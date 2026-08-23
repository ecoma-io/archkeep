import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildDependencies,
  buildNodes,
  buildWorkspaceIndex,
  discoverProjects,
  indexGaps,
  nodeTypeOf,
  PROJECT_CONFIG_FILE,
} from "./workspace-index.mjs";

// The analyzers and the rule matcher are real collaborators of the module under
// test, and this is the unit tier: the index's own job is deciding what a
// project IS and which edges follow from a set of records, not whether Go
// resolution works. `../lsp.integration.test.mjs` drives the real pair.
vi.mock("../analysis/analyze.mjs", () => ({
  analyzeFile: vi.fn(() => ({ imports: [], failures: [] })),
  languageOf: (file) => (file.endsWith(".go") ? "go" : null),
}));
vi.mock("../rules/match.mjs", async () => {
  const { posix } = await import("node:path");
  return {
    findMatchingProjects: (patterns) => patterns.filter((p) => !p.startsWith("!")),
    // `../providers/native/model.mjs`'s `declaredProjectViolations` imports this
    // to validate `implicitDependencies` entries — needed the moment a test
    // drives the native branch (`buildNativeWorkspaceIndex`), which loads that
    // module transitively. `null` means "no problem with this pattern", the same
    // permissive answer the real function gives every non-glob pattern.
    projectPatternError: () => null,
    // `../config.mjs` imports these three alongside `projectPatternError` above,
    // and `model.mjs` now imports `../../config.mjs` for
    // `findBoundaryConfigViolations` (the one shared validator both the
    // `boundaryConfig` file dialects and an inline policy object route through)
    // — so loading `model.mjs` at all pulls `../rules/match.mjs`'s whole
    // export surface in, not just the one name this suite used to need. Same
    // permissive "no problem" stub as `projectPatternError` above.
    importPatternError: () => null,
    globPatternError: () => null,
    tagPatternError: () => null,
    // `model.mjs`'s `projectRuleViolations`/`exemptRowViolations`/
    // `inferViolations` call this to validate a `projectRules[].match`/
    // `coverage.exempt[].path`/`projects.infer.include`/`exclude` entry the
    // moment `loadNativeModel` runs; its own `matchesGlob` export assigns
    // `safeMatchesGlob` at module scope, evaluated the moment `model.mjs`
    // loads at all, not only when a test calls it. Neither fixture in this
    // file exercises a brace-bomb pattern, so both stubs delegate straight to
    // the real, un-guarded `path.posix.matchesGlob`/"no problem" rather than
    // reproducing the cap — this is the unit tier, and the guard itself is
    // `rules/match.test.mjs`'s to prove.
    globComplexityError: () => null,
    safeMatchesGlob: (path, pattern) => posix.matchesGlob(path, pattern),
  };
});

const analyzeFile = vi.mocked((await import("../analysis/analyze.mjs")).analyzeFile);

/** A tree as `buildWorkspaceIndex` reads one: a file list and a reader. */
function tree(files) {
  return {
    files: Object.keys(files),
    readFile: (path) => files[path] ?? null,
  };
}

describe("discovering the projects a tree declares", () => {
  it("takes the name a project states, then its package, then its directory", () => {
    // Nx's own precedence. Guessing a different name would attribute every one
    // of the project's files to a project the graph does not have, and the rule
    // engine throws rather than guess on that (`../rules/index.mjs`).
    const { projects } = discoverProjects(
      tree({
        [`stated/${PROJECT_CONFIG_FILE}`]: '{"name":"stated-name"}',
        [`packaged/${PROJECT_CONFIG_FILE}`]: "{}",
        "packaged/package.json": '{"name":"packaged-name"}',
        [`fallback/${PROJECT_CONFIG_FILE}`]: "{}",
      }),
    );

    expect(projects.map((p) => p.name).sort()).toEqual([
      "fallback",
      "packaged-name",
      "stated-name",
    ]);
    expect(projects.find((p) => p.name === "stated-name").root).toBe("stated");
  });

  it("reads every JSONC form Nx reads, because a project Nx has is a project", () => {
    // Nx parses `project.json` with jsonc-parser and `allowTrailingComma`, so
    // each file below names a project that exists everywhere else in the
    // toolchain — in `nx graph`, in ESLint's view, in `../../cli.mjs`. Dropping
    // one here takes it out of the graph, turns every import of it into an
    // external package, and paints a real crossing clean in the editor while
    // the CLI still fails on it.
    const { projects, skipped } = discoverProjects(
      tree({
        [`trailing-comma/${PROJECT_CONFIG_FILE}`]: '{"name":"trailing-comma","tags":["a"],}',
        [`line-comment/${PROJECT_CONFIG_FILE}`]: '{\n// the near side\n"name":"line-comment"\n}',
        [`block-comment/${PROJECT_CONFIG_FILE}`]: '{/* the far side */"name":"block-comment"}',
      }),
    );

    expect(skipped).toEqual([]);
    expect(projects.map((p) => p.name).sort()).toEqual([
      "block-comment",
      "line-comment",
      "trailing-comma",
    ]);
    expect(projects.find((p) => p.name === "trailing-comma").config.tags).toEqual(["a"]);
  });

  it("takes a package.json name through the same parser project.json goes through", () => {
    // Nx reads both files with `readJsonFile`. A `package.json` this could not
    // parse would silently fall through to the directory name — a project the
    // graph knows under one name and every constraint row names under another.
    const { projects } = discoverProjects(
      tree({
        [`somewhere/${PROJECT_CONFIG_FILE}`]: "{}",
        "somewhere/package.json":
          '{\n// published under a different name\n"name":"@scope/thing"\n}',
      }),
    );

    expect(projects.map((p) => p.name)).toEqual(["@scope/thing"]);
  });

  it("skips a project.json it cannot read instead of blanking the whole graph", () => {
    // One project being edited must not cost the verdict for every other. The
    // skip is reported so the server can say so rather than swallow it.
    const { projects, skipped } = discoverProjects(
      tree({
        [`good/${PROJECT_CONFIG_FILE}`]: '{"name":"good"}',
        [`broken/${PROJECT_CONFIG_FILE}`]: "{ this is not json",
      }),
    );

    expect(projects.map((p) => p.name)).toEqual(["good"]);
    expect(skipped).toEqual([
      { file: `broken/${PROJECT_CONFIG_FILE}`, reason: expect.stringContaining("not valid JSON") },
    ]);
  });

  it("gives a project.json at the tree root the empty root the path lookups expect", () => {
    // `''` is what `normalizeProjectRoot` turns into `'.'` and what
    // `projectOwning` treats as matching everything; `'.'` written here would
    // match no file at all, because no workspace-relative path starts with `./`.
    const { projects } = discoverProjects(tree({ [PROJECT_CONFIG_FILE]: '{"name":"root"}' }));

    expect(projects).toEqual([{ name: "root", root: "", config: { name: "root" } }]);
  });

  it("skips a project.json that is listed but cannot be read", () => {
    // A manifest that vanishes between the git listing and the read is a
    // skipped project, reported — a project silently absent from the graph is
    // the same defect this index exists to refuse.
    const { projects, skipped } = discoverProjects(
      tree({
        [`good/${PROJECT_CONFIG_FILE}`]: '{"name":"good"}',
        [`gone/${PROJECT_CONFIG_FILE}`]: undefined,
      }),
    );
    expect(projects.map((p) => p.name)).toEqual(["good"]);
    expect(skipped).toEqual([{ file: `gone/${PROJECT_CONFIG_FILE}`, reason: "could not be read" }]);
  });

  it("skips a project.json at the root that can end up with no usable name", () => {
    // No stated name, no package.json beside it, and the tree root — the name
    // chain has nothing left to fall back to. Such a project must be skipped
    // and SAID to be skipped, never guessed into the graph under a made-up
    // name.
    const { projects, skipped } = discoverProjects(tree({ [PROJECT_CONFIG_FILE]: "{}" }));
    expect(projects).toEqual([]);
    expect(skipped).toEqual([
      { file: PROJECT_CONFIG_FILE, reason: "declares no usable project name" },
    ]);
  });
});

