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
 */

/** The verdict word, aligned to a column, with a mark that reads at a glance. */
function verdictLine(verdict, name, metric) {
  const value = metric.value === undefined ? "" : `  ${metric.value}`;
  const note = metric.note ? `  (${metric.note})` : "";
  return `  ${verdict.padEnd(16)}${name}${value}${note}`;
}

/**
 * The whole health report.
 *
 * @param {{metrics: object, trends: object|null, coverage: object}} input
 * @returns {string}
 */
export function formatHealthReport({ metrics, trends, coverage }) {
  const sections = [];

  const inspected =
    `${coverage.imports} import${coverage.imports === 1 ? "" : "s"} in ` +
    `${coverage.analyzedFiles} file${coverage.analyzedFiles === 1 ? "" : "s"} across ` +
    `${coverage.projects} project${coverage.projects === 1 ? "" : "s"}`;

  if (coverage.complete) {
    sections.push(`✔ health over complete coverage (${inspected})`);
  } else {
    const notAnalyzedCount = coverage.notAnalyzed.length;
    sections.push(
      `✖ health over incomplete coverage — ${notAnalyzedCount} file${notAnalyzedCount === 1 ? "" : "s"} ` +
        `could not be analyzed, so the metrics that needed them read unknown (${inspected})`,
    );
  }

  const ORDER = [
    ["projects", "projects"],
    ["edges", "edges"],
    ["coverage", "coverage"],
    ["violations", "violations"],
    ["waiverSurface", "waiver surface"],
    ["cycles", "cycles"],
    ["edgeDensity", "edge density"],
    ["debt", "debt rows"],
    ["fitness", "intent fitness"],
  ];
  for (const [key, label] of ORDER) {
    sections.push(verdictLine(metrics[key].verdict, label, metrics[key]));
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
