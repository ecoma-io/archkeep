import { describe, expect, it } from "vitest";

import { forwardDecision, lineage, reverseRow } from "./decision-graph.mjs";

/**
 * In-memory fixtures for the pure walk. The records and byId mirror the shape
 * `./adr-registry.mjs`'s `readAdrContext` hands a caller; rows mirror the
 * wave's governed-row schema. A decision record is `{id, status, bindings,
 * supersedes, supersededBy?, …prose}` exactly as `validateRecord` yields it.
 */

/** The registry opinion, as `readAdrContext(records, byId, knownFitness)` yields. */
function makeContext(overrides = {}) {
  const records = [
    {
      id: "0001-bind-collaboration",
      status: "accepted",
      rationale: "Bind every collaboration API to one owner.",
      context: "Collaboration spread across the graph was drifting.",
      decision: "Keep collaboration behind the hotspot rule.",
      alternatives: [],
      consequences: [],
      assumptions: [],
      bindings: ["hotspot"],
      supersedes: [],
      supersededBy: ["0002-case"],
    },
    {
      id: "0002-case",
      status: "active",
      rationale: "Case analysis must own its rules, superseding the blanket bind.",
      context: "0002 reworks the bind 0001 made.",
      decision: "Enforce rule:no-direct-dep directly.",
      alternatives: [],
      consequences: [],
      assumptions: [],
      bindings: ["rule:no-direct-dep"],
      supersedes: ["0001-bind-collaboration"],
      supersededBy: ["0003-new"],
    },
    {
      id: "0003-new",
      status: "active",
      rationale: "The case work is finished; this is the live regulation.",
      context: "0003 inherits 0002's work.",
      decision: "Keep enforcing rule:no-direct-dep.",
      alternatives: [],
      consequences: [],
      assumptions: [],
      bindings: [],
      supersedes: ["0002-case"],
      supersededBy: [],
    },
    {
      id: "0007-unreferenced",
      status: "accepted",
      rationale: "Not part of the chain this walk tests.",
      context: "Isolated.",
      decision: "Stand alone.",
      alternatives: [],
      consequences: [],
      assumptions: [],
      bindings: [],
      supersedes: [],
      supersededBy: [],
    },
  ];
  /** @type {import("./decision-graph.mjs").GovernedRow[]} */
  const rows = [
    { id: "hotspot", kind: "fitness", governs: ["core"] },
    {
      id: "rule:no-direct-dep",
      kind: "constraint",
      decisionRef: "0002-case",
      governs: ["core", "ui"],
    },
    {
      id: "projects.required[0]",
      kind: "intent",
      decisionRef: "0002-case",
      governs: ["core"],
    },
    { id: "forbidden[2]", kind: "intent", decisionRef: "0003-new", governs: ["ui"] },
  ];
  const byId = new Map(records.map((record) => [record.id, record]));
  const knownFitness = new Set(["hotspot", "no-direct-dep"]);
  return {
    records,
    byId,
    knownFitness,
    rows,
    findingsByProject: (projectId) => {
      if (projectId === "core") return [finding("finding-1", "core", "no-direct-dep")];
      if (projectId === "ui") return [finding("finding-2", "ui", "hotspot")];
      return [];
    },
    findingsById: new Map([
      ["finding-1", finding("finding-1", "core", "no-direct-dep")],
      ["finding-2", finding("finding-2", "ui", "hotspot")],
    ]),
    ...overrides,
  };
}

function finding(id, project, ruleId) {
  return { id, project, ruleId, message: `${project} :: ${ruleId}` };
}

/** The id set of a walk's nodes, in discovery order. */
function nodeIds(walk) {
  return walk.nodes.map((node) => node.id);
}

/** The edge list as `from→kind→to` strings. */
function edges(walk) {
  return walk.edges.map((edge) => `${edge.from}→${edge.kind}→${edge.to}`);
}

