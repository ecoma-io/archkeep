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

describe("buildDecision — additional silent-direction invariants", () => {
  it("refuses a verdict that contradicts status — status wins", () => {
    // The uncovered branch at line 92 of evidence.mjs: explicit verdict "pass"
    // with status "findings" must throw rather than trust the verdict verb.
    expect(() =>
      buildDecision({
        verdict: "pass",
        status: "findings",
        coverageComplete: true,
        findings: 3,
      }),
    ).toThrow(/verdict.*contradicts status/);
  });

  it("refuses 'pass' verdict with 'no-verdict' status — the cardinal rule at the boundary", () => {
    expect(() =>
      buildDecision({
        verdict: "pass",
        status: "no-verdict",
        coverageComplete: false,
        findings: 0,
      }),
    ).toThrow(/verdict.*contradicts status/);
  });

  it("refuses 'unknown' verdict with 'ok' status — cannot shrink a clean run", () => {
    expect(() =>
      buildDecision({
        verdict: "unknown",
        status: "ok",
        coverageComplete: true,
        findings: 0,
        reason: "something went wrong",
      }),
    ).toThrow(/verdict.*contradicts status/);
  });

  it("refuses explicit 'pass' verdict over incomplete coverage — same as I1", () => {
    // Using explicit verdict (no status) — the pass check fires regardless.
    expect(() =>
      buildDecision({
        verdict: "pass",
        coverageComplete: false,
        findings: 0,
      }),
    ).toThrow(/refusing to emit a "pass" decision over incomplete coverage/);
  });

  it("refuses explicit 'fail' verdict with zero findings — same as I2", () => {
    expect(() =>
      buildDecision({
        verdict: "fail",
        coverageComplete: true,
        findings: 0,
      }),
    ).toThrow(/refusing to emit a "fail" decision with no findings/);
  });
});

describe("buildDecision — determinism", () => {
  it("produces byte-identical output across 10 calls with status-based input", () => {
    const input = /** @type {{ status: "ok", coverageComplete: true, findings: 0 }} */ ({
      status: "ok",
      coverageComplete: true,
      findings: 0,
    });
    const results = Array.from({ length: 10 }, () => buildDecision(input));
    const first = JSON.stringify(results[0]);
    for (let i = 1; i < results.length; i++) {
      expect(JSON.stringify(results[i])).toBe(first);
    }
  });

  it("produces byte-identical output across 10 calls with explicit verdict", () => {
    const input = /** @type {{ verdict: "fail", coverageComplete: true, findings: 3 }} */ ({
      verdict: "fail",
      coverageComplete: true,
      findings: 3,
    });
    const results = Array.from({ length: 10 }, () => buildDecision(input));
    const first = JSON.stringify(results[0]);
    for (let i = 1; i < results.length; i++) {
      expect(JSON.stringify(results[i])).toBe(first);
    }
  });

  it("produces byte-identical output across 10 calls with unknown verdict", () => {
    const input = /** @type {{ status: "no-verdict", coverageComplete: false, findings: 0 }} */ ({
      status: "no-verdict",
      coverageComplete: false,
      findings: 0,
    });
    const results = Array.from({ length: 10 }, () => buildDecision(input));
    const first = JSON.stringify(results[0]);
    for (let i = 1; i < results.length; i++) {
      expect(JSON.stringify(results[i])).toBe(first);
    }
  });

  it("produces byte-identical output across 10 calls with not_applicable verdict", () => {
    const input =
      /** @type {{ verdict: "not_applicable", coverageComplete: true, findings: 0, notApplicableReason: string }} */ ({
        verdict: "not_applicable",
        coverageComplete: true,
        findings: 0,
        notApplicableReason: "this workspace declares no fitness functions",
      });
    const results = Array.from({ length: 10 }, () => buildDecision(input));
    const first = JSON.stringify(results[0]);
    for (let i = 1; i < results.length; i++) {
      expect(JSON.stringify(results[i])).toBe(first);
    }
  });
});

describe("buildDecision — error-path", () => {
  it("refuses a null status — the builder cannot derive a verdict from nothing", () => {
    expect(() => buildDecision({ status: null, coverageComplete: true, findings: 0 })).toThrow(
      /has no verdict/,
    );
  });

  it("refuses an empty run object — missing both status and verdict", () => {
    expect(() => buildDecision(/** @type {any} */ ({}))).toThrow(
      /needs either a status or an explicit verdict/,
    );
  });

  it("refuses a run with unknown status string — no silent default to 'unknown'", () => {
    expect(() =>
      buildDecision(
        /** @type {any} */ ({ status: "pending", coverageComplete: true, findings: 0 }),
      ),
    ).toThrow(/has no verdict/);
  });

  it("refuses undefined findings — cannot count violations from absence", () => {
    expect(() =>
      buildDecision({ status: "ok", coverageComplete: true, findings: undefined }),
    ).toThrow(/findings must be a non-negative number/);
  });

  it("refuses a non-numeric findings value — a string cannot be a count", () => {
    expect(() =>
      buildDecision(
        /** @type {any} */ ({ status: "findings", coverageComplete: true, findings: "three" }),
      ),
    ).toThrow(/findings must be a non-negative number/);
  });

  it("refuses explicit 'pass' verdict with negative findings — impossible count", () => {
    expect(() => buildDecision({ verdict: "pass", coverageComplete: true, findings: -1 })).toThrow(
      /findings must be a non-negative number/,
    );
  });

  it("refuses null findings — null is not a count", () => {
    expect(() => buildDecision({ status: "ok", coverageComplete: true, findings: null })).toThrow(
      /findings must be a non-negative number/,
    );
  });

  it("refuses NaN findings — not-a-number cannot be a count", () => {
    expect(() => buildDecision({ status: "ok", coverageComplete: true, findings: NaN })).toThrow(
      /findings must be a non-negative number/,
    );
  });

  it("refuses Infinity findings — infinite is not a count", () => {
    expect(() =>
      buildDecision({ status: "ok", coverageComplete: true, findings: Infinity }),
    ).toThrow(/findings must be a non-negative number/);
  });
});
