/**
 * The decision governance graph: a pure, descriptive, bidirectional walk over
 * decisions (the ADR registry's records), the intent/constraint/fitness rows
 * they govern, the projects those rows govern, and the projects' current
 * findings.
 *
 * It answers the two directions of one question — "what does this decision
 * make enforceable, and what does that enforcement currently see?" and "what
 * decision governs this row/project/finding, and why was it made?" — as one
 * pure data shape: `{ok, nodes, edges, unresolved}`.
 *
 * ## Descriptive by contract (Wave 2 scope)
 *
 * This module NEVER gates. It decides nothing about whether a finding IS one
 * (the rule that produced it owns that, `../report/evidence.mjs`'), never
 * changes `check`'s exit code, and never turns green or red on its own. It
 * reports the graph the registry and the caller's row/finding facts describe
 * — or, where a reference cannot resolve, names the gap. The `adr`/`report`
 * surface of the wave renders the walk; nothing here is a verdict.
 *
 * ## The invariant
 *
 * The repository's governing rule (`../../../../AGENTS.md`): an empty result
 * must mean "no violation", and nothing else. For a walk that means an
 * `unresolved` list is the only honest answer to a reference that cannot
 * resolve:
 *
 * - an unknown decision id, a `binding` that names no governed row, a row
 *   citing a decision that does not exist, a missing findings lookup, a row
 *   or finding with no governing decision — every one lands in `unresolved`
 *   with its `ref`, a `kind`, and a reason, and `ok` is false. A walk never
 *   returns an empty-looking `nodes: []` over a reference it could not
 *   resolve.
 * - a reference that DID resolve and genuinely has nothing attached — a
 *   decision that binds no rule and is cited by no row — is a true fact and
 *   stays `ok: true`: the walk looked, and what it found is that nothing is
 *   bound.
 *
 * ## Determinism
 *
 * No wall-clock time, no randomness, no environment. Iteration follows the
 * caller's data orders — `records` in registry (byte-sorted filename) order,
 * `rows` in the order given, each record's `bindings`/`supersedes` in the
 * order the record declares — and nodes/edges/unresolved are emitted in
 * first-discovery order, so two runs over the same context produce
 * byte-identical output.
 *
 * ## Injection, never IO
 *
 * The module reads no files. The context — the registry index
 * (`./adr-registry.mjs`'s `readAdrContext` returns `records`/`byId`), the
 * workspace's declared rule/fitness ids (`declaredFitnessNames(config)`), the
 * governed rows, and the findings lookups — is assembled by the caller (Wave
 * 2's report/adr surface), so the walk is a pure function of facts, testable
 * on in-memory fixtures.
 *
 * ## The two name spaces, resolved the way the registry resolves them
 *
 * Decision references are the registry's: an ADR id (`0002-case`, or the
 * documented `adr:` spelling `stripAdrPrefix` handles). Rule/fitness ids are
 * the declared-name space `declaredFitnessNames` owns, with the documented
 * `rule:`/`fitness:` prefixes `stripRuleFitnessPrefix` handles. Both helpers
 * (and `resolveDecisionRef`, the classification every other surface shares)
 * come from `./adr-registry.mjs` — this walk consumes the registry's meaning,
 * never a second opinion about what a reference names. Normalization for row
 * matching applies the same documented aliases: a record binding `hotspot`
 * and a row id `fitness:hotspot` name the same thing, exactly as a
 * `decisionRef` of either spelling resolves identically everywhere else.
 */

import { resolveDecisionRef, stripAdrPrefix, stripRuleFitnessPrefix } from "./adr-registry.mjs";

/**
 * One governed row the walk knows: an intent row, a boundary constraint row,
 * or a fitness rule, each carrying the governance block the wave's shared
 * row schema (`./row-schema.mjs`) validates. The caller assembles this list
 * from the surfaces it owns — `architecture-intent.json` rows, the boundary
 * law's `depConstraints`, the declared `fitness` list — so the walk never
 * reads a row itself.
 *
 * @typedef {object} GovernedRow
 * @property {string} id The row's own reference — an intent-row label
 *   (`projects.required[0]`) or a rule/fitness id (`rule:keep-a`,
 *   `fitness:hotspot`, or the bare `hotspot` spelling).
 * @property {"intent"|"constraint"|"fitness"} kind What kind of row it is.
 * @property {string} [decisionRef] The decision that makes the row
 *   enforceable — an ADR id (bare or `adr:`-prefixed), or a rule/fitness id
 *   naming a decision that binds it.
 * @property {string[]} [governs] The project/part ids this row governs.
 */

