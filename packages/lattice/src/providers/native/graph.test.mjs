import { describe, expect, it } from "vitest";

import { buildDependencies, buildNativeGraph } from "./graph.mjs";

const project = (overrides) => ({
  name: "p",
  root: "p",
  type: "lib",
  tags: [],
  implicitDependencies: [],
  ...overrides,
});

const importSite = (sourceFile, target, kind = "static") => ({
  sourceFile,
  kind,
  resolved: { target },
});

describe("buildNativeGraph", () => {
  // "graph / data hygiene": only what this provider actually measured reaches
  // `data`. The silent-direction bug is a future edit spreading the rest of
  // `lattice.json`'s declared-project row (a hypothetical `entryPoints` or
  // `mfeRemote`) straight through — fields the Nx path computes itself, from
  // real package.json/webpack facts, that a native `lattice.json` author could
  // otherwise simply assert into existence.
  it("writes only root, tags and implicitDependencies to data — nothing else", () => {
    const { nodes } = buildNativeGraph({
      projects: [
        project({
          name: "a",
          root: "libs/a",
          tags: ["scope:shared"],
          implicitDependencies: ["b"],
        }),
      ],
      importSites: [],
      projectOf: () => undefined,
    });
    expect(Object.keys(nodes)).toEqual(["a"]);
    expect(nodes.a).toEqual({
      name: "a",
      type: "lib",
      data: { root: "libs/a", tags: ["scope:shared"], implicitDependencies: ["b"] },
    });
    expect(Object.keys(nodes.a.data).sort()).toEqual(["implicitDependencies", "root", "tags"]);
  });

  it("never sets externalNodes", () => {
    const graph = buildNativeGraph({
      projects: [project({ name: "a" })],
      importSites: [],
      projectOf: () => undefined,
    });
    expect(/** @type {{externalNodes?: unknown}} */ (graph).externalNodes).toBeUndefined();
  });

  // S5: `lattice.json`'s `projects.declared[].targets` names target names
  // only, and this is where a name becomes the shape
  // `../../rules/topology.mjs`'s `hasBuildExecutor` actually reads —
  // `{[name]: {executor}}` with a non-empty executor string, since
  // `hasBuildExecutor` treats `executor === ''` as not really buildable.
  // Without this, `enforceBuildableLibDependency` validated but was never
  // live on a native tree: every project read as targetless, so the rule's
  // own "does the SOURCE have a build target" gate never opened.
  it("synthesizes data.targets from a project's declared target names", () => {
    const { nodes } = buildNativeGraph({
      projects: [project({ name: "a", targets: ["build", "test"] })],
      importSites: [],
      projectOf: () => undefined,
    });
    expect(nodes.a.data.targets).toEqual({
      build: { executor: "lattice:declared" },
      test: { executor: "lattice:declared" },
    });
  });

  // The absent/empty distinction matters to `hasBuildExecutor`'s own
  // `Boolean(targets && …)` check: a project that declares zero targets must
  // read as "no data.targets at all", not as a targets table that merely
  // happens to be empty — the two are behaviourally identical to
  // `hasBuildExecutor` today, but only one of them keeps `data`'s "nothing
  // this provider did not measure" invariant, which is what the first test in
  // this block pins.
  it("leaves data.targets absent, not an empty object, when the project declares no targets", () => {
    const { nodes } = buildNativeGraph({
      projects: [project({ name: "a", targets: [] })],
      importSites: [],
      projectOf: () => undefined,
    });
    expect("targets" in nodes.a.data).toBe(false);
  });

  // B2: `workspaceLayout` is a workspace-wide fact, not a per-project one, so
  // it rides on the returned graph OBJECT — never inside a node's `data` —
  // exactly where `../../rules/index.mjs`'s `createContext` reads it
  // (`graph.workspaceLayout ?? DEFAULT_WORKSPACE_LAYOUT`). The silent-direction
  // bug this pins against: `lattice.json`'s `workspaceLayout` used to be
  // validated and then dropped, so every native check ran against the Nx
  // default regardless of what a workspace declared.
  it("attaches a declared workspaceLayout to the graph object, not to any node's data", () => {
    const graph = buildNativeGraph({
      projects: [project({ name: "a" })],
      importSites: [],
      projectOf: () => undefined,
      workspaceLayout: { appsDir: "applications", libsDir: "packages" },
    });
    expect(graph.workspaceLayout).toEqual({ appsDir: "applications", libsDir: "packages" });
    expect("workspaceLayout" in graph.nodes.a.data).toBe(false);
  });

  it("leaves workspaceLayout absent — not defaulted here — when none is declared", () => {
    const graph = buildNativeGraph({
      projects: [project({ name: "a" })],
      importSites: [],
      projectOf: () => undefined,
    });
    expect("workspaceLayout" in graph).toBe(false);
  });
});

