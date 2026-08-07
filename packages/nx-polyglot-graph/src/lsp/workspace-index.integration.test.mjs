/**
 * The index against a real tree: the file list really comes from git, the
 * manifests are really read, and the Go analyzer really resolves.
 *
 * The unit tier next door injects both, which is what lets it pin the index's
 * own decisions. What it cannot pin is whether the two real components exist
 * and agree — whether git answers at all, whether a `go.mod` two directories
 * down is reachable through `filesOf`. Only a tree on disk shows that.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { environmentForTree } from "../workspace.mjs";
import { buildWorkspaceIndex, listWorkspaceFiles, readWorkspaceFile } from "./workspace-index.mjs";

let root;

const write = (relativePath, text) => {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text, "utf8");
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nx-polyglot-graph-index-"));
  write(".gitignore", "ignored/\n");
  write(
    "libs/inner/project.json",
    '{"name":"inner","projectType":"library","tags":["zone:inner"]}',
  );
  write("libs/inner/go.mod", "module example.test/inner\n\ngo 1.23\n");
  write("libs/inner/main.go", 'package inner\n\nimport "example.test/outer/thing"\n');
  write(
    "libs/outer/project.json",
    '{"name":"outer","projectType":"library","tags":["zone:outer"]}',
  );
  write("libs/outer/go.mod", "module example.test/outer\n\ngo 1.23\n");
  write("libs/outer/thing/thing.go", "package thing\n");
  write("ignored/generated.go", 'package generated\n\nimport "example.test/inner"\n');
  // `environmentForTree` because `GIT_DIR` beats `cwd`, and this suite runs
  // from a git hook on every push: inheriting it would re-initialise the
  // ambient repository and leave this fixture with no `.git` of its own.
  execFileSync("git", ["init", "-q"], { cwd: root, env: environmentForTree() });
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("where the file list comes from", () => {
  it("lists files that exist but are not committed, because that is what an editor sees", () => {
    // A file created five seconds ago is exactly the one about to be imported.
    // `--cached` alone would leave it out of every project's file list, and its
    // manifest — a brand new `go.mod` — out of resolution entirely.
    const files = listWorkspaceFiles(root);

    expect(files).toContain("libs/inner/main.go");
    expect(files).toContain("libs/outer/go.mod");
  });

  it("respects .gitignore, so a generated tree is not analyzed as source", () => {
    // This is the whole reason the list is derived from git rather than from a
    // hand-kept skip list: `.gitignore` is the tree's own single statement of
    // what is not source, and it cannot drift from itself.
    expect(listWorkspaceFiles(root)).not.toContain("ignored/generated.go");
  });

  it("fails loudly, naming the directory, when git cannot answer for the tree", () => {
    // An index built from no files puts every file in no project, and a file in
    // no project has no boundary to cross. That is a clean report produced by
    // not looking, which is the failure this whole server is written around.
    const outside = mkdtempSync(join(tmpdir(), "nx-polyglot-graph-not-a-repo-"));
    try {
      expect(() => listWorkspaceFiles(join(outside, "missing"))).toThrow(
        /cannot list the files of/u,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("answers null for a file that is not there, rather than throwing mid-run", () => {
    expect(readWorkspaceFile(root, "libs/inner/go.mod")).toContain("module example.test/inner");
    expect(readWorkspaceFile(root, "libs/inner/absent.go")).toBeNull();
  });
});

describe("the graph the index hands the rule engine", () => {
  it("carries the cross-project edge a Go import makes, resolved through real manifests", () => {
    // Nx infers no edge here at all, which is half of why this project exists.
    // An empty `dependencies` map costs no false positive and every cycle —
    // so it has to be shown really being populated, not merely being shaped.
    const index = buildWorkspaceIndex({ root });

    expect(index.graph.dependencies.inner).toEqual([
      { source: "inner", target: "outer", type: "static" },
    ]);
    expect(index.graph.nodes.inner.data.tags).toEqual(["zone:inner"]);
    expect(index.graph.nodes.outer.type).toBe("lib");
    expect(index.skippedProjects).toEqual([]);
    expect(index.fileFailures).toEqual([]);
  });
});
