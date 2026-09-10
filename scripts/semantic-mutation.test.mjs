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
  signalGuard,
  testFileFor,
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
