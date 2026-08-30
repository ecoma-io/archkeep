/**
 * The decision-lineage helpers of Decision Governance integration (Wave 3 §9):
 * two pure functions of registry input that answer which recorded decisions
 * govern a run's affected constraint/fitness ids, and whether the decision
 * lineage moved between two registry states.
 *
 * ## What each helper answers
 *
 * - `computeAffectedDecisions(registry, fitnessRows, constraintRows)` — the
 *   "affected-decisions resolution": for each affected id, the ADR records
 *   binding it (the registry's own `adrsBinding`/`boundFitnessIds`) and the
 *   row's `decisionRef` lineage (the registry's own `resolveDecisionRef`).
 *   An unresolved ref is surfaced twice — as the per-row entry's
 *   `resolution: "unknown"` and as the `unresolvedNote` naming every
 *   unresolved ref (`unresolvedDecisionRefRows`, the bulk form `check` /
 *   `context` / `drift` share) — never dropped (`../../../../AGENTS.md`: an
 *   empty result must mean "no violation", and nothing else; a citation that
 *   cannot be verified reads as unverified, never as clean).
 * - `detectDecisionChange(baseRegistry, headRegistry)` — the DECISION_CHANGE
 *   predicate (design §2): the ADR lineage moved between base and head —
 *   the same ADR id with a different status, or a new `supersedes` relation.
 *   Both registry states are REQUIRED: exactly one side absent is the
 *   one-sided case (the mirror of `policyOneSided`), where the change is NOT
 *   asserted and a note says the lineage is not comparable — asserting the
 *   lineage did not move from one registry would fabricate a fact about the
 *   side the input does not have.
 *
 * ## Reuse, never a second opinion
 *
 * Both helpers are pure functions of registry input — testable with no
 * filesystem — and every judgment they make is the registry's or the event
 * classifier's, never a private reading:
 *
 * - the binding reverse lookup is `adrsBinding` itself, the exact-match
 *   surface the `adr` command's reverse lookup uses (`rule:x` / `fitness:x`
 *   spellings match the record's own binding spelling);
 * - the fitness half of `resolveDecisionRef` answers against the registry's
 *   own binding ids (`boundFitnessIds`), prefix-normalised exactly the way
 *   `resolveDecisionRef` normalises the ref side (`stripRuleFitnessPrefix`)
 *   — the same-name-space comparison `decision-graph.mjs`'s row matching
 *   applies. This helper answers "what the recorded decisions make
 *   enforceable"; the F04 discipline — judging a citation against the ids
 *   the executed policy actually declares — stays with the config-facing
 *   surfaces (`check` / `context` / `drift`) that own it;
 * - the DECISION_CHANGE predicate is `classifyEvolution`'s own — one
 *   classification, one definition, consumed here rather than re-derived.
 *
 * Deterministic: input order is preserved (registry byte-sorted filename
 * order for `adrs`, caller order for rows and refs), and both outputs are
 * stable across runs.
 */

import {
  adrsBinding,
  boundFitnessIds,
  hasAuthority,
  resolveDecisionRef,
  stripAdrPrefix,
  stripRuleFitnessPrefix,
  unresolvedDecisionRefRows,
} from "./adr-registry.mjs";
import { classifyEvolution } from "./evolution-event.mjs";

/**
 * One affected constraint/fitness row: the identity the helper resolves
 * decisions for, and the optional `decisionRef` that claims a governing
 * decision.
 *
 * @typedef {object} AffectedRow
 * @property {string} id The affected constraint/fitness id — a constraint
 *   row label or a rule/fitness id in any spelling the registry records.
 * @property {string} [decisionRef] The decision that makes the row
 *   enforceable, in any spelling `resolveDecisionRef` accepts.
 */

