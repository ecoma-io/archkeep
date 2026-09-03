/**
 * The `reconcile` command: the declared intended model compared against the
 * observed architecture — the two-sided mirror of `drift`.
 *
 * Drift asks one question: which intended rows does reality violate? Reconcile
 * asks the other: element by element, what does the model say about reality,
 * and what would it take to make the two agree? It is READ-ONLY by design.
 * `--propose` emits a RANKED CANDIDATE LIST of model edits — add-only,
 * removal, tag-change, boundary-change — each marked as a proposal with the
 * evidence that supports it and an explicit `proposed: true` /
 * `notAuthoritative` marker. The feature never writes back into
 * `architecture-intent.json`: writing back is a manual, reviewable step the
 * operator performs, and authority stays with the intentional human or agent.
 *
 * ## Two faces, one verdict
 *
 * Like `drift`, `reconcile` is descriptive: it completes with status `"ok"` /
 * exit 0 whether the model matches reality or diverges from it, and it never
 * exits 1: divergence is described, never gated. The divergence lives in the result's scored
 * elements and, with `--propose`, in the ranked candidate list — both of which
 * a reader acts on deliberately rather than a CI gate failing over.
 *
 * ## Fail-closed — the empty-result invariant's reconcile face
 *
 * This command refuses loudly on every path that cannot reach a verdict,
 * the same four refusals `drift` makes:
 *
 * - the intent file cannot be read or parsed (strict JSON, validated) → exit 3;
 * - the observed side is incomplete (whole-file analysis failures) → exit 3 —
 *   every `absent` score would be ambiguous between "gone" and "never seen";
 * - an Nx workspace has polyglot manifests but the plugin is not registered →
 *   exit 3, the same refusal `graph`/`diff`/`drift` make;
 * - a boundary or row side matched no observed project → exit 3, because a
 *   score over an unresolved row would claim a verdict the judge never reached.
 *
 * An `unknown` score is only ever produced by a whole-file failure the command
 * already refused on — but `reconcileScores` marks it regardless, so the
 * scoring module can never render a partial read as a claim on its own.
 *
 * ## Determinism
 *
 * Every scored element and every candidate is keyed and sorted by plain string
 * comparison (never `localeCompare`), so two runs over an unchanged tree and
 * intent produce byte-identical text and JSON.
 */
import { blindSpotRows } from "../analysis/source-util.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { resolveProvenance } from "./provenance.mjs";
import { coverageRefusal, coverageVerdict } from "./coverage-verdict.mjs";
import { judgeIntent } from "../architecture-intent/judge.mjs";
import { computeIntentFingerprint } from "../architecture-intent/intent-fingerprint.mjs";
import { INTENT_FILE, loadIntent } from "../architecture-intent/model.mjs";
import { buildObserved, refuseIncompleteGraph } from "./drift.mjs";
import { reconcileScores } from "../governance/reconcile-score.mjs";
import { buildRankedCandidates } from "../governance/reconcile-candidates.mjs";
import { formatReconcileReport } from "../report/reconcile-text.mjs";

/**
 * The number of intent rows the scored set is a claim about — the same count
 * `drift` reports, so "no divergence" always reads as a claim about a specific
 * contract.
 *
 * @param {object} intent The normalized intent model.
 * @returns {number}
 */
function intentRows(intent) {
  return (
    (intent.boundaries?.length ?? 0) +
    (intent.allowed?.length ?? 0) +
    (intent.forbidden?.length ?? 0) +
    (intent.projects?.required?.length ?? 0) +
    (intent.projects?.forbidden?.length ?? 0) +
    (intent.dependencies?.allowed?.length ?? 0) +
    (intent.dependencies?.forbidden?.length ?? 0) +
    (intent.forbiddenTags?.length ?? 0)
  );
}

/**
 * Runs the `reconcile` command: loads the intent, refuses incomplete coverage,
 * scores every observed element and every intent row, and optionally emits a
 * ranked candidate list of model edits — never writing back.
 *
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {{loadIntentOverride?: (root: string) => Promise<object>}} [io]
 *   Injectable intent loader for tests.
 * @param {{propose?: boolean}} [options] `--propose` adds the ranked candidate list.
 * @returns {Promise<{status: "ok"|"no-verdict", reconcile?: object, coverage: object,
 *   report: {text: string, json: string}}>}
 *   `status: "no-verdict"` carries no `reconcile` payload — the verdict was
 *   withheld, and the envelope's `coverage` block is the whole answer (#608).
 * @throws {Error} on every condition the header lists except the coverage one,
 *   which returns instead of throwing.
 */
