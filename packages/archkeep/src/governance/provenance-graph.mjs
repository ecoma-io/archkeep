/**
 * Computes per-decision provenance from ADR records and file attribution.
 *
 * Pure function — no filesystem, no wall clock. Returns a Map of decision id
 * to `{attested, attribution}`. When `fileAttribution` cannot answer (returns
 * null), every decision is unattested.
 *
 * This is the shared helper both `buildProvenanceGraph` and the impact/scenario
 * evaluation callers use, so decision provenance is computed identically
 * everywhere — "via the same graph helper, never re-derived" (PR4).
 *
 * @param {{id: string}[]} records ADR records
 * @param {(path: string) => {createdBy: object|null,
 *   lastChangedBy: object|null}|null} [fileAttribution]
 *   Resolves git attribution for a decision record file. Defaults to a
 *   function that always returns null.
 * @returns {Map<string, {attested: boolean, attribution: object|null}>}
 */
export function computeDecisionProvenance(records, fileAttribution = () => null) {
  const provenance = new Map();
  for (const record of records) {
    const attribution = fileAttribution(`docs/adr/${record.id}.md`);
    provenance.set(record.id, {
      attested: attribution !== null,
      attribution: attribution ?? null,
    });
  }
  return provenance;
}
/**
 * The provenance graph: a pure, deterministic composition of every existing
 * provenance capability into a single traversable structure with nodes, edges,
 * claims, and causal chains.
 *
 * ## What it composes
 *
 * - `decision-graph.mjs` — the supersession lineage and decision-ref resolution
 * - `provenance-record.mjs` / `row-schema.mjs` — origin attestation
 * - `adr-registry.mjs` — `resolveDecisionRef`, `stripRuleFitnessPrefix`,
 *   `supersededByIndex`
 *
 * ## Node kinds
 *
 * - `repo` — the workspace's git state. One node. Evidence: git provenance.
 * - `row:<kind>:<index>` — one governance row. Evidence: the row's origin
 *   record, or a note that none exists.
 * - `decision:<id>` — one ADR record. Evidence: the record file's git
 *   attribution, or a note that none is available.
 *
 * ## Edge kinds
 *
 * - `provenance` — repo → row. The workspace provenance attests the row.
 * - `decisionRef` — row → decision. The row's `decisionRef` cites a decision.
 *   Evidence carries `{resolved: boolean, reason}` from `resolveDecisionRef`.
 * - `binding` — decision → row. The decision's `bindings` name the row's id.
 * - `supersedes` — decision → decision. Supersession chain forward.
 * - `supersededBy` — decision → decision. Supersession chain reverse (derived
 *   from the supersededBy index).
 *
 * ## Determinism
 *
 * Every emitted array is sorted byte-wise (no `localeCompare`), and every
 * node/edge/claim is deduplicated by id/key. Input order (the caller's row
 * list) is preserved for row nodes; decision nodes are sorted by id; edges
 * and claims are sorted by their canonical keys.
 *
 * ## Claims
 *
 * Three categories, each a flat list of `{id, kind, verdict, evidence}`:
 *
 * - `"attestation"` — per row: whether the row carries an origin.
 * - `"resolution"` — per decisionRef on a row: whether the ref resolves.
 * - `"lifecycle"` — per decision: whether its lifecycle is attributed.
 *
 * An empty `evidence` array is itself a claim — present, not a missing key.
 *
 * @module
 */

import { resolveDecisionRef, stripRuleFitnessPrefix, stripAdrPrefix } from "./adr-registry.mjs";

