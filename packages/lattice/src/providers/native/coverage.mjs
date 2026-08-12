/**
 * Coverage judgment for a native workspace: which tracked, analyzable files
 * no discovered project owns.
 *
 * Nx has no equivalent question — every file Nx's own graph omits is simply
 * outside any project as far as `nx graph` is concerned, and this package's
 * Nx path (`../nx.mjs`, `../../workspace.mjs`) has no unclaimed-file check of
 * its own: both compute imports and violations only for files a project
 * already claims. A native workspace gets no `nx graph` to lean on, so `lattice.json` states
 * the projects itself — and a file that fits none of them is exactly the
 * silent hole `../../../../../AGENTS.md`'s invariant is about: it is analyzed by
 * nothing, judged by nothing, and an empty violation list would read
 * identically to a file that really was clean.
 *
 * An unclaimed file becomes a whole-file `fileFailure`
 * (`../../analysis/source-util.mjs`) — the SAME record shape a language
 * analyzer produces for a file it could not read, so `../../../cli.mjs` and
 * `../../report/text.mjs`'s `formatFailures` need no native-specific branch
 * to report it: `formatFailures` already splits whole-file holes from
 * site-level ones (`isWholeFileFailure`, `failure.line === null`).
 */
import { languageOf } from "../../analysis/analyze.mjs";
import { fileFailure } from "../../analysis/source-util.mjs";
import { matchesGlob } from "./model.mjs";

/**
 * Judges coverage over a discovered native workspace.
 *
 * `files` and `claimed` ride alongside `unclaimed`/`exempted`/`stale` rather
 * than replacing any of them — additive, so an existing caller destructuring
 * this object keeps working unchanged. They exist for the same reason
 * `../../../CLAUDE.md`'s "What is a stub" section gives `cli.mjs check` its
 * own inspected-file count: "no violations" is a claim about coverage too,
 * and a caller that wants to state what it inspected (not just what it
 * found) needs the denominator, not only the failing files.
 *
 * @param {{files: string[], projectOf: (file: string) => string|undefined, exempt: {path: string, reason: string}[]}} args
 * @returns {{
 *   files: number,
 *   claimed: number,
 *   unclaimed: string[],
 *   exempted: string[],
 *   stale: {path: string, reason: string}[],
 *   failures: {sourceFile: string, line: null, column: null, reason: string}[],
 * }}
 */
export function judgeCoverage({ files, projectOf, exempt }) {
  const analyzable = files.filter((file) => languageOf(file) !== null);
  const unowned = analyzable.filter((file) => projectOf(file) === undefined);

  const matchesFor = exempt.map((row) => ({
    row,
    files: unowned.filter((file) => matchesGlob(file, row.path)),
  }));
  const exemptedFiles = new Set(matchesFor.flatMap((m) => m.files));
  const unclaimed = unowned.filter((file) => !exemptedFiles.has(file));
  const stale = matchesFor.filter((m) => m.files.length === 0).map((m) => m.row);

  return {
    files: analyzable.length,
    claimed: analyzable.length - unowned.length,
    unclaimed,
    exempted: [...exemptedFiles],
    stale,
    failures: unclaimed.map((file) =>
      fileFailure(
        file,
        "is not owned by any project declared or inferred from lattice.json — every " +
          "analyzable tracked file must belong to exactly one project, or be named in " +
          "lattice.json's coverage.exempt with a reason",
      ),
    ),
  };
}
