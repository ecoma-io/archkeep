// Tests for check-contributing-parity.mjs.
//
// Every fact arrives as an argument — workflow text, document text, hook-file
// text, the exception table — so these run with no filesystem and no mocking.
// The final two cases read the repository's real files and are the live
// enforcement point under CI's `pnpm test`.
//
// The two acceptance directions from the issue each have a red fixture:
// a step added to CI without documentation fails naming it, and a hook
// command removed from lefthook.yml while the row still names it fails. A pin
// whose tests only asserted today's green would keep passing while it
// compared nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DOC_PATH,
  EXCEPTIONS,
  HOOKS_HEADING,
  LEFTHOOK_PATH,
  WORKFLOW_PATH,
  collectCommandSpans,
  evaluateContributing,
  evaluateHooks,
  extractHookBullets,
  parseLefthookHooks,
  parseWorkflowInvocations,
  runSignature,
  shellSegments,
  spanMatchesSignature,
} from "./check-contributing-parity.mjs";

const WORKFLOW = [
  "jobs:",
  "  verify:",
  "    steps:",
  "      - name: Title",
  "        run: printf '%s\\n' \"${{ github.event.pull_request.title }}\" | pnpm exec commitlint",
  "      - run: pnpm format:check",
  "      # a comment mentioning `pnpm lint` must not become a step",
  "      - run: pnpm lint",
  "      - name: Targets",
  "        run: |",
  "          rustup component add clippy",
  "      - run: pnpm exec moon run --force ...:lint ...:test ...:typecheck",
  "      - run: node scripts/check-skills.mjs",
  "      - run: |",
  "          set -euo pipefail",
  '          (cd "$dir" && node "$cli" check)',
].join("\n");

const DOC = [
  "# Contributing",
  "",
  "| Command             | What it does |",
  "| ------------------- | ------------ |",
  "| `pnpm format`       | in place     |",
  "| `pnpm format:check` | read-only    |",
  "| `pnpm lint`         | ESLint       |",
  "",
  "```bash",
  "moon run ...:lint ...:test ...:typecheck",
  "node scripts/check-skills.mjs",
  "```",
].join("\n");

const LEFTHOOK = [
  "pre-commit:",
  "  parallel: false",
  "  commands:",
  "    format:",
  '      glob: "*.{mjs,md}"',
  "      run: pnpm exec prettier --write --ignore-unknown {staged_files}",
  "      stage_fixed: true",
  "    packages:",
  "      run: pnpm check-packages",
  "",
  "pre-push:",
  "  commands:",
  "    test:",
  "      run: pnpm test",
  "",
  "commit-msg:",
  "  commands:",
  "    commitlint:",
  "      run: pnpm exec commitlint --edit {1}",
].join("\n");

const HOOKS_DOC = [
  "## What the hooks do",
  "",
  "| hook         | commands it runs, in order                                        |",
  "| ------------ | ----------------------------------------------------------------- |",
  "| `pre-commit` | `prettier` over the staged files; `check-packages`                 |",
  "| `commit-msg` | `commitlint`, checking the message shape                           |",
  "| `pre-push`   | `pnpm test`                                                        |",
].join("\n");

test("workflow parsing reads compact and property run steps alike", () => {
  const identities = parseWorkflowInvocations(WORKFLOW).map((invocation) => invocation.identity);
  assert.ok(identities.includes("pnpm exec commitlint"));
  assert.ok(identities.includes("pnpm format:check"));
  assert.ok(identities.includes("pnpm lint"));
  assert.ok(identities.includes("node scripts/check-skills.mjs"));
});

test("comments and non-pnpm/node steps never become CI invocations", () => {
  const identities = parseWorkflowInvocations(WORKFLOW).map((invocation) => invocation.identity);
  assert.ok(!identities.some((identity) => identity.includes("rustup")));
  assert.equal(identities.filter((identity) => identity === "pnpm lint").length, 1);
});

test("shellSegments splits pipes and strips expressions", () => {
  const segments = shellSegments(`printf '%s\\n' "x" | pnpm exec commitlint`);
  assert.deepEqual(segments, [`printf '%s\\n' "x"`, `pnpm exec commitlint`]);
});

test("a step added to CI without documentation fails naming it", () => {
  const withNewStep = `${WORKFLOW}\n      - run: pnpm frobnicate`;
  const { failures } = evaluateContributing({ contributingText: DOC, workflowText: withNewStep });
  const named = failures.filter((failure) => failure.includes("pnpm frobnicate"));
  assert.equal(named.length, 1);
  assert.match(named[0], /never mentions it/);
});

