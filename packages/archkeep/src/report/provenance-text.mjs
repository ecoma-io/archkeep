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
 * A fourth section carries the decision lifecycle: every recorded decision's
 * status, authority, committed timeline, lineage, and bindings, attributed
 * with WHO recorded it (the record file's own git history). A decision with
 * no attributable history is named `no origin recorded — cannot attest`,
 * never silently passed; the section renders only when at least one decision
 * exists, the same "no fact, no claim" bargain the row arms state.
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
 *   unresolvedDecisionRefs: {kind: string, label: string, decisionRef: string, note: string}[],
 *   decisionLifecycle?: {id: string, status: string, authority: boolean,
 *     created: string|null, updated: string|null, supersedes: string[],
 *     supersededBy: string[], bindings: string[],
 *     attribution: {createdBy: object|null, lastChangedBy: object|null}|null,
 *     attested: boolean, note: string|null}[]}} input
 *   `decisionRefTotal` is how many governance rows cite a `decisionRef` at
 *   all — the resolution section renders only when it is non-zero, the same
 *   "no fact, no claim" bargain every optional axis in this tool states.
 *   `decisionLifecycle` (optional, default `[]`) is the decision-lifecycle
 *   section — it renders only when non-empty.
 * @returns {string}
 */
export function formatProvenanceReport({
  establishment,
  repo,
  rowsTotal,
  unattested,
  decisionRefTotal,
  unresolvedDecisionRefs,
  decisionLifecycle = [],
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
  // PR E — the decision lifecycle. "No fact, no claim", like the resolution
  // arm: the section renders only when the registry holds at least one
  // decision, and a decision with no attributable history is listed under a
  // cannot-attest heading, never silently passed.
  const decidedCount = decisionLifecycle.length;
  if (decidedCount > 0) {
    const attributedCount = decisionLifecycle.filter((d) => d.attested).length;
    const unattributedCount = decidedCount - attributedCount;
    text.push(
      `decisions  ${decidedCount} recorded — ${attributedCount} attributed, ` +
        `${unattributedCount} without attribution`,
    );
    for (const decision of decisionLifecycle) {
      if (!decision.attested) continue;
      const createdBy = decision.attribution?.createdBy ?? null;
      const lastChangedBy = decision.attribution?.lastChangedBy ?? null;
      const facts = [
        createdBy === null
          ? "created — no origin recorded — cannot attest"
          : `created by ${createdBy.by} on ${createdBy.on}`,
        lastChangedBy === null
          ? "changed — no origin recorded — cannot attest"
          : `changed by ${lastChangedBy.by} on ${lastChangedBy.on}`,
      ];
      if (decision.supersedes.length > 0) {
        facts.push(`supersedes ${decision.supersedes.join(", ")}`);
      }
      if (decision.supersededBy.length > 0) {
        facts.push(`superseded by ${decision.supersededBy.join(", ")}`);
      }
      if (decision.bindings.length > 0) {
        facts.push(`binds ${decision.bindings.join(", ")}`);
      }
      if (decision.created !== null || decision.updated !== null) {
        facts.push(`timeline ${decision.created ?? "?"} → ${decision.updated ?? "?"}`);
      }
      text.push(`  ${decision.status.padEnd(11)} ${decision.id}  ${facts.join("; ")}`);
    }
    if (unattributedCount > 0) {
      text.push("unattributed lifecycle (no origin recorded — cannot attest):");
      for (const decision of decisionLifecycle) {
        if (!decision.attested) text.push(`  ${decision.id}`);
      }
      text.push(`${unattributedCount} of them carry no recorded origin behind their lifecycle`);
    } else {
      text.push(
        `✔ every decision's lifecycle is attributed — each change names who ` +
          `recorded it and with what tool`,
      );
    }
  }
  return text.join("\n");
}
