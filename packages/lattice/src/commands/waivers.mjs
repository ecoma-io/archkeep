/**
 * The `waivers` command: the boundary-suppression surface that accept
 * violations TEMPORARILY — every `boundarySuppressions` row carrying an
 * `expiresAt` — read-only, with each one's remaining time and the current
 * violations it covers.
 *
 * ## What this command is for
 *
 * Waivers are the half-life half of `check`: `check` splits waived violations
 * out of the findings list into an "accepted violations" section, and this
 * command names every waiver still on the table and its term. It is the
 * surface a developer reads when deciding whether a waiver is stale (covers
 * nothing right now, or lapsed long ago) and worth removing — the same
 * "recorded, never silently deleted" rule the waiver feature exists to hold.
 *
 * ## Read-only, like every command that is not `check`
 *
 * This is a descriptive command — it exits 0 when it completes, never 1 — and
 * it never modifies the table. It states what the workspace DECLARES and what
 * that declaration currently covers, so a reader can judge whether a row has
 * earned its keep or is dead weight.
 *
 * ## Determinism
 *
 * The remaining-time column is computed against the injected clock
 * (`../governance/clock.mjs`), so a test drives the same command with a fixed
 * `now` and the output is reproducible byte-for-byte. Defaults to the wall
 * clock, the same injection `evaluate` uses for waiver expiry.
 */
import { isWholeFileFailure } from "../analysis/source-util.mjs";
import { suppressionCovers } from "../config.mjs";
import { referenceTime } from "../governance/clock.mjs";
import { isWaiver, remainingMs, waiverStatus } from "../governance/waiver.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { formatWaiversReport } from "../report/waivers-text.mjs";
import { resolveProvenance } from "./provenance.mjs";
import { evaluate } from "../rules/index.mjs";

/**
 * The waivers verdict for a run: every waiver with its term and what it
 * currently covers. Pure per-waiver, given the raw violations.
 *
 * `rawViolations` is the tree's violations WITH the suppression table removed —
 * the command evaluates with `suppressions: []` so each waiver's coverage is
 * judged against every finding, not against the run the table already cleaned.
 * A waiver that covers nothing is a stale row, named as such: waivers are
 * recorded and never silently deleted, so the command surfaces a row whose
 * reason has lapsed rather than hiding it.
 *
 * @param {object[]} suppressions The validated `boundarySuppressions` table.
 * @param {object[]} rawViolations Every violation the engine found, unfiltered.
 * @param {string} now Reference instant (ISO-8601).
 * @returns {{waivers: object[], covered: number, expired: number, stale: number}}
 */
export function computeWaivers(suppressions, rawViolations, now = referenceTime()) {
  const waivers = suppressions
    .filter(isWaiver)
    .map((row) => ({
      ...row,
      status: waiverStatus(row, now),
      remainingMs: remainingMs(row, now),
      covered: rawViolations.filter((violation) => suppressionCovers(row, violation)).length,
    }))
    // Plain string comparison — never `localeCompare`, which depends on the
    // locale and the Node build's ICU data and would let two machines order the
    // same rows differently (the determinism rule every snapshot-state command
    // shares; `graph`'s `buildProjects` documents the same refusal).
    .sort(
      (a, b) =>
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
        (a.expiresAt < b.expiresAt ? -1 : a.expiresAt > b.expiresAt ? 1 : 0),
    );

  const covered = waivers.reduce((sum, w) => sum + (w.covered > 0 ? 1 : 0), 0);
  const expired = waivers.filter((w) => w.status === "expired").length;
  const stale = waivers.filter((w) => w.covered === 0).length;
  return { waivers, covered, expired, stale };
}

/**
 * Runs the `waivers` command: loads the boundary law, evaluates the tree with
 * the table removed, and reports the waiver surface.
 *
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {object} boundaryConfig The run's boundary law, loaded and validated
 *   by the same three-way call `check` makes — `cli.mjs`'s `runWaivers`
 *   resolves `--config` against the working directory exactly as `runCheck`
 *   does, so the surface listed is the surface the law actually enforces.
 * @param {{now?: string}} [io] The injected clock.
 * @returns {Promise<{status: "ok", waivers: object, report: {text: string, json: string}}>}
 * @throws {Error} whenever the run's law is malformed, or the tree has
 *   whole-file analysis failures — exit-3 class, the same posture `check` takes
 *   on a malformed config and `impact`/`drift` take on incomplete coverage.
 */
export async function waiversCommand(commandContext, boundaryConfig, io = {}) {
  const { root, provider, marker, analysis, graph } = commandContext;
  const now = io.now ?? referenceTime();
  const config = boundaryConfig;

  // A waiver surface over a tree it could not fully read is a lottery ticket,
  // not a surface: a file the analyzer never judged contributes no raw
  // violation, so every waiver that names it reads as stale and the report
  // says "covers nothing" about a finding the run never looked at. Refuse
  // loudly on whole-file failures, the same posture `impact`, `drift`, and
  // `history` take — "could not look" must never read as "looked and found
  // nothing" (`./impact.mjs`'s refusal names the same silence).
  const notAnalyzed = analysis.failures
    .filter(isWholeFileFailure)
    .map(({ sourceFile, reason }) => ({ file: sourceFile, reason }));

  if (notAnalyzed.length > 0) {
    throw new Error(
      `lattice: waivers has incomplete coverage — ${notAnalyzed.length} file` +
        `${notAnalyzed.length === 1 ? "" : "s"} could not be analyzed, so every waiver naming one ` +
        `would read as covering nothing it never saw. Fix the unanalyzed files and re-run.`,
    );
  }

  // Evaluate with the suppression table REMOVED, so every row's coverage is
  // measured against the full finding set rather than the post-waiver run.
  // `now` is threaded so the expiry judgement is the same one `check` makes.
  const rawViolations = evaluate(analysis.imports, graph, { ...config, suppressions: [], now });

  const { waivers, covered, expired, stale } = computeWaivers(
    config.suppressions ?? [],
    rawViolations,
    now,
  );

  const coverage = {
    complete: true,
    projects: Object.keys(graph.nodes).length,
    analyzedFiles: analysis.analyzed,
    imports: analysis.imports.length,
    notAnalyzed,
    blindSpots: analysis.failures
      .filter((failure) => !isWholeFileFailure(failure))
      .map(({ sourceFile, line, column, reason }) => ({ file: sourceFile, line, column, reason })),
    notes: [],
  };

  const context = { root, provider, marker, provenance: resolveProvenance(root) };
  const result = { waivers, covered, expired, stale };

  const envelope = jsonEnvelope({
    command: "waivers",
    context,
    status: "ok",
    exitCode: 0,
    coverage,
    result,
  });

  return {
    status: "ok",
    waivers: result,
    report: {
      text: formatWaiversReport(result),
      json: renderJson(envelope),
    },
  };
}
