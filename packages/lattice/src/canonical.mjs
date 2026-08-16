/**
 * Canonical JSON — the deterministic serialization Contract K's fingerprints
 * are built on: plain-object keys sorted at every depth so two objects meaning
 * the same thing serialize identically.
 *
 * The one rule that matters: **only plain-object keys are sorted.** Array
 * element order is never re-ordered, on purpose — for a policy's
 * `depConstraints` and an intent's `dependencies.forbidden` rows, order is
 * semantic (row order is author intent, and a fingerprint that ignored it
 * could not tell two arrangements apart). A fingerprint therefore *changes*
 * when rows are re-ordered, which is correct.
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
      const sorted = {};
      for (const keyName of Object.keys(current).sort()) {
        sorted[keyName] = current[keyName];
      }
      return sorted;
    }
    return current;
  });
}