export async function reconcileCommand(commandContext, io = {}, options = {}) {
  const { root, provider, marker, analysis } = commandContext;

  refuseIncompleteGraph(commandContext);

  // A reconcile verdict cannot be established over a tree it could not fully
  // read — the same fail-closed condition `drift` enforces, refused through
  // the same structured envelope `./coverage-verdict.mjs` builds (#608): the
  // verdict is withheld in-band, where a parser and `--output` can read it.
  const completeness = coverageVerdict(commandContext);
  if (!completeness.complete) {
    return coverageRefusal({ command: "reconcile", commandContext, what: "reconciling" });
  }

  const intent = await (io.loadIntentOverride ?? loadIntent)(root, {
    tracked: commandContext.tracked,
  });
  if (intent === undefined) {
    throw new Error(
      `archkeep: reconcile requires a tracked ${INTENT_FILE} at the workspace root, but none ` +
        `is present — a workspace without an intended architecture cannot be reconciled`,
    );
  }
  const observed = buildObserved(commandContext);
  const verdict = judgeIntent(intent, {
    nodes: commandContext.graph.nodes,
    dependencies: commandContext.graph.dependencies,
  });

  // An intent whose boundary or row side matched no observed project reached no
  // verdict on that row — a score over it would claim a comparison the judge
  // never made. Refuse loudly, exactly as `drift` does.
  if (verdict.unresolved.length > 0) {
    throw new Error(
      `archkeep: cannot compare the observed architecture to ${INTENT_FILE} — ` +
        verdict.unresolved
          .map(({ boundary, issue }) => `boundary/row ${boundary}: ${issue}`)
          .join("; ") +
        `. An intent that cannot be verified is not a clean one; fix the intent or the graph and re-run.`,
    );
  }

  const scores = reconcileScores(intent, verdict, observed, analysis);

  const coverage = {
    complete: true,
    projects: observed.projects.length,
    analyzedFiles: analysis.analyzed,
    imports: analysis.imports.length,
    notAnalyzed: [],
    // Reconcile reads only the graph — provider failures are the same blind
    // spots every other command reports, and a blind spot never prevents a
    // verdict.
    blindSpots: blindSpotRows(analysis.failures),
    // Coverage notes (e.g. an `optional: true` allowed row the team has not
    // built yet) ride here so "optional and absent" never reads as "never
    // checked".
    notes: verdict.notes,
  };

  const context = { root, provider, marker, provenance: resolveProvenance(root) };
  const result = {
    intent: {
      file: INTENT_FILE,
      fingerprint: computeIntentFingerprint(intent),
      rows: intentRows(intent),
    },
    observed: {
      projects: observed.projects.length,
      edges: observed.edges.length,
      implicitEdges: observed.implicitEdges,
    },
    scores: {
      projects: scores.projects,
      edges: scores.edges,
      tags: scores.tags,
      boundaries: scores.boundaries,
      intentRows: scores.intentRows,
    },
    unknownFiles: scores.unknownFiles,
  };

  if (options.propose) {
    result.candidates = buildRankedCandidates(scores);
    result.proposed = true;
    result.notAuthoritative = true;
  }

  // Reconcile is descriptive — always status "ok" when it completes, never
  // "findings". Divergence is described and (with --propose) proposed, not
  // judged: a descriptive command never claims a violation's exit code.
  const status = "ok";
  const exitCode = 0;

  const envelope = jsonEnvelope({
    command: "reconcile",
    context,
    status,
    exitCode,
    coverage,
    result,
  });

  return {
    status,
    reconcile: result,
    coverage,
    report: {
      text: formatReconcileReport({
        scores,
        candidates: options.propose ? result.candidates : null,
        intent: { fingerprint: result.intent.fingerprint, rows: result.intent.rows },
        observed: {
          projects: result.observed.projects,
          edges: result.observed.edges,
          implicitEdges: result.observed.implicitEdges,
        },
      }),
      json: renderJson(envelope),
    },
  };
}