test("an undocumented step covered by an exception passes, and the reason travels", () => {
  const { failures } = evaluateContributing({
    contributingText: DOC.replace("`pnpm lint`", "`pnpm never-used`"),
    workflowText: WORKFLOW,
    exceptions: [...EXCEPTIONS, { identity: "pnpm lint", reason: "runner-only hygiene" }],
  });
  assert.deepEqual(failures, []);
});

test("a stale exception — its step gone from CI — fails loudly", () => {
  const withoutLint = WORKFLOW.replace("      - run: pnpm lint\n", "");
  const { failures } = evaluateContributing({
    contributingText: DOC,
    workflowText: withoutLint,
    exceptions: [{ identity: "pnpm lint", reason: "gone" }],
  });
  assert.ok(
    failures.some(
      (failure) => failure.includes("matches no step") && failure.includes("pnpm lint"),
    ),
  );
});

test("a moon run documented with fewer targets than CI runs fails naming the target", () => {
  const docMissingTest = DOC.replace(
    "moon run ...:lint ...:test ...:typecheck",
    "moon run ...:lint",
  );
  const { failures } = evaluateContributing({
    contributingText: docMissingTest,
    workflowText: WORKFLOW,
  });
  assert.ok(failures.some((failure) => failure.includes("moon run") && failure.includes("test")));
});

test("a variable-node step is satisfiable only through an explicit exception", () => {
  const withVarNode = `${WORKFLOW}\n      - run: (cd "$dir" && node "$cli" check)`;
  const withoutException = evaluateContributing({
    contributingText: DOC,
    workflowText: withVarNode,
    exceptions: [],
  });
  assert.ok(withoutException.failures.some((failure) => failure.includes('node "$cli"')));
  const withException = evaluateContributing({
    contributingText: DOC,
    workflowText: withVarNode,
    exceptions: [
      ...EXCEPTIONS,
      { identity: 'node "$cli"', reason: "composite CI-only self-check" },
    ],
  });
  assert.deepEqual(withException.failures, []);
});

test("a workflow or document with nothing comparable is a loud failure", () => {
  const emptyWorkflow = evaluateContributing({ contributingText: DOC, workflowText: "jobs: {}" });
  assert.ok(
    emptyWorkflow.failures.some((failure) => failure.includes("no pnpm or node invocation")),
  );
  const emptyDoc = evaluateContributing({ contributingText: "just prose", workflowText: WORKFLOW });
  assert.ok(emptyDoc.failures.some((failure) => failure.includes("no command spans")));
});

test("lefthook parsing keeps every command's own run value", () => {
  // Regression shape: a parser that let later blocks overwrite earlier ones
  // would leave one command holding another's run line.
  const hooks = parseLefthookHooks(LEFTHOOK);
  assert.deepEqual([...hooks.keys()], ["pre-commit", "pre-push", "commit-msg"]);
  assert.equal(
    hooks.get("pre-commit")?.get("format"),
    "pnpm exec prettier --write --ignore-unknown {staged_files}",
  );
  assert.equal(hooks.get("pre-commit")?.get("packages"), "pnpm check-packages");
  assert.equal(hooks.get("pre-push")?.get("test"), "pnpm test");
  assert.equal(hooks.get("commit-msg")?.get("commitlint"), "pnpm exec commitlint --edit {1}");
});

test("run signatures derive the tool and stop at flags and placeholders", () => {
  assert.deepEqual(runSignature("pnpm exec prettier --write --ignore-unknown {staged_files}"), [
    "prettier",
  ]);
  assert.deepEqual(runSignature("pnpm check-packages"), ["check-packages"]);
  assert.deepEqual(runSignature("pnpm exec moon projects"), ["moon", "projects"]);
  assert.deepEqual(runSignature("pnpm exec commitlint --edit {1}"), ["commitlint"]);
  assert.deepEqual(runSignature("{staged_files}"), []);
});

test("span matching ignores the span's own package-manager prefix and case", () => {
  // Prefix semantics are the point: a table cell may carry prose after the
  // tool name ("`prettier` over the staged files").
  assert.ok(spanMatchesSignature(["Prettier"], ["prettier"]));
  assert.ok(spanMatchesSignature(["pnpm", "test"], ["test"]));
  assert.ok(spanMatchesSignature(["moon", "projects"], ["moon", "projects"]));
  assert.ok(spanMatchesSignature(["prettier", "over", "the", "staged", "files"], ["prettier"]));
  assert.ok(!spanMatchesSignature(["eslintx"], ["eslint"]));
  assert.ok(!spanMatchesSignature(["unrelated"], ["prettier"]));
});

