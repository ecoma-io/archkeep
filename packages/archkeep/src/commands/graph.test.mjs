import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { EXIT, runCli } from "../../cli.mjs";

import { DEFAULT_WORKSPACE_LAYOUT } from "../rules/specifiers.mjs";
import {
  buildDependencies,
  buildProjects,
  computePolicyFingerprint,
  graphCommand,
} from "./graph.mjs";

/** Temp workspaces built below; removed together so a failure leaves no tree. */
const fixtures = [];
afterAll(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true });
});

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
      marker: "archkeep.json",
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

// ---------------------------------------------------------------------------
// graph over a workspace that has not written a boundary law yet — and over
// one that named a law which is no longer there
// ---------------------------------------------------------------------------

describe("the graph command's boundary-config load", () => {
  // #265. `graph` describes the project graph, not the boundary law: it takes
  // no `--config`, reads no constraint row, and uses the loaded policy for one
  // optional field. It refused with exit 3 when `module-boundaries.config.mjs`
  // was absent, which sits exactly on the adoption path — the first thing a
  // workspace wants is "what does Archkeep see", and that is the answer it needs
  // in order to write a first policy at all.
  //
  // The fix for that opened a second, silent hole, and both directions are
  // pinned below. Tolerating a missing law is right for a workspace that never
  // named one and wrong for a workspace that named
  // `policy-we-declared.mjs` and then renamed or deleted it: the second is a
  // law somebody wrote going quiet, byte-identical in every report to a
  // workspace that never had one. The two are separated only by
  // `options.boundaryConfigDeclared` (`../options.mjs`'s header owns the
  // argument; `./context.mjs` carries it onto `CommandContext.options`), which
  // is why every pair below fixes the resolved FILENAME and varies only
  // whether the workspace named it.
  //
  // Driven through `runCli` rather than `graphCommand` on purpose: the defect
  // was never in this module (`graphCommand` already treats `config` as
  // optional), it was in the caller loading it unconditionally, so a test
  // calling `graphCommand(context, { config: null })` would have been green
  // throughout the bug.

  /**
   * An `nx.json` that registers the plugin and names NO boundary law — the
   * bare-string plugin form Nx accepts. This is what "a workspace with no
   * boundary config at all" has to be written as: the suite used to write a
   * `plugins[].options.boundaryConfig` here, which is a workspace DECLARING
   * the convention filename, so the case it claimed to model was never the
   * case it ran.
   */
  const NX_NAMES_NO_LAW = `${JSON.stringify({ plugins: ["@ecoma-io/archkeep/nx"] })}\n`;

  /** An `nx.json` whose plugin entry names `boundaryConfig` — a declaration. */
  const nxNaming = (boundaryConfig) =>
    `${JSON.stringify({
      plugins: [{ plugin: "@ecoma-io/archkeep/nx", options: { boundaryConfig } }],
    })}\n`;

  /** A `archkeep.json` for the same two projects, with `extra` merged on top. */
  const nativeModel = (extra) =>
    `${JSON.stringify({
      projects: {
        declared: [
          { root: "libs/core", name: "core", tags: ["layer:core"] },
          { root: "apps/app", name: "app", type: "app", tags: ["layer:app"] },
        ],
      },
      ...extra,
    })}\n`;

  const VALID_LAW = `export const depConstraints = [
  { sourceTag: "layer:app", onlyDependOnLibsWithTags: ["layer:core", "layer:app"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`;

  /** The same law as an inline `archkeep.json` object — the fourth spelling. */
  const INLINE_LAW = {
    depConstraints: [
      { sourceTag: "layer:app", onlyDependOnLibsWithTags: ["layer:core", "layer:app"] },
    ],
    moduleBoundaryOptions: {
      allow: [],
      buildTargets: ["build"],
      enforceBuildableLibDependency: false,
      allowCircularSelfDependency: false,
      checkDynamicDependenciesExceptions: [],
      ignoredCircularDependencies: [],
      banTransitiveDependencies: false,
      checkNestedExternalImports: false,
    },
  };

  const GRAPH = {
    nodes: {
      core: { name: "core", type: "lib", data: { root: "libs/core", tags: ["layer:core"] } },
      app: { name: "app", type: "app", data: { root: "apps/app", tags: ["layer:app"] } },
    },
    dependencies: { core: [], app: [] },
  };

  /** Writes `entries` into a fresh tmpdir and returns the tracked-file list. */
  const treeOf = (prefix, entries) => {
    const root = mkdtempSync(join(tmpdir(), prefix));
    fixtures.push(root);
    for (const [path, text] of Object.entries(entries)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  };

  /** A tracked Nx tree: `nx.json` plus `files`, with the graph injected. */
  const nxWorkspace = (nxJson, files = {}) => {
    const entries = { "nx.json": nxJson, "libs/core/README.md": "core\n", ...files };
    return {
      cwd: treeOf("archkeep-graph-nx-", entries),
      readGraph: () => GRAPH,
      listFiles: () => Object.keys(entries),
    };
  };

  /**
   * A tracked native tree: `archkeep.json` plus `files`, and no `readGraph` at
   * all — the native provider derives the graph from the model itself, which
   * is why this branch has to be driven separately rather than by swapping one
   * marker file in the Nx fixture.
   */
  const nativeWorkspace = (model, files = {}) => {
    const entries = {
      "archkeep.json": nativeModel(model),
      "libs/core/go.mod": "module example.com/core\n\ngo 1.24\n",
      "libs/core/core.go": "package core\n",
      "apps/app/go.mod": "module example.com/app\n\ngo 1.24\n",
      "apps/app/app.go": "package app\n",
      ...files,
    };
    return {
      cwd: treeOf("archkeep-graph-native-", entries),
      listFiles: () => Object.keys(entries),
    };
  };

  const streamsFor = (context) => {
    const out = [];
    const err = [];
    return {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      lines: { out, err },
      ...context,
    };
  };

  /** `graph --format json`'s exit code, stdout envelope and stderr text. */
  const runGraphOn = async (context) => {
    const streams = streamsFor(context);
    const exit = await runCli(["graph", "--format", "json"], streams);
    const stdout = streams.lines.out.join("\n");
    return {
      exit,
      err: streams.lines.err.join("\n"),
      envelope: stdout === "" ? null : JSON.parse(stdout),
    };
  };

  // -- 1. nothing declared, no law on disk: answered (#265 stays fixed) ------

  it("nx: answers on a workspace that never named a boundary law", async () => {
    // The reported run. Exit 0, and a real snapshot on stdout — not an empty
    // one: "it did not refuse" would pass against a command that answered
    // nothing, so the projects it found are asserted too.
    const { exit, envelope } = await runGraphOn(nxWorkspace(NX_NAMES_NO_LAW));
    expect(exit).toBe(EXIT.ok);
    expect(envelope.result.projects.map((project) => project.name)).toEqual(["app", "core"]);
    // No law, no policy identity — the snapshot says so by omission rather
    // than by carrying a fingerprint of nothing.
    expect(envelope.result.policy).toBeUndefined();
  });

  it("nx: answers on a workspace with no plugins entry at all", async () => {
    // The other undeclared shape, and the commoner one: a tree that never
    // registered the plugin. `readPluginOptions` defaults both filenames for
    // it, and defaulting is not declaring.
    const { exit, envelope } = await runGraphOn(nxWorkspace("{}\n"));
    expect(exit).toBe(EXIT.ok);
    expect(envelope.result.projects.map((project) => project.name)).toEqual(["app", "core"]);
    expect(envelope.result.policy).toBeUndefined();
  });

  it("native: answers on a archkeep.json that names no boundary law", async () => {
    const { exit, envelope } = await runGraphOn(nativeWorkspace({}));
    expect(exit).toBe(EXIT.ok);
    expect(envelope.result.projects.map((project) => project.name)).toEqual(["app", "core"]);
    expect(envelope.result.policy).toBeUndefined();
  });

  // -- 2. declared, and the file is gone: refused, naming the file ----------

  it("nx: refuses when the workspace NAMED a boundary law that is not there", async () => {
    // The silent direction this suite exists for, and the one case that goes
    // red without the provenance bit: `nx.json` names `policy-we-declared.mjs`
    // and the file is absent. Before `options.boundaryConfigDeclared`, the
    // tolerance written for the case above swallowed this one too and `graph`
    // exited 0 with no `policy` field — byte-identical to the run above, on a
    // tree whose law someone renamed or deleted. The message has to name the
    // file, because "a config is missing" is not actionable when the fix is a
    // rename.
    const { exit, err, envelope } = await runGraphOn(
      nxWorkspace(nxNaming("policy-we-declared.mjs")),
    );
    expect(exit).toBe(EXIT.error);
    expect(err).toContain("policy-we-declared.mjs");
    expect(envelope).toBeNull();
  });

  it("nx: refuses even when the declared name IS the convention filename", async () => {
    // The pair that proves the fix reads provenance rather than the value.
    // This `nx.json` resolves `boundaryConfig` to the exact string the
    // undeclared case above resolves to by default; only the declaration
    // differs, and only the declaration may decide the verdict.
    const { exit, err } = await runGraphOn(nxWorkspace(nxNaming("module-boundaries.config.mjs")));
    expect(exit).toBe(EXIT.error);
    expect(err).toContain("module-boundaries.config.mjs");
  });

  it("native: refuses when archkeep.json NAMED a boundary law that is not there", async () => {
    const { exit, err, envelope } = await runGraphOn(
      nativeWorkspace({ boundaryConfig: "policy-we-declared.mjs" }),
    );
    expect(exit).toBe(EXIT.error);
    expect(err).toContain("policy-we-declared.mjs");
    expect(envelope).toBeNull();
  });

  it("native: refuses even when the declared name IS the convention filename", async () => {
    const { exit, err } = await runGraphOn(
      nativeWorkspace({ boundaryConfig: "module-boundaries.config.mjs" }),
    );
    expect(exit).toBe(EXIT.error);
    expect(err).toContain("module-boundaries.config.mjs");
  });

  // -- 3. the law is there and will not load: refused, either way -----------

  it("nx: still refuses when a boundary config is there and will not load", async () => {
    // The silent-direction guard on the #265 fix itself, on the harder side:
    // nothing is DECLARED here, so the tolerance applies — and it must still
    // not extend to a law the workspace wrote and this tool cannot read.
    // Skipping the load because a file is missing is one thing; swallowing a
    // law that IS there is another.
    const { exit, err } = await runGraphOn(
      nxWorkspace(NX_NAMES_NO_LAW, {
        "module-boundaries.config.mjs": "export const depConstraints = [\n",
      }),
    );
    expect(exit).toBe(EXIT.error);
    expect(err).toContain("module-boundaries.config.mjs");
  });

  it("native: still refuses when a declared boundary config will not load", async () => {
    const { exit, err } = await runGraphOn(
      nativeWorkspace(
        { boundaryConfig: "policy-we-declared.mjs" },
        { "policy-we-declared.mjs": "export const depConstraints = [\n" },
      ),
    );
    expect(exit).toBe(EXIT.error);
    expect(err).toContain("policy-we-declared.mjs");
  });

  // -- 4. every explicit declaration stays loud -----------------------------

  it("nx: still carries a policy fingerprint when the workspace has written a law", async () => {
    // The positive control for "policy absent when there is no config": that
    // assertion would pass against a command which had stopped fingerprinting
    // entirely, so the field has to be reachable on the same fixture shape.
    const { exit, envelope } = await runGraphOn(
      nxWorkspace(NX_NAMES_NO_LAW, { "module-boundaries.config.mjs": VALID_LAW }),
    );
    expect(exit).toBe(EXIT.ok);
    expect(envelope.result.policy.fingerprint).toEqual(expect.any(String));
  });

  it("nx: refuses when a named profile registry is missing", async () => {
    // The profile spelling. `profiles` turns `boundaryConfig` into a NAME
    // rather than a filename, so the missing-file tolerance must not reach it
    // at all — and does not, because it is gated on `hasProfiles` before the
    // provenance bit is even consulted.
    const nxJson = `${JSON.stringify({
      plugins: [
        {
          plugin: "@ecoma-io/archkeep/nx",
          options: { boundaryConfig: "strict", profiles: "profiles.json" },
        },
      ],
    })}\n`;
    const { exit, err } = await runGraphOn(nxWorkspace(nxJson));
    expect(exit).toBe(EXIT.error);
    expect(err).toContain("profiles.json");
  });

  it("native: applies an inline archkeep.json policy, which names no file to be missing", async () => {
    // The fourth spelling, and the one where "declared" cannot be a file
    // check: the law is a field on `archkeep.json`, present by construction.
    // It must reach the snapshot as a real policy identity rather than being
    // skipped alongside the absent-file case.
    const { exit, envelope } = await runGraphOn(nativeWorkspace({ boundaryConfig: INLINE_LAW }));
    expect(exit).toBe(EXIT.ok);
    expect(envelope.result.policy.fingerprint).toEqual(expect.any(String));
  });

  it("takes no --config flag, so there is no override to soften", async () => {
    // The remaining explicit declaration `check` has and `graph` does not.
    // Pinned rather than assumed: if `graph` ever grew the flag, the guard
    // above would need an arm for it, and this test is what says so.
    const streams = streamsFor(nxWorkspace(NX_NAMES_NO_LAW));
    expect(await runCli(["graph", "--config", "law.mjs"], streams)).toBe(EXIT.usage);
  });

  it("does not soften the law for a command that judges against it", async () => {
    // The constraint the #265 fix had to respect. `check` reads the constraint
    // table; on a tree with no law it must keep refusing loudly, because
    // reading "no file" as "no rules" would report a clean workspace over
    // every crossing there is — the silent direction, and a far worse bug than
    // the one being fixed.
    const streams = streamsFor(nxWorkspace(NX_NAMES_NO_LAW));
    expect(await runCli(["check"], streams)).toBe(EXIT.error);
    expect(streams.lines.err.join("\n")).toContain("module-boundaries.config.mjs");
  });
});
