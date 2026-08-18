#!/usr/bin/env node
// Opens a built .vsix and asserts what an install actually needs is inside.
//
// WHY this is its own gate rather than trust in `vsce package` exiting 0: the
// packaging script builds from a staging directory precisely because vsce and
// pnpm's symlinked `node_modules` disagree (see package-vsix.mjs), and every
// failure mode of that arrangement is silent at pack time. A staging install
// that quietly omitted the runtime dependency, a `.vscodeignore` line that
// started swallowing `src/`, a stale vsix left over from an earlier run — each
// produces a file that exists, has a plausible size, and dies only in the
// extension host of whoever installed it. The extension imports
// `vscode-languageclient` the moment it activates, so a vsix without that tree
// installs cleanly and breaks on first use, which is the exact shape of failure
// this repository refuses to ship.
//
// So this script lists the archive, reads the manifest packaged inside it, and
// judges both against the source manifest — the facts arrive as arguments to
// `evaluateVsix`, which decides everything and touches nothing, so the tests in
// verify-vsix.test.mjs run with no zip file and no filesystem. Run in CI on
// every pull request against the freshly packaged vsix, and again in the
// release lane against the exact bytes about to be uploaded and published.
//
// UNIX-ONLY: this script shells out to `unzip` by PATH, and stock Windows does
// not ship it. That is a deliberate constraint, not an oversight — a Windows
// vsix-verify leg would need a zip reader this repository does not want to
// carry. Nothing here claims otherwise: every CI and release job runs
// `ubuntu-latest` (`.github/workflows/ci.yml`, `release.yml`), and this
// script is not Windows-runnable by design.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The packages a module's static imports actually require, by name.
 *
 * This exists so the dependency checks below can start from the code rather
 * than from the manifest: a manifest that lost `vscode-languageclient` while
 * keeping some other dependency still hands the checks a nonempty list, and
 * every one of them passes while the extension dies on its first import. The
 * requirement has to come from the importer.
 *
 * Relative specifiers are packaged as files, `node:` builtins ship with the
 * host's Node, and `vscode` itself is provided by the extension host and
 * cannot appear in any package — so all three are excluded, and what remains
 * is exactly what an install must carry. Subpaths collapse to the package
 * name (`vscode-languageclient/node` → `vscode-languageclient`).
 *
 * @param {string} source module text
 * @returns {string[]} unique package names, in first-import order
 */
export function importedPackages(source) {
  const specifiers = [];
  for (const statement of source.matchAll(
    /(?:^|\n)[ \t]*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|(?:^|\n)[ \t]*import\s*["']([^"']+)["']/g,
  )) {
    specifiers.push(statement[1] ?? statement[2]);
  }
  const names = specifiers
    .filter(
      (s) => !s.startsWith(".") && !s.startsWith("/") && !s.startsWith("node:") && s !== "vscode",
    )
    .map((s) => (s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0]));
  return [...new Set(names)];
}

/**
 * Judges a vsix by its entry list and packaged manifest, against the source
 * manifest and the decision modules the source tree holds. Pure: every fact
 * arrives as an argument, nothing here opens a file.
 *
 * @param {object} input
 * @param {string[]} input.entries every entry name in the archive
 * @param {Record<string, any>} input.packagedManifest `extension/package.json` from inside the vsix
 * @param {Record<string, any>} input.sourceManifest the extension's own package.json
 * @param {string[]} input.decisionModules `src/*.mjs` paths the source tree ships, relative to the package
 * @param {string[]} input.entryImports package names the entry point's own imports require, from `importedPackages`
 * @returns {{lines: string[], failures: string[]}}
 */
