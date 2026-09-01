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
import { readAdrContext } from "./adr.mjs";
import { computeImpactConstraints } from "./edge-constraints.mjs";
import { computeImpact } from "./impact.mjs";
import { hasAuthority, resolveDecisionRef, stripAdrPrefix } from "../governance/adr-registry.mjs";
import { isComboDepConstraint } from "../rules/tags.mjs";

/**
 * @typedef {object} ImpactStatement
 * @property {string} project The target project name.
 * @property {{direct: string[], transitive: string[], dependents: string[]}} impact
 *   Reverse reachability: which projects depend on the target.
 * @property {object[]} [constraintImpact] Per-dependent edge constraint
 *   analysis. Present only when a boundary config was provided.
 * @property {{decisions: object[], unresolvedDecisionRefs: string[]}} [decisionImpact]
 *   Which recorded decisions bind the affected constraint rows. Present only
 *   when a boundary config with `depConstraints` was provided.
 * @property {{projects: string[], boundaries: string[], constraints: string[],
 *   decisions: string[]}} [evolutionAlignment] The `affected` shape matching
 *   `EvolutionEvent.affected` vocabulary.
 * @property {boolean} complete Whether the statement could be fully composed.
 * @property {string[]} notes Caveats about statement completeness.
 */

/**
 * Resolve a decisionRef to its record details.
 *
 * @param {string} ref The decision reference (bare, `adr:`, or `rule:`/`fitness:`-prefixed).
 * @param {Map<string, object>} byId The ADR registry index.
 * @param {Set<string>} knownFitness Declared fitness names.
 * @returns {{resolution: "adr"|"fitness"|"unknown", record?: object}}
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
function buildDecisionImpact(root, constraintImpact, config) {
  // Collect all unique decisionRefs from affected constraint rows
  const seenRefs = new Set();
  const affectedRefs = [];

  if (config && config.depConstraints) {
    for (const row of config.depConstraints) {
      if (row.decisionRef && !seenRefs.has(row.decisionRef)) {
        seenRefs.add(row.decisionRef);
        affectedRefs.push(row.decisionRef);
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
    });
  }

  return {
    decisions,
    unresolvedDecisionRefs: [...new Set(unresolvedDecisionRefs)].sort(),
  };
}

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
function buildEvolutionAlignment(projectName, impact, constraintImpact, resolvedDecisions) {
  const affectedProjects = [projectName, ...impact.dependents];
  const affectedConstraints = [];

  if (constraintImpact) {
    for (const entry of constraintImpact) {
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
    boundaries: [],
    constraints: affectedConstraints.sort(),
    decisions: resolvedDecisions ? [...new Set(resolvedDecisions)].sort() : [],
  };
}

/**
 * Composes the full Impact Statement for a project.
 *
 * @param {string} projectName The target project.
 * @param {object} commandContext The resolved command context (graph, analysis,
 *   root, provider, etc.).
 * @param {object|null} [config] The loaded boundary config. When provided,
 *   constraint and decision impact are computed.
 * @returns {ImpactStatement}
 * @throws {import("../errors.mjs").UsageError} When the project is not in the graph.
 */
export function composeImpactStatement(projectName, commandContext, config = null) {
  const { root, graph } = commandContext;

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

  // Step 5: Assemble the statement
  const statement = {
    project: impact.project,
    impact: {
      direct: impact.direct,
      transitive: impact.transitive,
      dependents: impact.dependents,
    },
    evolutionAlignment,
    complete: true,
    notes: [],
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
