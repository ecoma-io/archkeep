#!/usr/bin/env node
// The 1.0 conditions, read off something rather than remembered.
//
// `docs/doctrine/roadmap.md` states four conditions that separate 0.x from
// 1.0, and says each is "read off something that already runs rather than off
// anyone's judgement of readiness". Nothing read them. They were prose, and
// prose about readiness drifts in exactly one direction — a condition that was
// met stays listed as pending (the `schemaVersion` promise sat on that list
// for six releases after it landed) and a condition that regressed stays
// listed as met.
//
// This script is the reader. It prints one row per condition and never guesses:
//
//   met         the evidence says so, and the row names the evidence
//   not met     the evidence says so, and the row names what is missing
//   unmeasured  this script cannot see the evidence from here, and the row
//               names what would
//
// **`unmeasured` is not a failure and not a pass.** It is the third state this
// repository insists on everywhere else (`../AGENTS.md`: an empty result is a
// claim, not a shrug), and two of the four conditions are structurally in it:
// a run history lives in GitHub Actions, and an external repository's CI is
// somebody else's tree. Collapsing either into "met" would be the silent
// direction; collapsing it into "not met" would make the report cry wolf and
// stop being read.
//
// ## Why this is a report and not a gate
//
// A gate that fails until 1.0 fails every build for months and is deleted or
// ignored long before it is satisfied. What makes a report honest instead is
// that it is run and read: `pnpm readiness`, and the roadmap points at it.
// The one thing it exits non-zero for is its own failure to look — a reader
// that could not read its inputs must not print a table of `unmeasured` that
// looks like an answer.
//
// ## The facts come in as arguments
//
// `evaluate` takes records and returns rows; only the readers below touch git,
// the network or the clock. That split is why `check-readiness.test.mjs` needs
// no filesystem and no mocking library — the same consequence `../AGENTS.md`
// states for the other gate scripts.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  readGateAttestation,
  verifiedAdopters,
} from "../packages/archkeep/src/verify-gate-attestation.mjs";

/** The conditions, in the roadmap's own order and wording. */
export const CONDITIONS = Object.freeze([
  "the real-tree differential green, run after run",
  "a workspace outside this repository running check as a blocking gate",
  "a quiet stretch in what an unchanged workspace is told",
  "releases that land without a hand on them",
]);

/**
 * How many commits back the quiet stretch must reach before this script calls
 * condition 3 met.
 *
 * It is a number this repository chose rather than one anything derives, so it
 * is stated here where a reader can argue with it, and the row prints the
 * count either way — a maintainer reading "38 of 50" learns more than one
 * reading "not met".
 */
export const QUIET_STRETCH_COMMITS = 50;

/**
 * How many consecutive releases must agree before condition 4 is met.
 *
 * Two is the roadmap's own words — "more than once in a row" — and the reason
 * it is not more: the failure this condition exists to have stopped happening
 * (the 0.5.0 tag npm never received) is a single-release failure, so a run of
 * two already distinguishes a lane that works from a lane that worked once.
 */
export const RELEASES_IN_A_ROW = 2;

/**
 * A commit subject that marks a change to what an unchanged workspace is told.
 *
 * Conventional Commits spell a breaking change as a `!` before the colon or a
 * `BREAKING CHANGE:` footer, and `../AGENTS.md` makes a change to what is
 * reported on an unchanged workspace a breaking change "even when no API
 * moved". So every verdict-changing fix is in this set — along with breaking
 * changes that moved only an API and changed no verdict.
 *
 * The proxy therefore OVER-counts, and that direction is deliberate: it can
 * only report the stretch as shorter than it really is, never longer. A
 * readiness claim that errs must err toward "not yet".
 *
 * It can also under-count, in one way a marker scan cannot see: a commit that
 * changes what an unchanged workspace is told without carrying a marker. #573
 * reshaped the JSON envelope behind a subject with no `!` and no footer. So
 * the stretch reads a second, independent signal: `CONTRACT_SURFACE` below.
 * A commit touching one of those paths unmarked breaks the stretch too, and
 * the row names it — a commit that changes the output contract and says so
 * is the marker system working, not a hidden one.
 */
const BREAKING_SUBJECT = /^[a-z]+(\([^)]*\))?!:/u;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/mu;

