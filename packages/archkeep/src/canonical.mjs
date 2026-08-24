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
 * fingerprint (`./intent-fingerprint.mjs`), and anything else a fingerprint
 * is computed over — one canonicalizer, in one place, so two serializations
 * cannot drift.
 */

/**
 * Serialize `value` with keys sorted at every object level.
 *
 * @param {*} value Any JSON-serializable value.
 * @returns {string} The canonical serialization.
 */
export function canonicalizeJson(value) {
  return JSON.stringify(value, (key, current) => {
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
  });
}
