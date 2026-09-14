/**
 * Minimal mutation proof-of-value drill (#844, task T1).
 *
 * Proves that four mutation classes turn a targeted test red, then restores
 * the tree byte-identically. This is a tiny committed script — the
 * framework-class harness stays maintainer-deferred — so each mutation is one
 * exact single-line old→new replacement in `packages/archkeep/src`, and each
 * must be caught by a targeted test.
 *
 * The four classes, one mutation each:
 * - verdict-inversion: flip a verdict decision so a violation is reported
 *   clean or a clean row is reported — the bare-star arm of `tagMatches`.
 * - edge-removal: drop a graph edge the pipeline produces so dependent rules
 *   see a leaner graph — the Java resolver spread in the polyglot deps fold.
 * - coverage-as-complete: force `complete: true` even when `notAnalyzed` is
 *   non-empty — the completeness predicate in the shared coverage verdict.
 * - refusal-removed: remove a refusal throw so an incomplete run produces a
 *   verdict instead of a refusal — the whole-file-failure guard in
 *   `refuseUnjudgeableHead`.
 *
 * Run from the repository root with `node_modules` present:
 *
 *     node scripts/mutation-proof.mjs
 *
 * Pass `--json` for the same results as a JSON object. The script resolves the
 * vitest binary from the worktree's `node_modules/.bin`, applies each mutation
 * (asserting the replace string occurs exactly once — a no-op mutation is a
 * useless pass), runs the targeted test file with `--coverage.enabled=false`
 * (the repository config enables v8 coverage with a global threshold, so a
 * bare targeted run exits 1 despite passing), requires a nonzero exit whose
 * failure names the mutated behavior, restores the source byte-for-byte, and
 * finally asserts `git status --porcelain` shows no tracked modifications.
 * Exits 0 iff all four mutations went red AND the restore is byte-identical;
 * exits 1 (loud) otherwise.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_ARCHKEEP = join(REPO_ROOT, "packages", "archkeep");
const PKG_SRC = join(PKG_ARCHKEEP, "src");
const VITEST_BIN = join(REPO_ROOT, "node_modules", ".bin", "vitest");
const AS_JSON = process.argv.includes("--json");

const MUTATIONS = [
  {
    name: "verdict-inversion",
    file: "rules/match.mjs",
    replace: '  if (tag === "*") return true;',
    with: '  if (tag === "*") return false;',
    testFiles: ["src/rules/match.test.mjs"],
    expectedFailures: ["matches every project through a bare star"],
    why: "the bare-star arm of tagMatches is inverted, so a wildcard pattern stops matching everything — a violation reported clean, the silent direction",
  },
  {
    name: "edge-removal",
    file: "graph/create-dependencies.mjs",
    replace: "    ...resolveJavaDependencies(sharedWorkspace),",
    with: "",
    testFiles: ["src/graph/create-dependencies.test.mjs"],
    expectedFailures: ["reads every JVM source exactly once"],
    why: "the Java resolver spread is dropped from the polyglot deps fold, so the graph loses every Java edge — dependent rules see a leaner graph",
  },
  {
    name: "coverage-as-complete",
    file: "commands/coverage-verdict.mjs",
    replace: "  const complete = coverageComplete({",
    with: "  const complete = true || coverageComplete({",
    testFiles: ["src/commands/delta.test.mjs"],
    expectedFailures: ["refuses an incomplete head", "claiming coverage.complete"],
    why: "the completeness predicate is short-circuited to true, so an incomplete run claims complete:true while notAnalyzed is non-empty",
  },
  {
    name: "refusal-removed",
    file: "commands/delta.mjs",
    replace: "  if (notAnalyzed.length > 0 || blindSpotCount > 0) {",
    with: "  if (false && (notAnalyzed.length > 0 || blindSpotCount > 0)) {",
    testFiles: ["src/commands/delta.test.mjs"],
    expectedFailures: ["refuses to capture over incomplete coverage"],
    why: "the whole-file-failure guard in refuseUnjudgeableHead is disabled, so a capture over an unjudgeable head writes a baseline instead of refusing",
  },
];

/** Tracked-modifications-only git status check through spawnSync. */
function gitStatus() {
  const run = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return { clean: run.status === 0 && run.stdout.trim() === "", output: run.stdout.trim() };
}

if (!existsSync(VITEST_BIN)) {
  console.error(
    `mutation-proof: vitest binary not found at ${VITEST_BIN} — run with node_modules present`,
  );
  process.exit(1);
}

const preflight = gitStatus();
if (!preflight.clean) {
  console.error(
    `mutation-proof: refusing to run on a dirty tree — tracked modifications present:\n${preflight.output}`,
  );
  process.exit(1);
}

const results = [];
let overallOk = true;