/**
 * The observable-contract surface: paths whose change is a change to what an
 * unchanged workspace is told, whatever the commit message claims.
 *
 * The list over-approximates on purpose. A comment fix inside `src/report/`
 * flags a commit that changed no verdict, and the cost of that is a human
 * glancing at a named subject; the cost of a path missing from this list is
 * the silent direction this scan exists to close. When a change adds a face
 * to what the tool tells a workspace, this is the list that has to hear
 * about it.
 */
export const CONTRACT_SURFACE = Object.freeze([
  "packages/archkeep/src/report/",
  "packages/archkeep/src/verdict.mjs",
  "packages/archkeep/src/exit-matrix.integration.test.mjs",
  "packages/archkeep/src/intent/intent-manifest.json",
  "docs/reference/exit-codes.md",
  "docs/reference/json-output.md",
]);

/**
 * Whether a commit carries a breaking marker, in either Conventional Commits
 * spelling.
 *
 * @param {{subject: string, body: string}} commit
 * @returns {boolean}
 */
function isBreakingCommit(commit) {
  return BREAKING_SUBJECT.test(commit.subject) || BREAKING_FOOTER.test(commit.body);
}

/**
 * Whether a changed file sits on the contract surface. A directory entry
 * (trailing `/`) matches everything under it; a file entry matches only
 * itself — so `src/report/` covers the envelope and the text faces, and
 * `exit-codes.md` does not swallow a sibling appendix.
 *
 * @param {string} file
 * @param {readonly string[]} surface
 * @returns {boolean}
 */
function touchesContractSurface(file, surface) {
  return surface.some(
    (path) => file === path || file.startsWith(path.endsWith("/") ? path : `${path}/`),
  );
}

/**
 * The commits the marker scan cannot see: unmarked ones whose changed files
 * sit on the contract surface. These are the #573 shape — a reshaped envelope
 * behind a subject that carries no marker — and they break the quiet stretch
 * even though no marker will ever flag them.
 *
 * @param {{subject: string, body: string, files?: string[]}[]} commits Newest
 *   first. Commits read without their file lists (`files` absent) can never
 *   match, which is the safe direction for a caller that supplies fewer facts.
 * @param {readonly string[]} surface
 * @returns {{subject: string, body: string, files?: string[]}[]} The flagged
 *   commits, in the order given.
 */
export function findUnmarkedContractCommits(commits, surface = CONTRACT_SURFACE) {
  return commits.filter(
    (commit) =>
      !isBreakingCommit(commit) &&
      (commit.files ?? []).some((file) => touchesContractSurface(file, surface)),
  );
}

/**
 * @typedef {object} ReadinessFacts
 * @property {{subject: string, body: string, files?: string[]}[]} commits Newest
 *   first, from the tip toward the root, each with the files it changed.
 * @property {string[]} taggedVersions Every released version this repository
 *   tagged, newest last.
 * @property {string[] | null} publishedVersions Every version the registry
 *   holds, or `null` when the registry could not be reached.
 * @property {{red: boolean, runs: number} | null} differential The real-tree
 *   differential's recent history, or `null` when it was not supplied.
 * @property {string[] | null} externalAdopters `owner/name@version` entries
 *   derived from validated gate attestations, or `null` when none was
 *   supplied — never an unvalidated name.
 */

/**
 * @typedef {object} ReadinessRow
 * @property {string} condition
 * @property {"met"|"not met"|"unmeasured"} state
 * @property {string} evidence What was read, or what would have to be.
 */

/**
 * The four conditions, judged from facts.
 *
 * @param {ReadinessFacts} facts
 * @returns {ReadinessRow[]}
 */
export function evaluate(facts) {
  return [
    differentialRow(facts.differential),
    adoptionRow(facts.externalAdopters),
    quietStretchRow(facts.commits),
    releaseRow(facts.taggedVersions, facts.publishedVersions),
  ];
}

/**
 * Condition 1. A run history is a GitHub Actions fact; this script reads it
 * only when a caller hands one over.
 *
 * @param {{red: boolean, runs: number} | null} differential
 * @returns {ReadinessRow}
 */
function differentialRow(differential) {
  if (differential === null) {
    return {
      condition: CONDITIONS[0],
      state: "unmeasured",
      evidence:
        "the weekly Differential workflow's run history — pass --differential '<runs>,<red|green>' " +
        "after reading it, or open the conformance-differential issue trail the lane keeps",
    };
  }
  if (differential.red) {
    return {
      condition: CONDITIONS[0],
      state: "not met",
      evidence: `the last run was red over ${differential.runs} run(s)`,
    };
  }
  return {
    condition: CONDITIONS[0],
    state: differential.runs >= RELEASES_IN_A_ROW ? "met" : "not met",
    evidence: `${differential.runs} green run(s) in a row, and a run of them is what the condition asks for`,
  };
}

