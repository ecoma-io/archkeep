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

test("skips flags before the target list", () => {
  // CI uses --force to bypass Moon's VCS affected detection and local cache.
  const workflow = `- run: moon run --force ...:lint ...:test ...:typecheck\n`;
  assert.deepEqual(parseCiTargets(workflow), ["lint", "test", "typecheck"]);
});

test("a flag after the first target still stops the loop", () => {
  // Once a target has been seen, a flag is a trailing token — stop there.
  const workflow = `- run: moon run --force ...:lint --parallel ...:test\n`;
  assert.deepEqual(parseCiTargets(workflow), ["lint"]);
});

test("joins a shell line continuation into one logical invocation", () => {
  // A `moon run ...:lint \` followed on the next physical line by
  // `...:test ...:typecheck` is one invocation split across two lines by a
  // shell continuation, not two separate ones — all three targets must be
  // read, not just the ones on the first physical line.
  const workflow = [
    "      - run: |",
    "          pnpm exec moon run --force ...:lint \\",
    "            ...:test ...:typecheck",
    "",
  ].join("\n");
  assert.deepEqual(parseCiTargets(workflow), ["lint", "test", "typecheck"]);
});

test("unions targets across two separate moon run invocations", () => {
  // CI can (and once did) split the real run across more than one `moon run`
  // step; every invocation found must contribute, not just the first.
  const workflow = [
    "      - run: moon run ...:lint",
    "      - run: moon run ...:test ...:typecheck",
    "",
  ].join("\n");
  assert.deepEqual(parseCiTargets(workflow), ["lint", "test", "typecheck"]);
});

test("a comment mentioning 'moon run' does not seed or pollute the target list", () => {
  // A whole-line comment is dropped before targets are extracted, so prose
  // that happens to contain the words "moon run" can never become the
  // source of the enforced target list.
  const workflow = [
    "      # See the moon run wiki for available targets: build, deploy, hack",
    "      - run: pnpm test",
    "",
  ].join("\n");
  assert.deepEqual(parseCiTargets(workflow), []);
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

test("reads the target list out of a moon ci invocation the same way", () => {
  // PR CI runs the affected form; the roster it names is the same one the
  // full run names, and this gate holds both to it.
  const workflow = `- run: pnpm exec moon ci :lint :test :typecheck --base origin/main --affected\n`;
  assert.deepEqual(parseCiTargets(workflow), ["lint", "test", "typecheck"]);
});

test("a project-qualified target does not join the every-project roster", () => {
  // `archkeep:e2e` is one project's target: Moon itself fails a run that
  // names a target no project declares, so holding every package to it here
  // would only manufacture a false gap in every ok line.
  const workflow = `- run: moon ci archkeep:e2e :lint --base origin/main\n`;
  assert.deepEqual(parseCiTargets(workflow), ["lint"]);
});

test("an extra required root is judged like a package directory", () => {
  const { lines, failures } = evaluate({
    packageDirs: [],
    projects: [{ name: "gate-scripts", root: "scripts", targets: ["lint", "test"] }],
    ciTargets: ["lint", "test"],
    extraRequiredRoots: ["scripts"],
  });
  assert.deepEqual(failures, []);
  assert.equal(lines[0], "0 packages — declared empty");
  // The point of the state is that a reader is told, so the output has to say
  // so in words rather than merely exit 0 the way the workspace tool does.
  assert.match(lines.join("\n"), /runs nothing/);
  assert.deepEqual(lines[2], "ok   gate-scripts — lint, test");
});

test("an extra required root no project claims fails instead of passing in silence", () => {
  // scripts/ sits outside the packages glob, so deleting its manifest would
  // otherwise be exactly the invisible-directory state this gate exists to
  // catch — reached by no scan at all.
  const { failures } = evaluate({
    packageDirs: [],
    projects: [],
    ciTargets: ["lint"],
    extraRequiredRoots: ["scripts"],
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /scripts.*not a project/);
});

test("an extra required root declaring no CI target fails instead of being skipped", () => {
  const { failures } = evaluate({
    packageDirs: [],
    projects: [{ name: "gate-scripts", root: "scripts", targets: ["serve"] }],
    ciTargets: ["lint"],
    extraRequiredRoots: ["scripts"],
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /declares none of the targets/);
});
