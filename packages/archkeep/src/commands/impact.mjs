/**
 * The `impact` command: reverse reachability from the project graph.
 *
 * Given a project name, `impact` lists every project that transitively depends
 * on it — the set a developer needs to consider before changing that project.
 * It is descriptive: it never exits 1, because a description of what depends
 * on a project is never a finding.
 *
 * The result separates **direct** dependents (projects whose edges point
 * straight at the target) from **transitive** ones (reachable only through
 * another project), and the union of both is `dependents`. An empty
 * `dependents` list is a claim — "nothing depends on this project" — not a
 * shrug, and it is worded that way in the report so a reader never mistakes it
 * for silence.
 *
 * When a boundary config is provided (via `--config` or the workspace's own
 * declaration), `impact` also returns the **constraint context** for each
 * dependent: which `depConstraints` rows govern that edge and whether it
 * currently violates them. This is narrower than `check` — it checks only
 * `depConstraints` (tag-based), not npm/circular/lazy-load rules that need
 * import-site details. A consumer who needs the complete verdict should run
 * `check`.
 *
 * What it needs from its caller is a `CommandContext` — the preamble every
 * command shares (`./context.mjs`). What it gives back is a `status`, the
 * payload for both the text and the JSON renderers, and enough coverage
 * information to build a correct envelope. It does not print, and it does not
 * decide the process's exit code — `../../cli.mjs` owns those
 * (`./README.md`).
 *
 * ## The unregistered-plugin refusal
 *
 * Same as `graph` and `diff`: on an Nx workspace whose `nx.json` does not
 * register this plugin but whose tracked files include polyglot manifests
 * under project roots, `impact` refuses loudly rather than returning a result
 * whose dependents silently under-represent the real architecture.
 */
import { UsageError } from "../errors.mjs";
import { computeImpactConstraints } from "./edge-constraints.mjs";
import { coverageRefusal, coverageVerdict } from "./coverage-verdict.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { formatImpactReport } from "../report/impact-text.mjs";
import { resolveProvenance } from "./provenance.mjs";
import { composeImpactStatement } from "./impact-statement.mjs";

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

/**
 * Runs the `impact` command: resolves the command context, checks the
 * unregistered-plugin condition, and computes the impact set.
 *
 * @param {string} projectName The project whose dependents to list.
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {object} [config] The loaded boundary config. When provided,
 *   constraint context and violations for each dependent edge are computed.
 * @returns {{status: "ok"|"no-verdict", impact?: object, coverage: object,
 *   report: {text: string, json: string}}}
 *   `status: "no-verdict"` carries no `impact` payload — the verdict was
 *   withheld, and the envelope's `coverage` block is the whole answer (#608).
 * @throws {Error} when an Nx workspace has polyglot manifests but the plugin
 *   is not registered, or when the named project does not exist in the graph.
 *   Incomplete coverage returns the structured no-verdict envelope instead of
 *   throwing (#608).
 */
export function impactCommand(projectName, commandContext, config = null) {
  const { root, provider, marker, graph, pluginGap } = commandContext;

  // Descriptive commands refuse when the graph is known to be incomplete.
  if (provider === "nx" && !pluginGap.registered && pluginGap.manifests.length > 0) {
    throw new Error(
      `archkeep: refusing to compute impact for an Nx workspace where this plugin is ` +
        `not registered but polyglot manifests exist under project roots ` +
        `(${pluginGap.manifests.join(", ")}). The graph would carry no polyglot edges, ` +
        `so the impact set would silently under-represent the real architecture. ` +
        `Register the plugin in nx.json: ` +
        `"plugins": [{ "plugin": "@ecoma-io/archkeep/nx" }], or remove the polyglot manifests ` +
        `if they are not in use.`,
    );
  }

  // Validate the project exists before looking at coverage — a non-existent
  // project is a caller error, not a workspace fact, and it should name the
  // project before the run invests in anything else.
  const impact = computeImpact(projectName, graph);

  // The impact set is a claim about the tree the run read, refused through the
  // one structured contract `./coverage-verdict.mjs` builds (#608): the
  // verdict is withheld in-band — status "no-verdict", exit 3, a `coverage`
  // block naming every file and site the run could not judge — where a parser
  // and `--output` can read it, not on stderr where only a human can.
  const completeness = coverageVerdict(commandContext);
  if (!completeness.complete) {
    return coverageRefusal({ command: "impact", commandContext, what: "computing impact" });
  }
  const blindSpots = completeness.blindSpots;

  const complete = true; // the incompleteness cases all returned above
  const status = "ok";
  const exitCode = 0;

  const coverage = {
    complete,
    projects: Object.keys(graph.nodes).length,
    analyzedFiles: commandContext.analysis.analyzed,
    imports: commandContext.analysis.imports.length,
    notAnalyzed: [],
    blindSpots,
    notes: [
      "per-edge violations cover only depConstraints (3 of 15 violation types). " +
        "A dependent with no violations here may still violate npm-ban, circular-dependency, " +
        "lazy-load, or other rules that require import-site details. Run `check` for the " +
        "complete verdict.",
    ],
  };

  const context = { root, provider, marker, provenance: resolveProvenance(root) };
  const result = {
    project: impact.project,
    direct: impact.direct,
    transitive: impact.transitive,
    dependents: impact.dependents,
  };

  // Rule-impact analysis: when the boundary config is available, identify
  // which constraint rows govern each dependent's edge to the target and
  // whether the edge currently violates those rows. This is narrower than
  // the full rule engine: it covers `depConstraints`, not checks that need
  // import-site details such as npm bans or lazy loading.
  if (config && config.depConstraints) {
    result.constraintImpact = computeImpactConstraints(
      projectName,
      impact.dependents,
      graph.nodes,
      graph.dependencies,
      config.depConstraints,
    );
  }
  result.impactStatement = composeImpactStatement(projectName, commandContext, config);

  // Full impact statement: when a boundary config is available, compose the
  // enriched statement that includes decision impact and evolution alignment
  // in addition to the reverse reachability and constraint impact above.
  if (config) {
    result.impactStatement = composeImpactStatement(projectName, commandContext, config);
  }

  const envelope = jsonEnvelope({
    command: "impact",
    context,
    status,
    exitCode,
    coverage,
    result,
  });

  return {
    status,
    impact: result,
    coverage,
    report: {
      text: formatImpactReport({ impact: result, coverage }),
      json: renderJson(envelope),
    },
  };
}
