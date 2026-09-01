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
 * - Reuses existing primitives: `computeImpact`, `computeImpactConstraints`.
 * - Every consequence is labelled `virtual: true` / `notAuthoritative`.
 * - States its own limits: any unevaluated consequence is named.
 *
 * @module
 */
import { computeImpact } from "./impact.mjs";
import { computeImpactConstraints } from "./edge-constraints.mjs";
import { readAdrContext } from "./adr.mjs";
import { hasAuthority, resolveDecisionRef, stripAdrPrefix } from "../governance/adr-registry.mjs";

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
 * @property {string} [base] Optional git revision for attribution.
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
 * @property {string[]} changes The change descriptions that were applied.
 * @property {string[]|undefined} refused Changes that could not be applied, if any.
 * @property {object} current The current impact for the target project.
 * @property {object} scenario The would-be impact after applying the changes.
 * @property {object} delta What would change.
 * @property {boolean} complete Whether the evaluation could be completed.
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

// ---------------------------------------------------------------------------
// Decision impact (reuses impact-statement's buildDecisionImpact)
// ---------------------------------------------------------------------------

/**
 * Builds decision impact for the scenario's would-be state.
 *
 * @param {string} root Workspace root path.
 * @param {object[]} constraintImpact Per-dependent constraint analysis.
 * @param {object} config The loaded boundary config.
 * @returns {{decisions: object[], unresolvedDecisionRefs: string[]}|null}
 */
function buildScenarioDecisionImpact(root, constraintImpact, config) {
  if (!constraintImpact || !config?.depConstraints) {
    return { decisions: [], unresolvedDecisionRefs: [] };
  }

  const seenRefs = new Set();
  const affectedRefs = [];

  for (const row of config.depConstraints) {
    if (row.decisionRef && !seenRefs.has(row.decisionRef)) {
      seenRefs.add(row.decisionRef);
      affectedRefs.push(row.decisionRef);
    }
  }

  if (affectedRefs.length === 0) {
    return { decisions: [], unresolvedDecisionRefs: [] };
  }

  let adrContext;
  try {
    adrContext = readAdrContext(root);
  } catch {
    return { decisions: [], unresolvedDecisionRefs: [...affectedRefs] };
  }

  const { byId, knownFitness } = adrContext;
  const unresolvedDecisionRefs = [];
  const decisions = [];

  for (const ref of affectedRefs) {
    const resolution = resolveDecisionRef(byId, knownFitness, ref);
    if (resolution === "unknown") {
      unresolvedDecisionRefs.push(ref);
      continue;
    }
    if (resolution === "fitness") {
      decisions.push({ id: ref, kind: "fitness", resolution: "known" });
      continue;
    }
    const record = byId.get(stripAdrPrefix(ref));
    decisions.push({
      id: record.id,
      kind: "adr",
      status: record.status,
      hasAuthority: hasAuthority(record.status),
    });
  }

  return {
    decisions,
    unresolvedDecisionRefs: [...new Set(unresolvedDecisionRefs)].sort(),
  };
}

/**
 * Builds evolution alignment for the scenario.
 *
 * @param {string} projectName The target project.
 * @param {{direct: string[], transitive: string[], dependents: string[]}} impact
 * @param {object[]} [constraintImpact]
 * @param {string[]} [resolvedDecisions]
 * @returns {{projects: string[], boundaries: string[], constraints: string[], decisions: string[]}}
 */
function buildScenarioEvolutionAlignment(projectName, impact, constraintImpact, resolvedDecisions) {
  const affectedProjects = [projectName, ...impact.dependents];
  const affectedConstraints = [];

  if (constraintImpact) {
    for (const entry of constraintImpact) {
      for (const row of entry.constraintRows) {
        const label = row.sourceTag
          ? `sourceTag:${row.sourceTag}`
          : `allSourceTags:${(row.allSourceTags ?? []).join(",")}`;
        if (!affectedConstraints.includes(label)) {
          affectedConstraints.push(label);
        }
      }
    }
  }

  return {
    projects: [...new Set(affectedProjects)].sort(),
    boundaries: [],
    constraints: affectedConstraints.sort(),
    decisions: resolvedDecisions ? [...new Set(resolvedDecisions)].sort() : [],
  };
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
 * Evaluates a scenario against the current workspace.
 *
 * @param {string} projectName The target project.
 * @param {object} commandContext The resolved command context.
 * @param {ScenarioInput} scenarioInput The scenario description.
 * @param {object|null} [config] The loaded boundary config.
 * @returns {ScenarioEvaluation}
 */
export function evaluateScenario(projectName, commandContext, scenarioInput, config = null) {
  const { root, graph } = commandContext;

  // Step 1: Compute current impact
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

  // Step 2: Apply scenario changes to the graph
  const { graph: scenarioGraph, applied, refused } = applyChanges(graph, scenarioInput.changes);

  // Step 3: Compute scenario impact
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

  // Step 4: Build decision impact for both sides
  const currentDecisionImpact = buildScenarioDecisionImpact(root, currentConstraintImpact, config);
  const scenarioDecisionImpact = buildScenarioDecisionImpact(
    root,
    scenarioConstraintImpact,
    config,
  );

  // Step 5: Build evolution alignment for both sides
  const currentResolved = currentDecisionImpact
    ? currentDecisionImpact.decisions.map((d) => d.id)
    : [];
  const scenarioResolved = scenarioDecisionImpact
    ? scenarioDecisionImpact.decisions.map((d) => d.id)
    : [];

  const currentEvolution = buildScenarioEvolutionAlignment(
    projectName,
    currentImpact,
    currentConstraintImpact,
    currentResolved,
  );
  const scenarioEvolution = buildScenarioEvolutionAlignment(
    projectName,
    scenarioImpact,
    scenarioConstraintImpact,
    scenarioResolved,
  );

  // Step 6: Compute delta
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

  // Step 7: Build notes
  const notes = [
    "virtual evaluation — not authoritative",
    "this scenario has not been committed; run `check` for the real verdict",
  ];
  if (refused.length > 0) {
    notes.push(`changes that could not be applied: ${refused.join("; ")}`);
  }

  // Step 8: Assemble
  return {
    virtual: true,
    notAuthoritative: true,
    project: projectName,
    base: {
      revision: scenarioInput.base ?? "(current workspace)",
      attributed: true,
    },
    changes: applied,
    refused: refused.length > 0 ? refused : undefined,
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
    },
    delta,
    complete: true,
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
