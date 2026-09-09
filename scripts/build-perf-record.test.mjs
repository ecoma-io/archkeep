// Tests for the pure assembly functions in `build-perf-record.mjs`. The
// fixtures are real shapes — job names as the GitHub API and the log zip
// spell them — and each test names the silent direction it guards. No
// filesystem, no mocking library (AGENTS.md, "The gate scripts take their
// facts as arguments").

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRecord,
  logJobNameOf,
  normalizeJobName,
  vitestSuiteOf,
} from "./build-perf-record.mjs";

test("vitestSuiteOf — .e2e.mjs files are e2e, others unit", () => {
  assert.equal(vitestSuiteOf("packages/archkeep/e2e/parity.e2e.mjs"), "e2e");
  assert.equal(vitestSuiteOf("src/intent/intent.test.mjs"), "unit");
});

test("logJobNameOf — strips the numeric prefix and .txt suffix", () => {
  assert.equal(logJobNameOf("4_Verify (core) Node 22.txt"), "Verify (core) Node 22");
  assert.equal(logJobNameOf("0_ci-gate.txt"), "ci-gate");
});

test("normalizeJobName — folds / to _ (the log zip does the same)", () => {
  assert.equal(normalizeJobName("Verify (E2E 1/2)"), "Verify (E2E 1_2)");
});

test("buildRecord — joins logs to jobs, parses both suites, zero gaps", () => {
  const logs = [
    { jobName: "Verify (core) Node 22", text: "▮▮▮▮ archkeep:lint (33s 433ms, e708a2a4)" },
    { jobName: "Verify (E2E 1_2)", text: "✓ e2e/parity.e2e.mjs (5 tests) 56012ms" },
  ];
  const jobs = [
    {
      name: "Verify (core) Node 22",
      startedAt: "2026-09-08T10:00:00Z",
      completedAt: "2026-09-08T10:05:00Z",
      conclusion: "success",
    },
    {
      name: "Verify (E2E 1/2)",
      startedAt: "2026-09-08T10:00:00Z",
      completedAt: "2026-09-08T10:02:00Z",
      conclusion: "success",
    },
  ];
  const record = buildRecord(logs, jobs, {
    id: 1,
    headSha: "abc",
    event: "pull_request",
    conclusion: "success",
    createdAt: "t",
    updatedAt: "t",
  });
  assert.equal(Object.keys(record.jobs).length, 2);
  assert.equal(record.gaps.length, 0, "a complete run must produce zero gaps");
  assert.equal(record.jobs["Verify (core) Node 22"].moon.count, 1);
  assert.equal(record.jobs["Verify (core) Node 22"].wallSec, 300);
  assert.equal(record.jobs["Verify (E2E 1_2)"].vitest.e2e.count, 1);
});

test("buildRecord — a job with no log entry is a named gap (silent direction)", () => {
  // If a missing log collapsed to an empty record, a broken log download
  // would read as "measured, and clean" — the exact failure the invariant
  // exists to prevent.
  const record = buildRecord(
    [],
    [{ name: "Verify (core) Node 22", startedAt: null, completedAt: null, conclusion: "skipped" }],
    {
      id: 1,
      headSha: "abc",
      event: "pull_request",
      conclusion: "skipped",
      createdAt: "t",
      updatedAt: "t",
    },
  );
  assert.equal(record.gaps.length, 1);
  assert.match(record.gaps[0], /log entry absent for job "Verify \(core\) Node 22"/);
});

test("buildRecord — a log with no API metadata is a named gap too", () => {
  const record = buildRecord(
    [{ jobName: "Verify (core) Node 24", text: "no parseable content" }],
    [],
    { id: 1, headSha: "abc", event: "push", conclusion: null, createdAt: "t", updatedAt: "t" },
  );
  assert.equal(record.jobs["Verify (core) Node 24"].moon, undefined);
  assert.equal(record.jobs["Verify (core) Node 24"].vitest, undefined);
  assert.equal(record.gaps.length, 1);
  assert.match(record.gaps[0], /metadata absent/);
});
