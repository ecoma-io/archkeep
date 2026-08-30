/**
 * The terminal report for the `debt` command: the architecture-debt ledger as
 * a table a reader can act on.
 *
 * Every section ends with a count, and the header states what the ledger is a
 * claim about — how many entries, across how many snapshots, and whether the
 * ages are real. `agings: false` is the debt-report way of saying "observed,
 * not yet aged": ages are all 0 because the directory cannot establish time,
 * and showing them as 0 while disclosing why keeps "this debt is exactly one
 * snapshot old" from ever being read as "born yesterday".
 *
 * An empty ledger prints a "✔ no architecture debt" line — a claim about the
 * whole comparison, never a bare zero. The aggregates are printed even when
 * empty, so a reader can tell "no debt" from "the report forgot a section".
 *
 * This module decides nothing. A formatter that filtered would be a rule
 * wearing a formatter's name (`../README.md`).
 */

/**
 * Neutralises control and terminal-escape sequences in a name or value before
 * it is printed, so a crafted suppression path, project name or finding cannot
 * inject escape sequences into a consumer's terminal (`SECURITY.md`). The same
 * sanitation every other report renderer uses.
 *
 * @param {string} text
 * @returns {string}
 */
function sanitize(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/[\x00-\x1F\x7F]/g, (c) => {
    if (c === "\n") return "\\n";
    if (c === "\t") return "\\t";
    if (c === "\r") return "\\r";
    return `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}

/**
 * The whole debt report.
 *
 * @param {{ledger: {dir: string, snapshots: number, agings: boolean,
 *   sampleTime: string, entries: {source: string, kind: string,
 *   severity: string, age: number, count: number, remediationHint: string,
 *   id: string, status: string, introducedBy?: string}[],
 *   resolved?: {id: string, status: string, resolvedBy: string}[],
 *   total: number, byKind: object, bySeverity: object,
 *   lifecycle?: {linked: boolean, note: string|null}},
 *   coverage: object}} input
 * @returns {string}
 */
export function formatDebtReport({ ledger, coverage }) {
  const sections = [];

  sections.push(`debt  ${ledger.dir}`);
  const word = ledger.total === 1 ? "entry" : "entries";
  const ageWord = ledger.agings
    ? "a snapshot-relative ledger"
    : "ages not yet established (fewer than two snapshots)";
  sections.push(
    `${ledger.total} ${word} across ${ledger.snapshots} snapshot${ledger.snapshots === 1 ? "" : "s"} — ${ageWord}`,
  );

  const orderedKinds = [
    ["waiver", "waivers (accepted boundary violations)"],
    ["expired-waiver", "expired waivers (accepted violations that lapsed back into force)"],
    ["aspirational-gap", "aspirational gaps (optional allowed rows not built)"],
    ["drift", "drift findings"],
    ["unresolved", "unresolved intent"],
  ];
  for (const [kind, label] of orderedKinds) {
    const items = ledger.entries.filter((e) => e.kind === kind);
    if (items.length === 0) continue;
    sections.push(`${items.length} ${label}:`);
    for (const entry of items) {
      const age = ledger.agings ? `age ${entry.age}` : "age not yet established";
      sections.push(
        `  [${entry.kind}] ${entry.severity}  ${sanitize(entry.source)}  (${age}, count ${entry.count})`,
      );
      sections.push(`    ${sanitize(entry.remediationHint)}`);
      // The lifecycle fields (design §6) ride the entry as appended lines only;
      // every existing line above keeps its exact bytes. When no event store is
      // linked, the id/status are still printed (they are facts about the entry,
      // always determinable); refs are printed only when actually present.
      sections.push(`    id ${entry.id} · status ${entry.status}`);
      if (entry.introducedBy) sections.push(`    introducedBy ${entry.introducedBy}`);
    }
  }
  // The positive claim must be byte-truthful: no CURRENT findings AND no
  // retained resolution history. A ledger with an empty entry list but a
  // non-empty resolved list is not "no architecture debt" — it has history
  // that was resolved and is retained below (F-DEB-4).
  const resolved = ledger.resolved ?? [];
  if (ledger.entries.length === 0 && resolved.length === 0) {
    sections.push(
      "✔ no architecture debt — no waivers, aspirational gaps, drift or unresolved intent",
    );
  } else if (ledger.entries.length === 0 && resolved.length > 0) {
    sections.push(
      `no current architecture debt; ${resolved.length} resolved entry${resolved.length === 1 ? "" : "s"} retained below`,
    );
  }

  // The resolved surface (design §6): debt whose candidate fact is gone at
  // head AND closed by evidence (a REPAIR event). Entries are retained — the
  // history is never deleted — but they are no longer current findings. This
  // list is empty (and no line is printed) when no event store is linked or
  // nothing has been resolved.
  if (resolved.length > 0) {
    sections.push(`${resolved.length} resolved (no longer current findings):`);
    for (const entry of resolved) {
      // The resolved surface is evidence-backed only — id/status/resolvedBy
      // (F-DEB-2). The kind/severity/hint of the original entry live in the
      // history snapshots the ledger read, never in this row.
      sections.push(`  id ${entry.id} · status ${entry.status}`);
      if (entry.resolvedBy) sections.push(`    resolvedBy ${entry.resolvedBy}`);
    }
  }
  if (ledger.lifecycle?.note) {
    sections.push(ledger.lifecycle.note);
  }

  sections.push(
    `total ${ledger.total} ${word} · byKind: waiver ${ledger.byKind.waiver}, ` +
      `expired-waiver ${ledger.byKind["expired-waiver"]}, ` +
      `aspirational-gap ${ledger.byKind["aspirational-gap"]}, drift ${ledger.byKind.drift}, ` +
      `unresolved ${ledger.byKind.unresolved} · bySeverity: high ${ledger.bySeverity.high}, ` +
      `medium ${ledger.bySeverity.medium}, low ${ledger.bySeverity.low}`,
  );
  sections.push(`sampled ${ledger.sampleTime}`);

  // The coverage line states what the ledger is a claim about, the same
  // disclosure every other report renderer makes (`graph-text.mjs`, etc.).
  const inspected =
    `${coverage.imports} import${coverage.imports === 1 ? "" : "s"} in ` +
    `${coverage.analyzedFiles} file${coverage.analyzedFiles === 1 ? "" : "s"} across ` +
    `${coverage.projects} project${coverage.projects === 1 ? "" : "s"}`;
  sections.push(coverage.complete ? `✔ complete (${inspected})` : `✖ ${inspected}`);

  return sections.join("\n");
}
