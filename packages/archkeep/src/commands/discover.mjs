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
 *   `notAuthoritative: true` on every candidate. This layer performs no
 *   write: the evaluator is pure, and the one route from a proposal to
 *   `architecture-intent.json` is the CLI's own `--write-intent <file>` flag
 *   (`cli.mjs`'s `runDiscover`, serialized through `proposalToIntent`
 *   below) — explicit, named by the operator, and refused when a file
 *   already stands at the target. The command never hands a candidate the
 *   authority of a decision.
 *
 * ## The empty-result invariant
 *
 * Completeness comes from `./coverage-verdict.mjs`'s shared constructor —
 * the same three-axis law (no whole-file failure, no unjudged blind spot,
 * at least one file analyzed) that `graph` and `check` judge completeness
 * over. The graph-family restatement this replaces is how the zero-analysis
 * axis went missing here (#619).
 *
 * A workspace with zero projects is NOT a refusal: it is the empty proposal
 * with `unknown: true` (`evaluateDiscovery`'s contract), because zero observed
 * projects is a complete observation — the honest answer is "nothing to
 * propose", not a fabricated candidate set. The constructor's zero-analysis
 * clause is overridden for this case: if there is nothing to observe, the
 * observation is complete.
 *
 * An Nx workspace with polyglot manifests and no plugin registration is
 * refused the same way `graph` refuses it — the graph would silently
 * under-represent the real architecture, and a candidate derived from it
 * would be a fabrication wearing a proposal's name.
 *
 * ## Determinism
 *
 * The proposal evaluator sorts every leaf by plain string comparison, and the
 * report renderers never re-sort, so two runs over an unchanged tree produce
 * byte-identical text and JSON — the same promise `graph`'s snapshots make,
 * which is what lets a consumer `diff` two proposals meaningfully.
 */
import { evaluateDiscovery } from "../governance/discovery-proposal.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { formatDiscoverReport } from "../report/discover-text.mjs";
import { coverageIncompleteReasons } from "../verdict.mjs";
import { coverageVerdict } from "./coverage-verdict.mjs";
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
 * Convert a discovery proposal into an `architecture-intent.json`-compatible
 * object. The conversion preserves the proposal's structural intent:
 *
 * - **Components** (directory groupings of 2+ projects) → `boundaries` entries
 *   with `directory:` selectors.
 * - **`noDependency` rules** → `forbidden` entries — cross-component
 *   dependencies that should not exist.
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

  const observed = buildObserved(commandContext);

  const proposal = propose ? evaluateDiscovery(observed) : null;

  // The completeness verdict is the shared constructor's, not this file's:
  // restating the axes here is how the `analyzed > 0` term went missing from
  // this face (#619 — a run that judged no file at all used to report `ok` /
  // `complete: true` / exit 0, byte-for-byte the envelope a clean workspace
  // gets). `coverageVerdict` owns the one law — no whole-file failure, no
  // unjudged site, at least one file analyzed — and the same return shape
  // the envelope and the text face both read.
  //
  // One override: a workspace with zero projects is a complete observation
  // (there is nothing to observe), so the zero-analysis clause does not
  // withhold from it. `evaluateDiscovery`'s contract returns `unknown: true`
  // over an empty project list, and that answer is honest — it does not
  // claim completeness over nothing.
  const verdict = coverageVerdict(commandContext);
  const hasProjects = observed.projects.length > 0;
  const { complete, status, exitCode } = verdict;
  // When there are no projects, override the zero-analysis withdrawal: an
  // empty observation is a complete observation, and the `unknown` proposal
  // is the honest answer.
  const effectiveComplete = hasProjects ? complete : true;
  const effectiveStatus = hasProjects ? status : "ok";
  const effectiveExitCode = hasProjects ? exitCode : 0;

  // A proposal over an unread tree would be a fabrication wearing a
  // proposal's name: every candidate edge would be ambiguous between "gone"
  // and "never seen". Refuse loudly — the same reasoning `drift`'s refusal
  // gives — rather than print a proposal and a warning that it may be lying.
  // An unresolvable site is the same fabrication at site granularity (#595):
  // the edge out of it may be missing, and a candidate built over a gap is
  // still a guess. Use the shared verdict's counts rather than re-deriving.
  if (propose && (verdict.notAnalyzed.length > 0 || verdict.blindSpotCount > 0)) {
    throw new Error(
      `archkeep: discover --propose has incomplete coverage — ` +
        [
          verdict.notAnalyzed.length > 0
            ? `${verdict.notAnalyzed.length} file${verdict.notAnalyzed.length === 1 ? "" : "s"} could not be analyzed`
            : null,
          verdict.blindSpotCount > 0
            ? `${verdict.blindSpotCount} import site${verdict.blindSpotCount === 1 ? "" : "s"} could not be resolved`
            : null,
        ]
          .filter(Boolean)
          .join(", ") +
        `, so every candidate would be ambiguous between "gone" and "never seen". ` +
        `Fix the unresolved files and sites and re-run.`,
    );
  }

  // The clauses the text face renders over an incomplete run, worded by the
  // same function `verdictFor` joins into `decision.reason` — one wording,
  // two renderings, and neither can drift from the other.
  const coverageIncomplete = coverageIncompleteReasons({
    unchecked: verdict.notAnalyzed.length,
    blindSpots: verdict.blindSpotCount,
    analyzed: analysis.analyzed,
  });

  const coverage = {
    complete: effectiveComplete,
    projects: observed.projects.length,
    analyzedFiles: analysis.analyzed,
    imports: analysis.imports.length,
    notAnalyzed: verdict.notAnalyzed,
    blindSpots: verdict.blindSpots,
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
    status: effectiveStatus,
    exitCode: effectiveExitCode,
    coverage,
    result: { discovery, ...(proposal ? { proposal } : {}) },
  });

  return {
    status: effectiveStatus,
    discovery,
    proposal,
    coverage,
    report: {
      text: formatDiscoverReport({
        discovery,
        proposal,
        coverage,
        coverageIncomplete: hasProjects ? coverageIncomplete : undefined,
      }),
      json: renderJson(envelope),
    },
  };
}