describe("the node type a project gets", () => {
  it("reproduces Nx's rule, including the -e2e suffix that outranks 'application'", () => {
    // Reproducing Nx's convention is what keeps this safe over an unfamiliar
    // tree: it assumes a suffix Nx defines, never a tag vocabulary or a name
    // this workspace happens to use (`../../AGENTS.md`).
    expect(nodeTypeOf("thing", "library")).toBe("lib");
    expect(nodeTypeOf("thing", "application")).toBe("app");
    expect(nodeTypeOf("thing-e2e", "application")).toBe("e2e");
    expect(nodeTypeOf("e2e", "application")).toBe("e2e");
    expect(nodeTypeOf("thing-e2e", "library")).toBe("lib");
  });

  it("falls back to lib for a project that states no type, which is the safe direction", () => {
    // `lib` is the only type with no blanket import ban. A wrong `app` here
    // would fire `noImportsOfApps` on every import of the project.
    expect(nodeTypeOf("thing", undefined)).toBe("lib");
  });

  it("guarantees a tags array, because the tag rules read it unguarded", () => {
    const nodes = buildNodes([
      { name: "untagged", root: "libs/untagged", config: {} },
      { name: "tagged", root: "libs/tagged", config: { tags: ["zone:inner"] } },
    ]);

    expect(nodes.untagged.data.tags).toEqual([]);
    expect(nodes.tagged.data.tags).toEqual(["zone:inner"]);
    expect(nodes.untagged.data.root).toBe("libs/untagged");
  });
});

describe("the dependency edges the graph carries", () => {
  const nodes = buildNodes([
    { name: "inner", root: "libs/inner", config: { implicitDependencies: ["outer", "!ghost"] } },
    { name: "outer", root: "libs/outer", config: {} },
  ]);
  const projectOf = (file) => (file.startsWith("libs/inner") ? "inner" : "outer");

  it("keeps a dynamic import a dynamic edge, because one rule turns on exactly that", () => {
    // `noImportsOfLazyLoadedLibraries` is decided on whether ANY path to the
    // target is dynamic. Flattening every edge to `static` would disarm it.
    const dependencies = buildDependencies({
      importSites: [
        { sourceFile: "libs/inner/a.ts", kind: "dynamic", resolved: { target: "outer" } },
      ],
      nodes,
      projectOf,
    });

    expect(dependencies.inner).toContainEqual({
      source: "inner",
      target: "outer",
      type: "dynamic",
    });
  });

  it("drops a self-edge and an edge to a project the graph does not contain", () => {
    const dependencies = buildDependencies({
      importSites: [
        { sourceFile: "libs/inner/a.ts", kind: "static", resolved: { target: "inner" } },
        { sourceFile: "libs/inner/b.ts", kind: "static", resolved: { target: "ghost" } },
        { sourceFile: "libs/inner/c.ts", kind: "static", resolved: null },
      ],
      nodes,
      projectOf,
    });

    expect(dependencies.inner ?? []).not.toContainEqual(
      expect.objectContaining({ target: "inner" }),
    );
    expect(dependencies.inner ?? []).not.toContainEqual(
      expect.objectContaining({ target: "ghost" }),
    );
  });

  it("expands implicitDependencies through the matcher the constraints use", () => {
    // A pattern that resolves one way for a constraint row and another way here
    // would make the same project name mean two different sets in one run.
    const dependencies = buildDependencies({ importSites: [], nodes, projectOf });

    expect(dependencies.inner).toEqual([{ source: "inner", target: "outer", type: "implicit" }]);
  });
});

