/**
 * The terminal report for the `graph` command: the project graph as readable
 * text.
 *
 * Each project lists its outgoing edges beneath it — the reading order an
 * architect uses ("what does this project reach?"). A project with no
 * dependencies renders `(no dependencies)` rather than an omitted section,
 * because a project with no edges and a project the renderer forgot look
 * identical otherwise — the same reasoning as `./text.mjs`'s
 * `formatGoWork` clean-result line.
 *
 * The coverage claim sits ABOVE the listing, not below it, so the reader knows
 * whether the snapshot is complete before reading any entry — an incomplete
 * snapshot printed in full would have the "this may under-represent" warning
 * buried at the bottom. Under an incomplete claim sit the reason clauses the
 * run withheld the verdict over, worded by `../verdict.mjs`'s
 * `coverageIncompleteReasons` and rendered through `./text.mjs`'s
 * `formatCoverageIncomplete` — the same clauses, in the same `⚠` rendering,
 * `check`'s text report prints, so a terminal reader is told why the verdict
 * is withheld whichever face ran. A zero-analysis run is the case that needs
 * this: its `notAnalyzed` list is empty, so a count-bearing headline would
 * blame zero failures for an incomplete snapshot.
 *
 * This module decides nothing. A formatter that filtered would be a rule
 * wearing a formatter's name (`../README.md`).
 */

import { formatCoverageIncomplete } from "./text.mjs";

/**
 * One project as a line: name, root, type, and tags.
 *
 * @param {{name: string, root: string, type?: string, tags: string[]}} project
 * @returns {string}
 */
function formatProject(project) {
  const type = project.type ? `  ${project.type}` : "";
  const tags = project.tags.length > 0 ? ` [${project.tags.join(", ")}]` : "";
  return `  ${project.name}  ${project.root}${type}${tags}`;
}

/**
 * One edge as a line: source -> target (type).
 *
 * @param {{source: string, target: string, type: string}} edge
 * @returns {string}
 */
function formatEdge(edge) {
  return `    → ${edge.target} (${edge.type})`;
}

/**
 * The whole graph report.
 *
 * @param {{projects: object[], dependencies: object[], workspaceLayout: object,
 *   workspaceLayoutSource: string, coverage: object,
 *   coverageIncomplete?: string[]}} input
 *   `coverageIncomplete` is the withheld-verdict clause list
 *   (`../verdict.mjs`'s `coverageIncompleteReasons`, handed through
 *   `../../commands/graph.mjs`) — rendered below the incomplete headline,
 *   empty exactly when the snapshot is complete, and optional because a
 *   complete snapshot carries no clauses to render.
 * @returns {string}
 */
export function formatGraphReport({
  projects,
  dependencies,
  workspaceLayout,
  workspaceLayoutSource,
  coverage,
  coverageIncomplete,
}) {
  const sections = [];

  // Coverage claim goes FIRST — above the listing — so the reader knows
  // whether the snapshot is complete before reading any entry.
  const inspected =
    `${coverage.imports} import${coverage.imports === 1 ? "" : "s"} in ` +
    `${coverage.analyzedFiles} file${coverage.analyzedFiles === 1 ? "" : "s"} across ` +
    `${coverage.projects} project${coverage.projects === 1 ? "" : "s"}`;

  if (coverage.complete) {
    sections.push(`✔ graph snapshot complete (${inspected})`);
  } else {
    // The headline states the incompleteness and its consequence; the clauses
    // below state WHY, one per failed coverage axis. Blaming the whole-file
    // count in the headline alone would read "0 files could not be analyzed"
    // over a zero-analysis run (#612) — incomplete, with a reason of nothing.
    sections.push(
      `✖ graph snapshot incomplete — this snapshot may under-represent the architecture (${inspected})`,
    );
    const clauses = formatCoverageIncomplete(coverageIncomplete ?? []);
    if (clauses !== "") sections.push(clauses);
  }

  // Layout line
  const layoutSource = workspaceLayoutSource === "declared" ? "declared in workspace" : "default";
  sections.push(`layout ${workspaceLayout.appsDir}/${workspaceLayout.libsDir} (${layoutSource})`);

  // Project count header
  const projectWord = projects.length === 1 ? "project" : "projects";
  sections.push(`${projects.length} ${projectWord}`);

  // Build per-project edge map for the dependency sub-lists
  const edgesBySource = new Map();
  for (const edge of dependencies) {
    let list = edgesBySource.get(edge.source);
    if (!list) {
      list = [];
      edgesBySource.set(edge.source, list);
    }
    list.push(edge);
  }

  // Each project lists its outgoing edges beneath it
  for (const project of projects) {
    sections.push(formatProject(project));
    const edges = edgesBySource.get(project.name);
    if (edges && edges.length > 0) {
      for (const edge of edges) {
        sections.push(formatEdge(edge));
      }
    } else {
      // A project with no dependencies still gets a line, so the reader can
      // tell the project exists from the report alone — the same reasoning
      // as `./text.mjs`'s `formatGoWork` clean-result line.
      sections.push("    (no dependencies)");
    }
  }

  // Flat edge count for summary
  const edgeWord = dependencies.length === 1 ? "edge" : "edges";
  sections.push(`${dependencies.length} ${edgeWord}`);

  return sections.join("\n");
}
