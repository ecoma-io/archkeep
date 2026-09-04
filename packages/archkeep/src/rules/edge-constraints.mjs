/**
 * Edge-constraint analysis: which boundary-rule violations an edge introduces
 * or removes, and which constraint rows govern a given edge.
 *
 * The rules layer's counterpart to `./index.mjs`'s import-site judgment:
 * `evaluate` judges import sites, and the structural commands (`diff`,
 * `impact`) operate on graph edges — not on import sites — so they cannot call
 * `evaluate` directly. Instead, this module provides a narrower function that
 * judges a single edge against the `depConstraints` table, which is the part
 * of the boundary rules that depends only on project tags (not on npm imports,
 * circular dependencies, lazy loading, etc.).
 *
 * `check` is a third caller, through `declaredEdgeViolationsForCheck` below —
 * not for every edge, only the ones `evaluate()` structurally cannot reach: an
 * `implicit`-typed edge (Nx's/`archkeep.json`'s `implicitDependencies`) has no
 * import site behind it at all, so it never becomes an `importSites` record for
 * `evaluate()` to iterate. Without this, `check` could report a clean tree
 * while `context`/`impact` showed the exact same edge as a tag violation — the
 * "empty result is a claim, not a shrug" invariant (`../../../AGENTS.md`)
 * broken by omission rather than by a wrong answer. The language server rides
 * the same function (`../lsp/diagnose.mjs`), so an editor paints the same
 * declared-edge verdict `check` exits 1 over.
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
 * text, import kind, file path) that graph edges do not carry — true of every
 * edge `judgeEdge` judges, `check`'s own `implicit`-edge callers included: an
 * edge with no import site cannot gain one by being judged from `check` rather
 * than `impact`. A consumer who needs the full verdict should run `check`.
 *
 * ## Why a separate module, and not part of `./tags.mjs` or `./index.mjs`
 *
 * `src/rules/` judges import sites; this module judges graph edges. They share
 * the tag-matching functions (`findConstraintsFor`, `onlyTagsViolation`,
 * `notTagsViolation`, `emptyOnlyTagsViolation`) but the input is different
 * enough that merging them would put two input contracts in one module — the
 * boundary this file exists to keep legible. A sibling module in the same
 * layer, reached by `commands/` and `lsp/` as a downward import, keeps the
 * shared tag matching in one place without blurring the two judgments.
 */

import { edgeEvolutionIdentity } from "../governance/evolution-event.mjs";
import { renderMessage } from "./messages.mjs";
import { buildReachability } from "./reachability.mjs";
import {
  emptyOnlyTagsViolation,
  findConstraintsFor,
  notTagsViolation,
  onlyTagsViolation,
} from "./tags.mjs";

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
 * @param {object} [reachability] Pre-computed reachability from `buildReachability`.
 *   When omitted, it is built on demand (the slow path for single-edge callers).
 *   When provided by a batch caller like `computeRuleImpact`, it is reused across
 *   all edges in the same graph, avoiding O(E) rebuilds of the same structure.
 * @returns {{messageId: string, constraint: object|null, source: string, target: string, data: object, message: string}[]}
 */
export function judgeEdge(edge, nodes, dependencies, depConstraints, reachability) {
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
    const messageId = "projectWithoutTagsCannotHaveDependencies";
    return [
      {
        messageId,
        constraint: null,
        source: edge.source,
        target: edge.target,
        data: {},
        message: renderMessage(messageId, {}),
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
        data: onlyTags.data,
        message: renderMessage(onlyTags.messageId, onlyTags.data),
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
        data: emptyOnly.data,
        message: renderMessage(emptyOnly.messageId, emptyOnly.data),
      });
      continue;
    }

    // `notDependOnLibsWithTags` is transitive — it needs reachability.
    if (constraint.notDependOnLibsWithTags?.length > 0) {
      const reach = reachability ?? buildReachability({ nodes, dependencies });
      const notTags = notTagsViolation(constraint, targetNode, { nodes }, reach);
      if (notTags) {
        violations.push({
          messageId: notTags.messageId,
          constraint,
          source: edge.source,
          target: edge.target,
          data: notTags.data,
          message: renderMessage(notTags.messageId, notTags.data),
        });
      }
    }
  }

  return violations;
}