describe("forwardDecision", () => {
  it("attaches the rows a decision binds and cites, then their projects and findings", () => {
    const walk = forwardDecision("0002-case", makeContext());
    expect(walk.ok).toBe(true);
    // 0002 binds "rule:no-direct-dep" (whose id matches and which also cites
    // 0002) and "projects.required[0]" cites 0002. "hotspot" and "forbidden[2]"
    // belong to other decisions and must stay out.
    expect(nodeIds(walk)).toEqual([
      "0002-case",
      "rule:no-direct-dep",
      // rule:no-direct-dep governs ["core","ui"] in order; core's finding
      // lands before ui's project node (finding-2) because each project's
      // findings are emitted inside its own governs-step.
      "core",
      "finding-1",
      "ui",
      "finding-2",
      "projects.required[0]",
    ]);
    // The decision node carries the record's own facts.
    expect(walk.nodes.find((n) => n.id === "0002-case").data).toMatchObject({
      status: "active",
      rationale: "Case analysis must own its rules, superseding the blanket bind.",
      supersedes: ["0001-bind-collaboration"],
      supersededBy: ["0003-new"],
    });
    // A row that is both bound by AND cites the decision emits its
    // governs/finding legs first (inside attachRowLeg), then its
    // decisionRef edge, then its binding edge — deterministic discovery
    // order, not a sort.
    expect(edges(walk)).toEqual([
      "rule:no-direct-dep→governs→core",
      "core→finding→finding-1",
      "rule:no-direct-dep→governs→ui",
      "ui→finding→finding-2",
      "rule:no-direct-dep→decisionRef→0002-case",
      "0002-case→binding→rule:no-direct-dep",
      "projects.required[0]→governs→core",
      "projects.required[0]→decisionRef→0002-case",
    ]);
  });

  it("accepts the adr: spelling of the decision id", () => {
    const walk = forwardDecision("adr:0002-case", makeContext());
    expect(walk.ok).toBe(true);
    // The decision node id is the registered bare id, whatever spelling was given.
    expect(nodeIds(walk)).toContain("0002-case");
    expect(nodeIds(walk)).not.toContain("adr:0002-case");
    expect(nodeIds(walk)).toContain("rule:no-direct-dep");
  });

  it("reports an unknown decision id as unresolved, never as a clean empty walk", () => {
    const walk = forwardDecision("9999-never-written", makeContext());
    expect(walk.ok).toBe(false);
    expect(walk.nodes).toEqual([]);
    expect(walk.edges).toEqual([]);
    expect(walk.unresolved).toEqual([
      {
        ref: "9999-never-written",
        kind: "decision",
        reason: '"9999-never-written" does not resolve — no matching ADR record in the registry',
      },
    ]);
  });

  it("reports a binding that names no governed row as unresolved", () => {
    const records = [
      {
        id: "0004-lone",
        status: "active",
        bindings: ["ghost-rule"],
        supersedes: [],
        supersededBy: [],
      },
    ];
    const ctx = makeContext({
      records,
      byId: new Map(records.map((r) => [r.id, r])),
      rows: [{ id: "some-unrelated-row", kind: "intent", governs: [] }],
    });
    const walk = forwardDecision("0004-lone", ctx);
    expect(walk.ok).toBe(false);
    expect(walk.unresolved).toEqual([
      {
        ref: "ghost-rule",
        kind: "binding",
        reason:
          '"ghost-rule" is bound by 0004-lone but no governed row in the context carries that id',
      },
    ]);
  });

  it("cannot claim a project has no findings without a findings lookup", () => {
    const ctx = makeContext();
    delete ctx.findingsByProject;
    const walk = forwardDecision("0002-case", ctx);
    expect(walk.ok).toBe(false);
    // Every governed project reports the missing lookup — "cannot claim no
    // findings", not an empty-looking clean walk.
    expect(walk.unresolved.map((u) => [u.kind, u.ref])).toEqual([
      ["project", "core"],
      ["project", "ui"],
    ]);
  });

  it("keeps a project with no findings resolved when the lookup ran", () => {
    const ctx = makeContext();
    ctx.rows = [
      ...ctx.rows,
      { id: "veneer", kind: "constraint", decisionRef: "0002-case", governs: ["marketing"] },
    ];
    const walk = forwardDecision("0002-case", ctx);
    expect(walk.ok).toBe(true);
    expect(nodeIds(walk)).toContain("marketing");
    // The lookup ran for "marketing" and found nothing — genuinely none.
    expect(walk.edges.filter((e) => e.to === "marketing" && e.kind === "finding")).toEqual([]);
    expect(walk.unresolved).toEqual([]);
  });

  it("treats a decision that resolves but binds nothing as a true, non-empty fact", () => {
    const walk = forwardDecision("0007-unreferenced", makeContext());
    expect(walk.ok).toBe(true);
    expect(nodeIds(walk)).toEqual(["0007-unreferenced"]);
    expect(walk.edges).toEqual([]);
    expect(walk.unresolved).toEqual([]);
  });
});

