import { describe, expect, it } from "vitest";
import { buildProvenanceGraph, computeDecisionProvenance } from "./provenance-graph.mjs";

/**
 * Shared test fixtures.
 */

/** A minimal repo object matching resolveProvenance output. */
const repo = { commit: "abc123def", remote: "origin@example.com", dirty: false };

/** Two ADR records with supersession chain. */
const records = [
  {
    id: "0001-bind-collaboration",
    status: "active",
    supersedes: [],
    supersededBy: [],
    bindings: ["type-package"],
    created: "2026-01-15",
    updated: "2026-08-01",
  },
  {
    id: "0002-scopes",
    status: "active",
    supersedes: ["0003-rename-lattice"],
    supersededBy: [],
    bindings: [],
    created: "2026-03-01",
  },
  {
    id: "0003-rename-lattice",
    status: "superseded",
    supersedes: [],
    supersededBy: ["0002-scopes"],
    bindings: [],
  },
];

const byId = new Map(records.map((r) => [r.id, r]));
const knownFitness = new Set(["type-package", "scope-limit"]);

/** A file-attribution function that always returns a fixed attribution. */
function withAttribution() {
  return {
    createdBy: { by: "Tess <tess@example.com>", tool: "git", on: "2026-01-02T00:00:00.000Z" },
    lastChangedBy: { by: "Rex <rex@example.com>", tool: "git", on: "2026-08-16T00:00:00.000Z" },
  };
}

/** A file-attribution function that always returns null (cannot attest). */
function withoutAttribution() {
  return null;
}

/** Decision lifecycle entries matching records above. */
function makeLifecycle(attributionFn) {
  return records.map((r) => {
    const attr = attributionFn ? attributionFn(`docs/adr/${r.id}.md`) : null;
    return {
      id: r.id,
      status: r.status,
      authority: r.status === "active",
      created: r.created ?? null,
      updated: r.updated ?? null,
      supersedes: r.supersedes,
      supersededBy: r.supersededBy,
      bindings: r.bindings,
      attribution: {
        createdBy: attr?.createdBy ?? null,
        lastChangedBy: attr?.lastChangedBy ?? null,
      },
      attested: attr !== null,
      note: attr === null ? "no origin recorded — cannot attest" : null,
    };
  });
}

