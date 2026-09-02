import { describe, expect, it } from "vitest";

import { UsageError } from "../errors.mjs";
import { composeImpactStatement } from "./impact-statement.mjs";
import { computeImpact, impactCommand } from "./impact.mjs";

/**
 * What `impact` guarantees: the result is an honest account of which projects
 * transitively depend on the named project, and the silent direction is
 * guarded — an empty `dependents` list is a claim ("nothing depends on this"),
 * never silence, and incomplete coverage is a refusal rather than an
 * under-report.
 */

// ---------------------------------------------------------------------------
// computeImpact
// ---------------------------------------------------------------------------

describe("computeImpact", () => {
  it("returns the target project's direct and transitive dependents", () => {
    const graph = {
      nodes: { a: { name: "a" }, b: { name: "b" }, c: { name: "c" }, d: { name: "d" } },
      dependencies: {
        b: [{ target: "a", type: "static" }],
        c: [{ target: "a", type: "static" }],
        d: [{ target: "c", type: "static" }],
      },
    };
    const result = computeImpact("a", graph);
    expect(result.project).toBe("a");
    expect(result.direct).toEqual(["b", "c"]);
    expect(result.transitive).toEqual(["d"]);
    expect(result.dependents).toEqual(["b", "c", "d"]);
  });

  it("returns empty dependents when no project depends on the target", () => {
    const graph = {
      nodes: { a: { name: "a" }, b: { name: "b" } },
      dependencies: {
        a: [{ target: "b", type: "static" }],
      },
    };
    // a depends on b, so impact of a is: who depends on a? Nobody.
    const result = computeImpact("a", graph);
    expect(result.project).toBe("a");
    expect(result.direct).toEqual([]);
    expect(result.transitive).toEqual([]);
    expect(result.dependents).toEqual([]);
  });
  it("returns arrays (not null or undefined) when no project depends on the target", () => {
    const graph = {
      nodes: { a: { name: "a" }, b: { name: "b" } },
      dependencies: {
        a: [{ target: "b", type: "static" }],
      },
    };
    const result = computeImpact("a", graph);
    expect(Array.isArray(result.direct)).toBe(true);
    expect(Array.isArray(result.transitive)).toBe(true);
    expect(Array.isArray(result.dependents)).toBe(true);
  });

  it("throws when the project is not in the graph", () => {
    const graph = {
      nodes: { a: { name: "a" } },
      dependencies: {},
    };
    expect(() => computeImpact("nonexistent", graph)).toThrow(/no project named 'nonexistent'/);
  });

  it("lists available projects in the error message when the project is not found", () => {
    const graph = {
      nodes: { alpha: { name: "alpha" }, beta: { name: "beta" } },
      dependencies: {},
    };
    expect(() => computeImpact("missing", graph)).toThrow(/available projects: alpha, beta/);
  });
  it("throws UsageError (not a generic Error) when the project is not in the graph", () => {
    const graph = {
      nodes: { a: { name: "a" } },
      dependencies: {},
    };
    let thrown = null;
    try {
      computeImpact("nonexistent", graph);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UsageError);
    expect(thrown).toBeInstanceOf(Error);
  });

  it("deduplicates direct dependents when multiple edges exist between the same pair", () => {
    const graph = {
      nodes: { a: { name: "a" }, b: { name: "b" } },
      dependencies: {
        b: [
          { target: "a", type: "static" },
          { target: "a", type: "dynamic" },
        ],
      },
    };
    const result = computeImpact("a", graph);
    expect(result.direct).toEqual(["b"]);
    expect(result.dependents).toEqual(["b"]);
  });

  it("sorts results using plain string comparison (never localeCompare)", () => {
    const graph = {
      nodes: {
        z: { name: "z" },
        a: { name: "a" },
        m: { name: "m" },
        core: { name: "core" },
      },
      dependencies: {
        z: [{ target: "core", type: "static" }],
        a: [{ target: "core", type: "static" }],
        m: [{ target: "core", type: "static" }],
      },
    };
    const result = computeImpact("core", graph);
    expect(result.direct).toEqual(["a", "m", "z"]);
    expect(result.dependents).toEqual(["a", "m", "z"]);
  });

  it("handles deep transitive chains", () => {
    const graph = {
      nodes: {
        base: { name: "base" },
        layer1: { name: "layer1" },
        layer2: { name: "layer2" },
        layer3: { name: "layer3" },
      },
      dependencies: {
        layer1: [{ target: "base", type: "static" }],
        layer2: [{ target: "layer1", type: "static" }],
        layer3: [{ target: "layer2", type: "static" }],
      },
    };
    const result = computeImpact("base", graph);
    expect(result.direct).toEqual(["layer1"]);
    expect(result.transitive).toEqual(["layer2", "layer3"]);
    expect(result.dependents).toEqual(["layer1", "layer2", "layer3"]);
  });

  it("handles a project with no edges at all", () => {
    const graph = {
      nodes: { isolated: { name: "isolated" } },
      dependencies: {},
    };
    const result = computeImpact("isolated", graph);
    expect(result.direct).toEqual([]);
    expect(result.transitive).toEqual([]);
    expect(result.dependents).toEqual([]);
  });

  it("handles null-prototype dependency containers (native graph)", () => {
    const dependencies = Object.create(null);
    dependencies.b = [{ target: "a", type: "static" }];
    const graph = {
      nodes: { a: { name: "a" }, b: { name: "b" } },
      dependencies,
    };
    const result = computeImpact("a", graph);
    expect(result.direct).toEqual(["b"]);
    expect(result.dependents).toEqual(["b"]);
  });

  it("visits a transitive dependent once when two paths reach it — the diamond", () => {
    // a is reachable through b AND through c; the BFS must not record it
    // twice, or the transitive set would double-report one project.
    const graph = {
      nodes: { a: { name: "a" }, b: { name: "b" }, c: { name: "c" }, d: { name: "d" } },
      dependencies: {
        b: [{ target: "d", type: "static" }],
        c: [{ target: "d", type: "static" }],
        a: [
          { target: "b", type: "static" },
          { target: "c", type: "static" },
        ],
      },
    };
    const result = computeImpact("d", graph);
    expect(result.direct).toEqual(["b", "c"]);
    expect(result.transitive).toEqual(["a"]);
    expect(result.dependents).toEqual(["a", "b", "c"]);
  });

  it("lists available projects in ascending order when the name is missing", () => {
    const graph = {
      nodes: { z: { name: "z" }, a: { name: "a" } },
      dependencies: {},
    };
    expect(() => computeImpact("missing", graph)).toThrow(/available projects: a, z/);
  });

  it("sorts transitive dependents by plain string comparison, whichever order they were visited in", () => {
    // `x` is discovered before `a` — the walk order, not the assertion, is
    // what is fixed here — and the sorted result must still read a, x.
    const graph = {
      nodes: {
        a: { name: "a" },
        b: { name: "b" },
        c: { name: "c" },
        d: { name: "d" },
        x: { name: "x" },
      },
      dependencies: {
        c: [{ target: "d", type: "static" }],
        b: [{ target: "d", type: "static" }],
        x: [{ target: "c", type: "static" }],
        a: [{ target: "b", type: "static" }],
      },
    };
    const result = computeImpact("d", graph);
    expect(result.transitive).toEqual(["a", "x"]);
  });
  it("handles a graph with a cycle without infinite looping or incorrect results", () => {
    // a depends on b, b depends on a — a cycle. The BFS visited set
    // must prevent infinite looping. In a cyclic graph the target
    // itself ("a") can appear in the transitive set because the
    // reverse walk reaches it through the cycle.
    const graph = {
      nodes: { a: { name: "a" }, b: { name: "b" }, c: { name: "c" } },
      dependencies: {
        b: [{ target: "a", type: "static" }],
        a: [{ target: "b", type: "static" }],
        c: [{ target: "b", type: "static" }],
      },
    };
    // Impact of a: who depends on a? b (directly), and through the
    // cycle a is reachable from itself, plus c through b.
    const result = computeImpact("a", graph);
    expect(result.project).toBe("a");
    expect(result.direct).toEqual(["b"]);
    // a appears in transitive through the reverse cycle (b→a)
    expect(result.transitive).toEqual(["a", "c"]);
    expect(result.dependents).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// composeImpactStatement
// ---------------------------------------------------------------------------

describe("composeImpactStatement", () => {
  it("returns the expected shape with evolutionAlignment when no config is provided", () => {
    const graph = {
      nodes: { a: { name: "a" }, b: { name: "b" } },
      dependencies: {
        b: [{ target: "a", type: "static" }],
      },
    };
    const commandContext = {
      root: "/workspace",
      graph,
      analysis: { analyzed: 2, imports: [], failures: [], analyzedFiles: [] },
      provider: "native",
      marker: "archkeep.json",
    };
    const statement = composeImpactStatement("a", commandContext);

    expect(statement.project).toBe("a");
    expect(statement.impact).toEqual({
      direct: ["b"],
      transitive: [],
      dependents: ["b"],
    });
    // evolutionAlignment is always present
    expect(statement.evolutionAlignment).toEqual({
      projects: ["a", "b"],
      boundaries: [],
      constraints: [],
      decisions: [],
    });
    expect(statement.complete).toBe(true);
    expect(statement.notes).toEqual([
      "finding and debt impact are not yet evaluated. " +
        "The impact statement covers dependency structure and constraint violations only.",
    ]);
    // No config, so no constraintImpact or decisionImpact
    expect(statement).not.toHaveProperty("constraintImpact");
    expect(statement).not.toHaveProperty("decisionImpact");
  });

  it("returns decisionImpact and constraintImpact when boundary config is provided", () => {
    const graph = {
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
      },
      dependencies: {
        beta: [{ target: "alpha", type: "static" }],
      },
    };
    const commandContext = {
      root: "/workspace",
      graph,
      analysis: { analyzed: 2, imports: [], failures: [], analyzedFiles: [] },
      provider: "native",
      marker: "archkeep.json",
    };
    const config = {
      depConstraints: [
        {
          sourceTag: "layer:app",
          onlyDependOnLibsWithTags: ["layer:domain", "layer:app"],
        },
      ],
    };
    const statement = composeImpactStatement("alpha", commandContext, config);

    expect(statement.project).toBe("alpha");
    expect(statement.impact.dependents).toEqual(["beta"]);
    // constraintImpact is present because config.depConstraints exists
    expect(statement.constraintImpact).toBeDefined();
    expect(Array.isArray(statement.constraintImpact)).toBe(true);
    expect(statement.constraintImpact).toHaveLength(1);
    // decisionImpact is present (though decisions will be empty since no decisionRef)
    expect(statement.decisionImpact).toBeDefined();
    expect(statement.decisionImpact.decisions).toEqual([]);
    expect(statement.decisionImpact.unresolvedDecisionRefs).toEqual([]);
    // evolutionAlignment includes the constraint labels
    expect(statement.evolutionAlignment.projects).toEqual(["alpha", "beta"]);
    expect(statement.evolutionAlignment.constraints).toContain("sourceTag:layer:app");
    expect(statement.complete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// impactCommand
// ---------------------------------------------------------------------------

describe("impactCommand", () => {
  /** Minimal command context that passes the unregistered-plugin refusal. */
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
            data: { root: "libs/beta" },
          },
          gamma: {
            name: "gamma",
            type: "lib",
            data: { root: "libs/gamma" },
          },
        },
        dependencies: {
          beta: [{ target: "alpha", type: "static" }],
          gamma: [{ target: "beta", type: "static" }],
        },
      },
      analysis: {
        analyzed: 6,
        imports: [{ sourceFile: "libs/beta/b.go", specifier: "alpha", line: 1, column: 1 }],
        failures: [],
      },
      pluginGap: { registered: true, manifests: [] },
      ...overrides,
    };
  }

  it("returns 'ok' status with the impact set for a project with dependents", () => {
    const result = impactCommand("alpha", commandContext());
    expect(result.status).toBe("ok");
    expect(result.impact.project).toBe("alpha");
    expect(result.impact.direct).toEqual(["beta"]);
    expect(result.impact.transitive).toEqual(["gamma"]);
    expect(result.impact.dependents).toEqual(["beta", "gamma"]);
  });

  it("warns in coverage.notes that per-edge verdicts cover only depConstraints", () => {
    const result = impactCommand("alpha", commandContext());
    expect(result.coverage.notes).toHaveLength(1);
    expect(result.coverage.notes[0]).toContain("depConstraints");
    expect(result.coverage.notes[0]).toContain("check");
  });

  it("returns 'ok' status with empty dependents for a project with none", () => {
    const result = impactCommand("gamma", commandContext());
    expect(result.status).toBe("ok");
    expect(result.impact.project).toBe("gamma");
    expect(result.impact.direct).toEqual([]);
    expect(result.impact.transitive).toEqual([]);
    expect(result.impact.dependents).toEqual([]);
  });

  it("throws when the project is not in the graph", () => {
    expect(() => impactCommand("nonexistent", commandContext())).toThrow(
      /no project named 'nonexistent'/,
    );
  });

  it("throws on incomplete coverage (whole-file failures)", () => {
    expect(() =>
      impactCommand(
        "alpha",
        commandContext({
          analysis: {
            analyzed: 3,
            imports: [],
            failures: [
              {
                sourceFile: "libs/beta/broken.go",
                line: null,
                column: null,
                reason: "parse error",
              },
            ],
          },
        }),
      ),
    ).toThrow(/incomplete coverage/);
  });

  it("counts the unanalyzed files in the refusal", () => {
    expect(() =>
      impactCommand(
        "alpha",
        commandContext({
          analysis: {
            analyzed: 2,
            imports: [],
            failures: [
              { sourceFile: "a.go", line: null, column: null, reason: "r1" },
              { sourceFile: "b.go", line: null, column: null, reason: "r2" },
            ],
          },
        }),
      ),
    ).toThrow(/2 files could not be analyzed/);
  });

  it("throws when the plugin is unregistered on a polyglot Nx workspace", () => {
    expect(() =>
      impactCommand(
        "alpha",
        commandContext({
          provider: "nx",
          pluginGap: { registered: false, manifests: ["libs/alpha/go.mod"] },
        }),
      ),
    ).toThrow(/refusing to compute impact/);
  });

  it("does not throw when the plugin is unregistered on a pure-TypeScript Nx workspace", () => {
    const result = impactCommand(
      "alpha",
      commandContext({
        provider: "nx",
        pluginGap: { registered: false, manifests: [] },
      }),
    );
    expect(result.status).toBe("ok");
  });

  it("does not throw when the plugin is registered even with polyglot manifests", () => {
    const result = impactCommand(
      "alpha",
      commandContext({
        provider: "nx",
        pluginGap: { registered: true, manifests: ["libs/alpha/go.mod"] },
      }),
    );
    expect(result.status).toBe("ok");
  });

  it("produces both text and JSON report renderings", () => {
    const result = impactCommand("alpha", commandContext());
    expect(result.report.text).toContain("Impact of alpha");
    expect(result.report.json).toContain('"schemaVersion"');
    expect(result.report.json).toContain('"command": "impact"');
  });

  it("includes blind spots from non-whole-file failures", () => {
    const result = impactCommand(
      "alpha",
      commandContext({
        analysis: {
          analyzed: 6,
          imports: [],
          failures: [
            {
              sourceFile: "libs/alpha/a.go",
              line: 7,
              column: 2,
              reason: "unresolvable specifier",
            },
          ],
        },
      }),
    );
    expect(result.status).toBe("ok");
    expect(result.coverage.complete).toBe(true);
    expect(result.coverage.blindSpots).toEqual([
      { file: "libs/alpha/a.go", line: 7, column: 2, reason: "unresolvable specifier" },
    ]);
  });

  it("never exits 1 — impact is descriptive", () => {
    const result = impactCommand("alpha", commandContext());
    expect(result.status).not.toBe("findings");
    // A project with no dependents is still "ok", not a finding.
    const empty = impactCommand("gamma", commandContext());
    expect(empty.status).not.toBe("findings");
  });

  it("includes constraint impact when boundary config is provided", () => {
    const ctx = commandContext({
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
    });
    const config = {
      depConstraints: [
        {
          sourceTag: "layer:app",
          onlyDependOnLibsWithTags: ["layer:domain", "layer:app"],
        },
      ],
    };
    const result = impactCommand("alpha", ctx, config);

    expect(result.impact.constraintImpact).toHaveLength(2);
    // beta depends directly on alpha, and its constraint allows it
    const betaEntry = result.impact.constraintImpact.find((e) => e.project === "beta");
    expect(betaEntry.violations).toHaveLength(0);
    // gamma depends on beta (transitive via alpha's impact set)
    const gammaEntry = result.impact.constraintImpact.find((e) => e.project === "gamma");
    expect(gammaEntry.violations).toHaveLength(0);

    expect(result.report.text).toContain("Constraint context");
    expect(result.report.text).toContain("✔ beta");
    expect(result.report.text).toContain("✔ gamma");

    const envelope = JSON.parse(result.report.json);
    expect(envelope.result.constraintImpact).toHaveLength(2);
  });

  it("reports constraint violations for dependents that break boundary rules", () => {
    const ctx = commandContext({
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
        },
        dependencies: {
          beta: [{ target: "alpha", type: "static" }],
        },
      },
    });
    const config = {
      depConstraints: [
        {
          sourceTag: "layer:app",
          onlyDependOnLibsWithTags: ["layer:app"],
          description: "App isolation",
          remediation: "Move shared logic to an app-level project",
        },
      ],
    };
    const result = impactCommand("alpha", ctx, config);

    expect(result.impact.constraintImpact).toHaveLength(1);
    const entry = result.impact.constraintImpact[0];
    expect(entry.project).toBe("beta");
    expect(entry.violations).toHaveLength(1);
    expect(entry.violations[0].messageId).toBe("onlyTagsConstraintViolation");

    expect(result.report.text).toContain("✖ beta");
    expect(result.report.text).toContain("App isolation");
    expect(result.report.text).toContain("Move shared logic to an app-level project");
  });

  it("omits constraintImpact when no boundary config is provided", () => {
    const result = impactCommand("alpha", commandContext());
    expect(result.impact).not.toHaveProperty("constraintImpact");
  });

  it("includes constraintImpact as empty array when config is provided but no dependents", () => {
    // Bug 2 regression: the renderer hid the section for empty arrays,
    // but the command must always produce constraintImpact when a
    // boundary config is available, so the renderer can show the
    // "no dependents to judge" line.
    const result = impactCommand("gamma", commandContext(), {
      depConstraints: [{ sourceTag: "layer:app", onlyDependOnLibsWithTags: ["layer:domain"] }],
    });
    expect(result.impact.constraintImpact).toBeDefined();
    expect(result.impact.constraintImpact).toEqual([]);
    expect(result.report.text).toContain("Constraint context");
    expect(result.report.text).toContain("no dependents to judge against constraint table");
  });

  it("shows no matching constraint rows for an untagged dependent", () => {
    const ctx = commandContext({
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
            data: { root: "libs/beta", tags: [] },
          },
        },
        dependencies: {
          beta: [{ target: "alpha", type: "static" }],
        },
      },
    });
    const config = {
      depConstraints: [{ sourceTag: "layer:app", onlyDependOnLibsWithTags: ["layer:domain"] }],
    };
    const result = impactCommand("alpha", ctx, config);

    expect(result.impact.constraintImpact).toHaveLength(1);
    // Untagged beta matches no constraint row, so constraintRows is empty
    expect(result.impact.constraintImpact[0].constraintRows).toHaveLength(0);
    // But the untagged-dependent violation is flagged
    expect(result.impact.constraintImpact[0].violations).toHaveLength(1);
    expect(result.impact.constraintImpact[0].violations[0].messageId).toBe(
      "projectWithoutTagsCannotHaveDependencies",
    );
    expect(result.report.text).toContain("no matching constraint rows");
  });
});
