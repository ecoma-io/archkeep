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
import { hasAuthority, resolveDecisionRef, stripAdrPrefix } from "../governance/adr-registry.mjs";
import { isComboDepConstraint } from "../rules/tags.mjs";

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

  const { byId, knownFitness } = adrContext;
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
    decisions.push({
      id: record.id,
      kind: "adr",
      status: record.status,
      hasAuthority: hasAuthority(record.status),
      supersedes: record.supersedes.length > 0 ? record.supersedes : undefined,
      supersededBy: (record.supersededBy ?? []).length > 0 ? record.supersededBy : undefined,
      evidence,
    });
  }

  return {
    decisions: decisions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    unresolvedDecisionRefs: [...new Set(unresolvedDecisionRefs)].sort(),
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
        const edgeId = `${entry.project}>${edge.target}:${edge.type}`;
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
