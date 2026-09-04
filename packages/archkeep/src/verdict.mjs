/**
 * The process's exit-code contract, and the one function that turns a run's
 * counts into the verdict every format agrees on.
 *
 * Both sit here rather than in `../cli.mjs` because two callers need them and
 * only one of the two is the CLI shell: `./commands/check.mjs` words its own
 * `--format json` envelope's `status` and `exitCode` from `verdictFor`, and
 * `../cli.mjs`'s `runCheck` takes the process's exit code from the same call.
 * `../cli.mjs` re-exports `EXIT` under its own name, so every importer that
 * already reads it from there keeps working.
 *
 * `EXIT` is the one place a status→exit-code number is written. The
 * status-keyed view of it, `EXIT_FOR_STATUS`, is derived from `EXIT` and is
 * what the envelope's consistency check (`./report/json.mjs`) asserts against,
 * so a consumer-facing status and the process's own exit code can never drift
 * into two encodings of one contract.
 */

import { buildDecision } from "./governance/verdict.mjs";

export const EXIT = Object.freeze({
  ok: 0,
  violations: 1,
  usage: 2,
  error: 3,
});

/**
 * The envelope `status`→`exitCode` view of `EXIT` — the one mapping
 * `jsonEnvelope` asserts every command's envelope against. Derived from
 * `EXIT` rather than restated, so the numbers are written exactly once;
 * `usage` has no status because a usage error never reaches an envelope.
 *
 * @type {Readonly<Record<"ok"|"findings"|"no-verdict", 0|1|3>>}
 */
export const EXIT_FOR_STATUS = Object.freeze({
  ok: EXIT.ok,
  findings: EXIT.violations,
  "no-verdict": EXIT.error,
});
/**
 * The coverage clauses of a no-verdict reason, spelled once — the strings
 * `verdictFor` joins into `decision.reason` and `check`'s text report renders
 * beside its headline, so the two faces cannot disagree about WHY a run
 * failed to reach a verdict. The clauses cover only the three coverage axes
 * (whole-file failures, unresolved sites, zero analysis); the intent,
 * fitness and custom-rule clauses stay local to `verdictFor` because they
 * name verdict surfaces the coverage counts cannot see.
 *
 * @param {{unchecked: number, blindSpots: number, analyzed: number}} counts
 * @returns {string[]} One clause per failed coverage axis, in pinned order.
 */
export function coverageIncompleteReasons({ unchecked, blindSpots, analyzed }) {
  return [
    unchecked > 0
      ? `${unchecked} file${unchecked === 1 ? "" : "s"} could not be analyzed — coverage incomplete`
      : null,
    blindSpots > 0
      ? `${blindSpots} import site${blindSpots === 1 ? "" : "s"} could not be resolved — coverage incomplete`
      : null,
    analyzed === 0 ? "no file in scope could be analyzed — coverage incomplete" : null,
  ].filter(Boolean);
}

/**
 * The one completeness predicate — the three coverage axes conjoined, the
 * boolean twin of `coverageIncompleteReasons` directly above, which words the
 * same axes as clauses. `coverageVerdict` (`./commands/coverage-verdict.mjs`)
 * reads its `complete` from here, `verdictFor` reads the decision's
 * `coverageComplete` from here, and `check`'s coverage block reads its
 * `complete` from here — three faces of one claim, so the envelope's
 * `coverage.complete` and its `decision.coverageComplete` cannot disagree
 * about a run neither re-derives from the other.
 *
 * The counts come from the caller because a command's coverage universe is
 * its own: `check`'s is wider than `commandContext.analysis` (the go.work and
 * tsconfig whole-file failures it pushes, the accepted `coverage.unowned`
 * files it withdraws), and each face feeds the counts it is a claim about. A
 * caller that reads plain `commandContext.analysis` should call
 * `coverageVerdict` instead — this predicate is the law's last step, not the
 * place failure classes get decided (`./analysis/source-util.mjs`'s
 * classifiers own that line).
 *
 * @param {{unchecked: number, blindSpotCount: number, analyzed: number}} counts
 * @returns {boolean} Whether the run judged everything in its scope.
 */
