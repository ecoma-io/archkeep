/**
 * Unit tests for `./moon.mjs` — the Moon project-model provider.
 *
 * `moon project-graph --json` is never invoked; its output is injected via
 * the `run` seam, the same way `./nx.test.mjs` drives the Nx provider.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  moonProvider,
  moonMarkerAt,
  readProjectGraph,
  transformMoonGraph,
  MOON_DIR,
  MOON_ALT_DIR,
} from "./moon.mjs";

// ── constants ────────────────────────────────────────────────────────────────

describe("MOON_DIR", () => {
  it('is ".moon"', () => {
    expect(MOON_DIR).toBe(".moon");
  });
});

describe("MOON_ALT_DIR", () => {
  it('is ".config/moon"', () => {
    expect(MOON_ALT_DIR).toBe(".config/moon");
  });
});

describe("moonMarkerAt — the one dispatcher for which Moon directory resolves a root", () => {
  // The paths `moonMarkerAt` tests are the ones IT builds (`join(root, dir)`),
  // so the injected predicate matches on exactly those.
  const existsFor = (...dirs) => {
    const present = new Set(dirs.map((dir) => join("/ws", dir)));
    return (path) => present.has(path);
  };

  it("returns .moon when only the primary directory is present", () => {
    expect(moonMarkerAt("/ws", { exists: existsFor(MOON_DIR) })).toBe(MOON_DIR);
  });

  it("returns .config/moon when only the alternative directory is present", () => {
    expect(moonMarkerAt("/ws", { exists: existsFor(MOON_ALT_DIR) })).toBe(MOON_ALT_DIR);
  });

  it("returns null when neither directory is present", () => {
    expect(moonMarkerAt("/ws", { exists: existsFor() })).toBeNull();
  });

  it("refuses a root carrying both, naming both directories", () => {
    // The red direction of #224's silent preference: before this refusal, a
    // both-directories root resolved silently against `.config/moon` while
    // nothing anywhere said so. Now the winner is nobody to choose.
    expect(() => moonMarkerAt("/ws", { exists: existsFor(MOON_DIR, MOON_ALT_DIR) })).toThrow(
      /declares both \.moon and \.config\/moon/u,
    );
  });
});

describe("moonProvider", () => {
  it("has name moon", () => {
    expect(moonProvider.name).toBe("moon");
  });

  it("has marker .moon", () => {
    expect(moonProvider.marker).toBe(".moon");
  });

  it("has readProjectGraph", () => {
    expect(typeof moonProvider.readProjectGraph).toBe("function");
  });
});

// ── transformMoonGraph ────────────────────────────────────────────────────────

/** A minimal Moon `project-graph --json` output with two projects and one edge. */
function twoProjectGraph() {
  return {
    graph: {
      nodes: [0, 1],
      node_holes: [],
      edge_property: "directed",
      edges: [[0, 1, "production"]],
    },
    data: {
      0: {
        id: "web",
        language: "typescript",
        layer: "application",
        stack: "frontend",
        source: "apps/web",
        root: "/abs/apps/web",
        toolchains: ["system"],
        taskTargets: ["web:build", "web:test"],
        dependencies: [{ id: "api", scope: "production", source: "explicit" }],
        inherited: { configs: {}, layers: {} },
        config: {
          schema: "",
          id: "web",
          language: "typescript",
          layer: "application",
          stack: "frontend",
          tags: ["type-app", "lang-ts"],
          dependsOn: ["api"],
          owners: { paths: [] },
          docker: { file: {}, scaffold: {} },
          toolchains: { plugins: {} },
          workspace: { inheritedTasks: {} },
          tasks: {
            build: {
              command: "echo build web",
              args: null,
              globalInputs: [],
              inputs: [],
              options: { runInSyncPhase: null },
            },
          },
        },
      },
      1: {
        id: "api",
        language: "typescript",
        layer: "library",
        stack: "backend",
        source: "libs/api",
        root: "/abs/libs/api",
        toolchains: ["system"],
        taskTargets: ["api:build"],
        dependencies: [],
        inherited: { configs: {}, layers: {} },
        config: {
          schema: "",
          id: "api",
          language: "typescript",
          layer: "library",
          stack: "backend",
          tags: ["type-lib"],
          dependsOn: [],
          owners: { paths: [] },
          docker: { file: {}, scaffold: {} },
          toolchains: { plugins: {} },
          workspace: { inheritedTasks: {} },
          tasks: {
            build: {
              command: "echo build api",
              args: null,
              globalInputs: [],
              inputs: [],
              options: { runInSyncPhase: null },
            },
          },
        },
      },
    },
  };
}

