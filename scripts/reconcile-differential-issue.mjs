#!/usr/bin/env node
// The issue trail for the conformance differential — the consumer that turns a
// red run of `.github/workflows/differential.yml` into a durable, visible
// artifact instead of a log fragment nobody is forced to read. Runs in that
// workflow's `Reconcile the issue trail` step (`if: always()`), reads the
// verdict envelope `scripts/differential-real-trees.mjs --summary-out` wrote,
// and drives `gh` over the ONE issue this mechanism owns.
//
// The engine half of this file is lane-agnostic: `decideIssue`, `issueFooter`
// and `applyTrail` take the lane's identity as arguments, and the coverage
// lane's trail (`scripts/reconcile-coverage-issue.mjs`) is this same lifecycle
// pointed at the coverage envelope under its own label and title. The rule
// below is stated here, once; the coverage script contributes only its lane's
// identity and the mapping from its envelope into the engine's inputs.
//
// Lifecycle contract, every branch pinned by
// `scripts/reconcile-differential-issue.test.mjs`:
//
// - `findings` — opens the issue, or EDITS (never comments on — an edit sends
//   no notification) it if it exists in any state, so a human closing it
//   early does not silence the next red run. One issue, one label,
//   `conformance-differential`.
// - `ok` — closes an open issue with one comment naming the green run: the
//   only comment this script ever writes. Nothing exists or is already
//   closed -> nothing happens.
// - `infra` and `usage` — NEVER touch the issue, either way. A run that
//   could not look at the trees cannot prove a divergence is gone, so it
//   must not close an issue; and it carries no finding of its own to file.
//
// Why findings-only: an infra red (registry outage, a yanked tarball inside a
// third-party lockfile, the job timeout) is transient and can recur every
// Monday, so filing issues for it is how a bot trains a repository to ignore
// itself. A findings red is deterministic — same code, same pinned trees, same
// lockfile, same verdict — so a persistent issue per divergence is exactly the
// right amount of noise: it stays open until a later run measures the fix.
//
// The exit-class vocabulary is read from the envelope, never derived here —
// each lane's `buildSummary` (`scripts/differential-real-trees.mjs`,
// `scripts/coverage-real-trees.mjs`) is the one place its own mapping is
// spelled, and a workflow or this script holding a second copy of either
// would drift the way `AGENTS.md`'s "never state a rule twice" names.
//
// Environment: DIFFERENTIAL_SUMMARY (path to the envelope), DIFFERENTIAL_REPO,
// DIFFERENTIAL_RUN_URL, DIFFERENTIAL_SHA (default-branch head the scheduled
// run measured — the release lane's tag runs never reconcile, so every issue
// action this script takes is about `main`), GH_TOKEN.
//
// A missing or malformed envelope exits 1 — a red run whose issue never
// landed is a silent miss, and "could not decide" must not read as "decided
// nothing was wrong".

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The one label this mechanism owns — also the handle the workflow's
 * `gh issue list` query uses to find its own issue. */
export const LABEL = "conformance-differential";

/** The one issue title this lane's trail opens under, and the label
 * description `ensureLabel` bootstraps with. Both key to THIS lane: the
 * coverage lane's trail carries its own spellings of each, so the two lanes'
 * trails cannot collide — a query by one lane's label cannot find the other
 * lane's issue. */
export const ISSUE_TITLE =
  "differential: findings — conformance divergence from @nx/enforce-module-boundaries";
export const LABEL_DESCRIPTION =
  "The conformance differential found a divergence from @nx/enforce-module-boundaries";

/**
 * The maintenance promise every trail's issue closes with, parameterized by
 * the workflow step that maintains it. Both lanes' bodies end with this exact
 * text — the lifecycle it states is the one `decideIssue` implements, so it
 * is spelled here, once, and each lane's body builder names only its own
 * maintainer.
 *
 * @param {string} maintainer the workflow step the issue is maintained by
 * @returns {string}
 */