describe("reverseRow", () => {
  it("walks a finding back to its governing decision with its rationale, context, and lineage", () => {
    const walk = reverseRow("finding-1", makeContext());
    expect(walk.ok).toBe(true);
    // finding-1 is in "core"; "core" is governed by rule:no-direct-dep (cites
    // 0002) and hotspot (bound by 0001); its ruleId "no-direct-dep" is bound
    // by 0002. Both 0001 and 0002 govern the finding, and 0003 is reached as
    // part of the lineage chain 0003 -> 0002 -> 0001.
    expect(nodeIds(walk)).toContain("finding-1");
    const decision = walk.nodes.find((n) => n.id === "0002-case");
    expect(decision.data).toMatchObject({
      status: "active",
      rationale: "Case analysis must own its rules, superseding the blanket bind.",
      context: "0002 reworks the bind 0001 made.",
    });
    expect(edges(walk)).toContain("0002-case→supersedes→0001-bind-collaboration");
    expect(edges(walk)).toContain("0003-new→supersedes→0002-case");
  });

  it("resolves an exact row id through its decisionRef citation", () => {
    const walk = reverseRow("projects.required[0]", makeContext());
    expect(walk.ok).toBe(true);
    expect(nodeIds(walk)).toContain("projects.required[0]");
    expect(nodeIds(walk)).toContain("0002-case");
    expect(edges(walk)).toContain("projects.required[0]→decisionRef→0002-case");
  });

  it("resolves a rule:id through the decisions that bind it", () => {
    const walk = reverseRow("rule:no-direct-dep", makeContext());
    expect(walk.ok).toBe(true);
    expect(nodeIds(walk)).toContain("rule:no-direct-dep");
    expect(nodeIds(walk)).toContain("0002-case");
    expect(edges(walk)).toContain("0002-case→binding→rule:no-direct-dep");
  });

  it("reports an id that matches nothing as an unresolved row", () => {
    const walk = reverseRow("9999-nothing", makeContext());
    expect(walk.ok).toBe(false);
    expect(walk.unresolved).toHaveLength(1);
    expect(walk.unresolved[0]).toMatchObject({ ref: "9999-nothing", kind: "row" });
  });

  it("reports a legacy row with no governing decision as unresolved", () => {
    const ctx = makeContext();
    ctx.rows = [...ctx.rows, { id: "legacy-row", kind: "intent", governs: ["core"] }];
    const walk = reverseRow("legacy-row", ctx);
    expect(walk.ok).toBe(false);
    expect(walk.unresolved).toEqual([
      {
        ref: "legacy-row",
        kind: "row",
        reason: expect.stringContaining("governed by no decision"),
      },
    ]);
  });

  it("classifies an unresolvable rule:/fitness: reference as such", () => {
    const ruleWalk = reverseRow("rule:ghost", makeContext());
    expect(ruleWalk.ok).toBe(false);
    expect(ruleWalk.unresolved[0]).toMatchObject({ ref: "rule:ghost", kind: "rule" });

    const fitnessWalk = reverseRow("fitness:ghost", makeContext());
    expect(fitnessWalk.ok).toBe(false);
    expect(fitnessWalk.unresolved[0]).toMatchObject({ ref: "fitness:ghost", kind: "fitness" });
  });

  it("reports both the broken citation and the row when a decisionRef does not resolve", () => {
    const ctx = makeContext();
    ctx.rows = /** @type {import("./decision-graph.mjs").GovernedRow[]} */ ([
      { id: "bad-cite", kind: "intent", decisionRef: "9999-never-written", governs: [] },
    ]);
    const walk = reverseRow("bad-cite", ctx);
    expect(walk.ok).toBe(false);
    expect(walk.unresolved.map((u) => [u.kind, u.ref])).toEqual([
      ["decision", "9999-never-written"],
      ["row", "bad-cite"],
    ]);
  });

  it("resolves a fitness-shaped decisionRef through the decisions that bind it", () => {
    const ctx = makeContext();
    ctx.rows = /** @type {import("./decision-graph.mjs").GovernedRow[]} */ ([
      { id: "fitness-row", kind: "fitness", decisionRef: "fitness:hotspot", governs: [] },
    ]);
    const walk = reverseRow("fitness-row", ctx);
    expect(walk.ok).toBe(true);
    expect(nodeIds(walk)).toContain("0001-bind-collaboration");
    expect(edges(walk)).toContain("0001-bind-collaboration→binding→fitness-row");
  });

  it("reports an orphan finding no decision governs as unresolved", () => {
    const ctx = makeContext();
    ctx.findingsById = /** @type {Map<string, object>} */ (
      new Map([["orphan-finding", { id: "orphan-finding", project: "nowhere", ruleId: "nope" }]])
    );
    // Nothing governs "nowhere" and no decision binds "nope".
    const walk = reverseRow("orphan-finding", ctx);
    expect(walk.ok).toBe(false);
    expect(walk.unresolved[0]).toMatchObject({ ref: "orphan-finding", kind: "finding" });
  });
});

