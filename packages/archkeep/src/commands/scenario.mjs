/**
 * The `scenario` command: evaluate a hypothetical change against the current
 * workspace and report the current-versus-scenario comparison.
 *
 * A scenario is a virtual, read-only evaluation. It never mutates the
 * workspace, never writes to canonical history, and never emits an
 * `EvolutionEvent`. Every output field carries a `virtual: true` /
 * `notAuthoritative` marker.
 *
 * @module
 */
import { resolveProvenance } from "./provenance.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { isWholeFileFailure } from "../analysis/source-util.mjs";
import { evaluateScenario, parseScenarioInput } from "./scenario-evaluation.mjs";

/**
 * Runs the `scenario` command: parses the scenario input, evaluates it, and
 * returns the comparison.
 *
 * @param {string} projectName The target project.
 * @param {string} scenarioJson The scenario description as JSON.
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {object} [config] The loaded boundary config.
 * @returns {{status: string, scenario: object, coverage: object, report: {text: string, json: string}}}
 */
export function scenarioCommand(projectName, scenarioJson, commandContext, config = null) {
  const { root, provider, marker, graph, pluginGap } = commandContext;

  // Descriptive commands refuse when the graph is known to be incomplete.
  if (provider === "nx" && !pluginGap.registered && pluginGap.manifests.length > 0) {
    throw new Error(
      `archkeep: refusing to evaluate a scenario for an Nx workspace where this plugin is ` +
        `not registered but polyglot manifests exist under project roots ` +
        `(${pluginGap.manifests.join(", ")}). The graph would carry no polyglot edges, ` +
        `so the scenario would silently under-represent the real architecture. ` +
        `Register the plugin in nx.json: ` +
        `"plugins": [{ "plugin": "@ecoma-io/archkeep/nx" }], or remove the polyglot manifests ` +
        `if they are not in use.`,
    );
  }

  // Parse the scenario input
  const scenarioInput = parseScenarioInput(scenarioJson);

  // Check coverage
  const notAnalyzed = commandContext.analysis.failures
    .filter(isWholeFileFailure)
    .map(({ sourceFile, reason }) => ({ file: sourceFile, reason }));

  if (notAnalyzed.length > 0) {
    throw new Error(
      `archkeep: the graph has incomplete coverage — ${notAnalyzed.length} file` +
        `${notAnalyzed.length === 1 ? "" : "s"} could not be analyzed, so the scenario may ` +
        `under-represent the real architecture. Fix the unanalyzed files and re-run.`,
    );
  }

  // Evaluate
  const scenario = evaluateScenario(projectName, commandContext, scenarioInput, config);

  const coverage = {
    complete: scenario.complete,
    projects: Object.keys(graph.nodes).length,
    analyzedFiles: commandContext.analysis.analyzed,
    imports: commandContext.analysis.imports.length,
    notAnalyzed: [],
    blindSpots: commandContext.analysis.failures
      .filter((f) => !isWholeFileFailure(f))
      .map(({ sourceFile, line, column, reason }) => ({ file: sourceFile, line, column, reason })),
    notes: [
      "scenario evaluation is virtual and not authoritative — run `check` for the real verdict",
      "per-edge verdicts cover only depConstraints (3 of 15 violation types)",
    ],
  };

  const context = { root, provider, marker, provenance: resolveProvenance(root) };

  const result = {
    virtual: scenario.virtual,
    notAuthoritative: scenario.notAuthoritative,
    complete: scenario.complete,
    project: scenario.project,
    base: scenario.base,
    changes: scenario.changes,
    refused: scenario.refused,
    current: scenario.current,
    scenario: scenario.scenario,
    delta: scenario.delta,
    notes: scenario.notes,
  };

  const envelope = jsonEnvelope({
    command: "scenario",
    context,
    status: "ok",
    exitCode: 0,
    coverage,
    result,
  });

  const text = formatScenarioReport(scenario);

  return {
    status: "ok",
    scenario: result,
    coverage,
    report: {
      text,
      json: renderJson(envelope),
    },
  };
}

/**
 * Formats a scenario evaluation as terminal text.
 *
 * @param {object} scenario The scenario evaluation result.
 * @returns {string}
 */
function formatScenarioReport(scenario) {
  const lines = [];

  lines.push(`Scenario evaluation for "${scenario.project}"`);
  lines.push(`${"=".repeat(50)}`);
  lines.push(`Virtual: ${scenario.virtual}  |  Not authoritative: ${scenario.notAuthoritative}`);
  lines.push("");

  if (scenario.changes.length > 0) {
    lines.push("Changes applied:");
    for (const change of scenario.changes) {
      lines.push(`  ${change}`);
    }
  }

  if (scenario.refused && scenario.refused.length > 0) {
    lines.push("Changes refused:");
    for (const ref of scenario.refused) {
      lines.push(`  ✖ ${ref}`);
    }
  }

  lines.push("");
  lines.push("Current impact:");
  lines.push(`  Direct:      ${scenario.current.impact.direct.length} project(s)`);
  lines.push(`  Transitive:  ${scenario.current.impact.transitive.length} project(s)`);
  lines.push(`  Dependents:  ${scenario.current.impact.dependents.length} project(s)`);
  lines.push("");

  lines.push("Scenario impact:");
  lines.push(`  Direct:      ${scenario.scenario.impact.direct.length} project(s)`);
  lines.push(`  Transitive:  ${scenario.scenario.impact.transitive.length} project(s)`);
  lines.push(`  Dependents:  ${scenario.scenario.impact.dependents.length} project(s)`);
  lines.push("");

  lines.push("Delta:");
  const delta = scenario.delta;
  if (delta.dependentsAdded.length > 0) {
    lines.push(`  Dependents added:   ${delta.dependentsAdded.join(", ")}`);
  }
  if (delta.dependentsRemoved.length > 0) {
    lines.push(`  Dependents removed: ${delta.dependentsRemoved.join(", ")}`);
  }
  if (delta.dependentsAdded.length === 0 && delta.dependentsRemoved.length === 0) {
    lines.push("  No change to dependent set");
  }
  if (delta.constraintsChanged) {
    lines.push("  Constraint impact: CHANGED");
  }
  if (delta.decisionsChanged) {
    lines.push("  Decision impact: CHANGED");
  }
  lines.push("");

  if (scenario.notes.length > 0) {
    lines.push("Notes:");
    for (const note of scenario.notes) {
      lines.push(`  ${note}`);
    }
  }

  return lines.join("\n");
}
