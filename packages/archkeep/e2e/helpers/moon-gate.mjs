// The Moon CLI gate shared by every suite whose scenarios need a runnable
// Moon (`moon.e2e.mjs`, and the Moon arm of `parity.e2e.mjs`).
//
// Can the `moon` CLI run here at all? The fixtures are Moon workspaces and
// the Moon provider calls `moon project-graph --json`; the consumers install
// `@moonrepo/cli` as a devDependency, so Moon lives in the consumer's own
// `node_modules/.bin`. This probe only asks whether Moon runs on this platform
// (the consumer's install would fail otherwise, with a more confusing error).
import { execSync } from "node:child_process";
import { writeSync } from "node:fs";

import { describe as vitestDescribe, it } from "vitest";

let moonAvailable = false;
let moonProbeFailure = "";
try {
  execSync("npx moon --version", { stdio: "pipe" });
  moonAvailable = true;
} catch (cause) {
  // The last few meaningful lines only: a failing `npx` prints a screenful of
  // registry and config warnings ahead of the fact, and a reason nobody reads
  // to the end of is barely better than no reason.
  moonProbeFailure = String(cause?.stderr || cause?.message || cause)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-3)
    .join(" · ");
}

// A suite whose Moon scenarios all vanish is byte-for-byte identical, in its
// Moon arm, to one that passed — `AGENTS.md`'s invariant ("an empty result is
// a claim"), applied to a suite rather than to a diagnostic list. Nothing
// upstream catches it either: `ci.yml`'s E2E job fails a shard that resolves
// NO test file and one that resolves fewer files than shards, and a file
// whose gated describe skipped everything is neither.
//
// So in CI an unavailable Moon is a FAILURE, never a skip. `@moonrepo/cli` is
// a declared devDependency of the consumer fixtures these suites build, and
// CI runs on a platform Moon ships for, so "Moon cannot run" there is a real
// breakage — a broken install, a removed dependency, a platform the release
// dropped — and every one of those is a thing to fix rather than to step
// over.
//
// Locally the skip stays, because a contributor without a working Moon should
// still be able to run the rest of the suite. What it may not do is stay
// SILENT: the reason is printed, so a developer who sees the Moon scenarios
// missing knows why rather than assuming they passed.
const moonRequired = Boolean(process.env.CI);
const unavailableReason =
  "archkeep e2e: `npx moon --version` could not run, so the Moon E2E scenarios did not execute. " +
  "`@moonrepo/cli` is a declared devDependency of the consumer fixtures, so on a supported " +
  `platform this is a broken install rather than an unsupported one. Probe failure: ${moonProbeFailure}`;

const gatedDescribe = moonAvailable ? vitestDescribe : vitestDescribe.skip;

if (!moonAvailable) {
  if (moonRequired) {
    // A registered, failing test rather than a module-scope throw: a
    // collection error names the file, this names the REASON, in the
    // reporter's own list where a reader is already looking for what went
    // wrong.
    vitestDescribe("Moon CLI availability", () => {
      it("has a runnable Moon CLI, which CI requires rather than skips", () => {
        throw new Error(unavailableReason);
      });
    });
  } else {
    // Written to the real stderr descriptor, not through `console`. Measured
    // against vitest 4.1.11: a file whose every test is skipped has its
    // console output dropped by the default reporter, and so does a test that
    // calls `ctx.skip()` — through either channel the reason never reaches the
    // terminal, and the run prints a bare skipped count that reads exactly
    // like a suite nobody needed. `writeSync(2, …)` is below the interception
    // and always arrives.
    writeSync(2, `\n${unavailableReason}\n\n`);
  }
}

export { gatedDescribe, moonAvailable };
