/**
 * The decision builder: turns a command's verdict counts into the `decision`
 * the envelope optionally carries, enforcing the five evidence invariants
 * (`../governance/verdict.mjs` states them) in code rather than leaving them
 * to a docs page a later command author might not read.
 *
 * This module decides nothing about whether a finding IS one — the command
 * that built the envelope owns that. What it decides is whether the verdict
 * and its evidence AGREE, and it throws when they do not, the same posture
 * `jsonEnvelope` takes for the three consistency rules it enforces: a
 * mismatch here is a bug in the command, not a fact about the workspace.
 *
 * The shape it produces:
 *
 *   {
 *     verdict: "pass" | "fail" | "unknown" | "not_applicable",
 *     reason?: string,                // always present for unknown
 *     notApplicableReason?: string,   // always present for not_applicable
 *     sampleTime?: string             // opt-in, never on a deterministic envelope
 *   }
 *
 * A caller may pass `reason` for `unknown` — it names WHICH could-not-look
 * condition fired (coverage incomplete, an unresolved intent boundary, a
 * thrown analysis). Without it, `buildDecision` states the generic one. The
 * reason field itself is always present on an `unknown` decision (I3).
 *
 * ## Determinism is the default
 *
 * The envelope this decision rides on is byte-deterministic
 * (`docs/reference/json-output.md`: no timestamp, no random identifier). So
 * `sampleTime` is OPT-IN by construction: a command passes it explicitly when
 * it is an age/count capability (waivers, debt, health — the features
 * `../governance/clock.mjs` serves), and a command whose verdict must stay
 * reproducible over an unchanged tree emits a decision with no time at all.
 * That is how the determinism↔time tension is resolved — the clock is
 * injectable (a test drives the same code with a fixed time), never asserted
 * from the wall clock.
 *
 * ## The invariants, executable
 *
 * I1. `pass` requires complete coverage. A run that could not fully read the
 *     tree can never pass — the same refusal `jsonEnvelope` makes for
 *     `status: "ok"` over incomplete coverage, at the verdict layer.
 * I2. `fail` requires at least one finding. A failing verdict that names no
 *     finding leaves the reader guessing what failed.
 * I3. `unknown` requires a reason. `unknown` is a claim that something could
 *     not be determined, and the reader has to be able to tell what.
 * I4. `not_applicable` requires `notApplicableReason`. "Did not apply" and
 *     "did not run" are indistinguishable without it.
 * I5. The cardinal rule: a failed analysis or an unresolved question must
 *     emit `unknown`, NEVER `pass` — enforced here by I1's first check
 *     (pass + not-complete throws) and by every caller choosing `unknown`
 *     wherever the run did not reach a verdict.
 *
 * `not_applicable` has no envelope status, so `buildDecision` reaches it only
 * through an explicit `verdict` — the route a Fitness or Waiver capability
 * (a later governance wave) takes. Engine behavior today never passes it:
 * `jsonEnvelope` refuses a `decision.verdict` that contradicts the envelope's
 * `status`, and no status maps to `not_applicable`, so the state is locked
 * out of every envelope this release builds.
 */
import { verdictForStatus } from "../governance/verdict.mjs";

/**
 * Builds the `decision` a verdict's counts produce.
 *
 * @param {{
 *   verdict?: "pass"|"fail"|"unknown"|"not_applicable",
 *   status?: "ok"|"findings"|"no-verdict",
 *   coverageComplete: boolean,
 *   findings: number,
 *   reason?: string|null,
 *   notApplicableReason?: string|null,
 *   sampleTime?: string
 * }} run
 * @returns {{verdict: string, reason?: string, notApplicableReason?: string,
 *   sampleTime?: string}}
 * @throws {Error} on any invariant violation (I1–I4).
 */
export function buildDecision(run) {
  if (run.verdict === undefined && run.status === undefined) {
    // No status, no explicit verdict — a builder called with neither is a
    // programming error, not a fact about the workspace.
    throw new Error("lattice: buildDecision needs either a status or an explicit verdict");
  }
  const verdict = run.verdict ?? verdictForStatus(run.status);
  if (
    run.verdict !== undefined &&
    run.status !== undefined &&
    run.verdict !== verdictForStatus(run.status)
  ) {
    throw new Error(
      `lattice: refusing to build a decision where verdict "${run.verdict}" contradicts status ` +
        `"${run.status}" — status implies ${verdictForStatus(run.status)}, and a decision that ` +
        `disagrees with its own status would make one of the two a lie. ` +
        `This is a bug in the command that built the decision.`,
    );
  }

  if (verdict === "pass") {
    if (run.coverageComplete !== true) {
      throw new Error(
        `lattice: refusing to emit a "pass" decision over incomplete coverage ` +
          `(coverage.complete: ${run.coverageComplete}) — a run that could not fully read the ` +
          `tree can never pass. This is a bug in the command that built the decision.`,
      );
    }
    if (run.findings > 0) {
      throw new Error(
        `lattice: refusing to emit a "pass" decision with ${run.findings} finding(s) — ` +
          `"pass" and "fail" cannot both be true of the same run. This is a bug in the command.`,
      );
    }
    return withSampleTime({ verdict }, run.sampleTime);
  }

  if (verdict === "fail") {
    if (run.findings < 1) {
      throw new Error(
        `lattice: refusing to emit a "fail" decision with no findings — a failing verdict ` +
          `must name what failed. This is a bug in the command that built the decision.`,
      );
    }
    return withSampleTime({ verdict }, run.sampleTime);
  }

  if (verdict === "unknown") {
    const reason =
      run.reason ??
      (run.coverageComplete === true ? "no verdict was reached" : "coverage was incomplete");
    return withSampleTime({ verdict, reason }, run.sampleTime);
  }

  // verdict === "not_applicable" (I4).
  if (!run.notApplicableReason) {
    throw new Error(
      `lattice: refusing to emit a "not_applicable" decision without notApplicableReason — ` +
        `"did not apply" and "did not run" must never be indistinguishable. ` +
        `This is a bug in the command that built the decision.`,
    );
  }
  return withSampleTime({ verdict, notApplicableReason: run.notApplicableReason }, run.sampleTime);
}

/**
 * Adds `sampleTime` to the decision only when the caller opted into time —
 * the determinism rule in this module's header. Absent `sampleTime`, the
 * decision object carries exactly the invariant-bearing fields and nothing
 * more.
 *
 * @param {object} decision
 * @param {string|undefined} sampleTime
 * @returns {object}
 */
function withSampleTime(decision, sampleTime) {
  return sampleTime === undefined ? decision : { ...decision, sampleTime };
}
