/**
 * Evaluation primitives shared between Impact Statement and Scenario Evaluation.
 *
 * Both the impact statement (`./impact-statement.mjs`) and scenario evaluation
 * (`./scenario-evaluation.mjs`) compose deterministic evaluation primitives
 * into a single statement about what a change touches. These are the shared
 * primitives that live in one place so two callers cannot drift.
 *
 * @module
 */
import { readAdrContext } from "./adr.mjs";
import { edgeEvolutionIdentity } from "../governance/evolution-event.mjs";
import { hasAuthority, resolveDecisionRef, stripAdrPrefix } from "../governance/adr-registry.mjs";
import { isComboDepConstraint } from "../rules/tags.mjs";
import { computeDecisionProvenance } from "../governance/provenance-graph.mjs";
import { resolveFileAttribution } from "./provenance.mjs";

import {
  buildCompleteness,
  buildEvidenceComplete,
  buildGovernanceCompleteness,
  evaluationStatus,
  EVALUATION_STATUS,
  EVALUATION_CONTRACT_TYPES,
  computeDomainCoverage,
  REQUIRED_DOMAINS,
} from "./completeness.mjs";
import { computeImpact } from "./impact.mjs";
import { computeImpactConstraints } from "./edge-constraints.mjs";
// ---------------------------------------------------------------------------
// Decision resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a decisionRef to its record details.
 *
 * @param {string} ref The decision reference (e.g. `adr:0001` or `fitness:cyclic`).
 * @param {Map<string, object>} byId ADR records by id.
 * @param {Set<string>} knownFitness Known fitness function ids.
 * @returns {{resolution: string, record?: object}}
 */
function resolveDecision(ref, byId, knownFitness) {
  const resolution = resolveDecisionRef(byId, knownFitness, ref);
  if (resolution === "adr") {
    const record = byId.get(stripAdrPrefix(ref));
    return { resolution, record };
  }
  if (resolution === "fitness") {
    // A fitness ref resolves but has no ADR record entry — it's a
    // rule/fitness id, not an ADR. We report the resolution but have
    // no record details for it.
    return { resolution };
  }
  return { resolution };
}

// ---------------------------------------------------------------------------
// Decision Impact
// ---------------------------------------------------------------------------

/**
 * Builds the decision impact section: which recorded decisions bind the
 * affected constraint rows.
 *
 * @param {string} root Workspace root path.
 * @param {object[]} constraintImpact Per-dependent constraint analysis.
 * @param {object} config The loaded boundary config (with `depConstraints`).
 * @returns {{decisions: object[], unresolvedDecisionRefs: string[]}|null}
 *   null when the ADR registry is unreadable.
 */
