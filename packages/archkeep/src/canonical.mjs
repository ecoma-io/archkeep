/**
 * Canonical JSON — the deterministic serialization Contract K's fingerprints
 * are built on: plain-object keys sorted at every depth so two objects meaning
 * the same thing serialize identically.
 *
 * The one rule that matters: **only plain-object keys are sorted.** Array
 * element order is never re-ordered, on purpose — for a boundary policy's
 * `depConstraints` and an intent's `dependencies.forbidden` rows, order is
 * semantic, and a fingerprint that ignored it could not tell two arrangements
 * apart. A fingerprint therefore *changes* when rows are re-ordered, which is
 * correct.
 *
 * Used by `computePolicyFingerprint` (`../commands/graph.mjs`), the intent
 * fingerprint (`./architecture-intent/intent-fingerprint.mjs`), the
 * evidence-snapshot serializer
 * (`./commands/delta-snapshot.mjs`, through the exported replacer below), and
 * anything else a fingerprint or a byte-deterministic file is produced from —
 * one canonicalizer, in one place, so two serializations cannot drift.
 */

/**
 * The `JSON.stringify` replacer that sorts plain-object keys at every depth.
 *
 * Exported beside `canonicalizeJson` so a serializer that needs a different
 * `JSON.stringify` spacing can run the SAME rule rather than grow a second
 * copy of it: `canonicalizeJson` passes this replacer at compact spacing, and
 * `./commands/delta-snapshot.mjs`'s `serializeEvidenceSnapshot` passes it at
 * two-space spacing, so both spellings sort identically by construction.
 *
 * @param {string} _key The key being visited; `JSON.stringify` calls the
 *   replacer once per key and once for the root with `""`.
 * @param {*} current The value at that key.
 * @returns {*} The value to serialize in its place — a key-sorted copy when
 *   `current` is a plain object, `current` itself otherwise.
 */
export function canonicalJsonReplacer(_key, current) {
  if (current !== null && typeof current === "object" && !Array.isArray(current)) {
    // A null-prototype accumulator, not `{}`: `JSON.parse('{"__proto__":…}')`
    // produces an OWN key literally named "__proto__" (JSON has no notion of
    // prototypes), and `sorted[keyName] = …` on an ordinary object treats
    // that one key specially — it sets the object's prototype instead of
    // creating an own property, so the key silently vanishes from
    // `JSON.stringify`'s output. Two documents that disagree only in a
    // `__proto__` field would then canonicalize identically, a silent
    // fingerprint collision (`../../../AGENTS.md`, "An empty result is a claim,
    // not a shrug" — this is the same failure shape: two different inputs
    // must never produce one indistinguishable output). `Object.create(null)`
    // has no `__proto__` accessor to intercept the assignment, so every key
    // — "__proto__" included — always becomes a real own property.
    const sorted = Object.create(null);
    for (const keyName of Object.keys(current).sort()) {
      sorted[keyName] = current[keyName];
    }
    return sorted;
  }
  return current;
}

/**
 * Serialize `value` with keys sorted at every object level.
 *
 * @param {*} value Any JSON-serializable value.
 * @returns {string} The canonical serialization.
 */
export function canonicalizeJson(value) {
  return JSON.stringify(value, canonicalJsonReplacer);
}
