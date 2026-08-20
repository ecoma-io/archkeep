#!/usr/bin/env node
// Proves the packed artifact works for someone who is not this workspace.
//
// WHY this exists, and it is not a hypothetical. Before this script, the
// package's manifest declared zero dependencies and every gate was green:
// `typescript` and `smol-toml` live in the repository root's manifest, pnpm
// hoists them, and Node walks up to find them. Published as-is it would have
// installed cleanly and thrown at the first `import ts from "typescript"`. No
// test in the suite could see that, because every one of them runs where the
// thing it needs is already there.
//
// The same blind spot hid a second defect: both executables decided "was I run
// or imported?" by comparing `process.argv[1]` to `import.meta.url` as URLs.
// pnpm's `node_modules/@scope/pkg` is a symlink, so that comparison is false in
// an installed tree — the language server started, read nothing, and exited 0.
// Silence that looks like success is the one failure this repository exists to
// refuse, and it survived every existing test because they all drive the source
// tree or a generated bin shim, both of which hand Node the resolved path.
//
// So the checks below are the questions a consumer's first hour asks, in
// the order they get asked, against a real `pnpm pack` tarball installed into a
// throwaway workspace with a tag vocabulary nothing in `src/` knows about:
//
//   1. Nx loads the plugin and draws an edge Nx cannot infer on its own.
//   2. The checker exits 0 on a clean tree, and says what it inspected.
//   3. The language server answers an `initialize` frame when launched through
//      the symlinked path an installed plugin is launched by.
//   4. `graph` exits 0 on a clean tree and states project and edge counts.
//   5. `graph --format json` produces a valid JSON envelope with the correct
//      command name and schema version.
//   6. `diff` against a self-baseline exits 0 and reports no changes.
//   7. The checker exits 1 on a violating tree — a gate only proves it runs when
//      it can go red, so the clean direction alone would prove nothing.
//   8. The checker exits 3 on a run that cannot look — the can't-look state must
//      never read as clean (see `cli.mjs`'s exit contract), and it is proven
//      here against the installed tarball, not only in source-tree tests.
//   9. A shipped policy pack, named out of the installed tarball by the
//      `profiles` path `docs/usage/presets.md` documents, is the law that
//      judges the tree — exit 1, with the profile and its registry named in the
//      report. The packs are otherwise only ever read from this repository's
//      own tree, where `presets/` is present whether or not the manifest ships
//      it and where `profiles` never resolves through a pnpm symlink.
//
// The `pnpm pack` tarball above is also compared, by file selection, against
// `npm pack --dry-run` of the same tree: the lane verifies the pnpm tarball and
// publishes with `npm publish`, which re-packs — so a divergence between the two
// selections would ship bytes the lane never verified. The check pins them
// agreeing today (audit H-F11) rather than trusting a measurement.
//
// Checks 4-6 run before check 7 so that graph/diff prove the clean installed
// artifact. A boundary violation is not a graph or diff finding, so the
// commands would exit 0 either way — but checking the clean tree first is what
// makes the assertion meaningful: "graph works" is strongest when the tree is
// known to be clean, not merely when it happens to still produce output.
//
// A second, native-provider workspace runs the SAME questions 2, 4-6, 7, 3
// again, against a `lattice.json` root instead of an `nx.json` one, with no
// `nx` package installed at all. Before this addition, the native provider added
// by this package's M2 had been proven correct only against fixtures this
// tool's own tests built — a synthetic tree constructed in-process
// (`../packages/lattice/src/providers/native/discover.test.mjs` and friends)
// or co-located under the package itself
// (`../packages/lattice/src/providers/native/differential.integration.test.mjs`).
// None of that is what questions 2-3 above actually answer for the Nx path: a
// real `pnpm pack` tarball, installed into a workspace this repository never
// built, with a tag vocabulary nothing in `src/` has seen. The native
// consumer below is that same real proof, aimed at the provider Oracle 1 does
// not reach — and it exists to catch the same class of defect `verify-package.mjs`
// was written for in the first place: a manifest or an entry point that only
// works because this workspace's own tree happens to have already provided
// what a fresh install would not.
//
// Run from CI on every pull request, so a manifest that stops resolving fails
// the change that broke it; run again in the release lane before `npm publish`,
// because a version that resolves nothing cannot be unpublished away.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The fixture's own boundary law. Two tags this repository does not use, so a
 * pass here cannot be coming from anything the tool hardcoded about its home.
 *
 * All eight `moduleBoundaryOptions` are stated because the loader requires
 * every one explicitly — it defaults nothing, since a default would be a second
 * copy of a value the workspace's own config already states.
 */
const BOUNDARY_CONFIG = `export const depConstraints = [
  { sourceTag: "layer:core", onlyDependOnLibsWithTags: ["layer:core"] },
  { sourceTag: "layer:app", onlyDependOnLibsWithTags: ["layer:app", "layer:core"] },
];

export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};

export const boundarySuppressions = [];
`;

/**
 * A consumer workspace: two Go projects where the graph edge Nx cannot infer
 * runs from the permitted side, so the tree starts clean and one file turns it
 * dirty.
 *
 * The fixture asks for `typescript` and `nx` by RANGE rather than by pin, read
 * from the package's own `peerDependencies`, so what installs here is what a
 * consumer obeying the manifest would get. That is not a detail: the first run
 * of this script asked for `typescript: "*"`, pnpm supplied 7.0.2, and all four
 * checks below failed — TypeScript 7 is the native port and exports none of the
 * compiler API this tool delegates resolution to. The manifest said `>=5`. The
 * manifest was wrong, and nothing in the suite could say so, because this
 * workspace pins 5.9.3 for itself and every test ran against that. Resolving
 * the fixture's dependencies from the declared range is what makes this script
 * able to catch the next one.
 *
 * @param {string} packageName the name to depend on, read from the manifest
 * @param {Record<string, string>} peers the package's declared peer ranges
 * @param {string} packageManager this repository's own pnpm pin, so the fixture
 *   installs under the version CI installs under rather than whatever is ambient
 * @returns {Record<string, string>} relative path to contents
 */
