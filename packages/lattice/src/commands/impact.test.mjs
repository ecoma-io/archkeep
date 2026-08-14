import { describe, expect, it } from "vitest";

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
      marker: "lattice.json",
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
