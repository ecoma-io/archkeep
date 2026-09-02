/**
 * The Impact Statement: a composed, authoritative, deterministic enumeration of
 * every governed entity a change to one project touches — projects, edges,
 * constraints, and recorded Decisions — each tied to the reproducible evidence
 * that supports the claim, and with every gap reported rather than hidden.
 * This is a composition layer: it calls existing deterministic primitives
 * (`computeImpact`, `computeImpactConstraints`, `buildDecisionImpact`,
 * `buildEvolutionAlignment`) and assembles their outputs into one statement.
 * It does NOT invent evidence, run new analysis, or add a second authority.
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
import { computeImpactConstraints } from "./edge-constraints.mjs";
import { computeImpact } from "./impact.mjs";
import { buildDecisionImpact, buildEvolutionAlignment } from "./evaluation-primitives.mjs";

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
 * @property {{evaluated: boolean, entries: object[], note: string|null}} findingsImpact
 *   Findings that affect the impacted projects. `evaluated: false` when no
 *   findings data was provided — reported as a gap, never as "no findings".
 * @property {{evaluated: boolean, entries: object[], note: string|null}} debtImpact
 *   Debt entries that affect the impacted projects. `evaluated: false` when no
 *   debt data was provided — reported as a gap, never as "no debt".
 * @property {{boundaries: object[], evaluated: boolean}} boundaryImpact
 *   Boundary-crossing analysis for each affected edge. `evaluated: false` when
 *   no constraint impact was available.
 * @property {boolean} complete Whether the statement could be fully composed.
 * @property {string[]} notes Caveats about statement completeness and
 *   governance gaps.
 */

// ---------------------------------------------------------------------------
// Findings and Debt impact (governance integration)
// ---------------------------------------------------------------------------

/**
 * Evaluates findings impact for the affected projects.
 *
 * When no findings data is provided, reports the gap explicitly rather than
 * claiming no findings exist.
 *
 * @param {string[]} affectedProjects The projects affected by the change.
 * @param {object[]|null} [availableFindings] Optional pre-computed findings
 *   from the check pipeline.
 * @returns {{evaluated: boolean, entries: object[], note: string|null}}
 *   `evaluated: true` when findings data was available and filtered.
 *   `evaluated: false` when findings were not provided.
 */
function evaluateFindingsImpact(affectedProjects, availableFindings = null) {
  if (!availableFindings) {
    return {
      evaluated: false,
      entries: [],
      note: "findings impact not evaluated — no findings data provided to impact statement",
    };
  }

  // Filter findings by affected projects
  const affectedSet = new Set(affectedProjects);
  const entries = availableFindings.filter((f) => {
    const source = f.source ?? f.project ?? "";
    const target = f.target ?? "";
    return affectedSet.has(source) || affectedSet.has(target);
  });

  return {
    evaluated: true,
    entries,
    note:
      entries.length > 0
        ? `${entries.length} finding(s) affect impacted projects`
        : "no findings affect impacted projects",
  };
}

/**
 * Evaluates debt impact for the affected projects.
 *
 *
 * Debt entries have `source` as either a project name (for drift entries) or
 * a file path (for waiver entries). When a `resolveProject` function is
 * provided, file-path sources are resolved to project names for matching.
 * When no debt data is provided, reports the gap explicitly rather than
 * claiming no debt exists.
 *
 * @param {string[]} affectedProjects The projects affected by the change.
 * @param {object[]|null} [availableDebt] Optional pre-computed debt entries
 *   from the debt ledger (`computeDebtLedger().entries`).
 * @param {function(string): string|null} [resolveProject] Optional function
 *   to resolve a file path to its owning project name. Used for waiver entries
 *   whose `source` is a file path, not a project name.
 * @returns {{evaluated: boolean, entries: object[], note: string|null}}
 *   `evaluated: true` when debt data was available and filtering was attempted.
 *   `evaluated: false` when debt was not provided.
 */
function evaluateDebtImpact(affectedProjects, availableDebt = null, resolveProject = null) {
  if (!availableDebt) {
    return {
      evaluated: false,
      entries: [],
      note: "debt impact not evaluated — no debt data provided to impact statement",
    };
  }

  // Filter debt entries by affected projects.
  // Debt entries use `source` as either a project name (drift, unresolved) or
  // a file path (waiver, expired-waiver). For path-based sources, use the
  // resolveProject function when available.
  const affectedSet = new Set(affectedProjects);
  const entries = availableDebt.filter((d) => {
    // Drift and unresolved entries have source = project name directly
    if (d.kind === "drift" || d.kind === "unresolved") {
      return affectedSet.has(d.source ?? "");
    }
    // Waiver entries have source = file path; resolve via owning project
    if (d.kind === "waiver" || d.kind === "expired-waiver") {
      if (typeof resolveProject === "function") {
        const project = resolveProject(d.source ?? "");
        return project !== null && affectedSet.has(project);
      }
      // Without resolveProject, we cannot match path-based sources
      return false;
    }
    // Aspirational-gap entries have source = note text — no project match
    return false;
  });

  return {
    evaluated: true,
    entries,
    note:
      entries.length > 0
        ? `${entries.length} debt entry(ies) affect impacted projects`
        : "no debt entries affect impacted projects",
  };
}