describe("building the index over a whole tree", () => {
  const files = {
    [`libs/inner/${PROJECT_CONFIG_FILE}`]: '{"name":"inner","tags":["zone:inner"]}',
    "libs/inner/main.go": "package inner\n",
    [`libs/inner/nested/${PROJECT_CONFIG_FILE}`]: '{"name":"nested"}',
    "libs/inner/nested/main.go": "package nested\n",
    "README.md": "# not a source file\n",
  };
  const options = {
    root: "/fixture",
    listFiles: () => Object.keys(files),
    readFileAt: (_root, path) => files[path] ?? null,
  };

  it("attributes a file to the innermost project that contains it", () => {
    // Longest root wins. A first-match answer would hand every file of the
    // nested project to its parent: every intra-project import would read as a
    // boundary crossing, and every real crossing would vanish into the parent.
    const index = buildWorkspaceIndex(options);

    expect(index.workspace.filesOf("nested")).toContain("libs/inner/nested/main.go");
    expect(index.workspace.filesOf("inner")).not.toContain("libs/inner/nested/main.go");
  });

  it("hands every analysis the same workspace object, so per-tree work happens once", () => {
    // `../analysis/source-util.mjs` caches per-workspace on OBJECT IDENTITY. A
    // fresh object per file would re-read every manifest in the tree per file.
    analyzeFile.mockClear();
    const index = buildWorkspaceIndex(options);
    const seen = new Set(analyzeFile.mock.calls.map(([request]) => request.workspace));

    expect(analyzeFile).toHaveBeenCalledTimes(2); // the two .go files, not README.md
    expect(seen.size).toBe(1);
    expect([...seen][0]).toBe(index.workspace);
  });

  it("records an analyzer that throws instead of letting it cost the whole graph", () => {
    // `analyzeFile` throws for a language whose analyzer is not written yet.
    // One such language must not blank nineteen projects' worth of edges; the
    // document-level diagnosis re-analyzes the open file and shows the throw
    // where a reader will see it.
    analyzeFile.mockImplementationOnce(() => {
      throw new Error("no elvish import analyzer is implemented yet");
    });
    const index = buildWorkspaceIndex(options);

    // The record is `../analysis/source-util.mjs`'s whole-file `fileFailure`
    // shape — `line`/`column` null is what makes the failure render as a
    // whole-file range rather than as a caret on one line.
    expect(index.fileFailures).toEqual([
      {
        sourceFile: expect.stringContaining(".go"),
        line: null,
        column: null,
        reason: expect.stringContaining("elvish"),
      },
    ]);
    expect(Object.keys(index.graph.nodes).sort()).toEqual(["inner", "nested"]);
  });

  it("records a thrown string from an analyzer the same way, without crashing", () => {
    // A thrown string carries no `message`; the `String(cause)` fallback must
    // still land in the recorded failure.
    analyzeFile.mockImplementationOnce(() => {
      throw "no elvish import analyzer is implemented yet";
    });
    const index = buildWorkspaceIndex(options);

    expect(index.fileFailures[0].reason).toContain("no elvish import analyzer");
  });

  it("records a file that is listed but cannot be read, instead of analyzing an empty string", () => {
    // A file git listed but the reader cannot produce (deleted between the two)
    // was not analyzed — recording the gap is what keeps the verdict honest.
    const withGone = {
      ...options,
      listFiles: () => [...Object.keys(files), "libs/inner/gone.go"],
    };
    const index = buildWorkspaceIndex(withGone);

    expect(index.fileFailures).toEqual([
      { sourceFile: "libs/inner/gone.go", line: null, column: null, reason: "could not be read" },
    ]);
  });

  it("keeps a positioned failure out of the index gaps, where it would over-warn", () => {
    // A failure carrying a line/column is one unparseable SITE, not a file the
    // index lost: the analyzer's other import sites for that file are still in
    // the graph, so the tree is not INCOMPLETE for every open document the way
    // a whole-file failure makes it. Same split the CLI draws (`check`'s
    // `blindSpots` vs `notAnalyzed`); the site fact surfaces at the failing
    // file's own document level instead.
    analyzeFile.mockReturnValueOnce({
      imports: [],
      failures: [{ sourceFile: "libs/inner/main.go", line: 2, column: 8, reason: "boom" }],
    });
    const index = buildWorkspaceIndex(options);

    expect(index.fileFailures).toEqual([]);
    expect(index.graph.dependencies).toEqual({});
  });

  it("fails loudly when the file list cannot be obtained, rather than indexing nothing", () => {
    // An index built from no files puts every file in no project, and a file in
    // no project has no boundary to cross. That is a clean report produced by
    // not looking — the one outcome this server exists to make impossible.
    expect(() =>
      buildWorkspaceIndex({
        ...options,
        listFiles: () => {
          throw new Error("not a git repository");
        },
      }),
    ).toThrow(/not a git repository/u);
  });

  it("makes a project literally named __proto__ a first-class graph node", () => {
    // G-01: `buildNodes` keyed by project NAME, and names come from
    // attacker-controlled `project.json`s. A plain `{}` answered
    // `nodes["__proto__"] = …` by repointing the object's OWN prototype, so
    // the project vanished from `graph.nodes` while `filesOf` still attributed
    // it files — a real cross-project import into it then produced
    // `adjList[current].filter is not a function` (or a silent non-verdict)
    // instead of a boundary diagnostic. The null-prototype map makes the name
    // behave like every other: present, own, enumerable.
    const withProto = {
      [`libs/child/${PROJECT_CONFIG_FILE}`]: '{"name":"child","tags":["scope:child"]}',
      "libs/child/main.go": "package child\n",
      [`libs/__proto__/${PROJECT_CONFIG_FILE}`]: '{"name":"__proto__","tags":["scope:shared"]}',
      "libs/__proto__/s.go": "package proto\n",
    };
    analyzeFile.mockImplementation(({ sourceFile }) =>
      sourceFile === "libs/child/main.go"
        ? {
            imports: [
              {
                sourceFile,
                line: 2,
                column: 1,
                specifier: "libs/shared",
                spelling: { path: false, relative: false },
                kind: "static",
                resolved: { target: "__proto__", file: null, external: false, packageName: null },
              },
            ],
            failures: [],
          }
        : { imports: [], failures: [] },
    );
    const index = buildWorkspaceIndex({
      root: "/fixture",
      listFiles: () => Object.keys(withProto),
      readFileAt: (_root, path) => withProto[path] ?? null,
    });
    analyzeFile.mockImplementation(() => ({ imports: [], failures: [] }));

    expect(Object.keys(index.graph.nodes)).toContain("__proto__");
    expect(index.graph.nodes.__proto__.data.tags).toEqual(["scope:shared"]);
    expect(index.workspace.filesOf("__proto__")).toContain("libs/__proto__/s.go");
    // The import edge from the sibling into `__proto__` is recorded, so a rule
    // engine run can judge it. With the old `{}` map the node was absent AND
    // its own reachability key vanished — the edge led nowhere and the verdict
    // flipped or threw instead.
    expect(index.graph.dependencies.child).toContainEqual({
      source: "child",
      target: "__proto__",
      type: "static",
    });
  });
});

