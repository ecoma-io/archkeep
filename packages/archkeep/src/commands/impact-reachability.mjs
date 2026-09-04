/**
 * Reverse reachability over the project graph — the impact *computation*.
 *
 * Given a project name, `computeImpact` lists every project that transitively
 * depends on it — the set a developer needs to consider before changing that
 * project. It is descriptive: it never exits anything, because a description
 * of what depends on a project is never a finding.
 *
 * The result separates **direct** dependents (projects whose edges point
 * straight at the target) from **transitive** ones (reachable only through
 * another project), and the union of both is `dependents`. An empty
 * `dependents` list is a claim — "nothing depends on this project" — not a
 * shrug, and the reports built on it are worded that way so a reader never
 * mistakes it for silence.
 *
 * This is a plain module rather than part of `./impact.mjs` on purpose: the
 * canonical evaluator (`./evaluation-primitives.mjs`) needs the same
 * reachability walk the `impact` command reports, and `./impact.mjs` drives
 * `./impact-statement.mjs`, which drives that evaluator. Holding the walk in
 * `./impact.mjs` made `evaluation-primitives → impact → impact-statement →
 * evaluation-primitives` the engine's only import cycle (#644) — three
 * modules forced to load together, with no dependency order left to reason
 * about. Both sides import the walk from here instead:
 * `impact → impact-reachability`, `evaluation-primitives →
 * impact-reachability`, and the trio's remaining direction stays one-way.
 * `./impact.mjs` re-exports `computeImpact` so its existing importers keep
 * resolving.
 *
 * Like `./edge-constraints.mjs`, this is a shared computation layer: it holds
 * no argv, prints nothing, and decides no exit code (`./README.md`).
 */
import { UsageError } from "../errors.mjs";

/**
 * Computes the impact set: every project that transitively depends on
 * `projectName`.
 *
 * Builds a reverse adjacency map from the graph's `dependencies`, then walks
 * it breadth-first starting from the target project. The walk does NOT include
 * the target project itself in the dependent set — a project does not depend
 * on itself — but the returned `dependents` array is the union of `direct`
 * and `transitive`, and the report header names the target separately.
 *
 * @param {string} projectName The project whose impact is being queried.
 * @param {object} graph The project graph: `{nodes, dependencies}`.
 * @returns {{project: string, direct: string[], transitive: string[], dependents: string[]}}
 * @throws {UsageError} when `projectName` is not in the graph.
 */
export function computeImpact(projectName, graph) {
  const nodes = graph.nodes;
  const deps = graph.dependencies;

  if (!Object.hasOwn(nodes, projectName)) {
    throw new UsageError(
      `archkeep: no project named '${projectName}' in the graph — ` +
        `available projects: ${Object.keys(nodes)
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
          .join(", ")}`,
    );
  }

  // Build reverse adjacency: target → [sources that depend on it]
  const reverseAdj = Object.create(null);
  for (const source of Object.keys(deps)) {
    if (!Object.hasOwn(deps, source)) continue;
    const targets = deps[source];
    for (const edge of targets) {
      if (!Object.hasOwn(reverseAdj, edge.target)) {
        reverseAdj[edge.target] = [];
      }
      reverseAdj[edge.target].push(source);
    }
  }

  // Direct dependents: projects whose edges point straight at the target.
  // Deduplicate (multiple edges between same pair are possible) and sort.
  const directSet = new Set(reverseAdj[projectName] ?? []);
  const direct = [...directSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // BFS through reverse edges to find transitive dependents.
  const visited = new Set(directSet);
  const queue = [...directSet];
  while (queue.length > 0) {
    const current = queue.shift();
    const parents = reverseAdj[current];
    if (parents === undefined) continue;
    for (const parent of parents) {
      if (!visited.has(parent)) {
        visited.add(parent);
        queue.push(parent);
      }
    }
  }

  // Transitive dependents: reachable through another project, but not direct.
  const transitive = [...visited]
    .filter((name) => !directSet.has(name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // All dependents: direct + transitive, sorted.
  const dependents = [...visited].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return { project: projectName, direct, transitive, dependents };
}