export function evaluateVsix({
  entries,
  packagedManifest,
  sourceManifest,
  decisionModules,
  entryImports,
}) {
  const lines = [];
  const failures = [];
  const has = (name) => entries.includes(name);
  const check = (label, ok, evidence) => {
    if (ok) {
      lines.push(`ok   ${label}`);
    } else {
      lines.push(`FAIL ${label}`);
      failures.push(`${label}\n${evidence}`);
    }
  };

  // The entry point the manifest names. `./extension.mjs` → `extension/extension.mjs`.
  const main = `extension/${String(sourceManifest.main ?? "").replace(/^\.\//, "")}`;
  check(
    `the entry point ${main} is in the package`,
    Boolean(sourceManifest.main) && has(main),
    `manifest main: ${JSON.stringify(sourceManifest.main)}; a vsix without its entry point installs and never activates.`,
  );

  // Every decision module the source tree ships. The list is read from the
  // source tree by the caller, not hardcoded here, so a module added tomorrow
  // is required tomorrow — a fixed list would vouch for files it never met.
  check(
    `all ${decisionModules.length} decision modules under src/ are in the package`,
    decisionModules.length > 0 && decisionModules.every((m) => has(`extension/${m}`)),
    decisionModules.length === 0
      ? "the caller handed no decision modules, so nothing was actually asserted — that is a failure, not a pass."
      : `missing: ${decisionModules.filter((m) => !has(`extension/${m}`)).join(", ")}`,
  );

  // No test files. `.vscodeignore` is what keeps them out, and this is the
  // check that notices the day a rename slips past its patterns.
  const packagedTests = entries.filter((e) => e.endsWith(".test.mjs"));
  check(
    "no test files leaked into the package",
    packagedTests.length === 0,
    `packaged: ${packagedTests.join(", ")}`,
  );

  const icon = `extension/${String(sourceManifest.icon ?? "")}`;
  check(
    `the icon ${icon} is in the package`,
    Boolean(sourceManifest.icon) && has(icon),
    "the marketplace listing renders without it, silently, as a grey placeholder.",
  );

  // vsce lowercases README.md to readme.md inside the archive (measured against
  // @vscode/vsce 3.9.2), so the match is case-insensitive on purpose.
  check(
    "a README is in the package",
    entries.some((e) => /^extension\/readme\.md$/i.test(e)),
    "the marketplace page would be empty.",
  );
  check(
    "a LICENSE is in the package",
    entries.some((e) => /^extension\/license(\.(txt|md))?$/i.test(e)),
    "package-vsix.mjs staples the repository LICENSE in; its absence means that step was skipped.",
  );

  // What the entry point imports must be declared AND packaged, judged from
  // the code rather than the manifest — the check below this one iterates the
  // declared list, and a manifest that dropped one dependency while keeping
  // another would hand it a nonempty list that vouches for the wrong thing.
  const unmet = entryImports.filter(
    (dep) =>
      !sourceManifest.dependencies?.[dep] || !has(`extension/node_modules/${dep}/package.json`),
  );
  check(
    `every package the entry point imports is declared and packaged (${entryImports.join(", ")})`,
    entryImports.length > 0 && unmet.length === 0,
    entryImports.length === 0
      ? "no entry-point imports were handed in, so nothing was asserted — the entry point imports vscode-languageclient, so an empty list means extraction broke, not that the code went dependency-free."
      : `unmet: ${unmet
          .map(
            (dep) =>
              `${dep} (declared: ${Boolean(sourceManifest.dependencies?.[dep])}, packaged: ${has(
                `extension/node_modules/${dep}/package.json`,
              )})`,
          )
          .join(", ")}`,
  );

  // Every runtime dependency the manifest declares must have its tree inside
  // the vsix — an extension host installs nothing. This is the check that goes
  // red if packaging ever quietly becomes `--no-dependencies`.
  const runtimeDeps = Object.keys(sourceManifest.dependencies ?? {});
  check(
    `every runtime dependency is packaged under node_modules (${runtimeDeps.join(", ")})`,
    runtimeDeps.length > 0 &&
      runtimeDeps.every((dep) => has(`extension/node_modules/${dep}/package.json`)),
    runtimeDeps.length === 0
      ? "the source manifest declares no runtime dependencies, so this asserted nothing — the extension imports vscode-languageclient, so an empty list means the manifest regressed."
      : `missing: ${runtimeDeps
          .filter((dep) => !has(`extension/node_modules/${dep}/package.json`))
          .join(", ")}`,
  );

  // And no dev-only tree. `--omit=dev` in the staging install is what keeps
  // them out; @types/vscode or vsce itself arriving in the vsix means the
  // staging step regressed into packing the whole development install.
  const devDeps = Object.keys(sourceManifest.devDependencies ?? {});
  const leaked = devDeps.filter((dep) =>
    entries.some((e) => e.startsWith(`extension/node_modules/${dep}/`)),
  );
  check(
    "no devDependency tree leaked into the package",
    leaked.length === 0,
    `leaked: ${leaked.join(", ")}`,
  );

  check(
    `engines.vscode in the packaged manifest matches the source (${sourceManifest.engines?.vscode})`,
    Boolean(sourceManifest.engines?.vscode) &&
      packagedManifest.engines?.vscode === sourceManifest.engines?.vscode,
    `packaged: ${JSON.stringify(packagedManifest.engines?.vscode)}, source: ${JSON.stringify(
      sourceManifest.engines?.vscode,
    )} — a drifted floor installs on hosts the extension cannot load in.`,
  );

  // Same version, or this vsix was packaged from some other state of the tree —
  // the stale-artifact case, where every check above passes for the wrong file.
  check(
    `the packaged version matches the source (${sourceManifest.version})`,
    Boolean(sourceManifest.version) && packagedManifest.version === sourceManifest.version,
    `packaged: ${JSON.stringify(packagedManifest.version)}, source: ${JSON.stringify(sourceManifest.version)}`,
  );

  return { lines, failures };
}

