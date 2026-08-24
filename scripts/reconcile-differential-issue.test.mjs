// Unit tests for the PURE half of the issue trail — `decideIssue` and
// `buildIssueBody`. The `gh` driving in `main()` is deliberately untested,
// the same discipline `differential-real-trees.mjs` applies to `measureTree`:
// a test that stubbed `gh` would pin the stub, not the tool.
//
// The cases to read first are the SILENT-direction ones: an `infra` run with
// an open issue must NOT close it (a run that could not look cannot prove a
// divergence gone), and an `exitClass` nobody declared must throw rather than
// quietly do nothing — the two shapes in which this harness itself could
// close an issue that should stay open, or miss one that should be filed.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildGhCommands,
  buildIssueBody,
  decideIssue,
  LABEL,
} from "./reconcile-differential-issue.mjs";

const summary = {
  runUrl: "https://github.com/ecoma-io/archkeep/actions/runs/42",
  sha: "abcdef0123456789",
  trees: [
    {
      name: "code-pushup",
      verdict: "findings",
      lines: [
        "UNEXPLAINED stricter noRelativeOrAbsoluteImportsAcrossLibraries @ packages/cli/src/index.ts:3:1",
        "EMPTY-VERDICT BREACH: code-pushup: tool reported ZERO verdicts on a tree measured to contain violations",
      ],
    },
    { name: "ng-doc", verdict: "ok", lines: [] },
  ],
};

test("findings with no existing issue opens one; the body carries run, ref and the exact log lines", () => {
  const decision = decideIssue({ exitClass: "findings", summary, existing: undefined });
  assert.equal(decision.action, "open");
  assert.match(decision.title, /differential: findings/u);
  assert.ok(decision.body.includes("Run: https://github.com/ecoma-io/archkeep/actions/runs/42"));
  assert.ok(decision.body.includes("Measured ref: abcdef0123456789"));
  // The body IS the log fragment — verbatim, not re-formatted.
  assert.ok(
    decision.body.includes(
      "UNEXPLAINED stricter noRelativeOrAbsoluteImportsAcrossLibraries @ packages/cli/src/index.ts:3:1",
    ),
  );
  assert.ok(decision.body.includes("EMPTY-VERDICT BREACH:"));
  // The clean half of a mixed run contributes nothing.
  assert.equal(decision.body.includes("ng-doc"), false);
});

test("findings with an open issue updates it in place — an edit, never a comment", () => {
  const decision = decideIssue({
    exitClass: "findings",
    summary,
    existing: { number: 7, state: "open" },
  });
  assert.equal(decision.action, "update");
  assert.equal(decision.number, 7);
  assert.equal("closeComment" in decision, false);
  assert.ok(decision.body.includes("EMPTY-VERDICT BREACH:"));
});

test("findings with a closed issue reopens it — a human closing early does not silence the next red", () => {
  const decision = decideIssue({
    exitClass: "findings",
    summary,
    existing: { number: 7, state: "closed" },
  });
  assert.equal(decision.action, "reopen");
  assert.equal(decision.number, 7);
  assert.ok(decision.body.includes("UNEXPLAINED"));
});

test("a green run closes an open issue with one comment naming the green run", () => {
  const decision = decideIssue({
    exitClass: "ok",
    summary,
    existing: { number: 7, state: "open" },
  });
  assert.equal(decision.action, "close");
  assert.equal(decision.number, 7);
  assert.ok(
    decision.closeComment.includes(
      "Green run https://github.com/ecoma-io/archkeep/actions/runs/42 (default branch @ abcdef0123456789)",
    ),
  );
});

test("a green run with no issue — or an already-closed one — does nothing", () => {
  assert.equal(decideIssue({ exitClass: "ok", summary, existing: undefined }).action, "none");
  assert.equal(
    decideIssue({ exitClass: "ok", summary, existing: { number: 7, state: "closed" } }).action,
    "none",
  );
});

test("infra NEVER touches the issue, either way — the silent-direction case", () => {
  // A run that could not look at the trees must not close an open issue: its
  // green would be absence of measurement, not absence of divergence.
  const withOpen = decideIssue({
    exitClass: "infra",
    summary,
    existing: { number: 7, state: "open" },
  });
  assert.equal(withOpen.action, "none");
  assert.match(withOpen.reason, /could not look/u);
  const withNone = decideIssue({ exitClass: "infra", summary, existing: undefined });
  assert.equal(withNone.action, "none");
  const withClosed = decideIssue({
    exitClass: "infra",
    summary,
    existing: { number: 7, state: "closed" },
  });
  assert.equal(withClosed.action, "none");
  assert.equal(
    decideIssue({ exitClass: "usage", summary, existing: { number: 7, state: "open" } }).action,
    "none",
  );
});

