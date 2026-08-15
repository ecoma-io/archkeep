/**
 * The terminal report for the `history` command: snapshots in history order,
 * each transition classified, and what the whole record can and cannot say.
 *
 * The summary line states what the record is a claim about — how many
 * snapshots, how many transitions, and the shape of the history the directory
 * actually holds. Counts end every section, so a reader is never left deciding
 * whether an omission is content or silence.
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
 * One metadata change as a line, same shape as `diff-text.mjs`.
 *
 * @param {{field: string, baseline: *, head: *}} change
 * @returns {string}
 */
function formatChange(change) {
  const formatValue = (v) => {
    if (Array.isArray(v)) return v.length > 0 ? v.join(", ") : "(none)";
    if (v === null || v === undefined) return "(none)";
    return String(v);
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
function formatChanges(changes) {
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
 *   providerChanged: boolean}} transition
 * @returns {string}
 */
function transitionKind(transition) {
  if (transition.architectureChanged) return "architecture";
  if (transition.providerChanged) return "provider";
  if (transition.policyChanged === true) return "policy";
  if (transition.codeDrift) return "code drift";
  return "unchanged";
}

/**
 * The whole history report.
 *
 * @param {{evolution: {dir: string, captured: object|null,
 *   snapshots: {name: string, id: string}[],
 *   transitions: {from: string, to: string, architectureChanged: boolean,
 *     changes: object|null, policyChanged: boolean|null, providerChanged: boolean,
 *     codeDrift: boolean, notes: string[]}[]}, coverage: object}} input
 * @returns {string}
 */
export function formatHistoryReport({ evolution, coverage }) {
  const sections = [];

  const transitionWord = evolution.transitions.length === 1 ? "transition" : "transitions";
  const snapshotWord = evolution.snapshots.length === 1 ? "snapshot" : "snapshots";
  const inspected = `${coverage.imports} import${
    coverage.imports === 1 ? "" : "s"
  } in ${coverage.analyzedFiles} file${
    coverage.analyzedFiles === 1 ? "" : "s"
  } across ${coverage.projects} project${coverage.projects === 1 ? "" : "s"}`;

  sections.push(`history  ${evolution.dir}`);
  sections.push(
    `${evolution.snapshots.length} ${snapshotWord}, ${evolution.transitions.length} ${transitionWord} (${inspected})`,
  );

  if (evolution.captured) {
    sections.push(
      evolution.captured.deduplicated
        ? `capture  ${evolution.captured.name} — already the last snapshot, no new file written`
        : `capture  ${evolution.captured.name} written`,
    );
  }

  for (const [i, snapshot] of evolution.snapshots.entries()) {
    sections.push(`${i}  ${snapshot.name}  ${snapshot.id.slice(0, 8)}`);
  }

  let changed = 0;
  for (const transition of evolution.transitions) {
    if (
      transition.architectureChanged ||
      transition.policyChanged === true ||
      transition.providerChanged
    ) {
      changed += 1;
    }
    const kind = transitionKind(transition);
    sections.push(`~ ${transition.from} → ${transition.to}  (${kind})`);
    if (transition.changes) {
      for (const line of formatChanges(transition.changes)) sections.push(`  ${line}`);
    }
    for (const note of transition.notes) {
      sections.push(`  ${note}`);
    }
  }

  if (evolution.transitions.length === 0) {
    // A single snapshot is a claim about a history of length one — it says so
    // rather than reporting "no changes", which would be ambiguous.
    sections.push(
      "✔ one snapshot, no transitions yet — capture again after an architectural change",
    );
  } else if (changed === 0) {
    sections.push("✔ no architectural change recorded across the snapshots");
  } else {
    sections.push(
      `${changed} transition${changed === 1 ? "" : "s"} recorded an architectural change`,
    );
  }

  return sections.join("\n");
}