/**
 * @typedef {object} ProvenanceGraphInput
 * @property {object|null} repo
 *   Git provenance info (`{commit, remote, dirty}`) or null when unavailable.
 * @property {{kind: string, attested: boolean, origin: object|null,
 *   decisionRef: string|undefined, label: string}[]} rows
 *   Governance rows to include as nodes.
 * @property {object[]} records
 *   ADR records for decision nodes and supersession edges.
 * @property {Map<string, object>} byId
 *   Decision record lookup map.
 * @property {Set<string>} knownFitness
 *   Fitness record names for resolution.
 * @property {{id: string, attested: boolean, attribution: object|null}[]}
 *   decisionLifecycle
 *   Pre-computed decision lifecycle entries from provenance-command.
 */

/**
 * @typedef {object} ProvenanceGraphNode
 * @property {string} id
 * @property {string} kind
 * @property {string} label
 * @property {{origin: object|null, evidence: {kind: string, file: string|null,
 *   commit: string|null}}} data
 */

/**
 * @typedef {object} ProvenanceGraphEdge
 * @property {string} from
 * @property {string} to
 * @property {string} kind
 * @property {{resolved?: boolean, reason?: string}} [evidence]
 *   Present on `decisionRef` edges; absent on structural edges.
 */

/**
 * @typedef {object} ProvenanceClaim
 * @property {string} id
 * @property {"attestation"|"resolution"|"lifecycle"} kind
 * @property {"attested"|"unattested"|"resolved"|"unresolved"} verdict
 * @property {{kind: string, detail: string}[]} evidence
 */

/**
 * @typedef {object} CausalChainLink
 * @property {string} fromNode
 * @property {string} toNode
 * @property {string} edgeKind
 * @property {{kind: string, detail: string}[]} evidence
 */

/**
 * @typedef {object} CausalChain
 * @property {string} id
 * @property {string} startNode
 * @property {string} endNode
 * @property {CausalChainLink[]} hops
 */

/**
 * @typedef {object} ProvenanceGraph
 * @property {ProvenanceGraphNode[]} nodes
 * @property {ProvenanceGraphEdge[]} edges
 * @property {ProvenanceClaim[]} claims
 * @property {CausalChain[]} causalChains
 */

/** @type {(value: unknown) => string[]} */
function sortedArray(value) {
  if (!Array.isArray(value)) return [];
  return [...value].sort();
}

/** @type {(value: unknown) => string} */
function str(value) {
  if (typeof value === "string") return value;
  return "";
}

/**
 * Builds the provenance graph: nodes, edges, claims, and causal chains.
 *
 * Pure function of its inputs — no filesystem, no wall clock.
 * Every output array is sorted deterministically.
 *
 * @param {ProvenanceGraphInput} input
 */
