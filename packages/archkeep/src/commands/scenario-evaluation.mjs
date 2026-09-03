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
import { buildDecisionImpact, buildEvolutionAlignment } from "./evaluation-primitives.mjs";
import { resolveProvenance } from "./provenance.mjs";
import {
  buildGovernanceCompleteness,
  buildScenarioCompleteness,
  buildEvidenceComplete,
  createDomain,
  EVALUATED,
  NOT_EVALUATED,
  evaluationStatus,
  EVALUATION_CONTRACT_TYPES,
} from "./completeness.mjs";

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
 * @property {string} [edgeType] The dependency edge type (required for
 *   dependency_added; used for disambiguation in dependency_removed when
 *   multiple edges exist between the same source+target with different types).
 */

/**
 * @typedef {object} ScenarioInput
 * @property {string} [base] Optional git revision for attribution. When not
 *   provided, resolved from `git rev-parse HEAD`.
 * @property {DependencyChange[]} changes The hypothetical changes to evaluate.
 */

// ---------------------------------------------------------------------------
/**
 * @typedef {object} ScenarioEvaluation
 * @property {boolean} virtual Always true — a scenario is never authoritative.
 * @property {boolean} notAuthoritative Always true — mirrors `virtual`.
 * @property {string} project The target project being evaluated.
 * @property {object} base The base graph information.
 * @property {string} base.revision The git revision or snapshot identity.
 * @property {string} base.identity One of: "verified", "unverified", "mismatch", "unattributed".
 * @property {boolean} base.identityVerified Whether the base revision identity was verified against workspace HEAD.
 * @property {boolean} base.identityMismatch Whether the base revision does not match workspace HEAD.
 * @property {string} base.provenance How the base was determined.
 * @property {string[]} changes The change descriptions that were applied.
 * @property {string[]|undefined} refused Changes that could not be applied, if any.
 * @property {object} current The current impact for the target project.
 * @property {object} scenario The would-be impact after applying the changes.
 * @property {object} delta What would change.
 * @property {string[]} delta.dependentsAdded Dependents added in the scenario (flat access).
 * @property {string[]} delta.dependentsRemoved Dependents removed in the scenario (flat access).
 * @property {{status: string}} delta.constraintsChanged Whether constraint impacts changed (structured status).
 * @property {{status: string}} delta.decisionsChanged Whether decisions changed (structured status).
 * @property {object} delta.structuralDelta Structured delta for dependency changes.
 * @property {object} delta.governanceDelta Governance-level delta.
 * @property {{status: string}} delta.governanceDelta.findingsChanged Status: "changed" | "unchanged" | "not_evaluated".
 * @property {{status: string}} delta.governanceDelta.debtChanged Status: "changed" | "unchanged" | "not_evaluated".
 * @property {object} delta.evidenceDelta Evidence-level delta metadata.
 * @property {string} delta.evidenceDelta.baseRevision The revision used as base.
 * @property {number} delta.evidenceDelta.changesApplied Number of changes applied.
 * @property {number} delta.evidenceDelta.changesRefused Number of changes refused.
 * @property {object} [evidenceChain] The provenance chain: base → changes → re-evaluated → delta.
 * @property {string} evidenceChain.baseRevision The revision the scenario started from.
 * @property {string[]} evidenceChain.appliedChanges The changes applied to the base.
 * @property {string} evidenceChain.currentState The state before applying changes ("current").
 * @property {string} evidenceChain.scenarioState The state after applying changes ("scenario").
 * @property {object} evidenceChain.delta The computed differences.
 * @property {object} [governanceImpact] Governance re-evaluation results.
 * @property {boolean} governanceImpact.findingsFiltered Whether precomputed findings were filtered into the scenario state.
 * @property {boolean} governanceImpact.debtFiltered Whether precomputed debt was filtered into the scenario state.
 * @property {boolean} governanceImpact.governanceComplete Whether all governance data was provided.
 * @property {number} governanceImpact.scenarioFindingsCount Number of findings in the scenario state.
 * @property {number} governanceImpact.scenarioDebtCount Number of debt entries in the scenario state.
 * @property {string} governanceImpact.findingsStatus EVALUATION_STATUS for findings.
 * @property {string} governanceImpact.debtStatus EVALUATION_STATUS for debt.
 * @property {object} completeness Structured completeness from buildScenarioCompleteness.
 * @property {boolean} complete Backward-compat shorthand: whether all changes were applied (mutationCoverageComplete).
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
  const nodes = structuredClone(graph.nodes);
  const dependencies = structuredClone(graph.dependencies);
  return { nodes, dependencies };
}

/**
 * Applies a scenario's changes to a graph, producing a would-be graph.
 *
 * Each change must identify the edge type explicitly. For dependency_added,
 * the type field is required. For dependency_removed, identity is resolved
 * by source + target + type. If type is not provided and multiple edges
 * exist between the same source+target, the mutation is refused as ambiguous.
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

      // The edge type must be explicit — do not silently invent "static"
      if (!change.edgeType || typeof change.edgeType !== "string") {
        refused.push(
          `cannot add dependency: edge type is required for ${change.source} → ${change.target}`,
        );
        continue;
      }

      // Check if edge already exists (source+target+type identity)
      const existing = cloned.dependencies[change.source] ?? [];
      if (existing.some((e) => e.target === change.target && e.type === change.edgeType)) {
        applied.push(
          `dependency already exists: ${change.source} → ${change.target} (${change.edgeType})`,
        );
        continue;
      }

      // Add the edge with explicit type
      if (!cloned.dependencies[change.source]) {
        cloned.dependencies[change.source] = [];
      }
      cloned.dependencies[change.source].push({
        target: change.target,
        type: change.edgeType,
        source: change.source,
      });
      applied.push(`added dependency: ${change.source} → ${change.target} (${change.edgeType})`);
    }

    if (change.type === "dependency_removed") {
      const existing = cloned.dependencies[change.source] ?? [];

      // Use canonical edge identity: source + target + type
      const matching = existing.filter((e) => {
        if (e.target !== change.target) return false;
        if (change.edgeType && e.type !== change.edgeType) return false;
        return true;
      });

      if (matching.length === 0) {
        const typeInfo = change.edgeType ? ` (${change.edgeType})` : "";
        refused.push(
          `cannot remove dependency: no edge from "${change.source}" to "${change.target}"${typeInfo}`,
        );
        continue;
      }

      if (matching.length > 1) {
        // Ambiguous: multiple edges with same source+target but different types,
        // and no type was specified to disambiguate
        const types = matching.map((e) => e.type).join(", ");
        refused.push(
          `ambiguous removal: multiple edges from "${change.source}" to "${change.target}" ` +
            `(${types}). Specify edgeType to disambiguate.`,
        );
        continue;
      }
      // Remove the single matching edge by identity (matching was already computed)
      const idx = existing.indexOf(matching[0]);
      existing.splice(idx, 1);
      const typeLabel = change.edgeType ? ` (${change.edgeType})` : "";
      applied.push(`removed dependency: ${change.source} → ${change.target}${typeLabel}`);
    }
  }
  // Clean up empty dependency arrays
  for (const [source, edges] of Object.entries(cloned.dependencies)) {
    if (edges.length === 0) {
      delete cloned.dependencies[source];
    }
  }

  return { graph: cloned, applied, refused };
}

/**
 * Computes the delta between current and scenario.
 *
 * All boolean delta fields are replaced with structured status objects
 * to avoid boolean information loss. Each status is one of:
 * - "changed": the value differs between current and scenario
 * - "unchanged": the value is identical
 * - "not_evaluated": the comparison could not be performed
 *
 * @param {object} current Current impact.
 * @param {object} scenario Scenario impact.
 * @param {object} [extra] Additional context for structured delta sections.
 * @param {string} [extra.baseRevision] The base revision used.
 * @param {number} [extra.changesApplied] Number of changes applied.
 * @param {number} [extra.changesRefused] Number of changes refused.
 * @param {string} [extra.findingsChanged] Status: "changed" | "unchanged" | "not_evaluated".
 * @param {string} [extra.debtChanged] Status: "changed" | "unchanged" | "not_evaluated".
 * @returns {{dependentsAdded: string[], dependentsRemoved: string[],
 *   constraintsChanged: {status: string}, decisionsChanged: {status: string},
 *   structuralDelta: {dependentsAdded: string[], dependentsRemoved: string[]},
 *   governanceDelta: {findingsChanged: {status: string}, debtChanged: {status: string}},
 *   evidenceDelta: {baseRevision: string, changesApplied: number, changesRefused: number}}}
 */