test("an exitClass this script does not know throws rather than silently doing nothing", () => {
  assert.throws(
    () => decideIssue({ exitClass: "banana", summary, existing: undefined }),
    /unrecognised exitClass/u,
  );
});

test("buildIssueBody renders the footer contract and only the trees with lines", () => {
  const body = buildIssueBody({
    runUrl: "https://github.com/ecoma-io/archkeep/actions/runs/42",
    sha: "abcdef0123456789",
    trees: [
      { name: "a", verdict: "findings", lines: ["UNEXPLAINED stricter x @ a:1:1"] },
      { name: "b", verdict: "ok", lines: [] },
    ],
  });
  assert.ok(body.includes("a — findings"));
  assert.ok(body.includes("  UNEXPLAINED stricter x @ a:1:1"));
  assert.ok(body.includes("maintained by `.github/workflows/differential.yml`"));
  assert.equal(body.includes("b — ok"), false);
});

test("the label constant is the single handle both the query and the create use", () => {
  assert.equal(LABEL, "conformance-differential");
});

// `gh issue edit` has no `--state` flag — the old reopen branch built
// `["issue", "edit", ..., "--state", "open", ...]`, which `gh` rejects, so a
// findings run that landed after a human closed the issue errored out of
// `main()` and never reopened it. This is the silent-direction case: assert
// the actual subcommand used, not just that SOME argv comes back.
test("reopen issues `gh issue reopen`, never `gh issue edit --state` — the flag gh does not have", () => {
  const decision = decideIssue({
    exitClass: "findings",
    summary,
    existing: { number: 7, state: "closed" },
  });
  const commands = buildGhCommands(decision, "ecoma-io/archkeep");
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0], ["issue", "reopen", "--repo", "ecoma-io/archkeep", "7"]);
  // No command may carry a `--state` flag anywhere — that is the exact typo
  // that made reopening error out against a real `gh`.
  for (const args of commands) assert.equal(args.includes("--state"), false);
  // The fresher findings body still lands, via a second, separate `edit` call.
  assert.deepEqual(commands[1], [
    "issue",
    "edit",
    "--repo",
    "ecoma-io/archkeep",
    "7",
    "--body",
    decision.body,
  ]);
});

test("open, update and close each build exactly one gh command, unchanged from before the reopen fix", () => {
  const openDecision = decideIssue({ exitClass: "findings", summary, existing: undefined });
  const openCommands = buildGhCommands(openDecision, "ecoma-io/archkeep");
  assert.equal(openCommands.length, 1);
  assert.deepEqual(openCommands[0], [
    "issue",
    "create",
    "--repo",
    "ecoma-io/archkeep",
    "--title",
    openDecision.title,
    "--body",
    openDecision.body,
    "--label",
    LABEL,
  ]);

  const updateDecision = decideIssue({
    exitClass: "findings",
    summary,
    existing: { number: 7, state: "open" },
  });
  const updateCommands = buildGhCommands(updateDecision, "ecoma-io/archkeep");
  assert.deepEqual(updateCommands, [
    ["issue", "edit", "--repo", "ecoma-io/archkeep", "7", "--body", updateDecision.body],
  ]);

  const closeDecision = decideIssue({
    exitClass: "ok",
    summary,
    existing: { number: 7, state: "open" },
  });
  const closeCommands = buildGhCommands(closeDecision, "ecoma-io/archkeep");
  assert.deepEqual(closeCommands, [
    ["issue", "close", "--repo", "ecoma-io/archkeep", "7", "--comment", closeDecision.closeComment],
  ]);
});

test("a none decision requires no gh command at all", () => {
  const decision = decideIssue({ exitClass: "ok", summary, existing: undefined });
  assert.deepEqual(buildGhCommands(decision, "ecoma-io/archkeep"), []);
});

test("an action buildGhCommands does not know throws rather than silently doing nothing", () => {
  assert.throws(
    () => buildGhCommands({ action: "banana" }, "ecoma-io/archkeep"),
    /unknown decision action/u,
  );
});
