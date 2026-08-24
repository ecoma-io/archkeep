/**
 * The waiver model: a `boundarySuppressions` row with an `expiresAt` is a
 * WAIVER, and this module is the single place that decides what one does at a
 * given reference time.
 *
 * The distinction from a legacy suppression (a row with no `expiresAt`) is the
 * whole point of the feature:
 *
 * - a **suppression** removes a violation the workspace decided to accept,
 *   permanently, and a run whose violations are all suppressed reads clean
 *   (exit 0 — that is the existing boundary feature, unchanged);
 * - a **waiver** accepts a violation TEMPORARILY. It never removes the
 *   violation from the run's findings — a run whose only findings are waived
 *   is NOT clean (the exit code stays 1), because accepting a boundary breach
 *   for a fixed term is a tracked decision, not a fix. An ACTIVE waiver marks
 *   the violation as waived (the report renders it under "accepted
 *   violations"); an EXPIRED waiver stops covering it, and the violation
 *   re-asserts itself in full with the evidence `"expired waiver"`.
 *
 * That preserves the load-bearing invariant in `../../../../AGENTS.md`: an
 * empty diagnostic list must mean "no violation" and nothing else. Waiving
 * never makes a finding disappear; it annotates one. And because suppressions
 * filter VERDICTS after every site has been judged (never skip sites
 * up-front), a waiver can never promote `unknown` → `pass` — the "could not
 * tell" failures travel beside the records and no waiver ever touches them.
 *
 * The clock is the shared governance contract (`./clock.mjs`): injectable,
 * so the bytes a run emits are reproducible over an unchanged tree and an
 * unchanged injected reference time (the determinism rule every governance
 * capability shares).
 */

import { referenceTime } from "./clock.mjs";

/** The evidence a re-asserted violation carries after its waiver expired. */
export const EXPIRED_WAIVER_EVIDENCE = "expired waiver";

/**
 * Whether a suppression row is a waiver. Presence of `expiresAt` is the
 * distinguishing field — validated by `../config.mjs` to be a parseable ISO
 * instant when present, so a malformed one never reaches this module.
 *
 * @param {object|null|undefined} row A `boundarySuppressions` entry.
 * @returns {boolean}
 */
export function isWaiver(row) {
  return row != null && typeof row === "object" && "expiresAt" in row;
}

/**
 * The waiver's expiry as epoch milliseconds. Only called on rows `isWaiver`
 * accepts, which config validation has guaranteed parseable.
 *
 * @param {object} row A `boundarySuppressions` entry with `expiresAt`.
 * @returns {number}
 */
export function expiresAtMs(row) {
  return Date.parse(String(row.expiresAt));
}

/**
 * Whether the waiver is in force at `now`. `now` is included: a waiver whose
 * expiry exactly equals the reference time is expired — a waiver "valid
 * through" a term means it covers strictly before `expiresAt`.
 *
 * @param {object} row A waiver (has `expiresAt`).
 * @param {string} [now] Reference instant, ISO-8601; defaults to the shared clock.
 * @returns {"active"|"expired"}
 */
export function waiverStatus(row, now = referenceTime()) {
  return Date.parse(now) >= expiresAtMs(row) ? "expired" : "active";
}

/**
 * Milliseconds until expiry — negative when expired. Fractional-time aware
 * (epoch-ms precision), which is the boundary every clock test drives.
 *
 * @param {object} row A waiver (has `expiresAt`).
 * @param {string} [now] Reference instant, ISO-8601; defaults to the shared clock.
 * @returns {number}
 */
export function remainingMs(row, now = referenceTime()) {
  return expiresAtMs(row) - Date.parse(now);
}

/**
 * What a suppression entry does to the violation it covers at `now`.
 *
 * - `"suppress"` — a legacy row (no expiry): the violation is removed, the
 *   existing boundary feature's semantics, unchanged.
 * - `"waive"` — an active waiver: the violation stays in this run's findings,
 *   marked `waivedBy` so the report can render it as an accepted violation.
 *   The run is still findings (exit 1) — waiving does not flip exit 1 → 0.
 * - `"reassert"` — an expired waiver: the violation stays, carrying
 *   `evidence: "expired waiver"`. A waiver that stopped being in force is
 *   a waiver that covers nothing, and the boundary it accepted is live again.
 *
 * @param {object} row A `boundarySuppressions` entry.
 * @param {string} [now] Reference instant, ISO-8601; defaults to the shared clock.
 * @returns {"suppress"|"waive"|"reassert"}
 */
export function suppressionFate(row, now = referenceTime()) {
  if (!isWaiver(row)) return "suppress";
  return waiverStatus(row, now) === "expired" ? "reassert" : "waive";
}