function fixtureFiles(packageName, peers, packageManager) {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "consumer",
        private: true,
        type: "module",
        // Not decoration, and measured: without this the fixture installs under
        // whatever pnpm is on PATH, because it lives in a temp directory where
        // this repository's own pin cannot reach it. This machine had 10.34.5
        // ambient and CI runs 11.20.0, and the two DISAGREE about undecided
        // build scripts — 10 warns and installs, 11 fails the install. So the
        // `allowBuilds` omission below was green here and red there, and worse,
        // so was its absence: reverting the fix locally still passed 6/6.
        // Deriving the pin from the root manifest is what makes a local run and
        // a CI run able to reach the same verdict at all.
        packageManager,
        devDependencies: {
          [packageName]: "*",
          nx: peers.nx,
          typescript: peers.typescript,
        },
      },
      null,
      2,
    )}\n`,
    // `${packageName}/nx`, not the bare package name: the root export is the
    // engine (`index.mjs`), whose only Nx-shaped export is a
    // `createDependencies` that throws, naming this exact misregistration —
    // only the `./nx` subpath is the working Nx-plugin face Nx is meant to
    // load (`packages/lattice/nx.mjs`).
    "nx.json": `${JSON.stringify(
      {
        plugins: [
          {
            plugin: `${packageName}/nx`,
            options: { boundaryConfig: "module-boundaries.config.mjs" },
          },
        ],
      },
      null,
      2,
    )}\n`,
    "module-boundaries.config.mjs": BOUNDARY_CONFIG,
    // The second commit below happens after `pnpm install`, and `git add -A`
    // would otherwise walk an installed tree of thousands of files — including
    // the package under test, whose own sources would then be read as fixture
    // files by the very checker being verified.
    ".gitignore": "node_modules/\n.nx/\n",
    "libs/core/project.json": `${JSON.stringify(
      { name: "core", projectType: "library", tags: ["layer:core"] },
      null,
      2,
    )}\n`,
    "libs/core/go.mod": "module example.test/core\n\ngo 1.22\n",
    "libs/core/core.go": 'package core\n\nconst Name = "core"\n',
    "libs/app/project.json": `${JSON.stringify(
      { name: "app", projectType: "library", tags: ["layer:app"] },
      null,
      2,
    )}\n`,
    "libs/app/go.mod":
      "module example.test/app\n\ngo 1.22\n\nrequire example.test/core v0.0.0\n\n" +
      "replace example.test/core => ../core\n",
    "libs/app/app.go": 'package app\n\nimport "example.test/core"\n\nvar _ = core.Name\n',
  };
}

/**
 * The same two-project shape as `fixtureFiles`, described as a native
 * workspace instead: `lattice.json` at the root, no `nx.json`, no
 * `project.json` per project — native discovery reads the project list from
 * `lattice.json` itself — and critically no `nx` package requested at all,
 * so what installs here proves the peer is optional in fact, not only in the
 * manifest's `peerDependenciesMeta`.
 *
 * `module-boundaries.config.mjs` is a `.mjs` file at the root, inside no
 * project's directory, and `.mjs` is an analyzable extension
 * (`../packages/lattice/src/analysis/analyze.mjs`'s `LANGUAGE_BY_EXTENSION`).
 * Left unwaived it would be an unclaimed-file coverage failure — a question
 * the Nx path never asks (`../packages/lattice/src/providers/native/coverage.mjs`'s
 * header) — turning what should read as a clean tree into a false one, so
 * `lattice.json`'s own `coverage.exempt` waives it, the same waiver
 * `../packages/lattice/src/providers/native/differential.integration.test.mjs`
 * uses for the identical file.
 *
 * @param {string} packageName the name to depend on, read from the manifest
 * @param {Record<string, string>} peers the package's declared peer ranges
 * @param {string} packageManager this repository's own pnpm pin, so the fixture
 *   installs under the version CI installs under rather than whatever is ambient
 * @returns {Record<string, string>} relative path to contents
 */
function fixtureFilesNative(packageName, peers, packageManager) {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "consumer-native",
        private: true,
        type: "module",
        packageManager,
        // No `nx` entry — see the header above.
        devDependencies: {
          [packageName]: "*",
          typescript: peers.typescript,
        },
      },
      null,
      2,
    )}\n`,
    "lattice.json": `${JSON.stringify(
      {
        boundaryConfig: "module-boundaries.config.mjs",
        projects: {
          declared: [
            { root: "libs/core", name: "core", tags: ["layer:core"] },
            { root: "libs/app", name: "app", tags: ["layer:app"] },
          ],
        },
        coverage: {
          exempt: [
            {
              path: "module-boundaries.config.mjs",
              reason: "workspace tooling config at the root, not itself a project",
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    "module-boundaries.config.mjs": BOUNDARY_CONFIG,
    ".gitignore": "node_modules/\n.nx/\n",
    "libs/core/go.mod": "module example.test/core\n\ngo 1.22\n",
    "libs/core/core.go": 'package core\n\nconst Name = "core"\n',
    "libs/app/go.mod":
      "module example.test/app\n\ngo 1.22\n\nrequire example.test/core v0.0.0\n\n" +
      "replace example.test/core => ../core\n",
    "libs/app/app.go": 'package app\n\nimport "example.test/core"\n\nvar _ = core.Name\n',
  };
}

/**
 * The same two-project shape as `fixtureFiles`, described as a Moon workspace
 * instead: `.moon/workspace.yml` at the root, per-project `moon.yml` files,
 * and `@moonrepo/cli` as a dev dependency — no `nx.json`, no `project.json`.
 *
 * Moon tags use dash separators (`layer-core`) rather than colons because
 * Moon's tag validation rejects colons. The boundary config uses the same
 * dash format the Moon provider emits verbatim from `moon.yml` tags.
 *
 * The `@moonrepo/cli` version is pinned so the Moon provider can find the
 * binary via the consumer's `node_modules/.bin/moon`. A TypeScript
 * `tsconfig.base.json` provides the path aliases Lattice resolves against.
 *
 * @param {string} packageName the name to depend on, read from the manifest
 * @param {Record<string, string>} peers the package's declared peer ranges
 * @param {string} packageManager this repository's own pnpm pin, so the fixture
 *   installs under the version CI installs under rather than whatever is ambient
 * @returns {Record<string, string>} relative path to contents
 */
function fixtureFilesMoon(packageName, peers, packageManager) {
  // Moon tags cannot contain colons — use dash separators.
  const boundaryConfigMoon = `export const depConstraints = [
  { sourceTag: "layer-core", onlyDependOnLibsWithTags: ["layer-core"] },
  { sourceTag: "layer-app", onlyDependOnLibsWithTags: ["layer-app", "layer-core"] },
];

