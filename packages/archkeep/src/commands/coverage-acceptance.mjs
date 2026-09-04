/**
 * The policy's `coverage.unowned` acceptance channel, matched in ONE place
 * against the two unowned-file sets a run establishes — so `check` and
 * `waivers` cannot disagree about which files a row accepts.
 *
 * The channel exists for the Nx and Moon providers, whose project model has
 * no home of its own for "this file is owned by no project, and we accept
 * that, for this reason" — the decision `archkeep.json`'s `coverage.exempt`
 * records on a native tree (`../providers/native/coverage.mjs`). Without it,
 * the two unowned states those providers report are both permanent: the
 * TS/JS/Vue gap (`./context.mjs`'s `unownedAnalyzableFiles`) warns on every
 * run with no way to answer it, and a Go/Rust/Python unclaimed file
 * (`unclaimedFileFailures` there) is a hard exit 3 with no accepted middle
 * ground.
 *
 * A covered file is a RECORDED acceptance, never an invisible one: `check`
 * still states every accepted file, as the `"accepted-unowned-files"`
 * coverage-gap entry (`./check.mjs`), and `archkeep waivers` names each row
 * with its reason and current coverage. What changes is only the permanent
 * half — the warning stops re-asking a question someone answered, and the
 * unclaimed exit 3 stops firing for a file whose acceptance is on record.
 *
 * ## Matching starts AFTER unowned-ness is decided
 *
 * The inputs here are lists something else already judged: `unownedGap` is
 * the tolerated TS/JS/Vue list with the run's own configuration files
 * subtracted (`./context.mjs`'s `unownedGapWithoutRunConfiguration`, applied
 * by the caller), and `unclaimedFiles` is the Go/Rust/Python unclaimed list
 * the same module computes. A row is matched against those lists ONLY —
 * never against the tracked tree — so even a `**` row can never accept, or
 * silence anything about, a file a project owns. That is the same guarantee
 * the native provider's `coverage.exempt` states, kept by the same
 * construction (`../providers/native/coverage.mjs`'s `judgeCoverage` filters
 * `unowned` first and matches second).
 *
 * A row matching NOTHING across both sets is dead — the files it accepted
 * are owned now, or the path was never right — and dead is a verdict the
 * caller must refuse loudly, not a state to skip: `./check.mjs`'s dead-row
 * block does, in the same sentence shape as the native stale-row refusal
 * (`../providers/native/index.mjs`).
 */
import { languageOf } from "../analysis/registry.mjs";
import { safeMatchesGlob } from "../rules/match.mjs";

/**
 * The languages a file list spans — sorted and distinct, derived beside the
 * list it describes so no face can name a language the list does not contain
 * (the same rule `./context.mjs`'s `unownedAnalyzableFiles` states).
 *
 * @param {string[]} files
 * @returns {string[]}
 */
function languagesOf(files) {
  return [...new Set(files.map((file) => languageOf(file)))].sort();
}

/**
 * Partitions a run's unowned files into accepted and uncovered under the
 * policy's `coverage.unowned` rows.
 *
 * Everything is derived from the arguments — no filesystem, no policy load —
 * so a test drives it directly and the two callers (`./check.mjs`,
 * `./waivers.mjs`) provably run the identical judgment.
 *
 * @param {{
 *   rows: {path: string, reason: string}[],
 *   unownedGap: {files: string[], languages: string[]},
 *   unclaimedFiles: string[],
 *   tracked: string[],
 * }} args `rows` is `config.coverage?.unowned ?? []` — the validated table
 *   (`../config.mjs`'s `findCoverageViolations`). `tracked` fixes the order
 *   accepted files are reported in: `git ls-files` order, the same order
 *   every other file list in a report keeps.
 * @returns {{
 *   rows: {path: string, reason: string, index: number, files: string[]}[],
 *   dead: {path: string, reason: string, index: number}[],
 *   accepted: {files: string[], languages: string[]},
 *   acceptedFiles: Set<string>,
 *   uncoveredUnowned: {files: string[], languages: string[]},
 * }} `rows` is every declared row with the unowned files it currently
 *   accepts; `dead` the subset accepting none. `accepted` is the union of
 *   both sets' covered files in tracked order; `uncoveredUnowned` is
 *   `unownedGap` minus the accepted files — the warning that survives.
 *   Uncovered UNCLAIMED files need no list of their own: their whole-file
 *   failures are already in the caller's hands, untouched.
 */