describe("nx.json's workspaceLayout reaching the rule engine (Nx-shaped branch)", () => {
  // `readLayout` is injected here rather than driven through `readFileAt`,
  // the same way `../providers/nx.mjs`'s `readProjectGraph` takes an injected
  // `readLayout` rather than routing through its own `readFile` — the real
  // default (`../options.mjs`'s `readWorkspaceLayout`) reads an ABSOLUTE
  // `${root}/nx.json` path, while this suite's `readFileAt` fixtures are keyed
  // by workspace-relative path; the two conventions do not compose, so a test
  // that wants a specific declared/absent/malformed layout states it directly.
  const files = {
    [`libs/inner/${PROJECT_CONFIG_FILE}`]: '{"name":"inner","tags":["zone:inner"]}',
    "libs/inner/main.go": "package inner\n",
  };
  const baseOptions = {
    root: "/fixture",
    listFiles: () => Object.keys(files),
    readFileAt: (_root, path) => files[path] ?? null,
  };

  it("carries a declared, complete layout onto the graph", () => {
    // S12: a tree whose nx.json declares a non-default layout must judge
    // `noRelativeOrAbsoluteImportsAcrossLibraries` against THAT layout — the
    // breaking fix this chunk exists to ship (issue #31).
    const declared = { appsDir: "applications", libsDir: "packages" };
    const index = buildWorkspaceIndex({ ...baseOptions, readLayout: () => declared });

    expect(index.graph.workspaceLayout).toEqual(declared);
    expect(index.workspaceLayoutFailure).toBeNull();
  });

  it("leaves workspaceLayout absent from the graph when nx.json declares none", () => {
    // Silent direction guarded: an always-present defaulted object here would
    // make every Nx tree read as having declared a layout, hiding the very
    // declared-vs-undeclared distinction `../rules/index.mjs`'s
    // `graph.workspaceLayout ?? DEFAULT_WORKSPACE_LAYOUT` fallback exists for.
    const index = buildWorkspaceIndex({ ...baseOptions, readLayout: () => null });

    expect("workspaceLayout" in index.graph).toBe(false);
    expect(index.workspaceLayoutFailure).toBeNull();
  });

  // S13: a malformed or partial declaration becomes a named, self-clearing
  // index gap — never a silent fall-through to the default layout, and never
  // a throw that blanks the whole index over one bad key in nx.json.
  it("turns a malformed workspaceLayout into a named gap, not a thrown index build", () => {
    const index = buildWorkspaceIndex({
      ...baseOptions,
      readLayout: () => {
        throw new Error("lattice: nx.json's workspaceLayout must be an object, got string");
      },
    });

    expect("workspaceLayout" in index.graph).toBe(false);
    expect(index.workspaceLayoutFailure).toContain("workspaceLayout must be an object");
    // The index otherwise built normally: the gap did not cost the project.
    expect(Object.keys(index.graph.nodes)).toEqual(["inner"]);
  });

  it("turns a partial workspaceLayout into the same named gap, never a silently completed one", () => {
    // Parity refusal (`../options.mjs`'s `requireCompleteWorkspaceLayout`):
    // completing the missing key here would let this branch disagree with
    // `../providers/native/model.mjs`'s identical refusal for `lattice.json`.
    const index = buildWorkspaceIndex({
      ...baseOptions,
      readLayout: () => ({ libsDir: "packages" }),
    });

    expect("workspaceLayout" in index.graph).toBe(false);
    expect(index.workspaceLayoutFailure).toContain(
      "workspaceLayout declares libsDir but is missing appsDir",
    );
  });

  it("records a readLayout failure that is not an Error the same way", () => {
    // The thrown shape is whatever the layout reader chose; the gap must be
    // built from it either way.
    const index = buildWorkspaceIndex({
      ...baseOptions,
      readLayout: () => {
        throw "nx.json exploded";
      },
    });

    expect(index.workspaceLayoutFailure).toBe("nx.json exploded");
  });
});