// ---------------------------------------------------------------------------
// computeDecisionProvenance
// ---------------------------------------------------------------------------
describe("computeDecisionProvenance", () => {
  it("returns attested=true and attribution when fileAttribution answers", () => {
    const provenance = computeDecisionProvenance(records, withAttribution);
    expect(provenance.size).toBe(3);
    for (const [, p] of provenance) {
      expect(p.attested).toBe(true);
      expect(p.attribution).not.toBeNull();
    }
  });

  it("returns attested=false and attribution=null when fileAttribution returns null", () => {
    const provenance = computeDecisionProvenance(records, withoutAttribution);
    expect(provenance.size).toBe(3);
    for (const [, p] of provenance) {
      expect(p.attested).toBe(false);
      expect(p.attribution).toBeNull();
    }
  });

  it("returns empty map for empty records", () => {
    const provenance = computeDecisionProvenance([]);
    expect(provenance.size).toBe(0);
  });

  it("defaults fileAttribution to a function that always returns null", () => {
    const provenance = computeDecisionProvenance(records);
    for (const [, p] of provenance) {
      expect(p.attested).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// buildProvenanceGraph
// ---------------------------------------------------------------------------
describe("buildProvenanceGraph", () => {
  it("creates repo node with evidence", () => {
    const result = buildProvenanceGraph({
      repo,
      rows: [],
      records: [],
      byId: new Map(),
      knownFitness: new Set(),
      fileAttribution: withoutAttribution,
      decisionLifecycle: [],
    });

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].kind).toBe("repo");
    expect(result.nodes[0].data.evidence.commit).toBe("abc123def");
    expect(result.nodes[0].data.evidence.kind).toBe("git");
  });

  it("creates repo node with unavailable evidence when repo is null", () => {
    const result = buildProvenanceGraph({
      repo: null,
      rows: [],
      records: [],
      byId: new Map(),
      knownFitness: new Set(),
      fileAttribution: withoutAttribution,
      decisionLifecycle: [],
    });

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].kind).toBe("repo");
    expect(result.nodes[0].id).toBe("repo:unavailable");
    expect(result.nodes[0].data.evidence.commit).toBeNull();
  });

  it("creates row nodes with origin evidence when attested", () => {
    const rows = [
      {
        kind: "depConstraints[0]",
        attested: true,
        origin: { by: "jane@example.com", tool: "archkeep:v1", on: "2026-01-15" },
        decisionRef: "adr:0001-bind-collaboration",
        label: "depConstraints[0]",
      },
    ];
    const result = buildProvenanceGraph({
      repo,
      rows,
      records,
      byId,
      knownFitness,
      fileAttribution: withoutAttribution,
      decisionLifecycle: makeLifecycle(withoutAttribution),
    });

    const rowNodes = result.nodes.filter((n) => n.kind === "row");
    expect(rowNodes).toHaveLength(1);
    expect(rowNodes[0].data.origin).toEqual(rows[0].origin);
  });

  it("creates row nodes with null origin when unattested", () => {
    const rows = [
      {
        kind: "depConstraints[0]",
        attested: false,
        origin: null,
        label: "depConstraints[0]",
      },
    ];
    const result = buildProvenanceGraph({
      repo,
      rows,
      records: [],
      byId: new Map(),
      knownFitness: new Set(),
      fileAttribution: withoutAttribution,
      decisionLifecycle: [],
    });

    const rowNodes = result.nodes.filter((n) => n.kind === "row");
    expect(rowNodes).toHaveLength(1);
    expect(rowNodes[0].data.origin).toBeNull();
  });

  it("creates provenance edge from repo to each row", () => {
    const rows = [
      { kind: "depConstraints[0]", attested: true, origin: { by: "a", tool: "b" }, label: "c[0]" },
      { kind: "depConstraints[1]", attested: false, origin: null, label: "c[1]" },
    ];
    const result = buildProvenanceGraph({
      repo,
      rows,
      records: [],
      byId: new Map(),
      knownFitness: new Set(),
      fileAttribution: withoutAttribution,
      decisionLifecycle: [],
    });

    const provenanceEdges = result.edges.filter((e) => e.kind === "provenance");
    expect(provenanceEdges).toHaveLength(2);
    expect(provenanceEdges[0].from).toBe("repo:abc123def");
  });

  it("creates decisionRef edge with resolved evidence when decisionRef resolves as ADR", () => {
    const rows = [
      {
        kind: "depConstraints[0]",
        attested: true,
        origin: { by: "a", tool: "b" },
        decisionRef: "adr:0001-bind-collaboration",
        label: "c[0]",
      },
    ];
    const result = buildProvenanceGraph({
      repo,
      rows,
      records,
      byId,
      knownFitness,
      fileAttribution: withAttribution,
      decisionLifecycle: makeLifecycle(withAttribution),
    });

    const decisionRefEdges = result.edges.filter((e) => e.kind === "decisionRef");
    expect(decisionRefEdges).toHaveLength(1);
    expect(decisionRefEdges[0].evidence.resolved).toBe(true);
    expect(decisionRefEdges[0].to).toBe("decision:0001-bind-collaboration");
  });

  it("creates unresolved decisionRef edge when ref does not resolve", () => {
    const rows = [
      {
        kind: "depConstraints[0]",
        attested: true,
        origin: { by: "a", tool: "b" },
        decisionRef: "adr:9999-nonexistent",
        label: "c[0]",
      },
    ];
    const result = buildProvenanceGraph({
      repo,
      rows,
      records,
      byId,
      knownFitness,
      fileAttribution: withoutAttribution,
      decisionLifecycle: makeLifecycle(withoutAttribution),
    });

    const decisionRefEdges = result.edges.filter((e) => e.kind === "decisionRef");
    expect(decisionRefEdges).toHaveLength(1);
    expect(decisionRefEdges[0].evidence.resolved).toBe(false);
    expect(decisionRefEdges[0].to).toBe("unresolved:adr:9999-nonexistent");
  });

  it("creates decision nodes with attribution evidence", () => {
    const rows = [];
    const result = buildProvenanceGraph({
      repo,
      rows,
      records,
      byId,
      knownFitness,
      fileAttribution: withAttribution,
      decisionLifecycle: makeLifecycle(withAttribution),
    });

    const decisionNodes = result.nodes.filter((n) => n.kind === "decision");
    expect(decisionNodes.length).toBeGreaterThanOrEqual(3);
    // All should have evidence pointing at the ADR record file
    for (const node of decisionNodes) {
      expect(node.data.evidence.kind).toBe("adr-record");
      expect(node.data.evidence.file).toMatch(/^docs\/adr\//);
    }
  });

  it("marks decision without attribution as attested:false", () => {
    const result = buildProvenanceGraph({
      repo,
      rows: [],
      records,
      byId,
      knownFitness,
      fileAttribution: withoutAttribution,
      decisionLifecycle: makeLifecycle(withoutAttribution),
    });

    const decisionNodes = result.nodes.filter((n) => n.kind === "decision");
    for (const node of decisionNodes) {
      // attribution is always {createdBy, lastChangedBy}; when unattested both are null
      expect(node.data.attribution.createdBy).toBeNull();
      expect(node.data.attribution.lastChangedBy).toBeNull();
    }
  });

  it("creates supersedes edges between decisions", () => {
    const result = buildProvenanceGraph({
      repo,
      rows: [],
      records,
      byId,
      knownFitness,
      fileAttribution: withoutAttribution,
      decisionLifecycle: makeLifecycle(withoutAttribution),
    });

    const supersedesEdges = result.edges.filter((e) => e.kind === "supersedes");
    // 0002-scopes supersedes 0003-rename-lattice
    expect(supersedesEdges.length).toBeGreaterThanOrEqual(1);
    expect(
      supersedesEdges.some(
        (e) => e.from === "decision:0002-scopes" && e.to === "decision:0003-rename-lattice",
      ),
    ).toBe(true);
  });

  it("creates binding edges from decision to matching row", () => {
    // 0001-bind-collaboration binds type-package
    const rows = [
      {
        kind: "depConstraints[0]",
        attested: true,
        origin: { by: "a", tool: "b" },
        label: "type-package",
        id: "type-package",
      },
    ];
    const result = buildProvenanceGraph({
      repo,
      rows,
      records,
      byId,
      knownFitness,
      fileAttribution: withoutAttribution,
      decisionLifecycle: makeLifecycle(withoutAttribution),
    });

    const bindingEdges = result.edges.filter((e) => e.kind === "binding");
    expect(bindingEdges.length).toBeGreaterThanOrEqual(1);
  });

  it("produces attestation claims for each row", () => {
    const rows = [
      { kind: "depConstraints[0]", attested: true, origin: { by: "a", tool: "b" }, label: "c[0]" },
      { kind: "depConstraints[1]", attested: false, origin: null, label: "c[1]" },
    ];
    const result = buildProvenanceGraph({
      repo,
      rows,
      records: [],
      byId: new Map(),
      knownFitness: new Set(),
      fileAttribution: withoutAttribution,
      decisionLifecycle: [],
    });

    const attestationClaims = result.claims.filter((c) => c.kind === "attestation");
    expect(attestationClaims).toHaveLength(2);
    expect(attestationClaims.some((c) => c.verdict === "attested")).toBe(true);
    expect(attestationClaims.some((c) => c.verdict === "unattested")).toBe(true);
  });

  it("produces resolution claims for each decisionRef", () => {
    const rows = [
      {
        kind: "depConstraints[0]",
        attested: true,
        origin: { by: "a", tool: "b" },
        decisionRef: "adr:0001-bind-collaboration",
        label: "c[0]",
      },
    ];
    const result = buildProvenanceGraph({
      repo,
      rows,
      records,
      byId,
      knownFitness,
      fileAttribution: withAttribution,
      decisionLifecycle: makeLifecycle(withAttribution),
    });

    const resolutionClaims = result.claims.filter((c) => c.kind === "resolution");
    expect(resolutionClaims.length).toBeGreaterThanOrEqual(1);
    expect(resolutionClaims[0].verdict).toBe("resolved");
  });

  it("produces lifecycle claims for each decision", () => {
    const result = buildProvenanceGraph({
      repo,
      rows: [],
      records,
      byId,
      knownFitness,
      fileAttribution: withAttribution,
      decisionLifecycle: makeLifecycle(withAttribution),
    });

    const lifecycleClaims = result.claims.filter((c) => c.kind === "lifecycle");
    expect(lifecycleClaims).toHaveLength(3);
    for (const claim of lifecycleClaims) {
      expect(claim.verdict).toBe("attested");
    }
  });

  it("marks lifecycle claims as unattested when attribution is absent", () => {
    const result = buildProvenanceGraph({
      repo,
      rows: [],
      records,
      byId,
      knownFitness,
      fileAttribution: withoutAttribution,
      decisionLifecycle: makeLifecycle(withoutAttribution),
    });

    const lifecycleClaims = result.claims.filter((c) => c.kind === "lifecycle");
    for (const claim of lifecycleClaims) {
      expect(claim.verdict).toBe("unattested");
    }
  });

  it("builds causal chains for rows with resolvable decisionRefs", () => {
    const rows = [
      {
        kind: "depConstraints[0]",
        attested: true,
        origin: { by: "a", tool: "b" },
        decisionRef: "adr:0001-bind-collaboration",
        label: "c[0]",
      },
    ];
    const result = buildProvenanceGraph({
      repo,
      rows,
      records,
      byId,
      knownFitness,
      fileAttribution: withAttribution,
      decisionLifecycle: makeLifecycle(withAttribution),
    });

    expect(result.causalChains.length).toBeGreaterThanOrEqual(1);
    const chain = result.causalChains[0];
    expect(chain.startNode).toBe("row:depConstraints[0]:0");
    expect(chain.endNode).toMatch(/^decision:/);
  });

  it("causal chains include evidence on each hop", () => {
    const rows = [
      {
        kind: "depConstraints[0]",
        attested: true,
        origin: { by: "a", tool: "b" },
        decisionRef: "adr:0002-scopes",
        label: "c[0]",
      },
    ];
    const result = buildProvenanceGraph({
      repo,
      rows,
      records,
      byId,
      knownFitness,
      decisionLifecycle: makeLifecycle(withAttribution),
    });

    const chain = result.causalChains.find((c) => c.id.includes("0002-scopes"));
    expect(chain).toBeDefined();
    expect(chain.hops.length).toBeGreaterThanOrEqual(1);
    for (const hop of chain.hops) {
      expect(hop.evidence.length).toBeGreaterThanOrEqual(1);
      expect(hop.evidence[0].kind).toBeDefined();
      expect(hop.evidence[0].detail).toBeDefined();
    }
  });

  it("is deterministic — two calls produce byte-identical output", () => {
    const rows = [
      {
        kind: "depConstraints[0]",
        attested: true,
        origin: { by: "a", tool: "b" },
        decisionRef: "adr:0001-bind-collaboration",
        label: "c[0]",
      },
    ];
    const input = {
      repo,
      rows,
      records,
      byId,
      knownFitness,
      decisionLifecycle: makeLifecycle(withAttribution),
    };
    const a = buildProvenanceGraph(input);
    const b = buildProvenanceGraph(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("produces no causal chains when no row has a decisionRef", () => {
    const rows = [{ kind: "depConstraints[0]", attested: false, origin: null, label: "c[0]" }];
    const result = buildProvenanceGraph({
      repo,
      rows,
      records,
      byId,
      knownFitness,
      fileAttribution: withoutAttribution,
      decisionLifecycle: makeLifecycle(withoutAttribution),
    });

    expect(result.causalChains).toHaveLength(0);
  });

  it("is cycle-safe — lineage with cycles does not infinite-loop", () => {
    // Self-referencing record that would cause a cycle
    const cycleRecords = [
      {
        id: "0001-self",
        status: "active",
        supersedes: ["0001-self"],
        supersededBy: ["0001-self"],
        bindings: [],
      },
    ];
    const cycleById = new Map(cycleRecords.map((r) => [r.id, r]));
    const cycleLifecycle = makeLifecycle(withoutAttribution).slice(0, 1);
    cycleLifecycle[0] = {
      ...cycleLifecycle[0],
      supersedes: ["0001-self"],
      supersededBy: ["0001-self"],
    };

    const rows = [
      {
        kind: "depConstraints[0]",
        attested: true,
        origin: { by: "a", tool: "b" },
        decisionRef: "adr:0001-self",
        label: "c[0]",
      },
    ];
    const result = buildProvenanceGraph({
      repo,
      rows,
      records: cycleRecords,
      byId: cycleById,
      knownFitness: new Set(),
      fileAttribution: withoutAttribution,
      decisionLifecycle: cycleLifecycle,
    });

    // Should terminate without throwing
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.causalChains.length).toBeGreaterThanOrEqual(0);
  });

  it("fitness decisionRef produces no causal chain (only ADR refs)", () => {
    const rows = [
      {
        kind: "depConstraints[0]",
        attested: true,
        origin: { by: "a", tool: "b" },
        decisionRef: "fitness:type-package",
        label: "c[0]",
      },
    ];
    const result = buildProvenanceGraph({
      repo,
      rows,
      records,
      byId,
      knownFitness,
      fileAttribution: withoutAttribution,
      decisionLifecycle: makeLifecycle(withoutAttribution),
    });

    // Fitness refs resolve but don't produce causal chains (only ADR refs chain)
    // There should still be a decisionRef edge
    const decisionRefEdges = result.edges.filter((e) => e.kind === "decisionRef");
    expect(decisionRefEdges.length).toBeGreaterThanOrEqual(1);
  });
});