export function buildProvenanceGraph({
  repo,
  rows = [],
  records = [],
  byId = new Map(),
  knownFitness = new Set(),
  decisionLifecycle = [],
}) {
  const nodes = [];
  const edges = [];
  const claims = [];
  const nodeIds = new Set();
  const edgeKeys = new Set();
  const claimKeys = new Set();

  /** @type {(id: string, kind: string, label: string, data: object) => void} */
  function addNode(id, kind, label, data) {
    if (nodeIds.has(id)) return;
    nodeIds.add(id);
    nodes.push({ id, kind, label, data });
  }

  /** @type {(from: string, to: string, kind: string, evidence?: object) => void} */
  function addEdge(from, to, kind, evidence) {
    const key = `${from}\u0000${kind}\u0000${to}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    const edge = { from, to, kind };
    if (evidence !== undefined) edge.evidence = evidence;
    edges.push(edge);
  }

  /** @type {(id: string, kind: "attestation"|"resolution"|"lifecycle", verdict: string, evidence: {kind: string, detail: string}[]) => void} */
  function addClaim(id, kind, verdict, evidence) {
    const key = `${kind}\u0000${id}`;
    if (claimKeys.has(key)) return;
    claimKeys.add(key);
    claims.push({ id, kind, verdict, evidence: evidence ?? [] });
  }

  // ── Repo node ──────────────────────────────────────────────────────────
  const repoCommit = repo?.commit ?? null;
  const repoId = repoCommit !== null ? `repo:${repoCommit}` : "repo:unavailable";
  addNode(repoId, "repo", repoCommit ?? "unavailable", {
    origin: repo ?? null,
    evidence: {
      kind: "git",
      file: null,
      commit: repoCommit,
    },
  });

  // ── Row nodes ──────────────────────────────────────────────────────────
  const rowEntries = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowId = `row:${row.kind}:${i}`;
    const label = row.label ?? `${row.kind}[${i}]`;
    addNode(rowId, "row", label, {
      origin: row.origin ?? null,
      evidence: {
        kind: "governance-row",
        file: null,
        commit: null,
      },
    });

    // Edge: repo → row
    addEdge(repoId, rowId, "provenance");

    // Claim: row attestation
    const attestationVerdict = row.attested ? "attested" : "unattested";
    const attestationEvidence = row.attested
      ? [
          {
            kind: "origin",
            detail: `origin recorded: by=${str(row.origin?.by)}, tool=${str(row.origin?.tool)}`,
          },
        ]
      : [{ kind: "origin", detail: "no origin recorded" }];
    addClaim(rowId, "attestation", attestationVerdict, attestationEvidence);

    rowEntries.push({ rowId, row, index: i });

    // ── DecisionRef edge: row → decision ─────────────────────────────────
    if (typeof row.decisionRef === "string" && row.decisionRef.trim() !== "") {
      const ref = row.decisionRef.trim();
      const resolution = resolveDecisionRef(byId, knownFitness, ref);
      const resolved = resolution !== "unknown";
      const decisionId = resolved ? stripAdrPrefix(ref) : ref;
      const targetId = resolved ? `decision:${decisionId}` : `unresolved:${ref}`;

      addEdge(rowId, targetId, "decisionRef", {
        resolved,
        reason: resolved
          ? `resolves as ${resolution}`
          : `"${ref}" does not resolve — no matching ADR, rule, or fitness record`,
      });

      // Claim: decisionRef resolution
      const resolutionVerdict = resolved ? "resolved" : "unresolved";
      const resolutionEvidence = [
        {
          kind: "decisionRef",
          detail: resolved ? `resolves to ${decisionId}` : `unresolved ref: ${ref}`,
        },
        {
          kind: "resolveDecisionRef",
          detail:
            resolution === "adr"
              ? "resolved via ADR registry"
              : resolution === "fitness"
                ? "resolved via fitness names"
                : "unknown",
        },
      ];
      addClaim(`${rowId}\u0000${ref}`, "resolution", resolutionVerdict, resolutionEvidence);
    }
  }

  // ── Decision nodes ─────────────────────────────────────────────────────
  const lifecycleById = new Map();
  for (const entry of decisionLifecycle) {
    lifecycleById.set(entry.id, entry);
  }

  // Sort records by id for determinism
  const sortedRecords = [...records].sort((a, b) => {
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  for (const record of sortedRecords) {
    const decisionId = `decision:${record.id}`;

    // Attribution evidence
    const lifecycle = lifecycleById.get(record.id);
    const attested = lifecycle?.attested ?? false;
    const attribution = lifecycle?.attribution ?? null;

    const attributionEvidence = attested
      ? [
          { kind: "file-attribution", detail: `created by ${str(attribution?.createdBy?.by)}` },
          {
            kind: "file-attribution",
            detail: `last changed by ${str(attribution?.lastChangedBy?.by)}`,
          },
        ]
      : [{ kind: "file-attribution", detail: "no origin recorded — cannot attest" }];

    addNode(decisionId, "decision", record.id, {
      attribution,
      evidence: {
        kind: "adr-record",
        file: `docs/adr/${record.id}.md`,
        commit: repoCommit,
      },
    });

    // Claim: lifecycle attestation
    const lifecycleVerdict = attested ? "attested" : "unattested";
    addClaim(decisionId, "lifecycle", lifecycleVerdict, attributionEvidence);

    // ── Supersession edges ───────────────────────────────────────────────
    for (const supersedes of sortedArray(record.supersedes)) {
      addEdge(decisionId, `decision:${supersedes}`, "supersedes");
    }
    for (const supersededBy of sortedArray(record.supersededBy)) {
      addEdge(`decision:${supersededBy}`, decisionId, "supersedes");
    }

    // ── Binding edges: decision → row ────────────────────────────────────
    const bindings = sortedArray(record.bindings);
    for (const binding of bindings) {
      const target = stripRuleFitnessPrefix(binding);
      for (const { rowId, row } of rowEntries) {
        if (stripRuleFitnessPrefix(row.id ?? row.label ?? "") === target) {
          addEdge(decisionId, rowId, "binding");
        }
      }
    }
  }

  // ── Sort outputs deterministically ─────────────────────────────────────
  const sortedNodes = [...nodes].sort((a, b) => {
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  const sortedEdges = [...edges].sort((a, b) => {
    const ka = `${a.from}\u0000${a.kind}\u0000${a.to}`;
    const kb = `${b.from}\u0000${b.kind}\u0000${b.to}`;
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });

  const sortedClaims = [...claims].sort((a, b) => {
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  // ── Causal chains ─────────────────────────────────────────────────────
  // For each row that has a decisionRef, BFS through decision → lineage
  const causalChains = [];

  for (const { rowId, row } of rowEntries) {
    if (typeof row.decisionRef !== "string" || row.decisionRef.trim() === "") continue;

    const ref = row.decisionRef.trim();
    const resolution = resolveDecisionRef(byId, knownFitness, ref);
    if (resolution !== "adr") continue;

    const decisionId = stripAdrPrefix(ref);
    const chainId = `${rowId}→decision:${decisionId}`;
    const chainNodes = [];
    const chainEdges = [];
    const visited = new Set();
    const queue = [decisionId];
    const parentMap = new Map();

    while (queue.length > 0) {
      const currentId = queue.shift();
      if (visited.has(currentId)) continue;
      visited.add(currentId);

      const record = byId.get(currentId);
      if (record === undefined) continue;

      // Build evidence for this hop
      const hopEvidence = [];

      // Row origin evidence on the first hop
      if (currentId === decisionId && row.origin) {
        hopEvidence.push({ kind: "origin", detail: `row origin: by=${str(row.origin.by)}` });
      }

      // Decision attribution evidence
      const lc = lifecycleById.get(currentId);
      if (lc?.attested && lc?.attribution) {
        hopEvidence.push({
          kind: "file-attribution",
          detail: `decision attributed: ${str(lc.attribution.createdBy?.by)}`,
        });
      } else {
        hopEvidence.push({ kind: "file-attribution", detail: "decision not attributed" });
      }

      // Supersedes links
      for (const nextId of sortedArray(record.supersedes)) {
        if (!visited.has(nextId)) {
          queue.push(nextId);
          parentMap.set(nextId, currentId);
          hopEvidence.push({ kind: "supersedes", detail: `supersedes ${nextId}` });
        }
      }

      const nodeId = `decision:${currentId}`;
      chainNodes.push(nodeId);

      if (parentMap.has(currentId)) {
        const parent = parentMap.get(currentId);
        chainEdges.push({
          fromNode: parent !== null ? `decision:${parent}` : rowId,
          toNode: nodeId,
          edgeKind: "supersedes",
          evidence: hopEvidence,
        });
      }
    }

    if (chainNodes.length > 0) {
      causalChains.push({
        id: chainId,
        startNode: rowId,
        endNode: `decision:${chainNodes[chainNodes.length - 1]}`,
        hops: chainEdges,
      });
    }
  }

  // Sort causal chains deterministically
  const sortedChains = [...causalChains].sort((a, b) => {
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  return {
    nodes: sortedNodes,
    edges: sortedEdges,
    claims: sortedClaims,
    causalChains: sortedChains,
  };
}
