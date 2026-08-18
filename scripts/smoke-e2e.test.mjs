// Tests for smoke-e2e.mjs.
//
// The gate's decision — did any test actually run? — is `executedTests`, a
// pure function of the JSON report vitest writes. It is the whole difference
// between "smoke ran and passed" and "smoke ran nothing and passed by
// accident", so it is tested directly. What is deliberately NOT tested here
// is the spawn itself: the real gate runs in CI against the real suite, and
// a test that stubbed vitest's output would only pin the stub.
//
// Each case pins one state of the report. A zero-executed report (a `-t`
// pattern that matched nothing — vitest reports every test as "skipped" and
// still exits 0) must count 0, which is the silent hole this gate exists to
// close.

import { test } from "node:test";
import assert from "node:assert/strict";

import { executedTests } from "./smoke-e2e.mjs";

test("counts every test that executed, pass or fail", () => {
  const report = {
    testResults: [
      {
        assertionResults: [{ status: "passed" }, { status: "failed" }, { status: "passed" }],
      },
      {
        assertionResults: [{ status: "passed" }],
      },
    ],
  };
  assert.equal(executedTests(report), 4);
});

test("counts zero when every test was skipped — the zero-match -t shape", () => {
  // `vitest run -t 'nope'` exits 0 with every test reported "skipped"; a
  // gate that read "no failures" as green would pass on that shape.
  const report = {
    testResults: [
      {
        assertionResults: [{ status: "skipped" }, { status: "skipped" }],
      },
    ],
  };
  assert.equal(executedTests(report), 0);
});

test("ignores the inconclusive statuses the JSON reporter never emits for run tests", () => {
  // Guard against a status value appearing in a future reporter version and
  // being mistaken for an execution.
  const report = {
    testResults: [
      {
        assertionResults: [{ status: "pending" }, { status: "todo" }],
      },
    ],
  };
  assert.equal(executedTests(report), 0);
});

test("an empty report has nothing executed", () => {
  assert.equal(executedTests({ testResults: [] }), 0);
  assert.equal(executedTests({}), 0);
});