describe("the Module Federation fact the app-import exemption turns on", () => {
  // `data.mfeRemote` fails closed in the rule engine (`../rules/topology.mjs`),
  // so an index that never wrote it would flag every import of a real remote as
  // `noImportsOfApps` — noise upstream ESLint does not produce. The predicate
  // itself is `../workspace.mjs`'s, shared with the CLI path so the two
  // adapters cannot answer differently about the same app.
  const files = {
    [`apps/widgets/${PROJECT_CONFIG_FILE}`]: '{"name":"widgets","projectType":"application"}',
    "apps/widgets/module-federation.config.js":
      "module.exports = { exposes: { './Widget': './src/widget' } };\n",
    [`apps/portal/${PROJECT_CONFIG_FILE}`]: '{"name":"portal","projectType":"application"}',
    // The near-identical host: a config that names remotes and exposes nothing.
    "apps/portal/module-federation.config.js": "module.exports = { remotes: ['widgets'] };\n",
    [`libs/plain/${PROJECT_CONFIG_FILE}`]: '{"name":"plain","projectType":"library"}',
  };
  const index = buildWorkspaceIndex({
    root: "/fixture",
    listFiles: () => Object.keys(files),
    readFileAt: (_root, path) => files[path] ?? null,
  });

  it("marks the app that exposes a remote, so the exemption can fire", () => {
    expect(index.graph.nodes.widgets.data.mfeRemote).toBe(true);
  });

  it("marks the near-identical app that exposes nothing as NOT a remote", () => {
    // The silent direction: `true` here would waive a real `noImportsOfApps`
    // and the editor would paint the import clean, exactly like upstream never
    // would.
    expect(index.graph.nodes.portal.data.mfeRemote).toBe(false);
  });

  it("leaves the fact off libraries, whose imports the app ban never judges", () => {
    expect(index.graph.nodes.plain.data).not.toHaveProperty("mfeRemote");
  });
});

describe("the two package.json facts the entry-point and transitive rules turn on", () => {
  // `data.entryPoints` and `data.declaredPackages` fail closed in the rule
  // engine (`../rules/topology.mjs`), so an index that never wrote them would
  // report a self-import of a real secondary entry point and, with
  // `banTransitiveDependencies` on, every declared external package. The
  // functions are `../workspace.mjs`'s, shared with the CLI path so the two
  // adapters cannot answer differently about the same import.
  const files = {
    "package.json": '{"dependencies":{"root-dep":"^1.0.0"}}',
    [`libs/gadgets/${PROJECT_CONFIG_FILE}`]: '{"name":"gadgets"}',
    "libs/gadgets/package.json":
      '{"dependencies":{"local-dep":"^2.0.0"},"exports":{"./models":"./src/models.ts"}}',
    [`libs/bare/${PROJECT_CONFIG_FILE}`]: '{"name":"bare"}',
    // A project whose config smuggles both fields in: `buildNodes` spreads
    // project.json into `data` verbatim, so without the annotator's delete
    // these unmeasured claims would ride onto the graph and waive violations.
    [`libs/stale/${PROJECT_CONFIG_FILE}`]:
      '{"name":"stale","entryPoints":[{"path":"libs/stale/x","file":"libs/stale/x.ts"}],' +
      '"declaredPackages":["waived-package"]}',
  };
  const index = buildWorkspaceIndex({
    root: "/fixture",
    listFiles: () => Object.keys(files),
    readFileAt: (_root, path) => files[path] ?? null,
  });

  it("writes the entry points a project's own manifest declares", () => {
    expect(index.graph.nodes.gadgets.data.entryPoints).toEqual([
      { path: "libs/gadgets/models", file: "libs/gadgets/src/models.ts" },
    ]);
  });

  it("unions the root manifest into every project's declared packages", () => {
    expect(index.graph.nodes.gadgets.data.declaredPackages).toEqual(["root-dep", "local-dep"]);
    expect(index.graph.nodes.bare.data.declaredPackages).toEqual(["root-dep"]);
  });

  it("keeps entryPoints absent on a project with no manifest of its own", () => {
    // Only the project's own package.json can declare entry points; absent
    // stays absent, and absence fails closed downstream.
    expect(index.graph.nodes.bare.data).not.toHaveProperty("entryPoints");
  });

  it("overrides both fields a project.json smuggled in unmeasured — the silent direction", () => {
    // The unmeasurable one is deleted; the measurable one is replaced by the
    // measurement. Either way the config's claim — which would have waived
    // violations nobody checked — never reaches the rule engine.
    expect(index.graph.nodes.stale.data).not.toHaveProperty("entryPoints");
    expect(index.graph.nodes.stale.data.declaredPackages).toEqual(["root-dep"]);
  });
});

