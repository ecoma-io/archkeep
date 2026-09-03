/**
 * The canonical evolution event — one record every evolution command emits,
 * with one stable identity, one classification vocabulary and one idempotency
 * rule. `docs/concepts/evolution.md` is the human-facing model; this module is
 * its implementation, and the two must not disagree.
 *
 * The whole module is pure: no clock, no filesystem, no injected state. That
 * is the load-bearing half of the design. An event's `id`/`dedupeKey` are
 * derived from `{base, head, declarationDigest}` and nothing else — never from
 * `recordedAt`, `notes`, or `provenance` — so re-running the same transition
 * produces the same event and the store can prove idempotency instead of
 * guessing it. `declarationDigest` covers only the DECLARATIVE parts of a
 * change-intent (`{version, base, projects, edges, constraints}`); free-prose
 * `summary` is excluded because prose is not semantics: two runs whose
 * summary was re-worded must produce the same digest, or the digest would be
 * a function of narration rather than of the declared change.
 *
 * `classifyEvolution(input)` is the one home of the classification predicates
 * (design §2): CHANGE, DRIFT, VIOLATION, REPAIR, DECISION_CHANGE. Each class
 * is a fact about the input, multiple classes are allowed, and the output is
 * sorted. The invariant this module exists to hold is the repository's own:
 * **an empty result is a claim, not a shrug.** An unclassifiable item — an
 * unknown delta entry, one-sided metadata, a verdict that could not be
 * determined — is never folded into a clean result: it raises a `notes[]`
 * disclosure, and where the event carries a verdict-relevant unknown the
 * disposition is `no-verdict`, never a fabricated `accepted`/`rejected`.
 * `[]` classifications appear only for a fully comparable, unchanged pair,
 * and the event says so in notes.
 */

import { createHash } from "node:crypto";

import { canonicalizeJson } from "../canonical.mjs";

/** The version every event record carries. A different value is a store error. */
export const EVOLUTION_EVENT_SCHEMA_VERSION = 1;

/** The classification vocabulary, one fact per class, sorted lexicographically. */
export const EVENT_CLASSIFICATIONS = Object.freeze([
  "CHANGE",
  "DRIFT",
  "VIOLATION",
  "REPAIR",
  "DECISION_CHANGE",
]);

/** The disposition vocabulary every event may carry. */
export const EVENT_DISPOSITIONS = Object.freeze(["accepted", "rejected", "no-verdict"]);

/**
 * The canonical tuple an event's identity is built on — the ONE definition,
 * shared by `eventId` (which hashes it) and `eventDedupeKey` (which is it), so
 * the store cannot dedupe on one spelling of the tuple while the id is another.
 *
 * `declarationDigest` participates only when the event carries a declaration:
 * a transition-kind event (history/evolution) has none, and its absence is
 * part of the tuple — an event with a declaration is a different event from
 * the same base/head without one, and must not collide with it.
 *
 * @param {{base: object, head: object, declaration?: {digest?: string}}} event
 * @returns {string} The canonical serialization of the tuple.
 */
export function eventDedupeKey(event) {
  return canonicalizeJson({
    base: event.base,
    head: event.head,
    declarationDigest: event.declaration?.digest,
  });
}

/**
 * The stable event identity: `sha256` of the canonical tuple. Never depends on
 * `recordedAt`, `notes`, `provenance`, or any wall clock — see the module
 * header for why that exclusion is the idempotency guarantee.
 *
 * @param {{base: object, head: object, declaration?: {digest?: string}}} event
 * @returns {string} 64-hex-char SHA-256.
 */
export function eventId(event) {
  return createHash("sha256").update(eventDedupeKey(event)).digest("hex");
}

/**
 * The digest of a normalized change-intent's DECLARATIVE parts only:
 * `{version, base, projects, edges, constraints}`. The prose `summary` is
 * excluded by construction — this object never references it, so a re-worded
 * summary cannot change the digest (idempotency: prose is not semantics).
 *
 * The input is the same normalized shape `commands/change-intent.mjs`'s
 * `parseChangeIntent` returns; the digest is built from the whole declarative
 * sections, so any declarative difference — a project row, an edge row, a
 * constraint key, the base commit — changes the digest.
 *
 * @param {{version: string, base: object, projects: object, edges: object,
 *   constraints: object, summary?: string}} intent A normalized change-intent.
 *   `summary` is accepted (it rides on the normalized intent) and deliberately
 *   ignored — prose is not semantics.
 * @returns {string} The canonical serialization of the declarative parts.
 */