describe("buildDependencies", () => {
  const nodes = {
    a: { name: "a", data: { root: "a", tags: [], implicitDependencies: [] } },
    b: { name: "b", data: { root: "b", tags: ["shared"], implicitDependencies: [] } },
    c: { name: "c", data: { root: "c", tags: [], implicitDependencies: [] } },
  };

  it("turns a static import site into a static edge", () => {
    const dependencies = buildDependencies({
      importSites: [importSite("a/x.ts", "b")],
      nodes,
      projectOf: () => "a",
    });
    expect(dependencies.a).toEqual([{ source: "a", target: "b", type: "static" }]);
  });

  it("turns a dynamic import site into a dynamic edge, kept distinct from static", () => {
    const dependencies = buildDependencies({
      importSites: [importSite("a/x.ts", "b", "dynamic")],
      nodes,
      projectOf: () => "a",
    });
    expect(dependencies.a).toEqual([{ source: "a", target: "b", type: "dynamic" }]);
  });

  // The target has to be a real node for an edge to exist at all — a
  // deliberate silence, not a hole: an import resolving outside every known
  // project is a different question `../../rules/specifiers.mjs` answers
  // (external-dependency handling), not this reduction. Proven here by
  // showing it neither throws nor invents a phantom node for the target.
  it("drops an edge to a target with no node, without throwing or inventing one", () => {
    const dependencies = buildDependencies({
      importSites: [importSite("a/x.ts", "ghost")],
      nodes,
      projectOf: () => "a",
    });
    expect(dependencies.a ?? []).toEqual([]);
    expect(Object.keys(nodes)).toEqual(["a", "b", "c"]);
  });

  it("produces no edge for a self-loop", () => {
    const dependencies = buildDependencies({
      importSites: [importSite("a/x.ts", "a")],
      nodes,
      projectOf: () => "a",
    });
    expect(dependencies.a ?? []).toEqual([]);
  });

  it("deduplicates an identical edge reported by more than one import site", () => {
    const dependencies = buildDependencies({
      importSites: [importSite("a/x.ts", "b"), importSite("a/y.ts", "b")],
      nodes,
      projectOf: () => "a",
    });
    expect(dependencies.a).toEqual([{ source: "a", target: "b", type: "static" }]);
  });

  it("expands implicitDependencies into implicit edges through the shared matcher", () => {
    const withImplicit = {
      ...nodes,
      a: { ...nodes.a, data: { ...nodes.a.data, implicitDependencies: ["tag:shared"] } },
    };
    const dependencies = buildDependencies({
      importSites: [],
      nodes: withImplicit,
      projectOf: () => undefined,
    });
    expect(dependencies.a).toEqual([{ source: "a", target: "b", type: "implicit" }]);
  });

  // A pattern the matcher rejects (glob syntax it deliberately does not
  // reproduce, `../../rules/match.mjs`'s `projectPatternError`) is caught and
  // the edge is skipped rather than propagated. `./discover.mjs` validates
  // every native `implicitDependencies` entry before a graph is ever built
  // from it, so a native workspace never reaches this branch with a bad
  // pattern — the catch exists for `../../lsp/workspace-index.mjs`'s
  // unvalidated `project.json` data, and this proves it fails closed rather
  // than crashing the whole graph build over one bad row.
  it("does not throw when an implicitDependencies pattern is one the matcher rejects", () => {
    const withBadPattern = {
      ...nodes,
      a: { ...nodes.a, data: { ...nodes.a.data, implicitDependencies: ["libs/*"] } },
    };
    const build = () =>
      buildDependencies({ importSites: [], nodes: withBadPattern, projectOf: () => undefined });
    expect(build).not.toThrow();
    expect(build().a ?? []).toEqual([]);
  });
});
