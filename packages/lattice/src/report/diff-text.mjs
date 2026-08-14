/**
 * The terminal report for the `diff` command: two graph snapshots compared.
 *
 * Each section — added projects, removed projects, changed projects, added
 * edges, removed edges — is printed only when it has content, and always ends
 * with a count. A section with zero entries is absent from the report, and the
 * summary line then names "no changes" rather than "0 added, 0 removed" — the
 * two must never look identical, because "no changes" is a claim about a
 * complete comparison while "0 added, 0 removed" would be ambiguous over a
 * partial one (`../../../../AGENTS.md`).
 *
 * The changed-projects section lists projects that exist in both baseline and
 * head but whose metadata (tags, type, root) changed. Each changed project
 * shows the field name and its before → after values.
 *
 * When the diff carries a `ruleImpact` field (computed when a boundary config
 * was provided), a rule-impact section lists violations introduced and
 * resolved by the diff, plus a "no boundary-rule impact" line when the config
 * was provided but no violations changed. This section appears whenever
 * `ruleImpact` is present — even when there are no structural changes — so a
 * reader can always tell "config provided, no impact" from "no config". The
 * section is absent when no config was given, so a diff without `--config` is
 * unchanged from its prior output.
 *
 * This module decides nothing. A formatter that filtered would be a rule
 * wearing a formatter's name (`../README.md`).
 */

/**
 * One metadata change as a line.
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
 * One constraint-impact violation as a line.
 *
 * @param {{messageId: string, constraint: object|null, source: string, target: string}} violation
 * @returns {string}
 */
function formatImpactViolation(violation) {
  const tag =
    violation.constraint?.sourceTag ??
    violation.constraint?.allSourceTags?.join("+") ??
    "(no matching constraint)";
  return `  ${violation.source} → ${violation.target}  ${violation.messageId}  [${tag}]`;
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

  // Policy mismatch warning: when the boundary law changed between the
  // baseline and head runs, rule-impact results may reflect the policy change
  // rather than a structural change.
  if (diff.policyMismatch) {
    sections.push(
      "⚠ policy changed between baseline and head — rule-impact results may reflect the policy change, not a structural change",
    );
  }

  const hasChanges =
    diff.addedProjects.length > 0 ||
    diff.removedProjects.length > 0 ||
    (diff.changedProjects && diff.changedProjects.length > 0) ||
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

    if (diff.changedProjects && diff.changedProjects.length > 0) {
      const word = diff.changedProjects.length === 1 ? "project" : "projects";
      sections.push(`~ ${diff.changedProjects.length} changed ${word}`);
      for (const project of diff.changedProjects) {
        sections.push(`  ${project.name}`);
        for (const change of project.changes) {
          sections.push(formatChange(change));
        }
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

  // Rule-impact section: violations introduced or resolved by this diff.
  // This section appears whenever the boundary config was provided, so a
  // reader can always tell "config provided, no impact" from "no config".
  if (diff.ruleImpact) {
    const { introduced, resolved } = diff.ruleImpact;

    if (introduced.length > 0) {
      const word = introduced.length === 1 ? "violation" : "violations";
      sections.push(`⚠ ${introduced.length} boundary ${word} introduced`);
      for (const v of introduced) {
        sections.push(formatImpactViolation(v));
      }
    }

    if (resolved.length > 0) {
      const word = resolved.length === 1 ? "violation" : "violations";
      sections.push(`✔ ${resolved.length} boundary ${word} resolved`);
      for (const v of resolved) {
        sections.push(formatImpactViolation(v));
      }
    }

    if (introduced.length === 0 && resolved.length === 0) {
      sections.push("✔ no boundary-rule impact");
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
      (diff.changedProjects ? diff.changedProjects.length : 0) +
      diff.addedEdges.length +
      diff.removedEdges.length;
    sections.push(
      `${totalChanges} change${totalChanges === 1 ? "" : "s"} between baseline and head (${inspected})`,
    );
  }

  return sections.join("\n");
}
