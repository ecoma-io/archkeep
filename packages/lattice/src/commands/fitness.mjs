/**
 * The `fitness` command: every declared fitness function judged against the
 * observed workspace, as a verdict table.
 *
 * Fitness functions are the workspace's executable quality gates
 * (`module-boundaries.config.mjs`'s `fitness` export, validated by
 * `../config.mjs`): "the graph stays cycle-free", "no adapter reaches the
 * domain", "at least 90% of files are analyzed", "no more than N boundary
 * suppressions". Each is judged deterministically against the SAME observed
 * facts `check` reads — the project graph, the workspace analysis, the
 * architecture intent, and the boundary suppressions — through the registry
 * `../governance/fitness-registry.mjs` (which reuses `resolveMembers` and the
 * E0 verdict envelope, never duplicating a judge).
 *
 * ## Posture
 *
 * `fitness` is descriptive exactly like `diff`/`drift`: it prints a verdict
 * table and never exits 1. Only `check` exits 1, and `check` folds fitness in
 * by presence — a workspace whose policy declares fitness gets its per-function
 * verdicts counted into the same verdict machinery (exit 1 for any `fail`,
 * exit 3 for any `unknown`, never a new exit code). There is no `--fitness`
 * flag: an opt-in flag would make a forgotten flag byte-identical to "no
 * fitness checked", the silent direction this tool exists to end.
 *
 * ## Fail-closed
 *
 * A declared function that cannot be determined yields `unknown` — never
 * `pass`. The mirror of `drift`'s refusals: a `layer-dependency` tag no
 * matched project carries, a `coverage-minimum` over zero owned files, a
 * `drift-free` over no architecture-intent.json, and a path-scoped run all
 * answer `unknown` with the missing fact named. A function whose `match`
 * selects no project is `skipped` — loud ("declared but matches nothing"),
 * never folded into `pass`.
 *
 * ## Determinism
 *
 * Rows are judged in declaration order; edges and evidence are plain-`<`
 * sorted; JSON rides `canonicalizeJson`. Two runs over an unchanged tree and
 * policy produce byte-identical text and JSON.
 */
import { isWholeFileFailure } from "../analysis/source-util.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { formatFitnessSection } from "../report/text.mjs";
import { resolveProvenance } from "./provenance.mjs";
import { driftForCheck } from "./drift.mjs";
import { INTENT_FILE } from "../architecture-intent/model.mjs";
import {
  evaluateFitness,
  fitnessSnapshot,
  fitnessVerdictFor,
} from "../governance/fitness-registry.mjs";

/**
 * The `fitness` command's own text report: the same verdict table `check`'s
 * fold renders (`formatFitnessSection`), so the two faces can never disagree
 * about a function's verdict.
 *
 * @param {object[]} decisions Per-function verdict records.
 * @param {{verdict: string}} overall From `fitnessVerdictFor`.
 * @returns {string}
 */
function formatFitnessReport(decisions, overall) {
  return formatFitnessSection(decisions, overall);
}

/**
 * The fitness verdicts for `check`'s fold — the policy's rows evaluated
 * against the run's own facts (`check` needs no override: it already holds the
 * intent verdict it judged and the suppressions it enforced).
 *
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {{rows: object[], intent: object|null, suppressions: object[],
 *   scoped: boolean}} policy The validated fitness rows plus the run's own
 *   intent verdict and suppressions, scoped by `paths`.
 * @returns {{decisions: object[], overall: {verdict: string}}}
 */
export function fitnessForCheck(commandContext, { rows, intent, suppressions, scoped }) {
  const snapshot = fitnessSnapshot(commandContext, { intent, suppressions, scoped });
  const decisions = evaluateFitness(rows, snapshot);
  return { decisions, overall: fitnessVerdictFor(decisions) };
}

/**
 * Runs the `fitness` command: loads the boundary policy, evaluates every
 * declared function against the workspace's facts, and renders the verdict
 * table.
 *
 * The command re-reads the intent itself (its own `architecture-intent.json`
 * load) and the suppressions from the policy, so its verdict is the same facts
 * `check` folds — one registry, one snapshot shape, two faces.
 *
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {{config?: object|null}} [io] The loaded policy, injectable for tests.
 * @returns {Promise<{status: "ok", fitness: object, coverage: object,
 *   report: {text: string, json: string}}>}
 * @throws {Error} on every condition the header lists, all exit-3 class.
 */
export async function fitnessCommand(commandContext, io = {}) {
  const { root, provider, marker, analysis } = commandContext;

  const config = io.config ?? null;
  if (config === null || config.fitness === undefined) {
    throw new Error(
      `lattice: fitness requires a policy that declares fitness functions — ` +
        `module-boundary config has no \`fitness\` export, so there is nothing to judge`,
    );
  }

  // A verdict over a tree it could not fully read is a guess. Same refusal
  // `drift`/`graph`/`diff` make for the same condition.
  const notAnalyzed = analysis.failures
    .filter(isWholeFileFailure)
    .map(({ sourceFile, reason }) => ({ file: sourceFile, reason }));
  if (notAnalyzed.length > 0) {
    throw new Error(
      `lattice: fitness has incomplete coverage — ${notAnalyzed.length} file` +
        `${notAnalyzed.length === 1 ? "" : "s"} could not be analyzed, so every coverage ` +
        `and graph claim would be ambiguous between "clean" and "never seen". Fix the ` +
        `unanalyzed files and re-run.`,
    );
  }

  // `drift-free` judges the SAME verdict-shaped intent `check`'s fold builds —
  // `driftForCheck` (not raw `loadIntent`) — so the two faces can never
  // disagree about whether the declared intent matches the observed graph. A
  // drift comparison that cannot be completed surfaces as an `unknown` verdict
  // on the function, never a `fail` reading "0 findings" over an intent the
  // command never actually judged.
  let intent;
  try {
    const drift = await driftForCheck(commandContext);
    intent = {
      verdict:
        drift.findings.length > 0 ? "findings" : drift.unresolved.length > 0 ? "no-verdict" : "ok",
      boundaries: drift.boundaries,
      findings: drift.findings,
      unresolved: drift.unresolved,
      notes: drift.notes,
    };
  } catch (cause) {
    intent = {
      verdict: "no-verdict",
      findings: [],
      unresolved: [{ boundary: INTENT_FILE, issue: cause?.message ?? String(cause) }],
      boundaries: [],
      notes: [],
    };
  }
  const snapshot = fitnessSnapshot(commandContext, {
    intent,
    suppressions: config.suppressions,
  });
  const decisions = evaluateFitness(config.fitness, snapshot);
  const overall = fitnessVerdictFor(decisions);

  const coverage = {
    complete: true,
    projects: Object.keys(commandContext.graph.nodes).length,
    analyzedFiles: analysis.analyzed,
    imports: analysis.imports.length,
    notAnalyzed: [],
    blindSpots: analysis.failures
      .filter((failure) => !isWholeFileFailure(failure))
      .map(({ sourceFile, line, column, reason }) => ({ file: sourceFile, line, column, reason })),
    notes: [],
  };

  const context = { root, provider, marker, provenance: resolveProvenance(root) };
  const status = "ok";
  const exitCode = 0;
  const result = { verdict: overall.verdict, functions: decisions };

  const report = {
    text: formatFitnessReport(decisions, overall),
    json: renderJson(
      jsonEnvelope({ command: "fitness", context, status, exitCode, coverage, result }),
    ),
  };

  return { status, fitness: result, coverage, report };
}
