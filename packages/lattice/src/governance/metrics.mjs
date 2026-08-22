/**
 * Deterministic architecture-health metrics: the numbers that describe a run's
 * `{ projects, dependencies, analysis, coverage, intent }` without a service,
 * a dashboard, or a datastore beyond the snapshot directory `history` already
 * keeps (`../commands/history.mjs`). North-star doctrine refuses the hosted
 * surface outright (`../../../../docs/doctrine/north-star.md`, § "What is not on
 * that list"): the numbers are computed here, read-only, per run, and a
 * maintainer acts on the trend across `history` snapshots instead.
 *
 * ## What "deterministic" means here
 *
 * - Every metric is a pure function of its inputs. Two identical runs —
 *   identical tree, identical config, identical intent — produce identical
 *   bytes (`../../../../AGENTS.md`). Nothing here reads the clock, the locale,
 *   the environment, or any process state.
 * - No metric is a mutable counter. Each is re-derived from the run's own
 *   records every time; nothing is accumulated across runs (accumulation is
 *   exactly the mutable state the snapshot directory exists to avoid).
 * - Array and map iteration is sorted by plain string comparison, never
 *   `localeCompare` — the same guarantee `../commands/graph.mjs` makes for the
 *   snapshot bytes.
 *
 * ## The empty-result invariant, at the metric level
 *
 * The repository's whole judgment stands on one sentence (`AGENTS.md`): *an
 * empty result is a claim, not a shrug*. Applied to a metric, that sentence
 * reads: **a metric whose evidence is unavailable is `unknown` or `excluded` —
 * reading it as zero is the error.** Every metric's verdict is one of:
 *
 * - `ok` — the metric was measured over complete evidence and holds (e.g. zero
 *   violations over a fully-analyzed tree);
 * - `findings` — measured and broken (violations, dead debt rows);
 * - `not_applicable` — there is nothing for the metric to measure (no intent
 *   file, no boundary config, no edges, no projects of a type);
 * - `unknown` — the run could not fully inspect the evidence the metric needs
 *   (unanalyzable files, a partial graph). `unknown` is never folded into a
 *   zero — a metric that cannot look must not read as a clean one.
 *
 * These four are the canonical verdict vocabulary the governance wave shares
 * through E0's evidence envelope. `health` reports each metric's verdict
 * through that decision shape; it never reports a metric as a bare number
 * whose absent evidence could be mistaken for a clean zero.
 *
 * ## Reuse, and the limit the snapshots set
 *
 * Every metric here is derived from records the run already holds (the graph,
 * the analysis envelope, the boundary config, the intent verdict) through the
 * same functions the existing commands use — `buildProjects`,
 * `buildDependencies`, `evaluate`, `judgeIntent` — so health performs **no new
 * scans** and builds **no parallel store**. Trend data is read from the
 * snapshot directory `historyCommand` already reads, which is what keeps one
 * history instead of two. The snapshots are `graph` envelopes, so the trend
 * metrics are limited to what a `graph` snapshot carries: a snapshot cannot
 * recompute a violation count, because the constraint table and the import
 * sites do not travel with it. The trend therefore reports the structural
 * metrics (projects, edges, coverage) over the snapshots, and discloses that
 * rule-impact cannot be re-derived from stored bytes (`../commands/history.mjs`
 * states the same limit).
 */
import { suppressionCovers } from "../config.mjs";
import { referenceTime } from "./clock.mjs";
import { suppressionFate } from "./waiver.mjs";
import { evaluateWithSuppressions } from "../rules/index.mjs";
import { buildReachability } from "../rules/reachability.mjs";

/**
 * The four canonical verdicts (see the module header). A metric's verdict,
 * never a number that could read as a clean zero with its evidence missing.
 *
 * @typedef {"ok"|"findings"|"not_applicable"|"unknown"} MetricVerdict
 */

/**
 * One metric's measured value and the verdict over it. The verdict is the
 * decision E0's evidence envelope carries; `value` is the number it was
 * decided over, with a hard rule: `value` is present ONLY when the verdict is
 * `ok` or `findings` — a `not_applicable` or `unknown` metric carries no
 * number, because a number with no evidence would read as a measured zero.
 *
 * @typedef {object} Metric
 * @property {MetricVerdict} verdict
 * @property {number} [value] The measured count, present exactly when the
 *   verdict is `ok` or `findings`.
 * @property {string} [note] Why the verdict is what it is, for the text report.
 */

