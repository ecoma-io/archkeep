/**
 * Edge-constraint analysis: which boundary-rule violations an edge introduces
 * or removes, and which constraint rows govern a given edge.
 *
 * This is the bridge between the structural commands (`diff`, `impact`) and the
 * boundary rules. Both commands operate on graph edges — not on import sites —
 * so they cannot call `evaluate` directly. Instead, this module provides a
 * narrower function that judges a single edge against the `depConstraints`
 * table, which is the part of the boundary rules that depends only on project
 * tags (not on npm imports, circular dependencies, lazy loading, etc.).
 *
 * ## What it checks and what it does not
 *
 * It checks the three `depConstraints` verdicts:
 * - `onlyDependOnLibsWithTags` — the target must carry at least one listed tag
 * - `notDependOnLibsWithTags` — no project reachable from the target may carry
 *   a listed tag (transitive)
 * - `projectWithoutTagsCannotHaveDependencies` — a source project whose tags
 *   match no constraint row
 *
 * It does NOT check npm/external imports, circular dependencies, lazy-loading,
 * or the `allow` list. Those checks depend on import-site details (specifier
 * text, import kind, file path) that graph edges do not carry. A consumer who
 * needs the full verdict should run `check`.
 *
 * ## Why this lives here and not in `src/rules/`
 *
 * `src/rules/` judges import sites; this module judges graph edges. They share
 * the tag-matching functions (`findConstraintsFor`, `onlyTagsViolation`,
 * `notTagsViolation`, `emptyOnlyTagsViolation`) but the input is different
 * enough that merging them would blur the layer boundary the CLAUDE.md guards.
 */

import { buildReachability } from "../rules/reachability.mjs";
import {
  emptyOnlyTagsViolation,
  findConstraintsFor,
  notTagsViolation,
  onlyTagsViolation,
} from "../rules/tags.mjs";

/**
 * Judges a single edge against the `depConstraints` table.
 *
 * Returns an array of violations (zero or more), each carrying the constraint
 * row that fired. An empty array means the edge is allowed by the constraint
 * table — it does NOT mean the edge is free of all boundary violations (see
 * this module's header for what is not checked).
 *
 * @param {{source: string, target: string}} edge The graph edge to judge.
 * @param {object} nodes The project graph's `nodes` map (carries `data.tags`).
 * @param {object} dependencies The project graph's `dependencies` map (for `notDependOnLibsWithTags` reachability).
 * @param {object[]} depConstraints The constraint table from the boundary config.
 * @returns {{messageId: string, constraint: object, source: string, target: string}[]}
 */
export function judgeEdge(edge, nodes, dependencies, depConstraints) {
  const sourceNode = nodes[edge.source];
  const targetNode = nodes[edge.target];

  // If either project is not in the graph (external node, or removed), this
  // edge cannot be judged against tag constraints — it is outside the
  // depConstraints domain.
  if (!sourceNode || !targetNode) return [];

  const matchedConstraints = findConstraintsFor(depConstraints, sourceNode);

  // No matching constraint row → `projectWithoutTagsCannotHaveDependencies`.
  // This is the same semantics `findConstraintsFor` documents: an empty list
  // is an error, not a pass.
  if (matchedConstraints.length === 0) {
    return [
      {
        messageId: "projectWithoutTagsCannotHaveDependencies",
        constraint: null,
        source: edge.source,
        target: edge.target,
      },
    ];
  }

  const violations = [];

  for (const constraint of matchedConstraints) {
    const onlyTags = onlyTagsViolation(constraint, targetNode);
    if (onlyTags) {
      violations.push({
        messageId: onlyTags.messageId,
        constraint,
        source: edge.source,
        target: edge.target,
      });
      continue;
    }

    const emptyOnly = emptyOnlyTagsViolation(constraint, targetNode);
    if (emptyOnly) {
      violations.push({
        messageId: emptyOnly.messageId,
        constraint,
        source: edge.source,
        target: edge.target,
      });
      continue;
    }

    // `notDependOnLibsWithTags` is transitive — it needs reachability.
    if (constraint.notDependOnLibsWithTags?.length > 0) {
      const reach = buildReachability({ nodes, dependencies });
      const notTags = notTagsViolation(constraint, targetNode, { nodes }, reach);
      if (notTags) {
        violations.push({
          messageId: notTags.messageId,
          constraint,
          source: edge.source,
          target: edge.target,
        });
      }
    }
  }

  return violations;
}