function computeDelta(current, scenario, extra = {}) {
  const currentDeps = new Set(current.impact.dependents ?? []);
  const scenarioDeps = new Set(scenario.impact.dependents ?? []);

  const dependentsAdded = [...scenarioDeps].filter((d) => !currentDeps.has(d)).sort();
  const dependentsRemoved = [...currentDeps].filter((d) => !scenarioDeps.has(d)).sort();

  const constraintsChanged = {
    status:
      JSON.stringify(current.constraintImpact ?? []) !==
      JSON.stringify(scenario.constraintImpact ?? [])
        ? "changed"
        : "unchanged",
  };

  const decisionsChanged = {
    status:
      JSON.stringify(current.decisionImpact ?? []) !== JSON.stringify(scenario.decisionImpact ?? [])
        ? "changed"
        : "unchanged",
  };

  // Use structured status for governance changes
  const findingsStatus = extra.findingsChanged ?? "not_evaluated";
  const debtStatus = extra.debtChanged ?? "not_evaluated";

  return {
    dependentsAdded,
    dependentsRemoved,
    constraintsChanged,
    decisionsChanged,
    structuralDelta: {
      dependentsAdded,
      dependentsRemoved,
    },
    governanceDelta: {
      findingsChanged: { status: findingsStatus },
      debtChanged: { status: debtStatus },
    },
    evidenceDelta: {
      baseRevision: extra.baseRevision ?? "(unknown)",
      changesApplied: extra.changesApplied ?? 0,
      changesRefused: extra.changesRefused ?? 0,
    },
  };
}