describe("transformMoonGraph — full transformation", () => {
  it("transforms a two-project Moon graph into Lattice shape", () => {
    const result = transformMoonGraph(twoProjectGraph());

    // Two nodes, keyed by project ID.
    expect(Object.keys(result.nodes).sort()).toEqual(["api", "web"]);

    // web is an app (layer: application → type: "app").
    expect(result.nodes.web).toEqual({
      name: "web",
      type: "app",
      data: {
        root: "apps/web",
        tags: ["lang-ts", "layer:application", "stack:frontend", "type-app"],
        implicitDependencies: [],
        targets: {
          build: { executor: "moon:declared" },
          test: { executor: "moon:declared" },
        },
      },
    });

    // api is a lib (layer: library → type: "lib").
    expect(result.nodes.api).toEqual({
      name: "api",
      type: "lib",
      data: {
        root: "libs/api",
        tags: ["layer:library", "stack:backend", "type-lib"],
        implicitDependencies: [],
        targets: {
          build: { executor: "moon:declared" },
        },
      },
    });

    // One dependency: web → api (production → static).
    expect(result.dependencies.web).toEqual([{ source: "web", target: "api", type: "static" }]);
    // api has no outgoing edges, so it has no entry in the dependencies map.
    expect(result.dependencies.api).toBeUndefined();

    // workspaceLayout inferred from project paths.
    expect(result.workspaceLayout).toEqual({ appsDir: "apps", libsDir: "libs" });
  });
});

describe("transformMoonGraph — error paths", () => {
  it("throws when the raw output has no data map", () => {
    expect(() => transformMoonGraph({ graph: { nodes: [], edges: [] } })).toThrow(
      /produced no `data` map/,
    );
  });

  it("throws when the raw output is null", () => {
    expect(() => transformMoonGraph(null)).toThrow(/produced no `data` map/);
  });
});

describe("transformMoonGraph — node construction", () => {
  it("uses workspace-relative source as root, not the absolute root", () => {
    const raw = twoProjectGraph();
    // The absolute path in raw.data["0"].root should NOT be used.
    raw.data["0"].root = "/totally/different/apps/web";
    const result = transformMoonGraph(raw);
    expect(result.nodes.web.data.root).toBe("apps/web");
  });

  it("maps application layer to app type", () => {
    const raw = twoProjectGraph();
    expect(transformMoonGraph(raw).nodes.web.type).toBe("app");
  });

  it("maps library layer to lib type", () => {
    const raw = twoProjectGraph();
    expect(transformMoonGraph(raw).nodes.api.type).toBe("lib");
  });

  it("maps automation layer to e2e type", () => {
    const raw = twoProjectGraph();
    raw.data["1"].layer = "automation";
    raw.data["1"].id = "e2e-tests";
    raw.data["1"].source = "e2e/tests";
    const result = transformMoonGraph(raw);
    expect(result.nodes["e2e-tests"].type).toBe("e2e");
  });

  it("maps unknown/null layer to lib type", () => {
    const raw = twoProjectGraph();
    raw.data["1"].layer = null;
    const result = transformMoonGraph(raw);
    expect(result.nodes.api.type).toBe("lib");
  });

  it("maps a non-standard layer to lib type", () => {
    const raw = twoProjectGraph();
    raw.data["1"].layer = "tool";
    const result = transformMoonGraph(raw);
    expect(result.nodes.api.type).toBe("lib");
  });

  it("uses null-prototype objects for nodes and dependencies", () => {
    const result = transformMoonGraph(twoProjectGraph());
    expect(Object.getPrototypeOf(result.nodes)).toBe(null);
    expect(Object.getPrototypeOf(result.dependencies)).toBe(null);
  });
});

