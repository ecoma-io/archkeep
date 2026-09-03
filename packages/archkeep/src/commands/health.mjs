/**
 * The `health` command: deterministic architecture-health metrics and trends
 * for the current workspace — the numbers a maintainer acts on, computed
 * read-only, with no service behind them.
 *
 * `health` measures the run's `{ projects, dependencies, analysis, coverage,
 * intent }` and reports, per metric, a verdict in the canonical vocabulary the
 * governance wave shares (`../governance/metrics.mjs`'s header owns the four
 * states). It is **descriptive**, exactly like `graph`/`diff`/`impact`:
 * it never exits 1, because a description of how healthy the architecture is
 * is never itself a finding. Which verbs DO carry exit 1 is settled in
 * `./README.md`, and it is not this one.
 *
 * ## What it reports
 *
 * - **Per-run metrics** — violation count, waiver surface, debt rows, coverage
 *   ratio, project/edge counts, cycle count, edge density, and the intent
 *   (fitness) verdict. Every number is re-derived from records the run already
 *   holds through the same functions `check`/`graph`/`drift` use, so health
 *   performs no new scans and cannot disagree with those commands about the
 *   same tree.
 * - **Per-metric verdicts** — each metric is decided over complete evidence or
 *   says it could not look. A metric with no evidence reads `not_applicable`;
 *   a metric whose evidence is partial reads `unknown`. **A metric is never
 *   reported as a bare zero over evidence the run could not inspect** — that
 *   is the empty-result invariant applied at the metric level.
 * - **Trends** — the same metrics over the snapshot directory `history` reads
 *   (`.archkeep/history/` by convention), so a maintainer sees how each metric
 *   moved between snapshots. Trends are limited to what a `graph` snapshot
 *   carries: structural metrics over the snapshots, with the disclosure that
 *   rule-impact cannot be re-derived from stored bytes (`../commands/history.mjs`
 *   states the same limit).
 *
 * ## The status contract
 *
 * `health` returns `status: "ok"` when every metric reached a verdict
 * (`ok`, `findings`, or `not_applicable`) and `status: "no-verdict"` when any
 * metric is `unknown` — a run that could not fully inspect its own evidence is
 * not a healthy run, and a descriptive command's `no-verdict` is exit 3, the
 * same code `graph`/`impact` use for incomplete coverage. It never changes
 * the verdict or exit code of any other command: `health` is purely additive.
 *
 * It does not print, and it does not decide the process's exit code —
 * `../../cli.mjs` owns those (`./README.md`).
 */
import {
  blindSpotRows,
  isWholeFileFailure,
  unresolvableLiteralCount,
} from "../analysis/source-util.mjs";
import { buildDependencies, buildProjects } from "./graph.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { formatHealthReport } from "../report/health-text.mjs";
import { resolveProvenance } from "./provenance.mjs";
import { readSnapshots } from "./history.mjs";
import {
  boundaryMetrics,
  couplingMetrics,
  debtMetric,
  intentMetric,
  structuralMetrics,
} from "../governance/metrics.mjs";
import { judgeIntent } from "../architecture-intent/judge.mjs";

/**
 * Computes the intent verdict the fitness metric reads — the same `judgeIntent`
 * call `drift`/`check` make, so health and those commands cannot disagree about
 * the same intent file.
 *
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {object|null} intent The loaded intent model, or `null` when the
 *   workspace has no intent file.
 * @returns {{ok: boolean, findings: object[], unresolved: object[]}|null}
 */
function intentVerdict(commandContext, intent) {
  if (intent === null) return null;
  const judged = judgeIntent(intent, {
    nodes: commandContext.graph.nodes,
    dependencies: commandContext.graph.dependencies,
  });
  return {
    ok: judged.findings.length === 0 && judged.unresolved.length === 0,
    findings: judged.findings,
    unresolved: judged.unresolved,
  };
}

/**
 * Runs the `health` command: derives the metrics from the resolved command
 * context, reads the trend snapshots, and builds the report.
 *
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {{config?: object|null, intent?: object|null, trendDir?: string|null,
 *   readSnapshots?: Function}} [io]
 *   `config` is the loaded boundary law (or `null` when the workspace provides
 *   none — the same loading `check`/`graph` do, so `--config` in `cli.mjs`
 *   overrides the workspace's own). `intent` is the loaded intent model (or
 *   `null`). `trendDir` names the snapshot directory for trends, optional —
 *   health reports trends only when one is given. `readSnapshots` is
 *   injectable so a test drives trends without the filesystem.
 * @returns {{status: "ok"|"no-verdict", metrics: object, trends: object|null,
 *   coverage: object, report: {text: string, json: string}}}
 * @throws {Error} when the trend directory cannot be read (the same malformed
 *   snapshot dir condition `history` exits 3 on).
 */
