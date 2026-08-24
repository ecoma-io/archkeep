/**
 * The `context` command: the architecture constraints that apply to a project.
 *
 * Given a project name, `context` shows the project's tags, the constraint rows
 * that match those tags, and what each constraint allows or bans — the
 * architecture context a developer (or an AI agent) needs before editing a
 * project. It is descriptive: it never exits 1, because a description of what
 * the rules say is never a finding.
 *
 * What it needs from its caller is a project name and a `CommandContext` — the
 * preamble every command shares (`./context.mjs`) — plus the loaded boundary
 * config, because the constraint rows live there. What it gives back is a
 * `status`, the context payload for both the text and the JSON renderers, and
 * enough coverage information to build a correct envelope. It does not print,
 * and it does not decide the process's exit code — `../../cli.mjs` owns those
 * (`./README.md`).
 *
 * ## Why this command exists
 *
 * A developer opening a project for the first time — or an AI agent given a
 * task that touches one — needs to know what the boundary rules allow before
 * writing an import that violates them. Running `check` after the fact is a
 * lint cycle; `context` is the architecture answer before the first line is
 * written. It is the same constraint table `check` judges from, rendered as
 * a readable summary rather than as a list of violations.
 *
 * ## The unregistered-plugin refusal
 *
 * Same as `graph`, `diff`, `impact`, and `explain`: on an Nx workspace whose
 * `nx.json` does not register this plugin but whose tracked files include
 * polyglot manifests under project roots, `context` refuses loudly rather
 * than explaining constraints from a graph whose edges silently under-represent
 * the real architecture.
 */
import { isWholeFileFailure } from "../analysis/source-util.mjs";
import { UsageError } from "../errors.mjs";
import { judgeEdge } from "./edge-constraints.mjs";
import { findConstraintsFor } from "../rules/tags.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { formatContextReport } from "../report/context-text.mjs";
import { resolveProvenance } from "./provenance.mjs";
import { readAdrContext } from "./adr.mjs";
import { declaredFitnessNames, unresolvedDecisionRefRows } from "../governance/adr-registry.mjs";

/**
 * Collects the architecture context for a project: its tags, which constraint
 * rows match, what each row allows or bans, and the project's current
 * dependencies with per-edge constraint verdicts.
 *
 * @param {string} projectName The project whose context is being queried.
 * @param {object} graph The project graph: `{nodes, dependencies}`.
 * @param {object} config The loaded boundary config (from `loadBoundaryConfig`).
 * @returns {{project: string, tags: string[], constraints: object[],
 *   dependencies: {target: string, type: string, violations: object[]}[]}}
 * @throws {UsageError} when `projectName` is not in the graph.
 */
export function collectProjectContext(projectName, graph, config) {
  const nodes = graph.nodes;
  const dependencies = graph.dependencies;

  if (!Object.hasOwn(nodes, projectName)) {
    throw new UsageError(
      `archkeep: no project named '${projectName}' in the graph — ` +
        `available projects: ${Object.keys(nodes)
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
          .join(", ")}`,
    );
  }

  const node = nodes[projectName];
  const tags = node.data?.tags ?? [];

  const matchedConstraints = findConstraintsFor(config.depConstraints, node);

  // Collect the project's outgoing edges and judge each one.
  const outgoing = dependencies[projectName] ?? [];
  const deps = [];
  for (const edge of outgoing) {
    const violations = judgeEdge(
      { source: projectName, target: edge.target },
      nodes,
      dependencies,
      config.depConstraints,
    );
    deps.push({
      target: edge.target,
      type: edge.type,
      violations,
    });
  }

  return { project: projectName, tags, constraints: matchedConstraints, dependencies: deps };
}

/**
 * Runs the `context` command: resolves the command context, checks the
 * unregistered-plugin condition, and collects the project's architecture
 * context.
 *
 * @param {string} projectName The project whose architecture context to show.
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {object} config The loaded boundary config (from `loadBoundaryConfig`).
 * @returns {{status: "ok"|"no-verdict", projectContext: object, coverage: object,
 *   report: {text: string, json: string}}}
 * @throws {Error} when an Nx workspace has polyglot manifests but the plugin
 *   is not registered, or when the named project does not exist in the graph.
 */
