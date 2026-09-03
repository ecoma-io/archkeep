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
import { coverageRefusal, coverageVerdict } from "./coverage-verdict.mjs";
import { evaluateScenario, parseScenarioInput } from "./scenario-evaluation.mjs";
export { parseScenarioInput } from "./scenario-evaluation.mjs";

/**
 * Runs the `scenario` command: parses the scenario input, evaluates it, and
 * returns the comparison.
 *
 * @param {string} projectName The target project.
 * @param {string} scenarioJson The scenario description as JSON.
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {object} [config] The loaded boundary config.
 * @returns {{status: "ok"|"no-verdict", scenario?: object, coverage: object,
 *   report: {text: string, json: string}}} `scenario` is absent under
 *   `status: "no-verdict"` — the coverage refusal (#608) withholds the
 *   evaluation, and the envelope's `coverage` block is the whole answer.
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

  // Check coverage — refused through the one structured contract
  // `./coverage-verdict.mjs` builds (#608): the evaluation is withheld
  // in-band, where a parser and `--output` can read it.
  const completeness = coverageVerdict(commandContext);
  if (!completeness.complete) {
    return coverageRefusal({ command: "scenario", commandContext, what: "evaluating a scenario" });
  }

  // Evaluate
  const scenario = evaluateScenario(projectName, commandContext, scenarioInput, config);

  const coverage = {
    complete: true,
    projects: Object.keys(graph.nodes).length,
    analyzedFiles: commandContext.analysis.analyzed,
    imports: commandContext.analysis.imports.length,
    notAnalyzed: [],
    blindSpots: completeness.blindSpots,
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
    completeness: scenario.completeness,
    project: scenario.project,
    base: scenario.base,
    changes: scenario.changes,
    refused: scenario.refused,
    current: scenario.current,
    scenario: scenario.scenario,
    governanceImpact: scenario.governanceImpact,
    evidenceChain: scenario.evidenceChain,
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

  const text = formatScenarioReport(scenario, coverage);

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
 * The coverage line rides the same `coverageIncompleteReasons` clauses every
 * other text face uses (`../verdict.mjs`), so a terminal reader is told how
 * much of the tree the comparison inspected, in the one wording the JSON
 * envelope's status also speaks (#609).
 *
 * @param {object} scenario The scenario evaluation result.
 * @param {object} coverage The run's coverage block.
 * @returns {string}
 */
function formatScenarioReport(scenario, coverage) {
  const lines = [];

  lines.push(`Scenario evaluation for "${scenario.project}"`);
  lines.push(`${"=".repeat(50)}`);
  lines.push(`Virtual: ${scenario.virtual}  |  Not authoritative: ${scenario.notAuthoritative}`);
  // The "how much was inspected" line, derived from the same coverage block
  // the envelope carries — never re-counted here.
  lines.push(
    `Coverage: ${coverage.imports} import${coverage.imports === 1 ? "" : "s"} in ` +
      `${coverage.analyzedFiles} file${coverage.analyzedFiles === 1 ? "" : "s"} across ` +
      `${coverage.projects} project${coverage.projects === 1 ? "" : "s"}` +
      (coverage.complete ? "" : " — coverage incomplete"),
  );
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
  if (delta.constraintsChanged && delta.constraintsChanged.status === "changed") {
    lines.push("  Constraint impact: CHANGED");
  }
  if (delta.decisionsChanged && delta.decisionsChanged.status === "changed") {
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