/**
 * The facts a walk is a pure function of. Registry-shaped values come
 * straight from `./adr-registry.mjs`'s `readAdrContext` and
 * `declaredFitnessNames`; the rows and findings come from the caller.
 *
 * @typedef {object} GraphWalkContext
 * @property {object[]} records The validated records, in registry order.
 * @property {Map<string, object>} byId The registry index.
 * @property {Set<string>} knownFitness Rule/fitness ids the workspace
 *   declares (`declaredFitnessNames(config)`).
 * @property {GovernedRow[]} rows The governed rows this workspace carries.
 * @property {(projectId: string) => object[]} [findingsByProject] The current
 *   findings/evidence for a project. Required for a forward walk's
 *   "current findings" leg; when absent, the walk cannot claim a project has
 *   no findings and says so in `unresolved`.
 * @property {Map<string, object>} [findingsById] Finding id -> finding record,
 *   for the reverse walk's finding route. A finding record must carry at
 *   least `id`, `project`, and `ruleId`; any further fields pass through
 *   untouched in the finding node's `data`.
 */

/**
 * @typedef {"decision"|"intent"|"constraint"|"fitness"|"project"|"finding"} GraphNodeKind
 * @typedef {object} GraphNode
 * @property {string} id
 * @property {GraphNodeKind} kind
 * @property {string} label
 * @property {object} [data]
 * @typedef {"decisionRef"|"binding"|"governs"|"finding"|"supersedes"} GraphEdgeKind
 * @typedef {object} GraphEdge
 * @property {string} from
 * @property {string} to
 * @property {GraphEdgeKind} kind
 * @typedef {"decision"|"intent"|"constraint"|"fitness"|"project"|"finding"|"rule"|"binding"} UnresolvedKind
 * @typedef {object} UnresolvedRef
 * @property {string} ref The reference that did not resolve.
 * @property {UnresolvedKind} kind What the walk was trying to resolve.
 * @property {string} reason Why it cannot.
 * @typedef {object} GraphWalk
 * @property {boolean} ok False iff `unresolved` is non-empty — a walk that
 *   could not resolve every reference it met never looks like a walk that
 *   found nothing.
 * @property {GraphNode[]} nodes
 * @property {GraphEdge[]} edges
 * @property {UnresolvedRef[]} unresolved
 */

/** A fresh, empty walk — `ok: true` until the first unresolved reference. */
function newWalk() {
  const walk = { ok: true, nodes: [], edges: [], unresolved: [] };
  const nodeIds = new Set();
  const edgeKeys = new Set();
  const unresolvedKeys = new Set();
  return {
    walk,
    node(id, kind, label, data) {
      if (nodeIds.has(id)) return;
      nodeIds.add(id);
      walk.nodes.push(data === undefined ? { id, kind, label } : { id, kind, label, data });
    },
    edge(from, to, kind) {
      const key = `${from}\u0000${kind}\u0000${to}`;
      if (edgeKeys.has(key)) return;
      edgeKeys.add(key);
      walk.edges.push({ from, to, kind });
    },
    unresolved(ref, kind, reason) {
      const key = `${kind}\u0000${ref}`;
      if (unresolvedKeys.has(key)) return;
      unresolvedKeys.add(key);
      walk.ok = false;
      walk.unresolved.push({ ref, kind, reason });
    },
  };
}

/** The decision node a record contributes, with the record's own facts. */
function decisionNode(record) {
  const data = { status: record.status };
  for (const key of [
    "created",
    "updated",
    "context",
    "decision",
    "rationale",
    "alternatives",
    "consequences",
    "assumptions",
  ]) {
    if (record[key] !== undefined) data[key] = record[key];
  }
  if (record.supersedes.length > 0) data.supersedes = record.supersedes;
  if ((record.supersededBy ?? []).length > 0) data.supersededBy = record.supersededBy;
  return { id: record.id, kind: "decision", label: record.id, data };
}

/** `id`, with the documented `adr:` prefix stripped — the registry key. */
function decisionIdOf(ref) {
  return stripAdrPrefix(ref);
}

/**
 * The records whose `bindings` name `target`, normalized by the same
 * `rule:`/`fitness:` aliases the registry's own resolution applies.
 */
function bindingRecords(records, target) {
  return records.filter((record) =>
    record.bindings.some((binding) => stripRuleFitnessPrefix(binding) === target),
  );
}

/** The derived reverse-lineage index every walk builds for itself. */
function supersededByIndex(records) {
  const index = new Map();
  for (const record of records) {
    for (const ref of record.supersedes) {
      const list = index.get(ref) ?? [];
      list.push(record.id);
      index.set(ref, list);
    }
  }
  return index;
}

/**
 * Adds a record's node and the full supersession chain in both directions —
 * `supersedes` forward, derived `supersededBy` backward — cycle-safe (a
 * `visited` set; a raw, hand-built context can present a cycle the registry
 * would have refused, and the walk must still terminate).
 */
