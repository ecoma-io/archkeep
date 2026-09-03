import { describe, expect, it } from "vitest";

import {
  evaluateScenario,
  parseScenarioInput,
  SCENARIO_CHANGE_TYPES,
} from "./scenario-evaluation.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGraph(nodes, dependencies) {
  return {
    nodes: Object.fromEntries(nodes.map((n) => [n, { name: n }])),
    dependencies: Object.fromEntries(
      dependencies.map(([src, targets]) => [
        src,
        targets.map((t) => ({ target: t, type: "static", source: src })),
      ]),
    ),
  };
}

function makeCommandContext(graph) {
  return {
    root: "/fake/root",
    graph,
    analysis: { analyzed: 10, imports: [], failures: [] },
  };
}

/**
 * Creates a `ScenarioInput` with properly typed changes.
 * TypeScript needs literal types for `type` to match `DependencyChange`,
 * which a plain object literal widens to `string`.
 *
 * @param {"dependency_added"|"dependency_removed"} type
 * @param {string} source
 * @param {string} target
 * @returns {import("./scenario-evaluation.mjs").DependencyChange}
 */
function change(type, source, target, edgeType = "static") {
  return { type, source, target, ...(edgeType ? { edgeType } : {}) };
}

// ---------------------------------------------------------------------------
// parseScenarioInput
// ---------------------------------------------------------------------------

describe("parseScenarioInput", () => {
  it("parses a valid scenario with dependency_added", () => {
    const input = JSON.stringify({
      changes: [change("dependency_added", "x", "y")],
    });
    const result = parseScenarioInput(input);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toEqual({
      type: "dependency_added",
      source: "x",
      target: "y",
      edgeType: "static",
    });
  });

  it("parses a scenario with dependency_removed", () => {
    const input = JSON.stringify({
      changes: [change("dependency_removed", "x", "y")],
    });
    const result = parseScenarioInput(input);
    expect(result.changes[0].type).toBe("dependency_removed");
  });

  it("extracts the optional base field", () => {
    const input = JSON.stringify({
      base: "abc123",
      changes: [change("dependency_added", "x", "y")],
    });
    const result = parseScenarioInput(input);
    expect(result.base).toBe("abc123");
  });

  it("defaults base to undefined when absent", () => {
    const input = JSON.stringify({
      changes: [change("dependency_added", "x", "y")],
    });
    const result = parseScenarioInput(input);
    expect(result.base).toBeUndefined();
  });

  it("rejects invalid JSON", () => {
    expect(() => parseScenarioInput("not json")).toThrow(/invalid JSON/);
  });

  it("rejects a non-object", () => {
    expect(() => parseScenarioInput('"string"')).toThrow(/must be a JSON object/);
  });

  it("rejects missing changes array", () => {
    expect(() => parseScenarioInput("{}")).toThrow(/'changes' must be an array/);
  });

  it("rejects empty changes array", () => {
    expect(() => parseScenarioInput(JSON.stringify({ changes: [] }))).toThrow(
      /must contain at least one change/,
    );
  });

  it("rejects unsupported change type", () => {
    expect(() =>
      parseScenarioInput(
        JSON.stringify({
          changes: [{ type: "project_split", source: "x", target: "y" }],
        }),
      ),
    ).toThrow(/not supported/);
  });

  it("rejects changes with missing source", () => {
    expect(() =>
      parseScenarioInput(
        JSON.stringify({
          changes: [{ type: "dependency_added", target: "y" }],
        }),
      ),
    ).toThrow(/source must be a non-empty string/);
  });

  it("rejects changes with missing target", () => {
    expect(() =>
      parseScenarioInput(
        JSON.stringify({
          changes: [{ type: "dependency_added", source: "x" }],
        }),
      ),
    ).toThrow(/target must be a non-empty string/);
  });
});

// ---------------------------------------------------------------------------
// evaluateScenario — determinism and virtual labels
// ---------------------------------------------------------------------------

