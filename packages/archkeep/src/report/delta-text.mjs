/**
 * The terminal report for the `delta` command: how boundary violations moved
 * between a captured baseline and the current tree, both re-judged under the
 * current law (`../commands/delta.mjs`).
 *
 * Sections render only when they have content — introduced (with waived
 * annotations), resolved, unchanged (with the occurrences-reduced note where
 * one applies), unknown (with the reason each identity could not be stated),
 * and the unresolvable-import block — and the summary line always states what
 * was compared: base and head identity, record and project counts, and the
 * bucket totals. "No introduced violations" is a claim about a comparison the
 * reader can verify, never silence (`../../../../AGENTS.md`).
 *
 * `coverage.notes` — the policy-changed, dirty-tree, and provenance warnings
 * `../commands/delta.mjs` pushes there — fold into the report as their own
 * lines, so a note that rides the JSON envelope also reaches the terminal.
 *
 * This module decides nothing. A formatter that filtered would be a rule
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

  return sections.join("\n");
}
