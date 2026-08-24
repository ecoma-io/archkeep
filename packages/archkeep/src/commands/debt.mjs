/**
 * The `debt` command: the architecture-debt ledger — the exemptions, gaps and
 * violations a workspace is carrying, each aged across the snapshot history.
 *
 * Descriptive, read-only: `debt` never changes a verdict and never exits 1.
 * It computes today's candid facts the same way `check`/`drift` do — the
 * boundary config's `boundarySuppressions`, and `judgeIntent`'s findings,
 * notes and unresolved — and ages them across the history directory `graph
 * --format json` snapshots live in (`../commands/history.mjs`'s
 * `readSnapshots`).
 *
 * It is a report, not a gate: its exit code is 0 on a completed ledger (even a
 * long one) and 3 when the run cannot complete — no snapshots, a malformed or
 * inconsistent snapshot directory, incomplete graph coverage, or intent that
 * cannot be verified.
 *
 * ## The snapshot directory
 *
 * The ledger ages across the same directory the `history` command reads — a
 * consumer-managed directory of graph envelopes, the sole source of truth
 * with no index file (that is `history`'s choice, inherited here). When the
 * directory holds fewer than two snapshots, `agings: false` states that every
 * entry is really age-0 because the record cannot establish age — never a
 * guessed age. A missing directory is a no-verdict (exit 3), never an empty
 * ledger.
 *
 * ## Fail-closed
 *
 * Three conditions refuse loudly (exit 3) instead of degrading:
 *
 * - the graph coverage is incomplete — every "project missing" would be
 *   ambiguous between "gone" and "never seen";
 * - the intent cannot be verified (`judgeIntent`'s `unresolved` non-empty) —
 *   an intent that cannot be verified is not a clean ledger ("cannot verify"
 *   must never read as "no debt");
 * - the snapshot directory cannot be read or parsed — the ledger would either
 *   be empty (a shrug) or age against a record it could not read.
 *
 * An empty entry list must mean exactly "no exemptions, gaps or findings".
 *
 * ## Determinism
 *
 * The ledger sorts by the evaluator's total key — plain `<` comparison, never
 * `localeCompare` — and `sampleTime` rides in the result so a reader can see
 * when the ledger was taken; the aging itself is snapshot-relative
 * (`../governance/debt-ledger.mjs`).
 */
import { isWholeFileFailure } from "../analysis/source-util.mjs";
import { judgeIntent } from "../architecture-intent/judge.mjs";
import { INTENT_FILE, loadIntent } from "../architecture-intent/model.mjs";
import { computeDebtLedger } from "../governance/debt-ledger.mjs";
import { formatDebtReport } from "../report/debt-text.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { resolveProvenance } from "./provenance.mjs";
import { buildObserved, refuseIncompleteGraph } from "./drift.mjs";
import { readSnapshots } from "./history.mjs";

/**
 * Runs the `debt` command: computes the current candid facts, ages them across
 * the snapshot directory, and returns the ledger report.
 *
 * The `config` is resolved by the caller (`cli.mjs`) exactly the way `diff`'s
 * is — `--config`, the workspace's declared `boundaryConfig`, or the inline
 * `archkeep.json` policy — so a debt run and a `check` run never disagree about
 * the current boundary law.
 *
 * @param {string} dir Absolute path to the history directory.
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {{config?: {depConstraints: object[], options: object,
 *   suppressions: object[]}|null, referenceTime?: number|string,
 *   io?: {readSnapshots?: Function, loadIntentOverride?: Function,
 *   resolveProvenance?: Function}}} [options] Injectable seams for tests,
 *   mirroring the `history`/`drift` pattern.
 * @returns {Promise<{status: "ok", ledger: object, coverage: object,
 *   report: {text: string, json: string}}>}
 * @throws {Error} on every condition the header lists, all exit-3 class.
 */
