// Tests for semantic-mutation.mjs.
//
// The harness's logic sits at the isolation boundary — `evaluateMutations`
// takes the test runner as an argument and `applyMutationAndRun` takes its
// file operations as an object — so these tests run with no filesystem, no
// child process, and no mocking framework. What is deliberately NOT tested
// here is `main`: it exists to touch the real tree and spawn vitest, and a
// test that stubbed those would only pin the stub. The real thing is
// exercised by the nightly workflow against the real tree.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  anySurvived,
  applyMutationAndRun,
  evaluateMutations,
  reverifySurvivors,
  signalGuard,
  testFileFor,
  verdictFromSpawn,
} from "./semantic-mutation.mjs";

// --- testFileFor: the source→test colocated mapping ---

test("maps a source module to its colocated test file", () => {
  assert.equal(
    testFileFor("packages/archkeep/src/verdict.mjs"),
    "packages/archkeep/src/verdict.test.mjs",
  );
});

test("maps a nested source module to its nested colocated test file", () => {
  assert.equal(
    testFileFor("packages/archkeep/src/graph/create-dependencies.mjs"),
    "packages/archkeep/src/graph/create-dependencies.test.mjs",
  );
});

test("replaces only the trailing .mjs, not an interior one", () => {
  assert.equal(
    testFileFor("packages/archkeep/src/some.mjs.dir/file.mjs"),
    "packages/archkeep/src/some.mjs.dir/file.test.mjs",
  );
});

// --- evaluateMutations: the pure orchestration ---

test("all mutants killed passes", () => {
  const manifest = [{ name: "alpha" }, { name: "beta" }];
  const results = evaluateMutations(manifest, () => ({
    killed: true,
    durationMs: 10,
  }));
  assert.deepEqual(results, [
    { name: "alpha", killed: true, durationMs: 10 },
    { name: "beta", killed: true, durationMs: 10 },
  ]);
  assert.equal(anySurvived(results), false);
});

test("one survivor is named and anySurvived is true", () => {
  const manifest = [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }];
  const results = evaluateMutations(manifest, (name) => ({
    killed: name !== "beta",
    durationMs: 5,
  }));
  assert.equal(anySurvived(results), true);
  const survivor = results.find((r) => !r.killed);
  assert.ok(survivor, "the survivor must be in the results");
  assert.equal(survivor.name, "beta");
});

test("the runner is called once per manifest entry, in order", () => {
  const calls = [];
  const manifest = [{ name: "first" }, { name: "second" }, { name: "third" }];
  evaluateMutations(manifest, (name) => {
    calls.push(name);
    return { killed: true, durationMs: 1 };
  });
  assert.deepEqual(calls, ["first", "second", "third"]);
});

test("durations pass through untouched", () => {
  const manifest = [{ name: "timed" }];
  const results = evaluateMutations(manifest, () => ({
    killed: true,
    durationMs: 12345,
  }));
  assert.equal(results[0].durationMs, 12345);
});

// --- applyMutationAndRun: apply → run → restore, in every outcome ---

test("applies, runs, restores in the normal (killed) path", () => {
  const calls = [];
  const io = {
    apply: (m) => calls.push(`apply:${m.file}`),
    restore: (m) => calls.push(`restore:${m.file}`),
    runSuite: () => ({ killed: true, durationMs: 42 }),
  };
  const result = applyMutationAndRun(io, { name: "x", file: "a.mjs" });
  assert.equal(result.killed, true);
  assert.equal(result.durationMs, 42);
  assert.deepEqual(calls, ["apply:a.mjs", "restore:a.mjs"]);
});

test("restores even when the suite throws", () => {
  let restored = false;
  const io = {
    apply: () => {},
    restore: () => {
      restored = true;
    },
    runSuite: () => {
      throw new Error("suite crashed");
    },
  };
  const result = applyMutationAndRun(io, { name: "boom", file: "a.mjs" });
  assert.equal(restored, true, "restore must run even on a throw");
  assert.equal(result.killed, false, "a crashed suite is not a killed mutant");
  assert.equal(result.error, "suite crashed");
});

test("a non-Error throw is still recorded and still restored", () => {
  let restored = false;
  const io = {
    apply: () => {},
    restore: () => {
      restored = true;
    },
    runSuite: () => {
      throw "string throw";
    },
  };
  const result = applyMutationAndRun(io, { name: "boom", file: "a.mjs" });
  assert.equal(restored, true);
  assert.equal(result.error, "string throw");
});