export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};

export const boundarySuppressions = [];
`;

  return {
    "package.json": `${JSON.stringify(
      {
        name: "consumer-moon",
        private: true,
        type: "module",
        packageManager,
        // No `nx` — Moon is the workspace tool, not Nx.
        devDependencies: {
          [packageName]: "*",
          typescript: peers.typescript,
          "@moonrepo/cli": "2.4.6",
        },
      },
      null,
      2,
    )}\n`,
    "pnpm-workspace.yaml": "packages:\n  - 'libs/*'\nallowBuilds:\n  lefthook: false\n",
    ".moon/workspace.yml":
      "projects:\n" +
      "  core: 'libs/core'\n" +
      "  app: 'libs/app'\n" +
      "vcs:\n" +
      "  provider: other\n",
    "module-boundaries.config.mjs": boundaryConfigMoon,
    "tsconfig.base.json": `${JSON.stringify(
      {
        compilerOptions: {
          module: "nodenext",
          moduleResolution: "nodenext",
          paths: {
            "@acme/core": ["./libs/core/src/index.ts"],
            "@acme/app": ["./libs/app/src/index.ts"],
          },
        },
      },
      null,
      2,
    )}\n`,
    ".gitignore": "node_modules/\n.moon/cache/\n",
    "libs/core/moon.yml":
      "id: core\n" +
      "language: typescript\n" +
      "layer: library\n" +
      "stack: backend\n" +
      "tags:\n" +
      "  - layer-core\n",
    "libs/core/src/index.ts": 'export const core = "core";\n',
    "libs/core/go.mod": "module example.test/core\n\ngo 1.22\n",
    "libs/core/core.go": 'package core\n\nconst Name = "core"\n',
    "libs/app/moon.yml":
      "id: app\n" +
      "language: typescript\n" +
      "layer: library\n" +
      "stack: backend\n" +
      "tags:\n" +
      "  - layer-app\n" +
      "dependsOn:\n" +
      "  - core\n",
    "libs/app/src/index.ts": 'import { core } from "@acme/core";\n\nexport const app = core;\n',
    "libs/app/go.mod":
      "module example.test/app\n\ngo 1.22\n\nrequire example.test/core v0.0.0\n\n" +
      "replace example.test/core => ../core\n",
    "libs/app/app.go": 'package app\n\nimport "example.test/core"\n\nvar _ = core.Name\n',
  };
}

/** The file that makes the Moon tree dirty: `core` reaching up into `app`.
 *  The clean tree has app→core (valid under the tag constraint). To avoid
 *  creating a cycle that would fire noCircularDependencies before the tag
 *  constraint, we also replace app's source and manifest so that app no
 *  longer imports core — only the one-direction core→app violation remains. */
const VIOLATING_FILES_MOON = {
  "libs/core/src/index.ts": 'import { app } from "@acme/app";\n\nexport const core = app;\n',
  "libs/core/go.mod":
    "module example.test/core\n\ngo 1.22\n\nrequire example.test/app v0.0.0\n\n" +
    "replace example.test/app => ../app\n",
  "libs/core/violate.go": 'package core\n\nimport "example.test/app"\n\nvar _ = app.Thing\n',
  "libs/app/moon.yml":
    "id: app\n" +
    "language: typescript\n" +
    "layer: library\n" +
    "stack: backend\n" +
    "tags:\n" +
    "  - layer-app\n",
  "libs/app/src/index.ts": 'export const app = "app";\n',
  "libs/app/go.mod": "module example.test/app\n\ngo 1.22\n",
  "libs/app/app.go": 'package app\n\nconst Thing = "app"\n',
};

/** The file that makes the Nx/native tree dirty: `core` reaching up into `app`. */
const VIOLATING_FILES = {
  "libs/core/go.mod":
    "module example.test/core\n\ngo 1.22\n\nrequire example.test/app v0.0.0\n\n" +
    "replace example.test/app => ../app\n",
  "libs/core/violate.go": 'package core\n\nimport "example.test/app"\n\nvar _ = app.Thing\n',
  "libs/app/app.go": 'package app\n\nconst Thing = "app"\n',
};

const failures = [];
const note = (text) => console.log(text);

/** Two sorted name lists are the same file selection. */
function packsEqual(a, b) {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

/** Records a failure with the evidence, rather than throwing on the first one. */
function check(label, ok, evidence) {
  if (ok) {
    note(`ok   ${label}`);
    return true;
  }
  note(`FAIL ${label}`);
  failures.push(`${label}\n${evidence}`);
  return false;
}

/** Runs a command in the fixture, capturing everything. */
function run(command, args, cwd, extraEnv = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NX_DAEMON: "false", ...extraEnv },
  });
}

const write = (base, files) => {
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(base, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, "utf8");
  }
};

/**
 * `git add -A` + commit, shared by both consumers below — `-c` for identity
 * rather than config, since CI runners have no `user.email` set. `fresh`
 * runs `git init` first; the tool reads its file list from `git ls-files`
 * (never a directory walk), so a workspace with nothing committed yet is an
 * empty workspace as far as either provider is concerned.
 *
 * @param {string} consumer
 * @param {string} message
 * @param {boolean} fresh
 */
function commitTree(consumer, message, fresh) {
  if (fresh) run("git", ["init", "-q"], consumer);
  run("git", ["add", "-A"], consumer);
  run(
    "git",
    [
      "-c",
      "user.name=verify-package",
      "-c",
      "user.email=verify-package@invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      message,
    ],
    consumer,
  );
}

/**
 * Checks 2 and 3 from the header: clean-tree verdict and language server
 * handshake. Run while the tree is still clean, before graph/diff checks
 * (4-6) and before the violating mutation (7).
 *
 * @param {string} consumer absolute path to the installed consumer workspace
 * @param {string} label appended to each check's message
 * @param {string} packageName read from the tarball's own manifest
 */
function verifyCleanAndLspChecks(consumer, label, packageName) {
  // 2. The checker exits 0 on the clean tree, and states what it inspected —
  //    "no violations" is a claim about coverage too, so a 0 that inspected
  //    nothing is the same silence as no check at all. The counts are matched
  //    as NON-ZERO rather than merely present: an earlier draft of this fixture
  //    never committed, `git ls-files` returned nothing, and the checker
  //    truthfully reported "no violations (0 imports in 0 files)" — which a
  //    `/\d+ import/` test passes.
  const clean = run("pnpm", ["exec", "lattice", "check"], consumer);
  check(
    `the checker exits 0 on a clean tree (${label})`,
    clean.status === 0,
    `exit ${clean.status}\n${clean.stdout ?? ""}${clean.stderr ?? ""}`,
  );
  check(
    `the clean verdict states it inspected something, not merely that it inspected (${label})`,
    /[1-9]\d* import/.test(clean.stdout ?? "") &&
      /[1-9]\d* file/.test(clean.stdout ?? "") &&
      /[1-9]\d* project/.test(clean.stdout ?? ""),
    `stdout: ${clean.stdout ?? "(empty)"}`,
  );
  // The packed artifact's JSON envelope carries the canonical decision: a
  // structurally clean, fully read tree emits `pass`. The four-state
  // vocabulary is what every governance capability consumes, so the contract
  // is pinned against the real installed tarball, not only against fixtures.
  const cleanJson = run("pnpm", ["exec", "lattice", "check", "--format", "json"], consumer);
  let cleanEnvelope = null;
  try {
    cleanEnvelope = JSON.parse(cleanJson.stdout ?? "");
  } catch {
    // Will fail the check below.
  }
  check(
    `check --format json carries a pass decision on the clean tree (${label})`,
    cleanEnvelope !== null &&
      cleanEnvelope.status === "ok" &&
      cleanEnvelope.schemaVersion === 2 &&
      cleanEnvelope.decision?.verdict === "pass",
    `exit ${cleanJson.status}\nstdout: ${cleanJson.stdout ?? "(empty)"}`,
  );

  // 3. The language server answers when launched through the symlinked path.
  //    `node_modules/<name>` is a symlink into `node_modules/.pnpm/…`, and the
  //    Claude Code plugin manifest launches `${CLAUDE_PLUGIN_ROOT}/lsp.mjs` by
  //    path with no bin shim in between to resolve it. This is the spelling that
  //    made the server exit 0 having published nothing.
  const server = join(consumer, "node_modules", packageName, "lsp.mjs");
  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { processId: process.pid, rootUri: `file://${consumer}`, capabilities: {} },
  });
  // spawnSync direct, rather than through `run`: this is the one call that needs
  // a frame on stdin, and widening `run` for a single caller would make its shape
  // about this call instead of about the environment every call shares.
  const lsp = spawnSync(process.execPath, [server], {
    cwd: consumer,
    encoding: "utf8",
    input: `Content-Length: ${Buffer.byteLength(initialize)}\r\n\r\n${initialize}`,
    env: { ...process.env, NX_DAEMON: "false" },
    timeout: 60_000,
  });
  check(
    `the language server answers initialize when launched through a symlink (${label})`,
    (lsp.stdout ?? "").includes('"serverInfo"'),
    `exit ${lsp.status}\nstdout: ${lsp.stdout || "(empty)"}\nstderr: ${lsp.stderr || "(empty)"}` +
      `\n\nAn empty stdout here is the defect this check exists for: the process started, ` +
      `read nothing, and exited 0. See src/entry-point.mjs.`,
  );

  // 8. Exit 3 — a run that cannot look must never read as a clean tree. The
  //    packed artifact is driven through clean→0 and violating→1, but between
  //    them sits the can't-look state, and before this check it was proven
  //    only in source-tree integration tests, never against the tarball the
  //    lane actually ships. A regression that made "cannot look" return 0
  //    would ship green on the exact silent direction this repository exists
  //    to refuse. The cwd is a sibling of the consumer — no workspace marker
  //    anywhere above it, which a path inside the consumer could never be —
  //    and the CLI is the installed artifact's own `cli.mjs` run by absolute
  //    path, so this proves the packed bytes answer 3 on no-verdict, never 0.
  const nowhere = join(dirname(consumer), "lattice-no-workspace");
  mkdirSync(nowhere, { recursive: true });
  const cannotLook = run(
    process.execPath,
    [join(consumer, "node_modules", packageName, "cli.mjs"), "check"],
    nowhere,
  );
  check(
    `the checker exits 3 on a run that cannot look (${label})`,
    cannotLook.status === 3,
    `exit ${cannotLook.status}\n${cannotLook.stdout ?? ""}${cannotLook.stderr ?? ""}\n\n` +
      `The can't-look exit is the state that must never be mistaken for an inspected ` +
      `clean tree: value 3 on no-verdict, never 0.`,
  );
}