export async function debtCommand(dir, commandContext, options = {}) {
  const { root, provider, marker, analysis } = commandContext;
  const io = options.io ?? {};
  const config = options.config ?? { depConstraints: [], options: {}, suppressions: [] };

  refuseIncompleteGraph(commandContext);

  const notAnalyzed = analysis.failures
    .filter(isWholeFileFailure)
    .map(({ sourceFile, reason }) => ({ file: sourceFile, reason }));
  if (notAnalyzed.length > 0) {
    throw new Error(
      `archkeep: debt has incomplete coverage — ${notAnalyzed.length} file` +
        `${notAnalyzed.length === 1 ? "" : "s"} could not be analyzed, so every "project missing" ` +
        `would be ambiguous between "gone" and "never seen". Fix the unanalyzed files and re-run.`,
    );
  }

  // The snapshot directory is the sole source of truth for aging; a directory
  // that cannot be read or parsed throws here (exit 3), never an empty ledger.
  const read = (io.readSnapshots ?? readSnapshots)(dir, root);

  // A directory that EXISTS but holds no snapshots is the same state
  // `historyCommand` refuses in `./history.mjs`, and for the same reason: an
  // empty directory is not an empty history, it is no record at all. The
  // ledger ages every entry against that record, so with nothing to age
  // against a "✔ no architecture debt" line would be a claim this run cannot
  // make — a fresh `.archkeep/history/`, or a CI cache whose capture step never
  // ran, would silently turn a `archkeep debt` gate into a no-op. This
  // command's own header says so ("A missing directory is a no-verdict
  // (exit 3), never an empty ledger"); an unpopulated one is the same
  // no-verdict wearing a different errno.
  if (read.files.length === 0) {
    throw new Error(
      `archkeep: the history directory '${dir}' contains no snapshots — there is no record to ` +
        `age the ledger against, so "no architecture debt" would be a claim this run cannot ` +
        `make. Capture one first with 'archkeep history <dir> --capture' (or point the command ` +
        `at the directory where you keep graph snapshots).`,
    );
  }

  const intent = await (io.loadIntentOverride ?? loadIntent)(root, {
    tracked: commandContext.tracked,
  });
  if (intent === undefined) {
    throw new Error(
      `archkeep: debt requires a tracked ${INTENT_FILE} at the workspace root, but none ` +
        `is present — a ledger of architecture debt needs the declared intent to compare against`,
    );
  }

  const verdict = judgeIntent(intent, {
    nodes: commandContext.graph.nodes,
    dependencies: commandContext.graph.dependencies,
  });
  if (verdict.unresolved.length > 0) {
    throw new Error(
      `archkeep: cannot build a debt ledger — ${INTENT_FILE} cannot be verified: ` +
        verdict.unresolved
          .map(({ boundary, issue }) => `boundary/row ${boundary}: ${issue}`)
          .join("; ") +
        `. An intent that cannot be verified is not a clean ledger; fix the intent or the graph and re-run.`,
    );
  }

  const ledger = computeDebtLedger(
    {
      suppressions: config.suppressions,
      intentNotes: verdict.notes,
      findings: verdict.findings,
    },
    read,
    { referenceTime: options.referenceTime },
  );

  const observed = buildObserved(commandContext);
  const coverage = {
    complete: true,
    projects: observed.projects.length,
    analyzedFiles: analysis.analyzed,
    imports: analysis.imports.length,
    notAnalyzed: [],
    blindSpots: analysis.failures
      .filter((failure) => !isWholeFileFailure(failure))
      .map(({ sourceFile, line, column, reason }) => ({ file: sourceFile, line, column, reason })),
    // The ledger names what it could not age — a reader can tell "aged" from
    // "observed, not yet aged". The second note discloses `sampleTime`'s own
    // nature: it reflects the wall clock at the moment of THIS run, not the
    // workspace, so it is expected to differ between two runs of an unchanged
    // tree, by design (`../governance/clock.mjs`) — disclosed here, in-band,
    // so a consumer diffing or hashing two envelopes to detect real drift
    // knows to exclude it rather than read clock drift as architectural
    // change; every other field is deterministic given the same law, history
    // directory and tree.
    notes: [
      `ledger ages are snapshot-relative; ${ledger.entries.length} entr` +
        `${ledger.entries.length === 1 ? "y" : "ies"} derived across ${read.files.length} snapshot` +
        `${read.files.length === 1 ? "" : "s"}`,
      "sampleTime is the wall clock at the moment of this run, not a fact about the " +
        "workspace — it is expected to differ between two runs of an unchanged tree and " +
        "should be excluded from any diff or hash meant to detect real change. Every other " +
        "field here is deterministic given the same law, history directory and tree.",
    ],
  };

  const context = {
    root,
    provider,
    marker,
    provenance: (io.resolveProvenance ?? resolveProvenance)(root),
  };
  const result = {
    dir,
    snapshots: read.files.length,
    agings: ledger.agings,
    sampleTime: ledger.sampleTime,
    entries: ledger.entries,
    total: ledger.total,
    byKind: ledger.byKind,
    bySeverity: ledger.bySeverity,
  };

  const envelope = jsonEnvelope({
    command: "debt",
    context,
    status: "ok",
    exitCode: 0,
    coverage,
    result,
  });

  return {
    status: "ok",
    ledger: result,
    coverage,
    report: {
      text: formatDebtReport({ ledger: result, coverage }),
      json: renderJson(envelope),
    },
  };
}