/**
 * Condition 2. Somebody else's CI, which nothing in this tree can see.
 *
 * The evidence arrives as validated gate attestations
 * (`packages/archkeep/src/verify-gate-attestation.mjs` owns the schema and the
 * refusals) — never a
 * bare name, because "a repository is known to us" is not the condition; the
 * condition is that its build fails on an archkeep verdict and is right to.
 *
 * @param {string[] | null} adopters `owner/name@version` entries from
 *   `verifiedAdopters`, or `null` when no attestation was supplied.
 * @returns {ReadinessRow}
 */
function adoptionRow(adopters) {
  if (adopters === null) {
    return {
      condition: CONDITIONS[1],
      state: "unmeasured",
      evidence:
        "an external repository's own CI — pass --attestations '<file.json>,...' once one has " +
        "published one (docs/reference/gate-attestation.md)",
    };
  }
  return {
    condition: CONDITIONS[1],
    state: adopters.length > 0 ? "met" : "not met",
    evidence: adopters.length > 0 ? adopters.join(", ") : "no attested repository",
  };
}

/**
 * Condition 3, the one fact that is entirely local: how many commits have
 * landed since the last one that could have changed a verdict.
 *
 * @param {{subject: string, body: string, files?: string[]}[]} commits Newest first.
 * @returns {ReadinessRow}
 */
function quietStretchRow(commits) {
  if (!Array.isArray(commits) || commits.length === 0) {
    return {
      condition: CONDITIONS[2],
      state: "unmeasured",
      evidence: "no commits were read — git log answered nothing",
    };
  }
  const breaking = commits.findIndex(isBreakingCommit);
  const unmarked = findUnmarkedContractCommits(commits);
  // Both signals break the stretch at their own position, and the stretch is
  // what remains after whichever lands first from the tip. `-1` means a scan
  // saw nothing; the `commits.length` form means a stretch at least as long
  // as the window — reported as the window rather than as infinity, because
  // that is what was actually read.
  const breakingAt = breaking === -1 ? commits.length : breaking;
  const unmarkedAt = unmarked.length === 0 ? commits.length : commits.indexOf(unmarked[0]);
  const stretch = Math.min(breakingAt, unmarkedAt);
  const stretchCommit = stretch === commits.length ? null : commits[stretch];
  return {
    condition: CONDITIONS[2],
    state: stretch >= QUIET_STRETCH_COMMITS ? "met" : "not met",
    evidence:
      `${stretch} of ${QUIET_STRETCH_COMMITS} commits since the last commit that could have ` +
      `changed what an unchanged workspace is told` +
      (stretchCommit === null
        ? ` (none in the ${commits.length} read)`
        : ` (${stretchCommit.subject})`) +
      (unmarked.length === 0
        ? ""
        : `; ${unmarked.length} unmarked commit(s) touch the output-contract surface: ` +
          unmarked.map((commit) => `"${commit.subject}"`).join("; ")),
  };
}

/**
 * Condition 4. Every tag the repository cut, against every version the
 * registry holds, newest first — a run of agreeing releases, broken by the
 * first tag the registry never received.
 *
 * The `.vsix` half of the condition is not read here and the row says so: a
 * release's attached assets are a GitHub API fact, and a row that quietly
 * judged two thirds of a condition would be the silent direction.
 *
 * @param {string[]} tagged Newest last.
 * @param {string[] | null} published
 * @returns {ReadinessRow}
 */
function releaseRow(tagged, published) {
  if (published === null) {
    return {
      condition: CONDITIONS[3],
      state: "unmeasured",
      evidence: "the registry could not be read — pass --registry-json <file> with its document",
    };
  }
  const holds = new Set(published);
  const newestFirst = [...tagged].reverse();
  let run = 0;
  let broken = null;
  for (const version of newestFirst) {
    if (holds.has(version)) run += 1;
    else {
      broken = version;
      break;
    }
  }
  return {
    condition: CONDITIONS[3],
    state: run >= RELEASES_IN_A_ROW ? "met" : "not met",
    evidence:
      `${run} tag(s) in a row reached the registry` +
      (broken === null ? "" : `, then ${broken} did not`) +
      " — the attached .vsix is not read here and is not part of this verdict",
  };
}

