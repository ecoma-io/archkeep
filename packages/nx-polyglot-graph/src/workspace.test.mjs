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
  createWorkspace,
  listTrackedFiles,
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
  });

  it("records an unreadable file as a failure and keeps going, rather than blanking the run", () => {
    // A report empty because the tool tripped on file three and a report empty
    // because the tree is clean print the same thing (analysis/contract.md).
    const analyze = vi.fn(() => ({ imports: [{ specifier: "x" }], failures: [] }));
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
