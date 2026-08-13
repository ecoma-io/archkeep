/**
 * The terminal report for the `impact` command: reverse reachability from the
 * project graph.
 *
 * Each dependent project is listed as a single line, grouped under the target
 * project. A project with no dependents renders the header and a "0" count
 * rather than an omitted section, because "nothing depends on this" and "the
 * renderer forgot" look identical otherwise — the same reasoning as
 * `./graph-text.mjs`'s `(no dependencies)` line.
 *
 * The coverage claim sits ABOVE the listing, not below it, so the reader knows
 * whether the result is complete before reading any entry — an incomplete
 * impact set printed in full would have the "this may under-represent" warning
 * buried at the bottom.
 *
 * This module decides nothing. A formatter that filtered would be a rule
 * wearing a formatter's name (`../README.md`).
 */

/**
 * The whole impact report.
 *
 * @param {{impact: {project: string, direct: string[], transitive: string[],
 *   dependents: string[]}, coverage: object}} input
 * @returns {string}
 */
export function formatImpactReport({ impact, coverage }) {
  const sections = [];

  // Coverage claim goes FIRST — above the listing — so the reader knows
  // whether the impact set is complete before reading any entry.
  const inspected =
    `${coverage.imports} import${coverage.imports === 1 ? "" : "s"} in ` +
    `${coverage.analyzedFiles} file${coverage.analyzedFiles === 1 ? "" : "s"} across ` +
    `${coverage.projects} project${coverage.projects === 1 ? "" : "s"}`;

  if (coverage.complete) {
    sections.push(`✔ impact complete (${inspected})`);
  } else {
    const notAnalyzedCount = coverage.notAnalyzed.length;
    sections.push(
      `✖ impact incomplete — ${notAnalyzedCount} file${notAnalyzedCount === 1 ? "" : "s"} ` +
        `could not be analyzed, so this impact set may under-represent the real architecture (${inspected})`,
    );
  }

  // Header names the target project
  sections.push(`Impact of ${impact.project}`);

  // List dependents — each on its own line
  if (impact.dependents.length > 0) {
    for (const name of impact.dependents) {
      sections.push(`  ${name}`);
    }
  }

  // Summary line: total, with direct and transitive broken out.
  // A project with 0 dependents states "0 project(s) depend on" — an
  // explicit claim, never silence.
  const total = impact.dependents.length;
  const directCount = impact.direct.length;
  const transitiveCount = impact.transitive.length;

  const projectWord = total === 1 ? "project" : "projects";
  const verbWord = total === 1 ? "depends" : "depend";
  sections.push(
    `${total} ${projectWord} ${verbWord} on ${impact.project} (direct: ${directCount}, transitive: ${transitiveCount})`,
  );

  return sections.join("\n");
}
