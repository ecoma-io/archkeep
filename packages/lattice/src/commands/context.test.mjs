import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { markersAt, resolveCommandContext } from "./context.mjs";

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

describe("resolveCommandContext — the Moon branch derives edges from imports, not only from dependsOn", () => {
  // `moon project-graph --json` only carries an edge Moon itself resolved from
  // a hand-written `dependsOn` in `moon.yml` — it has no plugin hook this
  // package can register into the way `../nx.mjs`'s `createDependencies`
  // registers into Nx's own graph computation, so a real Go/Rust/Python import
  // crossing a project boundary with no `dependsOn` entry used to leave
  // `graph.dependencies` exactly as Moon declared it: empty. Every verdict
  // computed FROM the graph — architecture-intent, drift, cycles, `impact`,
  // `diff` — read that as "no dependency" while `check`'s own import-site
  // rules (which read analysis records directly) judged the same import fine,
  // so a workspace with a real cross-project dependency reported it as
  // unrelated in every one of those commands. This is the silent direction
  // `AGENTS.md`'s invariant forbids: the graph claimed completeness it never
  // had.
  it("adds an edge for a real cross-project import the Moon graph never declared", () => {
    const { root, write } = fixture("context-moon-imports-");
    write(".moon/workspace.yml", "projects:\n  a: libs/a\n  b: libs/b\n");
    write("libs/a/go.mod", "module example.com/a\n\ngo 1.24\n");
    write("libs/a/a.go", 'package a\n\nimport "example.com/b"\n\nvar _ = b.Name\n');
    write("libs/b/go.mod", "module example.com/b\n\ngo 1.24\n");
    write("libs/b/b.go", "package b\n");

    const context = resolveCommandContext(
      { cwd: root, paths: [] },
      {
        // The injected graph is exactly what `moon project-graph --json`
        // would answer for a workspace with no `dependsOn` anywhere: nodes,
        // and an empty dependency list for each — Moon knows the projects
        // exist and knows nothing about how they relate.
        readGraph: () => ({
          nodes: {
            a: { name: "a", type: "lib", data: { root: "libs/a", tags: [] } },
            b: { name: "b", type: "lib", data: { root: "libs/b", tags: [] } },
          },
          dependencies: { a: [], b: [] },
        }),
        listFiles: () => [
          ".moon/workspace.yml",
          "libs/a/go.mod",
          "libs/a/a.go",
          "libs/b/go.mod",
          "libs/b/b.go",
        ],
      },
    );

    expect(context.provider).toBe("moon");
    expect(context.graph.dependencies.a).toEqual([{ source: "a", target: "b", type: "static" }]);
  });

  it("analyzes the whole tree before scoping, so an edge outside the requested scope still survives", () => {
    // Same asymmetry the native branch's own test above names: a Moon
    // workspace derives `dependencies` from import sites the same way native
    // does now, so analyzing only the scoped project first would drop every
    // other project's imports from the graph entirely rather than merely
    // from the report.
    const { root, write } = fixture("context-moon-scope-");
    write(".moon/workspace.yml", "projects:\n  a: libs/a\n  b: libs/b\n  c: libs/c\n");
    write("libs/a/go.mod", "module example.com/a\n\ngo 1.24\n");
    write("libs/a/a.go", "package a\n");
    write("libs/b/go.mod", "module example.com/b\n\ngo 1.24\n");
    write("libs/b/b.go", 'package b\n\nimport "example.com/c"\n\nvar _ = c.Name\n');
    write("libs/c/go.mod", "module example.com/c\n\ngo 1.24\n");
    write("libs/c/c.go", "package c\n");

    const context = resolveCommandContext(
      { cwd: root, paths: ["libs/a"] },
      {
        readGraph: () => ({
          nodes: {
            a: { name: "a", type: "lib", data: { root: "libs/a", tags: [] } },
            b: { name: "b", type: "lib", data: { root: "libs/b", tags: [] } },
            c: { name: "c", type: "lib", data: { root: "libs/c", tags: [] } },
          },
          dependencies: { a: [], b: [], c: [] },
        }),
        listFiles: () => [
          ".moon/workspace.yml",
          "libs/a/go.mod",
          "libs/a/a.go",
          "libs/b/go.mod",
          "libs/b/b.go",
          "libs/c/go.mod",
          "libs/c/c.go",
        ],
      },
    );

    expect(context.provider).toBe("moon");
    expect(context.analysis.analyzedFiles).toEqual(["libs/a/a.go"]);
    expect(context.graph.dependencies.b).toEqual([{ source: "b", target: "c", type: "static" }]);
  });

  it("keeps a Moon-declared edge that no import site backs, additively rather than replacing it", () => {
    // `dependsOn` can be true without a matching source import — a build-order
    // or task dependency, or a language this package does not analyze. The
    // merge must be additive: a declared edge with no import behind it is
    // still a fact Moon asserted, not something this package gets to discard
    // because its own analysis found no corroborating site.
    const { root, write } = fixture("context-moon-declared-only-");
    write(".moon/workspace.yml", "projects:\n  a: libs/a\n  b: libs/b\n");
    write("libs/a/go.mod", "module example.com/a\n\ngo 1.24\n");
    write("libs/a/a.go", "package a\n");
    write("libs/b/go.mod", "module example.com/b\n\ngo 1.24\n");
    write("libs/b/b.go", "package b\n");

    const context = resolveCommandContext(
      { cwd: root, paths: [] },
      {
        readGraph: () => ({
          nodes: {
            a: { name: "a", type: "lib", data: { root: "libs/a", tags: [] } },
            b: { name: "b", type: "lib", data: { root: "libs/b", tags: [] } },
          },
          dependencies: { a: [{ source: "a", target: "b", type: "static" }], b: [] },
        }),
        listFiles: () => [
          ".moon/workspace.yml",
          "libs/a/go.mod",
          "libs/a/a.go",
          "libs/b/go.mod",
          "libs/b/b.go",
        ],
      },
    );

    expect(context.provider).toBe("moon");
    expect(context.graph.dependencies.a).toEqual([{ source: "a", target: "b", type: "static" }]);
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

describe("resolveCommandContext — the loud refusals it owns", () => {
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

  it("throws when a requested path matches no tracked file — the untracked-new-file case", () => {
    // The audit's exact reproduction: the file exists on disk under the
    // scoped path but `listFiles` (standing in for `git ls-files`) never
    // named it, mirroring a file that exists but was never `git add`ed. The
    // committed twin of this same path, byte for byte, would be selected and
    // judged instead of silently selecting nothing.
    const { root, write } = fixture("context-untracked-path-");
    write("nx.json", "{}\n");
    write("libs/a/a.go", "package a\n");
    write("libs/a/untracked.go", "package a\n");

    expect(() =>
      resolveCommandContext(
        { cwd: root, paths: ["libs/a/untracked.go"] },
        {
          readGraph: () => ({
            nodes: { a: { name: "a", type: "lib", data: { root: "libs/a" } } },
            dependencies: { a: [] },
          }),
          // `untracked.go` is on disk (written above) but not in this list —
          // the exact shape `git ls-files` would answer before `git add`.
          listFiles: () => ["nx.json", "libs/a/a.go"],
        },
      ),
    ).toThrow(/matches no tracked file/);
  });

  it("does not throw when a requested path is tracked but owned by no project — a real, empty slice", () => {
    // `docs/` is tracked (it is in `listFiles`) but no declared project's root
    // covers it, so it is legitimately empty — not a usage mistake, and must
    // select cleanly rather than join the refusal above.
    const { root, write } = fixture("context-tracked-unowned-path-");
    write("nx.json", "{}\n");
    write("libs/a/a.go", "package a\n");
    write("docs/readme.md", "# docs\n");

    const context = resolveCommandContext(
      { cwd: root, paths: ["docs"] },
      {
        readGraph: () => ({
          nodes: { a: { name: "a", type: "lib", data: { root: "libs/a" } } },
          dependencies: { a: [] },
        }),
        listFiles: () => ["nx.json", "libs/a/a.go", "docs/readme.md"],
      },
    );
    expect(context.analysis.analyzedFiles).toEqual([]);
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

describe("markersAt — detects all three workspace markers", () => {
  it("detects a .moon directory as a Moon marker", () => {
    const { root, write } = fixture("context-markers-moon-");
    write(".moon/tool.yml", " "); // .moon/ directory with any content
    const markers = markersAt(root);
    expect(markers.hasMoon).toBe(true);
    expect(markers.hasNx).toBe(false);
    expect(markers.hasNative).toBe(false);
  });

  it("detects a .config/moon directory as a Moon marker", () => {
    const { root, write } = fixture("context-markers-alt-moon-");
    write(".config/moon/tool.yml", " "); // .config/moon/ directory with any content
    const markers = markersAt(root);
    expect(markers.hasMoon).toBe(true);
    expect(markers.hasNx).toBe(false);
    expect(markers.hasNative).toBe(false);
  });

  it("detects nx.json as an Nx marker", () => {
    const { root, write } = fixture("context-markers-nx-");
    write("nx.json", "{}\n");
    const markers = markersAt(root);
    expect(markers.hasNx).toBe(true);
    expect(markers.hasNative).toBe(false);
    expect(markers.hasMoon).toBe(false);
  });

  it("detects lattice.json as a native marker", () => {
    const { root, write } = fixture("context-markers-native-");
    write("lattice.json", "{}\n");
    const markers = markersAt(root);
    expect(markers.hasNative).toBe(true);
    expect(markers.hasNx).toBe(false);
    expect(markers.hasMoon).toBe(false);
  });

  it("returns all three false when no marker is present", () => {
    const { root } = fixture("context-markers-none-");
    const markers = markersAt(root);
    expect(markers.hasNx).toBe(false);
    expect(markers.hasNative).toBe(false);
    expect(markers.hasMoon).toBe(false);
  });
});

describe("resolveCommandContext — Moon ambiguity refusals", () => {
  it("throws when the root carries both .moon and nx.json", () => {
    const { root, write } = fixture("context-moon-nx-ambiguity-");
    write(".moon/tool.yml", " ");
    write("nx.json", "{}\n");

    expect(() =>
      resolveCommandContext(
        { cwd: root },
        { listFiles: () => [".moon/tool.yml", "nx.json"], readGraph: () => ({ nodes: {} }) },
      ),
    ).toThrow(/declares both .moon and nx\.json/);
  });

  it("throws when the root carries both .moon and lattice.json", () => {
    const { root, write } = fixture("context-moon-native-ambiguity-");
    write(".moon/tool.yml", " ");
    write("lattice.json", "{}\n");

    expect(() =>
      resolveCommandContext({ cwd: root }, { listFiles: () => [".moon/tool.yml", "lattice.json"] }),
    ).toThrow(/declares both .moon and lattice\.json/);
  });
});

describe("resolveCommandContext — the Moon branch scopes before it analyzes", () => {
  it("selects the Moon provider when only .moon is present", () => {
    const { root, write } = fixture("context-moon-provider-");
    write(".moon/tool.yml", " ");
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
        listFiles: () => [".moon/tool.yml", "libs/x/x.go", "libs/y/y.go"],
      },
    );

    expect(context.provider).toBe("moon");
    expect(context.marker).toBe(".moon");
    expect(context.analysis.analyzedFiles).toEqual(["libs/y/y.go"]);
    // Moon has no Nx plugin registration to be missing.
    expect(context.pluginGap).toEqual({ registered: true, manifests: [] });
    // Options come from defaults (no nx.json plugins table, no lattice.json).
    expect(context.options.boundaryConfig).toBe("module-boundaries.config.mjs");
    expect(context.options.tsConfig).toBe("tsconfig.base.json");
  });

  it("selects the Moon provider when .config/moon is present", () => {
    const { root, write } = fixture("context-alt-moon-provider-");
    write(".config/moon/tool.yml", " ");
    write("libs/x/x.go", "package x\n");

    const graph = {
      nodes: {
        x: { name: "x", type: "lib", data: { root: "libs/x" } },
      },
      dependencies: { x: [] },
    };

    const context = resolveCommandContext(
      { cwd: root },
      {
        readGraph: () => graph,
        listFiles: () => [".config/moon/tool.yml", "libs/x/x.go"],
      },
    );

    expect(context.provider).toBe("moon");
    expect(context.marker).toBe(".config/moon");
    expect(context.pluginGap).toEqual({ registered: true, manifests: [] });
  });
});

describe("resolveCommandContext — the unclaimed-file coverage hole, on the Nx and Moon branches too", () => {
  // P1-12: the native branch's own unclaimed-file check ("the native branch
  // analyzes the whole tree before scoping" above draws on the same
  // `discovered.failures`) had no equivalent here — `createWorkspace` drops a
  // file no project owns (`../workspace.mjs`'s own header), and neither the
  // Nx nor the Moon branch ever looked at what got dropped. A tracked,
  // analyzable file outside every declared project's root was simply never
  // selected for analysis, never counted, and never mentioned — `analysis.failures`
  // stayed exactly as populated as a workspace where every file really was
  // owned.
  it("adds a whole-file failure for a tracked Go file outside every declared Nx project", () => {
    const { root, write } = fixture("context-nx-unclaimed-");
    write("nx.json", "{}\n");
    write("libs/a/a.go", "package a\n");
    write("libs/orphan/orphan.go", "package orphan\n");

    const graph = {
      nodes: { a: { name: "a", type: "lib", data: { root: "libs/a" } } },
      dependencies: { a: [] },
    };

    const context = resolveCommandContext(
      { cwd: root },
      {
        readGraph: () => graph,
        listFiles: () => ["nx.json", "libs/a/a.go", "libs/orphan/orphan.go"],
      },
    );

    expect(context.provider).toBe("nx");
    const unclaimed = context.analysis.failures.filter(
      (failure) => failure.sourceFile === "libs/orphan/orphan.go",
    );
    expect(unclaimed).toHaveLength(1);
    // Whole-file, not one position in it — the same shape a language
    // analyzer produces for a file it could not read at all.
    expect(unclaimed[0].line).toBeNull();
    expect(unclaimed[0].reason).toContain("not owned by any project");
    // Never handed to the analyzer as if some project claimed it.
    expect(context.analysis.analyzedFiles).not.toContain("libs/orphan/orphan.go");
  });

  it("adds a whole-file failure for a tracked Go file outside every declared Moon project", () => {
    const { root, write } = fixture("context-moon-unclaimed-");
    write(".moon/tool.yml", " ");
    write("libs/a/a.go", "package a\n");
    write("libs/orphan/orphan.go", "package orphan\n");

    const graph = {
      nodes: { a: { name: "a", type: "lib", data: { root: "libs/a" } } },
      dependencies: { a: [] },
    };

    const context = resolveCommandContext(
      { cwd: root },
      {
        readGraph: () => graph,
        listFiles: () => [".moon/tool.yml", "libs/a/a.go", "libs/orphan/orphan.go"],
      },
    );

    expect(context.provider).toBe("moon");
    const unclaimed = context.analysis.failures.filter(
      (failure) => failure.sourceFile === "libs/orphan/orphan.go",
    );
    expect(unclaimed).toHaveLength(1);
    expect(unclaimed[0].line).toBeNull();
    expect(unclaimed[0].reason).toContain("not owned by any project");
    expect(context.analysis.analyzedFiles).not.toContain("libs/orphan/orphan.go");
  });

  it("still reports the Nx orphan when the run is scoped away from it, same as native's own posture", () => {
    // The scoped-run regression, mirrored from native: a `check <path>` that
    // excludes the orphan's directory must not be able to make it disappear.
    // `unclaimedFileFailures` is computed from `tracked`, never from the
    // scoped selection, for exactly this reason.
    const { root, write } = fixture("context-nx-unclaimed-scoped-");
    write("nx.json", "{}\n");
    write("libs/a/a.go", "package a\n");
    write("libs/orphan/orphan.go", "package orphan\n");

    const graph = {
      nodes: { a: { name: "a", type: "lib", data: { root: "libs/a" } } },
      dependencies: { a: [] },
    };

    const context = resolveCommandContext(
      { cwd: root, paths: ["libs/a"] },
      {
        readGraph: () => graph,
        listFiles: () => ["nx.json", "libs/a/a.go", "libs/orphan/orphan.go"],
      },
    );

    expect(
      context.analysis.failures.some((failure) => failure.sourceFile === "libs/orphan/orphan.go"),
    ).toBe(true);
  });

  it("claims a file under a declared project's root, so only the true orphan is reported", () => {
    // The negative case every positive one above needs: a file that IS inside
    // a declared project's directory must never be reported as unclaimed,
    // whichever provider answered.
    const { root, write } = fixture("context-nx-unclaimed-negative-");
    write("nx.json", "{}\n");
    write("libs/a/a.go", "package a\n");

    const graph = {
      nodes: { a: { name: "a", type: "lib", data: { root: "libs/a" } } },
      dependencies: { a: [] },
    };

    const context = resolveCommandContext(
      { cwd: root },
      {
        readGraph: () => graph,
        listFiles: () => ["nx.json", "libs/a/a.go"],
      },
    );

    expect(context.analysis.failures).toEqual([]);
  });

  it("does not flag a root-level .mjs tooling script — Nx's own graph and @nx/enforce-module-boundaries already cover that language", () => {
    // The scope this check deliberately does NOT widen to: TypeScript,
    // JavaScript and Vue already have Nx's own edge-drawing and ESLint's own
    // boundary enforcement, so a config file living outside every declared
    // project is the everyday shape of a real Nx workspace (this
    // repository's own root is exactly this shape), not a silent hole this
    // tool introduces. Widening `UNCLAIMED_CHECK_LANGUAGES` back to "every
    // analyzable file" is the regression this test exists to catch — it
    // broke this repository's own `moon`-driven `check` when tried.
    const { root, write } = fixture("context-nx-unclaimed-js-excluded-");
    write("nx.json", "{}\n");
    write("libs/a/a.go", "package a\n");
    write("tooling.config.mjs", "export const x = 1;\n");

    const graph = {
      nodes: { a: { name: "a", type: "lib", data: { root: "libs/a" } } },
      dependencies: { a: [] },
    };

    const context = resolveCommandContext(
      { cwd: root },
      {
        readGraph: () => graph,
        listFiles: () => ["nx.json", "libs/a/a.go", "tooling.config.mjs"],
      },
    );

    expect(context.analysis.failures).toEqual([]);
  });
});