/**
 * Resolves the base revision for a scenario, with explicit identity verification.
 *
 * The following identity states are represented:
 * - verified: the base revision matches the verified workspace HEAD
 * - unverified: the base revision could not be verified against workspace state
 * - mismatch: the base revision differs from the verified workspace HEAD
 * - unattributed: no git revision could be resolved
 *
 * @param {string} root The workspace root.
 * @param {string} [userBase] Optional user-provided base revision.
 * @returns {{revision: string, identity: string, provenance: string,
 *   identityVerified: boolean, identityMismatch: boolean}}
 */
function resolveBaseRevision(root, userBase) {
  let workspaceHead = null;
  let isDirty = false;
  try {
    const provenance = resolveProvenance(root);
    if (provenance && provenance.commit && provenance.commit.length > 0) {
      workspaceHead = provenance.commit;
      isDirty = !!provenance.dirty;
    }
  } catch {
    // Provenance unavailable — will use "(unknown)" below
  }

  if (typeof userBase === "string" && userBase.length > 0) {
    // User-provided base — verify against workspace HEAD
    if (workspaceHead) {
      if (isDirty) {
        // Dirty tree: cannot verify relationship
        return {
          revision: userBase,
          identity: "unverified",
          identityVerified: false,
          identityMismatch: false,
          provenance: `user-provided (HEAD is ${workspaceHead}, dirty — identity unverifiable)`,
        };
      }
      if (userBase === workspaceHead) {
        return {
          revision: userBase,
          identity: "verified",
          identityVerified: true,
          identityMismatch: false,
          provenance: `user-provided (matches HEAD ${workspaceHead})`,
        };
      }
      // User-provided base does not match HEAD
      return {
        revision: userBase,
        identity: "mismatch",
        identityVerified: false,
        identityMismatch: true,
        provenance: `user-provided (HEAD is ${workspaceHead}, requested ${userBase})`,
      };
    }

    // No workspace HEAD to verify against
    return {
      revision: userBase,
      identity: "unverified",
      identityVerified: false,
      identityMismatch: false,
      provenance: "user-provided (could not verify — no git HEAD available)",
    };
  }

  // Auto-resolve from git
  if (workspaceHead) {
    const suffix = isDirty ? " (dirty)" : "";
    return {
      revision: workspaceHead,
      identity: isDirty ? "unverified" : "verified",
      identityVerified: !isDirty,
      identityMismatch: false,
      provenance: `auto-resolved: git commit ${workspaceHead}${suffix}`,
    };
  }

  return {
    revision: "(unattributed workspace)",
    identity: "unattributed",
    identityVerified: false,
    identityMismatch: false,
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
  const delta = computeDelta(currentState, scenarioState, {
    baseRevision: base.revision,
    changesApplied: applied.length,
    changesRefused: refused.length,
    // Governance was NOT re-evaluated — filtering is not evaluation
    findingsChanged: "not_evaluated",
    debtChanged: "not_evaluated",
  });
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
      structuralDelta: delta.structuralDelta,
      governanceDelta: delta.governanceDelta,
      evidenceDelta: delta.evidenceDelta,
    },
  };

  // Step 9: Evaluate governance impact on scenario (hypothetical re-evaluation)
  const scenarioAffectedProjects = [projectName, ...scenarioImpact.dependents];
  let scenarioFindings = null;
  let scenarioDebt = null;
  if (availableFindings) {
    // Build set of edges that were removed in this scenario
    const removedEdges = new Set();
    for (const change of scenarioInput.changes) {
      if (change.type === "dependency_removed") {
        removedEdges.add(`${change.source}|${change.target}`);
      }
    }

    // Re-filter findings for the hypothetical graph's affected projects,
    // excluding findings whose edge was removed
    const affectedSet = new Set(scenarioAffectedProjects);
    scenarioFindings = availableFindings.filter((f) => {
      // Check if this finding's edge was removed
      const source = f.source ?? f.project ?? "";
      const target = f.target ?? "";
      if (removedEdges.has(`${source}|${target}`)) {
        return false; // edge no longer exists in hypothetical graph
      }
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
  // Step 11: Assemble — determine provenance and completeness semantics
  //
  // Governance filtering (re-applying precomputed findings/debt to the
  // hypothetical graph) is NOT governance re-evaluation. True re-evaluation
  // would run the full check pipeline against the hypothetical graph.
  // When we only filter, governance is NOT_EVALUATED.
  const findingsFiltered = availableFindings !== null;
  const debtFiltered = availableDebt !== null;

  // Filtering is NOT re-evaluation (the header above), so the status is
  // NOT_EVALUATED on both paths — no re-evaluation pipeline exists to pass.
  // Telling a consumer "evaluated" for a filter is the mislabel this refuses.
  const findingsStatus = evaluationStatus({
    evaluated: false,
    notEvaluated: true,
  });
  const debtStatus = evaluationStatus({
    evaluated: false,
    notEvaluated: true,
  });

  // Build governance completeness
  const governanceCompleteness = buildGovernanceCompleteness({
    findingsStatus,
    debtStatus,
    findingsCount: scenarioFindings?.length ?? 0,
    debtCount: scenarioDebt?.length ?? 0,
  });

  // Determine mutation coverage completeness
  const totalChanges = scenarioInput.changes.length;
  const appliedCount = applied.length;
  const refusedCount = refused.length;
  const mutationCoverageComplete = totalChanges === appliedCount && refusedCount === 0;

  // Derive evidence gates for scenario evaluation and build Evidence-Complete contract.
  // Scenario mutation is deterministic: same inputs → same outputs (pure graph clone + apply).
  // surfaceParity: the scenario applied all requested changes (refused===0), so the
  // hypothetical surface is internally consistent — no surface drift from the plan.
  const surfaceParity = refusedCount === 0 ? 1 : 0;

  const evidenceComplete = buildEvidenceComplete({
    domainCoverage: currentDecisionImpact !== null ? 1 : 0,
    claimEvidenceCoverage: config !== null ? 1 : 0,
    causalCoverage: currentConstraintImpact !== null ? 1 : 0,
    provenanceCoverage: (currentDecisionImpact?.decisions ?? []).length > 0 ? 1 : 0,
    mutationCoverage: mutationCoverageComplete ? 1 : 0,
    surfaceParity,
    hiddenGapCount: 0,
    falseCompleteCount: 0,
    baseIdentityValid: base.identityVerified,
    deterministic: true,
    contractType: EVALUATION_CONTRACT_TYPES.SCENARIO,
  });

  // Derive base domain statuses from what the scenario actually evaluated.
  // structural is always evaluated (scenario builds a complete graph).
  // constraint, boundary, decision require config.
  // findings, debt require their respective inputs.
  // evidence is always evaluated (we build the EC contract).
  const hasConfig = config !== null;
  const scenarioDomains = {
    structural: createDomain(EVALUATED),
    constraint: createDomain(hasConfig ? EVALUATED : NOT_EVALUATED),
    boundary: createDomain(hasConfig ? EVALUATED : NOT_EVALUATED),
    decision: createDomain(
      hasConfig && (config?.decisionRefs?.length ?? 0) > 0 ? EVALUATED : NOT_EVALUATED,
    ),
    findings:
      governanceCompleteness.findings.status === NOT_EVALUATED
        ? createDomain(NOT_EVALUATED, "Findings not re-evaluated in scenario")
        : governanceCompleteness.findings,
    debt:
      governanceCompleteness.debt.status === NOT_EVALUATED
        ? createDomain(NOT_EVALUATED, "Debt not re-evaluated in scenario")
        : governanceCompleteness.debt,
    evidence: createDomain(EVALUATED),
  };
  const scenarioCompleteness = buildScenarioCompleteness({
    changesComplete: mutationCoverageComplete,
    baseIdentityVerified: base.identityVerified,
    mutationCoverageComplete,
    governance: governanceCompleteness,
    evidenceComplete,
    domains: scenarioDomains,
  });

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
      findingsFiltered,
      debtFiltered,
      governanceComplete: false,
      scenarioFindingsCount: scenarioFindings?.length ?? 0,
      scenarioDebtCount: scenarioDebt?.length ?? 0,
      findingsStatus,
      debtStatus,
    },
    delta,
    completeness: scenarioCompleteness,
    complete: scenarioCompleteness.overallComplete,
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
    changes: changes.map((c) => {
      const change = { type: c.type, source: c.source, target: c.target };
      if (c.edgeType && typeof c.edgeType === "string") {
        change.edgeType = c.edgeType;
      }
      return change;
    }),
  };
}
