/**
 * The Impact Statement: a composed, authoritative, deterministic enumeration of
 * every governed entity a change to one project touches — projects, edges,
 * constraints, and recorded Decisions — each tied to the reproducible evidence
 * that supports the claim, and with every gap reported rather than hidden.
 *
 * This is a composition layer: it calls existing deterministic primitives
 * (`computeImpact`, `computeImpactConstraints`, `readAdrContext`,
 * `resolveDecisionRef`) and assembles their outputs into one statement. It
 * does NOT invent evidence, run new analysis, or add a second authority.
 *
 * ## What it composes
 *
 * - **Reverse reachability** — `computeImpact`: direct and transitive
 *   dependents of the target project.
 * - **Edge and boundary impact** — `computeImpactConstraints`: which
 *   constraint rows govern each dependent's edge and whether it currently
 *   violates them.
 * - **Decision impact** — which recorded decisions bind the affected
 *   constraint rows, resolved through the ADR registry. A `decisionRef` that
 *   does not resolve is reported in `unresolvedDecisionRefs`, never silently
 *   dropped.
 * - **Evolution alignment** — the `affected` shape matching
 *   `EvolutionEvent.affected` vocabulary: `projects`, `boundaries`,
 *   `constraints`, `decisions`.
 *
 * ## Determinism
 *
 * The statement is deterministic: two runs over an unchanged tree produce
 * byte-identical output. Every claim traces to a reproducible evidence source
 * (the graph, the constraint table, the ADR registry).
 *
 * ## Failure states
 *
 * - An unreadable ADR registry: all decision refs are reported as unresolved
 *   (listed in `unresolvedDecisionRefs`), never silently evaluated.
 * - An unknown decision ref: reported in `unresolvedDecisionRefs`, never
 *   silently dropped.
 *
 * @module
 */
import { evaluateArchitectureState } from "./evaluation-primitives.mjs";
/**
 * @typedef {object} ImpactStatement
 * @property {string} project The target project name.
 * @property {{direct: string[], transitive: string[], dependents: string[]}} impact
 *   Reverse reachability: which projects depend on the target.
 * @property {object[]} [constraintImpact] Per-dependent edge constraint
 *   analysis. Present only when a boundary config was provided.
 * @property {{decisions: object[], unresolvedDecisionRefs: string[]}} [decisionImpact]
 *   Which recorded decisions bind the affected constraint rows. Each decision
 *   carries an `evidence` field tracing the causal chain: which constraint
 *   row index and which dependent project triggered the binding.
 *   Present only when a boundary config with `depConstraints` was provided.
 * @property {{projects: string[], boundaries: string[], constraints: string[],
 *   decisions: string[]}} [evolutionAlignment] The `affected` shape matching
 *   `EvolutionEvent.affected` vocabulary.
 * @property {{evaluated: boolean, findings: object[], count: number}} findingsImpact
 *   Findings that affect the impacted projects. `evaluated: false` when no
 *   findings data was provided — reported as a gap, never as "no findings".
 * @property {{evaluated: boolean, debt: object[], count: number}} debtImpact
 *   Debt entries that affect the impacted projects. `evaluated: false` when no
 *   debt data was provided — reported as a gap, never as "no debt".
 * @property {{boundaries: object[], evaluated: boolean}} boundaryImpact
 *   Boundary-crossing analysis for each affected edge. `evaluated: false` when
 *   no constraint impact was available.
 * @property {{domains: {structural: {status: string, note?: string}, constraint: {status: string, note?: string}, boundary: {status: string, note?: string}, decision: {status: string, note?: string}, governance: {status: string, note?: string}}, overallComplete: boolean, overallStatus: string}} completeness
 *   Completeness of each evaluation domain and the overall assessment.
 * @property {boolean} complete Whether the statement could be fully composed.
 *   Backward-compat alias for `completeness.overallComplete`.
 * @property {string[]} notes Caveats about statement completeness and
 *   governance gaps.
 */

/**
 * Composes the full Impact Statement for a project.
 *
 * @param {string} projectName The target project.
 * @param {object} commandContext The resolved command context (graph, analysis,
 *   root, provider, etc.).
 * @param {object|null} [config] The loaded boundary config. When provided,
 *   constraint and decision impact are computed.
 * @param {object} [options] Optional data for governance integration.
 * @param {object[]|null} [options.findings] Pre-computed findings from the
 *   check pipeline. When null, findings impact is reported as not evaluated.
 * @param {object[]|null} [options.debt] Pre-computed debt entries from the
 *   debt ledger. When null, debt impact is reported as not evaluated.
 * @returns {ImpactStatement}
 * @throws {import("../errors.mjs").UsageError} When the project is not in the graph.
 */
export function composeImpactStatement(projectName, commandContext, config = null, options = {}) {
  const { root, graph } = commandContext;
  const { findings: availableFindings = null, debt: availableDebt = null } = options;

  // Delegate to the canonical evaluator — one semantic evaluator, many views
  const evaluation = evaluateArchitectureState({
    graph,
    config,
    projectName,
    root,
    findings: availableFindings,
    debt: availableDebt,
  });

  // Build impact-statement-specific notes
  const notes = [];

  if (config && config.depConstraints) {
    notes.push(
      "constraint impact covers only depConstraints (3 of 15 violation types). " +
        "A project with no violations here may still violate other rules " +
        "that require import-site details. Run `check` for the complete verdict.",
    );
  }

  if (!evaluation.findingsImpact.evaluated) {
    notes.push(
      "finding impact not evaluated — no findings data provided to impact statement. " +
        "Pass findings data for complete governance evaluation.",
    );
  }

  if (!evaluation.debtImpact.evaluated) {
    notes.push(
      "debt impact not evaluated — no debt data provided to impact statement. " +
        "Pass debt data for complete governance evaluation.",
    );
  }

  const statement = {
    project: evaluation.project,
    impact: evaluation.impact,
    evolutionAlignment: evaluation.evolutionAlignment,
    findingsImpact: evaluation.findingsImpact,
    debtImpact: evaluation.debtImpact,
    boundaryImpact: evaluation.boundaryImpact,
    completeness: evaluation.completeness,
    complete: evaluation.completeness.overallComplete,
    notes,
  };

  if (evaluation.constraintImpact) {
    statement.constraintImpact = evaluation.constraintImpact;
  }

  if (evaluation.decisionImpact) {
    statement.decisionImpact = evaluation.decisionImpact;
    if (evaluation.decisionImpact.unresolvedDecisionRefs.length > 0) {
      statement.notes.push(
        `unresolved decision references: ${evaluation.decisionImpact.unresolvedDecisionRefs.join(", ")}`,
      );
    }
  }

  return statement;
}