describe("transformMoonGraph — tag derivation", () => {
  it("merges config.tags, layer, and stack into sorted tags", () => {
    const result = transformMoonGraph(twoProjectGraph());
    // web has tags: ["type-app", "lang-ts"] + layer:application + stack:frontend
    expect(result.nodes.web.data.tags).toEqual([
      "lang-ts",
      "layer:application",
      "stack:frontend",
      "type-app",
    ]);
  });

  it("deduplicates tags", () => {
    const raw = twoProjectGraph();
    // Add a tag that would duplicate a derived one.
    raw.data["0"].config.tags = ["type-app", "lang-ts", "layer:application"];
    const result = transformMoonGraph(raw);
    const webTags = result.nodes.web.data.tags;
    // "layer:application" appears only once.
    expect(webTags.filter((t) => t === "layer:application")).toHaveLength(1);
  });

  it("omits layer tag when layer is null", () => {
    const raw = twoProjectGraph();
    raw.data["0"].layer = null;
    const result = transformMoonGraph(raw);
    expect(result.nodes.web.data.tags.some((t) => t.startsWith("layer:"))).toBe(false);
  });

  it("omits stack tag when stack is null", () => {
    const raw = twoProjectGraph();
    raw.data["0"].stack = null;
    const result = transformMoonGraph(raw);
    expect(result.nodes.web.data.tags.some((t) => t.startsWith("stack:"))).toBe(false);
  });

  it("handles absent config.tags", () => {
    const raw = twoProjectGraph();
    delete raw.data["0"].config.tags;
    const result = transformMoonGraph(raw);
    // Only derived tags remain.
    expect(result.nodes.web.data.tags).toEqual(["layer:application", "stack:frontend"]);
  });
});