/**
 * Judges every `implicit`-typed edge in the graph against `depConstraints` —
 * the declaration-only counterpart to `evaluate()`'s import-site judgment,
 * for `check` specifically.
 *
 * `implicit` is the one edge type this package's own providers agree means
 * "declared, not derived from code" — Nx emits it for a `project.json`'s
 * `implicitDependencies` (verified against a real `nx graph --file=` run),
 * and the native provider's `buildDependencies` (`../providers/native/graph.mjs`)
 * assigns it for `archkeep.json`'s/`project.json`'s own `implicitDependencies`
 * row. It is also the exact criterion `drift.mjs`'s `buildObserved` and
 * `discover.mjs` already exclude architecture edges by — reused here rather
 * than re-derived, so this check and `drift`'s exclusion can never disagree
 * about which edges count as "declared".
 *
 * Only the three `depConstraints` verdicts `judgeEdge` covers are judged —
 * the same 3-of-15 limit `context`/`impact` already document, and for the same
 * reason: the other twelve rules need import-site details a declaration-only
 * edge structurally does not carry.
 *
 * An empty `depConstraints` table returns no violations, matching
 * `evaluate()`'s own early exit in `../rules/index.mjs`'s tag block
 * — a workspace declaring no constraint table has opted out of dep-constraint
 * enforcement entirely, on both the import-site and the declared-edge path.
 * `judgeEdge` itself has no such guard (an empty table makes every project's
 * `findConstraintsFor` return `[]`, i.e. `projectWithoutTagsCannotHaveDependencies`
 * on every edge) because `context`/`impact` intentionally show that as a
 * per-edge fact; folding the same into `check`'s pass/fail verdict would flag
 * an opted-out workspace on every implicit edge for a reason `check`'s own
 * import-site rules never would.
 *
 * @param {{nodes: object, dependencies: object}} graph
 * @param {object[]} depConstraints The constraint table from the boundary config.
 * @returns {{messageId: string, constraint: object|null, source: string, target: string, data: object, message: string}[]}
 */
export function declaredEdgeViolationsForCheck(graph, depConstraints) {
  if (depConstraints.length === 0) return [];
  const reachability = buildReachability(graph);
  const violations = [];
  for (const [source, edges] of Object.entries(graph.dependencies ?? {})) {
    for (const edge of edges) {
      if (edge.type !== "implicit") continue;
      violations.push(
        ...judgeEdge(
          { source, target: edge.target },
          graph.nodes,
          graph.dependencies,
          depConstraints,
          reachability,
        ),
      );
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
 * @param {{addedEdges: object[], removedEdges: object[],
 *   changedProjects?: {name: string, changes: {field: string, baseline?: unknown,
 *   head?: unknown}[]}[]}} diff From `computeDiff`.
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

  // Build reachability once for the head graph and once for the baseline graph,
  // so that repeated `judgeEdge` calls with `notDependOnLibsWithTags` constraints
  // do not rebuild the same structure per edge (the performance concern this
  // memoization addresses).
  const headReachability = buildReachability({ nodes: headNodes, dependencies: headDependencies });
  const baselineReachability = buildReachability({
    nodes: baselineNodes,
    dependencies: baselineDepsMap,
  });

  const introduced = [];
  for (const edge of diff.addedEdges) {
    const violations = judgeEdge(
      edge,
      headNodes,
      headDependencies,
      depConstraints,
      headReachability,
    );
    for (const v of violations) {
      introduced.push(v);
    }
  }

  const resolved = [];
  for (const edge of diff.removedEdges) {
    const violations = judgeEdge(
      edge,
      baselineNodes,
      baselineDepsMap,
      depConstraints,
      baselineReachability,
    );
    for (const v of violations) {
      resolved.push(v);
    }
  }

  // Standing edges whose legality a tags-only change can flip (#600): the
  // edge moved in neither direction, so the loops above never see it, but
  // the tags its judgment reads did. An edge adjacent to a project whose
  // tags changed is judged under BOTH sides' tags — violating under head
  // where it was legal under baseline is an introduced violation, the
  // inverse is a resolved one, and a violation under both is pre-existing
  // (unchanged legality is `check`'s finding, not this diff's). Edges the
  // loops above already judged are skipped by identity, so no edge is ever
  // reported twice.
  const tagChangedNames = new Set(
    (diff.changedProjects ?? [])
      .filter((project) => (project.changes ?? []).some((change) => change.field === "tags"))
      .map((project) => project.name),
  );
  if (tagChangedNames.size > 0) {
    const judged = new Set(
      [...diff.addedEdges, ...diff.removedEdges].map((edge) => edgeEvolutionIdentity(edge)),
    );
    for (const edge of baselineDependencies) {
      if (!(tagChangedNames.has(edge.source) || tagChangedNames.has(edge.target))) continue;
      if (judged.has(edgeEvolutionIdentity(edge))) continue;
      const headViolations = judgeEdge(
        edge,
        headNodes,
        headDependencies,
        depConstraints,
        headReachability,
      );
      const baselineViolations = judgeEdge(
        edge,
        baselineNodes,
        baselineDepsMap,
        depConstraints,
        baselineReachability,
      );
      if (headViolations.length > 0 && baselineViolations.length === 0) {
        introduced.push(...headViolations);
      } else if (baselineViolations.length > 0 && headViolations.length === 0) {
        resolved.push(...baselineViolations);
      }
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
  // Build reachability once for the whole graph, so `judgeEdge` calls with
  // `notDependOnLibsWithTags` constraints reuse the same structure instead of
  // rebuilding it per dependent.
  const reachability = buildReachability({ nodes, dependencies });

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
      const edgeViolations = judgeEdge(
        edgeWithSource,
        nodes,
        dependencies,
        depConstraints,
        reachability,
      );
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
