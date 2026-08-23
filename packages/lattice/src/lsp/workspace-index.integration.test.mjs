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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { environmentForTree } from "../workspace.mjs";
import { diagnoseDocument } from "./diagnose.mjs";
import {
  buildWorkspaceIndex,
  indexGaps,
  listWorkspaceFiles,
  readWorkspaceFile,
} from "./workspace-index.mjs";

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

/** Imports of the three installed packages, of which only two are declared. */
const GADGETS_INDEX_TS = [
  'import { name as direct } from "direct-dep";',
  'import { name as local } from "local-dep";',
  'import { name as transitive } from "transitive-dep";',
  "",
  "export const gadgets = [direct, local, transitive];",
  "",
].join("\n");

/** A file in the secondary entry point's subtree importing it by alias. */
const FEATURE_TS =
  'import { models } from "@fixture/gadgets/models";\n\nexport const feature = models;\n';

/** The near-identical import of the MAIN entry: a cycle through the barrel. */
const BARREL_TS =
  'import { gadgets } from "@fixture/gadgets";\n\nexport const viaBarrel = gadgets;\n';

const write = (relativePath, text) => {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text, "utf8");
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "lattice-index-"));
  write(".gitignore", "ignored/\nnode_modules/\n");
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
  // A TypeScript project carrying the two package.json facts the index must
  // read off the real tree: a secondary entry point in its `exports`, a
  // dependency in its own manifest, and one in the workspace root's.
  write("package.json", '{"name":"fixture","dependencies":{"direct-dep":"^1.0.0"}}');
  write(
    "tsconfig.base.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        baseUrl: ".",
        paths: {
          "@fixture/gadgets": ["libs/gadgets/src/index.ts"],
          "@fixture/gadgets/models": ["libs/gadgets/src/models.ts"],
        },
      },
    }),
  );
  write(
    "libs/gadgets/project.json",
    '{"name":"gadgets","projectType":"library","tags":["zone:site"]}',
  );
  write(
    "libs/gadgets/package.json",
    JSON.stringify({
      name: "@fixture/gadgets",
      dependencies: { "local-dep": "^1.0.0" },
      exports: { ".": "./src/index.ts", "./models": "./src/models.ts" },
    }),
  );
  write("libs/gadgets/src/index.ts", GADGETS_INDEX_TS);
  write("libs/gadgets/src/models.ts", 'export const models = "models";\n');
  write("libs/gadgets/src/deep/feature.ts", FEATURE_TS);
  write("libs/gadgets/src/barrel-user.ts", BARREL_TS);
  // All three packages are INSTALLED (and gitignored, as node_modules is in
  // any real tree): an unresolvable specifier is reported as transitive
  // regardless of declaration — upstream the same — which would let an
  // always-empty `declaredPackages` pass the flagged case for the wrong
  // reason.
  for (const name of ["direct-dep", "local-dep", "transitive-dep"]) {
    write(
      `node_modules/${name}/package.json`,
      JSON.stringify({
        name,
        version: "1.0.0",
        types: "./index.d.ts",
        exports: { ".": "./index.d.ts", "./*": "./*.d.ts" },
      }),
    );
    write(`node_modules/${name}/index.d.ts`, "export declare const name: string;\n");
  }
  // `environmentForTree` because `GIT_DIR` beats `cwd`, and this suite runs
  // from a git hook on every push: inheriting it would re-initialise the
  // ambient repository and leave this fixture with no `.git` of its own. The
  // files are staged because the file list is TRACKED files only — the same
  // set `../../cli.mjs`'s `check` reads (`../workspace.mjs`'s
  // `listTrackedFiles`) — and an untracked fixture file is invisible to both.
  execFileSync("git", ["init", "-q"], { cwd: root, env: environmentForTree() });
  execFileSync("git", ["add", "-A"], { cwd: root, env: environmentForTree() });
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("where the file list comes from", () => {
  it("lists only tracked files, because that is what check judges and the editor must match", () => {
    // An untracked file is a file `../../cli.mjs`'s `check` does not judge —
    // the CLI's file list is `git ls-files` tracked-only
    // (`../workspace.mjs`'s `listTrackedFiles`, which this delegates to) — so
    // an editor verdict that read a different set would disagree with the CLI
    // about the same tree. The parity is the point: list a fresh untracked
    // file, see it absent, stage it, see it present.
    const fresh = "libs/outer/fresh.go";
    write(fresh, "package outer\n");
    expect(listWorkspaceFiles(root)).not.toContain(fresh);

    execFileSync("git", ["add", "-A"], { cwd: root, env: environmentForTree() });
    expect(listWorkspaceFiles(root)).toContain(fresh);

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
    const outside = mkdtempSync(join(tmpdir(), "lattice-not-a-repo-"));
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

  it("refuses a symlink whose realpath leaves the workspace — the LSP read escape (G-10)", () => {
    // Before `containmentViolation` (`../containment.mjs`), `readWorkspaceFile`
    // followed a tracked symlink out of the tree with plain `readFileSync` and
    // judged the outside bytes as the workspace's own source — the index drew
    // no diagnostic for the escape, exactly like a clean tree. Now the outside
    // file is refused: `null` here is the whole-file failure the index
    // surfaces as an `indexGaps` diagnostic, never a silently-empty index.
    const outside = mkdtempSync(join(tmpdir(), "lattice-index-escape-"));
    try {
      writeFileSync(join(outside, "outsider.py"), "import os\n");
      const tracked = join(root, "libs", "inner", "escaped.py");
      symlinkSync(join(outside, "outsider.py"), tracked);
      try {
        expect(readWorkspaceFile(root, "libs/inner/escaped.py")).toBeNull();
      } finally {
        rmSync(tracked, { force: true });
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
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

describe("the two package.json facts, read off the real tree", () => {
  it("writes the entry points and the two-manifest union onto the node, and neither from config", () => {
    // The fail-closed fields the entry-point exemptions and
    // `noTransitiveDependencies` turn on (`../rules/topology.mjs`), populated
    // the way upstream populates its answers: from `package.json` files on
    // disk, never from anything the graph was told.
    const index = buildWorkspaceIndex({ root, tsConfig: "tsconfig.base.json" });

    expect(index.graph.nodes.gadgets.data.entryPoints).toEqual([
      { path: "libs/gadgets/models", file: "libs/gadgets/src/models.ts" },
    ]);
    expect(index.graph.nodes.gadgets.data.declaredPackages).toEqual(["direct-dep", "local-dep"]);
    // A project with no manifest of its own: the root manifest alone grants
    // declared packages, and nothing can grant entry points — absent, so the
    // rule layer keeps failing closed for it.
    expect(index.graph.nodes.consumer.data.declaredPackages).toEqual(["direct-dep"]);
    expect(index.graph.nodes.consumer.data).not.toHaveProperty("entryPoints");
  });
});

describe("the verdict an editor shows once the package facts are populated", () => {
  const config = {
    depConstraints: [{ sourceTag: "zone:site", onlyDependOnLibsWithTags: ["zone:site"] }],
    options: {
      allow: [],
      buildTargets: ["build"],
      enforceBuildableLibDependency: false,
      allowCircularSelfDependency: false,
      checkDynamicDependenciesExceptions: [],
      ignoredCircularDependencies: [],
      banTransitiveDependencies: true,
      checkNestedExternalImports: false,
    },
  };

  // Positions computed from the fixture, 0-based (`./diagnostics.mjs`); the
  // offset the analyzer records is the specifier literal's opening quote.
  const indexLines = GADGETS_INDEX_TS.split("\n");
  const transitiveLine = indexLines.findIndex((line) => line.includes("transitive-dep"));
  const transitiveCharacter = indexLines[transitiveLine].indexOf('"');

  it("flags only the undeclared package as transitive, from the union of both manifests", () => {
    // Both directions at once: losing the `transitive-dep` diagnostic would be
    // `declaredPackages` over-populated — a silently waived report upstream
    // makes — and a diagnostic on `direct-dep` or `local-dep` would mean one
    // of the two manifests was not read, the pre-change false alarm.
    const index = buildWorkspaceIndex({ root, tsConfig: "tsconfig.base.json" });
    const { analyzed, diagnostics } = diagnoseDocument({
      sourceFile: "libs/gadgets/src/index.ts",
      text: GADGETS_INDEX_TS,
      index,
      config,
    });

    expect(analyzed).toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe("noTransitiveDependencies");
    expect(diagnostics[0].range.start).toEqual({
      line: transitiveLine,
      character: transitiveCharacter,
    });
  });

  it("exempts the secondary-entry-point self-import and still flags the barrel one", () => {
    // `feature.ts` is upstream's `belongsToDifferentEntryPoint` escape hatch —
    // the pre-change false alarm `entryPoints` removes — and the clean list is
    // a CLAIM this suite may only make beside the barrel import still being
    // caught, because that pair is what proves the exemption did not over-fire.
    const index = buildWorkspaceIndex({ root, tsConfig: "tsconfig.base.json" });
    const feature = diagnoseDocument({
      sourceFile: "libs/gadgets/src/deep/feature.ts",
      text: FEATURE_TS,
      index,
      config,
    });
    const barrel = diagnoseDocument({
      sourceFile: "libs/gadgets/src/barrel-user.ts",
      text: BARREL_TS,
      index,
      config,
    });

    expect(feature.analyzed).toBe(true);
    expect(feature.diagnostics).toEqual([]);
    expect(barrel.analyzed).toBe(true);
    expect(barrel.diagnostics).toHaveLength(1);
    expect(barrel.diagnostics[0].code).toBe("noSelfCircularDependencies");
    expect(barrel.diagnostics[0].range.start).toEqual({
      line: 0,
      character: BARREL_TS.indexOf('"'),
    });
  });
});

// C1 (cubic): before `buildWorkspaceIndex` drove `../providers/native/`'s own
// `discover()`/`buildGraph()`, a `lattice.json` root was still read through
// `discoverProjects`, which finds a project only by its `project.json` — the
// file a native workspace is not required to have at all. A declared project
// with none was silently absent from the graph, an import into it resolved as
// an external package, and the rule engine's npm branch returned clean before
// any tag check ran: the exact silent-empty-index shape `AGENTS.md`'s
// invariant refuses. This describe block is a SEPARATE real tree from the one
// above — an Nx-shaped fixture and a `lattice.json`-shaped one cannot share a
// root, because `buildWorkspaceIndex` picks its branch by which marker file
// the root carries.
describe("a native lattice.json workspace, driven through the real provider", () => {
  let nativeRoot;

  const INNER_GO = 'package inner\n\nimport "native.test/outer"\n';

  const write2 = (relativePath, text) => {
    const absolute = join(nativeRoot, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text, "utf8");
  };

  const config = {
    depConstraints: [{ sourceTag: "zone:inner", onlyDependOnLibsWithTags: ["zone:inner"] }],
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

  beforeAll(() => {
    nativeRoot = mkdtempSync(join(tmpdir(), "lattice-native-index-"));
    // Two declared projects, NEITHER with a `project.json` — the whole point
    // of `lattice.json` is not needing one, and it is the case
    // `discoverProjects` cannot see at all.
    writeFileSync(
      join(nativeRoot, "lattice.json"),
      JSON.stringify({
        projects: {
          declared: [
            { root: "apps/inner", tags: ["zone:inner"] },
            { root: "apps/outer", tags: ["zone:outer"] },
          ],
        },
      }),
    );
    write2("apps/inner/go.mod", "module native.test/inner\n\ngo 1.23\n");
    write2("apps/inner/main.go", INNER_GO);
    write2("apps/outer/go.mod", "module native.test/outer\n\ngo 1.23\n");
    write2("apps/outer/outer.go", "package outer\n");
    execFileSync("git", ["init", "-q"], { cwd: nativeRoot, env: environmentForTree() });
    execFileSync("git", ["add", "-A"], { cwd: nativeRoot, env: environmentForTree() });
  });

  afterAll(() => {
    if (nativeRoot) rmSync(nativeRoot, { recursive: true, force: true });
  });

  it("discovers a declared project with no project.json and diagnoses a real violation into it", () => {
    const index = buildWorkspaceIndex({ root: nativeRoot });

    expect(index.nativeMarker).toBe(true);
    expect(index.nativeModelFailure).toBeNull();
    expect(Object.keys(index.graph.nodes).sort()).toEqual(["inner", "outer"]);
    expect(index.graph.dependencies.inner).toEqual([
      { source: "inner", target: "outer", type: "static" },
    ]);

    const lines = INNER_GO.split("\n");
    const importLine = lines.findIndex((line) => line.includes("native.test/outer"));
    const importCharacter = lines[importLine].indexOf('"');

    const { analyzed, diagnostics } = diagnoseDocument({
      sourceFile: "apps/inner/main.go",
      text: INNER_GO,
      index,
      config,
    });

    // The red-direction proof: before the fix, `apps/outer` was absent from
    // `graph.nodes` entirely, the import resolved as an external package, and
    // this list was `[]` — an editor showing a clean file for a real crossing.
    expect(analyzed).toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe("onlyTagsConstraintViolation");
    expect(diagnostics[0].range.start).toEqual({ line: importLine, character: importCharacter });
  });

  it("flags a declared implicit dependency across a tag boundary, like check does", () => {
    // A-F07: an `implicitDependencies` edge has no import site behind it, so
    // `evaluate()` over this document's import sites can never see it — and
    // `../../cli.mjs`'s `check` still exits 1 on it
    // (`../commands/edge-constraints.mjs`'s `declaredEdgeViolationsForCheck`).
    // The LSP used to paint the declaring project clean. A separate root, so
    // the graph here carries only the declared edge: `inner` declares a
    // dependency on `outer` and both are declared projects in `lattice.json`,
    // but `outer` sits outside `inner`'s only-depends-on set.
    const implicitRoot = mkdtempSync(join(tmpdir(), "lattice-native-implicit-"));
    const write3 = (relativePath, text) => {
      const absolute = join(implicitRoot, relativePath);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, text, "utf8");
    };
    try {
      writeFileSync(
        join(implicitRoot, "lattice.json"),
        JSON.stringify({
          projects: {
            declared: [
              {
                root: "apps/inner",
                tags: ["zone:inner"],
                implicitDependencies: ["outer"],
              },
              { root: "apps/outer", tags: ["zone:outer"] },
            ],
          },
        }),
      );
      write3("apps/inner/go.mod", "module implicit.test/inner\n\ngo 1.23\n");
      write3("apps/inner/main.go", "package inner\n");
      write3("apps/outer/go.mod", "module implicit.test/outer\n\ngo 1.23\n");
      write3("apps/outer/outer.go", "package outer\n");
      execFileSync("git", ["init", "-q"], { cwd: implicitRoot, env: environmentForTree() });
      execFileSync("git", ["add", "-A"], { cwd: implicitRoot, env: environmentForTree() });

      const index = buildWorkspaceIndex({ root: implicitRoot });

      expect(index.graph.dependencies.inner).toEqual([
        { source: "inner", target: "outer", type: "implicit" },
      ]);

      const { analyzed, diagnostics } = diagnoseDocument({
        sourceFile: "apps/inner/main.go",
        text: "package inner\n",
        index,
        config,
      });

      // The red-direction proof: before the fold, `declaredEdgeViolationsForCheck`
      // was called only from `cli.mjs`, and this list was `[]` — an editor
      // painting clean the project `check` exits 1 on. The whole-file range is
      // the project-level finding this file is the stand-in for.
      expect(analyzed).toBe(true);
      expect(diagnostics.some((d) => d.code === "onlyTagsConstraintViolation")).toBe(true);
      expect(diagnostics[0].range.start).toEqual({ line: 0, character: 0 });
    } finally {
      rmSync(implicitRoot, { recursive: true, force: true });
    }
  });

  it("still dispatches natively when lattice.json exists on disk but git does not track it", () => {
    // The dispatch-parity bug (S-bug C): `buildWorkspaceIndex` used to gate the
    // native branch on `files.includes(LATTICE_MODEL_FILE)` — `files` being
    // git's TRACKED list — while `../../cli.mjs`'s dispatch
    // (`../commands/context.mjs`'s `markersAt`) and this server's own
    // `readWorkspaceOptions` (`./server.mjs`'s `markersAt`) both gate on
    // `existsSync`, plain filesystem presence. An existing-but-untracked
    // `lattice.json` — written to the tree but never `git add`ed — passes the
    // CLI's test and fails the old index's, so `lattice check` on this exact
    // tree exits 1 on the real crossing while the editor fell through to
    // `discoverProjects`, found no `project.json` for a native-only tree, and
    // published `analyzed: true` with an empty diagnostic list — a clean file
    // for a real violation. The red direction: with the old `files.includes`
    // gate, `nativeMarker` here is `false`, `graph.nodes` is empty, and the
    // `diagnoseDocument` call below returns `analyzed: true, diagnostics: []`.
    const untrackedRoot = mkdtempSync(join(tmpdir(), "lattice-native-untracked-"));
    const write4 = (relativePath, text) => {
      const absolute = join(untrackedRoot, relativePath);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, text, "utf8");
    };
    try {
      write4("apps/inner/go.mod", "module native.test/inner\n\ngo 1.23\n");
      write4("apps/inner/main.go", INNER_GO);
      write4("apps/outer/go.mod", "module native.test/outer\n\ngo 1.23\n");
      write4("apps/outer/outer.go", "package outer\n");
      execFileSync("git", ["init", "-q"], { cwd: untrackedRoot, env: environmentForTree() });
      // Every file is staged EXCEPT lattice.json, added last and deliberately
      // left out — the exact state a developer is in the moment they create
      // one and have not yet run `git add`.
      execFileSync("git", ["add", "-A"], { cwd: untrackedRoot, env: environmentForTree() });
      writeFileSync(
        join(untrackedRoot, "lattice.json"),
        JSON.stringify({
          projects: {
            declared: [
              { root: "apps/inner", tags: ["zone:inner"] },
              { root: "apps/outer", tags: ["zone:outer"] },
            ],
          },
        }),
      );

      const index = buildWorkspaceIndex({ root: untrackedRoot });

      expect(index.nativeMarker).toBe(true);
      expect(index.nativeModelFailure).toBeNull();
      expect(Object.keys(index.graph.nodes).sort()).toEqual(["inner", "outer"]);

      const { analyzed, diagnostics } = diagnoseDocument({
        sourceFile: "apps/inner/main.go",
        text: INNER_GO,
        index,
        config,
      });

      expect(analyzed).toBe(true);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].code).toBe("onlyTagsConstraintViolation");
    } finally {
      rmSync(untrackedRoot, { recursive: true, force: true });
    }
  });

  it("refuses to call a document analyzed when lattice.json itself is broken", () => {
    // A second, independently broken root: `projects.declared[0].root` points
    // at a directory with no tracked file under it at all, which
    // `discoverNativeProjects` refuses rather than silently drop the project.
    // Before this fix, `buildWorkspaceIndex` had no branch that could even
    // reach that throw for a `lattice.json` root — this proves it is now
    // caught into `nativeModelFailure` rather than crashing the server or
    // (the silent direction) never running the check at all.
    const brokenRoot = mkdtempSync(join(tmpdir(), "lattice-native-broken-"));
    try {
      writeFileSync(
        join(brokenRoot, "lattice.json"),
        JSON.stringify({ projects: { declared: [{ root: "apps/ghost" }] } }),
      );
      mkdirSync(join(brokenRoot, "apps"), { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: brokenRoot, env: environmentForTree() });
      execFileSync("git", ["add", "-A"], { cwd: brokenRoot, env: environmentForTree() });

      const index = buildWorkspaceIndex({ root: brokenRoot });

      expect(index.nativeMarker).toBe(true);
      expect(index.nativeModelFailure).toBeTruthy();
      expect(Object.keys(index.graph.nodes)).toEqual([]);

      const { analyzed, diagnostics } = diagnoseDocument({
        sourceFile: "README.md",
        text: "# nothing to see\n",
        index,
        config,
      });

      // The other half of the same proof: a broken model must not read as a
      // clean, empty tree. `analyzed: true` here would be exactly that — every
      // open document in this workspace showing zero diagnostics regardless of
      // what it imports, because the model that would have caught it never
      // built at all.
      expect(analyzed).toBe(false);
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0].message).toContain("lattice.json");
    } finally {
      rmSync(brokenRoot, { recursive: true, force: true });
    }
  });
});

// #223: a `.moon`-rooted workspace fell through to `discoverProjects` — which
// finds a project only by its `project.json`, a file a Moon workspace never
// has — and built a zero-node index that published `analyzed: true` with an
// empty diagnostic list on a tree `lattice check` exits 1 on. The branch below
// drives the same provider object `check` resolves
// (`../providers/moon.mjs`'s `readProjectGraph`), injected here because the
// fixture has no Moon binary — everything else, git and the Go analyzer
// included, is real. A separate root from the two above: the branch is picked
// by which marker the root carries, so the three shapes cannot share a tree.
describe("a .moon workspace, populated through the same provider seam check holds", () => {
  let moonRoot;

  const INNER_GO = 'package inner\n\nimport "moon.test/outer"\n';

  const writeM = (relativePath, text) => {
    const absolute = join(moonRoot, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text, "utf8");
  };

  const config = {
    depConstraints: [{ sourceTag: "zone:inner", onlyDependOnLibsWithTags: ["zone:inner"] }],
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

  /** The graph shape `transformMoonGraph` emits for this fixture's two projects. */
  const moonGraph = () => ({
    nodes: {
      inner: {
        name: "inner",
        type: "lib",
        data: { root: "apps/inner", tags: ["zone:inner"], implicitDependencies: [] },
      },
      outer: {
        name: "outer",
        type: "lib",
        data: { root: "apps/outer", tags: ["zone:outer"], implicitDependencies: [] },
      },
    },
    dependencies: {},
  });

  beforeAll(() => {
    moonRoot = mkdtempSync(join(tmpdir(), "lattice-moon-index-"));
    writeM(".moon/workspace.yml", "projects:\n  inner: apps/inner\n  outer: apps/outer\n");
    writeM("apps/inner/go.mod", "module moon.test/inner\n\ngo 1.23\n");
    writeM("apps/inner/main.go", INNER_GO);
    writeM("apps/outer/go.mod", "module moon.test/outer\n\ngo 1.23\n");
    writeM("apps/outer/outer.go", "package outer\n");
    execFileSync("git", ["init", "-q"], { cwd: moonRoot, env: environmentForTree() });
    execFileSync("git", ["add", "-A"], { cwd: moonRoot, env: environmentForTree() });
  });

  afterAll(() => {
    if (moonRoot) rmSync(moonRoot, { recursive: true, force: true });
  });

  it("judges a violating import the way check does, instead of publishing clean", () => {
    // The red-direction proof (#223): before the Moon branch, `graph.nodes`
    // here was `{}`, the import resolved as an external package, and the
    // diagnose call below returned `analyzed: true, diagnostics: []` — an
    // editor painting clean the file `lattice check` exits 1 on.
    const index = buildWorkspaceIndex({ root: moonRoot, readGraph: moonGraph });

    expect(index.nativeMarker).toBe(false);
    expect(Object.keys(index.graph.nodes).sort()).toEqual(["inner", "outer"]);
    // The import-derived edge, folded onto Moon's declared-only graph by the
    // merge `check` runs (`../providers/moon.mjs`'s `mergeImportEdges`):
    expect(index.graph.dependencies.inner).toEqual([
      { source: "inner", target: "outer", type: "static" },
    ]);
    expect(indexGaps(index)).toEqual([]);

    const lines = INNER_GO.split("\n");
    const importLine = lines.findIndex((line) => line.includes("moon.test/outer"));
    const importCharacter = lines[importLine].indexOf('"');

    const { analyzed, diagnostics } = diagnoseDocument({
      sourceFile: "apps/inner/main.go",
      text: INNER_GO,
      index,
      config,
    });

    expect(analyzed).toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe("onlyTagsConstraintViolation");
    expect(diagnostics[0].range.start).toEqual({ line: importLine, character: importCharacter });
  });

  it("reports a failing provider invocation as a gap, never as a clean empty index", () => {
    // The other half of the same invariant: `moon project-graph --json`
    // failing (binary missing, nonzero exit) leaves zero nodes, and a
    // zero-node graph judges every file clean — so the failure must reach the
    // document as a named gap, not as silence.
    const index = buildWorkspaceIndex({
      root: moonRoot,
      readGraph: () => {
        throw new Error(
          `lattice: \`moon project-graph --json\` failed in ${moonRoot}: spawn moon ENOENT`,
        );
      },
    });
    expect(index.moonModelFailure).toContain("spawn moon ENOENT");

    const { analyzed, diagnostics } = diagnoseDocument({
      sourceFile: "apps/inner/main.go",
      text: INNER_GO,
      index,
      config,
    });

    expect(analyzed).toBe(false);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0].message).toContain("`moon project-graph --json`");
  });

  it("refuses a root carrying both .moon and .config/moon, naming both directories", () => {
    // #224 through the LSP's own dispatch: the same refusal `resolveCommandContext`
    // makes, from the same one dispatcher (`../providers/moon.mjs`'s
    // `moonMarkerAt`). Red direction: against the old silent preference, the
    // index builds against `.config/moon` without a word about `.moon`.
    writeM(".config/moon/workspace.yml", "projects:\n");
    try {
      expect(() => buildWorkspaceIndex({ root: moonRoot, readGraph: moonGraph })).toThrow(
        /declares both \.moon and \.config\/moon/u,
      );
    } finally {
      rmSync(join(moonRoot, ".config"), { recursive: true, force: true });
    }
  });
});
