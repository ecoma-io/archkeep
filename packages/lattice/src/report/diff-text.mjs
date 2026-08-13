/**
 * The terminal report for the `diff` command: two graph snapshots compared.
 *
 * Each section — added projects, removed projects, added edges, removed edges —
 * is printed only when it has content, and always ends with a count. A section
 * with zero entries is absent from the report, and the summary line then names
 * "no changes" rather than "0 added, 0 removed" — the two must never look
 * identical, because "no changes" is a claim about a complete comparison while
 * "0 added, 0 removed" would be ambiguous over a partial one
 * (`../../../../AGENTS.md`).
 *
 * This module decides nothing. A formatter that filtered would be a rule
 * wearing a formatter's name (`../README.md`).
 */

/**
 * One project as a line, same shape as `graph-text.mjs`.
 *
 * @param {{name: string, root: string, tags: string[]}} project
 * @returns {string}
 */
function formatProject(project) {
  const tags = project.tags.length > 0 ? ` [${project.tags.join(", ")}]` : "";
  return `  ${project.name}  ${project.root}${tags}`;
}

/**
 * One edge as a line, same shape as `graph-text.mjs`.
 *
 * @param {{source: string, target: string, type: string}} edge
 * @returns {string}
 */
function formatEdge(edge) {
  return `  ${edge.source} → ${edge.target} (${edge.type})`;
}

/**
 * The whole diff report.
 *
 * @param {{diff: object, coverage: object}} input
 * @returns {string}
 */
export function formatDiffReport({ diff, coverage }) {
  const sections = [];

  // Baseline summary
  sections.push(
    `baseline  ${diff.baseline.path} — ${diff.baseline.projects} projects, ` +
      `${diff.baseline.edges} edges`,
  );
  sections.push(`head      ${diff.head.projects} projects, ${diff.head.edges} edges`);

  const hasChanges =
    diff.addedProjects.length > 0 ||
    diff.removedProjects.length > 0 ||
    diff.addedEdges.length > 0 ||
    diff.removedEdges.length > 0;

  if (hasChanges) {
    if (diff.addedProjects.length > 0) {
      const word = diff.addedProjects.length === 1 ? "project" : "projects";
      sections.push(`+ ${diff.addedProjects.length} added ${word}`);
      for (const project of diff.addedProjects) {
        sections.push(formatProject(project));
      }
    }

    if (diff.removedProjects.length > 0) {
      const word = diff.removedProjects.length === 1 ? "project" : "projects";
      sections.push(`- ${diff.removedProjects.length} removed ${word}`);
      for (const project of diff.removedProjects) {
        sections.push(formatProject(project));
      }
    }

    if (diff.addedEdges.length > 0) {
      const word = diff.addedEdges.length === 1 ? "edge" : "edges";
      sections.push(`+ ${diff.addedEdges.length} added ${word}`);
      for (const edge of diff.addedEdges) {
        sections.push(formatEdge(edge));
      }
    }

    if (diff.removedEdges.length > 0) {
      const word = diff.removedEdges.length === 1 ? "edge" : "edges";
      sections.push(`- ${diff.removedEdges.length} removed ${word}`);
      for (const edge of diff.removedEdges) {
        sections.push(formatEdge(edge));
      }
    }
  }

  // The summary line states what was compared, so "no changes" reads as a
  // claim about coverage, not as silence.
  const inspected =
    `${coverage.imports} import${coverage.imports === 1 ? "" : "s"} in ` +
    `${coverage.analyzedFiles} file${coverage.analyzedFiles === 1 ? "" : "s"} across ` +
    `${coverage.projects} project${coverage.projects === 1 ? "" : "s"}`;

  if (!hasChanges) {
    sections.push(`✔ no changes between baseline and head (${inspected})`);
  } else {
    const totalChanges =
      diff.addedProjects.length +
      diff.removedProjects.length +
      diff.addedEdges.length +
      diff.removedEdges.length;
    sections.push(
      `${totalChanges} change${totalChanges === 1 ? "" : "s"} between baseline and head (${inspected})`,
    );
  }

  return sections.join("\n");
}