function attachLineage(g, record, ctx) {
  const index = supersededByIndex(ctx.records);
  const visited = new Set();
  const queue = [record.id];
  while (queue.length > 0) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    const current = ctx.byId.get(id);
    if (current === undefined) {
      g.unresolved(
        id,
        "decision",
        `"${id}" is named in a supersession chain but no matching ADR record is in the registry`,
      );
      continue;
    }
    g.node(current.id, "decision", current.id, decisionNode(current).data);
    for (const next of current.supersedes) {
      g.edge(current.id, next, "supersedes");
      if (!visited.has(next)) queue.push(next);
    }
    for (const next of index.get(current.id) ?? []) {
      g.edge(next, current.id, "supersedes");
      if (!visited.has(next)) queue.push(next);
    }
  }
}

/**
 * Every decision that governs `row`, in discovery order: the decision its
 * `decisionRef` names (an ADR record, or — for a `rule:`/`fitness:`-shaped
 * citation — the decisions whose `bindings` carry that id), plus every
 * decision whose `bindings` name the row's own id. A citation that resolves
 * to nothing lands in `unresolved`, never in a silent skip.
 *
 * @returns {number} How many governing decisions were attached.
 */
function governingDecisionsFor(g, row, ctx) {
  let count = 0;
  const decisionRef = row.decisionRef;
  if (typeof decisionRef === "string" && decisionRef.trim() !== "") {
    const resolution = resolveDecisionRef(ctx.byId, ctx.knownFitness, decisionRef);
    if (resolution === "adr") {
      const record = ctx.byId.get(decisionIdOf(decisionRef));
      attachLineage(g, record, ctx);
      g.edge(row.id, record.id, "decisionRef");
      count += 1;
    } else if (resolution === "fitness") {
      const target = stripRuleFitnessPrefix(decisionRef);
      for (const record of bindingRecords(ctx.records, target)) {
        attachLineage(g, record, ctx);
        g.edge(record.id, row.id, "binding");
        count += 1;
      }
    } else {
      g.unresolved(
        decisionRef,
        "decision",
        `${row.id} cites "${decisionRef}", which does not resolve — no matching ADR, rule, or fitness record`,
      );
    }
  }
  const target = stripRuleFitnessPrefix(row.id);
  for (const record of bindingRecords(ctx.records, target)) {
    attachLineage(g, record, ctx);
    g.edge(record.id, row.id, "binding");
    count += 1;
  }
  return count;
}

/** Adds a governed row's node plus its governed projects and their findings. */
function attachRowLeg(g, row, ctx) {
  g.node(row.id, row.kind, row.id);
  for (const projectId of row.governs ?? []) {
    g.node(projectId, "project", projectId);
    g.edge(row.id, projectId, "governs");
    if (ctx.findingsByProject === undefined) {
      g.unresolved(
        projectId,
        "project",
        `the context provides no findingsByProject lookup — the walk cannot claim "${projectId}" has no findings`,
      );
      continue;
    }
    for (const finding of ctx.findingsByProject(projectId)) {
      g.node(finding.id, "finding", finding.id, finding);
      g.edge(projectId, finding.id, "finding");
    }
  }
}

/**
 * Forward walk: a decision -> the governed rows that attach to it (rows whose
 * `decisionRef` names it — bare or `adr:`-prefixed — plus the rows whose ids
 * its `bindings` name) -> the projects/parts those rows govern -> the
 * projects' current findings/evidence, all read-only.
 *
 * Every hop that cannot resolve is reported: an unknown decision id, a
 * binding that names no governed row, a governed project the context cannot
 * produce findings for. A decision that resolves and attaches nothing is the
 * true fact "recorded but not enforceable", and stays `ok: true`.
 *
 * @param {string} decisionId An ADR id (`0002-case`, or `adr:0002-case`).
 * @param {GraphWalkContext} ctx
 * @returns {GraphWalk}
 */
export function forwardDecision(decisionId, ctx) {
  const g = newWalk();
  const record = ctx.byId.get(decisionIdOf(decisionId));
  if (record === undefined) {
    g.unresolved(
      decisionId,
      "decision",
      `"${decisionId}" does not resolve — no matching ADR record in the registry`,
    );
    return g.walk;
  }
  g.node(record.id, "decision", record.id, decisionNode(record).data);

  const boundIds = new Set(record.bindings.map((binding) => stripRuleFitnessPrefix(binding)));
  for (const row of ctx.rows) {
    const viaDecisionRef =
      typeof row.decisionRef === "string" &&
      resolveDecisionRef(ctx.byId, ctx.knownFitness, row.decisionRef) === "adr" &&
      decisionIdOf(row.decisionRef) === record.id;
    const viaBinding = boundIds.has(stripRuleFitnessPrefix(row.id));
    if (!viaDecisionRef && !viaBinding) continue;
    attachRowLeg(g, row, ctx);
    if (viaDecisionRef) g.edge(row.id, record.id, "decisionRef");
    if (viaBinding) g.edge(record.id, row.id, "binding");
  }

  for (const binding of record.bindings) {
    const target = stripRuleFitnessPrefix(binding);
    if (!ctx.rows.some((row) => stripRuleFitnessPrefix(row.id) === target)) {
      g.unresolved(
        binding,
        "binding",
        `"${binding}" is bound by ${record.id} but no governed row in the context carries that id`,
      );
    }
  }
  return g.walk;
}