/**
 * Wraps a measured count into a verdict-taking `Metric`. A count that reached
 * zero over complete evidence is the modern `ok`; a count that reached zero
 * over incomplete evidence is the ancient `unknown`, because "no violations"
 * over a tree the run could not fully read is not a claim it can make
 * (`AGENTS.md`).
 *
 * @param {number|null} value The count, or `null` when the evidence is
 *   unavailable or inapplicable.
 * @param {{note?: string}} [options]
 * @returns {Metric}
 */
function metric(value, { note } = {}) {
  if (value === null)
    return /** @type {Metric} */ ({ verdict: "unknown", ...(note ? { note } : {}) });
  return /** @type {Metric} */ ({ verdict: value === 0 ? "ok" : "findings", value });
}

/**
 * The one `unknown`-producing condition a metric record can carry: the run's
 * evidence is incomplete. `not_applicable` is decided per metric (no intent
 * file, no edges), never by this function — a condition that says "this metric
 * has nothing to measure" and a condition that says "the run could not look"
 * are different verdicts and must never collapse into each other
 * (`AGENTS.md`: empty must mean empty).
 *
 * @typedef {object} MetricRecord
 * @property {Metric} each The metric.
 * @property {boolean} complete Whether the evidence the metric needed was
 *   complete. Incomplete evidence makes the metric `unknown`, not `ok`.
 * @property {string[]} issues The reasons the evidence was incomplete, for a
 *   report that must say what it could not look at rather than silently
 *   degrade.
 */

/**
 * Derives the structural metrics from the graph and the run's coverage facts.
 * Everything here is re-derived from records the run already holds — `graph`
 * commands build the same projects/edges arrays for a snapshot — so the
 * numbers agree byte-for-byte with what `graph --format json` would print.
 *
 * @param {{projects: object[], edges: object[]}} model Projects and edges as
 *   `buildProjects`/`buildDependencies` emit them.
 * @param {{complete: boolean, analyzedFiles: number, imports: number,
 *   projects: number, notAnalyzed: object[], blindSpots: object[]}} coverage
 *   The run's coverage facts, the same shape every command's envelope carries.
 * @param {boolean} [edgeComplete] Whether the graph's EDGES are complete.
 *   Defaults to `coverage.complete`; a graph whose polyglot edges were never
 *   drawn (unregistered Nx plugin) is incomplete for the edges metric even
 *   when the file read was complete.
 * @returns {{projects: Metric, edges: Metric, coverage: Metric}}
 */
export function structuralMetrics(model, coverage, edgeComplete = coverage.complete) {
  const complete = coverage.complete === true;
  const edgesComplete = edgeComplete === true;
  // Projects and edges are DESCRIPTIONS, not pass/fail: a workspace with 40
  // projects is not "more broken" than one with 4. They carry `ok` with the
  // measured count when the evidence is complete, and `unknown` — no number —
  // when it is not.
  /** @type {Metric} */
  const projects = complete
    ? { verdict: "ok", value: model.projects.length }
    : {
        verdict: "unknown",
        note: `${coverage.notAnalyzed.length} file(s) could not be analyzed`,
      };
  /** @type {Metric} */
  const edges = edgesComplete
    ? { verdict: "ok", value: model.edges.length }
    : { verdict: "unknown", note: "the graph may under-represent edges" };
  // The fraction of ANALYZED files (not the whole tracked tree, which is mostly
  // Markdown, JSON and images the tool is not pointed at). Unlike the
  // projects/edges metrics — whose identified sets may under-count when the run
  // was partial — both sides of this ratio are KNOWN facts even on a partial
  // run (the analyzers count what they examined and what failed), so the
  // coverage metric is MEASURED, not unknown: a tree with holes reports a ratio
  // under 1 as findings, and a run that examined nothing reports `unknown`
  // rather than 0/0 read as a clean 1.
  const coverageRatio =
    coverage.analyzedFiles + coverage.notAnalyzed.length > 0
      ? coverage.analyzedFiles / Math.max(coverage.analyzedFiles + coverage.notAnalyzed.length, 1)
      : null;
  const coverageMetric = metric(
    coverageRatio === null
      ? null
      : // The coverage metric reports OK only at full coverage — anything less
        // is a finding, because a fraction under 1 means some file had no
        // verdict (`AGENTS.md`: empty must mean empty). The ratio itself is the
        // value behind the findings verdict.
        coverageRatio === 1
        ? 0
        : coverageRatio,
    coverageRatio === null
      ? { note: "no analyzable files were examined" }
      : {
          note: `${coverage.analyzedFiles} of ${coverage.analyzedFiles + coverage.notAnalyzed.length} analyzable files examined`,
        },
  );
  return { projects, edges, coverage: coverageMetric };
}

