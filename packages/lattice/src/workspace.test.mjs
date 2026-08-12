import { describe, expect, it, vi } from "vitest";

// Both analysis collaborators are faked so this file pins the SCAN's own
// decisions — which files are read, what a read failure becomes, what a scope
// argument selects — rather than any analyzer's behaviour.
// `workspace.integration.test.mjs` drives the real ones.
vi.mock("./analysis/analyze.mjs", () => ({
  analyzeFile: () => ({ imports: [], failures: [] }),
  languageOf: (path) => (path.endsWith(".go") ? "go" : null),
}));
vi.mock("./analysis/source-util.mjs", () => ({
  projectOwning: (projects, path) =>
    projects.find((project) => path.startsWith(`${project.root}/`)) ?? null,
  fileFailure: (sourceFile, reason) => ({ sourceFile, line: null, column: null, reason }),
}));

import {
  analyzeWorkspace,
  annotateMFERemotes,
  annotatePackageFacts,
  createWorkspace,
  declaredPackages,
  listTrackedFiles,
  packageEntryPoints,
  projectIsMFERemote,
  runProcess,
  selectFiles,
} from "./workspace.mjs";

const graph = {
  nodes: {
    alpha: { name: "alpha", type: "lib", data: { root: "libs/alpha" } },
    beta: { name: "beta", type: "lib", data: { root: "libs/beta" } },
  },
};

describe("building the workspace", () => {
  it("keeps only the files a project owns, since a file in none can produce no verdict", () => {
    // The rule engine returns nothing for a file outside every project, so
    // reading and analyzing one buys a verdict that cannot exist.
    const { owned } = createWorkspace({
      root: "/w",
      graph,
      files: ["libs/alpha/a.go", "README.md", "libs/beta/b.go"],
      read: () => "",
    });
    expect(owned.map(({ file }) => file)).toEqual(["libs/alpha/a.go", "libs/beta/b.go"]);
  });

  it("answers filesOf per project, which is what an analyzer's resolution is driven from", () => {
    const { workspace } = createWorkspace({
      root: "/w",
      graph,
      files: ["libs/alpha/a.go", "libs/alpha/go.mod", "libs/beta/b.go"],
      read: () => "",
    });
    expect(workspace.filesOf("alpha")).toEqual(["libs/alpha/a.go", "libs/alpha/go.mod"]);
    expect(workspace.filesOf("beta")).toEqual(["libs/beta/b.go"]);
  });

  it("returns an empty list for a project with no files, never undefined", () => {
    // The analysis contract lets an analyzer iterate `filesOf` without checking.
    const { workspace } = createWorkspace({ root: "/w", graph, files: [], read: () => "" });
    expect(workspace.filesOf("alpha")).toEqual([]);
    expect(workspace.filesOf("nonexistent")).toEqual([]);
  });
});