describe("the Moon branch buildWorkspaceIndex takes for a .moon root", () => {
  // The unit tier: the marker test and the graph reader are injected, so what
  // is pinned is this module's own decision — WHICH dispatch a `.moon` root
  // takes, and what its failure looks like. The real-tree tier next door
  // (`./workspace-index.integration.test.mjs`) drives git and the Go analyzer
  // for real over the same branch.
  const moonFiles = {
    ".moon/workspace.yml": "projects:\n",
    "libs/x/x.go": "package x\n",
    "libs/y/y.go": "package y\n",
  };
  const moonNodes = {
    x: {
      name: "x",
      type: "lib",
      data: { root: "libs/x", tags: ["zone:x"], implicitDependencies: [] },
    },
    y: {
      name: "y",
      type: "lib",
      data: { root: "libs/y", tags: ["zone:y"], implicitDependencies: [] },
    },
  };
  const base = (over = {}) => ({
    root: "/fixture",
    listFiles: () => Object.keys(moonFiles),
    readFileAt: (_root, path) => moonFiles[path] ?? null,
    pathExists: (path) => path === join("/fixture", ".moon"),
    readGraph: () => ({ nodes: structuredClone(moonNodes), dependencies: {} }),
    ...over,
  });
  /**
   * An import site in `x` resolving into `y`, in the analysis contract's
   * shape (`../analysis/analyze.mjs`'s `ImportSite` — annotated so the
   * literal's `kind` stays a `kind`, not an anonymous string).
   *
   * @returns {import("../analysis/analyze.mjs").ImportSite}
   */
  const importFromX = () => ({
    sourceFile: "libs/x/x.go",
    line: 1,
    column: 1,
    specifier: "example.test/y",
    spelling: { path: false, relative: false },
    kind: "static",
    resolved: { target: "y", file: null, external: false, packageName: null },
  });

  it("populates the index through the provider seam instead of falling through to zero nodes", () => {
    // The red direction (#223): before the Moon branch, this root reached
    // `discoverProjects`, which finds a project only by its `project.json` —
    // a file no Moon workspace has — so `graph.nodes` was `{}`, every import
    // resolved as external, and the editor published clean while
    // `../../cli.mjs check` exited 1 on the same tree.
    analyzeFile.mockImplementation(({ sourceFile }) =>
      sourceFile === "libs/x/x.go"
        ? { imports: [importFromX()], failures: [] }
        : { imports: [], failures: [] },
    );
    let askedRoot = null;
    const index = buildWorkspaceIndex(
      base({
        readGraph: (root) => {
          askedRoot = root;
          return { nodes: structuredClone(moonNodes), dependencies: {} };
        },
      }),
    );
    analyzeFile.mockImplementation(() => ({ imports: [], failures: [] }));

    expect(askedRoot).toBe("/fixture");
    expect(Object.keys(index.graph.nodes).sort()).toEqual(["x", "y"]);
    // The import-derived edge — Moon's own declared-only graph carries none:
    expect(index.graph.dependencies.x).toContainEqual({
      source: "x",
      target: "y",
      type: "static",
    });
    expect(index.nativeMarker).toBe(false);
    expect(index.moonModelFailure).toBeNull();
    expect(indexGaps(index)).toEqual([]);
  });

  it("merges import edges onto the declared ones by the same rule the CLI's Moon branch uses", () => {
    // A declared static edge plus an import-derived dynamic one are two
    // records for one pair that differ in kind — exactly what
    // `../providers/moon.mjs`'s `mergeImportEdges` keeps both of. A second
    // copy of the SAME record adds nothing.
    analyzeFile.mockImplementation(({ sourceFile }) =>
      sourceFile === "libs/x/x.go"
        ? {
            imports: [importFromX(), { ...importFromX(), kind: "dynamic" }],
            failures: [],
          }
        : { imports: [], failures: [] },
    );
    const index = buildWorkspaceIndex(
      base({
        readGraph: () => ({
          nodes: structuredClone(moonNodes),
          dependencies: { x: [{ source: "x", target: "y", type: "static" }] },
        }),
      }),
    );
    analyzeFile.mockImplementation(() => ({ imports: [], failures: [] }));

    expect(index.graph.dependencies.x).toEqual([
      { source: "x", target: "y", type: "static" },
      { source: "x", target: "y", type: "dynamic" },
    ]);
  });

  it("turns a failing provider invocation into a named gap, never a clean empty index", () => {
    // The other half of #223, and #226's LSP half: `moon project-graph`
    // failing leaves ZERO nodes, and a zero-node graph judges every file
    // clean — so the failure is recorded where `indexGaps` can say which
    // command failed, on an index that is otherwise a valid empty shape.
    const index = buildWorkspaceIndex(
      base({
        readGraph: () => {
          throw new Error(
            "lattice: `moon project-graph --json` failed in /fixture: spawn moon ENOENT",
          );
        },
      }),
    );

    expect(index.moonModelFailure).toContain("spawn moon ENOENT");
    expect(Object.keys(index.graph.nodes)).toEqual([]);
    const gaps = indexGaps(index);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain("`moon project-graph --json`");
    expect(gaps[0]).toContain("missing from the graph");
  });

  it("stays silent about a Moon root whose invocation succeeded", () => {
    // The normal case must produce NO gap entry, or the gap list means
    // nothing anywhere else.
    const index = buildWorkspaceIndex(base());
    expect(index.moonModelFailure).toBeNull();
    expect(indexGaps(index)).toEqual([]);
  });

  it("refuses a root carrying both .moon and .config/moon instead of picking one", () => {
    // #224 surfaced through the LSP shape: the same refusal the CLI makes,
    // from the same dispatcher (`../providers/moon.mjs`'s `moonMarkerAt`).
    // Thrown, not recorded — which config governs at all is refused the same
    // way an unreadable `nx.json` is, through this function's caller in
    // `./server.mjs`.
    expect(() =>
      buildWorkspaceIndex(base({ pathExists: (path) => path.startsWith("/fixture/") })),
    ).toThrow(/declares both \.moon and \.config\/moon/u);
  });
});

