import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  analyzeWorkspace,
  createWorkspace,
  environmentForTree,
  findWorkspaceRoot,
  listTrackedFiles,
} from "./workspace.mjs";

/**
 * The scan driven with its real collaborators: the project attribution the rest
 * of the tool resolves against, and the real Go analyzer over a real file on
 * disk. Both interactions are the behaviour being pinned — a nested project is
 * only interesting because `projectOwning` answers by longest prefix, and a
 * `Workspace` is only correct if an analyzer can actually resolve through it.
 */

const root = mkdtempSync(join(tmpdir(), "polyglot-workspace-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const write = (relativePath, text) => {
  mkdirSync(join(root, relativePath, ".."), { recursive: true });
  writeFileSync(join(root, relativePath), text);
};

// An outer project with a second project nested inside its directory — the one
// shape a first-match attribution gets wrong, and this workspace has one
// (a Tauri app keeps its crate under `src-tauri/`).
const graph = {
  nodes: {
    outer: { name: "outer", type: "lib", data: { root: "libs/outer" } },
    inner: { name: "inner", type: "lib", data: { root: "libs/outer/inner" } },
  },
};

write("libs/outer/go.mod", "module example.com/outer\n\ngo 1.24\n");
write("libs/outer/outer.go", 'package outer\n\nimport (\n\t"example.com/inner/pkg"\n)\n');
write("libs/outer/inner/go.mod", "module example.com/inner\n\ngo 1.24\n");
write("libs/outer/inner/pkg.go", "package pkg\n");
write("nx.json", "{}\n");

const files = [
  "libs/outer/go.mod",
  "libs/outer/outer.go",
  "libs/outer/inner/go.mod",
  "libs/outer/inner/pkg.go",
  "nx.json",
];

describe("attributing files to projects", () => {
  it("gives a nested project its own files instead of handing them to the parent", () => {
    // First-match attribution would put every inner file under `outer`, so
    // every intra-project import there would read as a boundary crossing and
    // every real crossing out of it would vanish.
    const { workspace } = createWorkspace({ root, graph, files });
    expect(workspace.filesOf("inner")).toEqual([
      "libs/outer/inner/go.mod",
      "libs/outer/inner/pkg.go",
    ]);
    expect(workspace.filesOf("outer")).toEqual(["libs/outer/go.mod", "libs/outer/outer.go"]);
  });
});

describe("analyzing through the real workspace", () => {
  it("resolves a cross-project import to the project the graph names, at its own line and column", () => {
    // The whole point of the object this module builds: an analyzer resolves
    // through `filesOf`/`readFile`, so a wrong file index yields a wrong
    // verdict rather than an error anyone would notice.
    const { workspace, owned } = createWorkspace({ root, graph, files });
    const { imports, failures } = analyzeWorkspace(
      workspace,
      owned.map(({ file }) => file),
    );

    expect(failures).toEqual([]);
    expect(imports).toEqual([
      {
        sourceFile: "libs/outer/outer.go",
        line: 4,
        column: 2,
        specifier: "example.com/inner/pkg",
        kind: "static",
        // Go has no relative import form: a module path is absolute by
        // construction, so both bits are false and neither the self-circular
        // check nor the path-specifier check can fire on one.
        spelling: { path: false, relative: false },
        resolved: { target: "inner", file: null, external: false, packageName: null },
      },
    ]);
  });

  it("reads files off disk when no reader is injected, which is how the CLI runs", () => {
    const { workspace } = createWorkspace({ root, graph, files });
    expect(workspace.readFile("libs/outer/inner/go.mod")).toContain("module example.com/inner");
    expect(workspace.readFile("libs/outer/missing.go")).toBeNull();
  });
});

describe("finding the tree to judge", () => {
  it("walks up from the working directory to the nx.json above it", () => {
    expect(findWorkspaceRoot(join(root, "libs/outer/inner"))).toBe(root);
  });

  it("returns null rather than guessing when no ancestor is an Nx workspace", () => {
    // Guessing would judge some other tree's files against this tree's rules.
    const orphan = mkdtempSync(join(tmpdir(), "polyglot-orphan-"));
    afterAll(() => rmSync(orphan, { recursive: true, force: true }));
    expect(findWorkspaceRoot(orphan)).toBeNull();
  });
});

describe("deciding which tree git answers about", () => {
  // `GIT_DIR` overrides `cwd`, and git exports it to every hook — which is
  // where this tool runs, from `pre-commit` and `pre-push`. Inheriting it lists
  // the ambient repository's files while resolving them against the root the
  // caller named, so every read fails against a path belonging to another tree
  // and the verdict covers nothing. Real git, real repositories: a stub would
  // pin the intent and miss the mechanism, which is entirely inside git.
  const gitTree = (files) => {
    const directory = mkdtempSync(join(tmpdir(), "polyglot-gitdir-"));
    afterAll(() => rmSync(directory, { recursive: true, force: true }));
    const git = (...args) =>
      execFileSync("git", args, { cwd: directory, env: environmentForTree(), encoding: "utf8" });
    git("init", "-q");
    for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
    git("add", "-A");
    return directory;
  };

  it("lists the files of the tree it was given, not the one GIT_DIR names", () => {
    const judged = gitTree({ "judged.go": "package judged\n" });
    const ambient = gitTree({ "ambient.go": "package ambient\n" });

    const inherited = process.env.GIT_DIR;
    process.env.GIT_DIR = join(ambient, ".git");
    try {
      expect(listTrackedFiles(judged)).toEqual(["judged.go"]);
    } finally {
      if (inherited === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = inherited;
    }
  });

  it("strips every variable that redirects git, and leaves the rest of the environment alone", () => {
    const cleaned = environmentForTree({
      GIT_DIR: "/elsewhere/.git",
      GIT_WORK_TREE: "/elsewhere",
      GIT_INDEX_FILE: "/elsewhere/index",
      PATH: "/usr/bin",
    });
    expect(cleaned).toEqual({ PATH: "/usr/bin" });
  });
});