export function contextCommand(projectName, commandContext, config) {
  const { root, provider, marker, graph, pluginGap, tracked } = commandContext;

  // Descriptive commands refuse when the graph is known to be incomplete.
  if (provider === "nx" && !pluginGap.registered && pluginGap.manifests.length > 0) {
    throw new Error(
      `archkeep: refusing to show context for an Nx workspace where this plugin is ` +
        `not registered but polyglot manifests exist under project roots ` +
        `(${pluginGap.manifests.join(", ")}). The graph would carry no polyglot edges, ` +
        `so the constraints shown would be against an incomplete graph. ` +
        `Register the plugin in nx.json: ` +
        `"plugins": [{ "plugin": "@ecoma-io/archkeep/nx" }], or remove the polyglot manifests ` +
        `if they are not in use.`,
    );
  }

  // Validate the project exists before investing in anything else.
  const projectContext = collectProjectContext(projectName, graph, config);

  // A matched constraint row's `decisionRef` names the ADR (or rule/fitness
  // id) that supposedly authorizes it, unverified until now — the same gap
  // `cli.mjs`'s `check` closes for the identical `depConstraints` table,
  // through the same `readAdrContext`/`unresolvedDecisionRefRows`
  // (`../governance/adr-registry.mjs`). Only the rows this report actually
  // renders are checked; a workspace that never uses `decisionRef` pays no
  // extra read.
  const decisionRefRows = projectContext.constraints
    .map((row, index) => ({ kind: `constraints[${index}]`, row }))
    .filter(({ row }) => typeof row?.decisionRef === "string" && row.decisionRef.trim() !== "");
  let unresolvedDecisionRefs = new Set();
  if (decisionRefRows.length > 0) {
    const adrContext = readAdrContext(root, { tracked });
    unresolvedDecisionRefs = new Set(
      // F04: the fitness half resolves against the ids THIS policy declares
      // (`declaredFitnessNames(config)`), never the ADRs' own `bindings`.
      unresolvedDecisionRefRows(decisionRefRows, adrContext.byId, declaredFitnessNames(config)).map(
        (row) => row.decisionRef,
      ),
    );
  }

  const notAnalyzed = commandContext.analysis.failures
    .filter(isWholeFileFailure)
    .map(({ sourceFile, reason }) => ({ file: sourceFile, reason }));

  const complete = notAnalyzed.length === 0;
  const status = complete ? "ok" : "no-verdict";
  const exitCode = complete ? 0 : 3;

  const coverage = {
    complete,
    projects: Object.keys(graph.nodes).length,
    analyzedFiles: commandContext.analysis.analyzed,
    imports: commandContext.analysis.imports.length,
    notAnalyzed,
    blindSpots: commandContext.analysis.failures
      .filter((f) => !isWholeFileFailure(f))
      .map(({ sourceFile, line, column, reason }) => ({ file: sourceFile, line, column, reason })),
    notes: [
      "per-edge violations cover only depConstraints (3 of 15 violation types). " +
        "A dependency with no violations here may still violate npm-ban, circular-dependency, " +
        "lazy-load, or other rules that require import-site details. Run `check` for the " +
        "complete verdict.",
    ],
  };

  const context = { root, provider, marker, provenance: resolveProvenance(root) };
  const result = {
    project: projectContext.project,
    tags: projectContext.tags,
    constraints: projectContext.constraints,
    dependencies: projectContext.dependencies,
    // Additive and optional: absent when every matched row's decisionRef
    // resolves (or none carries one) — a project with no governance-cited
    // rows reads exactly as it did before this field existed. `constraints`
    // above keeps every row's raw `decisionRef` untouched; this is the
    // separate, resolved fact a consumer cross-checks it against.
    ...(unresolvedDecisionRefs.size > 0
      ? {
          unresolvedDecisionRefs: [...unresolvedDecisionRefs].sort((a, b) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        }
      : {}),
  };

  const envelope = jsonEnvelope({
    command: "context",
    context,
    status,
    exitCode,
    coverage,
    result,
  });

  return {
    status,
    projectContext: result,
    coverage,
    report: {
      text: formatContextReport({ projectContext: result, coverage, unresolvedDecisionRefs }),
      json: renderJson(envelope),
    },
  };
}