describe("transformMoonGraph — edge type from scope", () => {
  it("maps production to static", () => {
    const raw = twoProjectGraph();
    raw.graph.edges = [[0, 1, "production"]];
    const result = transformMoonGraph(raw);
    expect(result.dependencies.web[0].type).toBe("static");
  });

  it("maps development to dynamic", () => {
    const raw = twoProjectGraph();
    raw.graph.edges = [[0, 1, "development"]];
    const result = transformMoonGraph(raw);
    expect(result.dependencies.web[0].type).toBe("dynamic");
  });

  it("maps build to static", () => {
    const raw = twoProjectGraph();
    raw.graph.edges = [[0, 1, "build"]];
    const result = transformMoonGraph(raw);
    expect(result.dependencies.web[0].type).toBe("static");
  });

  it("maps peer to static", () => {
    const raw = twoProjectGraph();
    raw.graph.edges = [[0, 1, "peer"]];
    const result = transformMoonGraph(raw);
    expect(result.dependencies.web[0].type).toBe("static");
  });

  it("skips root-scope edges", () => {
    const raw = twoProjectGraph();
    // Add a root project (index 2) with a root-scoped edge to api.
    raw.graph.nodes.push(2);
    raw.graph.edges.push([2, 1, "root"]);
    raw.data["2"] = {
      id: "root-marker",
      layer: "configuration",
      source: ".",
      dependencies: [{ id: "api", scope: "root", source: "explicit" }],
    };
    const result = transformMoonGraph(raw);
    // The root-scoped edge should not appear.
    expect(result.dependencies["root-marker"]).toBeUndefined();
  });

  it("maps an unknown edge scope to static, never silently dropping it", () => {
    // A scope this provider has not seen must not vanish an edge — that would
    // be a graph missing a dependency, silently.
    const raw = twoProjectGraph();
    raw.graph.edges = [[0, 1, "mystery-scope"]];
    const result = transformMoonGraph(raw);
    expect(result.dependencies.web[0].type).toBe("static");
  });

  it("skips an edge whose index names no node in the data map", () => {
    const raw = twoProjectGraph();
    raw.graph.edges = [
      [9, 1, "production"],
      [0, 9, "production"],
    ];
    raw.data["0"].dependencies = [];
    const result = transformMoonGraph(raw);
    expect(result.dependencies.web).toBeUndefined();
    expect(result.dependencies.api).toBeUndefined();
  });

  it("skips an edge whose two ends are the same project", () => {
    // A self-loop is not a dependency between projects.
    const raw = twoProjectGraph();
    raw.graph.edges = [[0, 0, "production"]];
    raw.data["0"].dependencies = [];
    const result = transformMoonGraph(raw);
    expect(result.dependencies.web).toBeUndefined();
  });

  it("does not read a graph that carries no edges array", () => {
    const raw = twoProjectGraph();
    delete raw.graph.edges;
    raw.data["0"].dependencies = [];
    const result = transformMoonGraph(raw);
    expect(result.dependencies.web).toBeUndefined();
  });

  it("skips a project node that carries no id or no source", () => {
    const raw = twoProjectGraph();
    raw.data["2"] = { layer: "library", source: "libs/ghost" };
    raw.data["3"] = { id: "ghost", layer: "library" };
    const result = transformMoonGraph(raw);
    expect(result.nodes.ghost).toBeUndefined();
    expect(Object.keys(result.nodes).sort()).toEqual(["api", "web"]);
  });

  it("reads a node whose dependencies are not an array as having none", () => {
    const raw = twoProjectGraph();
    /** @type {any} */ (raw.data["1"]).dependencies = "oops";
    const result = transformMoonGraph(raw);
    expect(result.nodes.api.data.implicitDependencies).toEqual([]);
  });

  it("reads a node with no dependencies key as having none", () => {
    const raw = twoProjectGraph();
    delete raw.data["1"].dependencies;
    const result = transformMoonGraph(raw);
    expect(result.nodes.api.data.implicitDependencies).toEqual([]);
    expect(result.dependencies.api).toBeUndefined();
  });

  it("skips a dependency record that names no project", () => {
    const raw = twoProjectGraph();
    raw.graph.edges = [];
    /** @type {any} */ (raw.data["0"]).dependencies = [{ scope: "production", source: "explicit" }];
    const result = transformMoonGraph(raw);
    expect(result.dependencies.web).toBeUndefined();
  });

  it("keeps a task target that has no project prefix as itself", () => {
    const raw = twoProjectGraph();
    raw.data["1"].taskTargets = ["build"];
    const result = transformMoonGraph(raw);
    expect(result.nodes.api.data.targets).toEqual({ build: { executor: "moon:declared" } });
  });
});

