// Tests for ci-workflow-facts.mjs.
//
// Every function takes workflow text and returns data, so these run with no
// filesystem — the same isolation boundary `check-packages.test.mjs` tests
// from. The fixtures below are shaped like the workflows this repository
// actually formats (Prettier's two-space job indent), because a reader that
// only parsed YAML no human would write would pin nothing real. Each case
// names the misread it refuses; the silent one is a step-level `if:` or a
// `uses:` captured where it should not be, which would make the drift pins
// either blind or falsely red.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseActionRefs, parseContainerImages, parseJobs } from "./ci-workflow-facts.mjs";

test("reads job ids, flow-array needs, and the job-level if", () => {
  const text = [
    "name: CI",
    "on:",
    "  push:",
    "jobs:",
    "  verify:",
    "    runs-on: ubuntu-latest",
    "  gate:",
    "    needs: [verify, e2e]",
    "    if: always()",
    "    steps:",
    "      - run: exit 1",
  ].join("\n");
  assert.deepEqual(parseJobs(text), [
    { id: "verify", needs: [], gateIf: null },
    { id: "gate", needs: ["verify", "e2e"], gateIf: "always()" },
  ]);
});

test("reads scalar needs the way release.yml writes them", () => {
  const text = "jobs:\n  publish:\n    needs: prepare\n    if: needs.prepare.result == 'success'\n";
  assert.deepEqual(parseJobs(text), [
    { id: "publish", needs: ["prepare"], gateIf: "needs.prepare.result == 'success'" },
  ]);
});

test("reads block-sequence needs", () => {
  const text = ["jobs:", "  gate:", "    needs:", "      - build", "      - test", ""].join("\n");
  assert.deepEqual(parseJobs(text)[0].needs, ["build", "test"]);
});

test("a trigger key before jobs: is never mistaken for a job id", () => {
  // `pull_request:` sits at the same two-space indent a job id has — under
  // `on:`. Only what follows `jobs:` counts.
  const text = ["on:", "  pull_request:", "  push:", "jobs:", "  verify:", ""].join("\n");
  assert.deepEqual(
    parseJobs(text).map((job) => job.id),
    ["verify"],
  );
});

test("a step-level if is never captured as the job's gate", () => {
  // The silent misread: a pin over job gates that also saw step conditions
  // would compare expressions that were never meant to match each other.
  const text = [
    "jobs:",
    "  verify:",
    "    steps:",
    "      - name: Skipped on forks",
    "        if: github.event_name != 'schedule'",
    "        run: echo hi",
    "",
  ].join("\n");
  assert.equal(parseJobs(text)[0].gateIf, null);
});

test("whole-line comments are dropped before anything is read", () => {
  const text = [
    "# A note quoting `needs: [ghost]` in prose.",
    "# jobs:",
    "#   phantom:",
    "jobs:",
    "  verify: # trailing comment on the id line",
    "    needs: [one] # trailing comment on a value line",
    "",
  ].join("\n");
  assert.deepEqual(parseJobs(text), [{ id: "verify", needs: ["one"], gateIf: null }]);
});

test("text without a jobs mapping yields no jobs rather than invented ones", () => {
  assert.deepEqual(parseJobs("on:\n  push:\n"), []);
});

test("every uses: ref is read with its line number", () => {
  const text = [
    "jobs:",
    "  verify:",
    "    steps:",
    "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
    "        with:",
    "          fetch-depth: 0",
    "      - run: pnpm install",
    "      - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10",
    "",
  ].join("\n");
  assert.deepEqual(parseActionRefs(text), [
    { ref: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", line: 4 },
    { ref: "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86", line: 8 },
  ]);
});

test("every container image is read, wherever its block sits", () => {
  const text = [
    "jobs:",
    "  scan:",
    "    container:",
    "      image: semgrep/semgrep:1.172.0@sha256:" + "a".repeat(64),
    "    steps:",
    "      - run: semgrep --version",
    "",
  ].join("\n");
  assert.deepEqual(parseContainerImages(text), [
    { image: `semgrep/semgrep:1.172.0@sha256:${"a".repeat(64)}`, line: 4 },
  ]);
});

test("a workflow with no actions or images yields empty lists, loudly consumed by callers", () => {
  assert.deepEqual(parseActionRefs("jobs:\n  verify:\n    steps:\n      - run: true\n"), []);
  assert.deepEqual(parseContainerImages("jobs:\n  verify:\n"), []);
});
