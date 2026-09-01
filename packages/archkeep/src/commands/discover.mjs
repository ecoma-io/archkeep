/**
 * The `discover` command: observed facts first, and — under `--propose` — the
 * candidate architecture those facts imply, marked as proposals that are never
 * decisions.
 *
 * `discover` is descriptive, exactly like `graph`/`diff`/`drift`: it reads the
 * resolved `CommandContext` (the same project model and analysis every command
 * shares) and returns a report. It never exits 1. The two modes:
 *
 * - **descriptive (default)** — reports what was observed: projects, edges,
 *   tags, and the analysis coverage. This is the read-only "what is here"
 *   answer, one level richer than `graph` because it also states the coverage
 *   a verdict over this tree could trust.
 * - **`--propose`** — computes the candidate architecture over those same
 *   observations (`src/governance/discovery-proposal.mjs`'s
 *   `evaluateDiscovery`) and emits it with `proposed: true` and
 *   `notAuthoritative: true` on every candidate. It never writes
 *   `architecture-intent.json`, never mutates the workspace, and never hands
 *   a candidate the authority of a decision.
 *
 * ## The empty-result invariant
 *
 * A workspace the run could not fully read (`notAnalyzed` non-empty) returns
 * `status: "no-verdict"` → exit 3, the same refusal `graph`/`drift` make:
 * every missing edge would be ambiguous between "gone" and "never seen".
 * An Nx workspace with polyglot manifests and no plugin registration is
 * refused the same way `graph` refuses it — the graph would silently
 * under-represent the real architecture, and a candidate derived from it
 * would be a fabrication wearing a proposal's name.
 *
 * A workspace with zero projects is NOT a refusal: it is the empty proposal
 * with `unknown: true` (`evaluateDiscovery`'s contract), because zero observed
 * projects is a complete observation — the honest answer is "nothing to
 * propose", not a fabricated candidate set.
 *
 * ## Determinism
 *
 * The proposal evaluator sorts every leaf by plain string comparison, and the
 * report renderers never re-sort, so two runs over an unchanged tree produce
 * byte-identical text and JSON — the same promise `graph`'s snapshots make,
 * which is what lets a consumer `diff` two proposals meaningfully.
 */
import { isWholeFileFailure } from "../analysis/source-util.mjs";
import { evaluateDiscovery } from "../governance/discovery-proposal.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { formatDiscoverReport } from "../report/discover-text.mjs";
import { buildDependencies, buildProjects } from "./graph.mjs";
import { resolveProvenance } from "./provenance.mjs";
import { refuseIncompleteGraph } from "./drift.mjs";

/**
 * The observed side of discovery: the same project model `graph` builds,
 * shared with `graph`/`drift` so the facts `discover` reports are the facts
 * every other command judges. Edges whose target is not a project in the
 * model are dropped, the same filter drift applies (`./drift.mjs`): an
 * external package is not a project a candidate can ever name.
 *
 * @param {object} commandContext From `resolveCommandContext`.
 * @returns {{projects: object[], edges: object[]}}
 */
export function buildObserved(commandContext) {
  const { graph } = commandContext;
  const projects = buildProjects(graph.nodes);
  const projectNames = new Set(projects.map((p) => p.name));
  const edges = [];
  for (const edge of buildDependencies(graph.dependencies)) {
    if (edge.type === "implicit") continue;
    if (projectNames.has(edge.source) && projectNames.has(edge.target)) {
      edges.push(edge);
    }
  }
  return { projects, edges };
}

/**
 * Converts a `discover --propose` proposal into a minimal
 * architecture-intent.json file that `drift` and `reconcile` can read.
 *
 * Confidence markers and evidence are dropped: the user is expected to review
 * the output before using it with `drift` or `reconcile`.
 *
 * @param {object} proposal The proposal from `evaluateDiscovery`.
 * @returns {{version: string, boundaries: Array<{name: string, match: string[]}>, forbidden?: Array<{source: string, target: string}>}}
 */
export function proposalToIntent(proposal) {
  const boundaries = (proposal.components?.items ?? []).map((component) => ({
    name: component.name,
    match: [`directory:${component.commonDirectory}`],
  }));

  // `noDependency` rules map to `forbidden` intent rows. The rules array
  // includes both `noDependency` and `boundary` kinds; only the former
  // carries source/target project pairs.
  const forbidden = (proposal.rules?.items ?? [])
    .filter((rule) => rule.kind === "noDependency")
    .map((rule) => ({
      source: rule.source,
      target: rule.target,
    }));

  return {
    version: "1",
    // Auto-generated header comment is not possible in strict JSON; the
    // user is expected to review before using with drift/reconcile.
    boundaries,
    ...(forbidden.length > 0 ? { forbidden } : {}),
  };
}

/**
 * Runs the `discover` command: observes the workspace, optionally proposes the
 * candidate architecture over it, and returns the report.
 *
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {{propose?: boolean}} [options]
 * @returns {{status: "ok"|"no-verdict", discovery: object, proposal: object|null,
 *   coverage: object, report: {text: string, json: string}}}
 * @throws {Error} on every condition the header lists, all exit-3 class.
 */
export function discoverCommand(commandContext, { propose = false } = {}) {
  const { root, provider, marker, analysis } = commandContext;

  refuseIncompleteGraph(commandContext);

  const notAnalyzed = analysis.failures
    .filter(isWholeFileFailure)
    .map(({ sourceFile, reason }) => ({ file: sourceFile, reason }));

  const observed = buildObserved(commandContext);

  const proposal = propose ? evaluateDiscovery(observed) : null;

  // A proposal over an unread tree would be a fabrication wearing a
  // proposal's name: every candidate edge would be ambiguous between "gone"
  // and "never seen". Refuse loudly — the same reasoning `drift`'s refusal
  // gives — rather than print a proposal and a warning that it may be lying.
  if (propose && notAnalyzed.length > 0) {
    throw new Error(
      `archkeep: discover --propose has incomplete coverage — ${notAnalyzed.length} file` +
        `${notAnalyzed.length === 1 ? "" : "s"} could not be analyzed, so every candidate ` +
        `would be ambiguous between "gone" and "never seen". Fix the unanalyzed files and ` +
        `re-run.`,
    );
  }

  const complete = notAnalyzed.length === 0;
  const status = complete ? "ok" : "no-verdict";
  const exitCode = complete ? 0 : 3;

  const coverage = {
    complete,
    projects: observed.projects.length,
    analyzedFiles: analysis.analyzed,
    imports: analysis.imports.length,
    notAnalyzed,
    blindSpots: analysis.failures
      .filter((failure) => !isWholeFileFailure(failure))
      .map(({ sourceFile, line, column, reason }) => ({ file: sourceFile, line, column, reason })),
    notes: [],
  };

  const context = { root, provider, marker, provenance: resolveProvenance(root) };
  const discovery = {
    projects: observed.projects,
    edges: observed.edges,
    tags: Array.from(new Set(observed.projects.flatMap((project) => project.tags))).sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
  };

  const envelope = jsonEnvelope({
    command: "discover",
    context,
    status,
    exitCode,
    coverage,
    result: { discovery, ...(proposal ? { proposal } : {}) },
  });

  return {
    status,
    discovery,
    proposal,
    coverage,
    report: {
      text: formatDiscoverReport({
        discovery,
        proposal,
        coverage,
      }),
      json: renderJson(envelope),
    },
  };
}
