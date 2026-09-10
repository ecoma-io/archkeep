#!/usr/bin/env node
/**
 * Semantic mutation harness: applies targeted source inversions to
 * `packages/archkeep/src/**` modules and verifies the test suite catches
 * each one. A surviving mutant is a silent-failure gap the suite does
 * not cover.
 *
 * The harness is a nightly CI lane (`nightly.yml`), not a PR gate — a
 * mutant that survives is a FINDING, not a build break: the suite lacks
 * a test for that failure class. Survivors are reported, not silenced.
 *
 * Each mutation is a `{ name, file, find, replace }` manifest entry.
 * `find` must occur exactly once in the current source; multiple hits
 * or zero hits are loud failures. After applying the mutation, the
 * harness runs the colocated test file (`foo.test.mjs` beside
 * `foo.mjs`) through vitest. A non-zero exit means the test suite
 * caught the inversion (mutant killed). Exit 0 means the mutant
 * survived — the finding.
 *
 * File restoration uses `git checkout --`, which requires a clean
 * working tree for the mutated file. Files with uncommitted changes
 * are skipped with a warning rather than clobbered. Crash guards make
 * the write→restore window safe against signals and unhandled
 * failures: any mutant still resident when the process dies (exit,
 * SIGINT, SIGTERM, uncaughtException, unhandledRejection) is restored
 * before the process ends, so a crashed run cannot poison the tree.
 *
 * Run from the repo root:
 *   node scripts/semantic-mutation.mjs
 *
 * Program entry is gated by `isProgramEntry` (same guard
 * `check-packages.mjs` uses), so this file is safe to import for its
 * pure functions.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The package whose vitest suite judges every mutant, repo-relative. */
export const ARCHKEEP_DIR = "packages/archkeep";

// ─── manifest ──────────────────────────────────────────────────────

/**
 * One named semantic mutation in the manifest.
 *
 * @typedef {object} MutationEntry
 * @property {string} name stable identifier, used as the runSuite key
 * @property {string} file repo-relative path of the module to mutate
 * @property {string} find the exact string to replace — must occur once
 * @property {string} replace its single substitution
 * @property {string} description what silent-failure class this mutant models
 */
/**
 * The named semantic mutations, each targeting a distinct silent-failure
 * class. `file` is relative to the repo root; `find` is the exact
 * (textual) string to replace once; `replace` is its single
 * substitution.
 *
 * @type {MutationEntry[]}
 */
export const MUTATIONS = [
  {
    name: "verdict-inversion",
    file: "packages/archkeep/src/verdict.mjs",
    find: "    violations > 0 ||\n",
    replace: "    violations === 0 ||\n",
    description:
      "Inverts the violation count check so violations > 0 reports 'ok' " +
      "instead of 'findings' — the exit-code engine hides all violations.",
  },
  {
    name: "create-dependencies-muted",
    file: "packages/archkeep/src/graph/create-dependencies.mjs",
    find: "  return resolvePolyglotDependencies(projects, filesOf, readFile);",
    replace: "  return [];",
    description:
      "Makes the Nx plugin hook return zero edges — the graph layer stops " +
      "drawing cross-project dependencies for Go, Rust, Python, and JVM.",
  },
  {
    name: "manifest-edges-dropped",
    file: "packages/archkeep/src/graph/create-dependencies.mjs",
    find:
      "  return [\n" +
      "    ...resolveCsprojDependencies(workspace),\n" +
      "    ...resolveMavenDependencies(workspace),\n" +
      "    ...resolveGradleDependencies(workspace),\n" +
      "  ];",
    replace: "  return [];",
    description:
      "Drops manifest-track edges (csproj, Maven, Gradle) — the declared-" +
      "dependency graph vanishes while import-site edges remain.",
  },
  {
    name: "violation-message-data-stripped",
    file: "packages/archkeep/src/rules/index.mjs",
    find: "    message: renderMessage(messageId, data),",
    replace: "    message: renderMessage(messageId, {}),",
    description:
      "Strips contextual data from every rule violation message — messages " +
      "lose the import names, project details, and constraint tags that " +
      "make them actionable.",
  },
  {
    name: "coverage-complete-inverted",
    file: "packages/archkeep/src/verdict.mjs",
    find: "  return unchecked === 0 && blindSpotCount === 0 && analyzed > 0;",
    replace: "  return unchecked === 0 && blindSpotCount === 0 && analyzed === 0;",
    description:
      "Inverts the coverage-complete predicate so runs that analyzed " +
      "nothing claim full coverage, and runs with real data claim incompleteness.",
  },
  {
    name: "rules-evaluate-empty",
    file: "packages/archkeep/src/rules/index.mjs",
    find: "  return evaluateRun(importSites, graph, config).violations;",
    replace: "  return [];",
    description:
      "Makes the rules engine return zero violations regardless of input — " +
      "the entire boundary-law check produces nothing.",
  },
  {
    name: "isVerdict-inverted",
    file: "packages/archkeep/src/governance/verdict.mjs",
    find: '  return typeof value === "string" && VERDICTS.includes(value);',
    replace: '  return typeof value === "string" && !VERDICTS.includes(value);',
    description:
      "Inverts the verdict-type predicate so valid verdicts are rejected and " +
      "arbitrary strings are accepted as verdict values.",
  },
];