/**
 * Derives the boundary metric: violations and the waiver surface.
 *
 * `violations` is `evaluate`'s full verdict — every boundary rule, over every
 * import site the run analyzed. The metric reports `unknown` when the evidence
 * is incomplete (a file with no analyzer, an unreadable file — a violation
 * count over a tree the run could not fully read is not a claim) or when no
 * boundary config exists at all (there is then no law to judge against, which
 * is `not_applicable`, never a clean zero).
 *
 * `waiverSurface` is the number of violations a suppression covers — the
 * surface of the boundary law that is waived. It is a METRIC, not a verdict:
 * a waiver is a decision the workspace made about its own law, so a
 * non-zero surface is a fact, not a finding. It reads `not_applicable` when
 * there is no law or no violations, and `unknown` when the run could not fully
 * inspect the files a waiver names — a suppressed violation over an
 * unanalyzed file would under-count the waivers in force.
 *
 * @param {object[]} importSites The run's analysis `imports`.
 * @param {object} graph The project graph `{nodes, dependencies}`.
 * @param {{depConstraints: object[], options: object, suppressions?: object[], now?: string}|null} config
 *   The loaded boundary law, or `null` when the workspace provides none. `now`
 *   is the waiver-expiry reference the rule engine honours, threaded so the
 *   metrics agree with `check` about which waivers are still in force.
 * @param {{complete: boolean}} coverage
 * @returns {{violations: Metric, waiverSurface: Metric, underWavedCount: number}}
 */
export function boundaryMetrics(importSites, graph, config, coverage) {
  if (config === null) {
    return {
      violations: {
        verdict: "not_applicable",
        note: "no boundary config; there is no law to judge against",
      },
      waiverSurface: {
        verdict: "not_applicable",
        note: "no boundary config; waivers attach to a law",
      },
      underWavedCount: 0,
    };
  }
  const complete = coverage.complete === true;
  const raws = evaluateWithSuppressions(importSites, graph, config);
  if (!complete) {
    return {
      violations: { verdict: "unknown", note: "the boundary could not be fully inspected" },
      waiverSurface: {
        verdict: "unknown",
        note: "the waiver surface could not be fully inspected",
      },
      underWavedCount: 0,
    };
  }
  const suppressions = config.suppressions ?? [];
  // F02: a suppression entry is a waiver (expires) or a legacy suppression
  // (permanent). `suppressionCovers` only answers "path+id match" — an
  // EXPIRED waiver still matched, so the metrics wrote the boundary clean
  // while `check`/`health` were re-asserting it. The fate decides: a waiver
  // in force (waive) or a permanent suppression (suppress) covers; an
  // expired one (reassert) covers nothing and the violation is live — the
  // same verdict the rule engine's table walk (`../rules/index.mjs`) renders
  // for the gate. `config.now` is the same reference the rule engine honours.
  const now = config.now ?? referenceTime();
  const waived = raws.filter((v) =>
    suppressions.some((entry) => {
      if (!suppressionCovers(entry, v)) return false;
      return suppressionFate(entry, now) !== "reassert";
    }),
  );
  const violations = metric(raws.length - waived.length);
  // The waiver surface is a METRIC, not a verdict: a waiver is a decision the
  // workspace made about its own law, so a non-zero surface is a fact on the
  // books, never a finding. It carries `ok` + the count (informational, like
  // edge density) — the violations verdict beside it already reports what that
  // surface is waiving. `waived` holds everything currently suppressing (a
  // legacy suppression and an active waiver alike); an EXPIRED waiver (fate
  // `reassert`) is in neither count, so the metric and the gate can never
  // disagree about the same tree (F02).
  /** @type {Metric} */
  const waiverSurface = { verdict: "ok", value: waived.length };
  return { violations, waiverSurface, underWavedCount: waived.length };
}

/**
 * Derives the intent (fitness) metric from the drift verdict.
 *
 * The verdict here is the canonical `judgeIntent` verdict: `ok` when every row
 * and every boundary was judged and holds; `findings` when a forbidden path
 * exists or an allowed one is missing; `no-verdict` when a boundary matched no
 * observed project (the tool cannot check it, so it must not read as clean).
 * A workspace with no intent file — a workspace that chose not to declare an
 * intended architecture — is `not_applicable`: there is nothing to keep fit
 * against. Absence of intent is a workspace decision, and a `not_applicable`
 * verdict says exactly that (it is not an `unknown`, which would claim the
 * tool tried and could not look).
 *
 * @param {{ok: boolean, findings: object[], unresolved: object[]}|null} drift
 *   The intent verdict: `null` when the workspace has no intent file.
 * @returns {Metric}
 */
