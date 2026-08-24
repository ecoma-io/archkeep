/**
 * The process's exit-code contract, and the one function that turns a run's
 * counts into the verdict every format agrees on.
 *
 * Both sit here rather than in `../cli.mjs` because two callers need them and
 * only one of the two is the CLI shell: `./commands/check.mjs` words its own
 * `--format json` envelope from `verdictFor`, and `../cli.mjs`'s `runCheck`
 * takes the process's exit code from the same call. `../cli.mjs` re-exports
 * `EXIT` under its own name, so every importer that already reads it from
 * there keeps working.
 */

import { buildDecision } from "./report/evidence.mjs";

export const EXIT = Object.freeze({
  ok: 0,
  violations: 1,
  usage: 2,
  error: 3,
});
/**
 * The one place that turns a run's counts into the verdict every format
 * agrees on. `runCheck` uses it for the process's exit code; `check` uses the
 * same function to word its own `--format json` envelope's `status` and
 * `exitCode` fields — called once each, from the same counts, so the two can
 * never disagree about a run neither of them re-derives from the other.
 *
 * Findings first — boundary violations, go.work drift, dead tsconfig path
 * aliases and architecture-intent findings alike are verdicts, and a caller
 * that gets `findings` knows the tree is dirty whatever else the run could not
 * reach; the report lists the unreached files either way. A clean run with a
 * file nobody could analyze — or an architecture-intent boundary nobody could
 * verify — is the case that must not read `ok`, because `ok` is read as
 * "checked, and fine".
 *
 * The `decision` is the canonical 4-state verb of the same verdict
 * (`./report/evidence.mjs`), built from the same counts so the envelope's
 * `status` and its `decision.verdict` cannot disagree: `ok`→`pass`,
 * `findings`→`fail`, `no-verdict`→`unknown`. `buildDecision` throws on any
 * invariant the counts violate (a `pass` over incomplete coverage, a `fail`
 * with no findings), which makes a regression in this mapping a loud error
 * rather than a silent one.
 *
 * @param {{violations: number, declaredEdgeFindings: number, goWorkDrift: number, tsconfigPathsDead: number, intentFindings: number, intentUnresolved: number, intentUnresolvedDecisionRefs?: number, unchecked: number, fitnessFail?: number, fitnessUnknown?: number, customRuleFail?: number, customRuleUnknown?: number}} counts
 * @returns {{status: "ok"|"findings"|"no-verdict", exitCode: 0|1|3, decision: object}}
 */
export function verdictFor({
  violations,
  declaredEdgeFindings,
  goWorkDrift,
  tsconfigPathsDead,
  intentFindings,
  intentUnresolved,
  intentUnresolvedDecisionRefs = 0,
  unchecked,
  fitnessFail = 0,
  fitnessUnknown = 0,
  customRuleFail = 0,
  customRuleUnknown = 0,
}) {
  if (
    violations > 0 ||
    declaredEdgeFindings > 0 ||
    goWorkDrift > 0 ||
    tsconfigPathsDead > 0 ||
    intentFindings > 0 ||
    fitnessFail > 0 ||
    // A `fail`-verdict custom rule is a finding by the same argument a failing
    // fitness function is one (D-09): the workspace declared the law, the law
    // judged, and the law says no. It rides this lane rather than a new exit
    // code, so a consumer's CI branches on the same 0/1/3 it already does.
    customRuleFail > 0
  ) {
    return {
      status: "findings",
      exitCode: EXIT.violations,
      decision: buildDecision({
        status: "findings",
        coverageComplete: unchecked === 0,
        findings:
          violations +
          declaredEdgeFindings +
          goWorkDrift +
          tsconfigPathsDead +
          intentFindings +
          fitnessFail +
          customRuleFail,
      }),
    };
  }
  if (
    unchecked > 0 ||
    intentUnresolved > 0 ||
    intentUnresolvedDecisionRefs > 0 ||
    fitnessUnknown > 0 ||
    customRuleUnknown > 0
  ) {
    return {
      status: "no-verdict",
      exitCode: EXIT.error,
      decision: buildDecision({
        status: "no-verdict",
        coverageComplete: unchecked === 0,
        findings: 0,
        // The could-not-look condition, named so a reader knows WHICH half of
        // the run did not reach a verdict (I3). When read-only coverage and
        // intent both failed, name both — a reason naming only the file count
        // would hide the unresolved intent boundary from a reader acting on
        // the reason alone (it stays visible in result.intent.unresolved, and
        // status is still no-verdict, so nothing is silent). Each clause below
        // is independent of the others — none is gated on a sibling clause
        // being zero — so a tree that fails on several axes at once names
        // every one of them, not just the first the array happens to check.
        reason: [
          unchecked > 0
            ? `${unchecked} file${unchecked === 1 ? "" : "s"} could not be analyzed — coverage incomplete`
            : null,
          intentUnresolved > 0
            ? `${intentUnresolved} architecture-intent boundary or row${intentUnresolved === 1 ? "" : "s"} could not be established`
            : null,
          intentUnresolvedDecisionRefs > 0
            ? `${intentUnresolvedDecisionRefs} intent row${intentUnresolvedDecisionRefs === 1 ? "" : "s"} ${intentUnresolvedDecisionRefs === 1 ? "cites" : "cite"} a decisionRef that does not resolve`
            : null,
          fitnessUnknown > 0
            ? `${fitnessUnknown} fitness function${fitnessUnknown === 1 ? "" : "s"} could not be determined`
            : null,
          customRuleUnknown > 0
            ? `${customRuleUnknown} custom rule${customRuleUnknown === 1 ? "" : "s"} could not be judged`
            : null,
        ]
          .filter(Boolean)
          .join("; "),
      }),
    };
  }
  return {
    status: "ok",
    exitCode: EXIT.ok,
    decision: buildDecision({
      status: "ok",
      coverageComplete: true,
      findings: 0,
    }),
  };
}
