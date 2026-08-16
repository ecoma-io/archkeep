/**
 * The shared reference-time clock for every governance capability that emits
 * a timestamp or an age (waivers, debt, health — not the envelope itself,
 * which stays byte-deterministic without one).
 *
 * The contract the evidence format depends on is the one the whole governance
 * wave shares: **determinism and time are resolved by injection, never by
 * absolute wall-clock asserts.** A feature that emits a timestamp takes its
 * reference time from `referenceTime`, and a test drives the same code with a
 * fixed time — so the evidence a run produces is reproducible byte-for-byte
 * over an unchanged tree AND an unchanged injected clock, and a test never
 * depends on the machine it runs on.
 *
 * `referenceTime` returns a stable ISO-8601 UTC instant. It is a function so
 * the injectable default is trivial (delegate to `Date`) and the injectable
 * override is trivial (a constant). Both are the same call shape, so a
 * feature that takes an optional clock reads `clock ?? referenceTime` and
 * works either way.
 */

/**
 * The reference time as a stable ISO-8601 UTC string.
 *
 * @returns {string} e.g. `"2026-08-16T10:00:00.000Z"`.
 */
export function referenceTime() {
  return new Date().toISOString();
}
