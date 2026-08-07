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
  createWorkspace,
  listTrackedFiles,
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
