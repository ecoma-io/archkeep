/**
 * Minimal mutation proof-of-value drill (#844, task T1).
 *
 * Proves that four mutation classes turn a targeted test red. Every mutation
 * is applied to an isolated temporary git worktree checked out at HEAD, never
 * to the judged tree: the judged tree keeps the same files and byte content
 * for the whole run (and the whole command) and is only ever read.
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
 * Pass `--json` for the same results as a JSON object.
 *
 * Copy contract: the drill creates ONE temporary isolated git worktree
 * (`git -C <repo> worktree add --detach <tmpdir> HEAD`), symlinks the
 * repository's `node_modules` into it (pnpm layout; the vitest binary
 * resolves from the worktree's `node_modules/.bin`), applies each mutation
 * (asserting the replace string occurs exactly once — a no-op mutation is a
 * useless pass) to the WORKTREE copy only, runs the targeted test file(s)
 * from the worktree's `packages/archkeep` with `--coverage.enabled=false`
 * (the repository config enables v8 coverage with a global threshold, so a
 * bare targeted run exits 1 despite passing), requires a nonzero exit whose
 * failure names the mutated behavior, restores the worktree file, and finally
 * removes the worktree. The judged tree is NEVER written: preflight refuses a
 * dirty judged tree (evidence of a previously interrupted drill) or a missing
 * `node_modules`; postflight asserts the judged tree still has zero tracked
 * modifications. A killed run (SIGINT/SIGTERM/SIGHUP, or `exit`) leaves at
 * worst an orphan temp worktree and its `node_modules` symlink — the judged
 * engine untouched — and the next run's preflight plus stale-worktree prune
 * make it self-healing. Exits 0 iff all four mutations went red AND the
 * judged tree is clean afterwards; exits 1 (loud) otherwise.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_ARCHKEEP = join(REPO_ROOT, "packages", "archkeep");
const PKG_SRC = join(PKG_ARCHKEEP, "src");
const AS_JSON = process.argv.includes("--json");
const TMP_PREFIX = join(tmpdir(), "archkeep-mutation-proof-");

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
function gitStatus(cwd = REPO_ROOT) {
  const run = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd,
    encoding: "utf8",
  });
  return { clean: run.status === 0 && run.stdout.trim() === "", output: run.stdout.trim() };
}

/**
 * Preflight: refuse loudly (exit 1, named) when the judged tree has tracked
 * modifications — the repo root and packages/archkeep — or when node_modules
 * is missing. A dirty judged tree is evidence of a previously interrupted
 * drill and must never be silently overwritten.
 */
function preflight() {
  const dirty = [];
  const root = gitStatus(REPO_ROOT);
  if (!root.clean) dirty.push(`  repo root:\n${root.output}`);
  const pkg = gitStatus(PKG_ARCHKEEP);
  if (!pkg.clean) dirty.push(`  packages/archkeep:\n${pkg.output}`);
  if (dirty.length > 0) {
    console.error(
      `mutation-proof: refusing to run on a dirty judged tree — tracked modifications present ` +
        `(evidence of a previously interrupted drill; the judged tree must never be overwritten):\n` +
        dirty.join("\n"),
    );
    return "dirty-tree";
  }
  const nodeModules = join(REPO_ROOT, "node_modules");
  if (!existsSync(nodeModules)) {
    console.error(
      `mutation-proof: node_modules not found at ${nodeModules} — run with node_modules present`,
    );
    return "missing-node-modules";
  }
  return null;
}

/**
 * Self-healing: remove leftover drill worktrees from a killed run. Only
 * worktrees under our own tmp pattern are touched; a `git worktree prune`
 * then clears metadata for directories the OS temp cleaner already removed.
 */
function pruneStaleDrillWorktrees() {
  const list = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (list.status !== 0 || !list.stdout) return;
  const stale = list.stdout
    .split(/\n(?=worktree )/)
    .map((block) => block.match(/^worktree (.+)$/m)?.[1])
    .filter((path) => path !== undefined && path.startsWith(TMP_PREFIX));
  for (const dir of stale) {
    const nm = join(dir, "node_modules");
    try {
      if (lstatSync(nm).isSymbolicLink()) unlinkSync(nm);
    } catch {
      // Absent or not a symlink — nothing to unlink.
    }
    const removed = spawnSync("git", ["worktree", "remove", "--force", dir], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    if (removed.status !== 0) {
      // Metadata already pruned or the directory is gone; leave a clean slate.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Tolerate — the OS temp cleaner may own the directory.
      }
      spawnSync("git", ["worktree", "prune"], { cwd: REPO_ROOT, encoding: "utf8" });
    }
  }
}

const preflightFailure = preflight();
if (preflightFailure !== null) {
  console.error(`mutation-proof: preflight failed (${preflightFailure}); aborting`);
  process.exit(1);
}

pruneStaleDrillWorktrees();

// One temp ISOLATED worktree for the whole drill; the judged tree is never written.
let worktreePath = null;
let cleaned = false;

