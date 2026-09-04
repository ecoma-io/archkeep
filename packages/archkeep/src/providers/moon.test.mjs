/**
 * Unit tests for `./moon.mjs` — the Moon project-model provider.
 *
 * `moon project-graph --json` is never invoked; its output is injected via
 * the `run` seam, the same way `./nx.test.mjs` drives the Nx provider.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import { tsconfigPathsFacts } from "../analysis/typescript.mjs";
import { MOON_TSCONFIG_CHAIN, readMoonOptions } from "../options.mjs";
import { createWorkspace } from "../workspace.mjs";

import {
  mergeImportEdges,
  moonProvider,
  moonMarkerAt,
  readProjectGraph,
  transformMoonGraph,
  MOON_DIR,
  MOON_ALT_DIR,
  MOON_WORKSPACE_MARKER,
  MOON_ALT_WORKSPACE_MARKER,
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

describe("MOON_WORKSPACE_MARKER", () => {
  // The walk's Moon marker (`../workspace.mjs`'s `findWorkspaceRoot` reads it
  // through `../commands/context.mjs`'s `WORKSPACE_MARKERS`). A typo here
  // fails no provider test — `moonMarkerAt` below reads directory presence —
  // while every Moon workspace everywhere starts answering "no workspace
  // root": the silent direction, so the spelling is pinned here, where the
  // provider's own constants live.
  it("is the workspace.yml inside .moon, not the directory alone (#339)", () => {
    expect(MOON_WORKSPACE_MARKER).toBe(`${MOON_DIR}/workspace.yml`);
  });

  it("has a v2 spelling under .config/moon", () => {
    expect(MOON_ALT_WORKSPACE_MARKER).toBe(`${MOON_ALT_DIR}/workspace.yml`);
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

/**
 * A minimal Moon `project-graph --json` output with two projects and one edge.
 *
 * That edge is a Moon-DERIVED one — `source: "implicit"` with an empty
 * `config.dependsOn`, the shape a workspace running
 * `javascript.syncProjectWorkspaceDependencies` produces for every
 * `package.json` dependency. It is the base fixture because it is the ordinary
 * case: a code-backed edge, typed from its `scope`. The hand-declared shape
 * (`source: "explicit"`, which is what Archkeep types `"implicit"`) has its own
 * describe below, where the distinction is the thing under test.
 */
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
        dependencies: [{ id: "api", scope: "production", source: "implicit" }],
        inherited: { configs: {}, layers: {} },
        config: {
          schema: "",
          id: "web",
          language: "typescript",
          layer: "application",
          stack: "frontend",
          tags: ["type-app", "lang-ts"],
          // Empty, and consistent with the `source: "implicit"` above: Moon
          // derived this dependency, nobody wrote it.
          dependsOn: [],
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
  it("transforms a two-project Moon graph into Archkeep shape", () => {
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

  it("names every anomaly in one refusal, not one per run", () => {
    // `./native/discover.mjs`'s collect-and-throw posture: a payload
    // carrying several defects names them all in a single refusal, so the
    // consumer fixes the whole shape in one pass instead of one per run.
    const raw = twoProjectGraph();
    raw.graph.nodes.push(2);
    raw.data["2"] = { ...raw.data["1"], id: "web", source: "apps/web-2" };
    raw.data["0"].dependencies = [{ id: "ghost", scope: "production", source: "explicit" }];
    // One invocation, one throw: both patterns must come from the SAME
    // error, which is what pins collect-and-throw against one-per-run.
    let message = "";
    try {
      transformMoonGraph(raw);
    } catch (error) {
      message = String(/** @type {Error} */ (error).message);
    }
    expect(message).toMatch(/both declare project 'web'/u);
    expect(message).toMatch(/dependency on 'ghost'/u);
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
    // Renaming the project renames it in its dependents too — a `moon.yml`
    // `dependsOn` names the id. Left pointing at the old id, this fixture
    // carried exactly the dangling dependency #365's refusal exists to name
    // (and the pre-#365 silent drop used to hide).
    raw.data["0"].dependencies = [{ id: "e2e-tests", scope: "production", source: "implicit" }];
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

  it("refuses a payload that declares one project id twice, naming both sources", () => {
    // Red in the silent direction until #365: the second `nodes[id] = …`
    // overwrote the first, the first project vanished from the graph, and
    // nothing anywhere named either — a graph byte-identical to a workspace
    // without that project. Moon's own graph is keyed by id, so a duplicate
    // cannot come from well-formed output; `./native/discover.mjs` refuses
    // the same class for the native provider, and this is its Moon twin.
    const raw = twoProjectGraph();
    raw.graph.nodes.push(2);
    raw.data["2"] = { ...raw.data["1"], id: "web", source: "apps/web-2" };
    expect(() => transformMoonGraph(raw)).toThrow(
      /data entries 0 and 2 both declare project 'web'[\s\S]*'apps\/web'[\s\S]*'apps\/web-2'/u,
    );
  });
});

// #367 — `node.source` used to become `data.root` verbatim. Every consumer
// answers by comparing that root against workspace-relative tracked paths
// (`projectOwning`'s `path.startsWith(`${root}/`)`, byte for byte), so a
// spelling like `./apps/web` made the project own NOTHING — a hole
// byte-for-byte identical to a clean workspace, the forbidden direction. The
// two disciplines pinned below are the ones the other two providers already
// apply (`../workspace.mjs` normalises Nx's `.` to `""`;
// `./native/model.mjs` refuses bad spellings at config load): normalise the
// normalisable, refuse the rest loudly, and let #369's `projectOwning`
// rewrite assume canonical roots.
describe("transformMoonGraph — root spelling discipline (#367)", () => {
  it("normalises './apps/web' to 'apps/web', so the project OWNS its files", () => {
    const raw = twoProjectGraph();
    raw.data["0"].source = "./apps/web";
    const graph = transformMoonGraph(raw);
    expect(graph.nodes.web.data.root).toBe("apps/web");
    // The half that makes this a fix rather than a cosmetic rewrite: files
    // under apps/web/ are attributed to web. Before the fix the root stayed
    // './apps/web', no tracked path starts with that spelling, and
    // `createWorkspace` dropped every web file as unowned — silently.
    const { filesByProject, owned } = createWorkspace({
      root: "/ws",
      graph,
      files: ["apps/web/src/main.ts", "libs/api/src/index.ts", "README.md"],
    });
    expect(filesByProject.get("web")).toEqual(["apps/web/src/main.ts"]);
    expect(owned).toEqual([
      { file: "apps/web/src/main.ts", project: "web" },
      { file: "libs/api/src/index.ts", project: "api" },
    ]);
  });

  it('normalises the root project\'s "." and "./" spellings to ""', () => {
    for (const source of [".", "./", "././"]) {
      const raw = twoProjectGraph();
      raw.data["0"].source = source;
      expect(transformMoonGraph(raw).nodes.web.data.root).toBe("");
    }
  });

  it("normalises a trailing slash", () => {
    const raw = twoProjectGraph();
    raw.data["0"].source = "./apps/web/";
    expect(transformMoonGraph(raw).nodes.web.data.root).toBe("apps/web");
  });

  it("reads workspaceLayout from the canonical root, not Moon's spelling", () => {
    // Before the fix, './services/web' was skipped by the layout guard (its
    // raw top segment was '.'), the app axis fell back to the DEFAULT 'apps',
    // and a services/ workspace was silently judged against the wrong layout.
    // Canonicalising first makes the inferred layout the real one.
    const raw = twoProjectGraph();
    raw.data["0"].source = "./services/web";
    raw.data["1"].source = "packages/api";
    expect(transformMoonGraph(raw).workspaceLayout).toEqual({
      appsDir: "services",
      libsDir: "packages",
    });
  });

  it("refuses a backslash spelling, naming the project and the source", () => {
    const raw = twoProjectGraph();
    raw.data["0"].source = "apps\\web";
    expect(() => transformMoonGraph(raw)).toThrow(/web: 'apps\\web' must use forward slashes/u);
  });

  it("refuses an absolute source", () => {
    const raw = twoProjectGraph();
    raw.data["0"].source = "/apps/web";
    expect(() => transformMoonGraph(raw)).toThrow(/web: '\/apps\/web' must be workspace-relative/u);
  });

  it("refuses a '..' segment", () => {
    const raw = twoProjectGraph();
    raw.data["0"].source = "../apps/web";
    expect(() => transformMoonGraph(raw)).toThrow(
      /web: '\.\.\/apps\/web' must be a canonical path — no '\.' or '\.\.' segment/u,
    );
  });

  it("refuses an empty '//' segment", () => {
    const raw = twoProjectGraph();
    raw.data["0"].source = "apps//web";
    expect(() => transformMoonGraph(raw)).toThrow(
      /web: 'apps\/\/web' must be a canonical path — no empty '\/\/' segment/u,
    );
  });

  it("refuses a non-string source, naming what arrived", () => {
    const raw = twoProjectGraph();
    /** @type {any} */ (raw.data["0"]).source = 42;
    expect(() => transformMoonGraph(raw)).toThrow(/web: must be a string, got number/u);
  });

  it("names every offending project in one refusal", () => {
    const raw = twoProjectGraph();
    raw.data["0"].source = "/apps/web";
    raw.data["1"].source = "libs\\api";
    /** @type {unknown} */ let thrown;
    try {
      transformMoonGraph(raw);
    } catch (error) {
      thrown = error;
    }
    const message = String(/** @type {Error} */ (thrown).message);
    expect(message).toContain("web: '/apps/web'");
    expect(message).toContain("api: 'libs\\api'");
    // The reason a consumer is being stopped, not just the spellings.
    expect(message).toContain("owns nothing");
  });

  it("still refuses when the offending project is the only one", () => {
    // The minimum silent-hole case: one project, one bad root — refusing must
    // not depend on a well-formed project being present too.
    const raw = twoProjectGraph();
    delete raw.data["1"];
    raw.graph.nodes = [0];
    raw.graph.edges = [];
    raw.data["0"].source = "././../web";
    // The refusal names Moon's ORIGINAL spelling, not the half-stripped one —
    // what a consumer greps their output for is what Moon actually emitted.
    expect(() => transformMoonGraph(raw)).toThrow(/web: '\.\/\.\/\.\.\/web'/u);
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

  it("maps development to static — a scope never manufactures a source-text fact (#280)", () => {
    // The red direction of #280's false positive: typed "dynamic", the
    // dev-only edge made `noImportsOfLazyLoadedLibraries` fire at the
    // declaring project's own test file, and moving the specifier from
    // devDependencies to dependencies silenced it — isolating cause to this
    // mapping. A scope is a fact about a manifest row; "dynamic" is a fact
    // about source text.
    const raw = twoProjectGraph();
    raw.graph.edges = [[0, 1, "development"]];
    const result = transformMoonGraph(raw);
    expect(result.dependencies.web[0].type).toBe("static");
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

  it("refuses an edge whose index names no node in the data map, naming the edge", () => {
    // Red in the silent direction until #365: both edges below used to
    // vanish — a bare `continue` on the unresolvable index — with nothing
    // anywhere naming them, so the graph claimed a completeness it never had.
    // Both appear in the ONE refusal, not one per run.
    const raw = twoProjectGraph();
    raw.graph.edges = [
      [9, 1, "production"],
      [0, 9, "production"],
    ];
    raw.data["0"].dependencies = [];
    expect(() => transformMoonGraph(raw)).toThrow(
      /\[9, 1, production\][\s\S]*\[0, 9, production\]/u,
    );
  });

  it("still skips a root-scope edge whose endpoint names nothing — it judges nothing", () => {
    // The scope check runs before endpoint resolution: a root-scoped edge is
    // Moon-internal bookkeeping this provider never judges (see
    // `edgeTypeFromScope`), so what it names at either end cannot be a
    // dropped boundary. Pinning the order keeps a future reorder from turning
    // Moon's root bookkeeping into refusals.
    const raw = twoProjectGraph();
    raw.graph.edges = [[9, 1, "root"]];
    raw.data["0"].dependencies = [];
    const result = transformMoonGraph(raw);
    expect(result.dependencies.web).toBeUndefined();
  });

  it("refuses an edge whose two ends are the same project, naming the self-edge", () => {
    // A self-loop is not a dependency between projects and is now refused loudly.
    const raw = twoProjectGraph();
    raw.graph.edges = [[0, 0, "production"]];
    raw.data["0"].dependencies = [];
    expect(() => transformMoonGraph(raw)).toThrow(/self-edge \[web, web\]/u);
  });

  it("does not read a graph that carries no edges array", () => {
    const raw = twoProjectGraph();
    delete raw.graph.edges;
    raw.data["0"].dependencies = [];
    const result = transformMoonGraph(raw);
    expect(result.dependencies.web).toBeUndefined();
  });

  it("refuses a project node that carries no id or no source path, naming the entry", () => {
    // Flips the pinned skip of #365's second class. Every `Project` Moon
    // serializes carries a non-optional `id` and `source`, so an entry
    // without either did not come from a well-formed `moon project-graph` —
    // and skipping it, the old pinned behaviour, judged the graph over one
    // project fewer: the silent direction. The one falsy-looking spelling
    // that IS well-formed — a root-level project's `source: ""` — has its
    // own acceptance test below.
    const raw = twoProjectGraph();
    raw.data["2"] = { layer: "library", source: "libs/ghost" };
    raw.data["3"] = { id: "ghost", layer: "library" };
    expect(() => transformMoonGraph(raw)).toThrow(
      /data entry 2 carries no id[\s\S]*data entry 3 \('ghost'\) carries no source/u,
    );
  });

  it("keys a root-level project whose source is the empty string, the other root spelling", () => {
    // Moon spells a root-level project's source `"."` on some versions and
    // `""` on others — its own `is_root_level_source` accepts both — so `""`
    // is a project root, not a missing one. Until #365 the falsy spelling
    // hit the same skip as an entry with no source at all, vanishing the
    // root project from the graph on the versions that spell it that way.
    // Only the node's PRESENCE is pinned here; how its root is spelled in
    // the output is root-normalization's subject, not this one's.
    const raw = twoProjectGraph();
    raw.graph.nodes.push(2);
    raw.data["2"] = { id: "workspace-root", layer: "configuration", source: "", dependencies: [] };
    const result = transformMoonGraph(raw);
    expect(Object.keys(result.nodes)).toContain("workspace-root");
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

  it("refuses a dependency record that names no project, naming the project and the missing id", () => {
    // A dependency record with no id is anomalous and is now refused loudly.
    const raw = twoProjectGraph();
    raw.graph.edges = [];
    /** @type {any} */ (raw.data["0"]).dependencies = [{ scope: "production", source: "explicit" }];
    expect(() => transformMoonGraph(raw)).toThrow(
      /project 'web' has a dependency record with no id/u,
    );
  });

  it("refuses a declared dependency naming a project the graph does not contain, naming both", () => {
    // Measured on @moonrepo/cli 2.5.3: a moon.yml `dependsOn: [ghost]`
    // naming no real project exits 0, keeps the record in the node's own
    // `dependencies[]` while `graph.edges` drops it — the exact payload
    // below. This provider used to drop it too (`!nodes[target]`), vanishing
    // a hand-declared edge: the #262 defect shape, reached through a typo'd
    // id (#365).
    const raw = twoProjectGraph();
    raw.graph.edges = [];
    raw.data["0"].dependencies = [{ id: "ghost", scope: "production", source: "explicit" }];
    expect(() => transformMoonGraph(raw)).toThrow(
      /project 'web' declares a dependency on 'ghost'/u,
    );
  });

  it("still skips a root-scoped dependency naming an absent project — it judges nothing", () => {
    // The mirror of the root-scope edge test above, on the second loop:
    // `edgeTypeFromScope` refuses "root" before the target is ever looked
    // up, so Moon's root bookkeeping can never turn into a refusal.
    const raw = twoProjectGraph();
    raw.graph.edges = [];
    raw.data["0"].dependencies = [{ id: "ghost", scope: "root", source: "explicit" }];
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

// Moon's `source` vocabulary is the INVERSE of Archkeep's `type: "implicit"`,
// and this describe is where that inversion is pinned. Verified against Moon's
// own shipped schema (`.moon/cache/schemas/project.json`, generated by
// @moonrepo/cli 2.4.6): `DependencySource` — "The source where the dependency
// comes from. Either explicitly defined in configuration, or implicitly
// derived from source files." And measured, by running `moon project-graph
// --json` over a two-project workspace whose `moon.yml` carried
// `dependsOn: ['core']` and whose `package.json` carried nothing: Moon
// answered `{"id": "core", "scope": "production", "source": "explicit"}`.
//
// Archkeep's `"implicit"` means the opposite fact — Nx's `implicitDependencies`
// and `archkeep.json`'s row of the same name: DECLARED by a human, with no
// import behind it. That is the entire criterion
// `../rules/edge-constraints.mjs`'s `declaredEdgeViolationsForCheck` selects
// on (`if (edge.type !== "implicit") continue`), and the one
// `../commands/drift.mjs`/`../commands/discover.mjs` exclude on.
//
// Matching the two words by spelling made `check` judge exactly the set it was
// written not to judge, and skip the only set it can usefully judge (#262). So
// every test below asserts the FACT the edge carries, not the word Moon used
// for it.
describe("transformMoonGraph — Moon `explicit` is Archkeep `implicit`", () => {
  it("puts a hand-declared (Moon `explicit`) dependency in implicitDependencies", () => {
    // Nx's `implicitDependencies` is the hand-declared list. Moon spells
    // hand-declared `"explicit"`.
    const raw = twoProjectGraph();
    raw.data["0"].dependencies = [{ id: "api", scope: "production", source: "explicit" }];
    const result = transformMoonGraph(raw);
    expect(result.nodes.web.data.implicitDependencies).toEqual(["api"]);
  });

  it("keeps a Moon-derived (`implicit`) dependency OUT of implicitDependencies", () => {
    // Moon's `"implicit"` means it read the dependency out of source files —
    // a `package.json` entry, say. There is real code behind it, so it is not
    // an `implicitDependencies` row in Archkeep's sense at all.
    const raw = twoProjectGraph();
    raw.data["0"].dependencies = [{ id: "api", scope: "production", source: "implicit" }];
    const result = transformMoonGraph(raw);
    expect(result.nodes.web.data.implicitDependencies).toEqual([]);
  });

  // The `implicitDependencies` bookkeeping above is not the only consumer of
  // `source` — the EDGE the same dependency produces carries the fact too, and
  // the edge is the half `check` reads.
  it("types a hand-declared (Moon `explicit`) edge `implicit`, the type check judges as a declaration", () => {
    const raw = twoProjectGraph();
    // graph.edges carries no `source` at all — only the project node's own
    // dependencies[] entry does, so this is the one path that can type an
    // edge `"implicit"` in the first place.
    raw.graph.edges = [];
    raw.data["0"].dependencies = [{ id: "api", scope: "production", source: "explicit" }];
    const result = transformMoonGraph(raw);
    expect(result.dependencies.web).toEqual([{ source: "web", target: "api", type: "implicit" }]);
  });

  it("types a Moon-derived (`implicit`) edge from its scope, NEVER `implicit`", () => {
    // The silent half of #262 read from the other side. A manifest-derived
    // edge has an import site behind it, so `evaluate()` reaches it; typing it
    // `"implicit"` hands it to `declaredEdgeViolationsForCheck` as though it
    // were a bare declaration, and in a workspace running
    // `syncProjectWorkspaceDependencies` that is almost every edge there is.
    for (const [scope, type] of [
      ["production", "static"],
      ["development", "static"],
      ["build", "static"],
      ["peer", "static"],
      ["mystery-scope", "static"],
    ]) {
      const raw = twoProjectGraph();
      raw.graph.edges = [];
      raw.data["0"].dependencies = [{ id: "api", scope, source: "implicit" }];
      const result = transformMoonGraph(raw);
      expect(result.dependencies.web).toEqual([{ source: "web", target: "api", type }]);
    }
  });

  it("still types the edge by scope when source is absent, the raw.graph.edges shape", () => {
    // raw.graph.edges' own [source, target, scope] tuples carry no `source`
    // field at all — the call site for that loop always passes `undefined`,
    // which is not `"explicit"` and so always falls through to `scope`.
    const raw = twoProjectGraph();
    raw.graph.edges = [[0, 1, "production"]];
    raw.data["0"].dependencies = [];
    const result = transformMoonGraph(raw);
    expect(result.dependencies.web).toEqual([{ source: "web", target: "api", type: "static" }]);
  });

  // Silent-direction regression: unlike the cases above (which clear
  // `raw.graph.edges` and so only ever exercise the second loop), Moon's real
  // output carries the SAME dependency in BOTH places at once — the edge tuple
  // in `raw.graph.edges` (typed only from `scope`) and the owning node's own
  // `dependencies[]` entry (the only one carrying `source`). The two loops
  // disagree on `type` for that one pair, and the `[source, target, type]`
  // dedup key this file used to carry let both survive: a correct declared
  // edge, plus a phantom `static` duplicate that `../commands/drift.mjs` and
  // `../commands/discover.mjs` — which exclude only `edge.type ===
  // "implicit"` — would count as a real, code-derived edge. One hand-declared
  // dependency must report exactly one edge, typed `implicit`.
  it("collapses a hand-declared dependency present in BOTH loops into one implicit edge, never a phantom static duplicate", () => {
    const raw = twoProjectGraph();
    // raw.graph.edges already carries the web→api tuple with scope
    // "production" (from twoProjectGraph's default) — left as-is, so it is
    // present exactly the way Moon emits it: with no `source` field.
    raw.data["0"].dependencies = [{ id: "api", scope: "production", source: "explicit" }];
    const result = transformMoonGraph(raw);
    expect(result.dependencies.web).toEqual([{ source: "web", target: "api", type: "implicit" }]);
    // Exactly one edge for the pair — no separate `static` entry survives.
    expect(result.dependencies.web).toHaveLength(1);
  });

  it("still skips a root-scoped edge even when it is hand-declared", () => {
    // scope === "root" is checked BEFORE `source`: a root-to-project edge is
    // not a project-to-project boundary either way, declared or not.
    const raw = twoProjectGraph();
    raw.graph.nodes.push(2);
    raw.data["2"] = {
      id: "root-marker",
      layer: "configuration",
      source: ".",
      dependencies: [{ id: "api", scope: "root", source: "explicit" }],
    };
    const result = transformMoonGraph(raw);
    expect(result.dependencies["root-marker"]).toBeUndefined();
  });
});

// The other half of #280, and the reason mapping `development` to `static`
// loses nothing: genuine lazy loading arrives through ANALYSIS, not through
// the manifest. `mergeImportEdges` folds real `import()` sites onto the
// declared graph keyed `[source, target, type]`, so a dynamic import between
// two projects already joined by a development-scoped edge survives as its
// OWN record — and `noImportsOfLazyLoadedLibraries` still sees the
// source-text fact it was written for, without the scope manufacturing it.
describe("mergeImportEdges — a real dynamic import survives alongside a development-scoped declared edge", () => {
  /**
   * An `import()` site in web resolving into api, in the analysis contract's
   * shape (`../analysis/analyze.mjs`'s `ImportSite`).
   *
   * @returns {import("../analysis/analyze.mjs").ImportSite}
   */
  const dynamicImportOfApi = () => ({
    sourceFile: "apps/web/lazy.ts",
    line: 3,
    column: 1,
    specifier: "@api/client",
    spelling: { path: false, relative: false, namesOnly: false },
    kind: "dynamic",
    resolved: { target: "api", file: null, external: false, packageName: null },
  });
  const projectOf = (file) =>
    file.startsWith("apps/web/") ? "web" : file.startsWith("libs/api/") ? "api" : undefined;

  it("keeps both records: the declared static edge and the analysis-derived dynamic one", () => {
    // The declared edge is typed from the DEVELOPMENT scope — "static" since
    // #280 — by the ordinary transform.
    const raw = twoProjectGraph();
    raw.graph.edges = [[0, 1, "development"]];
    const graph = transformMoonGraph(raw);
    expect(graph.dependencies.web).toEqual([{ source: "web", target: "api", type: "static" }]);

    mergeImportEdges(graph, { importSites: [dynamicImportOfApi()], projectOf });

    // Two records for one pair that differ in kind: the manifest's static
    // fact and the analysis's dynamic one. Folding them into one would be
    // the silent direction — the lazy-loading finding would vanish.
    expect(graph.dependencies.web).toEqual([
      { source: "web", target: "api", type: "static" },
      { source: "web", target: "api", type: "dynamic" },
    ]);
  });

  it("adds nothing when the analysis agrees in kind with the declared static edge", () => {
    // The dedupe half of the same key: an ordinary static import of a dev
    // dependency is already fully represented by the declared edge.
    const raw = twoProjectGraph();
    raw.graph.edges = [[0, 1, "development"]];
    const graph = transformMoonGraph(raw);
    mergeImportEdges(graph, {
      importSites: [{ ...dynamicImportOfApi(), kind: "static" }],
      projectOf,
    });
    expect(graph.dependencies.web).toEqual([{ source: "web", target: "api", type: "static" }]);
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

  // A ROOT-level project — one `moon.yml` at the workspace root — used to
  // contribute the top segment `"."` to whichever prefix set its layer
  // selected. `appsDir: "."` makes `../rules/specifiers.mjs`'s
  // `isAbsoluteImportIntoAnotherProject` test `imp.startsWith("./")`, so EVERY
  // ordinary relative import in the workspace becomes an
  // `noAbsoluteOrRelativeImportsAcrossLibraries`-class violation. It went
  // unnoticed because both existing root-project cases in this file declare
  // `layer: "configuration"`, which `inferWorkspaceLayout` never reads — so
  // the two layers that DO reach it are the ones pinned below.
  const withRootProject = (layer, source = ".") => {
    const raw = twoProjectGraph();
    raw.graph.nodes.push(2);
    raw.data["2"] = { id: "workspace-root", layer, source, dependencies: [] };
    return raw;
  };

  it('ignores a root-level "application" project rather than inferring appsDir "."', () => {
    const result = transformMoonGraph(withRootProject("application"));
    expect(result.workspaceLayout).toEqual({ appsDir: "apps", libsDir: "libs" });
  });

  it('ignores a root-level "library" project rather than inferring libsDir "."', () => {
    const result = transformMoonGraph(withRootProject("library"));
    expect(result.workspaceLayout).toEqual({ appsDir: "apps", libsDir: "libs" });
  });

  it("never carries `.` as a directory, whichever way a project spells a root-level source", () => {
    // The property, not one string: any spelling whose top segment is not a
    // real directory below the root must be unable to reach the layout. A
    // future spelling that slips through has to go red here. Spellings with
    // no canonical form at all ('/apps/web', 'apps//web', …) never get this
    // far — the transform refuses them, pinned in the root-spelling describe
    // above — so this loop covers exactly the spellings that normalise.
    for (const layer of ["application", "library"]) {
      for (const source of [".", "./", "././", "./apps/web"]) {
        const layout = transformMoonGraph(withRootProject(layer, source)).workspaceLayout;
        expect(Object.values(layout ?? {})).not.toContain(".");
        expect(Object.values(layout ?? {})).not.toContain("");
      }
    }
  });

  it("omits the layout entirely when the root project is the ONLY application project", () => {
    // The silent direction from the other side: with `apps/web` moved to the
    // root there is no appsDir candidate left, so the layout must come back
    // INCOMPLETE — letting `graph.workspaceLayout ?? DEFAULT_WORKSPACE_LAYOUT`
    // apply the complete default — rather than `{appsDir: "."}`, which is the
    // shape that reports every relative import in the tree.
    const raw = twoProjectGraph();
    raw.data["0"].source = ".";
    const result = transformMoonGraph(raw);
    expect(result.workspaceLayout).toBeUndefined();
  });
});

// ── readProjectGraph ─────────────────────────────────────────────────────────

/**
 * The directory the provider prepends to PATH for the fixture workspace root
 * `/workspace`, built the same way the provider builds it so a platform whose
 * separator is not `/` moves both sides together.
 */
const BIN_DIR = join("/workspace", "node_modules", ".bin");

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

  /**
   * The env one spawn was handed, for a given caller env and platform.
   *
   * `platform` is the seam `resolveMoonEnv` documents: the case rule it
   * decides is opposite on the two platforms, and a machine can only be one of
   * them, so both branches are driven here rather than one of them shipping
   * unproven.
   *
   * @param {Record<string, string|undefined>} env
   * @param {string} platform
   * @returns {Record<string, string|undefined>}
   */
  const childEnv = (env, platform) => {
    /** @type {Record<string, string|undefined>|undefined} */
    let captured;
    const run = (_file, _args, _cwd, spawnEnv) => {
      captured = spawnEnv;
      return JSON.stringify(twoProjectGraph());
    };
    readProjectGraph("/workspace", { run, resolveMoon: () => "moon", env, platform });
    return captured ?? {};
  };

  /** Every spelling of PATH the child was handed, in key order. */
  const pathSpellings = (env) => Object.keys(env).filter((key) => key.toUpperCase() === "PATH");

  // REPLACES a test that asserted the exact string
  // `/workspace/node_modules/.bin:` — a trailing empty PATH entry, pinned as
  // correct. POSIX resolves an empty entry as the CURRENT DIRECTORY, and this
  // spawn's current directory is the untrusted workspace being judged, so that
  // string means "run whatever file called `moon` the tree being checked
  // happens to contain". What is asserted now is the security PROPERTY over
  // every environment shape that can produce an empty entry — on BOTH
  // platforms, since the platform decides which variable is written — rather
  // than one expected string: a new spelling of the same hole has to go red
  // here.
  it("never emits an empty PATH entry, which resolves as the current directory — the tree being judged", () => {
    const environments = [
      {}, // no PATH at all
      { PATH: undefined }, // present, unset
      { PATH: "" }, // present, empty
      { PATH: delimiter }, // two empty entries and nothing else
      { PATH: `${delimiter}/usr/bin` }, // leading empty entry, inherited
      { PATH: `/usr/bin${delimiter}` }, // trailing empty entry, inherited
      { PATH: `/usr/bin${delimiter}${delimiter}/bin` }, // doubled delimiter
      { Path: "" }, // the Windows spelling, empty
      { Path: `${delimiter}/opt/tools${delimiter}` }, // the Windows spelling, padded
      { Path: "/opt/tools", PATH: `${delimiter}/usr/bin` }, // both spellings present
    ];
    let checked = 0;
    for (const platform of ["linux", "win32"]) {
      for (const env of environments) {
        const child = childEnv(env, platform);
        // Which variable carries the answer is the platform's decision, not
        // this assertion's: POSIX resolves the child through `PATH` alone,
        // Windows through the one spelling left standing.
        const key = platform === "win32" ? pathSpellings(child)[0] : "PATH";
        const entries = String(child[key] ?? "").split(delimiter);
        expect(entries).not.toContain("");
        // And the bin dir is still actually there — a PATH sanitised into
        // nothing would pass the assertion above by finding no binary at all.
        expect(entries[0]).toBe(BIN_DIR);
        checked += 1;
      }
    }
    // The loop ran; a `childEnv` that never spawned would satisfy every
    // assertion above by making none of them.
    expect(checked).toBe(environments.length * 2);
  });

  it("keeps the inherited entries when it strips the empty ones", () => {
    // The strip must remove empties, not neighbours: a PATH reduced to the bin
    // dir alone would stop finding a Moon installed anywhere else, which is a
    // loud failure but still a wrong one.
    /** @type {string|undefined} */
    let path;
    const run = (_file, _args, _cwd, env) => {
      path = String(env?.PATH ?? "");
      return JSON.stringify(twoProjectGraph());
    };
    const env = { PATH: `${delimiter}/usr/bin${delimiter}${delimiter}/bin${delimiter}` };
    readProjectGraph("/workspace", { run, resolveMoon: () => "moon", env });
    expect(path?.split(delimiter)).toEqual([BIN_DIR, "/usr/bin", "/bin"]);
  });

  it("on Windows, finds PATH under any case, so a `Path` is neither missed nor dropped", () => {
    // `../process.mjs`'s `environmentForTree` copies the environment with a
    // plain spread, which preserves the platform's own spelling — `Path` on
    // Windows — unlike `process.env`, whose Windows accessor is
    // case-insensitive. Reading `env.PATH` there answers undefined on a
    // machine whose PATH is perfectly present: the system PATH silently
    // dropped, leaving the bin dir plus an empty entry. That is the ordinary,
    // non-exotic route into the hole the test above pins shut.
    const child = childEnv({ Path: `/usr/bin${delimiter}/bin` }, "win32");
    expect(child.Path?.split(delimiter)).toEqual([BIN_DIR, "/usr/bin", "/bin"]);
    // Exactly ONE spelling reaches the child — on Windows the variants ARE one
    // variable, and two would leave the child reading whichever the system
    // prefers, with only one of them populated.
    expect(pathSpellings(child)).toEqual(["Path"]);
  });

  it("on Windows, prefers a populated PATH spelling over an empty one", () => {
    const child = childEnv({ PATH: "", Path: "/usr/bin" }, "win32");
    expect(child.Path?.split(delimiter)).toEqual([BIN_DIR, "/usr/bin"]);
    expect(pathSpellings(child)).toEqual(["Path"]);
  });

  // REPLACES a test ("prefers a populated PATH spelling over an empty one")
  // that ran the Windows rule on every platform and asserted the result was
  // right — pinning the defect as intended behaviour. On POSIX `Path` and
  // `PATH` are two ORDINARY, DISTINCT variables, both of which can exist, and
  // only `PATH` resolves the child's binary. Measured under the pinned
  // behaviour: env `{Path: "/opt/foo", PATH: "/usr/bin:/bin"}` reached the
  // child as `{Path: "/ws/node_modules/.bin:/opt/foo"}` alone — the real PATH
  // deleted, `moon` therefore ENOENT, and `isMoonBinaryMissing` telling a
  // consumer with Moon installed to install Moon.
  it("on POSIX, leaves an unrelated `Path` alone and augments the real `PATH`", () => {
    const child = childEnv({ Path: "/opt/foo", PATH: `/usr/bin${delimiter}/bin` }, "linux");
    // The variable the loader actually resolves through: augmented, complete,
    // bin dir first.
    expect(child.PATH?.split(delimiter)).toEqual([BIN_DIR, "/usr/bin", "/bin"]);
    // And the unrelated one: byte-identical, not deleted, not merged into.
    expect(child.Path).toBe("/opt/foo");
    expect(pathSpellings(child).sort()).toEqual(["PATH", "Path"]);
  });

  it("on POSIX, creates `PATH` rather than adopting a `Path` that is not it", () => {
    // The same rule from the other side: a POSIX env carrying only `Path` has
    // no PATH at all, so one is created — and `Path`, which the loader will
    // never read, is left exactly as the caller had it. Writing the bin dir
    // into `Path` instead would leave the child with no PATH and a variable
    // nobody asked this tool to touch.
    const child = childEnv({ Path: "/opt/foo" }, "linux");
    expect(child.PATH?.split(delimiter)).toEqual([BIN_DIR]);
    expect(child.Path).toBe("/opt/foo");
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

  it("puts workspace node_modules/.bin FIRST on PATH, joined with the platform delimiter", () => {
    // First, not merely present: the workspace's own Moon is the one that
    // matches the workspace's own Moon config. And joined with
    // `path.delimiter`, never a hardcoded ':', which is not the Windows one.
    /** @type {Record<string, string|undefined>|undefined} */
    let capturedEnv;
    const run = (_file, _args, _cwd, env) => {
      capturedEnv = env;
      return JSON.stringify(twoProjectGraph());
    };
    readProjectGraph("/workspace", {
      run,
      resolveMoon: () => "moon",
      env: { PATH: "/usr/bin" },
    });
    const path = capturedEnv?.PATH ?? "";
    expect(path.split(delimiter)).toEqual([BIN_DIR, "/usr/bin"]);
    expect(path[BIN_DIR.length]).toBe(delimiter);
  });

  it("does not duplicate node_modules/.bin in PATH when already present", () => {
    /** @type {Record<string, string|undefined>|undefined} */
    let capturedEnv;
    const run = (_file, _args, _cwd, env) => {
      capturedEnv = env;
      return JSON.stringify(twoProjectGraph());
    };
    const env = { PATH: `${BIN_DIR}${delimiter}/usr/bin` };
    readProjectGraph("/workspace", { run, resolveMoon: () => "moon", env });
    const path = capturedEnv?.PATH ?? "";
    expect(path.split(delimiter)).toEqual([BIN_DIR, "/usr/bin"]);
  });

  it("still prepends the bin dir when another entry merely CONTAINS its name", () => {
    // The dedupe is segment equality, not substring containment. A sibling
    // `…/node_modules/.bin-old` contains the bin dir as a substring; reading
    // that as "already on PATH" leaves the real one off entirely and lets
    // `moon` resolve to whatever else on the machine answers to the name —
    // silently, since the spawn still succeeds.
    /** @type {Record<string, string|undefined>|undefined} */
    let capturedEnv;
    const run = (_file, _args, _cwd, env) => {
      capturedEnv = env;
      return JSON.stringify(twoProjectGraph());
    };
    const env = { PATH: `${BIN_DIR}-old${delimiter}/usr/bin` };
    readProjectGraph("/workspace", { run, resolveMoon: () => "moon", env });
    expect(capturedEnv?.PATH?.split(delimiter)).toEqual([BIN_DIR, `${BIN_DIR}-old`, "/usr/bin"]);
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
  it("propagates a spawn failure that is not an absent binary, untouched", () => {
    // Anything Moon itself produced keeps `runProcess`'s naming: rewriting a
    // real Moon error here would bury the child's own stderr.
    const run = () => {
      throw new Error("archkeep: `moon project-graph --json` failed in /workspace: EACCES");
    };
    expect(() => readProjectGraph("/workspace", { run, resolveMoon: () => "moon" })).toThrow(
      /EACCES/u,
    );
  });

  it("propagates a nonzero exit with the command and working directory named", () => {
    // The exact shape `../process.mjs`'s `runProcess` emits for a failing
    // child — pinned here so a future catch inside `readProjectGraph` cannot
    // quietly flatten it into an empty-but-valid-looking result.
    const run = () => {
      throw new Error("archkeep: `moon project-graph --json` failed in /workspace: exit status 2");
    };
    expect(() => readProjectGraph("/workspace", { run, resolveMoon: () => "moon" })).toThrow(
      /`moon project-graph --json` failed in \/workspace: exit status 2/u,
    );
  });

  it("surfaces an injected resolver's failure before anything is spawned", () => {
    // An injected resolver still short-circuits the spawn. This is the SEAM's
    // contract, not the shipped one — the default resolver is a constant and
    // cannot fail, which is why the shipped missing-binary story is driven for
    // real in the describe below rather than from a stub's own message.
    const resolveMoon = () => {
      throw new Error("archkeep: injected resolver refused");
    };
    let spawned = false;
    const run = () => {
      spawned = true;
      return JSON.stringify(twoProjectGraph());
    };
    expect(() => readProjectGraph("/workspace", { run, resolveMoon })).toThrow(
      /injected resolver refused/u,
    );
    expect(spawned).toBe(false);
  });
});

// The missing-binary story, driven end to end with NO stub on the failure
// path: the DEFAULT resolver runs, the real `../process.mjs` `runProcess`
// spawns, and the ENOENT the consumer's own machine would produce is the one
// being read. This describe replaces an assertion made against an injected
// resolver's own thrown message — a fixture the shipped code never produces,
// standing in for a documented `@throws` neither `resolveMoonEnv` nor
// `resolveMoonCli` could reach. The environment is emptied so the child's PATH
// is exactly the fixture's own `node_modules/.bin`: the verdict is then a
// property of the fixture, not of whatever the machine running the suite
// happens to have installed.
describe("readProjectGraph — the real resolver, the real spawn", () => {
  /** @returns {{root: string, cleanup: () => void}} */
  const workspace = () => {
    const root = mkdtempSync(join(tmpdir(), "archkeep-moon-"));
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  };

  it("names an action a consumer can take when the binary is in neither place", () => {
    const { root, cleanup } = workspace();
    try {
      /** @type {unknown} */
      let thrown;
      try {
        readProjectGraph(root, { env: {} });
      } catch (error) {
        thrown = error;
      }
      // Loud, first of all: never an empty graph, and never a `{nodes: {},
      // dependencies: {}}` that reads as a clean workspace downstream.
      expect(thrown).toBeInstanceOf(Error);
      const message = String(/** @type {Error} */ (thrown).message);
      // The two places it looked, the command it meant to run, and — the half
      // the raw `spawnSync moon ENOENT` has never had — what to DO about it.
      expect(message).toContain(join(root, "node_modules", ".bin"));
      expect(message).toContain("PATH");
      expect(message).toContain("moon project-graph --json");
      expect(message).toMatch(/pnpm add -D @moonrepo\/cli/u);
      // The underlying failure is chained, not swallowed: nothing about WHY
      // is lost to the rewording.
      const cause = /** @type {{cause?: {message?: string}}} */ (thrown).cause;
      expect(String(cause?.message ?? "")).toMatch(/ENOENT/u);
    } finally {
      cleanup();
    }
  });

  it("actually runs a `moon` found only in the workspace's own node_modules/.bin", () => {
    // The other half of the same claim. Without this, the test above would
    // pass just as well against a provider that could never find Moon at all
    // — the PATH augmentation has to be proven to WORK, by a binary that
    // exists nowhere else, reached through the default resolver and the real
    // spawn.
    const { root, cleanup } = workspace();
    try {
      const binDir = join(root, "node_modules", ".bin");
      mkdirSync(binDir, { recursive: true });
      const graphFile = join(root, "graph.json");
      writeFileSync(graphFile, JSON.stringify(twoProjectGraph()));
      const shim = join(binDir, "moon");
      writeFileSync(shim, `#!/bin/sh\nexec /bin/cat ${graphFile}\n`);
      chmodSync(shim, 0o755);
      const result = readProjectGraph(root, { env: { PATH: `/usr/bin${delimiter}/bin` } });
      expect(Object.keys(result.nodes).sort()).toEqual(["api", "web"]);
    } finally {
      cleanup();
    }
  });
});
// ── the tsconfig a Moon workspace is read against ────────────────────────────

describe("the tsconfig convention a Moon workspace is judged through", () => {
  // `../options.mjs`'s `readMoonOptions` decides the NAME; this drives that
  // name through the real `ts.resolveModuleName` context the analyzer uses
  // (`../analysis/typescript.mjs`'s `tsconfigPathsFacts` reads the same
  // memoised parse the resolver does), so what is pinned here is the paths
  // table a verdict is actually computed from — not a string comparison that
  // would still pass if nothing downstream read the name.
  const PATHS = { "@ws/core": ["libs/core/index.ts"] };
  const FILES = ["tsconfig.json", "libs/core/index.ts", "apps/web/main.ts"];
  const TREE = {
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: PATHS } }),
    "libs/core/index.ts": "export const core = 1;\n",
    "apps/web/main.ts": 'import { core } from "@ws/core";\n',
  };
  const workspaceFor = (tsConfig) =>
    createWorkspace({
      root: "/ws",
      graph: {
        nodes: {
          core: { name: "core", data: { root: "libs/core" } },
          web: { name: "web", data: { root: "apps/web" } },
        },
      },
      files: FILES,
      tsConfig,
      read: (path) => TREE[path] ?? null,
    }).workspace;

  it("reads the paths table out of tsconfig.json when there is no tsconfig.base.json", () => {
    // The silent direction. This is the shape of the workspace that produced
    // the measured failure: a Vue tree whose paths table lives in
    // `tsconfig.json`, judged by a provider fixed at `tsconfig.base.json`.
    const options = readMoonOptions("/ws", {
      exists: (path) => path === join("/ws", "tsconfig.json"),
      listFiles: () => FILES,
    });
    const facts = tsconfigPathsFacts(workspaceFor(options.tsConfig));
    expect(facts.tsConfig).toBe("tsconfig.json");
    expect(facts.paths).toEqual(PATHS);
    expect(facts.configFailure).toBeNull();
  });

  it("resolves nothing at all when the name is fixed at the first chain entry", () => {
    // The half that makes the test above mean something: the same tree, read
    // under the name the provider used before the chain, has NO paths table
    // and reports no failure either — `ts.resolveModuleName` falls back to the
    // compiler defaults and every `@ws/…` specifier resolves to nothing, with
    // nothing anywhere in the run saying the table was never found.
    const facts = tsconfigPathsFacts(workspaceFor(MOON_TSCONFIG_CHAIN[0]));
    expect(facts.paths).toBeUndefined();
    expect(facts.configFailure).toBeNull();
  });
});
