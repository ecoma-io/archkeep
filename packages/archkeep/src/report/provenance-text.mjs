/**
 * The terminal report for the `provenance` command: where this run's facts
 * came from, and which governance rows carry an origin.
 *
 * Two lines state what was inspected before any verdict — the repo state (or
 * its absence) and the row count — so "every row carries an origin" always
 * reads as a claim about a specific, complete surface rather than a bare
 * count. Determinism: every line derives from the static facts
 * `../commands/provenance-command.mjs` already resolved — no wall-clock time
 * and no `localeCompare` enter here, matching every other report renderer.
 *
 * This module decides nothing. A formatter that filtered would be a rule
 * wearing a formatter's name (`./README.md`).
 */

/**
 * @param {{establishment: boolean,
 *   repo: {commit: string|null, remote: string|null, dirty: boolean|null}|null,
 *   rowsTotal: number,
 *   unattested: {kind: string, label: string, note: string}[],
 *   decisionRefTotal: number,
 *   unresolvedDecisionRefs: {kind: string, label: string, decisionRef: string, note: string}[]}} input
 *   `decisionRefTotal` is how many governance rows cite a `decisionRef` at
 *   all — the resolution section renders only when it is non-zero, the same
 *   "no fact, no claim" bargain every optional axis in this tool states.
 * @returns {string}
 */
export function formatProvenanceReport({
  establishment,
  repo,
  rowsTotal,
  unattested,
  decisionRefTotal,
  unresolvedDecisionRefs,
}) {
  const attestedCount = rowsTotal - unattested.length;
  const text = [];
  text.push(
    establishment
      ? `repo      ${repo.commit}${repo.dirty ? " (dirty)" : ""}` +
          (repo.remote ? ` — ${repo.remote}` : "")
      : "repo      provenance unavailable — not a git repository or git not installed",
  );
  text.push(
    `rows      ${rowsTotal} governance row${rowsTotal === 1 ? "" : "s"}, ` +
      `${attestedCount} with an origin, ${unattested.length} without`,
  );
  if (unattested.length > 0) {
    text.push("unattested (no origin recorded — cannot attest):");
    for (const row of unattested) {
      text.push(`  ${row.kind}`);
    }
    text.push(`${unattested.length} of them carry no decision behind the rule`);
  } else {
    text.push(
      `✔ every governance row carries an origin — each names who decided ` +
        `on it and with what tool`,
    );
  }
  if (decisionRefTotal > 0) {
    if (unresolvedDecisionRefs.length > 0) {
      text.push("unresolved decisionRefs (cite no known ADR, rule, or fitness record):");
      for (const row of unresolvedDecisionRefs) {
        text.push(`  ${row.kind} — "${row.decisionRef}"`);
      }
      text.push(
        `${unresolvedDecisionRefs.length} of ${decisionRefTotal} decisionRef citation` +
          `${decisionRefTotal === 1 ? "" : "s"} do not resolve`,
      );
    } else {
      text.push(
        `✔ every decisionRef citation (${decisionRefTotal}) resolves to a known ADR, ` +
          `rule, or fitness record`,
      );
    }
  }
  return text.join("\n");
}
