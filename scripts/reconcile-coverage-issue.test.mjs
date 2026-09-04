// Unit tests for the coverage lane's issue trail — the lane identity and the
// envelope mapping this script contributes, and the lifecycle decision it
// drives. The `gh` driving in `main()` is deliberately untested, the same
// discipline `reconcile-differential-issue.test.mjs` applies to its own lane:
// a test that stubbed `gh` would pin the stub, not the tool.
//
// The cases to read first are the SILENT-direction ones, the reason this lane
// needed its own trail at all (#691: four red runs, zero durable artifact):
// an `ok` envelope with an open issue must CLOSE it — a stale open issue
// claims a divergence persists when a green run proved it gone — and an
// `infra` envelope must NEVER touch the issue, either way, because a run that
// could not clone a tree cannot prove a pinned count moved or unmoved.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LABEL as DIFFERENTIAL_LABEL,
  buildGhCommands,
  decideIssue,
} from "./reconcile-differential-issue.mjs";
import { buildIssueBody, ISSUE_TITLE, LABEL } from "./reconcile-coverage-issue.mjs";

const runUrl = "https://github.com/ecoma-io/archkeep/actions/runs/33881319513";
const sha = "48c02c2f0a1b2c3d4e5f60718293a4b5c6d7e8f9";
const breaches = [
  "docker-cli: records is 12745, pinned at 12746 — the analyzer reads less of this tree than it did, which is the silent direction",
  "gin: sources is 98, pinned at 99 — the analyzer's output moved and nobody measured it",
];

// The caller's mapping from a coverage envelope into the engine's inputs,
// exactly what `main()` below the guard performs.
const decide = ({ exitClass, existing }) =>
  decideIssue({
    exitClass,
    title: ISSUE_TITLE,
    body: buildIssueBody({ runUrl, sha, breaches }),
    runUrl,
    sha,
    existing,
  });

test("findings with no existing issue opens one under this lane's label — never the differential's", () => {
  const decision = decide({ exitClass: "findings", existing: undefined });
  assert.equal(decision.action, "open");
  assert.match(decision.title, /^coverage: findings/u);
  const commands = buildGhCommands(decision, "ecoma-io/archkeep", LABEL);
  assert.deepEqual(commands[0].slice(-2), ["--label", LABEL]);
  for (const args of commands) assert.equal(args.includes(DIFFERENTIAL_LABEL), false);
});

test("the label is this lane's own — a query by one lane's handle cannot find the other's issue", () => {
  assert.equal(LABEL, "conformance-coverage");
  assert.notEqual(LABEL, DIFFERENTIAL_LABEL);
});

test("findings with an open issue updates it in place — an edit, never a comment", () => {
  const decision = decide({ exitClass: "findings", existing: { number: 9, state: "open" } });
  assert.equal(decision.action, "update");
  assert.equal(decision.number, 9);
  assert.equal("closeComment" in decision, false);
});

test("findings with a closed issue reopens it — a human closing early does not silence the next red", () => {
  const decision = decide({ exitClass: "findings", existing: { number: 9, state: "closed" } });
  assert.equal(decision.action, "reopen");
  assert.equal(decision.number, 9);
  const commands = buildGhCommands(decision, "ecoma-io/archkeep", LABEL);
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0], ["issue", "reopen", "--repo", "ecoma-io/archkeep", "9"]);
  for (const args of commands) assert.equal(args.includes("--state"), false);
});

test("an ok envelope CLOSES an open issue — a stale open issue is its own silent direction", () => {
  const decision = decide({ exitClass: "ok", existing: { number: 9, state: "open" } });
  assert.equal(decision.action, "close");
  assert.equal(decision.number, 9);
  assert.match(
    decision.closeComment,
    /Green run https:\/\/github\.com\/ecoma-io\/archkeep\/actions\/runs\/33881319513/u,
  );
  assert.match(decision.closeComment, /default branch @ 48c02c2f/u);
});

test("an ok envelope with no issue — or an already-closed one — does nothing (close-or-noop)", () => {
  assert.equal(decide({ exitClass: "ok", existing: undefined }).action, "none");
  assert.equal(
    decide({ exitClass: "ok", existing: { number: 9, state: "closed" } }).action,
    "none",
  );
});

test("infra NEVER touches the issue, either way — a run that could not look decides nothing", () => {
  const withOpen = decide({ exitClass: "infra", existing: { number: 9, state: "open" } });
  assert.equal(withOpen.action, "none");
  assert.match(withOpen.reason, /could not look/u);
  assert.equal(decide({ exitClass: "infra", existing: undefined }).action, "none");
  assert.equal(
    decide({ exitClass: "infra", existing: { number: 9, state: "closed" } }).action,
    "none",
  );
});

test("usage never touches the issue, and an unknown class throws rather than doing nothing", () => {
  assert.equal(
    decide({ exitClass: "usage", existing: { number: 9, state: "open" } }).action,
    "none",
  );
  assert.throws(
    () => decide({ exitClass: "banana", existing: undefined }),
    /unrecognised exitClass/u,
  );
});

test("the body carries the breach lines verbatim — the issue IS the log fragment", () => {
  const body = buildIssueBody({ runUrl, sha, breaches });
  assert.ok(body.includes(`Run: ${runUrl}`));
  assert.ok(body.includes(`Measured ref: ${sha} — default branch`));
  for (const breach of breaches) assert.ok(body.includes(breach), `missing: ${breach}`);
  // The footer names THIS lane's maintainer, not the differential trail's.
  assert.ok(
    body.includes("maintained by `.github/workflows/differential.yml`'s coverage reconcile step"),
  );
  assert.equal(body.includes("differential: findings"), false);
});