/**
 * Evaluates boundary impact: which boundary tags/layers are crossed by the
 * affected edges.
 *
 * Unlike `evolutionAlignment.boundaries` which collects edge identities, this
 * evaluates whether the change crosses meaningful governance boundaries (e.g.
 * layer transitions, scope crossings).
 *
 * @param {object} graph The project graph.
 * @param {object[]} constraintImpact Per-dependent constraint analysis.
 * @param {string} targetProject The target of the impact analysis.
 * @returns {{boundaries: object[], evaluated: boolean}}
 */
function evaluateBoundaryImpact(graph, constraintImpact, targetProject) {
  if (!constraintImpact || constraintImpact.length === 0) {
    return { boundaries: [], evaluated: false };
  }

  const targetNode = graph.nodes[targetProject];
  const targetTags = targetNode?.data?.tags ?? [];
  const boundaries = [];

  for (const entry of constraintImpact) {
    const sourceTags = graph.nodes[entry.project]?.data?.tags ?? [];

    for (const edge of entry.edges) {
      // Determine if this edge crosses a layer boundary
      const sourceLayer = sourceTags.find((t) => t.startsWith("layer:"));
      const targetLayer = targetTags.find((t) => t.startsWith("layer:"));
      const crossesLayer = sourceLayer && targetLayer && sourceLayer !== targetLayer;

      // Determine if this edge crosses a scope boundary
      const sourceScope = sourceTags.find((t) => t.startsWith("scope:"));
      const targetScope = targetTags.find((t) => t.startsWith("scope:"));
      const crossesScope = sourceScope && targetScope && sourceScope !== targetScope;

      // Determine if any constraint row governs this edge
      const violated = entry.violations?.length > 0;
      const governingRowCount = entry.constraintRows?.length ?? 0;

      boundaries.push({
        source: entry.project,
        target: edge.target,
        type: edge.type,
        crossesLayer,
        crossesScope,
        violated,
        governingConstraintRows: governingRowCount,
      });
    }
  }

  return { boundaries, evaluated: true };
}

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

  // Step 1: Reverse reachability (existing primitive)
  const impact = computeImpact(projectName, graph);

  // Step 2: Edge and constraint impact (existing primitive)
  let constraintImpact = null;
  if (config && config.depConstraints) {
    constraintImpact = computeImpactConstraints(
      projectName,
      impact.dependents,
      graph.nodes,
      graph.dependencies,
      config.depConstraints,
    );
  }

  // Step 3: Decision impact (with evidence)
  let decisionImpact = null;
  if (constraintImpact) {
    decisionImpact = buildDecisionImpact(root, constraintImpact, config);
  }

  // Step 4: Evolution alignment
  const resolvedDecisions = decisionImpact ? decisionImpact.decisions.map((d) => d.id) : [];
  const evolutionAlignment = buildEvolutionAlignment(
    projectName,
    impact,
    constraintImpact,
    resolvedDecisions,
  );

  // Step 5: Boundary impact evaluation
  const boundaryImpact = evaluateBoundaryImpact(graph, constraintImpact, projectName);

  // Step 6: Findings and Debt impact evaluation
  const affectedProjects = [projectName, ...impact.dependents];
  const findingsImpact = evaluateFindingsImpact(affectedProjects, availableFindings);
  const debtImpact = evaluateDebtImpact(affectedProjects, availableDebt);

  // Step 7: Assemble the statement with evidence and coverage notes
  const notes = [];

  if (config && config.depConstraints) {
    notes.push(
      "constraint impact covers only depConstraints (3 of 15 violation types). " +
        "A project with no violations here may still violate other rules " +
        "that require import-site details. Run `check` for the complete verdict.",
    );
  }

  if (!findingsImpact.evaluated) {
    notes.push(
      "finding impact not evaluated — no findings data provided to impact statement. " +
        "Pass findings data for complete governance evaluation.",
    );
  }

  if (!debtImpact.evaluated) {
    notes.push(
      "debt impact not evaluated — no debt data provided to impact statement. " +
        "Pass debt data for complete governance evaluation.",
    );
  }
  // Step 8: Determine multi-level completeness
  const executionComplete = true; // reached this point without throwing
  const graphComplete = true; // reverse reachability always completes
  const constraintComplete = config !== null && config.depConstraints !== undefined;
  const boundaryComplete = config !== null;
  const decisionComplete = config !== null;
  const governanceComplete = findingsImpact.evaluated && debtImpact.evaluated;
  const overallComplete =
    executionComplete &&
    graphComplete &&
    (config === null || constraintComplete) &&
    (config === null || boundaryComplete) &&
    (config === null || decisionComplete) &&
    governanceComplete;

  const statement = {
    project: impact.project,
    impact: {
      direct: impact.direct,
      transitive: impact.transitive,
      dependents: impact.dependents,
    },
    evolutionAlignment,
    findingsImpact,
    debtImpact,
    boundaryImpact,
    completeness: {
      executionComplete,
      graphComplete,
      constraintComplete,
      boundaryComplete,
      decisionComplete,
      governanceComplete,
      overallComplete,
    },
    complete: overallComplete,
    notes,
  };

  if (constraintImpact) {
    statement.constraintImpact = constraintImpact;
  }

  if (decisionImpact) {
    statement.decisionImpact = decisionImpact;
    if (decisionImpact.unresolvedDecisionRefs.length > 0) {
      statement.notes.push(
        `unresolved decision references: ${decisionImpact.unresolvedDecisionRefs.join(", ")}`,
      );
    }
  }

  return statement;
}