export function declarationDigest(intent) {
  return canonicalizeJson({
    version: intent.version,
    base: intent.base,
    projects: intent.projects,
    edges: intent.edges,
    constraints: intent.constraints,
  });
}

/**
 * The identity string of one graph edge, in the canonical spelling
 * `source>target:type` — the `(source, target, type)` identity design §1
 * names. The ONE spelling the evolution events' `observed.edges` and
 * `affected.boundaries` use: this module owns it, and `classifyEvolution`
 * maps every edge it is handed through this function, so there is exactly
 * one definition of "same edge" and no second spelling to drift.
 *
 * @param {{source: string, target: string, type: string}} edge
 * @returns {string}
 */
export function edgeEvolutionIdentity({ source, target, type }) {
  return `${source}>${target}:${type}`;
}

/**
 * The one accepted input shape for an `observed.edges` entry: the raw
 * `{source, target, type}` triple. A caller handing over a ready-made string
 * would be choosing a second spelling of "same edge", so a string is refused
 * loudly rather than accepted as one shape more — the identity string is this
 * module's output, never its input.
 *
 * @param {unknown} entry
 * @returns {string}
 */
function evolutionBoundary(entry) {
  if (
    typeof entry !== "object" ||
    entry === null ||
    !("source" in entry) ||
    typeof entry.source !== "string" ||
    entry.source === "" ||
    !("target" in entry) ||
    typeof entry.target !== "string" ||
    entry.target === "" ||
    !("type" in entry) ||
    typeof entry.type !== "string"
  ) {
    throw new TypeError(
      "classifyEvolution: observed.edges entries must be {source, target, type} triples — " +
        "the identity string is classifyEvolution's own output spelling, never an input",
    );
  }
  // The guard above has verified every property; the annotation only states
  // what it proved.
  return edgeEvolutionIdentity(
    /** @type {{source: string, target: string, type: string}} */ (entry),
  );
}

/**
 * @typedef {object} EvolutionEvidence
 * @property {{projects?: {added: string[], removed: string[], changed: string[]},
 *   edges?: {added: {source: string, target: string, type: string}[],
 *   removed: {source: string, target: string, type: string}[]},
 *   policyChanged?: boolean|null, policyOneSided?: boolean,
 *   provenanceChanged?: boolean|null}} [observed]
 *   The structural diff between base and head: project names and raw edge
 *   triples that were added, removed, or changed. The triples are mapped
 *   through `edgeEvolutionIdentity` here — the identity spelling is this
 *   module's own, so `affected.boundaries` comes out as identity strings
 *   whichever shape the caller held. Empty by default. `policyChanged` — whether the policy fingerprint changed
 *   between base and head; `null` is "could not be compared": exactly one side
 *   records the policy (`policyOneSided: true`) or neither does
 *   (both-absent). `true` is a disclosure, never a refusal. `policyOneSided`
 *   is the one-sided mirror from `commands/history.mjs` — an input fact, never
 *   derived from `policyChanged === null`, because both-sides-absent also
 *   yields `null` while remaining comparable. `provenanceChanged` — whether
 *   the commit record advanced between base and head; it is `true` only when
 *   both sides record provenance and the commits differ.
 * @property {boolean} [codeDrift]
 *   Whether provenance advanced with no architectural or policy change. The
 *   caller computes it under `commands/history.mjs`'s discipline — only when
 *   the architecture did not move, the policy was ACTUALLY compared, and the
 *   policy did not change; a caller that passes `true` alongside a
 *   `policyChanged` of `null` gets a loud note and no DRIFT, never a guess.
 * @property {{introduced?: {id: string, waived: boolean}[],
 *   resolved?: string[], unknown?: {id: string, reason: string}[]}} [violations]
 *   The delta classification of violations: introduced (with each entry's
 *   waiver state), resolved, and unknown. Unknown entries are the
 *   verdict-relevant unclassifiable items — they force `no-verdict`.
 * @property {{id: string, verdict: "pass"|"fail"|"unknown"}[]} [declaredConstraints]
 *   Declared constraint verdicts. `fail` is a VIOLATION; any other value than
 *   `pass`/`fail` is an undeterminable verdict — note + `no-verdict`.
 * @property {{id: string,
 *   verdict: "matched"|"undeclared"|"unfulfilled"|"unproven"}[]} [declaredIntentRows]
 *   Declared change-intent rows and the head's verdict on each (the
 *   `matched|undeclared|unfulfilled|unproven` vocabulary). `undeclared` and
 *   `unfulfilled` are DRIFT and reject; `unproven` is note + `no-verdict`.
 * @property {string[]} [driftFindingsResolved]
 *   Drift findings that no longer exist at head — a REPAIR signal.
 * @property {string[]} [debtResolved]
 *   Active debt entries closed between base and head — a REPAIR signal.
 * @property {{records: {id: string, status: string, supersedes: string[]}[]}|null} [adrBase]
 *   The ADR registry at base, as `{records: …}` (the shape
 *   `adr-registry.mjs`'s `loadAdrRegistry` returns), or `null` when the side
 *   does not record a decision registry. `undefined` = the input carried no
 *   decision evidence at all (not one-sided).
 * @property {{records: {id: string, status: string, supersedes: string[]}[]}|null} [adrHead]
 *   The ADR registry at head, or `null` when absent. Exactly one side `null`
 *   is the one-sided case: DECISION_CHANGE is NOT asserted and a note is
 *   added.
 */

