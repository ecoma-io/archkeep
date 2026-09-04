/**
 * Decision fitness — the "IS IT STILL TRUE" verification level, one per
 * decision that carries authority.
 *
 * This module DERIVES a decision's verification level from its attached
 * executable constraints and their verdicts. It is a pure, descriptive reader
 * of the governance state:
 *
 *   - it READS the decision's `bindings` (the constraint/fitness ids a record
 *     makes enforceable) and the fitness-registry's verdicts for those
 *     constraints;
 *   - it never judges a constraint itself — the verdict for a bound constraint
 *     comes in from the caller (a fitness-registry run), and `decisionFitness`
 *     only folds those verdicts into one per-decision level;
 *   - it is NOT wired into `check` exit codes this wave — a violated or
 *     unverifiable decision does not fail `check` (Wave 2 keeps decision
 *     fitness descriptive; see the Wave 2 design contract's scope section).
 *
 * ## The vocabulary (per decision, only for decisions WITH authority)
 *
 * A decision with no authority (`proposed` a draft, `superseded` replaced,
 * `retired` withdrawn) is not measured — its fitness is `not_applicable` with
 * a reason. A decision with authority is `active` (accepted and currently
 * governing) or `accepted` (a decision made and recorded, "not yet verified"
 * is a valid intermediate).
 *
 *   - `enforced` — at least one bound executable constraint/fitness resolves
 *     AND was evaluated AND passed (verified true).
 *   - `partially-enforced` — some bound constraints evaluated & passed, but
 *     others are unverified / coverage incomplete.
 *   - `violated` — at least one bound constraint/fitness FAILED: the decision's
 *     "what must remain true" is currently false. RED direction.
 *   - `unverifiable` — the decision has authority but no bound constraint/
 *     fitness can be resolved/evaluated. RED direction — it is NEVER a pass;
 *     "no violation" is not healthy.
 *
 * "Healthy" is NOT derivable from "no violations": a decision with no
 * executable constraint is `unverifiable`, never healthy. `violated` and
 * `unverifiable` are the two red directions; `enforced` is the only fully-green
 * one.
 *
 * ## No `stale`, deliberately
 *
 * The contract offers a `stale` level only if the repository already has a
 * time-based staleness notion. It does not (no decision-verification staleness
 * exists anywhere in `src/`), so `stale` is folded into `unverifiable`: a
 * decision whose evidence is out of date is, like one with no reachable
 * constraint, not verified true — same red meaning, deterministic, no clock.
 *
 * ## Determinism
 *
 * No wall-clock time enters the model. The `io` argument exists for signature
 * parity and future dependency injection (e.g. an injected clock), but the
 * derivation needs none: it reads only the bound verdicts a caller supplies,
 * so identical inputs yield byte-identical output. A caller that does need a
 * timestamp (a later wave) injects the clock through `io` rather than reading
 * the wall clock.
 */

import { hasAuthority } from "./adr-registry.mjs";

/** The closed set of per-decision fitness levels `computeDecisionFitness` emits. */
export const DECISION_FITNESS_LEVELS = Object.freeze([
  // used by its own test
  "enforced",
  "partially-enforced",
  "violated",
  "unverifiable",
  "not_applicable",
]);

/** Whether a level names a red (never-healthy) direction. */
export function isRedDirection(level) {
  // used by its own test
  return level === "violated" || level === "unverifiable";
}

/**
 * The resolver that turns a bound constraint id into its verdict record.
 *
 * @typedef {(bindingId: string) => (object | undefined)} DecisionRefLookup
 *   Returns the fitness/constraint verdict for a bound id, or `undefined` when
 *   no constraint resolves (or no verdict was produced for it) — a binding the
 *   lookup cannot answer is an UNVERIFIED binding, never a silent pass.
 */

/**
 * The per-decision fitness level.
 *
 * @typedef {object} DecisionFitness
 * @property {string} id The record id (`NNN-slug`).
 * @property {string} status The record's lifecycle status.
 * @property {string} level One of `DECISION_FITNESS_LEVELS`.
 * @property {boolean} verified True only for `enforced` — the decision's
 *   "what must remain true" has a constraint that verifies true.
 * @property {string} [reason] WHY the level, present on every non-`enforced`
 *   level (which constraint failed, why "not applicable", why nothing
 *   verified). Optional: `enforced` needs no reason.
 */
