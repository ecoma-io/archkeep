import { describe, expect, it } from "vitest";

import { DEFAULT_WORKSPACE_LAYOUT } from "../rules/specifiers.mjs";
import {
  buildDependencies,
  buildProjects,
  computePolicyFingerprint,
  graphCommand,
} from "./graph.mjs";

/**
 * What `graph` guarantees: determinism, completeness, and that nothing the
 * rule engine uses internally leaks into the snapshot the consumer sees.
 *
 * The "empty result is a claim" invariant is tested here in the silent
 * direction: an incomplete graph must return `status: "no-verdict"`, never
 * `status: "ok"` with missing entries.
 */

// ---------------------------------------------------------------------------
// buildProjects
// ---------------------------------------------------------------------------

describe("buildProjects", () => {
  it("strips internal data fields the rule engine uses but the consumer does not see", () => {
    const nodes = {
      a: {
        name: "a",
        type: "lib",
        data: {
          root: "libs/a",
          mfeRemote: "http://remote",
          entryPoints: ["src/main.ts"],
          declaredPackages: ["@scope/a"],
        },
      },
    };
    const [project] = buildProjects(nodes);
    expect(project).toEqual({ name: "a", root: "libs/a", type: "lib", tags: [] });
    expect("mfeRemote" in project).toBe(false);
    expect("entryPoints" in project).toBe(false);
    expect("declaredPackages" in project).toBe(false);
  });

  it("sorts projects by name using plain string comparison (never localeCompare)", () => {
    const nodes = {
      z: { name: "z", data: { root: "libs/z" } },
      a: { name: "a", data: { root: "libs/a" } },
      m: { name: "m", data: { root: "libs/m" } },
    };
    const names = buildProjects(nodes).map((p) => p.name);
    expect(names).toEqual(["a", "m", "z"]);
  });

  it("reads tags from data.tags (no provider writes node.tags)", () => {
    const nodes = {
      a: { name: "a", data: { root: "libs/a", tags: ["scope:core"] } },
    };
    const [project] = buildProjects(nodes);
    expect(project.tags).toEqual(["scope:core"]);
  });

  it("uses an empty array when data.tags is absent", () => {
    const nodes = {
      a: { name: "a", data: { root: "libs/a" } },
    };
    const [project] = buildProjects(nodes);
    expect(project.tags).toEqual([]);
  });

  it("sorts a project's own tags deterministically, whatever order they were written in", () => {
    const descending = {
      a: { name: "a", data: { root: "libs/a", tags: ["scope:z", "scope:a"] } },
    };
    expect(buildProjects(descending)[0].tags).toEqual(["scope:a", "scope:z"]);
    const ascending = {
      a: { name: "a", data: { root: "libs/a", tags: ["scope:a", "scope:z"] } },
    };
    expect(buildProjects(ascending)[0].tags).toEqual(["scope:a", "scope:z"]);
  });

  it("includes targets when the node declares any", () => {
    const nodes = {
      a: {
        name: "a",
        data: { root: "libs/a", targets: { build: {}, test: {} } },
      },
    };
    const [project] = buildProjects(nodes);
    expect(project.targets).toEqual(["build", "test"]);
  });

  it("sorts target names deterministically using plain string comparison", () => {
    const nodes = {
      a: {
        name: "a",
        data: { root: "libs/a", targets: { test: {}, build: {}, lint: {} } },
      },
    };
    const [project] = buildProjects(nodes);
    expect(project.targets).toEqual(["build", "lint", "test"]);
  });

  it("omits targets when the node has none — not an empty array", () => {
    const nodes = {
      a: {
        name: "a",
        data: { root: "libs/a", targets: {} },
      },
    };
    const [project] = buildProjects(nodes);
    expect("targets" in project).toBe(false);
  });

  it("omits targets when the node has no targets key at all", () => {
    const nodes = {
      a: { name: "a", data: { root: "libs/a" } },
    };
    const [project] = buildProjects(nodes);
    expect("targets" in project).toBe(false);
  });

  it("includes type from node.type when present", () => {
    const nodes = {
      a: { name: "a", type: "lib", data: { root: "libs/a" } },
    };
    const [project] = buildProjects(nodes);
    expect(project.type).toBe("lib");
  });

  it("omits type when node has no type field", () => {
    const nodes = {
      a: { name: "a", data: { root: "libs/a" } },
    };
    const [project] = buildProjects(nodes);
    expect(project.type).toBeUndefined();
  });

  it("produces byte-identical output regardless of insertion order", () => {
    // Silent direction: an order-dependent payload makes every `diff` report
    // phantom changes and trains users to ignore it.
    const nodesA = {
      alpha: { name: "alpha", data: { root: "libs/alpha" } },
      beta: { name: "beta", data: { root: "libs/beta" } },
    };
    const nodesB = {
      beta: { name: "beta", data: { root: "libs/beta" } },
      alpha: { name: "alpha", data: { root: "libs/alpha" } },
    };
    expect(JSON.stringify(buildProjects(nodesA))).toEqual(JSON.stringify(buildProjects(nodesB)));
  });

  it("handles null-prototype containers (native graph)", () => {
    // The native graph uses null-prototype containers for `__proto__` safety.
    const nodes = Object.create(null);
    nodes.a = { name: "a", data: { root: "libs/a" } };
    const [project] = buildProjects(nodes);
    expect(project.name).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// buildDependencies
// ---------------------------------------------------------------------------

describe("buildDependencies", () => {
  it("flattens the source-keyed map into a sorted array", () => {
    const dependencies = {
      b: [{ target: "c", type: "static" }],
      a: [
        { target: "b", type: "static" },
        { target: "c", type: "dynamic" },
      ],
    };
    const edges = buildDependencies(dependencies);
    expect(edges).toEqual([
      { source: "a", target: "b", type: "static" },
      { source: "a", target: "c", type: "dynamic" },
      { source: "b", target: "c", type: "static" },
    ]);
  });

  it("uses (source, target, type) as identity — a type change is an added and a removed edge", () => {
    const dependencies = {
      a: [
        { target: "b", type: "static" },
        { target: "b", type: "dynamic" },
      ],
    };
    const edges = buildDependencies(dependencies);
    expect(edges).toEqual([
      { source: "a", target: "b", type: "dynamic" },
      { source: "a", target: "b", type: "static" },
    ]);
  });

  it("handles null-prototype dependency containers", () => {
    const dependencies = Object.create(null);
    dependencies.a = [{ target: "b", type: "static" }];
    const edges = buildDependencies(dependencies);
    expect(edges).toEqual([{ source: "a", target: "b", type: "static" }]);
  });

  it("orders edges by source even when sources are listed descending", () => {
    const dependencies = {
      a: [{ target: "x", type: "static" }],
      z: [{ target: "y", type: "static" }],
    };
    expect(buildDependencies(dependencies).map((e) => e.source)).toEqual(["a", "z"]);
  });

  it("orders same-source edges by target, both spellings of the pair", () => {
    const descending = {
      a: [
        { target: "z", type: "static" },
        { target: "y", type: "static" },
      ],
    };
    expect(buildDependencies(descending).map((e) => e.target)).toEqual(["y", "z"]);
    const ascending = {
      a: [
        { target: "y", type: "static" },
        { target: "z", type: "static" },
      ],
    };
    expect(buildDependencies(ascending).map((e) => e.target)).toEqual(["y", "z"]);
  });

  it("orders same-pair edges by type, both spellings of the pair", () => {
    const descending = {
      a: [
        { target: "b", type: "dynamic" },
        { target: "b", type: "static" },
      ],
    };
    expect(buildDependencies(descending).map((e) => e.type)).toEqual(["dynamic", "static"]);
    const ascending = {
      a: [
        { target: "b", type: "static" },
        { target: "b", type: "dynamic" },
      ],
    };
    expect(buildDependencies(ascending).map((e) => e.type)).toEqual(["dynamic", "static"]);
  });
});

// ---------------------------------------------------------------------------
// graphCommand
// ---------------------------------------------------------------------------

describe("graphCommand", () => {
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
        },
        dependencies: {
          alpha: [{ target: "beta", type: "static" }],
        },
      },
      analysis: {
        analyzed: 4,
        imports: [{ sourceFile: "libs/alpha/a.go", specifier: "beta", line: 1, column: 1 }],
        failures: [],
      },
      pluginGap: { registered: true, manifests: [] },
      ...overrides,
    };
  }

  it("returns a deterministic snapshot sorted by plain string comparison", () => {
    const result = graphCommand(commandContext());
    expect(result.projects.map((p) => p.name)).toEqual(["alpha", "beta"]);
    expect(result.dependencies).toEqual([{ source: "alpha", target: "beta", type: "static" }]);
  });

  it("returns status 'ok' and exit-eligible coverage when the graph is complete", () => {
    const result = graphCommand(commandContext());
    expect(result.status).toBe("ok");
    expect(result.coverage.complete).toBe(true);
    expect(result.coverage.notAnalyzed).toEqual([]);
  });

  it("returns status 'no-verdict' when the graph has whole-file analysis failures", () => {
    const result = graphCommand(
      commandContext({
        analysis: {
          analyzed: 3,
          imports: [],
          failures: [
            { sourceFile: "libs/alpha/broken.go", line: null, column: null, reason: "parse error" },
          ],
        },
      }),
    );
    expect(result.status).toBe("no-verdict");
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.notAnalyzed).toEqual([
      { file: "libs/alpha/broken.go", reason: "parse error" },
    ]);
  });

  it("throws when the plugin is unregistered on a polyglot Nx workspace", () => {
    expect(() =>
      graphCommand(
        commandContext({
          provider: "nx",
          pluginGap: { registered: false, manifests: ["libs/alpha/go.mod"] },
        }),
      ),
    ).toThrow(/refusing to build a graph snapshot/);
  });

  it("does not throw when the plugin is unregistered on a pure-TypeScript Nx workspace", () => {
    const result = graphCommand(
      commandContext({
        provider: "nx",
        pluginGap: { registered: false, manifests: [] },
      }),
    );
    expect(result.status).toBe("ok");
  });

  it("does not throw when the plugin is registered even with polyglot manifests", () => {
    const result = graphCommand(
      commandContext({
        provider: "nx",
        pluginGap: { registered: true, manifests: ["libs/alpha/go.mod"] },
      }),
    );
    expect(result.status).toBe("ok");
  });

  it("produces both text and JSON report renderings", () => {
    const result = graphCommand(commandContext());
    expect(result.report.text).toContain("2 projects");
    expect(result.report.json).toContain('"schemaVersion"');
    expect(result.report.json).toContain('"command": "graph"');
  });

  it("includes blind spots from non-whole-file failures", () => {
    const result = graphCommand(
      commandContext({
        analysis: {
          analyzed: 4,
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

  it("uses default workspace layout when the graph does not carry one", () => {
    const result = graphCommand(commandContext());
    expect(result.workspaceLayout).toEqual(DEFAULT_WORKSPACE_LAYOUT);
    expect(result.workspaceLayoutSource).toBe("default");
  });

  it("uses declared workspace layout when the graph carries one", () => {
    const result = graphCommand(
      commandContext({
        graph: {
          nodes: {
            alpha: { name: "alpha", data: { root: "libs/alpha" } },
          },
          dependencies: {},
          workspaceLayout: { appsDir: "applications", libsDir: "packages" },
        },
      }),
    );
    expect(result.workspaceLayout).toEqual({ appsDir: "applications", libsDir: "packages" });
    expect(result.workspaceLayoutSource).toBe("declared");
  });

  it("defaults workspace layout by import, not by literal", () => {
    const result = graphCommand(commandContext());
    expect(result.workspaceLayout).toBe(DEFAULT_WORKSPACE_LAYOUT);
  });

  it("never exits 1 — graph is descriptive", () => {
    const result = graphCommand(commandContext());
    expect(result.status).not.toBe("findings");
    // A graph with incomplete coverage returns no-verdict (maps to exit 3), never findings (exit 1).
    const incomplete = graphCommand(
      commandContext({
        analysis: {
          analyzed: 3,
          imports: [],
          failures: [{ sourceFile: "x.go", line: null, column: null, reason: "err" }],
        },
      }),
    );
    expect(incomplete.status).toBe("no-verdict");
  });
});

// ---------------------------------------------------------------------------
// computePolicyFingerprint
// ---------------------------------------------------------------------------

describe("computePolicyFingerprint", () => {
  it("returns a deterministic SHA-256 hex string", () => {
    const config = {
      depConstraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] }],
      options: { allow: [], banTransitiveDependencies: false },
      suppressions: [],
    };
    const fingerprint = computePolicyFingerprint(config);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // Same config → same fingerprint.
    expect(computePolicyFingerprint(config)).toBe(fingerprint);
  });

  it("produces different fingerprints for different policies", () => {
    const config1 = {
      depConstraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] }],
      options: { allow: [] },
      suppressions: [],
    };
    const config2 = {
      depConstraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:util"] }],
      options: { allow: [] },
      suppressions: [],
    };
    expect(computePolicyFingerprint(config1)).not.toBe(computePolicyFingerprint(config2));
  });

  it("treats missing fields as empty defaults", () => {
    const minimal = {};
    const explicit = { depConstraints: [], options: {}, suppressions: [] };
    expect(computePolicyFingerprint(minimal)).toBe(computePolicyFingerprint(explicit));
  });

  it("moves when a declared custom rule's artifact hash moves, and not when the key is absent", () => {
    // The silent direction this covers: a policy's `customRules` row pins an
    // artifact by `sha256`, so swapping that hash swaps the law the run
    // executes. A fingerprint blind to the field would let `diff` report the
    // policy unchanged across exactly that edit. The absent case is the other
    // half — a policy that declares no custom rules must fingerprint as it did
    // before the field was covered, so extending the hash moved no existing
    // snapshot.
    const base = { depConstraints: [], options: {}, suppressions: [] };
    const withRule = (sha256) => ({
      ...base,
      customRules: [
        {
          name: "no-interface-outside-domain",
          artifact: "tools/rules/x.wasm",
          sha256,
          reason: "r",
        },
      ],
    });
    expect(computePolicyFingerprint(withRule("a".repeat(64)))).not.toBe(
      computePolicyFingerprint(withRule("b".repeat(64))),
    );
    expect(computePolicyFingerprint(base)).toBe(
      computePolicyFingerprint({ depConstraints: [], options: {}, suppressions: [] }),
    );
    expect(computePolicyFingerprint(withRule("a".repeat(64)))).not.toBe(
      computePolicyFingerprint(base),
    );
  });

  it("is key-order independent — same policy with different key order produces same fingerprint", () => {
    // Two options objects with the same keys but different insertion order.
    const configA = {
      depConstraints: [],
      options: { allow: [], banTransitiveDependencies: false, bannedExternalImports: [] },
      suppressions: [],
    };
    const configB = {
      depConstraints: [],
      options: { bannedExternalImports: [], banTransitiveDependencies: false, allow: [] },
      suppressions: [],
    };
    expect(computePolicyFingerprint(configA)).toBe(computePolicyFingerprint(configB));
  });
});

// ---------------------------------------------------------------------------
// graphCommand — policy fingerprint
// ---------------------------------------------------------------------------

describe("graphCommand — policy fingerprint", () => {
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
        },
        dependencies: {},
      },
      analysis: {
        analyzed: 1,
        imports: [],
        failures: [],
      },
      pluginGap: { registered: true, manifests: [] },
      ...overrides,
    };
  }

  it("omits policy when no config is provided", () => {
    const result = graphCommand(commandContext());
    expect(result.policy).toBeUndefined();
    const envelope = JSON.parse(result.report.json);
    expect(envelope.result.policy).toBeUndefined();
  });

  it("includes policy fingerprint when config is provided", () => {
    const config = {
      depConstraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] }],
      options: { allow: [] },
      suppressions: [],
    };
    const result = graphCommand(commandContext(), { config });
    expect(result.policy).toBeDefined();
    expect(result.policy.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const envelope = JSON.parse(result.report.json);
    expect(envelope.result.policy.fingerprint).toBe(result.policy.fingerprint);
  });
});
