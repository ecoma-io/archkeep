/**
 * The intent fingerprint: canonical SHA-256 of the parsed intent, so a
 * consumer can tell "the tree drifted" from "the contract changed" between two
 * runs.
 *
 * This is the same canonicalization `computePolicyFingerprint` uses (the
 * shared `canonicalizeJson` sorts object keys at every depth, never array
 * elements) — an intentional change that deletes an intent row, or re-orders
 * one, moves the fingerprint even when the observed tree is unchanged. The
 * fingerprint is *directional* metadata a human or a pipeline diffing two
 * `drift --format json` outputs reads; the engine does not keep a baseline
 * intent file and auto-detect changes to it, because that is `diff`'s job and
 * would be a second mechanism (`../../drift-DESIGN.md` §4). What it does not
 * do is pass judgment: a fingerprint difference is exactly as meaningful as
 * the intent rows that moved, and only the author knows whether the move was
 * intentional — so the engine reports the change, never calls it drift.
 */
import { createHash } from "node:crypto";

import { canonicalizeJson } from "../canonical.mjs";

/**
 * The intent rows, in exactly the shape `validateIntent` returns.
 *
 * @typedef {import("./intent.mjs").DriftIntent} DriftIntent
 */

/**
 * @param {DriftIntent} intent The validated, parsed intent.
 * @returns {string} A hex-encoded SHA-256 fingerprint.
 */
export function computeIntentFingerprint(intent) {
  const canonical = canonicalizeJson(intent);
  return createHash("sha256").update(canonical).digest("hex");
}