for (const mutation of MUTATIONS) {
  const target = join(PKG_SRC, mutation.file);
  const original = readFileSync(target, "utf8");
  const occurrences = original.split(mutation.replace).length - 1;
  if (occurrences !== 1) {
    console.error(
      `mutation-proof: "${mutation.name}" — expected exactly 1 occurrence of the replace string in ` +
        `${mutation.file}, found ${occurrences}; a no-op mutation is a useless pass`,
    );
    results.push({ ...mutation, outcome: "replace-not-unique", restored: true });
    overallOk = false;
    continue;
  }

  const backupPath = join(tmpdir(), `mutation-proof-${process.pid}-${mutation.name}.bak`);
  copyFileSync(target, backupPath);
  try {
    writeFileSync(target, original.replace(mutation.replace, mutation.with), "utf8");

    const run = spawnSync(VITEST_BIN, ["run", ...mutation.testFiles, "--coverage.enabled=false"], {
      cwd: PKG_ARCHKEEP,
      encoding: "utf8",
      timeout: 300_000,
    });
    const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;

    if (run.error ?? run.status === null) {
      console.error(
        `mutation-proof: "${mutation.name}" — vitest run failed to execute (${run.error?.message ?? "no exit status"}); ` +
          "cannot prove the mutation bites",
      );
      results.push({ ...mutation, outcome: "run-error", restored: false });
      overallOk = false;
    } else if (run.status === 0) {
      console.error(
        `mutation-proof: "${mutation.name}" — the targeted test PASSED under mutation; the mutation did not bite ` +
          "(a silent-direction hole in the suite)",
      );
      results.push({ ...mutation, outcome: "unexpected-pass", restored: false });
      overallOk = false;
    } else {
      const matched = mutation.expectedFailures.find((needle) => output.includes(needle));
      if (matched === undefined) {
        console.error(
          `mutation-proof: "${mutation.name}" — the targeted test exited ${run.status} but its failure does not ` +
            `name the mutated behavior (expected one of: ${mutation.expectedFailures.join(", ")}); ` +
            "the pinning assertion may not have caught it",
        );
        results.push({ ...mutation, outcome: "red-unpinned", restored: false });
        overallOk = false;
      } else {
        results.push({ ...mutation, outcome: "red", matchedFailure: matched, restored: false });
      }
    }
  } finally {
    copyFileSync(backupPath, target);
    rmSync(backupPath);
    const restored = readFileSync(target, "utf8") === original;
    if (!restored) {
      console.error(`mutation-proof: "${mutation.name}" — restore is NOT byte-identical`);
      overallOk = false;
    }
    const last = results[results.length - 1];
    if (last !== undefined) last.restored = restored;
  }
}

const postflight = gitStatus();
if (!postflight.clean) {
  console.error(
    `mutation-proof: git status --porcelain is not clean after restore:\n${postflight.output}`,
  );
  overallOk = false;
}

const columns = {
  name: "mutation",
  testFiles: "targeted test file(s)",
  red: "red under mutation?",
  restored: "restored?",
};
const widths = {
  name: Math.max(columns.name.length, ...results.map((r) => r.name.length)),
  testFiles: Math.max(
    columns.testFiles.length,
    ...results.map((r) => r.testFiles.join(", ").length),
  ),
  red: columns.red.length,
  restored: columns.restored.length,
};
const pad = (text, width) => text.padEnd(width);
const rows = [
  `${pad(columns.name, widths.name)} | ${pad(columns.testFiles, widths.testFiles)} | ${pad(columns.red, widths.red)} | ${pad(columns.restored, widths.restored)}`,
  `${"-".repeat(widths.name)}-+-${"-".repeat(widths.testFiles)}-+-${"-".repeat(widths.red)}-+-${"-".repeat(widths.restored)}`,
];
for (const r of results) {
  rows.push(
    `${pad(r.name, widths.name)} | ${pad(r.testFiles.join(", "), widths.testFiles)} | ${pad(r.outcome === "red" ? "yes" : "NO", widths.red)} | ${pad(r.restored ? "yes" : "NO", widths.restored)}`,
  );
}
rows.push(
  `\nresult: ${results.filter((r) => r.outcome === "red").length}/4 mutations red under targeted tests; ` +
    `tree restored byte-identically (no tracked modifications): ${postflight.clean ? "yes" : "NO"}`,
);
console.log(rows.join("\n"));

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        ok: overallOk,
        mutations: results.map(
          ({ name, file, testFiles, outcome, matchedFailure, restored, why }) => ({
            name,
            file,
            testFiles,
            outcome,
            matchedFailure,
            restored,
            why,
          }),
        ),
        restoreClean: postflight.clean,
      },
      null,
      2,
    ),
  );
}

process.exitCode = overallOk ? 0 : 1;
