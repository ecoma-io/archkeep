#!/usr/bin/env node
// The issue trail for the analyzer-coverage lane — the consumer that turns a
// red run of `.github/workflows/differential.yml`'s `coverage` job into a
// durable, visible artifact instead of a log fragment nobody is forced to
// read. It reads the verdict envelope
// `scripts/coverage-real-trees.mjs --summary-out` wrote and drives `gh` over
// the ONE issue this lane's trail owns.
//
// There is no second lifecycle here. The decide/act engine lives in
// `scripts/reconcile-differential-issue.mjs` (`decideIssue`, `issueFooter`,
// `applyTrail`) and is imported, not copied: findings open or update the
// issue, a later green run closes it, infra and usage never touch it — the
// branch list in `decideIssue` is the whole contract, and this file holds
// none of it. What this file contributes is the lane's identity and the
// mapping from the coverage envelope into the engine's inputs:
//
// - a separate label, `conformance-coverage`, and a separate title prefix —
//   identity the differential lane's trail never queries, so the two trails
//   cannot collide (a query by one lane's label cannot find the other's
//   issue);
// - a body built from the coverage envelope's exact breach lines, verbatim
//   from `evaluate`, the same "the issue IS the log fragment" shape the
//   differential body keeps.
//
// Environment: COVERAGE_SUMMARY (path to the envelope), COVERAGE_REPO,
// COVERAGE_RUN_URL, COVERAGE_SHA (the default-branch head the scheduled run
// measured — the same roles the differential trail's DIFFERENTIAL_* variables
// play), GH_TOKEN.
//
// A missing or malformed envelope exits 1, on the differential trail's
// ground: "could not decide" must not read as "decided nothing was wrong".

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  applyTrail,
  decideIssue,
  existingIssue,
  issueFooter,
} from "./reconcile-differential-issue.mjs";

/** The one label this lane's trail owns — the handle the `gh issue list`
 * query searches by, and the one the differential lane's trail never
 * touches. */
export const LABEL = "conformance-coverage";

/** This lane's issue title and label description, keyed to the lane the way
 * the differential trail's spellings are keyed to it. */
export const ISSUE_TITLE = "coverage: findings — a pinned analyzer-coverage count moved";
export const LABEL_DESCRIPTION =
  "The analyzer-coverage lane found a pinned count moved on a real tree";

/**
 * The issue body: the run that produced the finding, the ref it measured, and
 * the exact breach lines the envelope carried verbatim from `evaluate` — the
 * issue IS the log fragment, never a re-formatted claim.
 *
 * @param {{runUrl: string, sha: string, breaches: string[]}} summary
 * @returns {string}
 */
export function buildIssueBody({ runUrl, sha, breaches }) {
  const lines = [`Run: ${runUrl}`, `Measured ref: ${sha} — default branch`, ""];
  for (const breach of breaches) lines.push(breach);
  lines.push("");
  lines.push(issueFooter("`.github/workflows/differential.yml`'s coverage reconcile step"));
  return lines.join("\n");
}

function main() {
  const summaryPath = process.env.COVERAGE_SUMMARY;
  const repo = process.env.COVERAGE_REPO;
  const runUrl = process.env.COVERAGE_RUN_URL;
  const sha = process.env.COVERAGE_SHA;
  for (const [name, value] of [
    ["COVERAGE_SUMMARY", summaryPath],
    ["COVERAGE_REPO", repo],
    ["COVERAGE_RUN_URL", runUrl],
    ["COVERAGE_SHA", sha],
    ["GH_TOKEN", process.env.GH_TOKEN],
  ]) {
    if (!value) {
      console.error(`reconcile-coverage-issue: ${name} is not set — cannot decide`);
      process.exit(1);
    }
  }
  if (!existsSync(summaryPath)) {
    console.error(
      `reconcile-coverage-issue: ${summaryPath} does not exist — the coverage lane ran ` +
        `or failed without writing its envelope, so the issue trail cannot decide. A red run ` +
        `whose issue never landed is a silent miss.`,
    );
    process.exit(1);
  }
  let envelope;
  try {
    envelope = JSON.parse(readFileSync(summaryPath, "utf8"));
  } catch (error) {
    console.error(`reconcile-coverage-issue: the summary is not readable JSON: ${error.message}`);
    process.exit(1);
  }

  let decision;
  try {
    decision = decideIssue({
      exitClass: envelope.exitClass,
      title: ISSUE_TITLE,
      body: buildIssueBody({ runUrl, sha, breaches: envelope.breaches ?? [] }),
      runUrl,
      sha,
      existing: existingIssue(repo),
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
 * Every gate script carries its own copy by decision — see
 * `scripts/gate-entry-smokes.test.mjs`'s header.
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
