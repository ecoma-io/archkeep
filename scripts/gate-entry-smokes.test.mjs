// Output smokes for the cheap direct-run gates' entry guards (#236).
//
// Every gate script under `scripts/` carries its own copy of `isProgramEntry`,
// the run-vs-import guard compared on real paths (`check-packages.mjs` holds
// the canonical argument for both the function and the unshared copies). The
// failure it prevents is the quietest one this repository knows: through a
// symlinked checkout the naive `argv[1] === fileURLToPath(import.meta.url)`
// comparison is false, main() never runs, and the gate exits 0 having checked
// nothing — green that checked nothing. The guards themselves are deliberately
// unshared, so nothing imports them; what CAN be proven for each script is the
// observable that matters: invoked through a symlinked path, the gate still
// RUNS and says so.
//
// Each smoke below spawns a real gate through a symlinked scripts directory,
// exactly as a symlinked checkout invokes it, and asserts the named output or
// refusal — not merely an exit code. Under a broken guard every one of these
// scripts exits 0 with empty output, so each assertion goes red in the silent
// direction.
//
// Scope: gates that reach their named verdict WITHOUT network or install.
// Deliberately excluded, with the reason each needs:
//   - differential-real-trees.mjs / differential-real-trees-child.mjs — a bare
//     run starts cloning third-party repositories over the network (measured:
//     it clones before anything else), which no unit suite may do;
//   - verify-rule-sdk-ts-package.mjs — packs the SDK and installs it into a
//     throwaway workspace; an install-lane script, not a cheap gate;
//   - push-reformatted-files.mjs — talks to the GitHub API, and its
//     symlinked-entry loud failure is already pinned by its own colocated
//     test ("invoked through a symlinked path…"), so a second copy here would
//     be exactly the duplication this repository refuses;
//   - codex-post-tool-use.mjs — a dispatcher, not a gate: it produces no
//     verdict of its own. Its parsing half is pinned in its colocated test and
//     its happy path there exercises the same three hooks these smokes reach
//     directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, "..");

// One symlinked alias of scripts/, shared by every smoke: invoking a script
// THROUGH the link is what makes the naive argv[1] comparison fail.
const TMP = mkdtempSync(join(tmpdir(), "gate-entry-smoke-"));
const SCRIPTS_LINK = join(TMP, "scripts-link");
symlinkSync(SCRIPTS_DIR, SCRIPTS_LINK);

/**
 * Spawns a gate script by name through the symlinked directory.
 *
 * @param {string} script file name under `scripts/`
 * @param {{env?: NodeJS.ProcessEnv, args?: string[]}} [options]
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function spawnViaSymlink(script, { env = process.env, args = [] } = {}) {
  return spawnSync(process.execPath, [join(SCRIPTS_LINK, script), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...env },
  });
}

test("#236 — check-skills.mjs still reaches its verdict through a symlinked entry", () => {
  const result = spawnViaSymlink("check-skills.mjs");
  assert.equal(result.status, 0, `expected the skills verdict, got:\n${result.stderr}`);
  // A broken guard exits 0 with EMPTY stdout — the one state this smoke exists
  // to make red.
  assert.match(result.stdout ?? "", /ok\s+\S+/, "no per-skill verdict line was printed");
});

test("#236 — check-packages.mjs still reaches its verdict through a symlinked entry", () => {
  const result = spawnViaSymlink("check-packages.mjs");
  assert.equal(result.status, 0, `expected the package verdict, got:\n${result.stderr}`);
  assert.match(result.stdout ?? "", /ok\s+lattice\s—/, "no per-package verdict line was printed");
});

test("#236 — check-docs-links.mjs still reaches its verdict through a symlinked entry", () => {
  const result = spawnViaSymlink("check-docs-links.mjs");
  assert.equal(result.status, 0, `expected the doc-link verdict, got:\n${result.stderr}`);
  assert.match(
    result.stdout ?? "",
    /scanning \d+ files/,
    "the coverage claim (what was inspected) was never printed",
  );
});

test("#236 — sync-cargo-lock.mjs still reaches its verdict through a symlinked entry", () => {
  // Runs against a fixture copy of the real manifest pair rather than the tree:
  // the script's whole purpose is writing Cargo.lock, and a smoke that could
  // mutate tracked files mid-suite would be a test with side effects on the
  // working tree. In-sync bytes make the verdict deterministic.
  const root = join(TMP, "cargo-fixture", "packages", "lattice-rule-sdk-rust");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "Cargo.toml"),
    readFileSync(join(REPO_ROOT, "packages/lattice-rule-sdk-rust/Cargo.toml")),
  );
  writeFileSync(
    join(root, "Cargo.lock"),
    readFileSync(join(REPO_ROOT, "packages/lattice-rule-sdk-rust/Cargo.lock")),
  );

  const result = spawnViaSymlink("sync-cargo-lock.mjs", {
    args: ["--root", join(TMP, "cargo-fixture")],
  });
  assert.equal(result.status, 0, `expected the lockfile verdict, got:\n${result.stderr}`);
  assert.match(
    result.stdout ?? "",
    /Cargo\.lock already records/,
    "the in-step verdict was never printed",
  );
});

test("#236 — tag-go-module.mjs refuses loudly through a symlinked entry when its arguments are missing", () => {
  const result = spawnViaSymlink("tag-go-module.mjs");
  assert.equal(result.status, 2, "missing arguments must be a usage error, not silence");
  assert.match(result.stderr ?? "", /--version is required/);
});

test("#236 — reconcile-differential-issue.mjs refuses loudly through a symlinked entry when its envelope is missing", () => {
  const env = { ...process.env };
  delete env.DIFFERENTIAL_SUMMARY;
  delete env.DIFFERENTIAL_REPO;
  delete env.GH_TOKEN;
  const result = spawnViaSymlink("reconcile-differential-issue.mjs", { env });
  assert.equal(result.status, 1, "a missing summary must refuse, not exit clean");
  assert.match(result.stderr ?? "", /DIFFERENTIAL_SUMMARY is not set/);
});

test("#236 — verify-vsix.mjs refuses loudly through a symlinked entry when its argument is missing", () => {
  const result = spawnViaSymlink("verify-vsix.mjs");
  assert.equal(result.status, 2, "a missing vsix path must be a usage error, not silence");
  assert.match(result.stdout + result.stderr, /usage:/i);
});
