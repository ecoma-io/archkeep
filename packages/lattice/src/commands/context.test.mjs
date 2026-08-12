import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveCommandContext } from "./context.mjs";

/** Every tmpdir this file creates, cleaned up after each test that made one. */
const roots = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

/** A fresh tmpdir plus a `write(relativePath, text)` that creates parent directories. */
function fixture(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const write = (relativePath, text) => {
    mkdirSync(join(root, relativePath, ".."), { recursive: true });
    writeFileSync(join(root, relativePath), text);
  };
  return { root, write };
}

describe("resolveCommandContext — the native branch analyzes the whole tree before scoping", () => {
  it("draws a graph edge between two projects neither is inside the requested scope", () => {
    // The asymmetry `context.mjs`'s header argues: on the native path
    // `dependencies` is DERIVED from import sites, so analyzing only the
    // scoped project first would drop every other project's imports from the
    // graph entirely — a transitive edge outside the scope would silently
    // vanish rather than merely go unreported. `b` importing `c` must survive
    // in `graph.dependencies` even when the run is scoped to `a`, which has
    // no imports of its own.
    const { root, write } = fixture("context-native-scope-");
    write(
      "lattice.json",
      JSON.stringify({
        projects: {
          declared: [
            { root: "libs/a", name: "a", tags: [] },
            { root: "libs/b", name: "b", tags: [] },
            { root: "libs/c", name: "c", tags: [] },
          ],
        },
      }),
    );
    write("libs/a/go.mod", "module example.com/a\n\ngo 1.24\n");
    write("libs/a/a.go", "package a\n");
    write("libs/b/go.mod", "module example.com/b\n\ngo 1.24\n");
    write("libs/b/b.go", 'package b\n\nimport "example.com/c"\n\nvar _ = c.Name\n');
    write("libs/c/go.mod", "module example.com/c\n\ngo 1.24\n");
    write("libs/c/c.go", "package c\n");

    const context = resolveCommandContext(
      { cwd: root, paths: ["libs/a"] },
      {
        listFiles: () => [
          "lattice.json",
          "libs/a/go.mod",
          "libs/a/a.go",
          "libs/b/go.mod",
          "libs/b/b.go",
          "libs/c/go.mod",
          "libs/c/c.go",
        ],
      },
    );

    expect(context.provider).toBe("native");
    // Scoped: only `a`'s files were selected for reporting.
    expect(context.analysis.analyzedFiles).toEqual(["libs/a/a.go"]);
    // Not scoped: the graph still carries b → c, because the whole tree was
    // analyzed to build it before the scope was applied.
    expect(context.graph.dependencies.b).toEqual([{ source: "b", target: "c", type: "static" }]);
  });
});

describe("resolveCommandContext — the Nx branch scopes before it analyzes", () => {
  it("never analyzes a file outside the requested scope at all", () => {
    // The opposite order from the native branch, and load-bearing for the
    // opposite reason: `graph.dependencies` here comes from `readGraph`
    // (injected below) independently of any scope, so narrowing the files
    // handed to `analyzeWorkspace` only affects what gets reported — it must
    // narrow before analysis runs, not merely before the result is filtered,
    // or a caller injecting a spy `analyze` would see it called for a file
    // this run was never supposed to touch.
    const { root, write } = fixture("context-nx-scope-");
    write("nx.json", "{}\n");
    write("libs/x/x.go", "package x\n");
    write("libs/y/y.go", "package y\n");

    const graph = {
      nodes: {
        x: { name: "x", type: "lib", data: { root: "libs/x" } },
        y: { name: "y", type: "lib", data: { root: "libs/y" } },
      },
      dependencies: { x: [], y: [] },
    };

    const context = resolveCommandContext(
      { cwd: root, paths: ["libs/y"] },
      {
        readGraph: () => graph,
        listFiles: () => ["nx.json", "libs/x/x.go", "libs/y/y.go"],
      },
    );

    expect(context.provider).toBe("nx");
    expect(context.analysis.analyzedFiles).toEqual(["libs/y/y.go"]);
  });
});