describe("marker conflicts buildWorkspaceIndex refuses exactly like check does", () => {
  // One gate (`../commands/context.mjs`'s `requireSingleProjectModel`) serves
  // both faces; these drive it through the index build over a root whose
  // markers disagree, with every existence answer injected.
  const withMarkers = (...names) => {
    const present = new Set(names.map((name) => join("/fixture", name)));
    return (path) => present.has(path);
  };

  it("refuses .moon beside lattice.json instead of indexing nothing, silently", () => {
    // Red direction: before the shared gate, `readFile(lattice.json) !== null`
    // won the dispatch and the native branch ran — over a tree whose projects
    // (if any) it could not see, here a zero-node index with no gap entry,
    // published as analyzed-and-clean on a tree `lattice check` REFUSES with
    // exit 3. The CLI refused; the editor said nothing at all.
    expect(() =>
      buildWorkspaceIndex({
        root: "/fixture",
        listFiles: () => [],
        readFileAt: () => null,
        pathExists: withMarkers(".moon", "lattice.json"),
      }),
    ).toThrow(/declares both \.moon and lattice\.json/u);
  });

  it("refuses .moon beside nx.json instead of building the Moon index beside it", () => {
    // Red direction: before the shared gate, the Moon arm took the tree and
    // built its graph from `moon project-graph`, never reading the `nx.json`
    // it sat beside — an editor judging boundaries on a tree the CLI refuses
    // to judge at all.
    expect(() =>
      buildWorkspaceIndex({
        root: "/fixture",
        listFiles: () => [],
        readFileAt: () => null,
        pathExists: withMarkers(".moon", "nx.json"),
      }),
    ).toThrow(/declares both \.moon and nx\.json/u);
  });

  it("refuses .config/moon beside nx.json, naming the alternative spelling", () => {
    // Same conflict through the v2 marker spelling — the message names the
    // directory that is actually there, not a hardcoded `.moon`.
    expect(() =>
      buildWorkspaceIndex({
        root: "/fixture",
        listFiles: () => [],
        readFileAt: () => null,
        pathExists: withMarkers(".config/moon", "nx.json"),
      }),
    ).toThrow(/declares both \.config\/moon and nx\.json/u);
  });
});

describe("what the index could not read, as something a caller can publish", () => {
  it("says nothing at all about a tree that was read whole", () => {
    // The property the whole design rests on: this must be silent in the normal
    // case, or the report it makes in the abnormal one is worth nothing.
    expect(indexGaps({ skippedProjects: [], fileFailures: [] })).toEqual([]);
    expect(indexGaps({})).toEqual([]);
  });

  it("names the dropped project and says what its absence costs", () => {
    // A project missing from the graph does not merely lose its own files: an
    // import of it resolves as an external package instead, and every edge that
    // pointed at it is dropped. Saying which file to fix is what makes the
    // report actionable rather than merely alarming.
    const gaps = indexGaps({
      skippedProjects: [
        { file: "libs/outer/project.json", reason: "is not valid JSON: InvalidSymbol at 1:3" },
      ],
    });

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain("libs/outer/project.json");
    expect(gaps[0]).toContain("missing from the graph");
  });

  it("names a file whose imports never reached the graph", () => {
    // Two of the fifteen rules are decided on the transitive closure
    // (`../rules/reachability.mjs`), so an edge that was never recorded can
    // hide a cycle or a tag violation several projects away from the file that
    // could not be read.
    const gaps = indexGaps({
      fileFailures: [{ sourceFile: "libs/inner/generated.go", reason: "could not be read" }],
    });

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain("libs/inner/generated.go");
    expect(gaps[0]).toContain("could not be read");
  });

  it("keeps a multi-line reason to its first line, which is the line that locates it", () => {
    // Nx's parse errors carry an ASCII code frame under their first line. The
    // location is already in that first line, and a diagnostic message that
    // opens a drawing mid-sentence reads as noise — which is the one thing a
    // report published on every open document cannot afford to be.
    const gaps = indexGaps({
      skippedProjects: [
        {
          file: "libs/outer/project.json",
          reason: "is not valid JSON: InvalidSymbol in JSON at 1:3\n> 1 | { nope\n    |   ^^^^\n",
        },
      ],
    });

    expect(gaps[0]).not.toContain("\n");
    expect(gaps[0]).toContain("InvalidSymbol in JSON at 1:3");
  });

  // S12: a `lattice.json` root is driven through `../providers/native/`'s own
  // `discover()`/`buildGraph()` (`buildNativeWorkspaceIndex` below this
  // module's header), so a project with no `project.json` of its own is NOT
  // invisible the way it would be to `discoverProjects`. What IS still a real
  // gap is `discover()` throwing — a malformed `lattice.json`, a declared root
  // with no tracked file under it, a `projectRules` row matching nothing — and
  // that is what `nativeModelFailure` reports. `nativeMarker` alone (a clean
  // native workspace) must stay silent, or every native workspace would read
  // as permanently incomplete whether or not anything was actually wrong.
  it("reports a gap for a lattice.json root whose model could not be built", () => {
    const gaps = indexGaps({
      skippedProjects: [],
      fileFailures: [],
      nativeModelFailure: "lattice.json: projects: this workspace describes zero projects",
    });

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain("lattice.json");
    expect(gaps[0]).toContain("missing from the graph");
  });

  it("stays silent for a native workspace whose model built without error", () => {
    // The regression this test guards: before `nativeModelFailure` existed,
    // `nativeMarker: true` alone drove the gap, so a clean native workspace
    // read as permanently incomplete. `nativeMarker` here is the descriptive
    // fact the full index object still carries alongside the three
    // `indexGaps` actually reads — routed through a variable, not an object
    // literal, so the extra field exercises the real call shape (the full
    // index) without tripping TypeScript's excess-property check on a
    // function that deliberately does not declare `nativeMarker` as a
    // parameter it reads.
    const index = {
      skippedProjects: [],
      fileFailures: [],
      nativeMarker: true,
      nativeModelFailure: null,
    };
    expect(indexGaps(index)).toEqual([]);
  });

  it("reports a gap when nx.json's workspaceLayout could not be turned into a layout", () => {
    // The Nx-shaped branch's own equivalent of `nativeModelFailure` — see
    // `buildWorkspaceIndex`'s merge of `../options.mjs`'s `readWorkspaceLayout`/
    // `requireCompleteWorkspaceLayout`. Silence here would read as "this
    // workspace uses the default apps/libs layout", which is the silent
    // direction on exactly the tree whose declaration could not be trusted.
    const gaps = indexGaps({
      skippedProjects: [],
      fileFailures: [],
      workspaceLayoutFailure:
        "lattice: nx.json's workspaceLayout declares libsDir but is missing appsDir",
    });

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain("nx.json");
    expect(gaps[0]).toContain("workspaceLayout");
    expect(gaps[0]).toContain("declares libsDir but is missing appsDir");
  });

  it("stays silent for a tree whose nx.json declares no workspaceLayout, or a complete one", () => {
    expect(indexGaps({ workspaceLayoutFailure: null })).toEqual([]);
  });
});

