import { describe, expect, it } from "vitest";

import { evaluate } from "../../rules/index.mjs";
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
  specifier: target,
  resolved: { target },
  // `evaluate` validates every record's `spelling` against the analysis
  // contract before judging (`src/analysis/contract.md`): whether a specifier
  // is a path and whether it stays inside its own project are questions only
  // an analyzer can answer, so the fixture states the JS-family answer.
  spelling: { path: false, relative: false },
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

  // #218: the concrete coverage-exempt list rides the graph OBJECT the same
  // way `workspaceLayout` does — a workspace-wide fact the rules layer reads
  // off the graph it is handed (`../../rules/index.mjs`'s `exemptedFiles`),
  // never inside a node's `data`, and never as the globs the rows are
  // written with.
  it("threads the concrete coverage-exempt file list onto the graph object", () => {
    const graph = buildNativeGraph({
      projects: [project({ name: "a", root: "libs/a" })],
      importSites: [],
      projectOf: () => undefined,
      exemptedFiles: ["libs/loose.ts"],
    });
    expect(graph.exemptedFiles).toEqual(["libs/loose.ts"]);
    expect("exemptedFiles" in graph.nodes.a.data).toBe(false);
  });

  it("leaves exemptedFiles absent — never an empty array — when nothing was exempted", () => {
    const graph = buildNativeGraph({
      projects: [project({ name: "a" })],
      importSites: [],
      projectOf: () => undefined,
    });
    expect("exemptedFiles" in graph).toBe(false);
  });

  // A project literally named `__proto__` is not a hypothetical — the name
  // comes straight from `lattice.json` or a tracked manifest, both
  // attacker-supplied. The silent-direction bug this pins: `nodes[project.name]
  // = …` against a plain `{}` repoints the object's OWN [[Prototype]] instead
  // of adding an entry, so the project vanishes from every
  // `Object.keys`/`Object.entries` walk in this module and in `../../rules/`
  // while `nodes["__proto__"]` still reads back truthy — a workspace with a
  // `__proto__` project would read as one with fewer projects than it
  // declared, with no diagnostic naming why.
  // `Object.prototype.hasOwnProperty` is the direct proof of a real own
  // property, as distinct from an inherited one.
  it("keeps a project named __proto__ as a real, own entry — not a repointed prototype", () => {
    const { nodes } = buildNativeGraph({
      projects: [project({ name: "__proto__", root: "libs/weird" })],
      importSites: [],
      projectOf: () => undefined,
    });
    expect(Object.prototype.hasOwnProperty.call(nodes, "__proto__")).toBe(true);
    expect(Object.keys(nodes)).toEqual(["__proto__"]);
    expect(Object.entries(nodes)).toHaveLength(1);
    expect(nodes["__proto__"].name).toBe("__proto__");
    expect(nodes["__proto__"].data.root).toBe("libs/weird");
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

  // R14 — the code-pushup shape. Its root project (root `""`, no projectType,
  // named `workspace`) owns every root-level config file, and each project's
  // own `eslint.config.js` imports `../../eslint.config.js`, which resolves
  // INTO the root project. Nx drops exactly those target-root edges
  // (`explicit-project-dependencies.js`, now reproduced in `graph.mjs`), and
  // this is the regression that pins it: a config file must not become an
  // edge that closes a cycle through the root node. Fixture mirrors the real
  // tree's shape — a root project, a `.config`-style file importing the
  // root's config relatively, and a source file whose import the cycle would
  // otherwise poison — see `scripts/differential-real-trees.mjs`'s TREES
  // table (code-pushup @ ba41f92) for the measured 33 false `*->workspace`
  // edges and 330 false `noCircularDependencies` verdicts.
  it("does not draw an import edge INTO the workspace-root project from a project-level config file", () => {
    const withRoot = {
      workspace: { name: "workspace", data: { root: "", tags: [], implicitDependencies: [] } },
      utils: {
        name: "utils",
        data: { root: "packages/utils", tags: [], implicitDependencies: [] },
      },
    };
    const dependencies = buildDependencies({
      // `packages/utils/eslint.config.js` says `import ... from
      // '../../eslint.config.js'` — resolves to the root project.
      importSites: [importSite("packages/utils/eslint.config.js", "workspace")],
      nodes: withRoot,
      projectOf: () => "utils",
    });
    expect(dependencies.workspace ?? []).toEqual([]);
    expect(dependencies.utils ?? []).toEqual([]);
    // The mirror case, so the exemption's edge is pinned from both sides: an
    // edge FROM the workspace root to a real project (the root-level
    // `code-pushup.preset.ts` importing `./packages/...`) must STILL be drawn
    // — Nx keeps root-source edges, and dropping them would lose 9 real edges
    // on the same tree.
    const rootToProject = buildDependencies({
      importSites: [importSite("code-pushup.preset.ts", "utils")],
      nodes: withRoot,
      projectOf: () => "workspace",
    });
    expect(rootToProject.workspace).toEqual([
      { source: "workspace", target: "utils", type: "static" },
    ]);
  });

  // The SILENT-DIRECTION half of the same R14 finding, at the verdict layer:
  // the exported graph from the two fixture cases above, judged over a source
  // import like the tree's real ones (`packages/plugin-axe/src/lib/axe-plugin.ts`
  // importing the utils project). Before the target-root rule existed, the
  // `utils->workspace` config edge above plus the root project's `workspace->
  // utils` preset edge closed a cycle through the root node, and every such
  // resolution was reported `noCircularDependencies` — 330 false verdicts on
  // the code-pushup tree. With the edge gone, the same import must be judged
  // clean: a missing verdict here is the silent direction the whole exemption
  // exists to avoid, and this test proves the rule present in the graph rather
  // than only asserted in prose.
  it("judges clean the source import a config-edge-driven cycle used to poison", () => {
    const withRoot = {
      workspace: {
        name: "workspace",
        type: "lib",
        data: { root: "", tags: [], implicitDependencies: [] },
      },
      utils: {
        name: "utils",
        type: "lib",
        data: { root: "packages/utils", tags: [], implicitDependencies: [] },
      },
      axe: {
        name: "axe",
        type: "lib",
        data: { root: "packages/plugin-axe", tags: [], implicitDependencies: [] },
      },
    };
    // The raw analysis records the tree yields: each project's eslint config
    // importing the root config (target = workspace), the root preset importing
    // every project it composes (source = workspace, the real tree's nine
    // `workspace->X` edges), and the one real source-site being judged. Before
    // the target-root rule existed this graph carried BOTH halves — `utils ->
    // workspace` from the config and `workspace -> axe` from the preset — so
    // judging `axe -> utils` found the `utils -> workspace -> axe` road back
    // and reported `noCircularDependencies` (330 times on the code-pushup
    // tree). The target-root skip swallows the config edge half, the
    // root-source preset edge survives, the road back is gone, and the verdict
    // must stay silent — which is the exact direction the exemption could
    // otherwise fake green in.
    const importSites = [
      importSite("packages/utils/eslint.config.js", "workspace"),
      importSite("code-pushup.preset.ts", "utils"),
      importSite("code-pushup.preset.ts", "axe"),
      importSite("packages/plugin-axe/src/lib/axe-plugin.ts", "utils"),
    ];
    const { dependencies } = buildNativeGraph({
      projects: [
        {
          name: "workspace",
          root: "",
          type: "lib",
          tags: [],
          implicitDependencies: [],
          targets: [],
        },
        {
          name: "utils",
          root: "packages/utils",
          type: "lib",
          tags: [],
          implicitDependencies: [],
          targets: [],
        },
        {
          name: "axe",
          root: "packages/plugin-axe",
          type: "lib",
          tags: [],
          implicitDependencies: [],
          targets: [],
        },
      ],
      importSites,
      projectOf: (file) => {
        if (file.startsWith("packages/utils/")) return "utils";
        if (file.startsWith("packages/plugin-axe/")) return "axe";
        return "workspace";
      },
    });
    const graph = { nodes: withRoot, dependencies };
    const verdicts = evaluate(
      [importSite("packages/plugin-axe/src/lib/axe-plugin.ts", "utils")],
      graph,
      {
        depConstraints: [],
        options: {
          allow: [],
          buildTargets: ["build"],
          enforceBuildableLibDependency: false,
          allowCircularSelfDependency: false,
          checkDynamicDependenciesExceptions: [],
          ignoredCircularDependencies: [],
          banTransitiveDependencies: false,
          checkNestedExternalImports: false,
        },
        suppressions: [],
      },
    );
    expect(verdicts.map((v) => v.messageId)).toEqual([]);
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
  // reproduce, `../../rules/match.mjs`'s `projectPatternError`) is a
  // project-definition problem, and `findMatchingProjects` throws naming it.
  // This now propagates rather than being caught and dropped: the old
  // `catch { continue }` here silently skipped the bad row's implicit edges
  // and kept building, which read exactly like a workspace where every
  // implicit dependency really did resolve cleanly — the silent-direction
  // failure `../../../AGENTS.md`'s invariant refuses. `./discover.mjs`
  // validates every native `implicitDependencies` entry before a graph is
  // ever built, so this is dead code on the native path either way; the only
  // question was which failure mode the LSP's unvalidated `project.json` data
  // gets if it ever reaches here, and `../../lsp/server.mjs`'s existing
  // `.catch()` around the whole index build already turns a thrown error into
  // a loud "could not analyze" state, so propagating is safe there too.
  it("throws, naming the pattern, when an implicitDependencies pattern is one the matcher rejects", () => {
    const withBadPattern = {
      ...nodes,
      a: { ...nodes.a, data: { ...nodes.a.data, implicitDependencies: ["libs/*"] } },
    };
    const build = () =>
      buildDependencies({ importSites: [], nodes: withBadPattern, projectOf: () => undefined });
    expect(build).toThrow(/libs\/\*/);
  });

  // A project name may legally contain a space — neither `./model.mjs`'s
  // `declaredProjectViolations` nor `./discover.mjs`'s manifest-sourced name
  // resolution reject one, only non-empty is required. The silent-direction
  // bug this pins: the old dedup key `${source} ${target} ${type}` collided
  // whenever a space crossed the join — source `"a b"` target `"c"` and
  // source `"a"` target `"b c"` both hashed to `"a b c static"` — so the
  // second edge was dropped as a false duplicate of the first, and the
  // dependency it represented read as absent.
  it("keeps two distinct edges whose source/target names contain spaces — not collided by a space-joined key", () => {
    const spacedNodes = {
      ...nodes,
      "a b": { name: "a b", data: { root: "a b", tags: [], implicitDependencies: [] } },
      "b c": { name: "b c", data: { root: "b c", tags: [], implicitDependencies: [] } },
    };
    const dependencies = buildDependencies({
      importSites: [importSite("a b/x.ts", "c"), importSite("a/x.ts", "b c")],
      nodes: spacedNodes,
      projectOf: (file) => (file.startsWith("a b/") ? "a b" : "a"),
    });
    expect(dependencies["a b"]).toEqual([{ source: "a b", target: "c", type: "static" }]);
    expect(dependencies["a"]).toEqual([{ source: "a", target: "b c", type: "static" }]);
  });

  // Same class of bug as `buildNativeGraph`'s own `__proto__` test above, from
  // the other side: a project named `__proto__` must still be a valid EDGE
  // endpoint — both as the target of an import (`nodes[target]` must see it)
  // and as the source of an implicit edge (`Object.entries(nodes)` must walk
  // it, and `dependencies["__proto__"]` must be a real own array rather than
  // a repointed prototype the very next `.push` throws against).
  it("builds edges into and out of a project named __proto__ without crashing", () => {
    const protoNodes = Object.create(null);
    Object.assign(protoNodes, nodes);
    protoNodes["__proto__"] = {
      name: "__proto__",
      data: { root: "weird", tags: [], implicitDependencies: ["a"] },
    };
    const dependencies = buildDependencies({
      importSites: [importSite("a/x.ts", "__proto__")],
      nodes: protoNodes,
      projectOf: () => "a",
    });
    expect(Object.prototype.hasOwnProperty.call(dependencies, "a")).toBe(true);
    expect(dependencies.a).toEqual(
      expect.arrayContaining([{ source: "a", target: "__proto__", type: "static" }]),
    );
    expect(Object.prototype.hasOwnProperty.call(dependencies, "__proto__")).toBe(true);
    expect(dependencies["__proto__"]).toEqual([
      { source: "__proto__", target: "a", type: "implicit" },
    ]);
  });
});