describe("resolveCommandContext — the two loud refusals it owns", () => {
  it("throws when the root carries both nx.json and lattice.json, naming the tree", () => {
    const { root, write } = fixture("context-both-markers-");
    write("nx.json", "{}\n");
    write("lattice.json", "{}\n");

    expect(() =>
      resolveCommandContext(
        { cwd: root },
        { listFiles: () => ["nx.json", "lattice.json"], readGraph: () => ({ nodes: {} }) },
      ),
    ).toThrow(/declares both nx\.json and lattice\.json/);
  });

  it("throws when a requested path lies outside the workspace, via selectFiles unchanged", () => {
    const { root, write } = fixture("context-outside-path-");
    write("nx.json", "{}\n");
    write("libs/a/a.go", "package a\n");

    expect(() =>
      resolveCommandContext(
        { cwd: root, paths: ["/elsewhere/x.go"] },
        {
          readGraph: () => ({
            nodes: { a: { name: "a", type: "lib", data: { root: "libs/a" } } },
            dependencies: { a: [] },
          }),
          listFiles: () => ["nx.json", "libs/a/a.go"],
        },
      ),
    ).toThrow(/outside the workspace/);
  });
});

describe("resolveCommandContext — pluginGap", () => {
  it("is always {registered: true, manifests: []} on a native workspace", () => {
    // There is no Nx plugin registration to be missing on a tree with no
    // nx.json at all — a native root is never the tree this gap describes.
    const { root, write } = fixture("context-native-plugingap-");
    write(
      "lattice.json",
      JSON.stringify({ projects: { declared: [{ root: "libs/a", name: "a", tags: [] }] } }),
    );
    write("libs/a/go.mod", "module example.com/a\n\ngo 1.24\n");

    const context = resolveCommandContext(
      { cwd: root },
      { listFiles: () => ["lattice.json", "libs/a/go.mod"] },
    );
    expect(context.pluginGap).toEqual({ registered: true, manifests: [] });
  });

  it("names a tracked polyglot manifest under a project root, on an Nx workspace with no plugin registered", () => {
    // The silent-direction fact this exists to surface: a tracked go.mod with
    // no plugin registration draws no edge and `nx affected` under-selects
    // with no warning at all (`../workspace.mjs`'s `polyglotManifests`).
    const { root, write } = fixture("context-nx-plugingap-");
    write("nx.json", "{}\n");
    write("libs/a/go.mod", "module example.com/a\n\ngo 1.24\n");

    const context = resolveCommandContext(
      { cwd: root },
      {
        readGraph: () => ({
          nodes: { a: { name: "a", type: "lib", data: { root: "libs/a" } } },
          dependencies: { a: [] },
        }),
        listFiles: () => ["nx.json", "libs/a/go.mod"],
      },
    );
    expect(context.pluginGap).toEqual({ registered: false, manifests: ["libs/a/go.mod"] });
  });

  it("reads pluginGap.registered from the injected readFile, not from nx.json's real content on disk", () => {
    // The marker still has to exist on disk — `findWorkspaceRoot` and
    // `markersAt` check for it with the real filesystem, unrelated to this
    // seam — but its CONTENT never has to: `pluginIsRegistered`
    // (`../options.mjs`) is handed the injected `readFile` instead of the
    // real one, and this fixture's real `nx.json` on disk says the opposite
    // of what the injected reader says. If `registered` below came out
    // `true`, that could only be the injected answer — the real file has no
    // `plugins` key at all.
    const { root, write } = fixture("context-nx-plugingap-injected-");
    write("nx.json", "{}\n");
    write("libs/a/go.mod", "module example.com/a\n\ngo 1.24\n");

    const context = resolveCommandContext(
      { cwd: root },
      {
        readGraph: () => ({
          nodes: { a: { name: "a", type: "lib", data: { root: "libs/a" } } },
          dependencies: { a: [] },
        }),
        listFiles: () => ["nx.json", "libs/a/go.mod"],
        readFile: (path) =>
          path === join(root, "nx.json")
            ? JSON.stringify({ plugins: ["@ecoma-io/lattice/nx"] })
            : null,
      },
    );
    expect(context.pluginGap).toEqual({ registered: true, manifests: ["libs/a/go.mod"] });
  });
});