describe("transformMoonGraph — implicit dependencies", () => {
  it("extracts implicit dependencies from Moon's dependency metadata", () => {
    const raw = twoProjectGraph();
    // Make the web→api dependency implicit instead of explicit.
    raw.data["0"].dependencies = [{ id: "api", scope: "production", source: "implicit" }];
    const result = transformMoonGraph(raw);
    expect(result.nodes.web.data.implicitDependencies).toEqual(["api"]);
  });

  it("excludes explicit dependencies from implicitDependencies", () => {
    const raw = twoProjectGraph();
    raw.data["0"].dependencies = [{ id: "api", scope: "production", source: "explicit" }];
    const result = transformMoonGraph(raw);
    expect(result.nodes.web.data.implicitDependencies).toEqual([]);
  });

  // P0-06: `implicitDependencies` bookkeeping (above) is not the only consumer
  // of `source` — the EDGE this same dependency produces must also carry
  // `type: "implicit"`, because that is the one criterion `check`'s
  // `declaredEdgeViolationsForCheck` (`../commands/edge-constraints.mjs`) and
  // `drift.mjs`'s/`discover.mjs`'s own architecture-edge exclusion already key
  // off. Before this fix, every Moon-sourced edge fell through to a
  // `scope`-derived `"static"`/`"dynamic"`, so an implicit dependency was
  // structurally indistinguishable from a real, code-derived one to every one
  // of those callers — the same edge Nx's/the native provider's own
  // `implicitDependencies` already types `"implicit"` for.
  it("types the edge itself implicit, not the scope-derived type, when source is implicit", () => {
    const raw = twoProjectGraph();
    // graph.edges carries no source info at all — only this project node's
    // own dependencies[] entry does, so this is the one path that can type
    // the edge "implicit" in the first place.
    raw.graph.edges = [];
    raw.data["0"].dependencies = [{ id: "api", scope: "production", source: "implicit" }];
    const result = transformMoonGraph(raw);
    expect(result.dependencies.web).toEqual([{ source: "web", target: "api", type: "implicit" }]);
  });

  it("still types the edge by scope when source is explicit", () => {
    const raw = twoProjectGraph();
    raw.graph.edges = [];
    raw.data["0"].dependencies = [{ id: "api", scope: "development", source: "explicit" }];
    const result = transformMoonGraph(raw);
    expect(result.dependencies.web).toEqual([{ source: "web", target: "api", type: "dynamic" }]);
  });

  it("still types the edge by scope when source is absent, the raw.graph.edges shape", () => {
    // raw.graph.edges' own [source, target, scope] tuples carry no `source`
    // field at all — the call site for that loop always passes `undefined`,
    // and this pins that the function still behaves exactly as before there.
    const raw = twoProjectGraph();
    raw.graph.edges = [[0, 1, "production"]];
    raw.data["0"].dependencies = [];
    const result = transformMoonGraph(raw);
    expect(result.dependencies.web).toEqual([{ source: "web", target: "api", type: "static" }]);
  });

  // Silent-direction regression: unlike the "types the edge itself implicit"
  // case above (which clears `raw.graph.edges` and so only ever exercises the
  // second loop), Moon's real output carries the SAME dependency in BOTH
  // places at once — the edge tuple in `raw.graph.edges` (typed only from
  // `scope`) and the owning node's own `dependencies[]` entry (which carries
  // `source: "implicit"`). Before the fix, the two loops disagreed on `type`
  // for that one pair and the old `[source, target, type]` dedup key let both
  // survive: a correct `implicit` edge, plus a phantom `static` duplicate
  // that `../commands/drift.mjs` and `../commands/discover.mjs` — which
  // exclude only `edge.type === "implicit"` — would count as a real,
  // code-derived edge. A workspace with exactly one implicit dependency must
  // report exactly one edge for it, typed `implicit`; reporting two (one of
  // them mistyped as code-derived) is the silent false negative this test
  // pins closed.
  it("collapses a dependency present in BOTH raw.graph.edges and the node's own dependencies[] into one implicit edge, never a phantom static duplicate", () => {
    const raw = twoProjectGraph();
    // raw.graph.edges already carries the web→api tuple with scope
    // "production" (from twoProjectGraph's default) — left as-is, so it is
    // present exactly the way Moon emits it: with no `source` field.
    raw.data["0"].dependencies = [{ id: "api", scope: "production", source: "implicit" }];
    const result = transformMoonGraph(raw);
    expect(result.dependencies.web).toEqual([{ source: "web", target: "api", type: "implicit" }]);
    // Exactly one edge for the pair — no separate `static` entry survives.
    expect(result.dependencies.web).toHaveLength(1);
  });

  it("still skips a root-scoped edge even when its source is implicit", () => {
    // scope === "root" is checked first: a root-to-project edge is not a
    // project-to-project boundary either way, implicit or not.
    const raw = twoProjectGraph();
    raw.graph.nodes.push(2);
    raw.data["2"] = {
      id: "root-marker",
      layer: "configuration",
      source: ".",
      dependencies: [{ id: "api", scope: "root", source: "implicit" }],
    };
    const result = transformMoonGraph(raw);
    expect(result.dependencies["root-marker"]).toBeUndefined();
  });
});