/**
 * One affected id's decision lineage: the ADRs binding it and, when the row
 * carries a `decisionRef`, how that citation resolved.
 *
 * @typedef {object} DecisionLineageEntry
 * @property {string} id The affected id, verbatim.
 * @property {string[]} adrs The ADR ids binding the id, in registry order —
 *   a reverse lookup into the records' own `bindings`. Empty when no record
 *   binds it (an unenforced id is a fact, not an error — the same
 *   unenforced-but-ok sentence the `adr` command's reverse lookup prints).
 * @property {string} [decisionRef] The row's citation, when it carried one.
 * @property {"none"|"adr"|"fitness"|"unknown"} resolution
 *   `none` = the row carried no `decisionRef`. `adr` = the citation named a
 *   recorded decision; `fitness` = it named an id the registry's records
 *   bind; `unknown` = it named neither — and is disclosed, never dropped.
 * @property {object} [record] The governing record's status/lineage facts —
 *   present when `resolution` is `"adr"`.
 * @property {string} [reason] Why an `unknown` citation did not resolve.
 */

/**
 * The affected-decisions answer: the governing decision ids and one lineage
 * entry per affected id, plus the unresolved-citation disclosure.
 *
 * @typedef {object} AffectedDecisions
 * @property {string[]} decisions The distinct governing ADR ids — the ADRs
 *   binding the affected ids plus every `decisionRef` that itself named an
 *   ADR — sorted, de-duplicated. What an event's `affected.decisions` names
 *   for a run whose affected rows these are.
 * @property {DecisionLineageEntry[]} lineage One entry per affected id, in
 *   caller order (fitness rows first, then constraint rows).
 * @property {string} [unresolvedNote] Present exactly when some affected
 *   row's `decisionRef` resolved `unknown` — names every such ref. Never
 *   absent when an unresolved ref exists.
 */

/**
 * Resolves the affected-decisions answer for one run's affected
 * constraint/fitness ids.
 *
 * The registry is the `loadAdrRegistry` result (`{records, byId}`); absent
 * (`null`/`undefined`) it is an empty registry — a workspace that has not
 * adopted ADRs has nothing binding an id and nothing to resolve, and every
 * citation resolves `unknown`, surfaced by the note. Rows that lack an `id`
 * are skipped: they name no identity to resolve decisions for, and skipping
 * them drops no fact (an id-less row claims no affected identity).
 *
 * @param {{records: object[], byId: Map<string, object>}|null|undefined} registry
 * @param {AffectedRow[]} [fitnessRows] The affected fitness rows.
 * @param {AffectedRow[]} [constraintRows] The affected constraint rows.
 * @returns {AffectedDecisions}
 */
