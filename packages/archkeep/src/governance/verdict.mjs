/**
 * The canonical 4-state verdict vocabulary every governance capability emits
 * and consumes — the single answer shape an architecture-governance envelope
 * carries.
 *
 * The vocabulary exists because the three statuses the envelope has always
 * used (`"ok"` / `"findings"` / `"no-verdict"`) are about THIS run's position
 * on THIS tree, while the governance wave needs a verdict an evidencing
 * process can compare across runs, feeds, and capabilities. The mapping is
 * the interesting part and it is one-way on purpose:
 *
 *   `"ok"`         → `"pass"`
 *   `"findings"`   → `"fail"`
 *   `"no-verdict"` → `"unknown"`
 *
 * and `"not_applicable"` has no source status in this release — no envelope
 * status maps to it, so it never rides an envelope. Engine behavior does emit
 * it today, on the paths that cannot judge: the fitness registry answers it
 * for a declared function whose `match` selects no observed project, and
 * again for `coverage-minimum` on a path-scoped run, which no scoped run can
 * judge; decision fitness derives it for a decision without authority; the
 * boundary metrics answer it when there is no boundary config to judge
 * against (`./metrics.mjs`). A
 * custom rule may return it as its own verdict — the host requires a
 * `notApplicableReason` (`../custom-rules/host.mjs`) — but no engine path
 * answers it on a rule's behalf.
 *
 * ## The invariants, I1–I5
 *
 * I1. `pass` implies complete coverage — a run that could not fully read the
 *     tree can never pass. A `pass` without coverage is a claim the evidence
 *     cannot back.
 * I2. `fail` implies at least one finding — a failing verdict that names no
 *     finding leaves the reader to guess what failed.
 * I3. `unknown` implies "could not look" — coverage incomplete, an unresolved
 *     question, or a thrown analysis. `unknown` is never a degraded `pass`.
 * I4. `not_applicable` requires `notApplicableReason` — the reader has to be
 *     able to tell WHY a rule did not apply, since "did not apply" and "did
 *     not run" are indistinguishable otherwise.
 * I5. The cardinal rule: an analysis that failed, or a rule that could not
 *     determine, must emit `unknown`, NEVER `pass`. `pass` is the loudest
 *     claim the vocabulary makes and the hardest to disprove, so every other
 *     state exists to refuse it.
 *
 * The enforcer that makes the invariants executable is `buildDecision`, in
 * this file, beside the vocabulary it enforces — a vocabulary and the check
 * that a verdict's evidence agrees with it are one subject, and splitting
 * them across the report boundary had made the core verdict module
 * (`../verdict.mjs`) depend on the presentation layer. `../report/evidence.mjs`
 * re-exports `buildDecision` so the render-side callers keep their import
 * path — a path, never a second implementation.
 */

import { describe, isNonEmptyString } from "../values.mjs";

/** The four canonical verdict values. */
export const VERDICTS = Object.freeze(["pass", "fail", "unknown", "not_applicable"]);

/** The single mapping from an envelope status to a verdict. */
export const VERDICT_FOR_STATUS = Object.freeze({
  // used by its own test
  ok: "pass",
  findings: "fail",
  "no-verdict": "unknown",
});

/**
 * Whether a string names one of the four verdicts.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isVerdict(value) {
  return typeof value === "string" && VERDICTS.includes(value);
}

/**
 * The verdict an envelope status implies. Unknown statuses refuse loudly
 * rather than map to a guess — a status this vocabulary has never heard of is
 * a caller reading from the future, and guessing which verdict it implied
 * would make the evidence lie about what actually ran.
 *
 * @param {string} status One of `"ok"` | `"findings"` | `"no-verdict"`.
 * @returns {"pass"|"fail"|"unknown"}
 * @throws {Error} when `status` is not one of the three the envelope can hold.
 */
export function verdictForStatus(status) {
  const verdict = VERDICT_FOR_STATUS[status];
  if (verdict === undefined) {
    throw new Error(
      `archkeep: status "${status}" has no verdict — expected one of ` +
        `${Object.keys(VERDICT_FOR_STATUS).join(", ")}`,
    );
  }
  return verdict;
}