/**
 * The classification result.
 *
 * @typedef {object} EvolutionClassification
 * @property {string[]} classifications Sorted; a subset of
 *   `EVENT_CLASSIFICATIONS`. `[]` only for a fully comparable, unchanged pair
 *   (with a note saying so) — never for an input that could not be classified.
 * @property {"accepted"|"rejected"|"no-verdict"} disposition
 *   `no-verdict` on any verdict-relevant unknown; `rejected` on introduced
 *   non-waived violations, a declared constraint `fail`, or undeclared /
 *   unfulfilled declared-intent rows; `accepted` otherwise.
 * @property {string[]} notes Disclosure notes — one-sided metadata, unknown
 *   entries, the "fully comparable, unchanged" statement, the policy-change
 *   disclosure.
 * @property {{projects: string[], boundaries: string[], constraints: string[],
 *   decisions: string[]}} affected Identity strings only, each sorted and
 *   de-duplicated.
 */

/**
 * Classifies one evolution event from its evidence signals — deterministic
 * and pure (no clock, no fs). Each predicate is a fact about the input,
 * never an inference (design §2):
 *
 * | Class | Predicate (all must hold) |
 * |---|---|
 * | CHANGE | structural diff between base/head non-empty |
 * | DRIFT | `codeDrift` signal, OR declared intent rows `undeclared`/`unfulfilled`
 *   by the head; and NOT merely a policy-only transition; and no
 *   DECISION_CHANGE asserted (a supersession is DECISION_CHANGE, never DRIFT) |
 * | VIOLATION | introduced violations non-empty with ≥1 not-waived, OR a declared
 *   constraint verdict `fail` |
 * | REPAIR | resolved violations non-empty, OR drift findings resolved, OR active
 *   debt entries closed |
 * | DECISION_CHANGE | same ADR id with a different status between base/head, or a
 *   new `supersedes` relation. REQUIRES both sides' registries — either side
 *   absent (`null`) ⇒ NOT asserted, note added |
 *
 * The `affected` identities are derived from the same signals, never from a
 * second opinion: changed project names, the changed edges under the one
 * identity spelling (`edgeEvolutionIdentity`), the constraint/intent rows
 * whose verdict was not `pass`/`matched`, and the ADR ids whose lineage moved.
 *
 * @param {EvolutionEvidence} [input]
 * @returns {EvolutionClassification}
 */