export function computeAffectedDecisions(registry, fitnessRows, constraintRows) {
  const records = Array.isArray(registry?.records) ? registry.records : [];
  const byId = registry?.byId instanceof Map ? registry.byId : new Map();
  // The fitness half of `resolveDecisionRef` answers against the ids the
  // registry's records bind, prefix-normalised the same way the ref side is
  // (`stripRuleFitnessPrefix`), so `rule:no-direct-dep` and
  // `fitness:no-direct-dep` and bare `no-direct-dep` name the same id.
  const knownFitness = new Set([...boundFitnessIds(records)].map(stripRuleFitnessPrefix));

  const lineage = [];
  const decisions = new Set();
  for (const row of [...(fitnessRows ?? []), ...(constraintRows ?? [])]) {
    if (row === null || typeof row !== "object" || typeof row.id !== "string" || row.id === "") {
      continue;
    }
    /** @type {DecisionLineageEntry} */
    const entry = { id: row.id, adrs: adrsBinding(records, row.id), resolution: "none" };
    for (const adr of entry.adrs) decisions.add(adr);

    const ref = row.decisionRef;
    if (typeof ref !== "string" || ref.trim() === "") {
      entry.resolution = "none";
      lineage.push(entry);
      continue;
    }
    entry.decisionRef = ref;
    const resolution = resolveDecisionRef(byId, knownFitness, ref);
    if (resolution === "adr") {
      const record = byId.get(stripAdrPrefix(ref));
      entry.resolution = "adr";
      entry.record = {
        id: record.id,
        status: record.status,
        authority: hasAuthority(record.status),
        supersedes: record.supersedes,
        supersededBy: record.supersededBy,
      };
      decisions.add(record.id);
    } else if (resolution === "fitness") {
      entry.resolution = "fitness";
    } else {
      entry.resolution = "unknown";
      // The shared unresolved wording (`decision-graph.mjs` states the same
      // sentence for a row whose citation names nothing).
      entry.reason = `"${ref}" does not resolve — no matching ADR, rule, or fitness record`;
    }
    lineage.push(entry);
  }

  const rows = [
    ...(fitnessRows ?? []).map((row, index) => ({ kind: `fitness[${index}]`, row })),
    ...(constraintRows ?? []).map((row, index) => ({ kind: `constraint[${index}]`, row })),
  ];
  const unresolved = unresolvedDecisionRefRows(rows, byId, knownFitness);

  /** @type {AffectedDecisions} */
  const result = {
    decisions: [...decisions].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    lineage,
  };
  if (unresolved.length > 0) {
    result.unresolvedNote =
      `unresolved decisionRefs: ${unresolved.map(({ decisionRef }) => `"${decisionRef}"`).join(", ")}` +
      ` — no matching ADR, rule, or fitness record`;
  }
  return result;
}

/**
 * The DECISION_CHANGE answer between two registry states.
 *
 * @typedef {object} DecisionChange
 * @property {boolean} superseded Whether the decision lineage moved: the
 *   same ADR id with a different status, or a new `supersedes` relation,
 *   between base and head — `classifyEvolution`'s own predicate, never a
 *   second opinion.
 * @property {boolean} comparable Whether the two registry states were both
 *   present and could be compared. `false` for a one-sided comparison (or,
 *   at the caller, an unreadable head registry) — the state never read as a
 *   "did not move" claim, because that would fabricate a fact about evidence
 *   the comparison could not hold. `superseded` is meaningful only when
 *   `comparable` is `true`.
 * @property {string[]} notes Disclosure notes. The non-comparable case —
 *   exactly one registry state supplied — carries the
 *   "decision lineage not comparable" note; both states absent carries
 *   nothing to disclose (no decision evidence was supplied, so nothing was
 *   asserted, the mirror of `classifyEvolution`'s both-sides-absent case).
 */

/**
 * Detects whether the decision lineage moved between two registry states —
 * the DECISION_CHANGE predicate (design §2), delegating the supersession
 * judgment to `classifyEvolution` so one definition stays the only one.
 *
 * Both registry states are REQUIRED. Exactly one side absent (one-sided) ⇒
 * `comparable: false` (with `superseded: false` and a note) — the state
 * never reads as "did not move", because asserting the lineage did not move
 * from one registry would fabricate a fact about the side the input does not
 * have. Both sides absent is "no decision evidence supplied" — comparable,
 * nothing asserted, nothing to disclose.
 *
 * Each registry is a `loadAdrRegistry` result (`{records, byId}`) or
 * `null`/`undefined` for an absent side.
 *
 * @param {{records: object[], byId: Map<string, object>}|null|undefined} baseRegistry
 * @param {{records: object[], byId: Map<string, object>}|null|undefined} headRegistry
 * @returns {DecisionChange}
 */
export function detectDecisionChange(baseRegistry, headRegistry) {
  const base = baseRegistry ?? null;
  const head = headRegistry ?? null;
  const oneSided = (base == null) !== (head == null);
  const classification = classifyEvolution({ adrBase: base, adrHead: head });
  const notes = [];
  if (oneSided) {
    notes.push("decision lineage not comparable — both registry states required");
  }
  return {
    superseded: classification.classifications.includes("DECISION_CHANGE"),
    comparable: !oneSided,
    notes,
  };
}
