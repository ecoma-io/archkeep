// Tests for `perf-parse.mjs`. The fixtures below are real log shapes — taken
// from actual archkeep CI logs (moon 2.x on `ubuntu-latest`, vitest 5 default
// reporter) — abbreviated to the lines the parser must get right. A test
// names the silent direction it guards: a parser that matched less than it
// should would report fewer tasks/files than ran, and a parser that matched
// more would invent duration data that has docs/development/verification.md.
//
// These are pure-function tests: no filesystem, no mocking library — the
// same principle the other gate-script docs/development/verification.md use (AGENTS.md,
// "The gate scripts take their facts as arguments").

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseMoonTasks,
  parseMoonDuration,
  parseVitestFiles,
  stripAnsi,
  sumFileMs,
} from "./perf-parse.mjs";

test("stripAnsi removes SGR sequences around the tokens a parser needs", () => {
  assert.equal(stripAnsi("plain"), "plain");
  assert.equal(stripAnsi("a\x1b[32m✓\x1b[39m b\x1b[1m4\x1b[22m"), "a✓ b4");
  // Multi-parameter sequences (bold green) are also SGR.
  assert.equal(stripAnsi("x\x1b[1;32mfg\x1b[0m"), "xfg");
});

test("parseMoonDuration — unit shapes moon actually prints", () => {
  assert.equal(parseMoonDuration("1m 4s 600ms"), 64.6);
  assert.equal(parseMoonDuration("3s 100ms"), 3.1);
  assert.equal(parseMoonDuration("42s"), 42);
  assert.equal(parseMoonDuration("500ms"), 0.5);
  assert.equal(parseMoonDuration("1m 30s"), 90);
});

test("parseMoonDuration — the 'm' of 'ms' is not minutes (silent direction)", () => {
  // If "39ms" were read as 39 minutes, the perf record would inflate short
  // tasks a thousandfold with no red anywhere — the record itself is the
  // only thing that could catch it.
  assert.equal(parseMoonDuration("39ms"), 0.039);
});

test("parseMoonTasks — completion lines from a real run", () => {
  const text = [
    "Run started",
    "▮▮▮▮ archkeep:lint (33s 433ms, e708a2a4)",
    "▮▮▮▮ archkeep:typecheck (2s 106ms, 3a1f00bb)",
    "▮▮▮▮ archkeep:test (2m 1s 306ms, e708a2a4)",
  ].join("\n");
  const tasks = parseMoonTasks(text);
  assert.equal(tasks.length, 3);
  assert.deepEqual(
    tasks.map((t) => t.task),
    ["archkeep:lint", "archkeep:typecheck", "archkeep:test"],
  );
  assert.equal(tasks[0].durationSec, 33.433);
  assert.equal(tasks[2].durationSec, 121.306);
  assert.ok(tasks.every((t) => !t.cached));
});

test("parseMoonTasks — cached lines record cached=true, not a fake duration", () => {
  const tasks = parseMoonTasks("▮▮▮▮ scripts:lint (cached, e708a2a4)");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].cached, true);
  assert.equal(tasks[0].durationSec, 0);
});

test("parseMoonTasks — non-task lines are skipped (silent direction)", () => {
  // Headers and warnings must not become tasks with invented durations.
  const tasks = parseMoonTasks(
    ["Run started", "◉ provisioning", "WARN some moon warning", ""].join("\n"),
  );
  assert.deepEqual(tasks, []);
});

test("parseVitestFiles — completion lines from a real E2E run", () => {
  const text = [
    "RUN v2.1.9 /home/runner/work/archkeep/archkeep",
    "✓ e2e/parity.e2e.mjs (5 tests) 56012ms",
    "✓ e2e/sweep.e2e.mjs (3 tests) 34012ms",
  ].join("\n");
  const files = parseVitestFiles(text);
  assert.equal(files.length, 2);
  assert.equal(files[0].file, "e2e/parity.e2e.mjs");
  assert.equal(files[0].tests, 5);
  assert.equal(files[0].durationMs, 56012);
});

test("parseVitestFiles — slow-files section is not double counted (silent direction)", () => {
  // The slow-files summary repeats files as `❯ name (N tests | 1 failed) Dms`.
  // The `|` clause breaks the `(\d+) tests)` match, so summary lines do not
  // count a file twice and inflate shard totals.
  const text = [
    "✓ e2e/parity.e2e.mjs (5 tests) 56012ms",
    "❯ e2e/parity.e2e.mjs (5 tests | 1 failed) 56012ms",
  ].join("\n");
  const files = parseVitestFiles(text);
  assert.equal(files.length, 1);
});

test("sumFileMs — totals a file list", () => {
  assert.equal(
    sumFileMs([
      { file: "a.e2e.mjs", tests: 1, durationMs: 100 },
      { file: "b.e2e.mjs", tests: 2, durationMs: 250 },
    ]),
    350,
  );
  assert.equal(sumFileMs([]), 0);
});
