import { describe, expect, it } from "vitest";

import { formatDecisionChain } from "./decisions-text.mjs";

/**
 * The pure renderer tests: hand-built record/walk/fitness, no filesystem. The
 * renderer owns the invariant — a walk that could not resolve every hop
 * renders a loud `unresolved:` block, never a clean chain — so every test
 * below that walks a broken chain asserts the block is present, and every
 * resolved chain asserts it is absent.
 */

/** A resolved walk over 0001, binding a fitness gate and an intent row. */
function resolvedWalk() {
  return {
    ok: true,
    nodes: [
      { id: "0001-layers", kind: "decision", label: "0001-layers" },
      {
        id: "no-cycles",
        kind: "fitness",
        label: "no-cycles",
        data: { name: "no-cycles" },
      },
      {
        id: "forbidden[0] packages→packages",
        kind: "intent",
        label: "forbidden[0] packages→packages",
        data: { from: "packages", to: "packages" },
      },
      { id: "core", kind: "project", label: "core" },
    ],
    edges: [
      { from: "no-cycles", kind: "governs", to: "core" },
      { from: "no-cycles", kind: "binding", to: "0001-layers" },
      { from: "0001-layers", kind: "binding", to: "no-cycles" },
      {
        from: "forbidden[0] packages→packages",
        kind: "governs",
        to: "core",
      },
      { from: "forbidden[0] packages→packages", kind: "decisionRef", to: "0001-layers" },
    ],
    unresolved: [],
  };
}

/** A record, always carrying the derived `supersededBy` reverse-link. */
function record(overrides = {}) {
  return {
    id: "0001-layers",
    status: "accepted",
    context: "Layering was drifting across the graph.",
    decision: "Bind layering behind the no-cycles gate.",
    rationale: "Acyclic dependency graphs stay readable.",
    alternatives: [],
    consequences: [],
    assumptions: [],
    supersedes: ["0000-strawman"],
    supersededBy: [],
    ...overrides,
  };
}

describe("formatDecisionChain", () => {
  it("renders a resolved chain: header, prose, supersedes, fitness, governs, evidence", () => {
    const text = formatDecisionChain({
      decisionId: "0001-layers",
      record: record(),
      walk: resolvedWalk(),
      fitness: { level: "enforced", verified: true },
    });

    // Header mirrors the record's status.
    expect(text).toContain("0001-layers  (accepted)");
    expect(text.split("\n")[0]).toBe("0001-layers  (accepted)");

    // PROSE_FIELDS keep the 11-char label prefix + 1 space.
    expect(text).toContain("context:     Layering was drifting across the graph.");
    expect(text).toContain("decision:    Bind layering behind the no-cycles gate.");
    expect(text).toContain("rationale:   Acyclic dependency graphs stay readable.");

    expect(text).toContain("supersedes: 0000-strawman");
    expect(text).toContain(
      "fitness:      enforced — verified true: bound constraints resolve and pass",
    );

    // governs block: the fitness gate and the intent row, each with its target.
    expect(text).toContain("governs:");
    expect(text).toContain("  no-cycles  (fitness rule) → core");
    expect(text).toContain("  forbidden[0] packages→packages  (intent row) → core");

    // evidence block with the single project, no findings.
    expect(text).toContain("evidence:");
    expect(text).toContain("  core: no current findings");

    // A resolved chain never renders the unresolved block.
    expect(text).not.toContain("unresolved:");
  });

  it("renders evidence findings with their rule id", () => {
    const text = formatDecisionChain({
      decisionId: "0001-layers",
      record: record(),
      walk: {
        ok: true,
        nodes: [
          { id: "0001-layers", kind: "decision", label: "0001-layers" },
          { id: "core", kind: "project", label: "core" },
          {
            id: "f1",
            kind: "finding",
            label: "f1",
            data: { ruleId: "bannedExternalImportsViolation" },
          },
        ],
        edges: [{ from: "core", kind: "finding", to: "f1" }],
        unresolved: [],
      },
      fitness: undefined,
    });

    expect(text).toContain("evidence:");
    expect(text).toContain("  core: f1 (bannedExternalImportsViolation)");
  });

  it("renders the unmeasured fitness line when no measurement exists", () => {
    const text = formatDecisionChain({
      decisionId: "0001-layers",
      record: record(),
      walk: resolvedWalk(),
      fitness: undefined,
    });
    expect(text).toContain("fitness:      (not measured)");
  });

  it("renders a fitness level with its reason when not verified", () => {
    const text = formatDecisionChain({
      decisionId: "0001-layers",
      record: record(),
      walk: resolvedWalk(),
      fitness: {
        level: "unverifiable",
        verified: false,
        reason:
          "no bound constraint for 0001-layers resolves or was evaluated — none can be verified",
      },
    });
    expect(text).toContain(
      "fitness:      unverifiable — no bound constraint for 0001-layers resolves or was evaluated — none can be verified",
    );
  });

  it("renders governs: (none) when the decision binds no governed row", () => {
    const text = formatDecisionChain({
      decisionId: "0007-standalone",
      record: record({ id: "0007-standalone", supersedes: [] }),
      walk: {
        ok: true,
        nodes: [{ id: "0007-standalone", kind: "decision", label: "0007-standalone" }],
        edges: [],
        unresolved: [],
      },
      fitness: undefined,
    });
    expect(text).toContain("governs: (none — recorded but not enforceable)");
    expect(text).not.toContain("evidence:");
  });

  it("renders a loud unresolved block for a walk that could not resolve every hop", () => {
    const text = formatDecisionChain({
      decisionId: "0001-layers",
      record: record(),
      walk: {
        ok: false,
        nodes: [{ id: "0001-layers", kind: "decision", label: "0001-layers" }],
        edges: [],
        unresolved: [
          {
            ref: "no-cycles",
            kind: "binding",
            reason:
              '"no-cycles" is bound by 0001-layers but no governed row in the context carries that id',
          },
        ],
      },
      fitness: undefined,
    });
    expect(text).toContain("unresolved:");
    expect(text).toContain(
      '  no-cycles: "no-cycles" is bound by 0001-layers but no governed row in the context carries that id',
    );
  });
  it("renders an unknown decision id as unresolved, never a clean chain", () => {
    // `decisionsCommand` passes `record === null` for an id the registry does
    // not know; the renderer must still refuse to show a clean chain and must
    // never throw over the null record.
    const text = formatDecisionChain({
      decisionId: "9999-missing",
      record: null,
      walk: {
        ok: false,
        nodes: [],
        edges: [],
        unresolved: [
          {
            ref: "9999-missing",
            kind: "decision",
            reason: '"9999-missing" does not resolve — no matching ADR record in the registry',
          },
        ],
      },
      fitness: undefined,
    });
    expect(text).toContain("9999-missing  (unknown)");
    expect(text).toContain("unresolved:");
    expect(text).toContain(
      '  9999-missing: "9999-missing" does not resolve — no matching ADR record in the registry',
    );
  });
});
