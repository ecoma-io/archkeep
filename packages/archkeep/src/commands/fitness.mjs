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
 * `fitness` prints a verdict table, and the verdict carries the exit code: a
 * failing function is a finding (exit 1) and an undetermined one is a
 * could-not-determine (exit 3) — the same two lanes `check` uses, argued at
 * the status↔exitCode mapping below (D-09). `check` also folds fitness in by
 * presence — a workspace whose policy declares fitness gets its per-function
 * verdicts counted into the same verdict machinery (exit 1 for any `fail`,
 * exit 3 for any `unknown`, never a new exit code). There is no `--fitness`
 * flag: an opt-in flag would make a forgotten flag byte-identical to "no
 * fitness checked", the silent direction this tool exists to end.
 *
 * ## Fail-closed
 *
 * A declared function that cannot be determined yields `unknown` — never
 * `pass`. The mirror of `drift`'s refusals: a `layer-dependency` tag no
 * matched project carries, a `coverage-minimum` over zero owned files, and a
 * `drift-free` over no architecture-intent.json all answer `unknown` with the
 * missing fact named. A function whose `match` selects no project is
 * `skipped` — loud ("declared but matches nothing"), never folded into
 * `pass`; a `coverage-minimum` row judged from a path-scoped run joins it
 * there rather than `unknown` (`../governance/fitness-rules.mjs`), because a
 * scoped `check <path>` structurally cannot answer a whole-tree coverage
 * question — that is not evidence of a hole, and folding it into `unknown`
 * used to make `check <path>` exit 3 unconditionally in any workspace
 * declaring `coverage-minimum` (P1-19).
 *
 * ## Determinism
 *
 * Rows are judged in declaration order; edges and evidence are plain-`<`
 * sorted; JSON rides `canonicalizeJson`. Two runs over an unchanged tree and
 * policy produce byte-identical text and JSON.
 */