// ─── pure functions ────────────────────────────────────────────────

/**
 * Maps a source module path to its colocated test file. The archkeep
 * test layout mirrors `src/foo.mjs` → `src/foo.test.mjs`.
 *
 * @param {string} sourcePath repo-relative path (e.g. `packages/archkeep/src/verdict.mjs`)
 * @returns {string} the colocated test path
 */
export function testFileFor(sourcePath) {
  return sourcePath.replace(/\.mjs$/, ".test.mjs");
}

/**
 * Evaluates a manifest of mutations against an injected test runner.
 * Pure — no file I/O, no child process; the runner is the only side
 * effect.
 *
 * @param {{ name: string }[]} manifest
 * @param {(name: string) => { killed: boolean, durationMs: number }} runSuite
 * @returns {{ name: string, killed: boolean, durationMs: number }[]}
 */
export function evaluateMutations(manifest, runSuite) {
  return manifest.map((m) => {
    const { killed, durationMs } = runSuite(m.name);
    return { name: m.name, killed, durationMs };
  });
}

/**
 * Whether any mutant in the results escaped.
 *
 * @param {{ killed: boolean }[]} results
 * @returns {boolean}
 */
export function anySurvived(results) {
  return results.some((r) => !r.killed);
}

// ─── IO layer ──────────────────────────────────────────────────────

/**
 * Applies one mutation, runs the suite through the injected runner, and
 * restores the file in a `finally` block — restoration happens even
 * when the suite throws.
 *
 * @param {{ apply: (m: { name: string, file: string }) => void, restore: (m: { file: string }) => void, runSuite: (name: string) => { killed: boolean, durationMs: number } }} io
 * @param {{ name: string, file: string }} mutation
 * @returns {{ name: string, killed: boolean, durationMs: number, error?: string }}
 */