export function issueFooter(maintainer) {
  return [
    `This issue is maintained by ${maintainer}.`,
    "A findings-red run opens or updates it; a later green run on the default branch",
    "closes it. Closing it manually does not stop the next red run from reopening it.",
  ].join("\n");
}

/**
 * The issue body: the run that produced the finding, the ref it measured, and
 * the exact UNEXPLAINED / STALE / BREACH lines the run printed — the envelope
 * carries them verbatim from `reportTree`/`reportNativeLeg`, so the issue IS
 * the log fragment, never a re-formatted claim. Trees with no lines (the
 * clean half of a mixed run) contribute nothing.
 *
 * @param {{runUrl: string, sha: string, trees: {name: string, verdict: string, lines: string[]}[]}} summary
 * @returns {string}
 */
export function buildIssueBody({ runUrl, sha, trees }) {
  const lines = [`Run: ${runUrl}`, `Measured ref: ${sha} — default branch`, ""];
  for (const tree of trees) {
    if (tree.lines.length === 0) continue;
    lines.push(`${tree.name} — ${tree.verdict}`);
    for (const line of tree.lines) lines.push(`  ${line}`);
    lines.push("");
  }
  lines.push(issueFooter("`.github/workflows/differential.yml`'s reconcile step"));
  return lines.join("\n");
}

/**
 * The whole lifecycle decision, pure: takes the envelope's class, the lane's
 * identity (the ONE issue title, and the body already rendered from that
 * lane's envelope), the run facts, and the existing issue (or its absence),
 * and answers what `gh` must do. Which envelope the class came from, and how
 * the body was rendered, are the caller's mapping — every lane's trail lands
 * here, so the branches below are the lifecycle, stated once.
 *
 * The silent directions are the ones the tests pin first: `infra` with an
 * open issue must NOT close it, an `ok` class with an open issue MUST close
 * it (a green run that left a stale issue open would say a divergence
 * persists when it does not), and an `exitClass` no envelope can carry must
 * throw rather than quietly do nothing.
 *
 * @param {{exitClass: string, title: string, body: string, runUrl: string, sha: string, existing?: {number: number, state: "open"|"closed"}}} input
 * @returns {{action: string, number?: number, title?: string, body?: string, closeComment?: string, reason?: string}}
 * @throws {Error} on an `exitClass` that is none of the four the envelope can carry.
 */
export function decideIssue({ exitClass, title, body, runUrl, sha, existing }) {
  if (exitClass === "findings") {
    if (!existing) {
      return { action: "open", title, body };
    }
    if (existing.state === "open") return { action: "update", number: existing.number, body };
    return { action: "reopen", number: existing.number, body };
  }
  if (exitClass === "ok") {
    if (existing?.state === "open") {
      return {
        action: "close",
        number: existing.number,
        closeComment: `Green run ${runUrl} (default branch @ ${sha}) — closing automatically.`,
      };
    }
    return { action: "none", reason: "no open issue to close" };
  }
  if (exitClass === "infra" || exitClass === "usage") {
    return {
      action: "none",
      reason:
        `${exitClass} runs never touch the issue — a run that could not look cannot prove a ` +
        `divergence gone, and carries no finding of its own to file`,
    };
  }
  throw new Error(
    `unrecognised exitClass ${JSON.stringify(exitClass)} — a ` +
      `summary field no consumer knows must not silently do nothing`,
  );
}

/**
 * Runs `gh` and returns its result. The argument array rule (`AGENTS.md`)
 * applies here too: every value reaching the CLI is a separate element, never
 * a built string.
 *
 * @param {string[]} args
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function gh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", env: process.env });
  if (result.error) {
    throw new Error(`gh ${args.join(" ")}: ${result.error.message}`);
  }
  return result;
}

/** Like `gh`, but a non-zero exit throws — used where any failure is a miss. */
function requireGh(args) {
  const result = gh(args);
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result;
}