test("the hooks table parses by hook name with claimed spans", () => {
  const rows = extractHookBullets(`${HOOKS_DOC}\n\nProse after.`);
  assert.equal(rows.size, 3);
  assert.deepEqual(rows.get("pre-commit"), [["prettier"], ["check-packages"]]);
  assert.deepEqual(rows.get("pre-push"), [["pnpm", "test"]]);
  assert.ok(HOOKS_HEADING.test(HOOKS_DOC));
});

test("a hook command removed from lefthook.yml fails against its documented row", () => {
  const weakened = LEFTHOOK.split("\n")
    .filter((line) => !/^\s{4}packages:|^\s{6}run: pnpm check-packages/.test(line))
    .join("\n");
  const { failures } = evaluateHooks({ contributingText: HOOKS_DOC, lefthookText: weakened });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /pre-commit/);
  assert.match(failures[0], /check-packages/);
  assert.match(failures[0], /removed or weakened/);
});

test("a hook command added without documentation fails", () => {
  const grown = LEFTHOOK.replace(
    "    test:\n      run: pnpm test",
    "    test:\n      run: pnpm test\n    audit:\n      run: pnpm audit",
  );
  const { failures } = evaluateHooks({ contributingText: HOOKS_DOC, lefthookText: grown });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /audit/);
  assert.match(failures[0], /gained a gate/);
});

test("a whole hook removed fails in both directions; a phantom documented hook too", () => {
  const withoutPrePush = LEFTHOOK.split("\n")
    .filter((line) => !line.startsWith("pre-push"))
    .join("\n");
  const { failures } = evaluateHooks({ contributingText: HOOKS_DOC, lefthookText: withoutPrePush });
  assert.ok(
    failures.some((failure) => failure.includes("`pre-push`") && failure.includes("no such block")),
  );

  const phantomDoc = `${HOOKS_DOC}\n| \`post-commit\` | \`pnpm magic\` |`;
  void phantomDoc;
  const rowsWithPhantom = extractHookBullets(HOOKS_DOC).set("post-commit", [["pnpm", "magic"]]);
  void rowsWithPhantom;
  const phantom = evaluateHooks({
    contributingText: HOOKS_DOC.replace(
      "| `pre-push`   | `pnpm test`                                                        |",
      "| `pre-push`   | `pnpm test`                                                        |\n| `post-commit` | `pnpm magic` |",
    ),
    lefthookText: LEFTHOOK,
  });
  assert.ok(
    phantom.failures.some(
      (failure) => failure.includes("post-commit") && failure.includes("declares no such block"),
    ),
  );
});

test("an unreadable run value is loud rather than skipped", () => {
  const unreadable = LEFTHOOK.replace("run: pnpm check-packages", "run: {staged_files}");
  const { failures } = evaluateHooks({ contributingText: HOOKS_DOC, lefthookText: unreadable });
  assert.ok(failures.some((failure) => failure.includes("cannot read a tool signature")));
});

test("a missing hooks table or an empty hook file is a loud failure", () => {
  const noTable = evaluateHooks({
    contributingText: "# Contributing\n\nno table here",
    lefthookText: LEFTHOOK,
  });
  assert.ok(noTable.failures.some((failure) => failure.includes("no hooks table")));
  const noHooks = evaluateHooks({ contributingText: HOOKS_DOC, lefthookText: "# nothing" });
  assert.ok(noHooks.failures.some((failure) => failure.includes("yielded no hook blocks")));
});

test("the real CONTRIBUTING, ci.yml and lefthook.yml agree", () => {
  const rootUrl = new URL("..", import.meta.url);
  const read = (relative) => readFileSync(new URL(relative, rootUrl), "utf8");
  const contributingText = read(DOC_PATH);
  const workflowText = read(WORKFLOW_PATH);
  const lefthookText = read(LEFTHOOK_PATH);

  // Silent-direction guards first: the sides must have been READ, not merely
  // found absent.
  assert.ok(parseWorkflowInvocations(workflowText).length >= 10);
  assert.ok(collectCommandSpans(contributingText).length > 0);
  assert.ok(parseLefthookHooks(lefthookText).size >= 3);

  const roster = evaluateContributing({ contributingText, workflowText, exceptions: EXCEPTIONS });
  const hooksResult = evaluateHooks({ contributingText, lefthookText });
  assert.deepEqual(roster.failures, []);
  assert.deepEqual(hooksResult.failures, []);
});
