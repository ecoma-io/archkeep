/**
 * The terminal report for the `delta` command: how boundary violations moved
 * between a captured baseline and the current tree, both re-judged under the
 * current law (`../commands/delta.mjs`).
 *
 * Sections render only when they have content — introduced (with waived
 * annotations), resolved, unchanged (with the occurrences-reduced note where
 * one applies), unknown (with the reason each identity could not be stated),
 * the unresolvable-import block, and the custom-rules block (only when the
 * delta computed one — `../commands/delta.mjs` keeps it absent for a
 * workspace where neither side declares custom rules) — and the summary line
 * always states what
 * was compared: base and head identity, record and project counts, and the
 * bucket totals. "No introduced violations" is a claim about a comparison the
 * reader can verify, never silence (`../../../../AGENTS.md`).
 *
 * `coverage.notes` — the policy-changed, dirty-tree, and provenance warnings
 * `../commands/delta.mjs` pushes there — fold into the report as their own
 * lines, so a note that rides the JSON envelope also reaches the terminal.
 *
 * The wave-3 additive block — `classifications` and `affected` — is appended
 * after every existing line (and only when the payload carries the fields), so
 * a payload that predates them renders exactly what it always did. This module
 * decides nothing. A formatter that filtered would be a rule
 * wearing a formatter's name (`./README.md`).
 */

/** A side's identity for prose: its commit prefix, or an honest absence. */
function describeOrigin(provenance) {
  if (!provenance || typeof provenance.commit !== "string") return "unverified origin";
  const dirty = provenance.dirty ? ", dirty" : "";
  return `${provenance.commit.slice(0, 8)}${dirty}`;
}

/** One classified violation entry as its report lines. */
function violationLines(entry) {
  const source = entry.sourceProject ?? "(unattributed)";
  const arrow = entry.targetIsSpecifier ? "⇢" : "→";
  const counts = `${entry.baseCount} at base, ${entry.headCount} at head`;
  const waived = entry.waived === true ? "  [waived]" : "";
  const lines = [`  ${source} ${arrow} ${entry.target}  ${entry.messageId}  (${counts})${waived}`];
  if (entry.note !== undefined) lines.push(`    ${entry.note}`);
  const sites = entry.headSites.length > 0 ? entry.headSites : entry.baseSites;
  for (const site of sites) {
    lines.push(`    at ${site.file}:${site.line}:${site.column}`);
  }
  return lines;
}

/** One classified unresolvable-record entry as its report lines. */
function unresolvableLines(entry) {
  const source = entry.sourceProject ?? "(unattributed)";
  const counts = `${entry.baseCount} at base, ${entry.headCount} at head`;
  const lines = [`  ${source} ⇢ ${entry.specifier}  (${entry.kind || "unknown kind"}; ${counts})`];
  if (entry.note !== undefined) lines.push(`    ${entry.note}`);
  const sites = entry.headSites.length > 0 ? entry.headSites : entry.baseSites;
  for (const site of sites) {
    lines.push(`    at ${site.file}:${site.line}:${site.column}`);
  }
  return lines;
}

/** One unknown entry — the reason is the load-bearing half. */
function unknownLines(entry) {
  return [`  ? ${entry.reason}`];
}

/** One classified custom-finding entry as its report lines. */
function customFindingLines(entry) {
  const where = entry.project === null ? "" : `  in ${entry.project}`;
  const counts = `${entry.baseCount} at base, ${entry.headCount} at head`;
  const lines = [`  ${entry.ruleId}${where}  (${counts})`];
  if (entry.message !== undefined) lines.push(`    ${entry.message}`);
  if (entry.note !== undefined) lines.push(`    ${entry.note}`);
  const sites = entry.headSites.length > 0 ? entry.headSites : entry.baseSites;
  for (const site of sites) {
    // A custom finding states a position only when its rule stated one — a
    // whole-workspace finding has no file, and no line is printed for it.
    if (site.file !== undefined) lines.push(`    at ${site.file}:${site.line}:${site.column}`);
  }
  return lines;
}

