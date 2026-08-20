/**
 * The terminal report for the `health` command: per-metric verdicts with the
 * number each was decided over, and the trend when a snapshot directory was
 * given.
 *
 * Each metric renders as a verdict word (`ok` / `findings` /
 * `not_applicable` / `unknown`) and — exactly when the metric MEASURED
 * something — the number behind it. A metric whose verdict is
 * `not_applicable` or `unknown` carries no number, because a number with no
 * evidence would read as a measured zero (`../../../../AGENTS.md`: an empty
 * result is a claim, not a shrug). The report states what each
 * `not_applicable` and each `unknown` could not measure, so nothing reads as a
 * silent gap.
 *
 * Determinism: the metric order is fixed, and the trend rows are the snapshots
 * in byte-sort order (`../commands/history.mjs` orders them). This module
 * decides nothing — a formatter that filtered would be a rule wearing a
 * formatter's name (`../README.md`).
 *
 * Three pieces below are exported rather than private, because `report`
 * renders the same metrics inside a larger document (`./report-text.mjs`) and
 * a second copy of "how a metric renders" is how the two faces would come to
 * disagree about the same verdict — the rule against stating a rule twice
 * (`../../../../AGENTS.md`), applied to a format. The metric ORDER travels
 * with them for the same reason: the order is part of the determinism claim,
 * not a per-renderer taste.
 */

/**
 * The metric line: the verdict word aligned to a column, the number exactly
 * when the metric measured one, and the note that says what an unmeasured
 * metric could not look at.
 *
 * `metric.value` is present ONLY for `ok`/`findings`
 * (`../governance/metrics.mjs` fixes that), so this function never has to
 * decide whether a number may be shown — it shows whatever the metric
 * carries, and a `not_applicable`/`unknown` metric carries none.
 *
 * @param {string} label The metric's display name.
 * @param {{verdict: string, value?: number, note?: string}} metric
 * @returns {string}
 */
export function formatMetricLine(label, metric) {
  const value = metric.value === undefined ? "" : `  ${metric.value}`;
  const note = metric.note ? `  (${metric.note})` : "";
  return `  ${metric.verdict.padEnd(16)}${label}${value}${note}`;
}

/**
 * The fixed metric order: which key of the metrics object each line renders,
 * and under what label. Fixed is the point — two runs over an unchanged tree
 * produce byte-identical reports only if nothing decides this order at render
 * time.
 *
 * @type {readonly {readonly key: string, readonly label: string}[]}
 */
export const HEALTH_METRIC_ORDER = Object.freeze([
  Object.freeze({ key: "projects", label: "projects" }),
  Object.freeze({ key: "edges", label: "edges" }),
  Object.freeze({ key: "coverage", label: "coverage" }),
  Object.freeze({ key: "violations", label: "violations" }),
  Object.freeze({ key: "waiverSurface", label: "waiver surface" }),
  Object.freeze({ key: "cycles", label: "cycles" }),
  Object.freeze({ key: "edgeDensity", label: "edge density" }),
  Object.freeze({ key: "debt", label: "debt rows" }),
  Object.freeze({ key: "fitness", label: "intent fitness" }),
]);

/**
 * The coverage headline: what the run inspected, and — when it could not
 * inspect everything — that the metrics which needed the missing evidence read
 * `unknown` rather than zero.
 *
 * `subject` names the command the headline belongs to, so `report` states its
 * own coverage in the same words `health` does without a second copy of them.
 *
 * @param {{complete: boolean, imports: number, analyzedFiles: number,
 *   projects: number, notAnalyzed: object[]}} coverage
 * @param {string} [subject]
 * @returns {string}
 */
export function formatCoverageHeadline(coverage, subject = "health") {
  const inspected =
    `${coverage.imports} import${coverage.imports === 1 ? "" : "s"} in ` +
    `${coverage.analyzedFiles} file${coverage.analyzedFiles === 1 ? "" : "s"} across ` +
    `${coverage.projects} project${coverage.projects === 1 ? "" : "s"}`;

  if (coverage.complete) return `✔ ${subject} over complete coverage (${inspected})`;

  const notAnalyzedCount = coverage.notAnalyzed.length;
  return (
    `✖ ${subject} over incomplete coverage — ${notAnalyzedCount} file${notAnalyzedCount === 1 ? "" : "s"} ` +
    `could not be analyzed, so the metrics that needed them read unknown (${inspected})`
  );
}

/**
 * The whole health report.
 *
 * @param {{metrics: object, trends: object|null, coverage: object}} input
 * @returns {string}
 */
export function formatHealthReport({ metrics, trends, coverage }) {
  const sections = [formatCoverageHeadline(coverage, "health")];

  for (const { key, label } of HEALTH_METRIC_ORDER) {
    sections.push(formatMetricLine(label, metrics[key]));
  }

  if (trends) {
    sections.push(
      `trends  ${trends.snapshots.length} snapshot${trends.snapshots.length === 1 ? "" : "s"}`,
    );
    for (const snapshot of trends.snapshots) {
      sections.push(
        `  ${snapshot.name}  ${snapshot.projects} projects, ${snapshot.dependencies} edges`,
      );
    }
    for (const note of trends.notes) sections.push(`  ${note}`);
  }

  return sections.join("\n");
}