export function buildDecisionImpact(root, constraintImpact, config) {
  // Collect unique decisionRefs ONLY from constraint rows that are actually
  // AFFECTED by the change — rows that govern edges from impacted dependents.
  // A decisionRef in the config is not enough: the decision must be causally
  // bound to a governance entity the change touches.
  const seenRefs = new Set();
  const affectedRefs = [];

  // Build evidence map: decisionRef -> { constraintRows, dependentProjects }
  /** @type {Map<string, {constraintRows: number[], dependentProjects: string[]}>} */
  const evidenceByRef = new Map();

  if (constraintImpact && config && config.depConstraints) {
    // Use identity matching: constraintImpact.constraintRows are the actual
    // config row objects returned by findConstraintsFor — check by reference,
    // not by string label, for exact causal binding.
    for (const entry of constraintImpact) {
      const activeRows = new Set(entry.constraintRows);
      const sourceProject = entry.project;

      for (let i = 0; i < config.depConstraints.length; i++) {
        const row = config.depConstraints[i];
        if (!row.decisionRef) continue;
        if (!activeRows.has(row)) continue;

        if (!evidenceByRef.has(row.decisionRef)) {
          evidenceByRef.set(row.decisionRef, {
            constraintRows: [],
            dependentProjects: [],
          });
        }
        const evidence = evidenceByRef.get(row.decisionRef);
        if (!evidence.constraintRows.includes(i)) {
          evidence.constraintRows.push(i);
        }
        if (!evidence.dependentProjects.includes(sourceProject)) {
          evidence.dependentProjects.push(sourceProject);
        }

        if (!seenRefs.has(row.decisionRef)) {
          seenRefs.add(row.decisionRef);
          affectedRefs.push(row.decisionRef);
        }
      }
    }
  }

  if (affectedRefs.length === 0) {
    return { decisions: [], unresolvedDecisionRefs: [] };
  }

  // Try to read the ADR registry — if it fails, all refs are unresolved
  let adrContext;
  try {
    adrContext = readAdrContext(root);
  } catch {
    return {
      decisions: [],
      unresolvedDecisionRefs: [...affectedRefs],
    };
  }
  const { records, byId, knownFitness } = adrContext;
  const decisionProvenance = computeDecisionProvenance(records, (file) =>
    resolveFileAttribution(root, file),
  );
  const unresolvedDecisionRefs = [];
  const decisions = [];

  for (const ref of affectedRefs) {
    const resolved = resolveDecision(ref, byId, knownFitness);
    const evidence = evidenceByRef.get(ref);

    if (resolved.resolution === "unknown") {
      unresolvedDecisionRefs.push(ref);
      continue;
    }

    if (resolved.resolution === "fitness") {
      // Fitness refs are not ADR records — report them as resolved
      // but with no record-level details
      decisions.push({
        id: ref,
        kind: "fitness",
        resolution: "known",
        evidence,
      });
      continue;
    }
    // ADR record
    const record = resolved.record;
    const prov = decisionProvenance.get(record.id) ?? { attested: false, attribution: null };
    decisions.push({
      id: record.id,
      kind: "adr",
      status: record.status,
      hasAuthority: hasAuthority(record.status),
      supersedes: record.supersedes.length > 0 ? record.supersedes : undefined,
      supersededBy: (record.supersededBy ?? []).length > 0 ? record.supersededBy : undefined,
      provenance: {
        attested: prov.attested,
        origin: prov.attribution,
      },
      evidence,
    });
  }

  return {
    decisions: decisions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    unresolvedDecisionRefs: [...new Set(unresolvedDecisionRefs)].sort(),
  };
}
// ---------------------------------------------------------------------------
// Evaluation helpers (shared between Impact Statement and Scenario Evaluation)
// ---------------------------------------------------------------------------

/**
 * Evaluates findings impact: which findings affect the impacted projects.
 *
 * @param {string[]} affectedProjects The projects affected by the change.
 * @param {object[]|null} availableFindings Pre-computed findings, or null when
 *   not available.
 * @returns {{evaluated: boolean, findings: object[], count: number}}
 */
export function evaluateFindingsImpact(affectedProjects, availableFindings) {
  if (!availableFindings || availableFindings.length === 0) {
    return { evaluated: false, findings: [], count: 0 };
  }

  const entries = availableFindings.filter((f) =>
    affectedProjects.includes(f.project ?? f.target ?? ""),
  );

  return {
    evaluated: true,
    findings: entries,
    count: entries.length,
  };
}

/**
 * Evaluates debt impact: which debt entries affect the impacted projects.
 *
 * @param {string[]} affectedProjects The projects affected by the change.
 * @param {object[]|null} availableDebt Pre-computed debt entries, or null when
 *   not available.
 * @param {Function|null} resolveProject Optional function to resolve a debt
 *   entry's associated project.
 * @returns {{evaluated: boolean, debt: object[], count: number}}
 */
export function evaluateDebtImpact(affectedProjects, availableDebt, resolveProject = null) {
  if (!availableDebt || availableDebt.length === 0) {
    return { evaluated: false, debt: [], count: 0 };
  }

  const entries = availableDebt.filter((d) => {
    const project = resolveProject ? resolveProject(d) : (d.project ?? d.id ?? "");
    return affectedProjects.includes(project);
  });

  return {
    evaluated: true,
    debt: entries,
    count: entries.length,
  };
}

/**
 * Evaluates boundary impact: which boundary tags/layers are crossed by the
 * affected edges.
 *
 * @param {object} graph The project graph.
 * @param {object[]|null} constraintImpact Per-dependent constraint analysis.
 * @param {string} targetProject The target of the impact analysis.
 * @returns {{boundaries: object[], evaluated: boolean}}
 */