/**
 * One function's verdict record — the evidence envelope every governance
 * consumer (a fitness function, a waiver judge) reads.
 *
 * `evidence` is an object of deterministic facts the verdict is a claim over
 * (the same facts a report row renders), and `message` is human text naming
 * what was decided and why. `rows` is optional per-function observed detail
 * (matched projects, judged edges); it rides along so a report can show the
 * function's coverage without re-deriving it a second way.
 *
 * A `not_applicable` verdict carries its `notApplicableReason` (invariant I4):
 * "did not apply" and "did not run" are indistinguishable otherwise, and a
 * reader has to be told which one this was.
 *
 * @param {{verdict: (typeof VERDICTS)[number], name: string, evidence: object,
 *   message: string, rows?: object[], notApplicableReason?: string}} decision
 * @returns {object}
 * @throws {Error} on a verdict outside the four — a programming error in the
 *   function that built the decision, not a fact about the workspace — and on
 *   a `not_applicable` verdict without its `notApplicableReason`.
 */
export function fitnessVerdict({ verdict, name, evidence, message, rows, notApplicableReason }) {
  if (!isVerdict(verdict)) {
    throw new Error(
      `archkeep: fitness function "${name}" returned verdict ${JSON.stringify(verdict)} — ` +
        `expected one of ${VERDICTS.join(", ")}.`,
    );
  }
  if (verdict === "not_applicable" && !isNonEmptyString(notApplicableReason)) {
    throw new Error(
      `archkeep: fitness function "${name}" returned "not_applicable" without ` +
        `notApplicableReason — invariant I4: the reader must be told why the ` +
        `function did not apply.`,
    );
  }
  return {
    verdict,
    name,
    evidence,
    message,
    ...(rows === undefined ? {} : { rows }),
    ...(notApplicableReason === undefined ? {} : { notApplicableReason }),
  };
}

