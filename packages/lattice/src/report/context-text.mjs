/**
 * The terminal report for the `context` command: the architecture constraints
 * that apply to a project.
 *
 * The project's tags are listed first, then each matching constraint row
 * rendered the same way `./text.mjs`'s `formatConstraint` renders them — a
 * reader who has seen a violation's constraint line in `check` output
 * recognises the same shape here. When a constraint row carries `description`
 * or `remediation`, those appear indented below the row.
 *
 * A project with no tags states so explicitly — "no tags" — because a project
 * with no tags and a renderer that printed nothing would be indistinguishable
 * (`AGENTS.md`: "an empty result is a claim, not a shrug"). A project whose
 * tags match no constraint row states that too: the `check` command would
 * flag it as `projectWithoutTagsCannotHaveDependencies`, so a reader seeing
 * "(no matching constraint rows)" knows the project is unconstrained rather
 * than the command having failed to look.
 *
 * The coverage claim sits ABOVE the listing, not below it, so the reader
 * knows whether the result is complete before reading any entry — the same
 * reasoning as `./impact-text.mjs`.
 *
 * This module decides nothing. A formatter that filtered would be a rule
 * wearing a formatter's name (`../README.md`).
 */

import { formatConstraint } from "./text.mjs";

/** Two spaces of indent for detail lines. */
const DETAIL = "  ";

/**
 * The whole context report.
 *
 * @param {{projectContext: {project: string, tags: string[], constraints: object[]},
 *   coverage: object}} input
 * @returns {string}
 */
export function formatContextReport({ projectContext, coverage }) {
  const sections = [];

  // Coverage claim goes FIRST — above the listing — so the reader knows
  // whether the context is complete before reading any entry.
  const inspected =
    `${coverage.imports} import${coverage.imports === 1 ? "" : "s"} in ` +
    `${coverage.analyzedFiles} file${coverage.analyzedFiles === 1 ? "" : "s"} across ` +
    `${coverage.projects} project${coverage.projects === 1 ? "" : "s"}`;

  if (coverage.complete) {
    sections.push(`✔ context complete (${inspected})`);
  } else {
    const notAnalyzedCount = coverage.notAnalyzed.length;
    sections.push(
      `✖ context incomplete — ${notAnalyzedCount} file${notAnalyzedCount === 1 ? "" : "s"} ` +
        `could not be analyzed, so these constraints may be against an incomplete graph (${inspected})`,
    );
  }

  // Project name and tags.
  const tagsText = projectContext.tags.length > 0 ? projectContext.tags.join(", ") : "none";
  sections.push(`Project  ${projectContext.project}`);
  sections.push(`Tags     ${tagsText}`);

  // Constraint rows.
  if (projectContext.constraints.length > 0) {
    const count = projectContext.constraints.length;
    sections.push(
      `Constraints (${count} row${count === 1 ? "" : "s"} match${count === 1 ? "es" : ""}):`,
    );
    for (const constraint of projectContext.constraints) {
      sections.push(`${DETAIL}${formatConstraint(constraint)}`);
      if (constraint.description) {
        sections.push(`${DETAIL}  description  ${constraint.description}`);
      }
      if (constraint.remediation) {
        sections.push(`${DETAIL}  remediation   ${constraint.remediation}`);
      }
    }
  } else {
    sections.push(
      "Constraints  (no matching constraint rows — this project's tags match no depConstraints entry)",
    );
  }

  return sections.join("\n");
}