export function partitionUnownedCoverage({ rows, unownedGap, unclaimedFiles, tracked }) {
  const candidates = [...unownedGap.files, ...unclaimedFiles];
  const matched = rows.map((row, index) => ({
    path: row.path,
    reason: row.reason,
    index,
    files: candidates.filter((file) => safeMatchesGlob(file, row.path)),
  }));
  const acceptedFiles = new Set(matched.flatMap((entry) => entry.files));
  const acceptedInTrackedOrder = tracked.filter((file) => acceptedFiles.has(file));
  const uncoveredFiles = unownedGap.files.filter((file) => !acceptedFiles.has(file));
  return {
    rows: matched,
    dead: matched
      .filter((entry) => entry.files.length === 0)
      .map(({ path, reason, index }) => ({ path, reason, index })),
    accepted: {
      files: acceptedInTrackedOrder,
      languages: languagesOf(acceptedInTrackedOrder),
    },
    acceptedFiles,
    uncoveredUnowned: {
      files: uncoveredFiles,
      languages: languagesOf(uncoveredFiles),
    },
  };
}

/**
 * Withdraws each accepted unclaimed file's failure from the run's failure
 * list — the acceptance channel's effect on it, kept beside the matching so
 * the channel's contract (accept the file ⇒ withdraw its refusal) is one
 * module's. `./check.mjs` holds the list and narrows `acceptedFiles` to the
 * unclaimed half; `./waivers.mjs` has no failure list and only reports rows.
 *
 * An accepted unclaimed file carries exactly one failure — its unowned-file
 * refusal, the only row any producer appends for a file no analyzer ever
 * read. The withdrawal does not TRUST that assumption, it ENFORCES it: an
 * accepted file carrying more than one failure means some producer appended a
 * second row for it, and a splice by `sourceFile` would take the second one
 * down with the first — the failure count falls, `coverage.notAnalyzed` loses
 * a row, and a could-not-look run tips toward a clean one, the silent
 * direction (`../../../../AGENTS.md`). The run refuses instead, naming the
 * file and the count it found.
 *
 * @param {{sourceFile: string}[]} failures The run's failure list, in order.
 * @param {Set<string>} acceptedFiles The accepted subset of the unclaimed
 *   list — `partitionUnownedCoverage`'s `acceptedFiles` narrowed to that list
 *   by the caller.
 * @returns {{sourceFile: string}[]} A new array without the accepted files'
 *   single failures; the input is not mutated.
 * @throws {Error} when an accepted file carries more than one failure.
 */
export function withdrawAcceptedUnclaimedFailures(failures, acceptedFiles) {
  const carried = new Map();
  for (const failure of failures) {
    if (!acceptedFiles.has(failure.sourceFile)) continue;
    carried.set(failure.sourceFile, (carried.get(failure.sourceFile) ?? 0) + 1);
  }
  const overloaded = [...carried.entries()].filter(([, count]) => count > 1);
  if (overloaded.length > 0) {
    const named = overloaded
      .map(([file, count]) => `'${file}' (carries ${count} failures)`)
      .join(", ");
    throw new Error(
      `archkeep: the coverage.unowned acceptance channel cannot withdraw ${named} — ` +
        `acceptance withdraws exactly one failure per file (the unowned-file refusal), and ` +
        `withdrawing by file would drop the second one with it, understating what this run ` +
        `could not read`,
    );
  }
  return failures.filter((failure) => !acceptedFiles.has(failure.sourceFile));
}