/**
 * The `gh` invocation(s) a decision requires, as argument arrays. Pure, so
 * the reopen path can be asserted on its argv rather than only read.
 *
 * `gh issue edit` has no `--state` flag (checked against `gh issue edit
 * --help`, which lists `--add-assignee`, `--body`/`-b`, `--title`/`-t`,
 * `--milestone`, and the `--add-`/`--remove-label` etc. pairs — no state
 * flag among them); reopening a closed issue is a distinct subcommand,
 * `gh issue reopen <number>`, which itself takes no `--body`. The old
 * `reopen` branch called `gh issue edit --state open --body ...`, which
 * `gh` rejects outright, so a findings run that landed after a human closed
 * the issue errored out of `main()` and never reopened it — the exact
 * silent miss the file header's "A missing or malformed envelope exits 1"
 * paragraph exists to prevent, arriving instead through the one branch that
 * wasn't exercised against `gh`'s real flag set. `reopen` therefore issues
 * two calls: `gh issue reopen` to flip the state, then `gh issue edit
 * --body` to carry the fresher findings body the same way `update` does.
 *
 * @param {{action: string, number?: number, title?: string, body?: string, closeComment?: string}} decision
 * @param {string} repo
 * @param {string} label the lane's label — the handle the open command tags
 *   the issue with, and the handle that lane's query searches by
 * @returns {string[][]} zero or more `gh` argument arrays, in call order
 * @throws {Error} on an `action` this function does not know.
 */
export function buildGhCommands(decision, repo, label = LABEL) {
  switch (decision.action) {
    case "open":
      return [
        [
          "issue",
          "create",
          "--repo",
          repo,
          "--title",
          decision.title,
          "--body",
          decision.body,
          "--label",
          label,
        ],
      ];
    case "update":
      return [["issue", "edit", "--repo", repo, String(decision.number), "--body", decision.body]];
    case "reopen":
      return [
        ["issue", "reopen", "--repo", repo, String(decision.number)],
        ["issue", "edit", "--repo", repo, String(decision.number), "--body", decision.body],
      ];
    case "close":
      return [
        [
          "issue",
          "close",
          "--repo",
          repo,
          String(decision.number),
          "--comment",
          decision.closeComment,
        ],
      ];
    case "none":
      return [];
    default:
      throw new Error(`unknown decision action ${JSON.stringify(decision.action)}`);
  }
}

/** Creates the label when it does not exist yet — `gh issue create --label`
 * refuses an unknown label, and the first run of this mechanism is its own
 * bootstrap. Returns once the label exists, whether created here or already
 * present.
 *
 * The retry-with-`--force` is load-bearing, measured on 2026-08-19: the
 * earlier `gh label list --search` probe returned a false negative in CI —
 * the workflow's `GITHUB_TOKEN` carries `contents: read` + `issues: write`
 * but no `issues: read`, and `gh label list`'s GraphQL `repository.labels`
 * connection is gated on that read permission (the two failing runs' own
 * "Set up job" logs show `Metadata: read` present, so the blocker is the
 * label read, not metadata) — so every run fell through to `create`, which
 * then failed with "already exists; use `--force`", on `ok` runs whose only
 * job was to close the `conformance-differential` issue as well. Create
 * first, and on the one `already exists` error retry with `--force`: that
 * keeps create-if-absent while never overwriting a label that was already
 * there — a caller whose token CAN list labels (local runs, a fuller scope)
 * leaves a human-edited label untouched, and a caller that cannot reaches
 * the same create-or-update the old code intended. */
function ensureLabel(repo, label, description) {
  const base = [
    "label",
    "create",
    label,
    "--repo",
    repo,
    "--color",
    "d73a4a",
    "--description",
    description,
  ];
  const created = gh(base);
  if (created.status === 0) return;
  const force = gh([...base, "--force"]);
  if (force.status !== 0) {
    throw new Error(`label ${label} could not be created or updated: ${force.stderr.trim()}`);
  }
}

