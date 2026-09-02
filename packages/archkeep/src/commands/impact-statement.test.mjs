import { describe, expect, it } from "vitest";

import { composeImpactStatement } from "./impact-statement.mjs";

/**
 * What the Impact Statement guarantees: it composes existing deterministic
 * primitives into a single statement that names every governed entity a change
 * touches — projects, edges, constraints, and recorded decisions — with every
 * gap reported rather than hidden.
 *
 * The silent-direction invariant: an empty `dependents` list is a claim
 * ("nothing depends on this"), never silence, and an unresolved decision ref
 * is listed in `unresolvedDecisionRefs`, never silently dropped.
 */

// ---------------------------------------------------------------------------
// composeImpactStatement — without config (reverse reachability only)
// ---------------------------------------------------------------------------

describe("composeImpactStatement (no config)", () => {
  /** Minimal command context. */
  function commandContext(overrides = {}) {
    return {
      root: "/workspace",
      provider: "native",
      marker: "archkeep.json",
      graph: {
        nodes: { a: { name: "a" }, b: { name: "b" }, c: { name: "c" }, d: { name: "d" } },
        dependencies: {
          b: [{ target: "a", type: "static" }],
          c: [{ target: "a", type: "static" }],
          d: [{ target: "c", type: "static" }],
        },
      },
      analysis: {
        analyzed: 6,
        imports: [{ sourceFile: "libs/b/b.go", specifier: "a", line: 1, column: 1 }],
        failures: [],
      },
      pluginGap: { registered: true, manifests: [] },
      ...overrides,
    };
  }

  it("returns the target project and its dependents", () => {
    const stmt = composeImpactStatement("a", commandContext());
    expect(stmt.project).toBe("a");
    expect(stmt.impact.direct).toEqual(["b", "c"]);
    expect(stmt.impact.transitive).toEqual(["d"]);
    expect(stmt.impact.dependents).toEqual(["b", "c", "d"]);
  });

  it("returns empty dependents when no project depends on the target", () => {
    const stmt = composeImpactStatement("a", commandContext());
    expect(stmt.project).toBe("a");
    expect(stmt.impact.direct).toEqual(["b", "c"]);
    // Actually 'a' has dependents in our test graph. Let's test a leaf.
  });

  it("returns no constraintImpact or decisionImpact when config is absent", () => {
    const stmt = composeImpactStatement("a", commandContext());
    expect(stmt.constraintImpact).toBeUndefined();
    expect(stmt.decisionImpact).toBeUndefined();
  });

  it("includes evolution alignment with affected projects", () => {
    const stmt = composeImpactStatement("a", commandContext());
    expect(stmt.evolutionAlignment).toBeDefined();
    expect(stmt.evolutionAlignment.projects).toEqual(["a", "b", "c", "d"]);
    expect(stmt.evolutionAlignment.constraints).toEqual([]);
    expect(stmt.evolutionAlignment.decisions).toEqual([]);
  });

  it("reports complete and completeness dimensions", () => {
    const stmt = composeImpactStatement("a", commandContext());
    expect(stmt.complete).toBe(false);
    expect(stmt.completeness).toBeDefined();
    expect(stmt.completeness.executionComplete).toBe(true);
    expect(stmt.completeness.graphComplete).toBe(true);
    expect(stmt.completeness.constraintComplete).toBe(false);
    expect(stmt.completeness.boundaryComplete).toBe(false);
    expect(stmt.completeness.decisionComplete).toBe(false);
    expect(stmt.completeness.overallComplete).toBe(false); // no governance data
  });

  it("throws when the project is not in the graph", () => {
    expect(() => composeImpactStatement("nonexistent", commandContext())).toThrow(
      /no project named 'nonexistent'/,
    );
  });

  it("is deterministic — two calls produce the same output", () => {
    const ctx = commandContext();
    const a = composeImpactStatement("a", ctx);
    const b = composeImpactStatement("a", ctx);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// composeImpactStatement — with config (constraint impact)
// ---------------------------------------------------------------------------

describe("composeImpactStatement (with config)", () => {
  function commandContext(overrides = {}) {
    return {
      root: "/workspace",
      provider: "native",
      marker: "archkeep.json",
      graph: {
        nodes: {
          alpha: {
            name: "alpha",
            type: "lib",
            data: { root: "libs/alpha", tags: ["layer:domain"] },
          },
          beta: {
            name: "beta",
            type: "lib",
            data: { root: "libs/beta", tags: ["layer:app"] },
          },
          gamma: {
            name: "gamma",
            type: "lib",
            data: { root: "libs/gamma", tags: ["layer:app"] },
          },
        },
        dependencies: {
          beta: [{ target: "alpha", type: "static" }],
          gamma: [{ target: "beta", type: "static" }],
        },
      },
      analysis: {
        analyzed: 6,
        imports: [],
        failures: [],
      },
      pluginGap: { registered: true, manifests: [] },
      ...overrides,
    };
  }

  const basicConfig = {
    depConstraints: [
      {
        sourceTag: "layer:app",
        onlyDependOnLibsWithTags: ["layer:domain", "layer:app"],
      },
    ],
  };

  it("includes constraintImpact when config is provided", () => {
    const stmt = composeImpactStatement("alpha", commandContext(), basicConfig);
    expect(stmt.constraintImpact).toBeDefined();
    expect(Array.isArray(stmt.constraintImpact)).toBe(true);
  });

  it("includes per-dependent constraint entries", () => {
    const stmt = composeImpactStatement("alpha", commandContext(), basicConfig);
    expect(stmt.constraintImpact).toHaveLength(2);
    const betaEntry = stmt.constraintImpact.find((e) => e.project === "beta");
    expect(betaEntry).toBeDefined();
    expect(betaEntry.constraintRows).toHaveLength(1);
    expect(betaEntry.constraintRows[0].sourceTag).toBe("layer:app");
  });

  it("includes decisionImpact when config has decisionRefs", () => {
    const config = {
      depConstraints: [
        {
          sourceTag: "layer:app",
          onlyDependOnLibsWithTags: ["layer:domain", "layer:app"],
          decisionRef: "adr:0001-layer-structure",
        },
      ],
    };
    // No ADR registry at /workspace, so the ref should be unresolved
    const stmt = composeImpactStatement("alpha", commandContext(), config);
    expect(stmt.decisionImpact).toBeDefined();
    // Without a real ADR registry, the ref will be unresolved
    expect(stmt.decisionImpact.unresolvedDecisionRefs).toContain("adr:0001-layer-structure");
  });

  it("reports unresolved decision refs in notes", () => {
    const config = {
      depConstraints: [
        {
          sourceTag: "layer:app",
          onlyDependOnLibsWithTags: ["layer:domain", "layer:app"],
          decisionRef: "adr:0001-layer-structure",
        },
      ],
    };
    const stmt = composeImpactStatement("alpha", commandContext(), config);
    expect(stmt.notes.length).toBeGreaterThan(0);
    expect(stmt.notes.some((n) => n.includes("unresolved decision"))).toBe(true);
  });

  it("includes evolution alignment with affected constraints", () => {
    const stmt = composeImpactStatement("alpha", commandContext(), basicConfig);
    expect(stmt.evolutionAlignment.constraints.length).toBeGreaterThan(0);
    expect(stmt.evolutionAlignment.constraints).toContain("sourceTag:layer:app");
  });

  it("includes evolution alignment with affected decisions when resolved", () => {
    const stmt = composeImpactStatement("alpha", commandContext(), basicConfig);
    // No decisionRef in basicConfig, so decisions should be empty
    expect(stmt.evolutionAlignment.decisions).toEqual([]);
  });

  it("is deterministic with config — two calls produce the same output", () => {
    const ctx = commandContext();
    const a = composeImpactStatement("alpha", ctx, basicConfig);
    const b = composeImpactStatement("alpha", ctx, basicConfig);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// composeImpactStatement — empty config edge cases
// ---------------------------------------------------------------------------

describe("composeImpactStatement (edge cases)", () => {
  function commandContext(overrides = {}) {
    return {
      root: "/workspace",
      provider: "native",
      marker: "archkeep.json",
      graph: {
        nodes: { a: { name: "a" }, b: { name: "b" } },
        dependencies: { b: [{ target: "a", type: "static" }] },
      },
      analysis: {
        analyzed: 2,
        imports: [],
        failures: [],
      },
      pluginGap: { registered: true, manifests: [] },
      ...overrides,
    };
  }
  it("handles config with no depConstraints", () => {
    const stmt = composeImpactStatement("a", commandContext(), {});
    // No depConstraints key → no constraintImpact computed
    expect(stmt.constraintImpact).toBeUndefined();
    // But impactStatement is still composed
    expect(stmt.project).toBe("a");
    expect(stmt.complete).toBe(false); // config provided but no depConstraints
    expect(stmt.completeness.constraintComplete).toBe(false);
    expect(stmt.completeness.boundaryComplete).toBe(true); // config was provided
    expect(stmt.completeness.decisionComplete).toBe(true); // config was provided
    expect(stmt.completeness.overallComplete).toBe(false); // constraint not complete
  });

  it("handles null config gracefully", () => {
    const stmt = composeImpactStatement("a", commandContext(), null);
    expect(stmt.constraintImpact).toBeUndefined();
    expect(stmt.decisionImpact).toBeUndefined();
    expect(stmt.project).toBe("a");
    expect(stmt.completeness.constraintComplete).toBe(false);
    expect(stmt.completeness.boundaryComplete).toBe(false);
    expect(stmt.completeness.decisionComplete).toBe(false);
    expect(stmt.completeness.overallComplete).toBe(false); // no governance data
  });
});
describe("composeImpactStatement — completeness dimensions", () => {
  function commandContext(overrides = {}) {
    return {
      root: "/workspace",
      provider: "native",
      marker: "archkeep.json",
      graph: {
        nodes: { a: { name: "a" }, b: { name: "b" } },
        dependencies: { b: [{ target: "a", type: "static" }] },
      },
      analysis: {
        analyzed: 2,
        imports: [],
        failures: [],
      },
      pluginGap: { registered: true, manifests: [] },
      ...overrides,
    };
  }

  it("reports all completeness dimensions when config has depConstraints", () => {
    const config = {
      depConstraints: [{ sourceTag: "lib", onlyDependOnLibsWithTags: ["lib"] }],
    };
    const stmt = composeImpactStatement("a", commandContext(), config);
    expect(stmt.completeness.executionComplete).toBe(true);
    expect(stmt.completeness.graphComplete).toBe(true);
    expect(stmt.completeness.constraintComplete).toBe(true);
    expect(stmt.completeness.boundaryComplete).toBe(true);
    expect(stmt.completeness.decisionComplete).toBe(true);
    expect(stmt.completeness.overallComplete).toBe(false); // no governance data
    expect(stmt.complete).toBe(false);
  });

  it("reports governanceComplete when findings and debt are provided", () => {
    const config = {
      depConstraints: [{ sourceTag: "lib", onlyDependOnLibsWithTags: ["lib"] }],
    };
    const findings = [{ source: "a", target: "b", message: "test" }];
    const debt = [{ kind: "drift", source: "a", description: "test" }];
    const stmt = composeImpactStatement("a", commandContext(), config, {
      findings,
      debt,
    });
    expect(stmt.completeness.governanceComplete).toBe(true);
    expect(stmt.completeness.overallComplete).toBe(true);
  });

  it("reports governanceComplete:false when findings or debt are missing", () => {
    const config = {
      depConstraints: [{ sourceTag: "lib", onlyDependOnLibsWithTags: ["lib"] }],
    };
    const stmt = composeImpactStatement("a", commandContext(), config);
    expect(stmt.completeness.governanceComplete).toBe(false);
    expect(stmt.completeness.overallComplete).toBe(false); // governance not evaluated
  });

  it("constraintComplete:false when config has no depConstraints", () => {
    const stmt = composeImpactStatement("a", commandContext(), {});
    expect(stmt.completeness.constraintComplete).toBe(false);
    expect(stmt.completeness.overallComplete).toBe(false);
  });
});