/**
 * Reverse walk: a constraint/finding/rule id — a `rule:` id, a `fitness:` id,
 * an intent-row label, or a finding id — -> the decision(s) that govern it
 * (via the rows' `decisionRef` citations and the decisions' `bindings`) ->
 * each governing decision's rationale/context/lineage/status, all read-only.
 *
 * A reference that matches nothing, a row whose `decisionRef` does not
 * resolve, and a row or finding no decision binds or cites are all reported
 * in `unresolved` — a reverse walk never answers "no decision governs this"
 * about a reference it could not establish.
 *
 * @param {string} rowRef The id to walk back from.
 * @param {GraphWalkContext} ctx
 * @returns {GraphWalk}
 */
export function reverseRow(rowRef, ctx) {
  const g = newWalk();

  const row = ctx.rows.find((candidate) => candidate.id === rowRef);
  if (row !== undefined) {
    g.node(row.id, row.kind, row.id);
    const governing = governingDecisionsFor(g, row, ctx);
    if (governing === 0) {
      g.unresolved(
        rowRef,
        "row",
        `"${rowRef}" is governed by no decision — no decisionRef cites the row and no decision binds its id`,
      );
    }
    return g.walk;
  }

  const finding = ctx.findingsById?.get(rowRef);
  if (finding !== undefined) {
    g.node(finding.id, "finding", finding.id, finding);
    let governing = 0;
    for (const candidate of ctx.rows) {
      if ((candidate.governs ?? []).includes(finding.project)) {
        governing += governingDecisionsFor(g, candidate, ctx);
      }
    }
    const ruleId = stripRuleFitnessPrefix(finding.ruleId ?? "");
    for (const record of bindingRecords(ctx.records, ruleId)) {
      attachLineage(g, record, ctx);
      g.edge(record.id, finding.id, "binding");
      governing += 1;
    }
    if (governing === 0) {
      g.unresolved(
        rowRef,
        "finding",
        `"${rowRef}" is governed by no decision — no row governing its project cites one and no decision binds rule "${ruleId}"`,
      );
    }
    return g.walk;
  }

  if (rowRef.startsWith("rule:") || rowRef.startsWith("fitness:")) {
    const kind = rowRef.startsWith("rule:") ? "rule" : "fitness";
    const target = stripRuleFitnessPrefix(rowRef);
    let governing = 0;
    for (const candidate of ctx.rows) {
      if (stripRuleFitnessPrefix(candidate.id) === target) {
        g.node(candidate.id, candidate.kind, candidate.id);
        governing += governingDecisionsFor(g, candidate, ctx);
      }
    }
    for (const record of bindingRecords(ctx.records, target)) {
      attachLineage(g, record, ctx);
      g.edge(record.id, rowRef, "binding");
      governing += 1;
    }
    if (governing === 0) {
      g.unresolved(
        rowRef,
        kind,
        `"${rowRef}" does not resolve — no governed row carries that id and no decision binds it`,
      );
    }
    return g.walk;
  }

  g.unresolved(
    rowRef,
    "row",
    `"${rowRef}" does not resolve — no governed row, finding, rule, or fitness id carries it`,
  );
  return g.walk;
}

/**
 * Lineage walk: the full supersession chain of a decision, `supersedes`
 * forward and derived `supersededBy` backward, cycle-safe and deterministic
 * (registry order, first-discovery emission). An unknown start id — and a
 * chain that names a record the registry does not hold — is reported in
 * `unresolved`, never as an empty chain.
 *
 * @param {string} decisionId An ADR id (`0002-case`, or `adr:0002-case`).
 * @param {GraphWalkContext} ctx
 * @returns {GraphWalk}
 */
export function lineage(decisionId, ctx) {
  const g = newWalk();
  const record = ctx.byId.get(decisionIdOf(decisionId));
  if (record === undefined) {
    g.unresolved(
      decisionId,
      "decision",
      `"${decisionId}" does not resolve — no matching ADR record in the registry`,
    );
    return g.walk;
  }
  attachLineage(g, record, ctx);
  return g.walk;
}
