/**
 * Unit tests for `./moon.mjs` — the Moon project-model provider.
 *
 * `moon project-graph --json` is never invoked; its output is injected via
 * the `run` seam, the same way `./nx.test.mjs` drives the Nx provider.
 */
import { describe, expect, it } from "vitest";

import { moonProvider, readProjectGraph, transformMoonGraph, MOON_DIR } from "./moon.mjs";

// ── constants ────────────────────────────────────────────────────────────────

describe("MOON_DIR", () => {
  it('is ".moon"', () => {
    expect(MOON_DIR).toBe(".moon");
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

  it("infers only appsDir when all apps share a prefix but libs do not", () => {
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
    expect(result.workspaceLayout).toEqual({ appsDir: "apps" });
  });

  it("infers only libsDir when all libs share a prefix but apps do not", () => {
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
    expect(result.workspaceLayout).toEqual({ libsDir: "libs" });
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
});