describe("marking Module Federation remotes", () => {
  const appNode = (name, root) => ({ name, type: "app", data: { root } });
  const readerOf = (files) => (path) => files[path] ?? null;

  const EXPOSING = "module.exports = { exposes: { './Widget': './src/widget' } };\n";
  // A host: the near-identical config that names remotes and exposes nothing.
  const HOSTING = "module.exports = { remotes: ['elsewhere'] };\n";

  it("marks an app whose config carries an exposes key, which is what lets the exemption fire", () => {
    const nodes = { widgets: appNode("widgets", "apps/widgets") };
    annotateMFERemotes(nodes, readerOf({ "apps/widgets/module-federation.config.js": EXPOSING }));
    expect(nodes.widgets.data.mfeRemote).toBe(true);
  });

  it("marks a near-identical app whose config exposes nothing as NOT a remote", () => {
    // The silent direction. A `true` here would waive `noImportsOfApps` for an
    // app that is not importable, and a waived violation looks exactly like a
    // clean import — upstream reports this app, so this tool must too.
    const nodes = { portal: appNode("portal", "apps/portal") };
    annotateMFERemotes(nodes, readerOf({ "apps/portal/module-federation.config.js": HOSTING }));
    expect(nodes.portal.data.mfeRemote).toBe(false);
  });

  it("marks an app with no module-federation config at all as NOT a remote", () => {
    const nodes = { plain: appNode("plain", "apps/plain") };
    annotateMFERemotes(nodes, readerOf({}));
    expect(nodes.plain.data.mfeRemote).toBe(false);
  });

  it("falls back to the .ts spelling when the .js one is absent — or empty, upstream's own quirk", () => {
    // Upstream's `readFileIfExisting` answers '' for a missing file, and the
    // `||` between its two reads cannot tell an empty `.js` from an absent one.
    // Reproduced rather than repaired, so the two enforcers give one answer.
    expect(
      projectIsMFERemote("apps/a", readerOf({ "apps/a/module-federation.config.ts": EXPOSING })),
    ).toBe(true);
    expect(
      projectIsMFERemote(
        "apps/a",
        readerOf({
          "apps/a/module-federation.config.js": "",
          "apps/a/module-federation.config.ts": EXPOSING,
        }),
      ),
    ).toBe(true);
  });

  it("matches the key quoted, the way upstream's pattern is written", () => {
    expect(
      projectIsMFERemote(
        "apps/a",
        readerOf({ "apps/a/module-federation.config.js": "export default { 'exposes': {} };\n" }),
      ),
    ).toBe(true);
  });

  it("reads nothing for a library or an e2e suite, the kinds the app ban never names", () => {
    // Only `type === "app"` reaches the exemption (`rules/index.mjs`), and two
    // candidate reads per library would scale the scan with the tree's size.
    const read = vi.fn(() => null);
    const nodes = {
      util: { name: "util", type: "lib", data: { root: "libs/util" } },
      "util-e2e": { name: "util-e2e", type: "e2e", data: { root: "apps/util-e2e" } },
    };
    annotateMFERemotes(nodes, read);
    expect(read).not.toHaveBeenCalled();
    expect(nodes.util.data).not.toHaveProperty("mfeRemote");
  });

  it("finds the config of an app at the workspace root under both spellings of that root", () => {
    // The LSP index writes `''` for the tree root; `nx graph --file=` writes
    // `'.'`. Both must name `module-federation.config.js` and not `./…` or
    // `/…`, which an in-memory reader keyed by exact path would answer null for.
    const files = readerOf({ "module-federation.config.js": EXPOSING });
    expect(projectIsMFERemote("", files)).toBe(true);
    expect(projectIsMFERemote(".", files)).toBe(true);
  });
});

