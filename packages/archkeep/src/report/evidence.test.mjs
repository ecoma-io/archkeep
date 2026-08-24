import { describe, expect, it } from "vitest";

import { buildDecision } from "./evidence.mjs";

/**
 * The decision builder's five invariants, pinned in both directions — each
 * with a case that MUST build (the verdict + its required evidence) and a
 * case that MUST throw (the verdict minus that evidence). `src/governance/verdict.mjs`
 * states the invariants; this file proves the runtime refuses the silent
 * direction of each.
 */
describe("buildDecision", () => {
  it("I1 — pass requires complete coverage; a pass over an unread tree throws, never degrades", () => {
    expect(buildDecision({ status: "ok", coverageComplete: true, findings: 0 })).toEqual({
      verdict: "pass",
    });
    // The silent direction: a run that could not read the tree reported as
    // fine. `jsonEnvelope` would refuse the same run at `status: "ok"`, but
    // this is the invariant enforced at the verdict layer independently.
    expect(() => buildDecision({ status: "ok", coverageComplete: false, findings: 0 })).toThrow(
      /refusing to emit a "pass" decision over incomplete coverage/,
    );
  });

  it("I5 — pass is the refusal of could-not-determine: findings force fail, never pass", () => {
    // The cardinal rule, from the pass side: a pass that claims zero findings
    // while the counts disagree must throw rather than ship a lie.
    expect(() => buildDecision({ status: "ok", coverageComplete: true, findings: 1 })).toThrow(
      /refusing to emit a "pass" decision with 1 finding/,
    );
  });

  it("I2 — fail requires at least one finding; a fail with none throws", () => {
    expect(buildDecision({ status: "findings", coverageComplete: true, findings: 3 })).toEqual({
      verdict: "fail",
    });
    expect(() =>
      buildDecision({ status: "findings", coverageComplete: true, findings: 0 }),
    ).toThrow(/refusing to emit a "fail" decision with no findings/);
  });

  it("I3 — unknown carries a reason naming which could-not-look condition fired", () => {
    // Coverage incomplete — the default reason states it.
    expect(buildDecision({ status: "no-verdict", coverageComplete: false, findings: 0 })).toEqual({
      verdict: "unknown",
      reason: "coverage was incomplete",
    });
    // A caller naming the specific half of the run that could not reach a
    // verdict (an unresolved intent boundary, a thrown analysis) rides through.
    expect(
      buildDecision({
        status: "no-verdict",
        coverageComplete: true,
        findings: 0,
        reason: "2 architecture-intent boundaries could not be established",
      }),
    ).toEqual({
      verdict: "unknown",
      reason: "2 architecture-intent boundaries could not be established",
    });
  });

  it("I3 — unknown is never a degraded pass: 'could not look' and 'looked and found nothing' stay distinct", () => {
    // The silent direction this refutes is a caller mapping a could-not-look
    // run onto `pass`. `buildDecision` has no such pathway — `unknown` only
    // ever comes from `status: "no-verdict"` — so what this pins is that the
    // same counts that produce `no-verdict` status always carry the `unknown`
    // verdict and its reason, never an empty shell.
    const decision = buildDecision({
      status: "no-verdict",
      coverageComplete: false,
      findings: 0,
    });
    expect(decision.verdict).toBe("unknown");
    expect(decision.reason).toBeTruthy();
  });

  it("I4 — not_applicable requires notApplicableReason; without it the builder throws", () => {
    // The vocabulary's fourth state is reserved for Fitness/Waivers — engine
    // behavior never emits it today, but the invariant the vocabulary pins is
    // that when it IS emitted, the reason is mandatory. Both directions:
    // with the reason it builds, without it it refuses loudly.
    expect(
      buildDecision({
        verdict: "not_applicable",
        coverageComplete: true,
        findings: 0,
        notApplicableReason: "this workspace declares no fitness functions",
      }),
    ).toEqual({
      verdict: "not_applicable",
      notApplicableReason: "this workspace declares no fitness functions",
    });
    expect(() =>
      buildDecision({ verdict: "not_applicable", coverageComplete: true, findings: 0 }),
    ).toThrow(/refusing to emit a "not_applicable" decision without notApplicableReason/);
  });

  it("requires either a status or an explicit verdict — a builder called with neither is a bug", () => {
    expect(() => buildDecision({ coverageComplete: true, findings: 0 })).toThrow(
      /buildDecision needs either a status or an explicit verdict/,
    );
  });

  it("sampleTime is opt-in — a decision without one carries no time at all (determinism)", () => {
    // The determinism↔time resolution: the envelope the decision rides on is
    // byte-deterministic, so time is a field a capability opts into, never a
    // default the envelope absorbs.
    expect(buildDecision({ status: "ok", coverageComplete: true, findings: 0 })).toEqual({
      verdict: "pass",
    });
    expect(
      buildDecision({ status: "ok", coverageComplete: true, findings: 0, sampleTime: "t0" }),
    ).toEqual({ verdict: "pass", sampleTime: "t0" });
  });
});