export function healthCommand(commandContext, io = {}) {
  const { root, provider, marker, graph, analysis, pluginGap } = commandContext;
  const config = io.config === undefined ? null : io.config;
  const intent = io.intent === undefined ? null : io.intent;

  const projects = buildProjects(graph.nodes);
  const edges = buildDependencies(graph.dependencies);

  // The run's coverage facts, the same shape every command's envelope carries.
  // An unresolvable site is a fact the run saw but never judged (#595) —
  // metrics measured over it would read precision the run does not have,
  // so it defeats file completeness the way a whole-file failure does.
  const fileComplete =
    analysis.failures.filter(isWholeFileFailure).length === 0 &&
    unresolvableLiteralCount(analysis.failures) === 0;
  // The graph is complete only when the files are AND the graph actually sees
  // every polyglot edge — an Nx workspace with an unregistered plugin carries
  // a graph with no Go/Rust/Python edges, which `graph`/`impact` refuse and
  // health must report `unknown` rather than measure.
  const graphComplete =
    fileComplete && !(provider === "nx" && !pluginGap.registered && pluginGap.manifests.length > 0);
  const coverage = {
    complete: fileComplete,
    projects: projects.length,
    analyzedFiles: analysis.analyzed,
    imports: analysis.imports.length,
    notAnalyzed: analysis.failures
      .filter(isWholeFileFailure)
      .map(({ sourceFile, reason }) => ({ file: sourceFile, reason })),
    blindSpots: blindSpotRows(analysis.failures),
    notes: graphComplete
      ? []
      : [
          "the Nx plugin is not registered for polyglot manifests — the graph carries no " +
            "Go/Rust/Python edges, so edge, cycle and boundary metrics read unknown",
        ],
  };

  const graphCoverage = { ...coverage, complete: graphComplete };
  const structural = structuralMetrics({ projects, edges }, coverage, graphComplete);
  const boundary = boundaryMetrics(analysis.imports, graph, config, graphCoverage);
  const intentVerd = intentVerdict(commandContext, intent);
  const fitness = intentMetric(intentVerd);
  const coupling = couplingMetrics(projects, edges, graphCoverage);
  const debt = debtMetric(config);

  const metrics = {
    projects: structural.projects,
    edges: structural.edges,
    coverage: structural.coverage,
    violations: boundary.violations,
    waiverSurface: boundary.waiverSurface,
    cycles: coupling.cycles,
    edgeDensity: coupling.edgeDensity,
    debt: debt,
    fitness: fitness,
  };

  // A run with any `unknown` metric is a no-verdict: it could not fully inspect
  // its own evidence, so the healthy claim it would make is not one it can
  // establish. `not_applicable` is fine (a metric with nothing to measure is
  // not a gap); `unknown` is exactly the gap.
  const hasUnknown = Object.values(metrics).some((m) => m.verdict === "unknown");
  const status = hasUnknown ? "no-verdict" : "ok";

  // Trends: the same structural metrics over the snapshots `history` reads.
  // A trend is available only when a snapshot directory is named, and it is
  // limited to what a `graph` snapshot carries — rule-impact cannot be
  // re-derived from stored bytes.
  let trends = null;
  if (io.trendDir) {
    const read = io.readSnapshots
      ? io.readSnapshots(io.trendDir)
      : readSnapshots(io.trendDir, root);
    trends = {
      snapshots: read.files.map((f) => ({
        name: f.name,
        projects: f.envelope.result.projects.length,
        dependencies: f.envelope.result.dependencies.length,
      })),
      notes: [
        "rule-impact metrics (violations, waivers, debt, fitness) cannot be re-derived from " +
          "stored snapshots — snapshots carry the graph and the policy fingerprint, not the " +
          "constraint table or import sites. Run `check` at any commit for those.",
      ],
    };
  }

  const context = { root, provider, marker, provenance: resolveProvenance(root) };
  const result = {
    trendDir: io.trendDir ?? null,
    metrics,
    trends,
  };

  const envelope = jsonEnvelope({
    command: "health",
    context,
    status,
    exitCode: status === "ok" ? 0 : 3,
    coverage,
    result,
  });

  return {
    status,
    metrics,
    trends,
    coverage,
    report: {
      text: formatHealthReport({ metrics, trends, coverage }),
      json: renderJson(envelope),
    },
  };
}