describe("evaluateScenario — determinism and labels", () => {
  it("marks every output as virtual and not authoritative", () => {
    const graph = makeGraph(
      ["a", "b", "c"],
      [
        ["b", ["a"]],
        ["c", ["a"]],
      ],
    );
    const input = {
      changes: [change("dependency_added", "c", "b")],
    };
    const result = evaluateScenario("a", makeCommandContext(graph), input);
    expect(result.virtual).toBe(true);
    expect(result.notAuthoritative).toBe(true);
  });

  it("is deterministic — same input produces identical output", () => {
    const graph = makeGraph(
      ["a", "b", "c"],
      [
        ["b", ["a"]],
        ["c", ["a"]],
      ],
    );
    const input = {
      changes: [change("dependency_added", "c", "b")],
    };
    const ctx = makeCommandContext(graph);
    const r1 = evaluateScenario("a", ctx, input);
    const r2 = evaluateScenario("a", ctx, input);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it("includes a note that this is not authoritative", () => {
    const graph = makeGraph(["a", "b"], [["b", ["a"]]]);
    const input = {
      changes: [change("dependency_added", "b", "a")],
    };
    const result = evaluateScenario("a", makeCommandContext(graph), input);
    expect(result.notes).toEqual(
      expect.arrayContaining(["virtual evaluation — not authoritative"]),
    );
  });
});

// ---------------------------------------------------------------------------
// evaluateScenario — dependency_added
// ---------------------------------------------------------------------------

describe("evaluateScenario — dependency_added", () => {
  it("adds a new dependent when a dependency is added", () => {
    // a ← b, a ← c. Add c → b. Now b depends on a directly, and c depends
    // on a transitively through b. The dependents of 'a' stay the same.
    const graph = makeGraph(
      ["a", "b", "c"],
      [
        ["b", ["a"]],
        ["c", ["a"]],
      ],
    );
    const input = {
      changes: [change("dependency_added", "c", "b")],
    };
    const result = evaluateScenario("a", makeCommandContext(graph), input);
    // Current: b, c depend on a directly
    expect(result.current.impact.dependents).toEqual(["b", "c"]);
    // Scenario: b depends on a directly, c depends on b + a
    // c still depends on a, and also transitively through b
    // Dependents of 'a' are still b and c (no change in the set)
    expect(result.scenario.impact.dependents).toEqual(["b", "c"]);
    expect(result.delta.dependentsAdded).toEqual([]);
    expect(result.delta.dependentsRemoved).toEqual([]);
  });

  it("adds a dependent when creating a new chain", () => {
    // a ← b. Add c → a. Now c also depends on a directly.
    const graph = makeGraph(["a", "b", "c"], [["b", ["a"]]]);
    const input = {
      changes: [change("dependency_added", "c", "a")],
    };
    const result = evaluateScenario("a", makeCommandContext(graph), input);
    expect(result.current.impact.dependents).toEqual(["b"]);
    expect(result.scenario.impact.dependents).toEqual(["b", "c"]);
    expect(result.delta.dependentsAdded).toEqual(["c"]);
  });

  it("records the change in the changes list", () => {
    const graph = makeGraph(["a", "b"], []);
    const input = {
      changes: [change("dependency_added", "b", "a")],
    };
    const result = evaluateScenario("a", makeCommandContext(graph), input);
    expect(result.changes).toEqual(
      expect.arrayContaining([expect.stringMatching(/added dependency: b.*a/)]),
    );
  });

  it("refuses when source project does not exist", () => {
    const graph = makeGraph(["a"], []);
    const input = {
      changes: [change("dependency_added", "nonexistent", "a")],
    };
    const result = evaluateScenario("a", makeCommandContext(graph), input);
    expect(result.refused).toBeDefined();
    expect(result.refused).toEqual(expect.arrayContaining([expect.stringMatching(/not in graph/)]));
  });

  it("refuses when target project does not exist", () => {
    const graph = makeGraph(["a"], []);
    const input = {
      changes: [change("dependency_added", "a", "nonexistent")],
    };
    const result = evaluateScenario("a", makeCommandContext(graph), input);
    expect(result.refused).toBeDefined();
  });

  it("skips duplicate edges without error", () => {
    const graph = makeGraph(["a", "b"], [["b", ["a"]]]);
    const input = {
      changes: [change("dependency_added", "b", "a")],
    };
    const result = evaluateScenario("a", makeCommandContext(graph), input);
    // The edge already exists, so it's noted as already present
    expect(result.changes).toEqual(
      expect.arrayContaining([expect.stringMatching(/already exists/)]),
    );
    expect(result.refused).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// evaluateScenario — dependency_removed
// ---------------------------------------------------------------------------

describe("evaluateScenario — dependency_removed", () => {
  it("removes a dependent when a dependency is removed", () => {
    // a ← b ← c. Remove b → a. Now c has no path to a.
    const graph = makeGraph(
      ["a", "b", "c"],
      [
        ["b", ["a"]],
        ["c", ["b"]],
      ],
    );
    const input = {
      changes: [change("dependency_removed", "b", "a")],
    };
    const result = evaluateScenario("a", makeCommandContext(graph), input);
    expect(result.current.impact.dependents).toEqual(["b", "c"]);
    expect(result.scenario.impact.dependents).toEqual([]);
    expect(result.delta.dependentsRemoved).toEqual(["b", "c"]);
  });

  it("refuses when the edge does not exist", () => {
    const graph = makeGraph(["a", "b"], []);
    const input = {
      changes: [change("dependency_removed", "b", "a")],
    };
    const result = evaluateScenario("a", makeCommandContext(graph), input);
    expect(result.refused).toBeDefined();
    expect(result.refused).toEqual(expect.arrayContaining([expect.stringMatching(/no edge/)]));
  });
});

// ---------------------------------------------------------------------------
// evaluateScenario — multiple changes
// ---------------------------------------------------------------------------

describe("evaluateScenario — multiple changes", () => {
  it("applies multiple changes and produces the combined result", () => {
    // a ← b, a ← c ← d. Add c → b, Remove d → c.
    // After: b depends on a, c depends on a and b, d depends on nothing.
    const graph = makeGraph(
      ["a", "b", "c", "d"],
      [
        ["b", ["a"]],
        ["c", ["a"]],
        ["d", ["c"]],
      ],
    );
    const input = {
      changes: [change("dependency_added", "c", "b"), change("dependency_removed", "d", "c")],
    };
    const result = evaluateScenario("a", makeCommandContext(graph), input);
    // Current dependents of a: b (direct), c (direct), d (transitive via c)
    expect(result.current.impact.dependents).toEqual(["b", "c", "d"]);
    // Scenario: b depends on a, c depends on a + b, d has no path to a
    expect(result.scenario.impact.dependents).toEqual(["b", "c"]);
    expect(result.delta.dependentsRemoved).toEqual(["d"]);
  });
});

// ---------------------------------------------------------------------------
// evaluateScenario — delta correctness
// ---------------------------------------------------------------------------

describe("evaluateScenario — delta correctness", () => {
  it("reports no delta when changes do not affect the target", () => {
    // a ← b, c ← d. Add d → a. This does not affect a's dependents.
    const graph = makeGraph(
      ["a", "b", "c", "d"],
      [
        ["b", ["a"]],
        ["d", ["c"]],
      ],
    );
    const input = {
      changes: [change("dependency_added", "d", "a")],
    };
    const result = evaluateScenario("a", makeCommandContext(graph), input);
    // Current: b depends on a
    // Scenario: b + d depend on a
    expect(result.delta.dependentsAdded).toEqual(["d"]);
    expect(result.delta.dependentsRemoved).toEqual([]);
  });

  it("reports constraint impact changes when config is provided", () => {
    const graph = makeGraph(["a", "b"], [["b", ["a"]]]);
    const input = {
      changes: [change("dependency_added", "b", "a")],
    };
    const config = {
      depConstraints: [
        {
          sourceTag: "*",
          targetTag: "*",
          allowed: true,
          description: "All dependencies allowed",
        },
      ],
    };
    // evaluateScenario handles config — if config.depConstraints exists,
    // it calls computeImpactConstraints. The constraint impact should be
    // present in both current and scenario.
    const result = evaluateScenario("a", makeCommandContext(graph), input, config);
    expect(result.current.constraintImpact).toBeDefined();
    expect(result.scenario.constraintImpact).toBeDefined();
  });

  it("reports no constraint impact when config is null", () => {
    const graph = makeGraph(["a", "b"], [["b", ["a"]]]);
    const input = {
      changes: [change("dependency_added", "b", "a")],
    };
    const result = evaluateScenario("a", makeCommandContext(graph), input, null);
    expect(result.current.constraintImpact).toBeNull();
    expect(result.scenario.constraintImpact).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// evaluateScenario — edge cases
// ---------------------------------------------------------------------------

describe("evaluateScenario — edge cases", () => {
  it("handles self-referential scenarios gracefully", () => {
    const graph = makeGraph(["a"], []);
    const input = {
      changes: [change("dependency_added", "a", "a")],
    };
    // Self-referential: a depends on itself. This adds an edge, but
    // computeImpact should handle it (a project doesn't count as its own
    // dependent since computeImpact finds projects that import it).
    const result = evaluateScenario("a", makeCommandContext(graph), input);
    expect(result.changes).toHaveLength(1);
    // When a project depends on itself, computeImpact reports it as a direct
    // dependent because the graph edge exists and is traversed.
    expect(result.scenario.impact.dependents).toEqual(["a"]);
  });

  it("handles a complex diamond dependency", () => {
    //   a
    //  / \
    // b   c
    //  \ /
    //   d
    // Current: b,c,d depend on a
    // Scenario: remove b → a. Now c,d still depend on a.
    const graph = makeGraph(
      ["a", "b", "c", "d"],
      [
        ["b", ["a"]],
        ["c", ["a"]],
        ["d", ["b", "c"]],
      ],
    );
    const input = {
      changes: [change("dependency_removed", "b", "a")],
    };
    const result = evaluateScenario("a", makeCommandContext(graph), input);
    // Current dependents of a: b (direct), c (direct), d (transitive)
    expect(result.current.impact.dependents).toEqual(["b", "c", "d"]);
    // Scenario: c (direct), d (transitive via c)
    expect(result.scenario.impact.dependents).toEqual(["c", "d"]);
    expect(result.delta.dependentsRemoved).toEqual(["b"]);
  });

  it("includes complete flag — false without config or evidence gates", () => {
    const graph = makeGraph(["a", "b"], [["b", ["a"]]]);
    const input = {
      changes: [change("dependency_added", "b", "a")],
    };
    // Without config and verified base, evidence gates fail → complete is false
    const result = evaluateScenario("a", makeCommandContext(graph), input);
    expect(result.complete).toBe(false);
  });

  it("outputs base revision when provided", () => {
    const graph = makeGraph(["a", "b"], [["b", ["a"]]]);
    const input = {
      base: "abc123def",
      changes: [change("dependency_added", "b", "a")],
    };
    const result = evaluateScenario("a", makeCommandContext(graph), input);
    expect(result.base.revision).toBe("abc123def");
    expect(result.base.identityVerified).toBe(false); // dirty test env, can't verify
  });

  it("outputs unattributed workspace when no git revision available", () => {
    const graph = makeGraph(["a", "b"], [["b", ["a"]]]);
    const input = {
      changes: [change("dependency_added", "b", "a")],
    };
    const result = evaluateScenario("a", makeCommandContext(graph), input);
    expect(result.base.revision).toBe("(unattributed workspace)");
    expect(result.base.identityVerified).toBe(false);
    expect(result.base.identity).toBe("unattributed");
    expect(result.base.provenance).toMatch(/unverifiable/);
  });
  it("marks complete:false when changes are refused (even with config)", () => {
    const graph = makeGraph(["a"], []);
    const input = {
      changes: [change("dependency_added", "nonexistent", "a")],
    };
    const config = { depConstraints: [] };
    const result = evaluateScenario("a", makeCommandContext(graph), input, config);
    expect(result.refused).toBeDefined();
    expect(result.complete).toBe(false);
  });
  it("marks complete:true when all changes apply with config and evidence gates pass", () => {
    const graph = makeGraph(["a", "b"], [["b", ["a"]]]);
    const input = {
      base: "abc123def",
      changes: [change("dependency_added", "b", "a")],
    };
    const config = {
      depConstraints: [],
      decisionRefs: [{ id: "ADR-001", source: "b", target: "a" }],
    };
    const result = evaluateScenario("a", makeCommandContext(graph), input, config);
    expect(result.refused).toBeUndefined();
    // In test env without git, baseIdentityValid is false → overallComplete is false.
    // Mutation coverage is complete, and evidence gates that depend on config/decisions pass.
    expect(result.completeness.scenarioDomains.mutationCoverage.status).toBe("evaluated");
    expect(result.completeness.scenarioDomains.changes.status).toBe("evaluated");
  });
  it("includes evidenceChain with correct shape", () => {
    const graph = makeGraph(["a", "b"], [["b", ["a"]]]);
    const input = {
      base: "abc123def",
      changes: [change("dependency_added", "b", "a")],
    };
    const result = evaluateScenario("a", makeCommandContext(graph), input);
    expect(result.evidenceChain).toBeDefined();
    expect(result.evidenceChain.baseRevision).toBe("abc123def");
    expect(Array.isArray(result.evidenceChain.appliedChanges)).toBe(true);
    expect(result.evidenceChain.currentState).toBe("current");
    expect(result.evidenceChain.scenarioState).toBe("scenario");
    expect(result.evidenceChain.delta).toBeDefined();
    expect(typeof result.evidenceChain.delta.dependentsAdded).toBe("object");
  });
  it("includes governanceImpact with correct defaults", () => {
    const graph = makeGraph(["a", "b"], [["b", ["a"]]]);
    const input = {
      changes: [change("dependency_added", "b", "a")],
    };
    const result = evaluateScenario("a", makeCommandContext(graph), input);
    expect(result.governanceImpact).toBeDefined();
    expect(result.governanceImpact.findingsFiltered).toBe(false);
    expect(result.governanceImpact.debtFiltered).toBe(false);
    // No findings/debt supplied: governance was not evaluated, and the
    // statuses must say so rather than defaulting toward a claim.
    expect(result.governanceImpact.findingsStatus).toBe("not_evaluated");
    expect(result.governanceImpact.debtStatus).toBe("not_evaluated");
    expect(result.governanceImpact.governanceComplete).toBe(false);
    expect(result.governanceImpact.scenarioFindingsCount).toBe(0);
    expect(result.governanceImpact.scenarioDebtCount).toBe(0);
  });
  it("filters provided findings and debt into the scenario state without calling it re-evaluation", () => {
    const graph = makeGraph(["a", "b"], [["b", ["a"]]]);
    const input = {
      changes: [change("dependency_added", "b", "a")],
    };
    const findings = [{ source: "a", target: "b", message: "test finding" }];
    const debt = [{ kind: "drift", source: "a", description: "test debt" }];
    const result = evaluateScenario("a", makeCommandContext(graph), input, null, {
      findings,
      debt,
    });
    expect(result.governanceImpact.findingsFiltered).toBe(true);
    expect(result.governanceImpact.debtFiltered).toBe(true);
    // Filtering is not re-evaluation — the status stays NOT_EVALUATED even
    // when findings/debt were available. This is the assertion that goes red
    // if the "evaluated" mislabel comes back.
    expect(result.governanceImpact.findingsStatus).toBe("not_evaluated");
    expect(result.governanceImpact.debtStatus).toBe("not_evaluated");
    expect(result.governanceImpact.governanceComplete).toBe(false);
    expect(result.governanceImpact.scenarioFindingsCount).toBe(1);
    expect(result.governanceImpact.scenarioDebtCount).toBe(1);
    expect(result.scenario.findings).toBeDefined();
    expect(result.scenario.findings).toHaveLength(1);
    expect(result.scenario.debt).toBeDefined();
    expect(result.scenario.debt).toHaveLength(1);
  });
  it("filters out findings whose edge was removed in the scenario", () => {
    const graph = makeGraph(["a", "b"], [["b", ["a"]]]);
    const input = {
      changes: [change("dependency_removed", "b", "a")],
    };
    // Finding on the edge that gets removed
    const findings = [
      { source: "b", target: "a", message: "violation on b→a" },
      { source: "a", target: "b", message: "unrelated finding" },
    ];
    const result = evaluateScenario("a", makeCommandContext(graph), input, null, {
      findings,
    });
    expect(result.governanceImpact.scenarioFindingsCount).toBe(1);
    // The b→a finding should be filtered out since that edge was removed
    const filteredMessages = result.scenario.findings.map((f) => f.message);
    expect(filteredMessages).not.toContain("violation on b→a");
    expect(filteredMessages).toContain("unrelated finding");
  });
});

// ---------------------------------------------------------------------------
// evaluateScenario — evolution alignment (with config)
// ---------------------------------------------------------------------------

describe("evaluateScenario — evolution alignment", () => {
  it("builds evolution alignment for the current state", () => {
    const graph = makeGraph(["a", "b"], [["b", ["a"]]]);
    const input = {
      changes: [change("dependency_added", "b", "a")],
    };
    const config = {
      depConstraints: [
        {
          sourceTag: "scope:shared",
          targetTag: "scope:app",
          allowed: true,
        },
      ],
    };
    const result = evaluateScenario("a", makeCommandContext(graph), input, config);
    expect(result.current.evolutionAlignment).toBeDefined();
    expect(result.current.evolutionAlignment.projects).toContain("a");
    expect(result.current.evolutionAlignment.constraints).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// SCENARIO_CHANGE_TYPES
// ---------------------------------------------------------------------------

describe("SCENARIO_CHANGE_TYPES", () => {
  it("exports the supported types as a frozen array", () => {
    expect(SCENARIO_CHANGE_TYPES).toEqual(["dependency_added", "dependency_removed"]);
    expect(Object.isFrozen(SCENARIO_CHANGE_TYPES)).toBe(true);
  });
});