/** Runs a command with an argument array, capturing everything. */
function run(command, args) {
  return spawnSync(command, args, { encoding: "utf8" });
}

/** Loud exit when a child this script depends on could not answer. */
function must(result, label) {
  if (result.status === 0 && !result.error) return result;
  console.error(result.stdout ?? "");
  console.error(result.stderr ?? "");
  if (result.error) console.error(String(result.error));
  console.error(
    `${label} failed, so the vsix could not be inspected — which is a failure, not a pass.`,
  );
  process.exit(1);
}

function main() {
  const [vsixArg, packageArg = "packages/lattice-vscode"] = process.argv.slice(2);
  if (!vsixArg) {
    console.error("usage: verify-vsix.mjs <vsix-file> [package-directory]");
    process.exit(2);
  }
  const vsix = resolve(root, vsixArg);
  const packageDir = resolve(root, packageArg);
  if (!existsSync(vsix)) {
    console.error(
      `${vsix} does not exist. Package first: node scripts/package-vsix.mjs ${packageArg} <out>.`,
    );
    process.exit(1);
  }

  // `unzip -Z1` lists entry names, one per line; `unzip -p` streams one entry.
  // unzip rather than a library because the repository ships no zip reader and
  // the CI image carries this one.
  const listed = must(run("unzip", ["-Z1", vsix]), "`unzip -Z1` (listing the archive)");
  const entries = listed.stdout.split("\n").filter((line) => line.length > 0);

  const shown = must(
    run("unzip", ["-p", vsix, "extension/package.json"]),
    "`unzip -p` (reading the packaged manifest)",
  );
  const packagedManifest = JSON.parse(shown.stdout);
  const sourceManifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));

  // The modules an install needs: every non-test `.mjs` under src/, read from
  // git so the list is the shipped tree's own, not a copy that drifts.
  const tracked = must(
    spawnSync("git", ["ls-files", "-z", "src"], { cwd: packageDir, encoding: "utf8" }),
    "`git ls-files` (listing the source decision modules)",
  );
  const decisionModules = tracked.stdout
    .split("\0")
    .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"));

  // The entry point's own text, from the source tree — the requirements the
  // dependency checks judge against come from what this file imports.
  const entryPath = join(packageDir, String(sourceManifest.main ?? "").replace(/^\.\//, ""));
  const entryImports = importedPackages(readFileSync(entryPath, "utf8"));

  const { lines, failures } = evaluateVsix({
    entries,
    packagedManifest,
    sourceManifest,
    decisionModules,
    entryImports,
  });
  for (const line of lines) console.log(line);

  if (failures.length > 0) {
    console.error("");
    for (const failure of failures) console.error(`✗ ${failure}\n`);
    console.error(
      `${failures.length} of the checks above failed. This vsix would install and then fail ` +
        `in the extension host, whatever \`vsce package\` said.`,
    );
    process.exit(1);
  }
  console.log(`${vsix} holds everything an install needs.`);
}

/**
 * Whether this file was RUN rather than imported, compared on real paths — the
 * same guard, for the same symlink reason, as the one in check-packages.mjs,
 * which documents why the obvious `argv[1] === import.meta.url` spelling fails.
 */
function isProgramEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}

if (isProgramEntry(import.meta.url)) main();
