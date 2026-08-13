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
            data: { root: "libs/alpha" },
            tags: ["layer:domain"],
          },
          beta: {
            name: "beta",
            type: "lib",
            data: { root: "libs/beta" },
            tags: [],
          },
          gamma: {
            name: "gamma",
            type: "lib",
            data: { root: "libs/gamma" },
            tags: [],
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
});