describe("reading a project's entry points from its package.json exports", () => {
  const readerOf = (files) => (path) => files[path] ?? null;
  const manifest = (exports) => JSON.stringify({ name: "gadgets", exports });

  it("answers null — not [] — when the manifest is absent, so the graph field stays absent", () => {
    // The silent-direction distinction this function exists to keep: `[]` is
    // "measured, no secondary entry points" and travels onto the node, where it
    // is a CLAIM; only null keeps the field absent and failing closed.
    expect(packageEntryPoints("libs/gadgets", readerOf({}))).toBe(null);
  });

  it("treats an existing-but-empty manifest as absent, upstream's readFileIfExisting quirk", () => {
    expect(packageEntryPoints("libs/gadgets", readerOf({ "libs/gadgets/package.json": "" }))).toBe(
      null,
    );
  });

  it("answers null for a manifest no parser reads, keeping the field absent rather than throwing", () => {
    // Named divergence: upstream's `parseJson` throws mid-lint here. Absence
    // over-reports — the loud direction — and a manifest is malformed for
    // exactly as long as someone is typing inside it.
    expect(
      packageEntryPoints("libs/gadgets", readerOf({ "libs/gadgets/package.json": "{ not json" })),
    ).toBe(null);
  });

  it("reads a manifest carrying the JSONC forms Nx accepts, the way upstream's parseJson does", () => {
    const text = `{\n  // the package\n  "exports": { "./models": "./src/models.ts", },\n}`;
    expect(
      packageEntryPoints("libs/gadgets", readerOf({ "libs/gadgets/package.json": text })),
    ).toEqual([{ path: "libs/gadgets/models", file: "libs/gadgets/src/models.ts" }]);
  });

  it("answers [] for a manifest with no exports map — measured, exactly what upstream answers", () => {
    expect(
      packageEntryPoints(
        "libs/gadgets",
        readerOf({ "libs/gadgets/package.json": JSON.stringify({ name: "gadgets" }) }),
      ),
    ).toEqual([]);
  });

  it("collects only SECONDARY entry points: a top-level string and the '.' key both yield nothing", () => {
    const read = (exports) =>
      packageEntryPoints(
        "libs/gadgets",
        readerOf({ "libs/gadgets/package.json": manifest(exports) }),
      );
    expect(read("./index.ts")).toEqual([]);
    expect(read({ ".": "./index.ts" })).toEqual([]);
  });

  it("builds {path, file} pairs the way upstream's parseExports joins them", () => {
    expect(
      packageEntryPoints(
        "libs/gadgets",
        readerOf({ "libs/gadgets/package.json": manifest({ "./models": "./src/models.ts" }) }),
      ),
    ).toEqual([{ path: "libs/gadgets/models", file: "libs/gadgets/src/models.ts" }]);
  });

  it("keeps a key's trailing slash — the one shape entryPointOf's walk can ever match", () => {
    // See `./conformance/README.md`, "`getEntryPoint`'s directory branch is
    // dead upstream" — corrected: the walk compares against `parent`, which
    // always carries a trailing slash, so this key shape is the live one.
    expect(
      packageEntryPoints(
        "libs/gadgets",
        readerOf({ "libs/gadgets/package.json": manifest({ "./models/": "./src/models/" }) }),
      ),
    ).toEqual([{ path: "libs/gadgets/models/", file: "libs/gadgets/src/models/" }]);
  });

  it("resolves a conditional-exports object as default||import||require||node — NOT the guard's order", () => {
    // Upstream detects the object by `import || require || default || node`
    // but picks by `default || import || require || node`. The orders differ,
    // so {import, default} follows `default`. Measured against 23.1.1;
    // reproduced, not repaired.
    expect(
      packageEntryPoints(
        "libs/gadgets",
        readerOf({
          "libs/gadgets/package.json": manifest({
            "./models": { import: "./esm/models.js", default: "./dist/models.js" },
          }),
        }),
      ),
    ).toEqual([{ path: "libs/gadgets/models", file: "libs/gadgets/dist/models.js" }]);
  });

  it("skips a conditional member declared falsy, since upstream's pick tests truthiness", () => {
    expect(
      packageEntryPoints(
        "libs/gadgets",
        readerOf({
          "libs/gadgets/package.json": manifest({
            "./models": { import: "", require: "./cjs/models.js" },
          }),
        }),
      ),
    ).toEqual([{ path: "libs/gadgets/models", file: "libs/gadgets/cjs/models.js" }]);
  });

  it("recurses into any other object per KEY, which discards the parent key — upstream's quirk", () => {
    // {"./sub": {"./deep": f}} yields `<root>/deep`, not `<root>/sub/deep`:
    // the recursion replaces basePath with each key rather than joining them.
    // A types-only object rides the same branch, making `<root>/types` a
    // "path". Both measured; both reproduced so the two enforcers walk the
    // same pairs.
    expect(
      packageEntryPoints(
        "libs/gadgets",
        readerOf({
          "libs/gadgets/package.json": manifest({
            "./sub": { "./deep": "./src/deep.ts" },
            "./typed": { types: "./typed.d.ts" },
          }),
        }),
      ),
    ).toEqual([
      { path: "libs/gadgets/deep", file: "libs/gadgets/src/deep.ts" },
      { path: "libs/gadgets/types", file: "libs/gadgets/typed.d.ts" },
    ]);
  });

  it("drops a null target and walks an array by index, as upstream does", () => {
    expect(
      packageEntryPoints(
        "libs/gadgets",
        readerOf({
          "libs/gadgets/package.json": manifest({
            "./gone": null,
            "./pair": ["./a.ts", "./b.ts"],
          }),
        }),
      ),
    ).toEqual([
      { path: "libs/gadgets/0", file: "libs/gadgets/a.ts" },
      { path: "libs/gadgets/1", file: "libs/gadgets/b.ts" },
    ]);
  });

  it("finds the manifest of a project at the workspace root under both spellings of that root", () => {
    // Same two spellings `projectIsMFERemote` handles: the LSP index writes
    // `''`, `nx graph --file=` writes `'.'`.
    const files = readerOf({ "package.json": manifest({ "./models": "./src/models.ts" }) });
    expect(packageEntryPoints("", files)).toEqual([{ path: "models", file: "src/models.ts" }]);
    expect(packageEntryPoints(".", files)).toEqual([{ path: "models", file: "src/models.ts" }]);
  });
});

