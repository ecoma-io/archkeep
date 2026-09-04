/**
 * Formatters two snapshot-transition reports share — `history-text.mjs` and
 * `evolution-text.mjs` render the same transition shape (a graph diff, notes,
 * and a short kind label), and a second copy of these helpers is where the
 * two renders would drift: one day "code drift" means one thing in `history`
 * and another in `evolution`, and no gate compares rendered prose.
 *
 * This module decides nothing. A formatter that filtered would be a rule
 * wearing a formatter's name (`../README.md`).
 */

/**
 * Neutralises control and terminal-escape sequences in a name or value before
 * it is printed, so a crafted project/tag/edge name cannot inject escape
 * sequences into a consumer's terminal (`SECURITY.md`). Real project names are
 * ordinary characters and pass through untouched; only C0 control characters
 * (which includes the ESC byte) and DEL become visible escapes.
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitize(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/[\x00-\x1F\x7F]/g, (c) => {
    if (c === "\n") return "\\n";
    if (c === "\t") return "\\t";
    if (c === "\r") return "\\r";
    return `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}

/**
 * One project as a line, same shape as `graph-text.mjs`.
 *
 * @param {{name: string, root: string, tags: string[]}} project
 * @returns {string}
 */
function formatProject(project) {
  const tags =
    project.tags.length > 0 ? ` [${project.tags.map((t) => sanitize(t)).join(", ")}]` : "";
  return `  ${sanitize(project.name)}  ${sanitize(project.root)}${tags}`;
}

/**
 * One edge as a line, same shape as `graph-text.mjs`.
 *
 * @param {{source: string, target: string, type: string}} edge
 * @returns {string}
 */
function formatEdge(edge) {
  return `  ${sanitize(edge.source)} → ${sanitize(edge.target)} (${sanitize(edge.type)})`;
}

/**
 * One metadata change as a line, same shape as `diff-text.mjs`.
 *
 * @param {{field: string, baseline: *, head: *}} change
 * @returns {string}
 */
function formatChange(change) {
  const formatValue = (v) => {
    if (Array.isArray(v)) return v.length > 0 ? v.map((x) => sanitize(x)).join(", ") : "(none)";
    if (v === null || v === undefined) return "(none)";
    return sanitize(String(v));
  };
  return `  ${change.field}  ${formatValue(change.baseline)} → ${formatValue(change.head)}`;
}

/**
 * How the architecture actually changed between two snapshots: the added and
 * removed projects and edges rendered as one line each. Changed projects
 * render their changed fields beneath the project line, like `diff`.
 *
 * @param {object} changes The `computeDiff` payload.
 * @returns {string[]}
 */
export function formatChanges(changes) {
  const lines = [];
  if (changes.addedProjects.length > 0) {
    const word = changes.addedProjects.length === 1 ? "project" : "projects";
    lines.push(`+ ${changes.addedProjects.length} added ${word}`);
    for (const project of changes.addedProjects) lines.push(formatProject(project));
  }
  if (changes.removedProjects.length > 0) {
    const word = changes.removedProjects.length === 1 ? "project" : "projects";
    lines.push(`- ${changes.removedProjects.length} removed ${word}`);
    for (const project of changes.removedProjects) lines.push(formatProject(project));
  }
  if (changes.changedProjects.length > 0) {
    const word = changes.changedProjects.length === 1 ? "project" : "projects";
    lines.push(`~ ${changes.changedProjects.length} changed ${word}`);
    for (const project of changes.changedProjects) {
      lines.push(`  ${project.name}`);
      for (const change of project.changes) lines.push(formatChange(change));
    }
  }
  if (changes.addedEdges.length > 0) {
    const word = changes.addedEdges.length === 1 ? "edge" : "edges";
    lines.push(`+ ${changes.addedEdges.length} added ${word}`);
    for (const edge of changes.addedEdges) lines.push(formatEdge(edge));
  }
  if (changes.removedEdges.length > 0) {
    const word = changes.removedEdges.length === 1 ? "edge" : "edges";
    lines.push(`- ${changes.removedEdges.length} removed ${word}`);
    for (const edge of changes.removedEdges) lines.push(formatEdge(edge));
  }
  return lines;
}

/**
 * Classifies one transition into the short "kind" a reader skims for.
 *
 * @param {{architectureChanged: boolean, codeDrift: boolean, policyChanged: boolean|null,
 *   policyOneSided: boolean, provenanceChanged: boolean|null,
 *   providerChanged: boolean}} transition
 */
export function transitionKind(transition) {
  if (transition.architectureChanged) return "architecture";
  if (transition.providerChanged) return "provider";
  if (transition.policyChanged === true) return "policy";
  if (transition.codeDrift) return "code drift";
  // A pair whose policy could not be compared — one side records the law
  // (`policyOneSided`) or neither does while the commit advanced
  // (F-HIST-1) — is never rendered "unchanged": that label claims every
  // comparable signal was compared and equal. The record carries these as
  // fields, never parsed out of its notes.
  if (
    transition.policyChanged === null &&
    (transition.policyOneSided || transition.provenanceChanged === true)
  ) {
    return "not comparable";
  }
  return "unchanged";
}

/**
 * One transition's canonical evolution classes as a renderable line. Shared
 * by every reporter that renders a transition record (`history` today;
 * `evolution` will render the same record), so the JSON field and its prose
 * cannot disagree about what a classification is — one spelling, one home,
 * beside the sibling `transitionKind` label.
 *
 * The line appears only when the record carries classifications: an
 * unclassified transition is labelled by its kind, and the empty-classification
 * statement — where it applies — is a note on the record, never a second line
 * this helper has to invent.
 *
 * @param {string[]|undefined} classifications The record's `classifications`
 *   array; `undefined` when the caller's record predates the field.
 * @returns {string[]} The line, or `[]` when there is nothing to state.
 */
export function formatClassifications(classifications) {
  if (!Array.isArray(classifications) || classifications.length === 0) {
    return [];
  }
  return [`classifications: ${classifications.map((c) => sanitize(c)).join(", ")}`];
}