/**
 * Computes the rule-impact of a diff: which boundary violations the added
 * edges introduce and which the removed edges resolve.
 *
 * For each added edge, judges it against the head graph's tags and the
 * constraint table. For each removed edge, judges it against the baseline
 * graph's tags (reconstructed from the baseline's project list) and the same
 * constraint table. The constraint table is the current one — it is what `check`
 * would judge from today, not what some past version judged from.
 *
 * @param {{addedEdges: object[], removedEdges: object[]}} diff From `computeDiff`.
 * @param {object} headNodes The head graph's `nodes` map (for tag lookups).
 * @param {object} headDependencies The head graph's `dependencies` map (for reachability).
 * @param {object[]} baselineProjects The baseline snapshot's project list (each
 *   carries `tags`).
 * @param {object[]} baselineDependencies The baseline snapshot's flat edge list.
 * @param {object[]} depConstraints The constraint table from the boundary config.
 * @returns {{introduced: object[], resolved: object[]}}
 */
export function computeRuleImpact(
  diff,
  headNodes,
  headDependencies,
  baselineProjects,
  baselineDependencies,
  depConstraints,
) {
  // Build a node-map shape from the baseline's project list so `findConstraintsFor`
  // can read tags from it the same way it reads from the live graph.
  const baselineNodes = Object.create(null);
  for (const project of baselineProjects) {
    baselineNodes[project.name] = {
      name: project.name,
      data: { root: project.root, tags: project.tags ?? [] },
    };
  }

  // Build a source-keyed dependency map from the baseline's flat edge list for
  // reachability analysis in `notDependOnLibsWithTags` checks.
  const baselineDepsMap = Object.create(null);
  for (const edge of baselineDependencies) {
    if (!baselineDepsMap[edge.source]) baselineDepsMap[edge.source] = [];
    baselineDepsMap[edge.source].push({ target: edge.target, type: edge.type });
  }

  const introduced = [];
  for (const edge of diff.addedEdges) {
    const violations = judgeEdge(edge, headNodes, headDependencies, depConstraints);
    for (const v of violations) {
      introduced.push(v);
    }
  }

  const resolved = [];
  for (const edge of diff.removedEdges) {
    const violations = judgeEdge(edge, baselineNodes, baselineDepsMap, depConstraints);
    for (const v of violations) {
      resolved.push(v);
    }
  }

  return { introduced, resolved };
}

/**
 * Computes the constraint context for each dependent in an impact set.
 *
 * For each project that depends on the target, this identifies which constraint
 * rows govern that edge and whether the edge currently passes or violates. The
 * result carries enough detail for a report to name the constraint, state the
 * verdict, and (for violations) show what the constraint requires.
 *
 * @param {string} targetProject The project whose dependents are being analysed.
 * @param {string[]} dependents The impact set (direct + transitive).
 * @param {object} nodes The project graph's `nodes` map.
 * @param {object} dependencies The project graph's `dependencies` map.
 * @param {object[]} depConstraints The constraint table from the boundary config.
 * @returns {{project: string, edges: {target: string, type: string}[], constraintRows: object[], violations: object[]}[]}
 */
export function computeImpactConstraints(
  targetProject,
  dependents,
  nodes,
  dependencies,
  depConstraints,
) {
  const results = [];

  for (const dependent of dependents) {
    // Find all edges from this dependent to the target.
    const deps = dependencies[dependent] ?? [];
    const edgesToTarget = deps.filter((e) => e.target === targetProject);

    const sourceNode = nodes[dependent];
    const constraintRows = sourceNode ? findConstraintsFor(depConstraints, sourceNode) : [];

    const violations = [];
    for (const edge of edgesToTarget) {
      // The dependencies map is keyed by source — the edge object carries only
      // `target` and `type`, so `source` must be added before `judgeEdge` can
      // look up the source project's tags.
      const edgeWithSource = { source: dependent, target: edge.target, type: edge.type };
      const edgeViolations = judgeEdge(edgeWithSource, nodes, dependencies, depConstraints);
      for (const v of edgeViolations) {
        violations.push(v);
      }
    }

    results.push({
      project: dependent,
      edges: edgesToTarget.map((e) => ({ target: e.target, type: e.type })),
      constraintRows,
      violations,
    });
  }

  return results;
}
