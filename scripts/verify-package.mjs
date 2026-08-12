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
// So the checks below are the four questions a consumer's first hour asks, in
// the order they get asked, against a real `pnpm pack` tarball installed into a
// throwaway workspace with a tag vocabulary nothing in `src/` knows about:
//
//   1. Nx loads the plugin and draws an edge Nx cannot infer on its own.
//   2. The checker exits 0 on a clean tree, and says what it inspected.
//   3. The checker exits 1 on a violating one — a gate only proves it runs when
//      it can go red, so the clean direction alone would prove nothing.
//   4. The language server answers an `initialize` frame when launched through
//      the symlinked path an installed plugin is launched by.
//
// Run from CI on every pull request, so a manifest that stops resolving fails
// the change that broke it; run again in the release lane before `npm publish`,
// because a version that resolves nothing cannot be unpublished away.

import { spawnSync } from "node:child_process";
import {
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

/** The file that makes the tree dirty: `core` reaching up into `app`. */
const VIOLATING_FILES = {
  "libs/core/go.mod":
    "module example.test/core\n\ngo 1.22\n\nrequire example.test/app v0.0.0\n\n" +
    "replace example.test/app => ../app\n",
  "libs/core/violate.go": 'package core\n\nimport "example.test/app"\n\nvar _ = app.Thing\n',
  "libs/app/app.go": 'package app\n\nconst Thing = "app"\n',
};

const failures = [];
const note = (text) => console.log(text);

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
mkdirSync(packDir);
mkdirSync(consumer);

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

  const files = fixtureFiles(
    packageName,
    manifest.peerDependencies ?? {},
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager,
  );
  files["package.json"] = files["package.json"].replace(
    '"*"',
    JSON.stringify(`file:${join(packDir, tarball)}`),
  );
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
  //
  // `-c` for identity rather than config: CI runners have no `user.email`, and
  // a commit that fails leaves the same empty tree this comment is about.
  const commit = (message) => {
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
  };
  run("git", ["init", "-q"], consumer);
  commit("the clean tree");

  const installed = run("pnpm", ["install", "--no-frozen-lockfile"], consumer);
  if (installed.status !== 0) {
    console.error(installed.stdout ?? "");
    console.error(installed.stderr ?? "");
    console.error("the packed tarball could not be installed into a fresh workspace.");
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

  // 2. The checker exits 0 on the clean tree, and states what it inspected —
  //    "no violations" is a claim about coverage too, so a 0 that inspected
  //    nothing is the same silence as no check at all. The counts are matched
  //    as NON-ZERO rather than merely present: an earlier draft of this fixture
  //    never committed, `git ls-files` returned nothing, and the checker
  //    truthfully reported "no violations (0 imports in 0 files)" — which a
  //    `/\d+ import/` test passes.
  const clean = run("pnpm", ["exec", "lattice", "check"], consumer);
  check(
    "the checker exits 0 on a clean tree",
    clean.status === 0,
    `exit ${clean.status}\n${clean.stdout ?? ""}${clean.stderr ?? ""}`,
  );
  check(
    "the clean verdict states it inspected something, not merely that it inspected",
    /[1-9]\d* import/.test(clean.stdout ?? "") &&
      /[1-9]\d* file/.test(clean.stdout ?? "") &&
      /[1-9]\d* project/.test(clean.stdout ?? ""),
    `stdout: ${clean.stdout ?? "(empty)"}`,
  );

  // 3. And exits 1 on a violating one, naming the rule and the position.
  write(consumer, VIOLATING_FILES);
  commit("core reaches up into app");
  run("pnpm", ["exec", "nx", "reset"], consumer);
  const dirty = run("pnpm", ["exec", "lattice", "check"], consumer);
  const dirtyOutput = `${dirty.stdout ?? ""}${dirty.stderr ?? ""}`;
  check(
    "the checker exits 1 on a violating tree",
    dirty.status === 1,
    `exit ${dirty.status}\n${dirtyOutput}`,
  );
  check(
    "the violation names its rule and its file:line:column",
    dirtyOutput.includes("onlyTagsConstraintViolation") &&
      /libs\/core\/violate\.go:\d+:\d+/.test(dirtyOutput),
    dirtyOutput || "(no output)",
  );

  // 4. The language server answers when launched through the symlinked path.
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
    "the language server answers initialize when launched through a symlink",
    (lsp.stdout ?? "").includes('"serverInfo"'),
    `exit ${lsp.status}\nstdout: ${lsp.stdout || "(empty)"}\nstderr: ${lsp.stderr || "(empty)"}` +
      `\n\nAn empty stdout here is the defect this check exists for: the process started, ` +
      `read nothing, and exited 0. See src/entry-point.mjs.`,
  );
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