export function applyMutationAndRun(io, mutation) {
  io.apply(mutation);
  try {
    const { killed, durationMs } = io.runSuite(mutation.name);
    return { name: mutation.name, killed, durationMs };
  } catch (err) {
    return {
      name: mutation.name,
      killed: false,
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    io.restore(mutation);
  }
}

/**
 * Builds a process-level guard handler for the crash window between
 * "mutant written to disk" and "finally restores it": on a signal or an
 * unhandled failure the harness restores every still-resident mutant and
 * exits with `code`, so a dead run cannot leave a mutant poisoning the
 * tree. A separate factory (rather than inline closures in `main`) keeps
 * the restore-then-exit ORDER unit-testable without registering real
 * process handlers in the test runner.
 *
 * @param {number} code exit status the guard ends the process with
 * @returns {() => void} the handler to register
 */
export function signalGuard(restorePending, exit, code) {
  return () => {
    restorePending();
    exit(code);
  };
}

// ─── main (real I/O) ───────────────────────────────────────────────

/**
 * Validates the manifest against the current tree, then iterates each
 * mutation: applies it, runs the targeted vitest, and restores via
 * `git checkout --`.
 */
function main() {
  const archkeepDir = resolve(root, ARCHKEEP_DIR);

  // Crash guards: repo-relative paths currently holding a written mutant.
  // Between writeFileSync below and the finally that restores it, a crash
  // would otherwise leave the mutant resident in the shared tree.
  const inFlight = new Set();
  const restorePending = () => {
    for (const rel of [...inFlight]) {
      spawnSync("git", ["checkout", "--", rel], { cwd: root });
      inFlight.delete(rel);
    }
  };
  process.on("exit", restorePending);
  const guard = (code) => signalGuard(restorePending, (c) => process.exit(c), code);
  process.on("SIGINT", guard(130));
  process.on("SIGTERM", guard(143));
  process.on("uncaughtException", guard(1));
  process.on("unhandledRejection", guard(1));

  // Pre-validate: every find string occurs exactly once and the file is clean.
  for (const mutation of MUTATIONS) {
    const abs = resolve(root, mutation.file);
    const content = readFileSync(abs, "utf8");
    const count = content.split(mutation.find).length - 1;
    if (count === 0) {
      console.error(`\x1b[31m✖ ${mutation.name}: find string not found in ${mutation.file}\x1b[0m`);
      console.error("  The source may have drifted — update the manifest entry.");
      process.exit(1);
    }
    if (count > 1) {
      console.error(
        `\x1b[31m✖ ${mutation.name}: find string occurs ${count} times in ${mutation.file} (expected exactly 1)\x1b[0m`,
      );
      console.error(
        "  A non-unique find would leave a second copy intact after " +
          "replacement. Tighten the string.",
      );
      process.exit(1);
    }

    const status = spawnSync("git", ["status", "--porcelain", "--", mutation.file], {
      cwd: root,
      encoding: "utf8",
    });
    if (status.stdout.trim()) {
      console.error(`\x1b[33m⚠ ${mutation.name}: ${mutation.file} is dirty — skipped\x1b[0m`);
    }
  }

  console.log(`\x1b[1mSemantic mutation harness — ${MUTATIONS.length} mutants\x1b[0m\n`);

  const byName = new Map(MUTATIONS.map((m) => [m.name, m]));
  const results = evaluateMutations(MUTATIONS, (name) => {
    const mutation = byName.get(name);
    const abs = resolve(root, mutation.file);
    const content = readFileSync(abs, "utf8");

    // Skip dirty files.
    const status = spawnSync("git", ["status", "--porcelain", "--", mutation.file], {
      cwd: root,
      encoding: "utf8",
    });
    if (status.stdout.trim()) {
      return { killed: false, durationMs: 0 };
    }

    // Apply.
    writeFileSync(abs, content.replace(mutation.find, mutation.replace), "utf8");
    inFlight.add(mutation.file);

    const start = performance.now();
    try {
      const vitestBin = resolve(root, "node_modules/.bin/vitest");
      // Coverage stays OFF for a targeted run: the config's global
      // thresholds are measured over the whole suite, so a single test
      // file would fail them on coverage alone and every mutant would
      // read as "killed" without the suite ever judging it.
      const testRel = testFileFor(mutation.file).slice(ARCHKEEP_DIR.length + 1);
      const child = spawnSync(vitestBin, ["run", "--coverage.enabled=false", testRel], {
        cwd: archkeepDir,
        timeout: 120_000,
        env: { ...process.env, FORCE_COLOR: "1" },
      });
      const durationMs = Math.round(performance.now() - start);
      return { killed: child.status !== 0, durationMs };
    } finally {
      // Restore to HEAD, always.
      spawnSync("git", ["checkout", "--", mutation.file], { cwd: root });
      inFlight.delete(mutation.file);
    }
  });

  printReport(results);

  if (anySurvived(results)) {
    process.exit(1);
  }
}

/**
 * Coloured report: each mutant's name, status (killed / survived /
 * skipped), and duration. Survivors are named explicitly.
 *
 * @param {{ name: string, killed: boolean, durationMs: number, error?: string }[]} results
 */
function printReport(results) {
  for (const r of results) {
    const time = `${r.durationMs}ms`;
    if (r.error) {
      console.log(`  \x1b[33m⚠ ${r.name}\x1b[0m  error: ${r.error}`);
    } else if (r.killed) {
      console.log(`  \x1b[32m✔ ${r.name}\x1b[0m  killed (${time})`);
    } else if (r.durationMs === 0) {
      console.log(`  \x1b[33m⚠ ${r.name}\x1b[0m  skipped (dirty)`);
    } else {
      console.log(`  \x1b[31m✖ ${r.name}\x1b[0m  SURVIVED (${time})`);
    }
  }
  console.log();

  const killed = results.filter((r) => r.killed).length;
  const survived = results.filter((r) => !r.killed && r.durationMs > 0).length;
  const skipped = results.filter((r) => !r.killed && r.durationMs === 0 && !r.error).length;
  const errored = results.filter((r) => r.error).length;

  console.log(
    `\x1b[1m${killed} killed, \x1b[31m${survived} survived\x1b[0m` +
      (skipped ? `, \x1b[33m${skipped} skipped\x1b[0m` : "") +
      (errored ? `, \x1b[31m${errored} error(s)\x1b[0m` : ""),
  );
  console.log();

  if (survived > 0 || errored > 0) {
    console.log("\x1b[31mSome mutants survived or errored — exit 1.\x1b[0m");
  } else {
    console.log("\x1b[32mAll mutants killed — exit 0.\x1b[0m");
  }
}

/**
 * Whether this file was RUN rather than imported, compared on real
 * paths.
 */
function isProgramEntry(
  moduleUrl,
  /** @type {string | undefined} */
  argv1 = process.argv[1],
) {
  if (!argv1) return false;
  const realModule = /** @type {string} */ (fileURLToPath(moduleUrl));
  const realArgv = resolve(argv1);
  return realModule === realArgv;
}

if (isProgramEntry(import.meta.url)) main();
