/**
 * The `waivers` command: the whole `boundarySuppressions` surface, read-only —
 * both the TEMPORARY rows (carrying `expiresAt`) and the PERMANENT ones (no
 * `expiresAt`) — with each row's remaining time (waivers only) and the
 * current violations it covers.
 *
 * ## What this command is for
 *
 * Waivers are the half-life half of `check`: `check` splits waived violations
 * out of the findings list into an "accepted violations" section, and this
 * command names every waiver still on the table and its term. A permanent
 * suppression never appears in `check`'s findings at all — removing the
 * violation outright is the mechanism working as designed
 * (`../governance/waiver.mjs`) — which makes this command the ONLY surface
 * that names one. Dropping that half used to mean a tree could carry a
 * `boundarySuppressions` row with `path: "**"`, silencing every violation in
 * it, and this command would still answer "no waivers — every boundary is
 * enforced": a positive claim about a proposition it never measured, the
 * exact silent direction `../../../../AGENTS.md`'s invariant forbids (an
 * empty result is a claim, not a shrug). It is the surface a developer reads
 * when deciding whether a row — waiver or suppression — is stale (covers
 * nothing right now, or lapsed long ago) and worth removing — the same
 * "recorded, never silently deleted" rule the waiver feature exists to hold,
 * extended to the permanent half it always needed to cover.
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
 * currently covers, plus every PERMANENT suppression (a `boundarySuppressions`
 * row with no `expiresAt`) and what it is currently hiding. Pure per-row,
 * given the raw violations.
 *
 * `rawViolations` is the tree's violations WITH the suppression table removed —
 * the command evaluates with `suppressions: []` so each row's coverage is
 * judged against every finding, not against the run the table already cleaned.
 * A waiver that covers nothing is a stale row, named as such: waivers are
 * recorded and never silently deleted, so the command surfaces a row whose
 * reason has lapsed rather than hiding it. A permanent suppression that
 * currently covers nothing is surfaced the same way — dead weight is dead
 * weight whether or not it has a term.
 *
 * @param {object[]} suppressions The validated `boundarySuppressions` table —
 *   waivers and permanent suppressions together, undivided.
 * @param {object[]} rawViolations Every violation the engine found, unfiltered.
 * @param {string} now Reference instant (ISO-8601).
 * @returns {{waivers: object[], covered: number, expired: number, stale: number,
 *   suppressions: object[], suppressed: number}}
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

  // The other half of the table: a row with no `expiresAt` is a PERMANENT
  // suppression — it never re-asserts and it never appears in `check`'s
  // findings, so this command is the only surface that names it at all. It
  // used to be filtered out by the `isWaiver` predicate above and reported
  // nowhere, which is how a `path: "**"` row could hide every violation in a
  // tree while this command still answered "no waivers — every boundary is
  // enforced" (see this module's header). Same shape as a waiver — `path`,
  // `reason`, `origin` when declared, and `covered` — minus the term fields a
  // permanent row has none of, sorted the same deterministic way.
  const permanentSuppressions = suppressions
    .filter((row) => !isWaiver(row))
    .map((row) => ({
      ...row,
      covered: rawViolations.filter((violation) => suppressionCovers(row, violation)).length,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Distinct violations hidden by AT LEAST ONE permanent suppression — a
  // `Set` over the violation objects themselves (each one is a distinct
  // object `evaluate()` built), not a sum of the per-row `covered` counts
  // above, because two overlapping rows both matching the same violation
  // would otherwise double-count it.
  const suppressedViolations = new Set();
  for (const row of permanentSuppressions) {
    for (const violation of rawViolations) {
      if (suppressionCovers(row, violation)) suppressedViolations.add(violation);
    }
  }

  return {
    waivers,
    covered,
    expired,
    stale,
    suppressions: permanentSuppressions,
    suppressed: suppressedViolations.size,
  };
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

  const { waivers, covered, expired, stale, suppressions, suppressed } = computeWaivers(
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
    // `remainingMs` reflects the wall clock at the moment of THIS run, not the
    // workspace — it is expected to differ between two runs of an unchanged
    // tree, by design (`../governance/clock.mjs`). Disclosed here, in-band,
    // so a consumer diffing or hashing two envelopes to detect real drift
    // knows to exclude it rather than read clock drift as architectural
    // change; every other field is deterministic given the same law and tree.
    notes: [
      "remainingMs is the wall clock at the moment of this run, not a fact about the " +
        "workspace — it is expected to differ between two runs of an unchanged tree and " +
        "should be excluded from any diff or hash meant to detect real change. Every other " +
        "field here is deterministic given the same law and the same tree.",
    ],
  };

  const context = { root, provider, marker, provenance: resolveProvenance(root) };
  const result = { waivers, covered, expired, stale, suppressions, suppressed };

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
