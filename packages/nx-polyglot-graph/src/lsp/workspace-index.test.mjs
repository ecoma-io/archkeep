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
vi.mock("../rules/match.mjs", () => ({
  findMatchingProjects: (patterns) => patterns.filter((p) => !p.startsWith("!")),
}));

const { analyzeFile } = await import("../analysis/analyze.mjs");

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
});

describe("the node type a project gets", () => {
  it("reproduces Nx's rule, including the -e2e suffix that outranks 'application'", () => {
    // Reproducing Nx's convention is what keeps this safe over an unfamiliar
    // tree: it assumes a suffix Nx defines, never a tag vocabulary or a name
    // this workspace happens to use (`../../CLAUDE.md`).
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

    expect(index.fileFailures).toEqual([
      { sourceFile: expect.stringContaining(".go"), reason: expect.stringContaining("elvish") },
    ]);
    expect(Object.keys(index.graph.nodes).sort()).toEqual(["inner", "nested"]);
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
});
