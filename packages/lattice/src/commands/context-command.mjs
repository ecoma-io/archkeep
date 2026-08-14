/**
 * The `context` command: the architecture constraints that apply to a project.
 *
 * Given a project name, `context` shows the project's tags, the constraint rows
 * that match those tags, and what each constraint allows or bans — the
 * architecture context a developer (or an AI agent) needs before editing a
 * project. It is descriptive: it never exits 1, because a description of what
 * the rules say is never a finding (only `check` ever exits 1).
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
import { findConstraintsFor } from "../rules/tags.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { formatContextReport } from "../report/context-text.mjs";

/**
 * Collects the architecture context for a project: its tags, which constraint
 * rows match, and what each row allows or bans.
 *
 * @param {string} projectName The project whose context is being queried.
 * @param {object} graph The project graph: `{nodes, dependencies}`.
 * @param {object} config The loaded boundary config (from `loadBoundaryConfig`).
 * @returns {{project: string, tags: string[], constraints: object[]}}
 * @throws {Error} when `projectName` is not in the graph.
 */
export function collectProjectContext(projectName, graph, config) {
  const nodes = graph.nodes;

  if (!Object.hasOwn(nodes, projectName)) {
    throw new Error(
      `lattice: no project named '${projectName}' in the graph — ` +
        `available projects: ${Object.keys(nodes)
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
          .join(", ")}`,
    );
  }

  const node = nodes[projectName];
  const tags = node.data?.tags ?? [];

  const matchedConstraints = findConstraintsFor(config.depConstraints, node);

  return { project: projectName, tags, constraints: matchedConstraints };
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
  const { root, provider, marker, graph, pluginGap } = commandContext;

  // Descriptive commands refuse when the graph is known to be incomplete.
  if (provider === "nx" && !pluginGap.registered && pluginGap.manifests.length > 0) {
    throw new Error(
      `lattice: refusing to show context for an Nx workspace where this plugin is ` +
        `not registered but polyglot manifests exist under project roots ` +
        `(${pluginGap.manifests.join(", ")}). The graph would carry no polyglot edges, ` +
        `so the constraints shown would be against an incomplete graph. ` +
        `Register the plugin in nx.json: ` +
        `"plugins": [{ "plugin": "@ecoma-io/lattice/nx" }], or remove the polyglot manifests ` +
        `if they are not in use.`,
    );
  }

  // Validate the project exists before investing in anything else.
  const projectContext = collectProjectContext(projectName, graph, config);

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
    notes: [],
  };

  const context = { root, provider, marker };
  const result = {
    project: projectContext.project,
    tags: projectContext.tags,
    constraints: projectContext.constraints,
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
      text: formatContextReport({ projectContext: result, coverage }),
      json: renderJson(envelope),
    },
  };
}
