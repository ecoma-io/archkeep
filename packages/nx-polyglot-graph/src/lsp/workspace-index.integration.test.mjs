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
import { diagnoseDocument } from "./diagnose.mjs";
import { buildWorkspaceIndex, listWorkspaceFiles, readWorkspaceFile } from "./workspace-index.mjs";

let root;

/** A Go file importing two apps: the exposing remote, and the near-identical host. */
const CONSUMER_GO = [
  "package consumer",
  "",
  "import (",
  '\t"example.test/widgets"',
  '\t"example.test/portal"',
  ")",
  "",
  "var _ = widgets.Name",
  "var _ = portal.Name",
  "",
].join("\n");

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
  // Two near-identical apps and the library importing both — the pair the
  // Module Federation exemption is decided between. Only the config files on
  // disk separate them, which is exactly the fact the index must read.
  write(
    "apps/widgets/project.json",
    '{"name":"widgets","projectType":"application","tags":["zone:site"]}',
  );
  write("apps/widgets/go.mod", "module example.test/widgets\n\ngo 1.23\n");
  write("apps/widgets/widgets.go", "package widgets\n");
  write(
    "apps/widgets/module-federation.config.js",
    "module.exports = { exposes: { './Widget': './src/widget' } };\n",
  );
  write(
    "apps/portal/project.json",
    '{"name":"portal","projectType":"application","tags":["zone:site"]}',
  );
  write("apps/portal/go.mod", "module example.test/portal\n\ngo 1.23\n");
  write("apps/portal/portal.go", "package portal\n");
  write("apps/portal/module-federation.config.js", "module.exports = { remotes: ['widgets'] };\n");
  write(
    "libs/consumer/project.json",
    '{"name":"consumer","projectType":"library","tags":["zone:site"]}',
  );
  write("libs/consumer/go.mod", "module example.test/consumer\n\ngo 1.23\n");
  write("libs/consumer/consumer.go", CONSUMER_GO);
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

  it("reads the Module Federation fact off the real config files beside each app", () => {
    // The fail-closed field the app-import exemption turns on
    // (`../rules/topology.mjs`), populated the way upstream populates its
    // answer: from `module-federation.config.js` on disk, never from anything
    // the graph was told.
    const index = buildWorkspaceIndex({ root });

    expect(index.graph.nodes.widgets.data.mfeRemote).toBe(true);
    expect(index.graph.nodes.portal.data.mfeRemote).toBe(false);
  });
});

describe("the verdict an editor shows for an import of an app", () => {
  const config = {
    depConstraints: [{ sourceTag: "zone:site", onlyDependOnLibsWithTags: ["zone:site"] }],
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
  };

  // The position the marker lands on, computed from the fixture rather than
  // written as a literal, so editing the fixture moves both sides. LSP
  // positions are 0-based (`./diagnostics.mjs`).
  const lines = CONSUMER_GO.split("\n");
  const portalLine = lines.findIndex((line) => line.includes("example.test/portal"));
  const portalCharacter = lines[portalLine].indexOf('"');

  it("flags the host app and not the remote — both directions of the exemption, over a real tree", () => {
    // The whole change in one verdict: before the index populated `mfeRemote`,
    // the widgets import was a false `noImportsOfApps` here; and the exemption
    // must not over-fire, because a waived real violation is silent — upstream
    // reports the portal import, so this diagnostic list must carry it.
    const index = buildWorkspaceIndex({ root });
    const { analyzed, diagnostics } = diagnoseDocument({
      sourceFile: "libs/consumer/consumer.go",
      text: CONSUMER_GO,
      index,
      config,
    });

    expect(analyzed).toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe("noImportsOfApps");
    expect(diagnostics[0].range.start).toEqual({ line: portalLine, character: portalCharacter });
  });
});
