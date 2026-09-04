/**
 * The terminal report for the `discover` command: observed facts, and under
 * `--propose` the candidate architecture those facts imply.
 *
 * The coverage claim sits ABOVE everything — the reader knows whether the
 * observations are complete before reading any entry, exactly like
 * `./graph-text.mjs`'s report. Under an incomplete claim sit the reason
 * clauses the run withheld the verdict over, worded by
 * `../verdict.mjs`'s `coverageIncompleteReasons` and rendered through
 * `./text.mjs`'s `formatCoverageIncomplete` — the same clauses, in the
 * same `⚠` rendering, `check`'s text report prints, so a terminal reader is
 * told why the verdict is withheld whichever face ran. A zero-analysis run
 * is the case that needs this: its `notAnalyzed` list is empty, so a
 * count-bearing headline would blame zero failures for an incomplete
 * discovery (#619).
 *
 * The proposal, when present, is rendered below the observations with the
 * proposal-only banner (`proposed`, `not authoritative`) repeated on every
 * line of every candidate, so a reader who scans the report cannot mistake a
 * candidate for a decision.
 *
 * This module decides nothing. A formatter that filtered would be a rule
 * wearing a formatter's name (`../README.md`).
 */

import { formatCoverageIncomplete } from "./text.mjs";

/** The three confidence markers, in the order the legend prints them. */
const CONFIDENCE_ORDER = ["high", "medium", "low"];

/** One project as a line — the same shape `./graph-text.mjs` prints. */
function formatProject(project) {
  const type = project.type ? `  ${project.type}` : "";
  const tags = project.tags.length > 0 ? ` [${project.tags.join(", ")}]` : "";
  return `  ${project.name}  ${project.root}${type}${tags}`;
}

/** One edge as a line — the same shape `./graph-text.mjs` prints. */
function formatEdge(edge) {
  return `    → ${edge.target} (${edge.type})`;
}

const PROPOSAL_BANNER = "  [proposed — not authoritative] ";

/**
 * One proposal candidate as one or more lines, every line carrying the
 * proposal-only banner — never a bare candidate that could be read as a
 * decision.
 *
 * The four candidate lists hold different item shapes, so each is formatted by
 * the function that knows its shape rather than by one switch over a flat
 * array — a candidate's `kind` names its role inside its own list
 * (`"component"` means a shared-directory assertion inside
 * `boundaryAssertions.items`, a `"component"` component inside
 * `components.items`), which is why the lists are never concatenated.
 */

/** @param {{name: string, projects: string[], confidence: string}} item */
function formatComponent(item) {
  const confidence = item.confidence ? ` (${item.confidence} confidence)` : "";
  return [
    `${PROPOSAL_BANNER}component ${item.name}${confidence}`,
    `    members: ${item.projects.join(", ")}`,
  ];
}

/** @param {{component: string|undefined, source: string, target: string, confidence: string}} item */
function formatBoundaryAssertion(item) {
  const confidence = item.confidence ? ` (${item.confidence} confidence)` : "";
  return item.component !== undefined
    ? [`${PROPOSAL_BANNER}boundary: projects of ${item.component} share a role${confidence}`]
    : [
        `${PROPOSAL_BANNER}boundary: ${item.source} and ${item.target} belong to different components${confidence}`,
        `    evidence: edge ${item.source} → ${item.target}`,
      ];
}

/** @param {{axis: string|undefined, values: string[]|undefined, tag: string, members: string[], confidence: string}} item */
function formatTag(item) {
  const confidence = item.confidence ? ` (${item.confidence} confidence)` : "";
  return item.axis !== undefined
    ? [
        `${PROPOSAL_BANNER}tag axis ${item.axis}${confidence}`,
        `    values: ${(item.values ?? []).join(", ")}`,
      ]
    : [
        `${PROPOSAL_BANNER}tag ${item.tag}${confidence}`,
        `    members: ${(item.members ?? []).join(", ")}`,
      ];
}

/** @param {{kind: "noDependency"|"boundary", source: string, target: string, component: string, evidence: object[], confidence: string}} item */
function formatRule(item) {
  const confidence = item.confidence ? ` (${item.confidence} confidence)` : "";
  return item.kind === "noDependency"
    ? [`${PROPOSAL_BANNER}rule: ${item.source} must not depend on ${item.target}${confidence}`]
    : [
        `${PROPOSAL_BANNER}rule: declare a boundary around ${item.component}${confidence}`,
        `    members: ${item.evidence
          .filter((e) => e.kind === "shared-directory")
          .map((e) => e.project)
          .join(", ")}`,
      ];
}

