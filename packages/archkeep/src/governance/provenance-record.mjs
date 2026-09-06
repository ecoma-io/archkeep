/**
 * The provenance record: WHO decided a governance row, with WHICH tool, and
 * optionally WHEN — the auditable half of decision provenance.
 *
 * ## Shape
 *
 * ```json
 * { "by": "jane@example.com", "tool": "archkeep:v1", "on": "2026-08-16" }
 * ```
 *
 * `by` and `tool` are required non-empty strings; `on` is optional and is only
 * ever PRODUCED by the shared clock (`./clock.mjs`). This module has two
 * surfaces, and the split is the determinism rule made concrete:
 *
 * - **Read** — `originViolations`/`validateOrigin` shape-check an `origin`
 *   already committed in a declaration file. An `on` present there is a static
 *   fact about committed bytes, byte-identical across every read regardless of
 *   wall clock, so no clock is needed to read it.
 * - **Write** — `recordOrigin` is the ONLY producer of `on`. It refuses to run
 *   without a clock, loudly, and calls `clock.now()` exactly once for the
 *   record. A workspace that omits `on` entirely calls `recordOrigin` with the
 *   same clock and gets byte-identical bytes across runs; a workspace that
 *   records `on` hands a hermetic clock (a build id, a pinned value) so the
 *   claim is reproducible.
 *
 * ## Determinism — asserted both ways
 *
 * - Two runs over unchanged rows with the same clock are byte-identical.
 * - Two runs with different clocks differ — the clock is the single
 *   non-determinism door, which is exactly why it is the only door.
 *
 * ## Null-prototype safety
 *
 * `origin` and every nested object are read through plain-object checks that
 * reject arrays and non-plain objects, and enumeration uses `Object.keys`
 * (own, enumerable, never the prototype chain) — a crafted `{"__proto__": …}`
 * or a polluted prototype cannot smuggle keys into a validated origin. This
 * module builds nothing from untrusted keys; it validates and, at write time,
 * builds a fresh object with only the three permitted keys.
 */

import { clockViolations } from "./clock.mjs";
import { describe, isPlainObject } from "../values.mjs";

/** The only keys a validated `origin` may carry. */
export const ORIGIN_KEYS = Object.freeze(["by", "tool", "on"]); // used by its own test

/**
 * @typedef {object} OriginRecord
 * @property {string} by Who decided the row — a non-empty string (a name, an
 *   email, a handle). Free form; no format is enforced.
 * @property {string} tool Which tool or process recorded the decision — a
 *   non-empty string (`archkeep:v1`, `claude`, an ADR editor). Free form.
 * @property {string} [on] When the decision was recorded — present ONLY when
 *   `recordOrigin` produced it through the shared clock.
 */

/**
 * Everything wrong with a raw `origin` record at READ time, as messages; empty
 * when it is well-formed. Shape only — an `on` committed in a declaration file
 * is a static fact, so no clock is needed to read it.
 *
 * An `io.clock` may be supplied by a caller in a WRITE context (a command that
 * is about to emit `on`, or a test pinning determinism); it is then validated
 * itself and every `on` must equal its answer — a raw `on` can never ride
 * along beside a clock that would say something else.
 *
 * @param {unknown} raw
 * @param {{clock?: import("./clock.mjs").Clock}} [io]
 * @returns {string[]}
 */
export function originViolations(raw, io = {}) {
  if (!isPlainObject(raw)) {
    return [`origin must be an object, got ${describe(raw)}`];
  }

  const violations = [];
  const allowed = ORIGIN_KEYS;
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      violations.push(
        `origin.${key}: unknown key — an origin may carry only ${allowed.join(", ")}`,
      );
    }
  }

  if (typeof raw.by !== "string" || raw.by.trim() === "") {
    violations.push(
      `origin.by: must be a non-empty string naming who decided, got ${describe(raw.by)}`,
    );
  }
  if (typeof raw.tool !== "string" || raw.tool.trim() === "") {
    violations.push(
      `origin.tool: must be a non-empty string naming the tool that recorded the decision, got ${describe(raw.tool)}`,
    );
  }
  if ("on" in raw && (typeof raw.on !== "string" || raw.on.trim() === "")) {
    violations.push(`origin.on: must be a non-empty string when present, got ${describe(raw.on)}`);
  }

  // Write-context strictness: a caller that supplied a clock is about to emit
  // `on`, and the clock is the single door.
  if (io.clock !== undefined) {
    violations.push(...clockViolations(io.clock));
    if ("on" in raw && raw.on !== io.clock.now()) {
      violations.push(
        `origin.on: must equal the clock's answer (${JSON.stringify(io.clock.now())}), got ${describe(raw.on)} — the clock is the only producer of 'on'`,
      );
    }
  }

  return violations;
}

/**
 * Shape-validates an `origin` at read time and returns the row's own object
 * when valid; throws one Error naming every violation otherwise.
 *
 * Never walks the prototype chain and never builds from untrusted keys, so a
 * crafted `__proto__` cannot leak into a fresh object.
 *
 * @param {unknown} raw
 * @param {{clock?: import("./clock.mjs").Clock}} [io]
 * @param {string} at Dotted path of the field, for the message.
 * @returns {OriginRecord}
 * @throws {Error} naming every violation at once, prefixed by `at`.
 */
export function validateOrigin(raw, io = {}, at = "origin") {
  // used by its own test
  const violations = originViolations(raw, io).map((message) =>
    message.startsWith("origin.")
      ? `${at}.${message.slice("origin.".length)}`
      : `${at}: ${message}`,
  );
  if (violations.length > 0) {
    throw new Error(violations.join("; "));
  }
  return /** @type {OriginRecord} */ (raw);
}

/**
 * The one way a governance record obtains `on`: through the shared clock, and
 * nowhere else.
 *
 * @param {{by: string, tool: string, clock: import("./clock.mjs").Clock}} author
 *   The two required fields (shape checked like any read-time origin) plus the
 *   clock that supplies `on`. `clock` is required — an `on` produced without a
 *   clock is the non-determinism this module exists to exclude, so the absence
 *   is a loud Error, never a default.
 * @returns {OriginRecord} `{by, tool, on: clock.now()}`, and ONLY those three
 *   keys — a fresh object, so nothing from untrusted input rides along.
 * @throws {Error} on an invalid author, an unusable clock, or a
 *   non-string/empty clock answer.
 */
export function recordOrigin({ by, tool, clock }) {
  const origin = { by, tool };
  const shape = originViolations(origin);
  if (shape.length > 0) {
    throw new Error(shape.join("; "));
  }
  const clockProblems = clockViolations(clock);
  if (clockProblems.length > 0) {
    throw new Error(`origin.on: ${clockProblems.join("; ")}`);
  }
  // The clock is the single door, and it is called exactly once for this
  // record, so two calls with the same clock are byte-identical.
  return { by, tool, on: clock.now() };
}