export function evaluateBoundaryImpact(graph, constraintImpact, targetProject) {
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

// ---------------------------------------------------------------------------
// Canonical Architecture Evaluation
// ---------------------------------------------------------------------------

/**
 * The provenance coverage of a decision set: the fraction of rows that
 * resolved to a known record with authority.
 *
 * An ADR row counts when its record carries decision authority
 * (`hasAuthority` — `accepted`/`active`); a fitness row counts when it
 * resolved to an id the loaded policy binds (`resolution === "known"`).
 * Refs that resolve to nothing are reported by `unresolvedDecisionRefs`
 * and never become rows; a record without authority emits a row the gate
 * fails on loudly rather than counting. One derivation, one home —
 * `deriveEvidenceGates` and the scenario face both read it, so the two
 * callers cannot disagree about what a covered decision is.
 *
 * @param {object[]|null|undefined} decisions Decision rows from
 *   `buildDecisionImpact`.
 * @returns {number} A ratio in [0, 1]; 0 when no decision binds an
 *   affected row.
 */
export function decisionProvenanceCoverage(decisions) {
  const rows = decisions ?? [];
  if (rows.length === 0) return 0;
  const covered = rows.filter((row) =>
    row.kind === "adr" ? row.hasAuthority === true : row.resolution === "known",
  ).length;
  return covered / rows.length;
}

/**
 * Derives evidence gates from evaluation outputs for the canonical evaluator.
 *
 * Each gate is computed from actual evaluation data rather than being
 * caller-supplied. Gates not applicable to canonical evaluation
 * (mutationCoverage, surfaceParity, baseIdentityValid) are set to 0/false
 * and excluded via EVALUATION_CONTRACT_TYPES.CANONICAL.
 *
 * @param {object} evaluation The full evaluation result.
 * @param {object} evaluation.completeness The completeness result.
 * @param {object} evaluation.impact The structural impact.
 * @param {object|null} evaluation.constraintImpact Constraint impact.
 * @param {object|null} evaluation.decisionImpact Decision impact.
 * @param {object} evaluation.boundaryImpact Boundary impact.
 * @param {object} evaluation.findingsImpact Findings impact.
 * @param {object} evaluation.debtImpact Debt impact.
 * @param {object} evaluation.evolutionAlignment Evolution alignment.
 * @returns {object} Evidence gate values for buildEvidenceComplete.
 */
export function deriveEvidenceGates(evaluation) {
  const { completeness, constraintImpact, decisionImpact } = evaluation;

  // domainCoverage: ratio of evaluated required domains
  /** @type {{ [domain: string]: string }} */
  const domainStatuses = {};
  for (const domain of REQUIRED_DOMAINS) {
    const dom = completeness.domains[domain];
    domainStatuses[domain] = dom ? dom.status : EVALUATION_STATUS.NOT_EVALUATED;
  }
  const dc = computeDomainCoverage(domainStatuses);
  const domainCoverage = dc.coverage;

  // claimEvidenceCoverage: structural always produces claims with evidence.
  // Constraint/decision claims exist when config is present.
  const structuralClaimEvidence = 1; // structural always produces evidence
  const constraintClaimEvidence = constraintImpact !== null ? 1 : 0;
  const decisionClaimEvidence = decisionImpact !== null ? 1 : 0;
  const totalClaims = 3; // structural + constraint + decision
  const evidencedClaims = structuralClaimEvidence + constraintClaimEvidence + decisionClaimEvidence;
  const claimEvidenceCoverage = totalClaims > 0 ? evidencedClaims / totalClaims : 0;

  // causalCoverage: constraint consequences with complete causal chains
  // When constraint impact is present, all constraint edges are traced.
  // When absent, causal coverage is 0 (no constraints to trace).
  const causalCoverage = constraintImpact !== null ? 1 : 0;

  // provenanceCoverage: the fraction of decision rows that resolved to a
  // known record with authority — derived from facts the rows carry, never
  // from a property the row builder never wrote.
  const provenanceCoverage = decisionProvenanceCoverage(decisionImpact?.decisions);

  // mutationCoverage: not applicable for canonical evaluation
  // surfaceParity: not applicable for canonical evaluation

  // hiddenGapCount: NOT_EVALUATED domains without a note
  let hiddenGapCount = 0;
  for (const [, domain] of Object.entries(completeness.domains)) {
    if (domain.status === EVALUATION_STATUS.NOT_EVALUATED && !domain.note) {
      hiddenGapCount++;
    }
  }

  // falseCompleteCount: detect when domains pass but evidence gates fail
  // This is computed by buildCompleteness from the evidenceComplete contract.

  // baseIdentityValid: not applicable for canonical evaluation

  // deterministic: canonical evaluator is deterministic by construction
  const deterministic = true;

  return {
    domainCoverage,
    claimEvidenceCoverage,
    causalCoverage,
    provenanceCoverage,
    mutationCoverage: 0,
    surfaceParity: 0,
    hiddenGapCount,
    falseCompleteCount: 0,
    baseIdentityValid: false,
    deterministic,
  };
}
/**
 * Evaluates the complete architecture state for a target project.
 *
 * This is the canonical evaluation function that composes all evaluation
 * dimensions (structural, constraint, boundary, decision, governance) into a
 * single result.
 *
 * @param {object} params
 * @param {object} params.graph The project graph.
 * @param {object|null} params.config The loaded boundary config.
 * @param {string} params.projectName The target project.
 * @param {string} [params.root] The ADR root directory path. When null (default),
 *   decision impact cannot resolve decision refs and reports them as unresolved.
 * @param {object[]|null} [params.findings] Pre-computed findings.
 * @param {object[]|null} [params.debt] Pre-computed debt entries.
 * @returns {object} The complete evaluation result with all domains and
 *   completeness.
 */
export function evaluateArchitectureState({
  graph,
  config,
  projectName,
  root = null,
  findings = null,
  debt = null,
}) {
  // Step 1: Reverse reachability
  const impact = computeImpact(projectName, graph);

  // Step 2: Edge and constraint impact
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

  // Step 3: Decision impact
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

  // Step 5: Boundary impact
  const boundaryImpact = evaluateBoundaryImpact(graph, constraintImpact, projectName);

  // Step 6: Findings and Debt impact
  const affectedProjects = [projectName, ...impact.dependents];
  const findingsImpact = evaluateFindingsImpact(affectedProjects, findings);
  const debtImpact = evaluateDebtImpact(affectedProjects, debt);

  // Step 7: Build completeness with all 8 domains (structural, constraint, boundary,
  // decision, findings, debt, governance, evidence)
  const hasConfig = config !== null;

  const structuralStatus = evaluationStatus({ evaluated: true });
  const constraintStatus = evaluationStatus({
    evaluated: hasConfig && config.depConstraints !== undefined,
    notEvaluated: !hasConfig || config.depConstraints === undefined,
  });
  const boundaryStatus = evaluationStatus({
    evaluated: hasConfig,
    notEvaluated: !hasConfig,
  });
  const decisionStatus = evaluationStatus({
    evaluated: hasConfig,
    notEvaluated: !hasConfig,
  });

  const governanceResult = buildGovernanceCompleteness({
    findingsStatus: findingsImpact.evaluated
      ? EVALUATION_STATUS.EVALUATED
      : EVALUATION_STATUS.NOT_EVALUATED,
    debtStatus: debtImpact.evaluated
      ? EVALUATION_STATUS.EVALUATED
      : EVALUATION_STATUS.NOT_EVALUATED,
    findingsCount: findingsImpact.count,
    debtCount: debtImpact.count,
  });

  // Build evidence domain: evaluated when any evaluation produced evidence
  // In the canonical evaluator, evidence is always produced (structural,
  // constraint, decision all produce traceable output). The evidence domain
  // tracks whether we can verify that claims have supporting evidence.
  const evidenceEvaluated = true; // canonical evaluator always produces evidence
  const evidenceStatus = evaluationStatus({ evaluated: evidenceEvaluated });

  const completeness = buildCompleteness({
    structural: {
      status: structuralStatus,
      evaluated: true,
      partial: false,
      notEvaluated: false,
      unsupported: false,
      refused: false,
      note: "",
    },
    constraint: {
      status: constraintStatus,
      evaluated: hasConfig && config.depConstraints !== undefined,
      partial: false,
      notEvaluated: !hasConfig || config.depConstraints === undefined,
      unsupported: false,
      refused: false,
      note: "",
    },
    boundary: {
      status: boundaryStatus,
      evaluated: hasConfig,
      partial: false,
      notEvaluated: !hasConfig,
      unsupported: false,
      refused: false,
      note: "",
    },
    decision: {
      status: decisionStatus,
      evaluated: hasConfig,
      partial: false,
      notEvaluated: !hasConfig,
      unsupported: false,
      refused: false,
      note: "",
    },
    findings: governanceResult.findings,
    debt: governanceResult.debt,
    governance: governanceResult.domain,
    evidence: {
      status: evidenceStatus,
      evaluated: evidenceEvaluated,
      partial: false,
      notEvaluated: false,
      unsupported: false,
      refused: false,
      note: "",
    },
  });

  // Derive evidence gates and build Evidence-Complete contract
  const evaluationResult = {
    completeness,
    impact,
    constraintImpact,
    decisionImpact,
    boundaryImpact,
    findingsImpact,
    debtImpact,
    evolutionAlignment,
  };
  const evidenceGates = deriveEvidenceGates(evaluationResult);
  const evidenceComplete = buildEvidenceComplete({
    ...evidenceGates,
    contractType: EVALUATION_CONTRACT_TYPES.CANONICAL,
  });

  // Rebuild completeness with evidenceComplete contract
  const completenessWithEC = buildCompleteness({
    structural: {
      status: structuralStatus,
      evaluated: true,
      partial: false,
      notEvaluated: false,
      unsupported: false,
      refused: false,
      note: "",
    },
    constraint: {
      status: constraintStatus,
      evaluated: hasConfig && config.depConstraints !== undefined,
      partial: false,
      notEvaluated: !hasConfig || config.depConstraints === undefined,
      unsupported: false,
      refused: false,
      note: "",
    },
    boundary: {
      status: boundaryStatus,
      evaluated: hasConfig,
      partial: false,
      notEvaluated: !hasConfig,
      unsupported: false,
      refused: false,
      note: "",
    },
    decision: {
      status: decisionStatus,
      evaluated: hasConfig,
      partial: false,
      notEvaluated: !hasConfig,
      unsupported: false,
      refused: false,
      note: "",
    },
    findings: governanceResult.findings,
    debt: governanceResult.debt,
    governance: governanceResult.domain,
    evidence: {
      status: evidenceStatus,
      evaluated: evidenceEvaluated,
      partial: false,
      notEvaluated: false,
      unsupported: false,
      refused: false,
      note: "",
    },
    evidenceComplete,
  });

  return {
    project: projectName,
    impact,
    constraintImpact,
    decisionImpact,
    evolutionAlignment,
    boundaryImpact,
    findingsImpact,
    debtImpact,
    completeness: completenessWithEC,
    affectedProjects,
    evidenceComplete,
  };
}

// ---------------------------------------------------------------------------
// Evolution Alignment
// ---------------------------------------------------------------------------

/**
 * Builds the evolution alignment section: the `affected` shape matching
 * `EvolutionEvent.affected` vocabulary.
 *
 * @param {string} projectName The target project.
 * @param {{direct: string[], transitive: string[], dependents: string[]}} impact
 * @param {object[]} [constraintImpact] Per-dependent constraint rows.
 * @param {string[]} [resolvedDecisions] Decision IDs that bind affected rows.
 * @returns {{projects: string[], boundaries: string[], constraints: string[],
 *   decisions: string[]}}
 */
export function buildEvolutionAlignment(projectName, impact, constraintImpact, resolvedDecisions) {
  const affectedProjects = [projectName, ...impact.dependents];
  const affectedConstraints = [];
  const affectedBoundaries = [];

  if (constraintImpact) {
    for (const entry of constraintImpact) {
      // Collect edge identities for each affected boundary
      for (const edge of entry.edges) {
        // The canonical spelling — imported, not restated, so this surface
        // cannot drift from `EvolutionEvent.affected`'s vocabulary.
        const edgeId = edgeEvolutionIdentity({
          source: entry.project,
          target: edge.target,
          type: edge.type,
        });
        if (!affectedBoundaries.includes(edgeId)) {
          affectedBoundaries.push(edgeId);
        }
      }
      // Collect constraint row labels
      for (const row of entry.constraintRows) {
        const label = isComboDepConstraint(row)
          ? `allSourceTags:${row.allSourceTags.join(",")}`
          : `sourceTag:${row.sourceTag}`;
        if (!affectedConstraints.includes(label)) {
          affectedConstraints.push(label);
        }
      }
    }
  }

  return {
    projects: [...new Set(affectedProjects)].sort(),
    boundaries: affectedBoundaries.sort(),
    constraints: affectedConstraints.sort(),
    decisions: resolvedDecisions ? [...new Set(resolvedDecisions)].sort() : [],
  };
}