describe("transformMoonGraph — task targets", () => {
  it("synthesizes targets from taskTargets with moon:declared executor", () => {
    const result = transformMoonGraph(twoProjectGraph());
    expect(result.nodes.web.data.targets).toEqual({
      build: { executor: "moon:declared" },
      test: { executor: "moon:declared" },
    });
  });

  it("omits targets when taskTargets is empty", () => {
    const raw = twoProjectGraph();
    raw.data["1"].taskTargets = [];
    const result = transformMoonGraph(raw);
    expect(result.nodes.api.data.targets).toBeUndefined();
  });

  it("omits targets when taskTargets is absent", () => {
    const raw = twoProjectGraph();
    delete raw.data["1"].taskTargets;
    const result = transformMoonGraph(raw);
    expect(result.nodes.api.data.targets).toBeUndefined();
  });
});

describe("transformMoonGraph — workspaceLayout inference", () => {
  it("infers both appsDir and libsDir from project paths", () => {
    const result = transformMoonGraph(twoProjectGraph());
    expect(result.workspaceLayout).toEqual({ appsDir: "apps", libsDir: "libs" });
  });

  it("returns undefined when no consistent prefixes exist", () => {
    const raw = twoProjectGraph();
    // Move web to frontend/ and api to packages/ — different top-level dirs.
    raw.data["0"].source = "frontend/web";
    // Add another app in a different directory to break the appsDir prefix.
    raw.graph.nodes.push(2);
    raw.data["2"] = {
      id: "mobile",
      layer: "application",
      source: "mobile/app",
      dependencies: [],
    };
    // Add a second library in a different directory to break the libsDir prefix.
    raw.graph.nodes.push(3);
    raw.data["3"] = {
      id: "shared",
      layer: "library",
      source: "packages/shared",
      dependencies: [],
    };
    const result = transformMoonGraph(raw);
    expect(result.workspaceLayout).toBeUndefined();
  });

  it("returns undefined when apps share a prefix but libs do not (partial layout)", () => {
    const raw = twoProjectGraph();
    // api under packages/ (library) + add a second library in libs/ to break the prefix.
    raw.data["1"].source = "packages/api";
    raw.graph.nodes.push(2);
    raw.data["2"] = {
      id: "shared",
      layer: "library",
      source: "libs/shared",
      dependencies: [],
    };
    const result = transformMoonGraph(raw);
    // A partial layout (appsDir only, no libsDir) would silently disable the
    // absolute-import rule for the libs axis — inferWorkspaceLayout returns
    // null instead, so `graph.workspaceLayout ?? DEFAULT_WORKSPACE_LAYOUT`
    // applies the complete default.
    expect(result.workspaceLayout).toBeUndefined();
  });

  it("returns undefined when libs share a prefix but apps do not (partial layout)", () => {
    const raw = twoProjectGraph();
    // Move web out of apps/ and add another app in a different directory.
    raw.data["0"].source = "src/web";
    raw.graph.nodes.push(2);
    raw.data["2"] = {
      id: "mobile",
      layer: "application",
      source: "mobile/app",
      dependencies: [],
    };
    const result = transformMoonGraph(raw);
    // A partial layout (libsDir only, no appsDir) would silently disable the
    // absolute-import rule for the apps axis — inferWorkspaceLayout returns
    // null instead, so `graph.workspaceLayout ?? DEFAULT_WORKSPACE_LAYOUT`
    // applies the complete default.
    expect(result.workspaceLayout).toBeUndefined();
  });

  it("infers layout from deeply nested projects", () => {
    const raw = twoProjectGraph();
    raw.data["0"].source = "apps/frontend/web";
    raw.data["1"].source = "libs/backend/api";
    const result = transformMoonGraph(raw);
    expect(result.workspaceLayout).toEqual({ appsDir: "apps", libsDir: "libs" });
  });

  it("returns undefined when there are no projects", () => {
    const result = transformMoonGraph({ graph: { nodes: [], edges: [] }, data: {} });
    // No projects → no layout → property absent (undefined), which lets
    // `graph.workspaceLayout ?? DEFAULT_WORKSPACE_LAYOUT` apply the default.
    expect(result.workspaceLayout).toBeUndefined();
  });
});