/**
 * Check 9 from the header: a shipped policy pack, selected BY NAME out of the
 * installed tarball, is the law that judges the tree.
 *
 * Everything the packs have otherwise been proven by reads them from this
 * repository's own source tree (`../packages/lattice/src/governance/presets.integration.test.mjs`,
 * and the fingerprint pin beside it), where `presets/` is present whether or
 * not `package.json` was ever told to publish it, and where `profiles` never
 * has to name a path through `node_modules`. Two things only a real install can
 * answer therefore had no gate: that the pack file is reachable at the path
 * `../docs/usage/presets.md` tells a consumer to write, and that the containment
 * check on the `profiles` option accepts it — pnpm makes
 * `node_modules/<pkg>` a symlink into `node_modules/.pnpm`, and that read is the
 * one the option resolves through.
 *
 * This runs LAST on the Nx consumer and deliberately reuses the tree check 7
 * already made violating, so the lane pays one `nx reset` and one `check` rather
 * than a fourth install. Profile selection is Nx-only — the option lives in
 * `nx.json`'s plugin options and nowhere else, which is why neither the native
 * nor the Moon consumer runs this.
 *
 * `core` is retagged into the pack's own vocabulary so the edge check 7 built
 * (`core` reaching up into `app`) is one the pack's rows can see: under
 * `hexagonal`, `layer:domain` may depend on `layer:domain` alone, so
 * domain → app is a violation, while the `app` → `core` edge the fixture has
 * carried all along stays legal under the pack's `layer:app` row. Exit 1 is
 * therefore a claim about the PACK's rows, not a leftover from the workspace's
 * own `module-boundaries.config.mjs`, which this step stops naming entirely.
 *
 * @param {string} consumer absolute path to the installed Nx consumer workspace
 * @param {string} label appended to each check's message
 * @param {string} packageName the installed package's name, from the manifest
 */
