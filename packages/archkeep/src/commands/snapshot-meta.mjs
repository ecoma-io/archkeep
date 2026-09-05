/**
 * Shared comparison of the snapshot metadata two graph envelopes carry beyond
 * the graph itself — provider, repository provenance, and policy fingerprint.
 * `diff` and `history` both need to know whether these changed between two
 * states, and they must agree about it, so the comparison lives here once
 * rather than in each (`../README.md`'s "single home" rule applied to a fact
 * two commands share).
 *
 * This is a pure function of its arguments and decides nothing about exit
 * codes or renderings: it reports raw facts — changed / unchanged /
 * unverifiable — and each consumer decides what a fact means. `diff` renders
 * them as `coverage.notes` and `result.policyMismatch`; `history` renders them
 * as a transition's change classification. The two could drift only if one
 * stopped calling this, which is the point of sharing it.
 *
 * "Unverifiable" is a deliberate third state, never collapsed into
 * "unchanged". When a side is missing a field, this tool cannot assert the
 * metadata is the same — asserting so would be the silent direction
 * (`../../../../AGENTS.md`): reporting "no change" where it cannot look.
 *
 * `provenanceChanged`/`policyChanged` are `null` exactly when the comparison
 * could not be made (one side missing), which is why a consumer must check for
 * `null` before treating either as a boolean.
 */

/**
 * The one wording for the dirty-baseline disclosure, shared by every command
 * that compares a snapshot pair (`diff`, `delta`, `change`). Three copies of
 * one disclosure spell drift three ways, so the wording lives beside the fact
 * it translates. A consumer that pins the baseline by its own contract names
 * that pin (`pinned`) — `change`'s contract carries `base.commit`; a diff or
 * delta pair has no such pin, so its note names the commit the snapshot
 * itself claims.
 *
 * @param {boolean} pinned Whether the consumer's contract pins the base commit.
 * @returns {string} The disclosure note.
 */
export function dirtyBaselineNote(pinned) {
  return pinned
    ? "the baseline was captured from a dirty working tree — its evidence is not a reproducible " +
        "claim about the commit the contract pins"
    : "the baseline was captured from a dirty working tree — its evidence is not a reproducible " +
        "claim about the commit it names";
}

/**
 * The one wording for the dirty-head disclosure — byte-identical in every
 * consumer, so it is stated exactly once.
 *
 * @returns {string} The disclosure note.
 */
export function dirtyHeadNote() {
  return (
    "this run's working tree is dirty — the head side describes uncommitted state, not the " +
    "commit HEAD names"
  );
}

/**
 * Compares the provider, provenance, and policy fingerprint of two graph
 * envelopes.
 *
 * @param {{baselineProvider: string|null, headProvider: string|null,
 *   baselineProvenance: {commit: string, remote: string|null, dirty: boolean}|null,
 *   headProvenance: {commit: string, remote: string|null, dirty: boolean}|null,
 *   baselineFingerprint: string|null, headFingerprint: string|null}} input
 * @returns {{providerChanged: boolean,
 *   provenanceChanged: boolean|null, provenanceOneSided: boolean, crossRepo: boolean,
 *   dirtyBaseline: boolean, dirtyHead: boolean,
 *   policyChanged: boolean|null, policyOneSided: boolean,
 *   policyMismatch: {baseline: {fingerprint: string}, head: {fingerprint: string}}|null}}
 */
export function compareSnapshotMetadata({
  baselineProvider,
  headProvider,
  baselineProvenance,
  headProvenance,
  baselineFingerprint,
  headFingerprint,
}) {
  // Provider differs only when the baseline actually names one — a snapshot
  // that predates the workspace header cannot be asserted different (diff's
  // original condition, kept exact so its notes are byte-identical).
  const providerChanged = !!baselineProvider && baselineProvider !== headProvider;

  let provenanceChanged = null;
  let provenanceOneSided = false;
  let crossRepo = false;
  if (baselineProvenance && headProvenance) {
    provenanceChanged = baselineProvenance.commit !== headProvenance.commit;
    if (
      baselineProvenance.remote &&
      headProvenance.remote &&
      baselineProvenance.remote !== headProvenance.remote
    ) {
      crossRepo = true;
    }
  } else if ((baselineProvenance && !headProvenance) || (!baselineProvenance && headProvenance)) {
    // Exactly one side carries provenance — the comparison is unverifiable.
    provenanceOneSided = true;
  }
  // Both sides missing provenance: provenanceChanged stays null (we cannot
  // assert anything) but not "one-sided", so no note about an uneven pair.

  let policyChanged = null;
  let policyOneSided = false;
  if (baselineFingerprint && headFingerprint) {
    policyChanged = baselineFingerprint !== headFingerprint;
  } else if (
    (baselineFingerprint && !headFingerprint) ||
    (!baselineFingerprint && headFingerprint)
  ) {
    policyOneSided = true;
  }
  // Both sides carrying no fingerprint: policyChanged stays null — no config
  // was ever provided, so neither "changed" nor a one-sided warning applies.

  // A snapshot taken from a dirty (uncommitted) tree is not a reproducible
  // claim about the commit it names (`../../commands/provenance.mjs`'s header),
  // so each consumer is told when either side came from one. Consumers decide
  // what the fact means — `history` discloses it, `diff` leaves it to its own
  // notes.
  const dirtyBaseline = baselineProvenance?.dirty === true;
  const dirtyHead = headProvenance?.dirty === true;

  return {
    providerChanged,
    provenanceChanged,
    provenanceOneSided,
    crossRepo,
    dirtyBaseline,
    dirtyHead,
    policyChanged,
    policyOneSided,
    policyMismatch:
      policyChanged === true
        ? { baseline: { fingerprint: baselineFingerprint }, head: { fingerprint: headFingerprint } }
        : null,
  };
}