// --- signalGuard: restore-then-exit order on the crash path ---

test("a guard restores every resident mutant BEFORE exiting", () => {
  const order = [];
  const handler = signalGuard(
    () => order.push("restore"),
    (code) => order.push(`exit:${code}`),
    143,
  );
  handler();
  assert.deepEqual(order, ["restore", "exit:143"]);
});

test("guards pass their exit status through — SIGINT, SIGTERM, crash codes differ", () => {
  let seen;
  const handler = signalGuard(
    () => {},
    (code) => {
      seen = code;
    },
    130,
  );
  handler();
  assert.equal(seen, 130);
});

test("restore runs even when it has nothing to restore — guards are idempotent", () => {
  let calls = 0;
  let exited = 0;
  const handler = signalGuard(
    () => {
      calls += 1;
    },
    () => {
      exited += 1;
    },
    1,
  );
  handler();
  handler();
  assert.equal(calls, 2);
  assert.equal(exited, 2);
});

// --- reverifySurvivors: the red-direction guard (#860) ---
//
// The colocated file is the fast judge, not the complete one: a covering
// test can live in an integration file the colocated mapping never names.
// A mutant the full package suite kills must therefore NOT be reported as
// a survivor — before reverifySurvivors existed, that case passed
// silently and produced exactly the false finding #860 records.

test("a mutant the full suite kills is corrected from SURVIVED to killed", () => {
  const results = [{ name: "false-survivor", killed: false, durationMs: 100 }];
  reverifySurvivors(results, (name) => {
    assert.equal(name, "false-survivor");
    return { killed: true, durationMs: 300 };
  });
  assert.equal(results[0].killed, true, "full-suite kill must flip the verdict");
  assert.equal(results[0].fullSuiteVerified, true);
  assert.equal(results[0].durationMs, 400, "durations accumulate across passes");
});

test("genuine survivors, dirty skips, and already-killed mutants are not touched", () => {
  const results = [
    { name: "killed-colocated", killed: true, durationMs: 5 },
    { name: "genuine-survivor", killed: false, durationMs: 200 },
    { name: "skipped-dirty", killed: false, durationMs: 0 },
  ];
  const judged = [];
  reverifySurvivors(results, (name) => {
    judged.push(name);
    return { killed: false, durationMs: 50 };
  });
  // Only the colocated survivor was re-judged — killed and skipped were not.
  assert.deepEqual(judged, ["genuine-survivor"]);
  assert.equal(results[0].fullSuiteVerified, undefined);
  assert.equal(results[1].killed, false, "a mutant surviving both passes is a real finding");
  assert.equal(results[1].fullSuiteVerified, undefined);
  assert.equal(results[2].durationMs, 0);
});

test("a timed-out full-suite verdict never flips a survivor to killed", () => {
  const results = [{ name: "unjudged", killed: false, durationMs: 100 }];
  reverifySurvivors(results, () => ({
    killed: false,
    durationMs: 600_000,
    error: "full suite timed out (signal SIGTERM)",
  }));
  assert.equal(
    results[0].killed,
    false,
    "a timed-out suite judges nothing — killed would hide the mutant's true fate",
  );
  assert.equal(results[0].fullSuiteVerified, undefined);
  assert.match(results[0].error, /timed out/, "the inconclusive verdict must be loud, not silent");
});

// --- verdictFromSpawn: only a numeric non-zero exit kills (#860's silent direction) ---

test("spawnSync timeout (status null) is inconclusive, never a kill", () => {
  const verdict = verdictFromSpawn({ status: null, signal: "SIGTERM" });
  assert.equal(verdict.killed, false, "status null !== 0 must NOT classify as killed");
  assert.match(verdict.error, /timed out/);
  assert.match(verdict.error, /SIGTERM/);
});

test("spawn failure (child.error) is inconclusive, never a kill", () => {
  const verdict = verdictFromSpawn({ status: null, signal: null, error: new Error("ENOENT") });
  assert.equal(verdict.killed, false);
  assert.match(verdict.error, /spawn failed/);
  assert.match(verdict.error, /ENOENT/);
});

test("a numeric non-zero exit still kills; exit zero is the only survivor verdict", () => {
  assert.deepEqual(verdictFromSpawn({ status: 1, signal: null }), { killed: true });
  assert.deepEqual(verdictFromSpawn({ status: 2, signal: null }), { killed: true });
  assert.deepEqual(verdictFromSpawn({ status: 0, signal: null }), { killed: false });
});