function verifyPresetSelectedCheck(consumer, label, packageName) {
  const registry = `node_modules/${packageName}/presets/hexagonal.json`;
  write(consumer, {
    "libs/core/project.json": `${JSON.stringify(
      { name: "core", projectType: "library", tags: ["layer:domain"] },
      null,
      2,
    )}\n`,
    "nx.json": `${JSON.stringify(
      {
        plugins: [
          {
            plugin: `${packageName}/nx`,
            // `boundaryConfig` is a profile NAME here, never a filename: the
            // moment `profiles` is set the two spellings do not mix
            // (`../docs/concepts/profiles.md`). The workspace's own
            // module-boundaries.config.mjs is left on disk and no longer named
            // by anything, so a verdict below can only have come from the pack.
            options: { boundaryConfig: "hexagonal", profiles: registry },
          },
        ],
      },
      null,
      2,
    )}\n`,
  });
  commitTree(consumer, "select the shipped hexagonal pack by name", false);
  run("pnpm", ["exec", "nx", "reset"], consumer);

  const judged = run("pnpm", ["exec", "lattice", "check"], consumer);
  const output = `${judged.stdout ?? ""}${judged.stderr ?? ""}`;
  check(
    `a shipped pack installed from the tarball judges the tree, exit 1 (${label})`,
    judged.status === 1,
    `exit ${judged.status}\nprofiles: ${registry}\n${output || "(no output)"}`,
  );
  // The verdict alone would not say WHICH law produced it. A run that silently
  // fell back to the workspace's own config would also exit 1 here, and read
  // identically — so the report has to name the profile and the file it came
  // from before this check means anything.
  check(
    `the report names the profile and the installed registry it was read from (${label})`,
    /profile "hexagonal"/.test(output) && output.includes(registry),
    output || "(no output)",
  );
  // And the finding has to be the PACK's. Exit 1 is reachable from several
  // classes a check counts — a dead tsconfig alias, go.work drift — none of
  // which would prove a shipped row ran. So this pins the row itself: the
  // constraint the pack ships, at the position check 7's file put it.
  check(
    `the finding is the pack's own row, at its file:line:column (${label})`,
    output.includes("onlyTagsConstraintViolation") &&
      /libs\/core\/violate\.go:\d+:\d+/.test(output) &&
      output.includes("sourceTag layer:domain → onlyDependOnLibsWithTags [layer:domain]"),
    output || "(no output)",
  );
}

/**
 * Check 7 from the header: the checker exits 1 on a violating tree.
 * Run AFTER graph/diff checks (4-6) so those proved the clean artifact first.
 *
 * @param {string} consumer absolute path to the installed consumer workspace
 * @param {string} label appended to each check's message
 * @param {() => void} [afterViolatingCommit] run after the violating tree is
 *   committed but before the checker sees it — the Nx consumer uses this to
 *   reset Nx's own cache, which the native provider has none of.
 */