/**
 * The decision builder: turns a command's verdict counts into the `decision`
 * the envelope optionally carries, enforcing the five invariants the module
 * header states in code rather than leaving them to a docs page a later
 * command author might not read.
 *
 * This function decides nothing about whether a finding IS one — the command
 * that built the envelope owns that. What it decides is whether the verdict
 * and its evidence AGREE, and it throws when they do not, the same posture
 * `../report/json.mjs`'s `jsonEnvelope` takes for the three consistency rules
 * it enforces: a mismatch here is a bug in the command, not a fact about the
 * workspace.
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
 * `./clock.mjs` serves), and a command whose verdict must stay reproducible
 * over an unchanged tree emits a decision with no time at all. That is how
 * the determinism↔time tension is resolved — the clock is injectable (a test
 * drives the same code with a fixed time), never asserted from the wall
 * clock.
 *
 * ## One refusal per invariant
 *
 * I1 refuses a `pass` over incomplete coverage — the same refusal
 * `jsonEnvelope` makes for `status: "ok"` over incomplete coverage, at the
 * verdict layer — and a `pass` carrying findings. I2 refuses a `fail` that
 * names no finding. I3 keeps a reason on every `unknown`, defaulting the
 * generic one when the caller supplies none. I4 refuses a `not_applicable`
 * without its `notApplicableReason`. I5 is I1's first check plus every caller
 * choosing `unknown` wherever the run did not reach a verdict.
 *
 * `not_applicable` has no envelope status, so `buildDecision` reaches it only
 * through an explicit `verdict` — the route a Fitness or Waiver capability
 * takes. Engine behavior today never passes it: `jsonEnvelope` refuses a
 * `decision.verdict` that contradicts the envelope's `status`, and no status
 * maps to `not_applicable`, so the state is locked out of every envelope this
 * release builds.
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
    throw new Error("archkeep: buildDecision needs either a status or an explicit verdict");
  }
  const verdict = run.verdict ?? verdictForStatus(run.status);
  // The vocabulary latch. `verdictForStatus` cannot produce a stranger, so
  // this refuses exactly the explicitly-passed verdicts — and it must run
  // BEFORE the status-conflict check below, so a malformed verdict reports
  // the vocabulary it violated rather than a conflict it never had. Without
  // this latch, "perhaps", "PASS", `42` and `{}` fell through the
  // pass/fail/unknown arms into the not_applicable one and SHIPPED whenever
  // `notApplicableReason` happened to be truthy — a byte-legal decision
  // about a workspace nobody judged.
  if (!isVerdict(verdict)) {
    throw new Error(
      `archkeep: refusing to build a decision with verdict ${describe(run.verdict)} — ` +
        `expected one of ${VERDICTS.join(", ")}. This is a bug in the command that ` +
        `built the decision.`,
    );
  }
  if (
    run.verdict !== undefined &&
    run.status !== undefined &&
    run.verdict !== verdictForStatus(run.status)
  ) {
    throw new Error(
      `archkeep: refusing to build a decision where verdict "${run.verdict}" contradicts status ` +
        `"${run.status}" — status implies ${verdictForStatus(run.status)}, and a decision that ` +
        `disagrees with its own status would make one of the two a lie. ` +
        `This is a bug in the command that built the decision.`,
    );
  }

  // The `findings` count is the cardinal evidence number — a non-negative
  // integer that the I1–I5 invariants all rely on. A missing, non-numeric, or
  // negative value would silently falsify every comparison (`undefined > 0` is
  // `false`), producing a clean verdict over a run whose counts were never set
  // or are logically impossible — the exact silent direction this module exists
  // to refuse.
  if (typeof run.findings !== "number" || !Number.isFinite(run.findings) || run.findings < 0) {
    throw new Error(
      `archkeep: refusing to build a decision where findings is ${JSON.stringify(run.findings)} ` +
        `— findings must be a non-negative number, or the verdict invariants cannot be enforced. ` +
        `This is a bug in the command that built the decision.`,
    );
  }
  if (verdict === "pass") {
    if (run.coverageComplete !== true) {
      throw new Error(
        `archkeep: refusing to emit a "pass" decision over incomplete coverage ` +
          `(coverage.complete: ${run.coverageComplete}) — a run that could not fully read the ` +
          `tree can never pass. This is a bug in the command that built the decision.`,
      );
    }
    if (run.findings > 0) {
      throw new Error(
        `archkeep: refusing to emit a "pass" decision with ${run.findings} finding(s) — ` +
          `"pass" and "fail" cannot both be true of the same run. This is a bug in the command.`,
      );
    }
    return withSampleTime({ verdict }, run.sampleTime);
  }

  if (verdict === "fail") {
    if (run.findings < 1) {
      throw new Error(
        `archkeep: refusing to emit a "fail" decision with no findings — a failing verdict ` +
          `must name what failed. This is a bug in the command that built the decision.`,
      );
    }
    return withSampleTime({ verdict }, run.sampleTime);
  }

  if (verdict === "unknown") {
    // An absent reason (undefined/null) still defaults to the generic one —
    // absence is not emptiness. A SUPPLIED reason must actually say
    // something: "" and "   " are byte-present but semantically absent, and
    // a non-string reason would ship a `typeof` artifact where the reader
    // was promised a sentence (I3).
    const reason =
      run.reason ??
      (run.coverageComplete === true ? "no verdict was reached" : "coverage was incomplete");
    if (!isNonEmptyString(reason)) {
      throw new Error(
        `archkeep: refusing to emit an "unknown" decision with a ${describe(run.reason)} reason — ` +
          `I3 requires a non-empty reason naming why no verdict was reached. ` +
          `This is a bug in the command that built the decision.`,
      );
    }
    return withSampleTime({ verdict, reason }, run.sampleTime);
  }

  // verdict === "not_applicable" (I4). The reason must be a string a reader
  // could act on — the falsy check this replaces refused "" but SHIPPED
  // "   " and non-strings, the same byte-present-semantically-absent hole.
  if (!isNonEmptyString(run.notApplicableReason)) {
    throw new Error(
      `archkeep: refusing to emit a "not_applicable" decision without notApplicableReason — ` +
        `"did not apply" and "did not run" must never be indistinguishable, and a reason of ` +
        `${describe(run.notApplicableReason)} tells the reader nothing. ` +
        `This is a bug in the command that built the decision.`,
    );
  }
  return withSampleTime({ verdict, notApplicableReason: run.notApplicableReason }, run.sampleTime);
}

/**
 * Adds `sampleTime` to the decision only when the caller opted into time —
 * the determinism rule in `buildDecision`'s header. Absent `sampleTime`, the
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
