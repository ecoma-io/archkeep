/**
 * The ONE incomplete-coverage refusal contract, and the one completeness
 * every command's verdict is a claim about (#608).
 *
 * #602 gave the graph family (`check`, `graph`, `discover`, `explain`,
 * `context`) a structured refusal: `status: "no-verdict"`, exit 3, a
 * `coverage` block naming what the run could not read — in the envelope,
 * where a parser and `--output` can read it. Every command here that refuses
 * the same condition refused it by throwing: a stderr sentence, an empty
 * stdout, no envelope, nothing under `--output`. Same refusal class, two
 * machine contracts — while `docs/reference/exit-codes.md` already documents
 * the structured one for every descriptive command. The functions here are
 * the shared construction the throw family now goes through, so the two
 * families cannot drift again:
 *
 * - `coverageVerdict` computes the one completeness over three axes — no
 *   whole-file failure, no unjudged blind spot, at least one file analyzed —
 *   and the status/exit pair that completeness implies. The first two axes
 *   ride the envelope law (`../report/json.mjs`), and there only in ONE
 *   direction: the envelope refuses `complete: true` over a non-empty
 *   `notAnalyzed` list or an unjudged blind-spot row, and deliberately
 *   allows `complete: false` with both lists empty, so a run that judged
 *   nothing is able to say so. The third axis — `analyzed > 0` — is the one
 *   this constructor adds on top (#599, #612, #619): the envelope has no
 *   zero-analysis refusal by design, which is WHY this constructor exists.
 *   The failure classes are read through
 *   `../analysis/source-util.mjs`'s classifiers, never an inline filter: the
 *   class line is theirs alone to own.
 * - `coverageRefusal` builds the refusal result itself: the envelope through
 *   `jsonEnvelope` (so the envelope invariants hold by construction, and a
 *   refusal cannot accidentally claim `complete: true`), and a text face
 *   whose coverage lines come from `coverageIncompleteReasons` — the same
 *   clauses `check`'s text report renders — so a terminal reader is told the
 *   same thing the envelope tells a parser.
 *
 * What still throws: the plugin-gap refusal (a graph that under-represents
 * the workspace is a different refusal, kept loud in every command that has
 * one — `drift.mjs`'s `refuseIncompleteGraph` and `delta.mjs`'s
 * `refusePluginGapHead` are the two shared guards), input refusals (a
 * malformed baseline file, a missing intent), and the capture modes
 * (`delta --capture`, `history --capture`) whose product is a snapshot file
 * with no envelope contract to refuse through.
 *
 * @module
 */

import {
  blindSpotRows,
  isWholeFileFailure,
  unresolvableLiteralCount,
} from "../analysis/source-util.mjs";
import { EXIT, coverageComplete, coverageIncompleteReasons } from "../verdict.mjs";
import { buildDecision } from "../report/evidence.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { formatCoverageIncomplete } from "../report/text.mjs";
import { resolveProvenance } from "./provenance.mjs";

/**
 * @typedef {object} CoverageVerdict
 * @property {{file: string, reason: string}[]} notAnalyzed One row per
 *   whole-file failure — the files the run never read.
 * @property {object[]} blindSpots Every positioned failure, all permanent
 *   classes — the run's disclosure of every site it saw and did not judge.
 * @property {number} blindSpotCount The count of sites that WITHHOLD the
 *   verdict (unresolvable literals referencing the workspace; dynamic and
 *   external sites disclosed but exit-neutral).
 * @property {boolean} complete Whether the run judged everything in scope.
 * @property {"ok"|"no-verdict"} status The verdict the completeness implies.
 * @property {0|3} exitCode The exit code the status implies.
 */

/**
 * The one completeness verdict over a command context's analysis.
 *
 * The three completeness axes are exactly the envelope law's: a whole-file
 * failure is a file no verdict was reached on; an unresolvable literal site
 * is a question the resolver was asked and could not answer; a zero-analyzed
 * run judged nothing (#599). Dynamic and external sites are declared limits —
 * disclosed in `blindSpots`, never withholding — because
 * `unresolvableLiteralCount` draws that class line once, and this function
 * reads the count rather than re-deriving it.
 *
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {{acceptedFiles?: Set<string>}} [io] `acceptedFiles` names whole-
 *   file failures a `coverage.unowned` row already accepts (`waivers` and
 *   `check` withdraw those first): the state is a recorded acceptance the
 *   report itself names, not a hole the run failed to look at. Absent ⇒ no
 *   withdrawal, which is every command but `waivers`.
 * @returns {CoverageVerdict}
 */