function verifyViolatingCheck(
  consumer,
  label,
  afterViolatingCommit,
  violatingFiles = VIOLATING_FILES,
) {
  // 7. And exits 1 on a violating one, naming the rule and the position.
  write(consumer, violatingFiles);
  commitTree(consumer, "core reaches up into app", false);
  afterViolatingCommit?.();
  const dirty = run("pnpm", ["exec", "lattice", "check"], consumer);
  const dirtyOutput = `${dirty.stdout ?? ""}${dirty.stderr ?? ""}`;
  check(
    `the checker exits 1 on a violating tree (${label})`,
    dirty.status === 1,
    `exit ${dirty.status}\n${dirtyOutput}`,
  );
  check(
    `the violation names its rule and its file:line:column (${label})`,
    dirtyOutput.includes("onlyTagsConstraintViolation") &&
      /libs\/core\/violate\.go:\d+:\d+/.test(dirtyOutput),
    dirtyOutput || "(no output)",
  );
  // The violating tree's envelope carries the `fail` decision — the verdict
  // the four-state vocabulary gives a run with findings, agreeing with the
  // three-state status the way status and exitCode agree.
  const dirtyJson = run("pnpm", ["exec", "lattice", "check", "--format", "json"], consumer);
  let dirtyEnvelope = null;
  try {
    dirtyEnvelope = JSON.parse(dirtyJson.stdout ?? "");
  } catch {
    // Will fail the check below.
  }
  check(
    `check --format json carries a fail decision on the violating tree (${label})`,
    dirtyEnvelope !== null &&
      dirtyEnvelope.status === "findings" &&
      dirtyEnvelope.schemaVersion === 2 &&
      dirtyEnvelope.decision?.verdict === "fail",
    `exit ${dirtyJson.status}\nstdout: ${dirtyJson.stdout ?? "(empty)"}`,
  );
}

/**
 * Checks 4-6: `graph` and `diff` verification. These run while the tree is
 * still clean — before check 7 introduces violating files — so that the
 * assertions prove the clean installed artifact, not merely that the commands
 * still produce output on a dirty tree. A boundary violation is not a graph
 * or diff finding, so the commands would exit 0 either way, but checking the
 * clean tree first is what makes the assertion meaningful.
 *
 * Per `SPEC-m5b-graph-and-diff.md` §6, these checks live on the native path
 * because that is the only place in this repository where the new commands are
 * driven from a real `pnpm pack` tarball installed into a tree this repository
 * never built, with no Nx present to fall back on — the same reason the native
 * consumer exists at all. The Nx path's check 1 already proves the plugin
 * loads; graph/diff add no new Nx-specific surface.
 *
 * @param {string} consumer absolute path to the native consumer workspace
 * @param {string} label appended to each check's message
 */
function verifyGraphDiffChecks(consumer, label) {
  // 4. `graph` exits 0 on a clean tree and states the project and edge counts.
  const graphClean = run("pnpm", ["exec", "lattice", "graph"], consumer);
  check(
    `graph exits 0 on a clean tree (${label})`,
    graphClean.status === 0,
    `exit ${graphClean.status}\n${graphClean.stdout ?? ""}${graphClean.stderr ?? ""}`,
  );
  check(
    `graph states project and edge counts on a clean tree (${label})`,
    /[1-9]\d* project/.test(graphClean.stdout ?? "") &&
      /[1-9]\d* edge/.test(graphClean.stdout ?? ""),
    `stdout: ${graphClean.stdout ?? "(empty)"}`,
  );

  // 5. `graph --format json` produces a valid JSON envelope with command "graph".
  const graphJson = run("pnpm", ["exec", "lattice", "graph", "--format", "json"], consumer);
  let graphEnvelope = null;
  try {
    graphEnvelope = JSON.parse(graphJson.stdout ?? "");
  } catch {
    // Will fail the check below.
  }
  check(
    `graph --format json produces a valid JSON envelope (${label})`,
    graphEnvelope !== null &&
      graphEnvelope.command === "graph" &&
      graphEnvelope.schemaVersion === 2 &&
      Array.isArray(graphEnvelope.result?.projects) &&
      Array.isArray(graphEnvelope.result?.dependencies),
    `exit ${graphJson.status}\nstdout: ${graphJson.stdout ?? "(empty)"}`,
  );

  // 6. `diff` against the same tree (self-baseline) exits 0 and reports no changes.
  //    First, capture a baseline snapshot with `graph --format json --output`.
  const baselineFile = join(consumer, "baseline-snapshot.json");
  const graphOutput = run(
    "pnpm",
    ["exec", "lattice", "graph", "--format", "json", "--output", baselineFile],
    consumer,
  );
  check(
    `graph --output writes a baseline file for diff (${label})`,
    graphOutput.status === 0 && existsSync(baselineFile),
    `exit ${graphOutput.status}\nstderr: ${graphOutput.stderr ?? "(empty)"}`,
  );
  const diffSelf = run("pnpm", ["exec", "lattice", "diff", baselineFile], consumer);
  check(
    `diff against a self-baseline exits 0 (${label})`,
    diffSelf.status === 0,
    `exit ${diffSelf.status}\n${diffSelf.stdout ?? ""}${diffSelf.stderr ?? ""}`,
  );
  check(
    `diff against a self-baseline reports no changes (${label})`,
    (diffSelf.stdout ?? "").includes("no changes"),
    `stdout: ${diffSelf.stdout ?? "(empty)"}`,
  );
}

