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

/**
 * The shape a clock must have for a **record-`on`** producer. `now()`
 * returns a non-empty string.
 *
 * @typedef {object} Clock
 * @property {() => string} now
 */

/**
 * Refuses a value that is not a usable record clock, naming what was wrong.
 *
 * Loud on purpose: a clock handed to a place that would emit `on` and silently
 * ignored is exactly the silent direction — a record that claims a "when" it
 * never obtained. A caller that passes no clock at all never reaches this
 * check (the `on`-without-clock path is `provenance-record.mjs`'s own
 * refusal).
 *
 * @param {unknown} clock
 * @returns {string[]} Empty when `clock` is a usable clock.
 */
export function clockViolations(clock) {
  if (clock === null || typeof clock !== "object") {
    return [`clock must be an object with a now() function, got ${describe(clock)}`];
  }
  const now = /** @type {{now?: unknown}} */ (clock).now;
  if (typeof now !== "function") {
    return ["clock.now must be a function returning a non-empty string"];
  }
  const value = now();
  if (typeof value !== "string" || value.length === 0) {
    return ["clock.now() must return a non-empty string"];
  }
  return [];
}

/** A value's type, for an error message that shows what was actually there. */
function describe(value) {
  if (value === null) return "null";
  return `${typeof value} (${JSON.stringify(value) ?? String(value)})`;
}
