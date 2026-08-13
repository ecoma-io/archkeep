// Tests for check-packages.mjs.
//
// `evaluate` and `parseCiTargets` take every fact they need as an argument, so
// these run with no workspace, no filesystem and no mocking framework — the
// logic already sits at the isolation boundary. What is deliberately NOT tested
// here is `readMoonProjects`: it exists to ask Moon a question, and a test that
// stubbed the answer would only pin the stub. The real thing is exercised by
// `pnpm check-packages` in CI, against the real graph.
//
// Each case is named by the state it pins, and each of the three states named in
// check-packages.mjs's header has one — a gate whose own tests do not distinguish
// those three would be repeating the defect it was written to catch.

import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluate, parseCiTargets } from "./check-packages.mjs";

test("reads the target list out of the workflow's moon run ...: invocation", () => {
  const workflow = `
jobs:
  verify:
    steps:
      - run: pnpm check-packages
      - run: moon run ...:lint ...:test ...:typecheck
`;
  assert.deepEqual(parseCiTargets(workflow), ["lint", "test", "typecheck"]);
});

test("strips the ...: prefix Moon uses for all-projects targets", () => {
  const workflow = `- run: moon run ...:lint ...:test ...:typecheck\n`;
  assert.deepEqual(parseCiTargets(workflow), ["lint", "test", "typecheck"]);
});

test("stops at the first token that is not a target name", () => {
  const workflow = `- run: moon run ...:lint ...:test --log=debug\n`;
  assert.deepEqual(parseCiTargets(workflow), ["lint", "test"]);
});

test("reports no targets when the workflow does not run the workspace's targets", () => {
  // The caller treats this as a hard failure rather than as "nothing to check":
  // a workflow with no moon run means this script no longer knows what green is.
  assert.deepEqual(parseCiTargets(`jobs:\n  verify:\n    steps:\n      - run: pnpm lint\n`), []);
});

test("an empty packages directory is declared rather than passed in silence", () => {
  const { lines, failures } = evaluate({
    packageDirs: [],
    projects: [],
    ciTargets: ["lint", "test"],
  });
  assert.deepEqual(failures, []);
  assert.equal(lines[0], "0 packages — declared empty");
  // The point of the state is that a reader is told, so the output has to say so
  // in words rather than merely exit 0 the way the workspace tool already does.
  assert.match(lines.join("\n"), /runs nothing/);
});

test("a directory with no manifest fails instead of being skipped as invisible", () => {
  const { failures } = evaluate({
    packageDirs: ["orphan"],
    projects: [],
    ciTargets: ["lint", "test"],
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /packages\/orphan/);
  assert.match(failures[0], /no manifest/);
});

test("a project declaring none of the CI targets fails instead of being skipped", () => {
  const { failures } = evaluate({
    packageDirs: ["noscript"],
    projects: [{ name: "noscript", root: "packages/noscript", targets: ["serve"] }],
    ciTargets: ["lint", "test"],
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /declares none of the targets CI runs/);
});

test("a project declaring every CI target passes", () => {
  const { lines, failures } = evaluate({
    packageDirs: ["graph"],
    projects: [{ name: "graph", root: "packages/graph", targets: ["lint", "test"] }],
    ciTargets: ["lint", "test"],
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(lines, ["ok   graph — lint, test"]);
});

test("a project declaring some CI targets passes, and the log names the gap", () => {
  // Not every package legitimately has every target, so a partial set is
  // reported rather than failed — but it must be reported, or the difference
  // between "buildless on purpose" and "forgot the build target" is invisible.
  const { lines, failures } = evaluate({
    packageDirs: ["graph"],
    projects: [{ name: "graph", root: "packages/graph", targets: ["lint", "test"] }],
    ciTargets: ["lint", "test", "build"],
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(lines, ["ok   graph — lint, test (no build)"]);
});

test("a project whose root is not the directory it sits in does not vouch for it", () => {
  // The workspace tool names a project freely, so identity has to be matched on
  // root. Matching on name would let a project called `orphan` elsewhere in the
  // tree satisfy the check for `packages/orphan`.
  const { failures } = evaluate({
    packageDirs: ["orphan"],
    projects: [{ name: "orphan", root: "tools/orphan", targets: ["lint", "test"] }],
    ciTargets: ["lint", "test"],
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /invisible|no manifest/);
});

test("every package directory is judged, not just the first", () => {
  const { failures } = evaluate({
    packageDirs: ["good", "orphan", "noscript"],
    projects: [
      { name: "good", root: "packages/good", targets: ["lint", "test"] },
      { name: "noscript", root: "packages/noscript", targets: ["serve"] },
    ],
    ciTargets: ["lint", "test"],
  });
  assert.equal(failures.length, 2);
});