/** The open-or-closed issue this lane's label owns, if one exists at all.
 * Exported because the coverage lane's trail runs the same query under its
 * own label — the one `gh` read both trails share, so it exists once. */
export function existingIssue(repo, label) {
  const list = requireGh([
    "issue",
    "list",
    "--repo",
    repo,
    "--label",
    label,
    "--state",
    "all",
    "--json",
    "number,state",
    "--limit",
    "1",
  ]);
  const found = JSON.parse(list.stdout);
  if (found.length === 0) return undefined;
  // `gh issue list --json state` answers in UPPERCASE ("OPEN"/"CLOSED"), while
  // `decideIssue` compares against lowercase. Normalized here, at the boundary
  // that reads from the CLI, so the decision function keeps its pure contract.
  return { number: found[0].number, state: found[0].state.toLowerCase() };
}

/**
 * The act half, shared by both lanes' trails: make sure the lane's label
 * exists (the first run of a trail is its own bootstrap), run the decision's
 * `gh` commands, and log one line naming what happened. Impure by design —
 * it is the half the tests deliberately leave untested, the same discipline
 * the differential lane's `main()` has always applied to `gh`.
 *
 * @param {{decision: object, repo: string, label: string, labelDescription: string}} input
 */
export function applyTrail({ decision, repo, label, labelDescription }) {
  ensureLabel(repo, label, labelDescription);
  const commands = buildGhCommands(decision, repo, label);
  if (commands.length === 0) {
    console.log(`no issue action: ${decision.reason}`);
    return;
  }
  for (const args of commands) requireGh(args);
  const summaries = {
    open: `opened the ${label} issue for findings`,
    update: `updated issue #${decision.number}`,
    reopen: `reopened issue #${decision.number}`,
    close: `closed issue #${decision.number}`,
  };
  console.log(summaries[decision.action]);
}

function main() {
  const summaryPath = process.env.DIFFERENTIAL_SUMMARY;
  const repo = process.env.DIFFERENTIAL_REPO;
  const runUrl = process.env.DIFFERENTIAL_RUN_URL;
  const sha = process.env.DIFFERENTIAL_SHA;
  for (const [name, value] of [
    ["DIFFERENTIAL_SUMMARY", summaryPath],
    ["DIFFERENTIAL_REPO", repo],
    ["DIFFERENTIAL_RUN_URL", runUrl],
    ["DIFFERENTIAL_SHA", sha],
    ["GH_TOKEN", process.env.GH_TOKEN],
  ]) {
    if (!value) {
      console.error(`reconcile-differential-issue: ${name} is not set — cannot decide`);
      process.exit(1);
    }
  }
  if (!existsSync(summaryPath)) {
    console.error(
      `reconcile-differential-issue: ${summaryPath} does not exist — the differential ran ` +
        `or failed without writing its envelope, so the issue trail cannot decide. A red run ` +
        `whose issue never landed is a silent miss.`,
    );
    process.exit(1);
  }
  let envelope;
  try {
    envelope = JSON.parse(readFileSync(summaryPath, "utf8"));
  } catch (error) {
    console.error(
      `reconcile-differential-issue: the summary is not readable JSON: ${error.message}`,
    );
    process.exit(1);
  }

  let decision;
  try {
    decision = decideIssue({
      exitClass: envelope.exitClass,
      title: ISSUE_TITLE,
      body: buildIssueBody({ runUrl, sha, trees: envelope.trees ?? [] }),
      runUrl,
      sha,
      existing: existingIssue(repo, LABEL),
    });
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(1);
  }

  try {
    applyTrail({ decision, repo, label: LABEL, labelDescription: LABEL_DESCRIPTION });
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(1);
  }
}

/**
 * Run-vs-import guard, compared on real paths for the reason
 * `scripts/check-packages.mjs` documents on its own copy: through a symlinked
 * checkout the naive comparison is false and `main()` silently never runs.
 */
function isProgramEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}

if (isProgramEntry(import.meta.url)) main();