describe("the native branch buildWorkspaceIndex takes for a lattice.json root", () => {
  const files = {
    "lattice.json": '{"projects":{"declared":[{"root":"apps/a"}]}}',
    "apps/a/main.go": "package a\n",
  };
  const options = {
    root: "/fixture",
    listFiles: () => Object.keys(files),
    readFileAt: (_root, path) => files[path] ?? null,
  };

  // The red-direction case this whole mechanism exists for: `apps/a` is
  // declared in `lattice.json` and has no `project.json`. Before this module
  // drove `../providers/native/discover.mjs` directly, `discoverProjects`
  // found ZERO projects here — a tree this server could not actually see the
  // shape of, not a tree with nothing in it — and the index looked identical
  // to a clean, empty workspace. Now the declared project IS discovered
  // (named `a`, Nx's own directory-basename fallback — no `project.json`, no
  // `package.json`), and the gap list is empty because there was nothing to
  // fail on.
  it("discovers a declared project with no project.json, and reports no gap for it", () => {
    const index = buildWorkspaceIndex(options);

    expect(index.nativeMarker).toBe(true);
    expect(index.nativeModelFailure).toBeNull();
    expect(Object.keys(index.graph.nodes)).toEqual(["a"]);
    expect(indexGaps(index)).toEqual([]);
  });

  it("catches a discover() throw into nativeModelFailure instead of the whole session", () => {
    // Malformed JSON — `loadNativeModel` throws before `discoverNativeProjects`
    // ever runs. The index this returns must still be a valid, empty shape a
    // caller can iterate over, not a missing one: the point of catching this at
    // all is that one broken `lattice.json` must not blank the server.
    const brokenFiles = { "lattice.json": "{ not json" };
    const index = buildWorkspaceIndex({
      root: "/fixture",
      listFiles: () => Object.keys(brokenFiles),
      readFileAt: (_root, path) => brokenFiles[path] ?? null,
    });

    expect(index.nativeMarker).toBe(true);
    expect(index.nativeModelFailure).toContain("lattice.json");
    expect(Object.keys(index.graph.nodes)).toEqual([]);
    expect(indexGaps(index)).toHaveLength(1);
    expect(indexGaps(index)[0]).toContain("lattice.json");
  });

  it("catches a stale coverage.exempt row into nativeModelFailure, never a silently empty index", () => {
    // A waiver naming a file nothing unclaimed matches is a real defect in
    // `lattice.json` — the covered file is owned by a project now, or the path
    // was never right — and discover() refusing it loudly is what keeps a raw
    // index from publishing verdicts computed against a tree it never fully
    // read.
    const staleFiles = {
      "lattice.json": JSON.stringify({
        projects: { declared: [{ root: "apps/a" }] },
        coverage: {
          exempt: [{ path: "scripts/*.py", reason: "generated, reviewed at codegen time" }],
        },
      }),
      "apps/a/main.go": "package a\n",
    };
    const index = buildWorkspaceIndex({
      root: "/fixture",
      listFiles: () => Object.keys(staleFiles),
      readFileAt: (_root, path) => staleFiles[path] ?? null,
    });

    expect(index.nativeMarker).toBe(true);
    expect(index.nativeModelFailure).toContain("coverage.exempt");
    expect(indexGaps(index)).toHaveLength(1);
  });

  it("dispatches natively for an untracked lattice.json, agreeing with the CLI's existsSync gate", () => {
    // S-bug C, unit tier: `listFiles` here stands in for git's TRACKED list —
    // `lattice.json` is deliberately absent from it — while `readFileAt` stands
    // in for the real filesystem, where the file DOES exist. The old gate,
    // `files.includes(LATTICE_MODEL_FILE)`, only ever consulted the tracked
    // list and fell through to `discoverProjects`, which finds nothing for a
    // native-only tree with no `project.json`: a zero-node index reads clean
    // on a tree `../../cli.mjs check`'s `existsSync`-based `markersAt`
    // (`../commands/context.mjs`) dispatches to the native provider and finds
    // a real violation in. The red direction: with the old gate,
    // `index.nativeMarker` here is `false` and `graph.nodes` is `{}`.
    const trackedFiles = { "apps/a/main.go": "package a\n" };
    const onDisk = {
      ...trackedFiles,
      "lattice.json": '{"projects":{"declared":[{"root":"apps/a"}]}}',
    };
    const index = buildWorkspaceIndex({
      root: "/fixture",
      listFiles: () => Object.keys(trackedFiles),
      readFileAt: (_root, path) => onDisk[path] ?? null,
    });

    expect(index.nativeMarker).toBe(true);
    expect(index.nativeModelFailure).toBeNull();
    expect(Object.keys(index.graph.nodes)).toEqual(["a"]);
    expect(indexGaps(index)).toEqual([]);
  });

  it("leaves nativeMarker false for a tree with no lattice.json at its root", () => {
    const index = buildWorkspaceIndex({
      root: "/fixture",
      listFiles: () => ["apps/a/main.go"],
      readFileAt: (_root, path) => (path === "apps/a/main.go" ? "package a\n" : null),
    });

    expect(index.nativeMarker).toBe(false);
    expect(index.nativeModelFailure).toBeNull();
    expect(indexGaps(index)).toEqual([]);
  });
});