const packageDir = resolve(root, process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: verify-package.mjs <package-directory>");
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const packageName = manifest.name;

// `realpathSync` because macOS hands out a symlinked temp directory, and check 4
// below is precisely about a symlinked path being told apart from a real one.
const workdir = realpathSync(mkdtempSync(join(tmpdir(), "verify-package-")));
const packDir = join(workdir, "pack");
const consumer = join(workdir, "consumer");
const consumerNative = join(workdir, "consumer-native");
mkdirSync(packDir);
mkdirSync(consumer);
mkdirSync(consumerNative);

let exitCode = 0;
try {
  note(`packing ${packageName} from ${process.argv[2]}`);
  const packed = run("pnpm", ["pack", "--pack-destination", packDir], packageDir);
  if (packed.status !== 0) {
    console.error(packed.stdout ?? "");
    console.error(packed.stderr ?? "");
    console.error("`pnpm pack` failed, so there is no artifact to verify.");
    process.exit(1);
  }
  const tarball = readdirSync(packDir).find((entry) => entry.endsWith(".tgz"));
  if (!tarball) {
    console.error(`\`pnpm pack\` reported success but wrote no .tgz into ${packDir}.`);
    process.exit(1);
  }

  // The lane verifies the `pnpm pack` tarball below, then `npm publish`
  // rebuilds its own tarball on the way out (the release lane's own comment
  // names the measured difference: npm does not copy the repository-root
  // LICENSE the way `pnpm pack` does, which is why the package holds its own
  // copy). Nothing pins those two file selections agreeing, and the audit
  // measured them set-identical today (111 files). "Measured today" is a
  // claim, not a gate: this check pins the agreement here, so a manifest edit
  // that makes npm select different files than pnpm breaks the change that
  // caused it instead of shipping bytes the lane never verified. The parity
  // asserted is selection parity: npm and pnpm must agree on which files
  // ship. Contents are not hashed here — `npm publish` re-packs from the same
  // tracked tree the pnpm tarball came from, so a selection divergence is the
  // drift this check pins.
  //
  // `tar -tzf` reads the pnpm tarball's entry names; `npm pack --dry-run
  // --json` is npm's own selection of the same tree. The two order their
  // entries differently (locale-correct sorting is not a byte-stable
  // contract), so both sides are compared as sorted SETS after stripping the
  // `package/` prefix pnpm's tarball carries.
  const packParity = (() => {
    const listing = run("tar", ["-tzf", join(packDir, tarball)], packageDir, {
      LC_ALL: "C",
    });
    const pnpmNames = (listing.stdout ?? "")
      .split("\n")
      .map((entry) => entry.replace(/\/$/, "").replace(/^package\//, ""))
      .filter(Boolean)
      .sort();

    const dryRun = run("npm", ["pack", "--dry-run", "--json"], packageDir, {
      LC_ALL: "C",
    });
    let npmNames = [];
    try {
      const json = JSON.parse(dryRun.stdout ?? "");
      npmNames = (json[0]?.files ?? []).map((file) => file.path).sort();
    } catch {
      // Will fail the check below.
    }

    const identical =
      listing.status === 0 && dryRun.status === 0 && packsEqual(pnpmNames, npmNames);
    return { identical, pnpmNames, npmNames, listing, dryRun };
  })();

  check(
    "npm and pnpm select the same files from the same tree — the verified bytes are the published bytes",
    packParity.identical,
    `pnpm pack lists ${packParity.pnpmNames.length}; npm pack lists ${packParity.npmNames.length}\n` +
      (packParity.listing.status === 0 ? "" : `tar exited ${packParity.listing.status}\n`) +
      (packParity.dryRun.status === 0 ? "" : `npm dry-run exited ${packParity.dryRun.status}\n`) +
      `pnpm-only: ${packParity.pnpmNames.filter((n) => !packParity.npmNames.includes(n)).join(", ") || "(none)"}\n` +
      `npm-only: ${packParity.npmNames.filter((n) => !packParity.pnpmNames.includes(n)).join(", ") || "(none)"}`,
  );

  const peers = manifest.peerDependencies ?? {};
  const packageManager = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ).packageManager;
  const tarballRef = JSON.stringify(`file:${join(packDir, tarball)}`);

  const files = fixtureFiles(packageName, peers, packageManager);
  files["package.json"] = files["package.json"].replace('"*"', tarballRef);
  write(consumer, files);
  // `allowBuilds` is not decoration here. pnpm 11 blocks every dependency
  // install script until the workspace decides on it, and FAILS the install
  // while any decision is missing — `ERR_PNPM_IGNORED_BUILDS`, exit 1, after
  // the tree is already correctly on disk. So without these two lines the
  // fixture install aborts and this script reports that the tarball "could not
  // be installed", which is a true sentence about a workspace that is fine.
  //
  // Measured, and the measurement is why the fixture pins `packageManager`
  // above: this ran green locally and red in CI because the two ran different
  // pnpm majors, and pnpm 10 only warns where 11 fails. The values match the
  // repository's own `pnpm-workspace.yaml` and the reasoning lives there — nx's
  // postinstall builds a native watcher and warms a daemon this fixture runs
  // with disabled, and lefthook's installs git hooks into a throwaway tree.
  writeFileSync(
    join(consumer, "pnpm-workspace.yaml"),
    "packages: []\nallowBuilds:\n  lefthook: false\n  nx: false\n",
    "utf8",
  );

  // The fixture is a COMMITTED git tree because the tool reads its file list
  // from `git ls-files` — never a directory walk, which would need ignore rules
  // that drift from `.gitignore`. `ls-files` lists tracked files only, so a
  // `git init` with nothing committed yields an empty workspace, and the
  // checker then reports "no violations (0 imports in 0 files)" on a tree that
  // violates: green, and meaningless. Measured here rather than reasoned — the
  // first version of this script did exactly that and check 3 caught it.
  commitTree(consumer, "the clean tree", true);

  const installed = run("pnpm", ["install", "--no-frozen-lockfile"], consumer);
  if (installed.status !== 0) {
    console.error(installed.stdout ?? "");
    console.error(installed.stderr ?? "");
    console.error("the packed tarball could not be installed into a fresh workspace (Nx path).");
    process.exit(1);
  }
  note(`installed into ${consumer}`);

  // 1. The plugin loads inside a real Nx process and draws the Go edge.
  const graphFile = join(workdir, "graph.json");
  const graphed = run("pnpm", ["exec", "nx", "graph", `--file=${graphFile}`], consumer);
  let edges = "graph was not produced";
  let drewEdge = false;
  if (graphed.status === 0) {
    const graph = JSON.parse(readFileSync(graphFile, "utf8"));
    const dependencies = graph.graph?.dependencies ?? {};
    edges = JSON.stringify(dependencies);
    drewEdge = (dependencies.app ?? []).some((edge) => edge.target === "core");
  } else {
    edges = `${graphed.stdout ?? ""}\n${graphed.stderr ?? ""}`;
  }
  check(
    "Nx draws the Go edge app -> core, which Nx cannot infer on its own",
    drewEdge,
    `dependencies: ${edges}`,
  );

  verifyCleanAndLspChecks(consumer, "Nx path", packageName);
  verifyViolatingCheck(consumer, "Nx path", () => run("pnpm", ["exec", "nx", "reset"], consumer));

  // 9. A shipped pack, selected by name out of the installed tarball, is the
  //    law. Last on this consumer because it re-points `nx.json` at the pack
  //    and reuses the tree check 7 already made violating.
  verifyPresetSelectedCheck(consumer, "Nx path", packageName);

  // --- the native consumer: same physical shape, `lattice.json` instead of
  // `nx.json`, no `nx` requested at all. See this file's header for why this
  // is not redundant with `differential.integration.test.mjs`'s Oracle 1.
  const filesNative = fixtureFilesNative(packageName, peers, packageManager);
  filesNative["package.json"] = filesNative["package.json"].replace('"*"', tarballRef);
  write(consumerNative, filesNative);
  writeFileSync(
    join(consumerNative, "pnpm-workspace.yaml"),
    "packages: []\nallowBuilds:\n  lefthook: false\n",
    "utf8",
  );
  commitTree(consumerNative, "the clean tree", true);

  const installedNative = run("pnpm", ["install", "--no-frozen-lockfile"], consumerNative);
  if (installedNative.status !== 0) {
    console.error(installedNative.stdout ?? "");
    console.error(installedNative.stderr ?? "");
    console.error(
      "the packed tarball could not be installed into a fresh workspace (native path).",
    );
    process.exit(1);
  }
  note(`installed into ${consumerNative}`);

  // 5. `nx` was never asked for, and none resolves — the peer is optional in
  //    fact, not only in `peerDependenciesMeta`. A native workspace that had
  //    to install Nx anyway to run this tool would be the M2 pivot's whole
  //    premise failing quietly at install time.
  const nativeModules = existsSync(join(consumerNative, "node_modules"))
    ? readdirSync(join(consumerNative, "node_modules"))
    : [];
  check(
    "no nx package resolves in the native consumer — the peer is optional in fact",
    !nativeModules.includes("nx"),
    `node_modules entries: ${nativeModules.join(", ") || "(none)"}`,
  );

  verifyCleanAndLspChecks(consumerNative, "native path", packageName);

  // 4-6. `graph` and `diff` from a clean installed tarball — native path only.
  // Per SPEC-m5b-graph-and-diff.md §6, these checks prove the commands work
  // against a real `pnpm pack` tarball installed into a tree this repository
  // never built, with no Nx present to fall back on. They run before the
  // violating mutation (check 7) so the assertions prove the clean artifact.
  verifyGraphDiffChecks(consumerNative, "native path");

  // 7. The checker exits 1 on a violating tree (native path).
  verifyViolatingCheck(consumerNative, "native path");

  // --- the Moon consumer: `.moon/workspace.yml` at the root, per-project
  // `moon.yml` files, `@moonrepo/cli` as a dev dependency — no `nx.json`,
  // no `project.json`. This is the third provider face the package ships,
  // and these checks prove it works against a real `pnpm pack` tarball
  // installed into a tree with Moon as the workspace orchestrator.
  const consumerMoon = join(workdir, "consumer-moon");
  mkdirSync(consumerMoon);

  const filesMoon = fixtureFilesMoon(packageName, peers, packageManager);
  filesMoon["package.json"] = filesMoon["package.json"].replace('"*"', tarballRef);
  write(consumerMoon, filesMoon);
  commitTree(consumerMoon, "the clean tree", true);

  const installedMoon = run("pnpm", ["install", "--no-frozen-lockfile"], consumerMoon);
  if (installedMoon.status !== 0) {
    console.error(installedMoon.stdout ?? "");
    console.error(installedMoon.stderr ?? "");
    console.error("the packed tarball could not be installed into a fresh workspace (Moon path).");
    process.exit(1);
  }
  note(`installed into ${consumerMoon}`);

  // The Moon provider finds the `moon` binary through the consumer's own
  // `node_modules/.bin/moon`, so `@moonrepo/cli` must resolve.
  const moonBin = existsSync(join(consumerMoon, "node_modules", ".bin", "moon"));
  check(
    "the moon CLI binary is present in the Moon consumer's node_modules/.bin",
    moonBin,
    `node_modules/.bin/moon ${moonBin ? "exists" : "missing"}`,
  );

  verifyCleanAndLspChecks(consumerMoon, "Moon path", packageName);

  // `graph` and `diff` from a clean Moon consumer — the same checks the
  // native path runs, proving the commands work against a Moon workspace.
  verifyGraphDiffChecks(consumerMoon, "Moon path");

  // The checker exits 1 on a violating Moon tree, using the Moon-violating
  // files (which include a TypeScript violation the Nx/native files lack).
  verifyViolatingCheck(consumerMoon, "Moon path", undefined, VIOLATING_FILES_MOON);
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("");
  for (const failure of failures) console.error(`✗ ${failure}\n`);
  console.error(
    `${failures.length} of the checks above failed. The package is not installable as ` +
      `published, whatever this repository's own suite says.`,
  );
  exitCode = 1;
}
process.exit(exitCode);