export function coverageVerdict(commandContext, { acceptedFiles } = {}) {
  const { analysis } = commandContext;
  const notAnalyzed = analysis.failures
    .filter(isWholeFileFailure)
    .filter(({ sourceFile }) => !(acceptedFiles?.has(sourceFile) ?? false))
    .map(({ sourceFile, reason }) => ({ file: sourceFile, reason }));
  const blindSpots = blindSpotRows(analysis.failures);
  const blindSpotCount = unresolvableLiteralCount(analysis.failures);
  // The conjunction is `../verdict.mjs`'s `coverageComplete` — the same
  // predicate `verdictFor`'s decision face reads, so `check`'s envelope
  // cannot carry a `coverage.complete` and a `decision.coverageComplete`
  // that disagree about one run. The predicate is defined there, not here,
  // because `verdictFor` needs it and this module already imports from that
  // one: the reverse import would be a cycle.
  const complete = coverageComplete({
    unchecked: notAnalyzed.length,
    blindSpotCount,
    analyzed: analysis.analyzed,
  });
  return {
    notAnalyzed,
    blindSpots,
    blindSpotCount,
    complete,
    status: complete ? "ok" : "no-verdict",
    exitCode: complete ? EXIT.ok : EXIT.error,
  };
}

/**
 * The structured refusal itself: what a command returns over an analysis it
 * could not fully read, instead of throwing.
 *
 * The envelope carries no `result`: the verdict was withheld, so there is no
 * verdict payload to ride beside the refusal — the `coverage` block IS the
 * payload, and `jsonEnvelope`'s law would refuse any `ok`-shaped claim this
 * object might otherwise smuggle through. `decision` is accepted for the two
 * commands whose envelopes already carry one (`delta`, `change`); an
 * "unknown" decision must name its reason (I3), so callers pass `true` and
 * the reason is joined from the same clause list the text face renders.
 *
 * @param {{command: string, commandContext: object, what: string,
 *   acceptedFiles?: Set<string>, decision?: boolean}} input
 *   `command` is the envelope's command name, `what` names the question the
 *   command was asking (the text face's one free clause), `acceptedFiles`
 *   forwards to `coverageVerdict` (see above), and `decision: true` attaches
 *   the canonical `unknown` decision.
 * @returns {{status: "no-verdict", coverage: object,
 *   report: {text: string, json: string}}}
 */
export function coverageRefusal({ command, commandContext, what, acceptedFiles, decision }) {
  const verdict = coverageVerdict(commandContext, { acceptedFiles });
  // A refusal over a complete coverage would be a `no-verdict` claim about a
  // run that looked at everything — the silent direction in the other dress.
  // Every caller gates on `coverageVerdict(...).complete` first; this is the
  // one place that refuses to build the lie if a caller stops gating.
  if (verdict.complete) {
    throw new Error(
      `coverageRefusal: ${command}'s coverage is complete — there is nothing to refuse`,
    );
  }
  /** @type {"no-verdict"} The completeness is false, so this is the status. */
  const status = "no-verdict";
  const reasons = coverageIncompleteReasons({
    unchecked: verdict.notAnalyzed.length,
    blindSpots: verdict.blindSpotCount,
    analyzed: commandContext.analysis.analyzed,
  });
  const coverage = {
    complete: false,
    projects: Object.keys(commandContext.graph.nodes).length,
    analyzedFiles: commandContext.analysis.analyzed,
    imports: commandContext.analysis.imports.length,
    notAnalyzed: verdict.notAnalyzed,
    blindSpots: verdict.blindSpots,
    notes: [],
  };
  const envelope = jsonEnvelope({
    command,
    context: {
      root: commandContext.root,
      provider: commandContext.provider,
      marker: commandContext.marker,
      provenance: resolveProvenance(commandContext.root),
    },
    status,
    exitCode: verdict.exitCode,
    coverage,
    result: undefined,
    ...(decision === true
      ? {
          decision: buildDecision({
            status,
            coverageComplete: false,
            findings: 0,
            reason: reasons.join("; "),
          }),
        }
      : {}),
  });
  return {
    status,
    coverage,
    report: {
      text:
        `${command}: no verdict — ${what} needs a workspace this run could fully read\n` +
        formatCoverageIncomplete(reasons),
      json: renderJson(envelope),
    },
  };
}