/** One unknown custom entry — the rule name plus the mandatory reason. */
function customUnknownLines(entry) {
  return [`  ? ${entry.rule}: ${entry.reason}`];
}

/**
 * The custom-rules block, rendered only when the delta computed one — a
 * workspace where neither side declares custom rules keeps the exact report
 * it already had.
 *
 * @param {{judged: object[], skipped: object[], removed: string[],
 *   findings: object}} customRules
 * @param {{customFindings: {introduced: number, resolved: number,
 *   unchanged: number, unknown: number}}} summary
 * @returns {string[]}
 */
function customRulesSections(customRules, summary) {
  const { judged, skipped, removed, findings } = customRules;
  const counts = summary.customFindings;
  const lines = [
    `custom rules (${judged.length} judged, ${skipped.length} skipped, ${removed.length} removed)`,
  ];
  lines.push(
    ...section(
      `  ⚠ ${counts.introduced} introduced custom finding${counts.introduced === 1 ? "" : "s"}`,
      findings.introduced.map(customFindingLines),
    ),
  );
  lines.push(
    ...section(
      `  ✔ ${counts.resolved} resolved custom finding${counts.resolved === 1 ? "" : "s"}`,
      findings.resolved.map(customFindingLines),
    ),
  );
  lines.push(
    ...section(
      `  = ${counts.unchanged} unchanged custom finding${counts.unchanged === 1 ? "" : "s"}`,
      findings.unchanged.map(customFindingLines),
    ),
  );
  lines.push(
    ...section(
      `  ? ${counts.unknown} unclassifiable custom item${counts.unknown === 1 ? "" : "s"}`,
      findings.unknown.map(customUnknownLines),
    ),
  );
  return lines;
}

/**
 * One classification bucket as a section, or nothing when it is empty.
 *
 * @param {string} heading Rendered above the entries, already carrying its count.
 * @param {string[][]} entryLines
 * @returns {string[]}
 */
function section(heading, entryLines) {
  if (entryLines.length === 0) return [];
  return [heading, ...entryLines.flat()];
}

/**
 * The whole delta report.
 *
 * @param {{delta: object, coverage: object}} input `delta` is
 *   `../commands/delta.mjs`'s result payload; `coverage` its coverage block.
 * @returns {string}
 */