/**
 * Computes the per-decision verification level for every record.
 *
 * Deterministic and pure: folds the supplied per-constraint verdicts into one
 * level per decision, reading only the arguments. Bindings that fail win over
 * everything (`violated`); when nothing fails and nothing passes, the decision
 * is `unverifiable` — never healthy, the silent direction this vocabulary
 * exists to refuse.
 *
 * @param {Array<{id: string, status: string, bindings: string[]}>} records
 *   The ADR registry's parsed records (a `loadAdrRegistry` result or an
 *   equivalent in tests).
 * @param {unknown} _fitnessVerdicts
 *   Reserved for parity with the wave's call shape. `computeDecisionFitness`
 *   it (the lookup is the single door through which verdicts enter, so the
 *   derivation stays agnostic to how the caller keys them).
 * @param {DecisionRefLookup} decisionRefLookup Resolves a bound constraint id
 *   to its verdict record (or `undefined` when it does not resolve / was not
 *   evaluated). The only door through which verdicts enter the derivation.
 * @param {object} [_io] The reserved `io` injection seam the wave's call shape
 *   coordinates on. This derivation is pure and needs no clock (see the
 *   no-`stale` note), so it is intentionally unused here; a later timestamp-
 *   bearing wave injects a clock through this slot.
 * @returns {DecisionFitness[]} One entry per record, in input order.
 */
export function computeDecisionFitness(records, _fitnessVerdicts, decisionRefLookup, _io = {}) {
  /** @type {DecisionFitness[]} */
  const out = [];

  for (const record of records) {
    if (!hasAuthority(record.status)) {
      out.push({
        id: record.id,
        status: record.status,
        level: "not_applicable",
        verified: false,
        reason: `status "${record.status}" carries no authority — only active/accepted decisions are measured`,
      });
      continue;
    }

    const bindings = record.bindings ?? [];
    const resolved = bindings
      .map((binding) => ({ binding, verdict: decisionRefLookup(binding) }))
      .filter((entry) => entry.verdict !== undefined) // an unresolved binding is unverified
      .map((entry) => entry.verdict);

    const failed = resolved.filter((v) => v.verdict === "fail");
    const passed = resolved.filter((v) => v.verdict === "pass");

    if (failed.length > 0) {
      out.push({
        id: record.id,
        status: record.status,
        level: "violated",
        verified: false,
        reason: `bound constraint "${failed[0].name}" FAILED — what-must-remain-true is currently false`,
      });
      continue;
    }

    if (passed.length === 0) {
      // RED: no bound constraint verifies true. Covers "no bindings",
      // "bindings resolve to nothing", and "bindings evaluate but return
      // unknown/not_applicable". Never a pass.
      out.push({
        id: record.id,
        status: record.status,
        level: "unverifiable",
        verified: false,
        reason: unverifiableReason(record, bindings, resolved),
      });
      continue;
    }

    if (passed.length === bindings.length && resolved.length === bindings.length) {
      out.push({
        id: record.id,
        status: record.status,
        level: "enforced",
        verified: true,
      });
    } else {
      out.push({
        id: record.id,
        status: record.status,
        level: "partially-enforced",
        verified: false,
        reason:
          `${passed.length} of ${bindings.length} bound constraint(s) verified true; ` +
          `the rest are unverified or unevaluated`,
      });
    }
  }

  return out;
}

/**
 * Names WHY a decision with authority verifies nothing true.
 *
 * @param {{id: string}} record
 * @param {string[]} bindings
 * @param {Array<{name: string, verdict: string}>} resolved
 * @returns {string}
 */
function unverifiableReason(record, bindings, resolved) {
  if (bindings.length === 0) {
    return `no executable constraint/fitness is bound to ${record.id} — nothing can be verified`;
  }
  if (resolved.length === 0) {
    return `no bound constraint for ${record.id} resolves or was evaluated — none can be verified`;
  }
  const names = resolved.map((v) => v.name ?? "?").join(", ");
  return `bound constraint(s) ${names} evaluated but none verified true — coverage incomplete, not enforced`;
}