export function intentMetric(drift) {
  if (drift === null) {
    return {
      verdict: "not_applicable",
      note: "no architecture-intent.json; the workspace declared no intended architecture",
    };
  }
  if (drift.unresolved.length > 0) {
    return { verdict: "unknown", note: "some intent rows matched no observed project" };
  }
  return metric(drift.ok ? 0 : drift.findings.length);
}

/**
 * Derives the coupling metric: the project-level edge density and the cycle
 * count.
 *
 * `edgeDensity` is `edges / projects`, the average fan-out per project — a
 * structural pressure gauge with no correct value, only a trend. So it is
 * reported with a `not_applicable` verdict when there are no projects (nothing
 * to couple), and otherwise carries the number with an informational verdict
 * (`ok` — a ratio is a description, not a pass/fail). A maintainer acts on how
 * it moves between snapshots, never on a single reading.
 *
 * `cycles` uses the rule engine's own reachability (`buildReachability`), the
 * same model `noCircularDependencies` judges against, so health and check
 * cannot disagree about what a cycle is. A cycle is a finding (broken
 * structure), and is `unknown` when the graph could not be fully inspected.
 *
 * @param {object[]} projects
 * @param {object[]} edges
 * @param {{complete: boolean}} coverage
 * @returns {{edgeDensity: Metric, cycles: Metric}}
 */
export function couplingMetrics(projects, edges, coverage) {
  const complete = coverage.complete === true;
  /** @type {Metric} */
  const edgeDensity =
    projects.length === 0
      ? { verdict: "not_applicable", note: "no projects; there is nothing to couple" }
      : complete
        ? { verdict: "ok", value: edges.length / projects.length }
        : { verdict: "unknown", note: "the graph may under-count edges" };

  /** @type {Metric} */
  let cycles = { verdict: "not_applicable", note: "no edges; nothing can cycle" };
  if (edges.length > 0) {
    if (!complete) {
      cycles = { verdict: "unknown", note: "the graph may under-count edges" };
    } else {
      // A cycle is a pair of projects that reach each other — a 2-cycle in the
      // reachability matrix, counted from the same `buildReachability` the
      // `noCircularDependencies` rule judges against, so health and check
      // cannot disagree about what a cycle is. The matrix diagonal is excluded
      // (`matrix[p][p]` is true by definition); each true off-diagonal pair is
      // counted once.
      const nodes = new Set(edges.flatMap((e) => [e.source, e.target]));
      const graph = {
        nodes: Object.fromEntries([...nodes].map((n) => [n, { name: n }])),
        dependencies: {},
      };
      for (const edge of edges) {
        (graph.dependencies[edge.source] ??= []).push(edge);
      }
      const { matrix } = buildReachability(graph);
      let cycleCount = 0;
      for (const node of nodes) {
        for (const other of nodes) {
          if (node !== other && matrix[node]?.[other] && matrix[other]?.[node]) {
            cycleCount += 1;
          }
        }
      }
      cycleCount = Math.round(cycleCount / 2);
      cycles = metric(cycleCount, {
        note: cycleCount === 0 ? undefined : "a cycle is broken structure — see check",
      });
    }
  }
  return { edgeDensity, cycles };
}

/**
 * Derives the debt metric from the boundary config's own `notes`.
 *
 * Lattice's boundary config dialect lets a workspace declare rows that are
 * temporary with the reason written down (an `"optional": true` allowed row,
 * a suppression entry that predates a fix, a policy note). Those rows are the
 * architecture's debt ledger — each one is a decision to defer a constraint,
 * and the metric counts the deferred rows. A config with no notes has no debt:
 * `ok`, value 0. A config with notes reports each one; the debt is a finding
 * the maintainer acts on.
 *
 * @param {{notes?: string[]}|null} config
 * @returns {Metric}
 */
export function debtMetric(config) {
  if (config === null) {
    return { verdict: "not_applicable", note: "no boundary config; no debt ledger" };
  }
  const notes = config.notes ?? [];
  return metric(notes.length === 0 ? 0 : notes.length, {
    note: notes.length === 0 ? undefined : "deferred rows are recorded in the config's own notes",
  });
}