export function coverageComplete({ unchecked, blindSpotCount, analyzed }) {
  return unchecked === 0 && blindSpotCount === 0 && analyzed > 0;
}

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
 * (`./governance/verdict.mjs`), built from the same counts so the envelope's
 * `status` and its `decision.verdict` cannot disagree: `ok`→`pass`,
 * `findings`→`fail`, `no-verdict`→`unknown`. `buildDecision` throws on any
 * invariant the counts violate (a `pass` over incomplete coverage, a `fail`
 * with no findings), which makes a regression in this mapping a loud error
 * rather than a silent one.
 *
 * @param {{violations: number, declaredEdgeFindings: number, goWorkDrift: number, tsconfigPathsDead: number, intentFindings: number, intentUnresolved: number, intentUnresolvedDecisionRefs?: number, unchecked: number, analyzed: number, blindSpots: number, fitnessFail?: number, fitnessUnknown?: number, customRuleFail?: number, customRuleUnknown?: number}} counts
 * @returns {{status: "ok"|"findings"|"no-verdict", exitCode: 0|1|3, reasons: string[], decision: object}}
 *   `reasons` is the coverage clause list behind this verdict — the
 *   could-not-look clauses on the findings and no-verdict lanes, empty on the
 *   clean one. `decision.reason` joins it with the intent/fitness/custom
 *   clauses where the lane is no-verdict.
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
  analyzed,
  blindSpots,
  fitnessFail = 0,
  fitnessUnknown = 0,
  customRuleFail = 0,
  customRuleUnknown = 0,
}) {
  const coverageReasons = coverageIncompleteReasons({ unchecked, blindSpots, analyzed });
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
      exitCode: EXIT_FOR_STATUS.findings,
      reasons: coverageReasons,
      decision: buildDecision({
        status: "findings",
        // The one completeness predicate, not a restatement: the decision's
        // `coverageComplete` and the envelope's `coverage.complete` are the
        // same claim about the same counts (`check` feeds both from one
        // object), so they read it from one expression.
        coverageComplete: coverageComplete({ unchecked, blindSpotCount: blindSpots, analyzed }),
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
    // An unresolvable site was seen but never judged (#595): named in
    // coverage.blindSpots, and echoed here so the exit says it too — a
    // pass over a site the run could not read claims a verdict it does
    // not hold.
    blindSpots > 0 ||
    // A run that analyzed nothing judged nothing (#599) — a scope that
    // selected no project-owned file, or in-scope files no analyzer
    // claims. Judging nothing is not finding nothing.
    analyzed === 0 ||
    intentUnresolved > 0 ||
    intentUnresolvedDecisionRefs > 0 ||
    fitnessUnknown > 0 ||
    customRuleUnknown > 0
  ) {
    // The list is built before the return so `decision.reason` joins the very
    // array the envelope's `reasons` carries — one list, two renderings, and
    // neither can drift from the other.
    const reasons = [
      ...coverageReasons,
      // The could-not-look condition, named so a reader knows WHICH half of
      // the run did not reach a verdict (I3). When read-only coverage and
      // intent both failed, name both — a reason naming only the file count
      // would hide the unresolved intent boundary from a reader acting on
      // the reason alone (it stays visible in result.intent.unresolved, and
      // status is still no-verdict, so nothing is silent). Each clause below
      // is independent of the others — none is gated on a sibling clause
      // being zero — so a tree that fails on several axes at once names
      // every one of them, not only the first the array happens to hit.
      intentUnresolved > 0
        ? `${intentUnresolved} architecture-intent boundary or row${intentUnresolved === 1 ? "" : "s"} could not be established`
        : null,
      intentUnresolvedDecisionRefs > 0
        ? `${intentUnresolvedDecisionRefs} intent row${intentUnresolvedDecisionRefs === 1 ? "" : "s"} ${intentUnresolvedDecisionRefs === 1 ? "cites" : "cite"} a decisionRef that does not resolve`
        : null,
      fitnessUnknown > 0
        ? `${fitnessUnknown} fitness functions${fitnessUnknown === 1 ? "" : "s"} could not be determined`
        : null,
      customRuleUnknown > 0
        ? `${customRuleUnknown} custom rule${customRuleUnknown === 1 ? "" : "s"} could not be judged`
        : null,
    ].filter(Boolean);
    return {
      status: "no-verdict",
      exitCode: EXIT_FOR_STATUS["no-verdict"],
      reasons,
      decision: buildDecision({
        status: "no-verdict",
        coverageComplete: coverageComplete({ unchecked, blindSpotCount: blindSpots, analyzed }),
        findings: 0,
        reason: reasons.join("; "),
      }),
    };
  }
  return {
    status: "ok",
    exitCode: EXIT_FOR_STATUS.ok,
    reasons: [],
    decision: buildDecision({
      status: "ok",
      coverageComplete: true,
      findings: 0,
    }),
  };
}