import {
  blindSpotRows,
  isWholeFileFailure,
  unresolvableLiteralCount,
} from "../analysis/source-util.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { formatFitnessSection } from "../report/text.mjs";
import { resolveProvenance } from "./provenance.mjs";
import { driftForCheck } from "./drift.mjs";
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
 * Whether a policy declares fitness functions at all — the one condition that
 * separates "this workspace has no quality gates to judge" from "the gates
 * could not be judged". `fitnessCommand` refuses (exit 3) when it is false,
 * because a `fitness` run asked for a table that does not exist; a composing
 * report reads the same predicate to render `not_applicable` instead, which is
 * the correct verdict for a workspace that declared none
 * (`../governance/metrics.mjs`'s header owns that distinction). Exported so the
 * two callers cannot come to disagree about what "declares fitness" means.
 *
 * @param {{fitness?: unknown}|null|undefined} config The loaded boundary policy.
 * @returns {boolean}
 */
export function declaresFitness(config) {
  return config !== null && config !== undefined && config.fitness !== undefined;
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
 * @returns {Promise<{status: "ok"|"findings"|"no-verdict", fitness: object, coverage: object,
 *   report: {text: string, json: string}}>}
 * @throws {Error} on every condition the header lists, all exit-3 class.
 */
export async function fitnessCommand(commandContext, io = {}) {
  const { root, provider, marker, analysis } = commandContext;

  const config = io.config ?? null;
  if (!declaresFitness(config)) {
    throw new Error(
      `archkeep: fitness requires a policy that declares fitness functions — ` +
        `module-boundary config has no \`fitness\` export, so there is nothing to judge`,
    );
  }

  // A verdict over a tree it could not fully read is a guess. Same refusal
  // `drift`/`graph`/`diff` make for the same condition.
  const notAnalyzed = analysis.failures
    .filter(isWholeFileFailure)
    .map(({ sourceFile, reason }) => ({ file: sourceFile, reason }));

  const blindSpotCount = unresolvableLiteralCount(analysis.failures);
  if (notAnalyzed.length > 0) {
    throw new Error(
      `archkeep: fitness has incomplete coverage — ` +
        [
          notAnalyzed.length > 0
            ? `${notAnalyzed.length} file${notAnalyzed.length === 1 ? "" : "s"} could not be analyzed`
            : null,
          blindSpotCount > 0
            ? `${blindSpotCount} import site${blindSpotCount === 1 ? "" : "s"} could not be resolved`
            : null,
        ]
          .filter(Boolean)
          .join(", ") +
        `, so every coverage ` +
        `and graph claim would be ambiguous between "clean" and "never seen". Fix the ` +
        `unanalyzed files and re-run.`,
    );
  }

  // `drift-free` judges the SAME verdict-shaped intent `check`'s fold builds —
  // `driftForCheck` (not raw `loadIntent`) — so the two faces can never
  // disagree about whether the declared intent matches the observed graph. A
  // drift comparison that cannot be completed surfaces as an `unknown` verdict
  // on the function, never a `fail` reading "0 findings" over an intent the
  // command never actually judged. `driftForCheck` is called UNCONDITIONALLY —
  // never gated on `tracked` the way `check`/`plan-context-command.mjs` gate
  // their own calls — because this command must still reach
  // `driftForCheck`'s `refuseIncompleteGraph` guard whether or not intent is
  // declared: an Nx workspace with an unregistered plugin over polyglot
  // manifests must refuse loudly regardless of intent. `driftForCheck` itself
  // resolves an absent intent (`drift.intent === undefined`) to a quiet
  // result rather than judging one, which is what makes this unconditional
  // call safe; that signal becomes `intent: null` here, the same value
  // `check`'s fold passes when no intent file is tracked at all, and
  // `drift-free` below reads it as `unknown`. `driftForCheck` is NOT caught
  // here: every OTHER fail-closed condition — that same unregistered-plugin
  // refusal, an unreadable or invalid intent — must exit 3 exactly as they do
  // for `drift`/`graph`/`impact`/`explain`, not fold into a verdict-bearing
  // run over a graph that cannot see the workspace.
  const drift = await driftForCheck(commandContext);
  const intent =
    drift.intent === undefined
      ? null
      : {
          verdict:
            drift.findings.length > 0
              ? "findings"
              : drift.unresolved.length > 0
                ? "no-verdict"
                : "ok",
          boundaries: drift.boundaries,
          findings: drift.findings,
          unresolved: drift.unresolved,
          notes: drift.notes,
        };
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
    blindSpots: blindSpotRows(analysis.failures),
    notes: [],
  };

  const context = { root, provider, marker, provenance: resolveProvenance(root) };
  // D-09: a `fitness` run is a verdict, not a print job. `fail` is a finding
  // (exit 1) and `unknown` is a could-not-determine (exit 3) — the same two
  // lanes `check` uses, so a CI that gates on `archkeep fitness` cannot be
  // green over a function the run could not determine. `pass` and a run whose
  // every function is `not_applicable` are both `ok`: nothing failed and
  // nothing stayed undetermined. The status↔exitCode pair is asserted by
  // `jsonEnvelope` (3-on-no-verdict), so a wrong mapping here cannot ship.
  /** @type {{status: "ok"|"findings"|"no-verdict", exitCode: 0|1|3}} */
  const { status, exitCode } =
    overall.verdict === "fail"
      ? { status: "findings", exitCode: 1 }
      : overall.verdict === "unknown"
        ? { status: "no-verdict", exitCode: 3 }
        : { status: "ok", exitCode: 0 };
  const result = { verdict: overall.verdict, functions: decisions };

  const report = {
    text: formatFitnessReport(decisions, overall),
    json: renderJson(
      jsonEnvelope({ command: "fitness", context, status, exitCode, coverage, result }),
    ),
  };

  return { status, fitness: result, coverage, report };
}