// ── readProjectGraph ─────────────────────────────────────────────────────────

describe("readProjectGraph — injectable IO", () => {
  it("calls run with moon binary and project-graph args", () => {
    const calls = [];
    const run = (file, args, cwd, _env) => {
      calls.push({ file, args, cwd });
      return JSON.stringify(twoProjectGraph());
    };
    const resolveMoon = () => "/usr/bin/moon";
    readProjectGraph("/workspace", { run, resolveMoon });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      file: "/usr/bin/moon",
      args: ["project-graph", "--json"],
      cwd: "/workspace",
    });
  });

  it("uses the default moon binary name when no resolver is injected", () => {
    const calls = [];
    const run = (file, _args, _cwd, _env) => {
      calls.push(file);
      return JSON.stringify(twoProjectGraph());
    };
    readProjectGraph("/workspace", { run });
    expect(calls).toEqual(["moon"]);
  });

  it("builds a PATH from nothing when the environment carries none at all", () => {
    /** @type {Record<string, string|undefined>|undefined} */
    let capturedEnv;
    const run = (_file, _args, _cwd, env) => {
      capturedEnv = env;
      return JSON.stringify(twoProjectGraph());
    };
    readProjectGraph("/workspace", { run, resolveMoon: () => "moon", env: {} });
    // The bin dir leads, delimiter-terminated; the empty remainder is joined
    // the same way a real PATH would be.
    const path = capturedEnv?.PATH ?? "";
    expect(path).toBe(`/workspace/node_modules/.bin${require("node:path").delimiter}`);
  });

  it("passes argument array, never a shell string", () => {
    // The child-process rule (AGENTS.md) enforced by Semgrep: every value
    // from the package tree is attacker-supplied, so an argument array
    // prevents command injection.
    let captured;
    const run = (file, args) => {
      captured = args;
      return JSON.stringify(twoProjectGraph());
    };
    readProjectGraph("/workspace", { run, resolveMoon: () => "moon" });
    expect(Array.isArray(captured)).toBe(true);
  });

  it("uses resolveMoon to find the binary", () => {
    let resolved = false;
    const resolveMoon = () => {
      resolved = true;
      return "/found/moon";
    };
    const run = () => JSON.stringify(twoProjectGraph());
    readProjectGraph("/workspace", { run, resolveMoon });
    expect(resolved).toBe(true);
  });

  it("returns the transformed graph", () => {
    const run = () => JSON.stringify(twoProjectGraph());
    const result = readProjectGraph("/workspace", { run, resolveMoon: () => "moon" });
    expect(Object.keys(result.nodes)).toContain("web");
    expect(Object.keys(result.nodes)).toContain("api");
  });

  it("throws when the output cannot be parsed as JSON", () => {
    const run = () => "not json at all";
    expect(() => readProjectGraph("/workspace", { run, resolveMoon: () => "moon" })).toThrow();
  });

  it("adds workspace node_modules/.bin to PATH in the env", () => {
    /** @type {Record<string, string|undefined>|undefined} */
    let capturedEnv;
    const run = (_file, _args, _cwd, env) => {
      capturedEnv = env;
      return JSON.stringify(twoProjectGraph());
    };
    readProjectGraph("/workspace", { run, resolveMoon: () => "moon" });
    expect(capturedEnv?.PATH).toContain("/workspace/node_modules/.bin");
  });

  it("does not duplicate node_modules/.bin in PATH when already present", () => {
    /** @type {Record<string, string|undefined>|undefined} */
    let capturedEnv;
    const run = (_file, _args, _cwd, env) => {
      capturedEnv = env;
      return JSON.stringify(twoProjectGraph());
    };
    const env = { PATH: "/workspace/node_modules/.bin:/usr/bin" };
    readProjectGraph("/workspace", { run, resolveMoon: () => "moon", env });
    // Should not double the bin dir.
    const path = capturedEnv?.PATH ?? "";
    const occurrences = path.split("/workspace/node_modules/.bin").length - 1;
    expect(occurrences).toBe(1);
  });

  it("uses path.delimiter to join PATH entries (not hardcoded ':')", () => {
    /** @type {Record<string, string|undefined>|undefined} */
    let capturedEnv;
    const run = (_file, _args, _cwd, env) => {
      capturedEnv = env;
      return JSON.stringify(twoProjectGraph());
    };
    readProjectGraph("/workspace", { run, resolveMoon: () => "moon" });
    // The PATH must use the platform delimiter — on Windows that is ';',
    // on Unix it is ':'. A hardcoded ':' would break Windows.
    const path = capturedEnv?.PATH ?? "";
    const binDir = "/workspace/node_modules/.bin";
    if (path.includes(binDir)) {
      // After the bin dir, there should be a path.delimiter character.
      const afterBin = path.slice(binDir.length);
      // The first character after the bin dir must be the platform delimiter.
      expect(afterBin[0]).toBe(require("node:path").delimiter);
    }
  });
});