/**
 * The whole discover report.
 *
 * @param {{discovery: {projects: object[], edges: object[], tags: string[]},
 *   proposal: object|null,
 *   coverage: object,
 *   coverageIncomplete?: string[]}} input
 *   `coverageIncomplete` is the withheld-verdict clause list
 *   (`../verdict.mjs`'s `coverageIncompleteReasons`, handed through
 *   `../commands/discover.mjs`) — rendered below the incomplete headline,
 *   empty exactly when the discovery is complete, and optional because a
 *   complete discovery carries no clauses to render.
 * @returns {string}
 */
export function formatDiscoverReport({ discovery, proposal, coverage, coverageIncomplete }) {
  const sections = [];

  const inspected =
    `${coverage.imports} import${coverage.imports === 1 ? "" : "s"} in ` +
    `${coverage.analyzedFiles} file${coverage.analyzedFiles === 1 ? "" : "s"} across ` +
    `${coverage.projects} project${coverage.projects === 1 ? "" : "s"}`;

  if (coverage.complete) {
    sections.push(`✔ discovery complete (${inspected})`);
  } else {
    // The headline states the incompleteness and its consequence; the clauses
    // below state WHY, one per failed coverage axis. Blaming the whole-file
    // count in the headline alone would read "0 files could not be analyzed"
    // over a zero-analysis run (#619) — incomplete, with a reason of nothing.
    sections.push(
      `✖ discovery incomplete — these observations may under-represent the workspace (${inspected})`,
    );
    const clauses = formatCoverageIncomplete(coverageIncomplete ?? []);
    if (clauses !== "") sections.push(clauses);
  }

  const projectWord = discovery.projects.length === 1 ? "project" : "projects";
  sections.push(`${discovery.projects.length} ${projectWord}`);

  const edgesBySource = new Map();
  for (const edge of discovery.edges) {
    let list = edgesBySource.get(edge.source);
    if (!list) {
      list = [];
      edgesBySource.set(edge.source, list);
    }
    list.push(edge);
  }

  for (const project of discovery.projects) {
    sections.push(formatProject(project));
    const edges = edgesBySource.get(project.name);
    if (edges && edges.length > 0) {
      for (const edge of edges) {
        sections.push(formatEdge(edge));
      }
    } else {
      sections.push("    (no dependencies)");
    }
  }

  const edgeWord = discovery.edges.length === 1 ? "edge" : "edges";
  sections.push(`${discovery.edges.length} ${edgeWord}`);

  if (discovery.tags.length > 0) {
    sections.push(`tags ${discovery.tags.join(", ")}`);
  } else {
    sections.push("tags (none observed)");
  }

  if (proposal) {
    sections.push("");
    sections.push("proposed architecture — NOT authoritative, never written");
    if (proposal.unknown) {
      sections.push("  no observed projects — nothing to propose");
    } else {
      const counts = [
        `${proposal.components.total} component${proposal.components.total === 1 ? "" : "s"}`,
        `${proposal.boundaryAssertions.total} boundary ` +
          `assertion${proposal.boundaryAssertions.total === 1 ? "" : "s"}`,
        `${proposal.tagVocabulary.total} tag candidate${proposal.tagVocabulary.total === 1 ? "" : "s"}`,
        `${proposal.rules.total} rule${proposal.rules.total === 1 ? "" : "s"}`,
      ];
      const confidenceLegend = CONFIDENCE_ORDER.map(
        (level) => `${level} (${proposal.uncertainty[level]})`,
      ).join(" · ");
      sections.push(`  ${counts.join(", ")}`);
      sections.push(`  confidence: ${confidenceLegend}`);

      const items = [
        ...proposal.components.items.map(formatComponent),
        ...proposal.boundaryAssertions.items.map(formatBoundaryAssertion),
        ...proposal.tagVocabulary.items.map(formatTag),
        ...proposal.rules.items.map(formatRule),
      ];
      for (const lines of items) {
        sections.push(...lines);
      }
    }
  }

  return sections.join("\n");
}