/**
 * `git log` as records. The one reader that touches the repository, and it is
 * deliberately untested for the reason `readMoonProjects` is
 * (`../AGENTS.md`): a test that stubbed the answer would pin the stub.
 *
 * @param {number} limit How many commits to read, newest first.
 * @returns {{subject: string, body: string, files?: string[]}[]}
 */
function readCommits(limit) {
  // A record separator no commit message can contain, so a body with blank
  // lines in it cannot be read as two commits. `--name-only` puts each
  // commit's changed files after the format record, so the files that decide
  // the contract-surface scan ride along in the same read.
  const result = spawnSync(
    "git",
    ["log", `-${limit}`, "--no-merges", "--format=%x1e%s%x1f%b%x1f", "--name-only"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return [];
  return result.stdout
    .split("\u001e")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const [subject, body = "", files = ""] = entry.split("\u001f");
      return {
        subject: subject.trim(),
        body,
        files: files
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== ""),
      };
    });
}

/**
 * Every `v`-prefixed tag, as bare versions in the order git sorts them.
 *
 * @returns {string[]}
 */
function readTaggedVersions() {
  const result = spawnSync("git", ["tag", "--list", "v*", "--sort=v:refname"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^v\d+\.\d+\.\d+$/u.test(line))
    .map((line) => line.slice(1));
}

/**
 * The versions a registry document holds.
 *
 * Handed a document rather than a URL: fetching is the caller's business, and
 * a script that reached the network on its own would make its own tests need
 * one.
 *
 * @param {string} path A file holding the registry's JSON.
 * @returns {string[]}
 */
export function versionsFromRegistry(path) {
  const document = JSON.parse(readFileSync(path, "utf8"));
  const versions = document?.versions;
  if (versions === null || typeof versions !== "object") {
    throw new Error(
      `archkeep: ${path} holds no "versions" object — that is a registry document's own shape, ` +
        `and reading a different one as if it were would report a release history nobody has.`,
    );
  }
  return Object.keys(versions);
}

/**
 * `--flag value` pairs, with nothing positional.
 *
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`archkeep: unexpected argument '${token}' — every input is a --flag <value>`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`archkeep: '${token}' needs a value`);
    }
    parsed[token.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

/**
 * `--differential '<runs>,<red|green>'` as the record `evaluate` reads.
 *
 * @param {string | undefined} value
 * @returns {{red: boolean, runs: number} | null}
 */
export function parseDifferential(value) {
  if (value === undefined) return null;
  const [runs, colour] = value.split(",").map((part) => part.trim());
  if (!/^\d+$/u.test(runs ?? "") || (colour !== "red" && colour !== "green")) {
    throw new Error(
      `archkeep: --differential expects '<runs>,<red|green>', got '${value}' — a shape this ` +
        `script cannot read must not be rounded into a verdict about readiness.`,
    );
  }
  return { runs: Number(runs), red: colour === "red" };
}

/** The report, one row per condition. */
function main() {
  const args = parseArgs(process.argv.slice(2));
  const publishedVersions = args["registry-json"]
    ? versionsFromRegistry(args["registry-json"])
    : null;
  const rows = evaluate({
    commits: readCommits(QUIET_STRETCH_COMMITS),
    taggedVersions: readTaggedVersions(),
    publishedVersions,
    differential: parseDifferential(args.differential),
    externalAdopters: args.attestations
      ? verifiedAdopters(
          args.attestations
            .split(",")
            .map((path) => path.trim())
            .filter((path) => path !== "")
            .map((path) => readGateAttestation(path)),
          publishedVersions,
        )
      : null,
  });

  console.log("1.0 readiness — docs/doctrine/roadmap.md's four conditions\n");
  for (const row of rows) {
    console.log(`${row.state.padEnd(10)} ${row.condition}`);
    console.log(`           ${row.evidence}\n`);
  }
  const unmeasured = rows.filter((row) => row.state === "unmeasured").length;
  console.log(
    `${rows.filter((row) => row.state === "met").length} met, ` +
      `${rows.filter((row) => row.state === "not met").length} not met, ` +
      `${unmeasured} unmeasured. An unmeasured condition is neither — it names what would read it.`,
  );
}

// Run only when invoked as a program, so importing this module for its pure
// half does not print a report as a side effect.
if (process.argv[1] && process.argv[1].endsWith("check-readiness.mjs")) main();
