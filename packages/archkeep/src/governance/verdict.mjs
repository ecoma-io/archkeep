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
 * and `"not_applicable"` has no source status in this release — it is the
 * vocabulary for Fitness functions and Waivers (a follow-up capability),
 * never for engine behavior today.
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
 * The enforcer that makes the invariants executable lives in
 * `../report/evidence.mjs` (`buildDecision`) — this module owns the closed
 * vocabulary and its relation to the envelope's existing statuses, and the
 * report module owns the runtime check a command's counts go through.
 */

/** The four canonical verdict values. */
export const VERDICTS = Object.freeze(["pass", "fail", "unknown", "not_applicable"]);

/** The single mapping from an envelope status to a verdict. */
export const VERDICT_FOR_STATUS = Object.freeze({
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
  if (verdict === "not_applicable" && notApplicableReason === undefined) {
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