export function classifyEvolution(input = {}) {
  const observed = input.observed ?? {};
  const projects = observed.projects ?? { added: [], removed: [], changed: [] };
  const edges = observed.edges ?? { added: [], removed: [] };
  const addedProjects = projects.added ?? [];
  const removedProjects = projects.removed ?? [];
  const changedProjects = projects.changed ?? [];
  const addedEdges = (edges.added ?? []).map(evolutionBoundary);
  const removedEdges = (edges.removed ?? []).map(evolutionBoundary);
  const structureChanged =
    addedProjects.length +
      removedProjects.length +
      changedProjects.length +
      addedEdges.length +
      removedEdges.length >
    0;

  const codeDrift = input.codeDrift === true;
  const policyChanged = observed.policyChanged ?? false;
  // One-sided is an input fact (`snapshot-meta`'s `policyOneSided`), never
  // derived from `policyChanged === null`: both-absent also yields `null` but
  // is comparable, and deriving one-sided from it would disclose a refusal
  // that is not real.
  const policyOneSided = observed.policyOneSided === true;
  // Provenance actually advanced (both sides record a commit and they
  // differ). Pair an unverifiable policy with advancing provenance and the
  // transition carried real code motion that cannot be classified — never a
  // "fully comparable, unchanged pair".
  const provenanceAdvanced = observed.provenanceChanged === true;

  const violations = input.violations ?? {};
  const introduced = violations.introduced ?? [];
  const resolved = violations.resolved ?? [];
  const unknown = violations.unknown ?? [];
  const declaredConstraints = input.declaredConstraints ?? [];
  const declaredIntentRows = input.declaredIntentRows ?? [];
  const driftFindingsResolved = input.driftFindingsResolved ?? [];
  const debtResolved = input.debtResolved ?? [];

  const adrBase = input.adrBase;
  const adrHead = input.adrHead;
  // One-sided mirror of history's policyOneSided: exactly ONE side carries a
  // registry. Both sides absent ("no decision evidence supplied", like
  // snapshots that record no fingerprint on either side) is comparable —
  // nothing was asserted, and there is nothing to disclose. Either side
  // `null` (the side does not record one) while the other carries the
  // registry is "could not be compared".
  const decisionOneSided = (adrBase == null) !== (adrHead == null);

  const notes = [];
  const classifications = new Set();
  const constraintIds = [];
  const decisionIds = [];

  if (structureChanged) {
    classifications.add("CHANGE");
  }

  // Disclosures first, so every note is in the record even when a predicate
  // below has nothing to add — a transition's notes must not depend on its
  // classes. The wording mirrors `commands/history.mjs`'s `classifyTransition`
  // for the same signals, so the two surfaces read the same facts the same way.
  if (policyChanged === true) {
    notes.push(
      "policy (the declared architectural intent) changed between these snapshots — " +
        "the boundary law differs even though the graph may not",
    );
  }
  if (policyOneSided) {
    notes.push(
      "policy (the declared architectural intent) could not be compared — one side of " +
        "the transition records the boundary law and the other does not",
    );
  }
  if (observed.policyChanged === null && provenanceAdvanced) {
    notes.push(
      "policy (the declared architectural intent) could not be compared — neither side " +
        "records the boundary law while the provenance advanced, so the pair cannot be " +
        "classified (code motion may be hidden)",
    );
  }
  if (decisionOneSided) {
    notes.push(
      "the decision registry (docs/adr) could not be compared — one side of the " +
        "transition records it and the other does not",
    );
  }

  // Verdict-relevant unknowns: an entry the input cannot classify is NEVER
  // folded into a clean result. Each one is disclosed, and any of them makes
  // the disposition `no-verdict` (never a fabricated accepted/rejected).
  let verdictRelevantUnknown = false;
  for (const entry of unknown) {
    verdictRelevantUnknown = true;
    notes.push(
      `delta entry '${entry.id}' could not be classified` +
        (typeof entry.reason === "string" && entry.reason !== "" ? ` — ${entry.reason}` : ""),
    );
  }
  for (const row of declaredConstraints) {
    constraintIds.push(row.id);
    if (row.verdict !== "pass" && row.verdict !== "fail") {
      verdictRelevantUnknown = true;
      notes.push(
        `declared constraint '${row.id}' verdict '${row.verdict}' could not be determined`,
      );
    }
  }
  for (const row of declaredIntentRows) {
    if (
      row.verdict !== "matched" &&
      row.verdict !== "undeclared" &&
      row.verdict !== "unfulfilled" &&
      row.verdict !== "unproven"
    ) {
      verdictRelevantUnknown = true;
      notes.push(`declared intent row '${row.id}' carries an unknown verdict '${row.verdict}'`);
    } else if (row.verdict === "unproven") {
      verdictRelevantUnknown = true;
      notes.push(
        `declared intent row '${row.id}' is unproven — its verdict could not be determined`,
      );
    }
    if (row.verdict !== "matched") {
      constraintIds.push(row.id);
    }
  }

  // VIOLATION — introduced non-waived entries are the violations that count; a
  // waived introduction is a disclosed, non-gating fact, never a violation —
  // and an introduction whose every entry is waived is disclosed too, so the
  // empty classification below never reads as "nothing moved".
  const introducedNotWaived = introduced.filter((entry) => entry.waived !== true);
  const failedConstraints = declaredConstraints.filter((row) => row.verdict === "fail");
  if (introducedNotWaived.length > 0 || failedConstraints.length > 0) {
    classifications.add("VIOLATION");
  }
  if (introduced.length > 0 && introducedNotWaived.length === 0) {
    notes.push("introduced violations are all waived — not classified as VIOLATION");
  }

  // REPAIR — resolved violations, resolved drift findings, or closed debt.
  if (resolved.length > 0 || driftFindingsResolved.length > 0 || debtResolved.length > 0) {
    classifications.add("REPAIR");
  }

  // DECISION_CHANGE — the ADR lineage moved between base and head. Both sides'
  // registries are REQUIRED: either side absent is the one-sided case, and
  // "could not be compared" is disclosed, never asserted as a change.
  if (!decisionOneSided) {
    const baseRecords = adrBase?.records ?? [];
    const headRecords = adrHead?.records ?? [];
    const baseStatus = new Map(baseRecords.map((record) => [record.id, record.status]));
    const baseSupersedes = new Map(
      baseRecords.map((record) => [record.id, new Set(record.supersedes ?? [])]),
    );
    for (const record of headRecords) {
      if (baseStatus.has(record.id) && baseStatus.get(record.id) !== record.status) {
        decisionIds.push(record.id);
      }
      const relationsAtBase = baseSupersedes.get(record.id) ?? new Set();
      for (const target of record.supersedes ?? []) {
        if (!relationsAtBase.has(target)) {
          decisionIds.push(record.id, target);
        }
      }
    }
    if (decisionIds.length > 0) {
      classifications.add("DECISION_CHANGE");
    }
  }

  // DRIFT — the one predicate with a guard and an exclusion. The guard: not
  // merely a policy-only transition (a policy change with no other signal is
  // disclosed, never DRIFT). The exclusion: a supersession between two
  // registry states is DECISION_CHANGE, never DRIFT (design §9), so the code
  // drift signal is not ALSO classified DRIFT when the lineage moved.
  if (!classifications.has("DECISION_CHANGE")) {
    const otherSignals =
      structureChanged ||
      codeDrift ||
      introduced.length > 0 ||
      resolved.length > 0 ||
      unknown.length > 0 ||
      driftFindingsResolved.length > 0 ||
      debtResolved.length > 0 ||
      declaredConstraints.some((row) => row.verdict !== "pass") ||
      declaredIntentRows.some((row) => row.verdict !== "matched");
    const merelyPolicyOnly = policyChanged === true && !otherSignals;
    const intentViolated = declaredIntentRows.filter(
      (row) => row.verdict === "undeclared" || row.verdict === "unfulfilled",
    );
    let drifted = intentViolated.length > 0;
    if (codeDrift) {
      if (policyOneSided) {
        notes.push("code drift cannot be asserted — the policy change could not be compared");
      } else if (!merelyPolicyOnly) {
        drifted = true;
      }
    }
    if (drifted) {
      classifications.add("DRIFT");
      for (const row of intentViolated) {
        constraintIds.push(row.id);
      }
    }
  }

  // The disposition: `no-verdict` on any verdict-relevant unknown (never a
  // fabricated accepted/rejected), `rejected` on introduced non-waived
  // violations, a declared constraint `fail`, or undeclared / unfulfilled
  // declared-intent rows, `accepted` otherwise — including the fully
  // comparable, unchanged pair.
  /** @type {"accepted"|"rejected"|"no-verdict"} */
  let disposition = "accepted";
  if (verdictRelevantUnknown) {
    disposition = "no-verdict";
  } else if (
    introducedNotWaived.length > 0 ||
    failedConstraints.length > 0 ||
    declaredIntentRows.some((row) => row.verdict === "undeclared" || row.verdict === "unfulfilled")
  ) {
    disposition = "rejected";
  }

  const classificationsList = [...classifications].sort();

  // **An empty result is a claim.** `[]` classifications appear ONLY for a
  // fully comparable, unchanged pair, and the event says so; an input that
  // could not be fully classified never reads as a clean "nothing happened".
  // Each other empty-list case carries its own disclosure (the one-sided
  // notes, the waiver note, the unknown-entry notes), so no branch of this
  // block produces a silent `[]`.
  if (classificationsList.length === 0) {
    const signaledButUnclassified =
      introduced.length > 0 ||
      resolved.length > 0 ||
      driftFindingsResolved.length > 0 ||
      debtResolved.length > 0;
    if (
      !verdictRelevantUnknown &&
      !signaledButUnclassified &&
      !policyOneSided &&
      !decisionOneSided &&
      !(observed.policyChanged === null && provenanceAdvanced)
    ) {
      notes.push("a fully comparable, unchanged pair — no classification applies");
    }
  }

  const uniqueSorted = (values) => [...new Set(values)].sort();

  return {
    classifications: classificationsList,
    disposition,
    notes,
    affected: {
      projects: uniqueSorted([...addedProjects, ...removedProjects, ...changedProjects]),
      boundaries: uniqueSorted([...addedEdges, ...removedEdges]),
      constraints: uniqueSorted(constraintIds),
      decisions: uniqueSorted(decisionIds),
    },
  };
}