describe("lineage", () => {
  it("returns the full supersession chain in both directions", () => {
    const walk = lineage("0001-bind-collaboration", makeContext());
    expect(walk.ok).toBe(true);
    expect(nodeIds(walk)).toEqual(["0001-bind-collaboration", "0002-case", "0003-new"]);
    expect(edges(walk)).toEqual([
      "0002-case→supersedes→0001-bind-collaboration",
      "0003-new→supersedes→0002-case",
    ]);
  });

  it("walks forward in time from any decision", () => {
    const walk = lineage("0002-case", makeContext());
    expect(walk.ok).toBe(true);
    expect(nodeIds(walk)).toEqual(["0002-case", "0001-bind-collaboration", "0003-new"]);
    expect(edges(walk)).toEqual([
      "0002-case→supersedes→0001-bind-collaboration",
      "0003-new→supersedes→0002-case",
    ]);
  });

  it("is cycle-safe on a hand-built cyclic supersession graph", () => {
    const records = [
      { id: "A", status: "active", bindings: [], supersedes: ["B"], supersededBy: [] },
      { id: "B", status: "active", bindings: [], supersedes: ["A"], supersededBy: [] },
    ];
    const ctx = {
      records,
      byId: new Map(records.map((r) => [r.id, r])),
      knownFitness: new Set(),
      rows: [],
    };
    const walk = lineage("A", ctx);
    expect(walk.ok).toBe(true);
    // B -> A and A -> B both present; the walk terminates.
    expect(nodeIds(walk)).toEqual(["A", "B"]);
    expect(edges(walk)).toEqual(["A→supersedes→B", "B→supersedes→A"]);
  });

  it("reports a chain member the registry does not hold as unresolved", () => {
    const records = [
      { id: "C", status: "active", bindings: [], supersedes: ["ghost"], supersededBy: [] },
    ];
    const ctx = {
      records,
      byId: new Map(records.map((r) => [r.id, r])),
      knownFitness: new Set(),
      rows: [],
    };
    const walk = lineage("C", ctx);
    expect(walk.ok).toBe(false);
    expect(walk.unresolved).toEqual([
      {
        ref: "ghost",
        kind: "decision",
        reason: expect.stringContaining("supersession chain"),
      },
    ]);
  });

  it("reports an unknown start id as unresolved", () => {
    const walk = lineage("9999-x", makeContext());
    expect(walk.ok).toBe(false);
    expect(walk.unresolved[0]).toMatchObject({ ref: "9999-x", kind: "decision" });
    expect(walk.nodes).toEqual([]);
  });
});