export function formatDeltaReport({ delta, coverage }) {
  const sections = [];
  const { baseline, head, summary, violations, unresolvable } = delta;

  sections.push(
    `baseline  ${baseline.path} — ${describeOrigin(baseline.provenance)}, ` +
      `${baseline.records} record${baseline.records === 1 ? "" : "s"}, ` +
      `${baseline.projects} project${baseline.projects === 1 ? "" : "s"}`,
  );
  sections.push(
    `head      ${describeOrigin(head.provenance)}, ` +
      `${head.records} record${head.records === 1 ? "" : "s"}, ` +
      `${head.projects} project${head.projects === 1 ? "" : "s"}`,
  );

  for (const note of coverage.notes ?? []) {
    sections.push(`⚠ ${note}`);
  }

  const introducedWord = summary.introduced === 1 ? "violation" : "violations";
  sections.push(
    ...section(
      `⚠ ${summary.introduced} introduced ${introducedWord}` +
        (summary.introducedWaived > 0
          ? ` (${summary.introducedWaived} waived — reported, not gating)`
          : ""),
      violations.introduced.map(violationLines),
    ),
  );
  sections.push(
    ...section(
      `✔ ${summary.resolved} resolved ${summary.resolved === 1 ? "violation" : "violations"}`,
      violations.resolved.map(violationLines),
    ),
  );
  sections.push(
    ...section(
      `= ${summary.unchanged} unchanged ${summary.unchanged === 1 ? "violation" : "violations"}`,
      violations.unchanged.map(violationLines),
    ),
  );
  sections.push(
    ...section(
      `? ${summary.unknown} unclassifiable ${summary.unknown === 1 ? "item" : "items"}`,
      violations.unknown.map(unknownLines),
    ),
  );

  const unresolvableTotal =
    summary.unresolvable.introduced +
    summary.unresolvable.resolved +
    summary.unresolvable.unchanged +
    summary.unresolvable.unknown;
  if (unresolvableTotal > 0) {
    sections.push(
      `unresolvable imports (carried, never counted as violations — no rule reached a verdict ` +
        `about them)`,
    );
    sections.push(
      ...section(
        `  + ${summary.unresolvable.introduced} introduced`,
        unresolvable.introduced.map(unresolvableLines),
      ),
    );
    sections.push(
      ...section(
        `  - ${summary.unresolvable.resolved} resolved`,
        unresolvable.resolved.map(unresolvableLines),
      ),
    );
    sections.push(
      ...section(
        `  = ${summary.unresolvable.unchanged} unchanged`,
        unresolvable.unchanged.map(unresolvableLines),
      ),
    );
    sections.push(
      ...section(
        `  ? ${summary.unresolvable.unknown} unclassifiable`,
        unresolvable.unknown.map(unknownLines),
      ),
    );
  }

  if (delta.customRules !== undefined) {
    sections.push(...customRulesSections(delta.customRules, summary));
  }

  // The closing claim always states what was compared, so an empty delta is a
  // verifiable statement rather than silence.
  const compared =
    `compared baseline ${describeOrigin(baseline.provenance)} ` +
    `(${baseline.records} record${baseline.records === 1 ? "" : "s"}) against head ` +
    `${describeOrigin(head.provenance)} (${head.records} record${head.records === 1 ? "" : "s"}, ` +
    `${coverage.analyzedFiles} analyzed file${coverage.analyzedFiles === 1 ? "" : "s"}, ` +
    `${coverage.projects} project${coverage.projects === 1 ? "" : "s"})`;
  if (summary.introduced === 0) {
    sections.push(`✔ no introduced violations — ${compared}`);
  } else {
    sections.push(
      `${summary.introduced - summary.introducedWaived} introduced ${introducedWord} not ` +
        `waived — ${compared}`,
    );
  }
  // The custom gate's own closing claim, so a delta whose only introduction is
  // a custom finding does not end on a line reading clean.
  if (delta.customRules !== undefined && summary.customFindings.introduced > 0) {
    const count = summary.customFindings.introduced;
    sections.push(
      `⚠ ${count} introduced custom finding${count === 1 ? "" : "s"} — custom findings have ` +
        `no waiver lane, every one gates`,
    );
  }
  // The wave-3 additive block: the evolution classification and its affected
  // identities, appended after every existing line so an older report's lines
  // stay byte-identical. Rendered only when the payload carries the fields —
  // a payload that predates them renders exactly what it always did. An empty
  // classification list is not silence here: the closing claims above already
  // state what was compared, and `classifications  none` says plainly that no
  // class applies.
  if (delta.classifications !== undefined) {
    sections.push(
      `classifications  ${
        delta.classifications.length === 0 ? "none" : delta.classifications.join(", ")
      }`,
    );
  }
  if (delta.affected !== undefined) {
    const affectedParts = [];
    if (delta.affected.projects.length > 0) {
      affectedParts.push(`projects: ${delta.affected.projects.join(", ")}`);
    }
    if (delta.affected.boundaries.length > 0) {
      affectedParts.push(`boundaries: ${delta.affected.boundaries.join(", ")}`);
    }
    if (delta.affected.constraints.length > 0) {
      affectedParts.push(`constraints: ${delta.affected.constraints.join(", ")}`);
    }
    if (delta.affected.decisions.length > 0) {
      affectedParts.push(`decisions: ${delta.affected.decisions.join(", ")}`);
    }
    sections.push(
      `affected         ${affectedParts.length === 0 ? "none" : affectedParts.join(" · ")}`,
    );
  }

  return sections.join("\n");
}