// Failure-naming parity with `./nx.test.mjs` (#226). There, the same three
// classes are pinned for the Nx provider — the named not-installed error, the
// non-MODULE_NOT_FOUND resolver passthrough, and the layout-read propagation —
// because a provider that cannot answer must throw a named error, never
// resolve to an empty graph. Here the binary is found on PATH rather than
// through `require.resolve`, so "missing binary" surfaces at spawn time and
// every class reduces to one contract: the failure propagates out of
// `readProjectGraph` untouched (`../process.mjs`'s `runProcess` does the
// naming), and nothing on the path catches it into `{nodes: {}, dependencies:
// {}}`. Downstream, `../../cli.mjs`'s exit classification turns that throw
// into exit 3, and the language server turns it into a named index gap
// (`../lsp/workspace-index.test.mjs`) — both pinned against the silent
// direction this describe exists to keep impossible.
describe("readProjectGraph — failure paths propagate named, never as an empty graph", () => {
  it("propagates a spawn failure untouched", () => {
    const run = () => {
      throw new Error("spawn moon ENOENT");
    };
    expect(() => readProjectGraph("/workspace", { run, resolveMoon: () => "moon" })).toThrow(
      /spawn moon ENOENT/u,
    );
  });

  it("propagates a nonzero exit with the command and working directory named", () => {
    // The exact shape `../process.mjs`'s `runProcess` emits for a failing
    // child — pinned here so a future catch inside `readProjectGraph` cannot
    // quietly flatten it into an empty-but-valid-looking result.
    const run = () => {
      throw new Error("lattice: `moon project-graph --json` failed in /workspace: exit status 2");
    };
    expect(() => readProjectGraph("/workspace", { run, resolveMoon: () => "moon" })).toThrow(
      /`moon project-graph --json` failed in \/workspace: exit status 2/u,
    );
  });

  it("surfaces an unresolvable binary before anything is spawned", () => {
    // The missing-binary case: resolution fails before there is anything to
    // spawn, so a `run` that throws proves it was never reached — the same
    // shape `./nx.test.mjs` pins for its not-installed peer.
    const resolveMoon = () => {
      throw new Error("lattice: moon was not found on PATH");
    };
    let spawned = false;
    const run = () => {
      spawned = true;
      return JSON.stringify(twoProjectGraph());
    };
    expect(() => readProjectGraph("/workspace", { run, resolveMoon })).toThrow(
      /moon was not found on PATH/u,
    );
    expect(spawned).toBe(false);
  });
});