describe("reading a project's declared packages from the two manifests upstream reads", () => {
  const readerOf = (files) => (path) => files[path] ?? null;

  it("unions the workspace root's manifest with the project's own, upstream's || of two lookups", () => {
    // `isDirectDependency` is `packageExistsInPackageJson(pkg, '.') ||
    // packageExistsInPackageJson(pkg, source.data.root)` — either manifest
    // alone is enough to make a package direct.
    expect(
      declaredPackages(
        "libs/gadgets",
        readerOf({
          "package.json": JSON.stringify({ dependencies: { "root-dep": "^1.0.0" } }),
          "libs/gadgets/package.json": JSON.stringify({ dependencies: { "local-dep": "^2.0.0" } }),
        }),
      ),
    ).toEqual(["root-dep", "local-dep"]);
  });

  it("reads dependencies, peerDependencies and devDependencies — and NOT optionalDependencies", () => {
    // Upstream's own `getAllDependencies` includes optionalDependencies, but
    // `packageExistsInPackageJson` never calls it: an optional dependency is
    // transitive to the boundary rule, and repairing that would silently waive
    // reports upstream makes.
    expect(
      declaredPackages(
        "libs/gadgets",
        readerOf({
          "libs/gadgets/package.json": JSON.stringify({
            dependencies: { runtime: "1.0.0" },
            peerDependencies: { peer: "1.0.0" },
            devDependencies: { dev: "1.0.0" },
            optionalDependencies: { optional: "1.0.0" },
          }),
        }),
      ),
    ).toEqual(["runtime", "peer", "dev"]);
  });

  it("does not see a dependency declared with a falsy version, upstream's truthy-value test", () => {
    // The silent direction of over-population: including it would exempt an
    // import upstream reports as transitive.
    expect(
      declaredPackages(
        "libs/gadgets",
        readerOf({
          "libs/gadgets/package.json": JSON.stringify({
            dependencies: { visible: "^1.0.0", invisible: "" },
          }),
        }),
      ),
    ).toEqual(["visible"]);
  });

  it("answers null only when NEITHER manifest could be measured", () => {
    // One readable manifest is a measurement: the root manifest alone must
    // produce a list, or every project without its own package.json — most of
    // them — would lose the exemption the root manifest grants.
    expect(declaredPackages("libs/gadgets", readerOf({}))).toBe(null);
    expect(
      declaredPackages(
        "libs/gadgets",
        readerOf({ "package.json": JSON.stringify({ dependencies: { "root-dep": "1" } }) }),
      ),
    ).toEqual(["root-dep"]);
  });

  it("reads the workspace root's manifest once, not unioned with itself, for a root project", () => {
    const read = vi.fn(
      readerOf({ "package.json": JSON.stringify({ dependencies: { "root-dep": "1" } }) }),
    );
    expect(declaredPackages("", read)).toEqual(["root-dep"]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(
      declaredPackages(".", readerOf({ "package.json": '{"dependencies":{"a":"1"}}' })),
    ).toEqual(["a"]);
  });
});

describe("annotating package facts onto the graph nodes", () => {
  const readerOf = (files) => (path) => files[path] ?? null;
  const libNode = (name, root) => ({ name, type: "lib", data: { root } });

  it("writes both fields on every project node whose manifests answered", () => {
    // Upstream reads the SOURCE project's manifest for entry-point and
    // direct-dependency questions and the TARGET's for the lazy-load check, so
    // no node type may be skipped.
    const nodes = {
      gadgets: libNode("gadgets", "libs/gadgets"),
      portal: { name: "portal", type: "app", data: { root: "apps/portal" } },
    };
    annotatePackageFacts(
      nodes,
      readerOf({
        "package.json": JSON.stringify({ dependencies: { "root-dep": "1" } }),
        "libs/gadgets/package.json": JSON.stringify({
          dependencies: { "local-dep": "1" },
          exports: { "./models": "./src/models.ts" },
        }),
      }),
    );
    expect(nodes.gadgets.data.entryPoints).toEqual([
      { path: "libs/gadgets/models", file: "libs/gadgets/src/models.ts" },
    ]);
    expect(nodes.gadgets.data.declaredPackages).toEqual(["root-dep", "local-dep"]);
    // The two facts part ways on a project with no manifest of its own: only
    // that manifest can declare entry points, so the field stays absent (fails
    // closed), while the root manifest alone still grants declared packages.
    expect(nodes.portal.data).not.toHaveProperty("entryPoints");
    expect(nodes.portal.data.declaredPackages).toEqual(["root-dep"]);
  });

  it("DELETES a stale field a manifest-less node carried in from config — the silent direction", () => {
    // `nx graph --file=` copies arbitrary `project.json` keys into `data`
    // verbatim, and `buildNodes` in `lsp/workspace-index.mjs` spreads the same
    // config. A stale `entryPoints` or `declaredPackages` riding in that way
    // would WAIVE violations on a claim nobody measured; deleting it restores
    // "absent fails closed".
    const nodes = {
      gadgets: {
        name: "gadgets",
        type: "lib",
        data: {
          root: "libs/gadgets",
          entryPoints: [{ path: "libs/gadgets/anything", file: "libs/gadgets/x.ts" }],
          declaredPackages: ["waived-package"],
        },
      },
    };
    annotatePackageFacts(nodes, readerOf({}));
    expect(nodes.gadgets.data).not.toHaveProperty("entryPoints");
    expect(nodes.gadgets.data).not.toHaveProperty("declaredPackages");
  });

  it("reads each manifest once per pass, since every node's answer unions the root's manifest", () => {
    const read = vi.fn(readerOf({ "package.json": '{"dependencies":{"a":"1"}}' }));
    annotatePackageFacts(
      { one: libNode("one", "libs/one"), two: libNode("two", "libs/two") },
      read,
    );
    const paths = read.mock.calls.map(([path]) => path);
    expect(paths.filter((path) => path === "package.json")).toHaveLength(1);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("scoping a run to named paths", () => {
  const files = ["libs/alpha/a.go", "libs/alpha/deep/b.go", "libs/beta/c.go"];
  const location = { root: "/w", cwd: "/w" };

  it("covers the whole workspace when no path is named — the gate's mode", () => {
    expect(selectFiles(files, [], location)).toEqual(files);
  });

  it("takes a directory as everything under it, and a file as itself", () => {
    expect(selectFiles(files, ["libs/alpha"], location)).toEqual([
      "libs/alpha/a.go",
      "libs/alpha/deep/b.go",
    ]);
    expect(selectFiles(files, ["libs/beta/c.go"], location)).toEqual(["libs/beta/c.go"]);
  });

  it("resolves a path against the working directory, not the workspace root", () => {
    expect(selectFiles(files, ["deep"], { root: "/w", cwd: "/w/libs/alpha" })).toEqual([
      "libs/alpha/deep/b.go",
    ]);
  });

  it("does not match a sibling whose name merely starts the same way", () => {
    // `libs/alpha` must not select `libs/alpha-extra` — a prefix test without
    // the separator would quietly widen every scoped run.
    expect(selectFiles([...files, "libs/alpha-extra/d.go"], ["libs/alpha"], location)).toEqual([
      "libs/alpha/a.go",
      "libs/alpha/deep/b.go",
    ]);
  });

  it("refuses a path outside the workspace instead of selecting nothing", () => {
    // Selecting nothing would report a clean tree for a run that inspected none
    // of it — the false green this tool exists to remove.
    expect(() => selectFiles(files, ["/elsewhere/x.go"], location)).toThrow(
      /outside the workspace/,
    );
  });
});

describe("analyzing the selection", () => {
  const workspace = { readFile: () => "package main" };

  it("skips a file no analyzer claims before paying to read it", () => {
    const read = vi.fn(() => "text");
    const analyze = vi.fn(() => ({ imports: [], failures: [] }));
    const result = analyzeWorkspace({ readFile: read }, ["a.go", "README.md", "b.json"], {
      analyze,
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(result.analyzed).toBe(1);
    expect(result.analyzedFiles).toEqual(["a.go"]);
  });

  // `analyzed` is a count derived from `analyzedFiles`, not tracked
  // separately — a caller that re-scopes AFTER a wider analysis (the native
  // provider's whole-tree pass, filtered down for a scoped `check <path>` run
  // in `cli.mjs`) needs the list, not just the count, to recompute a
  // scope-correct number without analyzing the tree twice. The silent-
  // direction risk this guards: `analyzed` and `analyzedFiles.length`
  // silently drifting apart, which would make a filtered recount wrong in a
  // way no test over `analyzed` alone would ever catch.
  it("keeps analyzed and analyzedFiles.length in agreement, including over an unreadable file", () => {
    const analyze = vi.fn(() => ({ imports: [], failures: [] }));
    const result = analyzeWorkspace(
      { readFile: (path) => (path === "b.go" ? null : "package main") },
      ["a.go", "b.go", "c.go"],
      { analyze },
    );
    expect(result.analyzedFiles).toEqual(["a.go", "c.go"]);
    expect(result.analyzed).toBe(result.analyzedFiles.length);
  });

  it("records an unreadable file as a failure and keeps going, rather than blanking the run", () => {
    // A report empty because the tool tripped on file three and a report empty
    // because the tree is clean print the same thing (analysis/contract.md).
    const analyze = vi.fn(() => ({
      imports: [/** @type {any} */ ({ specifier: "x" })],
      failures: [],
    }));
    const result = analyzeWorkspace(
      { readFile: (path) => (path === "b.go" ? null : "package main") },
      ["a.go", "b.go", "c.go"],
      { analyze },
    );
    expect(result.failures).toEqual([
      { sourceFile: "b.go", line: null, column: null, reason: "could not be read" },
    ]);
    expect(result.imports).toHaveLength(2);
    expect(result.analyzed).toBe(2);
  });

  it("hands each analyzer the workspace, so resolution can reach the rest of the tree", () => {
    const analyze = vi.fn(() => ({ imports: [], failures: [] }));
    analyzeWorkspace(workspace, ["a.go"], { analyze });
    expect(analyze).toHaveBeenCalledWith({
      sourceFile: "a.go",
      text: "package main",
      workspace,
    });
  });
});

describe("reading the tree's own answers", () => {
  it("splits git's -z output on NUL, so a path is never mangled by quoting", () => {
    // `git ls-files` without -z quotes any path outside plain ASCII, and the
    // quoted form names a file that does not exist.
    const run = () => "libs/alpha/a.go\0libs/béta/b.go\0";
    expect(listTrackedFiles("/w", { run })).toEqual(["libs/alpha/a.go", "libs/béta/b.go"]);
  });

  it("names the failing command when a spawn fails, instead of surfacing a bare ENOENT", () => {
    expect(() => runProcess("definitely-not-a-program", ["--x"], process.cwd())).toThrow(
      /`definitely-not-a-program --x` failed/,
    );
  });
});