function cleanupWorktree() {
  if (cleaned) return;
  cleaned = true;
  const dir = worktreePath;
  worktreePath = null;
  if (dir === null) return;
  const nm = join(dir, "node_modules");
  try {
    if (lstatSync(nm).isSymbolicLink()) unlinkSync(nm);
  } catch {
    // Absent or not a symlink — nothing to unlink.
  }
  const removed = spawnSync("git", ["worktree", "remove", "--force", dir], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (removed.status !== 0) {
    // The OS temp cleaner may already have removed the directory — tolerate it.
    if (existsSync(dir)) {
      console.error(
        `mutation-proof: could not remove temp worktree at ${dir}: ` +
          `${(removed.stderr ?? "").trim()}`,
      );
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Tolerate — next run's prune reaps whatever is left.
      }
    }
    spawnSync("git", ["worktree", "prune"], { cwd: REPO_ROOT, encoding: "utf8" });
  }
}

function onSignal(signal) {
  const code = 128 + { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal];
  console.error(
    `mutation-proof: received ${signal} — removing the temp worktree (judged tree untouched), exiting ${code}`,
  );
  cleanupWorktree();
  process.exit(code);
}
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
process.on("SIGHUP", onSignal);
process.on("exit", () => {
  // Safety net for every exit path (normal return, thrown error, process.exit):
  // removes the worktree unless a trap already did.
  try {
    cleanupWorktree();
  } catch {
    // Exit path — at worst an orphan worktree, reaped by the next run's prune.
  }
});

function failSetup(message) {
  console.error(`mutation-proof: ${message}`);
  cleanupWorktree();
  process.exit(1);
}

const worktreePathCandidate = join(tmpdir(), `archkeep-mutation-proof-${randomUUID()}`);
const added = spawnSync("git", ["worktree", "add", "--detach", worktreePathCandidate, "HEAD"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
  timeout: 120_000,
});
if (added.status !== 0) {
  failSetup(
    `could not create the temp worktree at ${worktreePathCandidate}: ${(added.stderr ?? "").trim()}`,
  );
}
worktreePath = worktreePathCandidate;

// node_modules is gitignored and never checked out, so the symlink lands in a
// fresh directory; pnpm's layout resolves from the repo root and the vitest
// binary becomes available at <tmpdir>/node_modules/.bin/vitest.
try {
  symlinkSync(join(REPO_ROOT, "node_modules"), join(worktreePath, "node_modules"), "dir");
} catch (err) {
  failSetup(`could not symlink node_modules into the temp worktree: ${err.message}`);
}

const WORKTREE_SRC = join(worktreePath, "packages", "archkeep", "src");

// The worktree is checked out at HEAD; assert pristine before mutating.
{
  const wtStatus = gitStatus(worktreePath);
  if (!wtStatus.clean) {
    failSetup(
      `temp worktree is not pristine (expected a clean HEAD checkout):\n${wtStatus.output}`,
    );
  }
  const mismatched = MUTATIONS.filter(
    (m) =>
      readFileSync(join(WORKTREE_SRC, m.file), "utf8") !==
      readFileSync(join(PKG_SRC, m.file), "utf8"),
  );
  if (mismatched.length > 0) {
    failSetup(
      `temp worktree files differ from the judged tree at HEAD: ${mismatched.map((m) => m.file).join(", ")}`,
    );
  }
}

const results = [];
let overallOk = true;

for (const mutation of MUTATIONS) {
  const target = join(WORKTREE_SRC, mutation.file);
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

  writeFileSync(target, original.replace(mutation.replace, mutation.with), "utf8");

  const vitestBin = join(worktreePath, "node_modules", ".bin", "vitest");
  const run = spawnSync(vitestBin, ["run", ...mutation.testFiles, "--coverage.enabled=false"], {
    cwd: join(worktreePath, "packages", "archkeep"),
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

  // Restore the worktree file so the worktree (and each subsequent mutation)
  // starts from pristine HEAD content.
  spawnSync("git", ["restore", "--", mutation.file], {
    cwd: WORKTREE_SRC,
    encoding: "utf8",
  });
  const restored = readFileSync(target, "utf8") === original;
  if (!restored) {
    console.error(`mutation-proof: "${mutation.name}" — worktree restore is NOT byte-identical`);
    overallOk = false;
  }
  const last = results[results.length - 1];
  if (last !== undefined) last.restored = restored;
}

cleanupWorktree();

// Postflight: the judged tree must show zero tracked modifications — it was
// never written during the drill.
const postflight = gitStatus();
const postflightPkg = gitStatus(PKG_ARCHKEEP);
const judgedTreeClean = postflight.clean && postflightPkg.clean;
if (!judgedTreeClean) {
  const dirty = [];
  if (!postflight.clean) dirty.push(`  repo root:\n${postflight.output}`);
  if (!postflightPkg.clean) dirty.push(`  packages/archkeep:\n${postflightPkg.output}`);
  console.error(
    `mutation-proof: judged tree has tracked modifications after the drill:\n${dirty.join("\n")}`,
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
    `judged tree has zero tracked modifications (never written during the drill): ${judgedTreeClean ? "yes" : "NO"}`,
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
        trees: {
          judgedPreflight: { clean: true, output: "" },
          judgedPostflight: {
            clean: judgedTreeClean,
            output: [postflight.output, postflightPkg.output].filter(Boolean).join("\n"),
          },
        },
      },
      null,
      2,
    ),
  );
}

process.exitCode = overallOk ? 0 : 1;
