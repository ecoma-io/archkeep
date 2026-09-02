/**
 * Scenario Evaluation: the second architecture-intelligence capability
 * (`docs/doctrine/scenario-evaluation.md`).
 *
 * Given a hypothetical change description (the "scenario"), applies it to a
 * real workspace graph and re-runs the deterministic impact-analysis path to
 * produce a current-versus-scenario comparison. Every output field carries a
 * `virtual: true` / `notAuthoritative` marker — a scenario is never a real
 * verdict and never enters canonical history.
 *
 * ## What it evaluates
 *
 * For the MVP, a scenario describes **dependency changes**:
 *
 * - `dependency_added`: adds an edge from `source` to `target`.
 * - `dependency_removed`: removes an edge from `source` to `target`.
 *
 * Each scenario is evaluated against a **base graph** (the current workspace
 * graph). The scenario's would-be graph is derived by applying the changes,
 * then the deterministic impact path is re-run. The result is compared against
 * the current impact to produce a delta.
 *
 * ## Design constraints
 *
 * - Read-only: no workspace mutation, no canonical history write.
 * - Deterministic: two runs over the same base and scenario produce identical
 *   output.
 * - Reuses existing primitives: `computeImpact`, `computeImpactConstraints`,
 *   `buildDecisionImpact`, `buildEvolutionAlignment`.
 * - States its own limits: any unevaluated consequence is named.
 *
 * @module
 */
import { computeImpact } from "./impact.mjs";
import { computeImpactConstraints } from "./edge-constraints.mjs";
import { buildDecisionImpact, buildEvolutionAlignment } from "./evaluation-primitives.mjs";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Scenario types
// ---------------------------------------------------------------------------

/** The supported scenario change types. */
export const SCENARIO_CHANGE_TYPES = Object.freeze(["dependency_added", "dependency_removed"]);

// ---------------------------------------------------------------------------
// Input schema types
// ---------------------------------------------------------------------------

/**
 * @typedef {object} DependencyChange
 * @property {"dependency_added"|"dependency_removed"} type
 * @property {string} source The source project of the dependency.
 * @property {string} target The target project of the dependency.
 */

/**
 * @typedef {object} ScenarioInput
 * @property {string} [base] Optional git revision for attribution. When not
 *   provided, resolved from `git rev-parse HEAD`.
 * @property {DependencyChange[]} changes The hypothetical changes to evaluate.
 */

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------
/**
 * @typedef {object} ScenarioEvaluation
 * @property {boolean} virtual Always true — a scenario is never authoritative.
 * @property {boolean} notAuthoritative Always true — mirrors `virtual`.
 * @property {string} project The target project being evaluated.
 * @property {object} base The base graph information.
 * @property {string} base.revision The git revision or snapshot identity.
 * @property {boolean} base.attributed Whether the base is a real, verifiable revision.
 * @property {string} base.provenance How the base was determined (user-provided, auto-resolved, or unverifiable).
 * @property {string[]} changes The change descriptions that were applied.
 * @property {string[]|undefined} refused Changes that could not be applied, if any.
 * @property {object} current The current impact for the target project.
 * @property {object} scenario The would-be impact after applying the changes.
 * @property {object} delta What would change.
 * @property {object} [evidenceChain] The provenance chain: base → changes → re-evaluated → delta.
 * @property {string} evidenceChain.baseRevision The revision the scenario started from.
 * @property {string[]} evidenceChain.appliedChanges The changes applied to the base.
 * @property {string} evidenceChain.currentState The state before applying changes ("current").
 * @property {string} evidenceChain.scenarioState The state after applying changes ("scenario").
 * @property {object} evidenceChain.delta The computed differences.
 * @property {object} [governanceImpact] Governance re-evaluation results.
 * @property {boolean} governanceImpact.findingsReEvaluated Whether findings were re-evaluated.
 * @property {boolean} governanceImpact.debtReEvaluated Whether debt was re-evaluated.
 * @property {boolean} governanceImpact.governanceComplete Whether all governance data was provided.
 * @property {number} governanceImpact.scenarioFindingsCount Number of findings in the scenario state.
 * @property {number} governanceImpact.scenarioDebtCount Number of debt entries in the scenario state.
 * @property {boolean} complete Whether the evaluation could be fully completed.
 * @property {string[]} notes Caveats about the evaluation.
 */

// ---------------------------------------------------------------------------
// Graph manipulation
// ---------------------------------------------------------------------------

/**
 * Deep-clones the graph's nodes and dependencies for mutation.
 *
 * @param {object} graph The project graph: `{nodes, dependencies}`.
 * @returns {{nodes: object, dependencies: object}}
 */
