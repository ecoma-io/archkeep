#!/usr/bin/env node
// Builds the VS Code extension's .vsix — from a staging directory, and the
// staging directory is the mechanism, not a convenience.
//
// WHY not `vsce package` in the source tree, measured against @vscode/vsce
// 3.9.2 under pnpm 11.20.0 rather than assumed: vsce decides which production
// dependencies belong in the package by running `npm list --production` in the
// extension directory, and against pnpm's symlinked `node_modules` that command
// exits with ELSPROBLEMS — npm follows each symlink into `.pnpm/`, reads every
// package's own manifest there, and reports the dev dependencies pnpm never
// installed as "missing". The packaging fails outright. The other spelling,
// `vsce package --no-dependencies`, produces a vsix with NO `node_modules` at
// all — and this extension imports `vscode-languageclient` at runtime, so that
// package installs, activates, and dies on its first import.
//
// So this script rebuilds the extension the way an outsider would hold it, the
// same move `verify-package.mjs` makes for the npm package: copy the tracked
// files into a throwaway directory, `npm install --omit=dev` there so the
// runtime tree is the flat npm-shaped one vsce knows how to walk, and run vsce
// against that. `scripts/verify-vsix.mjs` then opens the result and asserts the
// language client actually made it in — the check that goes red if either
// failure mode above ever comes back by another route.
//
// The LICENSE and the icon are both copied in from the repository root, each
// because the extension directory does not hold its own copy: the LICENSE
// because vsce refuses to pack without one outside of a TTY (it prompts
// interactively; in CI the prompt is a failure), the icon because the brand
// logo lives once at `.github/assets/logo.png` and the `icon` a manifest names
// has to resolve inside the extension root for vsce to pack it. One copy of
// each, staged at pack time, rather than second tracked copies.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const [packageArg, outArg] = process.argv.slice(2);
if (!packageArg || !outArg) {
  console.error("usage: package-vsix.mjs <package-directory> <output-vsix>");
  process.exit(2);
}
const packageDir = resolve(root, packageArg);
const outFile = resolve(root, outArg);

/** Runs a command with an argument array, capturing everything. */
function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}

/** Fails loudly with the child's own words — a packaging step that half-ran
 *  and said nothing would hand the verify gate a stale vsix to bless. */
function must(result, label) {
  if (result.status === 0 && !result.error) return result;
  console.error(result.stdout ?? "");
  console.error(result.stderr ?? "");
  if (result.error) console.error(String(result.error));
  console.error(`${label} failed, so there is no .vsix to hand on.`);
  process.exit(1);
}

// The file list comes from git, not a directory walk: the source tree carries
// `node_modules` and Nx cache state that must not be staged, and a walk would
// need its own ignore rules that drift from `.gitignore`. `-z` so a filename
// with a newline cannot smuggle a second entry.
const listed = must(run("git", ["ls-files", "-z"], packageDir), "`git ls-files`");
const tracked = listed.stdout.split("\0").filter((name) => name.length > 0);
if (tracked.length === 0) {
  console.error(`git tracks no files under ${packageDir}, so there is nothing to package.`);
  process.exit(1);
}

// `realpathSync` because macOS hands out a symlinked temp directory and vsce
// records absolute paths while packing.
const staging = realpathSync(mkdtempSync(join(tmpdir(), "package-vsix-")));

let exitCode = 0;
try {
  for (const name of tracked) {
    const target = join(staging, name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(packageDir, name), target);
  }
  copyFileSync(join(root, "LICENSE"), join(staging, "LICENSE"));
  copyFileSync(join(root, ".github/assets/logo.png"), join(staging, "icon.png"));

  // `--omit=dev` is the point: what installs here is exactly the runtime tree
  // the extension host will see. `--ignore-scripts` because nothing in this
  // dependency chain needs a build step, and an install script that arrives in
  // a new transitive release should not get to run inside CI just for packing.
  console.log(`staging ${tracked.length} tracked files, installing runtime dependencies…`);
  must(
    run(
      "npm",
      ["install", "--omit=dev", "--no-package-lock", "--ignore-scripts", "--no-audit", "--no-fund"],
      staging,
    ),
    "`npm install --omit=dev` in the staging directory",
  );

  // vsce resolved from the extension's own devDependencies — the pinned version
  // the repository declares, not whatever is ambient on the runner.
  const requireFromPackage = createRequire(join(packageDir, "package.json"));
  const vsceManifestPath = requireFromPackage.resolve("@vscode/vsce/package.json");
  const vsceManifest = JSON.parse(readFileSync(vsceManifestPath, "utf8"));
  const vsceBin = join(dirname(vsceManifestPath), vsceManifest.bin.vsce);

  mkdirSync(dirname(outFile), { recursive: true });
  const packed = must(
    run(process.execPath, [vsceBin, "package", "--out", outFile], staging),
    "`vsce package`",
  );
  process.stdout.write(packed.stdout ?? "");
  process.stderr.write(packed.stderr ?? "");

  // vsce exiting 0 without writing the file would otherwise read as success
  // right up until the verify gate opens a vsix from some earlier run.
  if (!existsSync(outFile)) {
    console.error(`vsce exited 0 but ${outFile} does not exist. Nothing was packaged.`);
    exitCode = 1;
  } else {
    console.log(`packaged ${outFile} (${statSync(outFile).size} bytes)`);
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}
process.exit(exitCode);