function cloneGraph(graph) {
  const nodes = { ...graph.nodes };
  const dependencies = {};
  for (const [source, edges] of Object.entries(graph.dependencies)) {
    dependencies[source] = edges.map((e) => ({ ...e }));
  }
  return { nodes, dependencies };
}

/**
 * Applies a scenario's changes to a graph, producing a would-be graph.
 *
 * @param {object} graph The base graph to apply changes to.
 * @param {DependencyChange[]} changes The hypothetical changes.
 * @returns {{graph: object, applied: string[], refused: string[]}}
 */
function applyChanges(graph, changes) {
  const cloned = cloneGraph(graph);
  const applied = [];
  const refused = [];

  for (const change of changes) {
    if (!SCENARIO_CHANGE_TYPES.includes(change.type)) {
      refused.push(`unsupported change type: "${change.type}"`);
      continue;
    }

    if (change.type === "dependency_added") {
      // Validate that source and target exist in the graph
      if (!Object.hasOwn(cloned.nodes, change.source)) {
        refused.push(`cannot add dependency: source project "${change.source}" not in graph`);
        continue;
      }
      if (!Object.hasOwn(cloned.nodes, change.target)) {
        refused.push(`cannot add dependency: target project "${change.target}" not in graph`);
        continue;
      }

      // Check if edge already exists
      const existing = cloned.dependencies[change.source] ?? [];
      if (existing.some((e) => e.target === change.target)) {
        applied.push(`dependency already exists: ${change.source} → ${change.target}`);
        continue;
      }

      // Add the edge
      if (!cloned.dependencies[change.source]) {
        cloned.dependencies[change.source] = [];
      }
      cloned.dependencies[change.source].push({
        target: change.target,
        type: "static",
        source: change.source,
      });
      applied.push(`added dependency: ${change.source} → ${change.target}`);
    }

    if (change.type === "dependency_removed") {
      const existing = cloned.dependencies[change.source] ?? [];
      const idx = existing.findIndex((e) => e.target === change.target);
      if (idx === -1) {
        refused.push(
          `cannot remove dependency: no edge from "${change.source}" to "${change.target}"`,
        );
        continue;
      }
      existing.splice(idx, 1);
      applied.push(`removed dependency: ${change.source} → ${change.target}`);
    }
  }

  return { graph: cloned, applied, refused };
}

/**
 * Computes the delta between current and scenario.
 *
 * @param {object} current Current impact.
 * @param {object} scenario Scenario impact.
 * @returns {{dependentsAdded: string[], dependentsRemoved: string[],
 *   constraintsChanged: boolean, decisionsChanged: boolean}}
 */
function computeDelta(current, scenario) {
  const currentDeps = new Set(current.impact.dependents ?? []);
  const scenarioDeps = new Set(scenario.impact.dependents ?? []);

  const dependentsAdded = [...scenarioDeps].filter((d) => !currentDeps.has(d)).sort();
  const dependentsRemoved = [...currentDeps].filter((d) => !scenarioDeps.has(d)).sort();

  const constraintsChanged =
    JSON.stringify(current.constraintImpact ?? []) !==
    JSON.stringify(scenario.constraintImpact ?? []);

  const decisionsChanged =
    JSON.stringify(current.decisionImpact ?? []) !== JSON.stringify(scenario.decisionImpact ?? []);

  return {
    dependentsAdded,
    dependentsRemoved,
    constraintsChanged,
    decisionsChanged,
  };
}
/**
 * Resolves the base revision for a scenario evaluation.
 *
 * When the user provides a `base` string, it is used as-is and marked as
 * attributed. When no base is provided, we attempt to resolve from
 * `git rev-parse HEAD`. If that fails, we report the gap rather than
 * fabricating a revision.
 *
 * @param {string} root The workspace root.
 * @param {string|undefined} userBase The user-provided base (optional).
 * @returns {{revision: string, attributed: boolean, provenance: string}}
 */
function resolveBaseRevision(root, userBase) {
  if (typeof userBase === "string" && userBase.length > 0) {
    return {
      revision: userBase,
      attributed: true,
      provenance: "user-provided",
    };
  }

  // Attempt to resolve from git
  try {
    const revision = execSync("git rev-parse HEAD", {
      cwd: root,
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (revision && revision.length === 40) {
      return {
        revision,
        attributed: true,
        provenance: "auto-resolved: git rev-parse HEAD",
      };
    }
  } catch {
    // Fall through to unverifiable
  }

  return {
    revision: "(unattributed workspace)",
    attributed: false,
    provenance: "unverifiable — git rev-parse HEAD failed or not a git repository",
  };
}

/**
 * Evaluates a scenario against the current workspace.
 *
 * @param {string} projectName The target project.
 * @param {object} commandContext The resolved command context.
 * @param {ScenarioInput} scenarioInput The scenario description.
 * @param {object|null} [config] The loaded boundary config.
 * @param {object} [options] Optional data for governance integration.
 * @param {object[]|null} [options.findings] Pre-computed findings for
 *   governance re-evaluation on the hypothetical graph.
 * @param {object[]|null} [options.debt] Pre-computed debt entries for
 *   governance re-evaluation.
 * @returns {ScenarioEvaluation}
 */
export function evaluateScenario(
  projectName,
  commandContext,
  scenarioInput,
  config = null,
  options = {},
) {
  const { root, graph } = commandContext;
  const { findings: availableFindings = null, debt: availableDebt = null } = options;

  // Step 1: Resolve base revision (real attribution)
  const base = resolveBaseRevision(root, scenarioInput.base);

  // Step 2: Compute current impact
  const currentImpact = computeImpact(projectName, graph);

  let currentConstraintImpact = null;
  if (config && config.depConstraints) {
    currentConstraintImpact = computeImpactConstraints(
      projectName,
      currentImpact.dependents,
      graph.nodes,
      graph.dependencies,
      config.depConstraints,
    );
  }

  // Step 3: Apply scenario changes to the graph
  const { graph: scenarioGraph, applied, refused } = applyChanges(graph, scenarioInput.changes);

  // Step 4: Compute scenario impact
  const scenarioImpact = computeImpact(projectName, scenarioGraph);

  let scenarioConstraintImpact = null;
  if (config && config.depConstraints) {
    scenarioConstraintImpact = computeImpactConstraints(
      projectName,
      scenarioImpact.dependents,
      scenarioGraph.nodes,
      scenarioGraph.dependencies,
      config.depConstraints,
    );
  }

  // Step 5: Build decision impact for both sides
  const currentDecisionImpact = buildDecisionImpact(root, currentConstraintImpact, config);
  const scenarioDecisionImpact = buildDecisionImpact(root, scenarioConstraintImpact, config);

  // Step 6: Build evolution alignment for both sides
  const currentResolved = currentDecisionImpact
    ? currentDecisionImpact.decisions.map((d) => d.id)
    : [];
  const scenarioResolved = scenarioDecisionImpact
    ? scenarioDecisionImpact.decisions.map((d) => d.id)
    : [];

  const currentEvolution = buildEvolutionAlignment(
    projectName,
    currentImpact,
    currentConstraintImpact,
    currentResolved,
  );
  const scenarioEvolution = buildEvolutionAlignment(
    projectName,
    scenarioImpact,
    scenarioConstraintImpact,
    scenarioResolved,
  );

  // Step 7: Compute delta
  const currentState = {
    impact: currentImpact,
    constraintImpact: currentConstraintImpact,
    decisionImpact: currentDecisionImpact,
  };
  const scenarioState = {
    impact: scenarioImpact,
    constraintImpact: scenarioConstraintImpact,
    decisionImpact: scenarioDecisionImpact,
  };
  const delta = computeDelta(currentState, scenarioState);

  // Step 8: Build evidence chain
  const evidenceChain = {
    baseRevision: base.revision,
    appliedChanges: applied,
    currentState: "current",
    scenarioState: "scenario",
    delta: {
      dependentsAdded: delta.dependentsAdded,
      dependentsRemoved: delta.dependentsRemoved,
      constraintsChanged: delta.constraintsChanged,
      decisionsChanged: delta.decisionsChanged,
    },
  };

  // Step 9: Evaluate governance impact on scenario (hypothetical re-evaluation)
  const scenarioAffectedProjects = [projectName, ...scenarioImpact.dependents];
  let scenarioFindings = null;
  let scenarioDebt = null;
  if (availableFindings) {
    // Re-filter findings for the hypothetical graph's affected projects
    const affectedSet = new Set(scenarioAffectedProjects);
    scenarioFindings = availableFindings.filter((f) => {
      const source = f.source ?? f.project ?? "";
      const target = f.target ?? "";
      return affectedSet.has(source) || affectedSet.has(target);
    });
  }
  if (availableDebt) {
    const affectedSet = new Set(scenarioAffectedProjects);
    scenarioDebt = availableDebt.filter((d) => {
      if (d.kind === "drift" || d.kind === "unresolved") {
        return affectedSet.has(d.source ?? "");
      }
      return false;
    });
  }

  // Step 10: Build notes — coverage and completeness
  const notes = [
    "virtual evaluation — not authoritative",
    "this scenario has not been committed; run `check` for the real verdict",
  ];
  if (config && config.depConstraints) {
    notes.push(
      "constraint impact covers only depConstraints (3 of 15 violation types). " +
        "A project with no violations here may still violate other rules.",
    );
  }
  if (!availableFindings) {
    notes.push(
      "finding impact not re-evaluated — no findings data provided to scenario. " +
        "Pass findings data for complete governance re-evaluation.",
    );
  }
  if (!availableDebt) {
    notes.push(
      "debt impact not re-evaluated — no debt data provided to scenario. " +
        "Pass debt data for complete governance re-evaluation.",
    );
  }
  if (refused.length > 0) {
    notes.push(`changes that could not be applied: ${refused.join("; ")}`);
  }
  // Step 11: Assemble — determine multi-level completeness semantics
  // Each dimension records whether that axis of evaluation completed
  // successfully. `overallComplete` is the aggregate: true only when every
  // applicable dimension completed.
  const executionComplete = true; // reached this point without throwing
  const graphComplete = refused.length === 0;
  const constraintComplete = config !== null && config.depConstraints !== undefined;
  const decisionComplete = config !== null;
  const governanceComplete = availableFindings !== null && availableDebt !== null;
  const evidenceComplete = base.attributed;
  const overallComplete =
    executionComplete &&
    graphComplete &&
    (config === null || constraintComplete) &&
    (config === null || decisionComplete) &&
    governanceComplete &&
    evidenceComplete;

  return {
    virtual: true,
    notAuthoritative: true,
    project: projectName,
    base,
    changes: applied,
    refused: refused.length > 0 ? refused : undefined,
    evidenceChain,
    current: {
      impact: {
        project: currentImpact.project,
        direct: currentImpact.direct,
        transitive: currentImpact.transitive,
        dependents: currentImpact.dependents,
      },
      constraintImpact: currentConstraintImpact,
      decisionImpact: currentDecisionImpact,
      evolutionAlignment: currentEvolution,
    },
    scenario: {
      impact: {
        project: scenarioImpact.project,
        direct: scenarioImpact.direct,
        transitive: scenarioImpact.transitive,
        dependents: scenarioImpact.dependents,
      },
      constraintImpact: scenarioConstraintImpact,
      decisionImpact: scenarioDecisionImpact,
      evolutionAlignment: scenarioEvolution,
      ...(scenarioFindings !== null ? { findings: scenarioFindings } : {}),
      ...(scenarioDebt !== null ? { debt: scenarioDebt } : {}),
    },
    governanceImpact: {
      findingsReEvaluated: availableFindings !== null,
      debtReEvaluated: availableDebt !== null,
      governanceComplete,
      scenarioFindingsCount: scenarioFindings?.length ?? 0,
      scenarioDebtCount: scenarioDebt?.length ?? 0,
    },
    delta,
    completeness: {
      executionComplete,
      graphComplete,
      constraintComplete,
      decisionComplete,
      governanceComplete,
      evidenceComplete,
      overallComplete,
    },
    complete: overallComplete,
    notes,
  };
}

/**
 * Validates and parses a scenario input from a JSON string.
 *
 * @param {string} jsonString The raw JSON string.
 * @returns {ScenarioInput}
 * @throws {Error} When the input is invalid.
 */
export function parseScenarioInput(jsonString) {
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (cause) {
    throw new Error(`scenario: invalid JSON — ${cause.message}`, { cause });
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("scenario: input must be a JSON object");
  }

  const changes = parsed.changes;
  if (!Array.isArray(changes)) {
    throw new Error("scenario: 'changes' must be an array");
  }

  if (changes.length === 0) {
    throw new Error("scenario: 'changes' must contain at least one change");
  }

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    if (!change || typeof change !== "object") {
      throw new Error(`scenario: changes[${i}] must be an object`);
    }
    if (!SCENARIO_CHANGE_TYPES.includes(change.type)) {
      throw new Error(
        `scenario: changes[${i}].type "${change.type}" is not supported — ` +
          `supported types: ${SCENARIO_CHANGE_TYPES.join(", ")}`,
      );
    }
    if (typeof change.source !== "string" || change.source.trim() === "") {
      throw new Error(`scenario: changes[${i}].source must be a non-empty string`);
    }
    if (typeof change.target !== "string" || change.target.trim() === "") {
      throw new Error(`scenario: changes[${i}].target must be a non-empty string`);
    }
  }

  return {
    base: typeof parsed.base === "string" ? parsed.base : undefined,
    changes: changes.map((c) => ({ type: c.type, source: c.source, target: c.target })),
  };
}
