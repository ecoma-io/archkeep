import { describe, expect, it } from "vitest";

import {
  buildDecision,
  fitnessVerdict,
  isVerdict,
  VERDICT_FOR_STATUS,
  VERDICTS,
  verdictForStatus,
} from "./verdict.mjs";

describe("the canonical verdict vocabulary", () => {
  it("has exactly the four states, in the order the governance wave consumes them", () => {
    expect(VERDICTS).toEqual(["pass", "fail", "unknown", "not_applicable"]);
  });

  it("knows the verdict every envelope status implies — the one-way mapping", () => {
    expect(VERDICT_FOR_STATUS).toEqual({ ok: "pass", findings: "fail", "no-verdict": "unknown" });
  });

  it("isVerdict accepts the four and rejects a fifth spelling (the loud direction)", () => {
    for (const verdict of VERDICTS) expect(isVerdict(verdict)).toBe(true);
    // The silent direction this refutes: a near-miss spelling — "NOT_APPLICABLE",
    // "unknown_", "waived" — would otherwise read as an unrecognised state and
    // no code would ever notice the vocabulary grew a stranger.
    expect(isVerdict("not_applicable_")).toBe(false);
    expect(isVerdict("pass ")).toBe(false);
    expect(isVerdict("skipped")).toBe(false);
  });
});

describe("verdictForStatus", () => {
  it("maps each envelope status to its verdict", () => {
    expect(verdictForStatus("ok")).toBe("pass");
    expect(verdictForStatus("findings")).toBe("fail");
    expect(verdictForStatus("no-verdict")).toBe("unknown");
  });

  it("refuses a status it has never heard of rather than guessing a verdict", () => {
    // A status from the future read as a present verdict would make the
    // evidence lie about what actually ran.
    expect(() => verdictForStatus("not_applicable")).toThrow(/has no verdict/);
    expect(() => verdictForStatus("skipped")).toThrow(/has no verdict/);
  });
});

describe("buildDecision — the executable verdict contract", () => {
  const complete = { coverageComplete: true, findings: 0 };

  it("builds the decision each status implies", () => {
    expect(buildDecision({ ...complete, status: "ok" })).toEqual({ verdict: "pass" });
    expect(buildDecision({ coverageComplete: true, findings: 2, status: "findings" })).toEqual({
      verdict: "fail",
    });
    expect(buildDecision({ coverageComplete: false, findings: 0, status: "no-verdict" })).toEqual({
      verdict: "unknown",
      reason: "coverage was incomplete",
    });
  });

  it("refuses a verdict outside the vocabulary — a malformed verdict can never ship", () => {
    // The silent direction: without a vocabulary latch, "perhaps", "PASS",
    // 42 and {} fall through the pass/fail/unknown arms into the
    // not_applicable one and SHIP whenever notApplicableReason happens to be
    // truthy — a byte-legal decision about a workspace nobody judged.
    // notApplicableReason is supplied on every case so the shipping branch
    // is exactly what this test pins red.
    for (const verdict of ["perhaps", "PASS", "pass ", "skipped", "", 42, true, {}]) {
      expect(() =>
        buildDecision({ ...complete, verdict, notApplicableReason: "did not apply" }),
      ).toThrow(/expected one of/);
    }
  });

  it("refuses an unknown whose supplied reason is empty, whitespace, or not a string (I3)", () => {
    // The silent direction: a nullish-coalesced reason kept "" and "   " as
    // the reason an envelope ships — byte-present, semantically absent.
    for (const reason of ["", "   ", 42, {}]) {
      expect(() =>
        buildDecision({ coverageComplete: false, findings: 0, status: "no-verdict", reason }),
      ).toThrow(/non-empty reason/);
    }
  });

  it("still defaults an absent or null reason to the generic one — absence is not emptiness", () => {
    expect(buildDecision({ coverageComplete: true, findings: 0, status: "no-verdict" })).toEqual({
      verdict: "unknown",
      reason: "no verdict was reached",
    });
    expect(
      buildDecision({ coverageComplete: false, findings: 0, status: "no-verdict", reason: null }),
    ).toEqual({ verdict: "unknown", reason: "coverage was incomplete" });
  });

  it("refuses a not_applicable whose reason is empty, whitespace, or not a string (I4)", () => {
    // The silent direction: the falsy check refused "" but SHIPPED "   " and
    // 42 — a whitespace reason is a byte-present, semantically absent one.
    for (const notApplicableReason of ["", "   ", 42, null]) {
      expect(() =>
        buildDecision({ ...complete, verdict: "not_applicable", notApplicableReason }),
      ).toThrow(/notApplicableReason/);
    }
  });

  it("refuses an explicit not_applicable without any reason", () => {
    expect(() => buildDecision({ ...complete, verdict: "not_applicable" })).toThrow(
      /notApplicableReason/,
    );
  });

  it("keeps the invariants I1–I2 and the status↔verdict agreement loud", () => {
    expect(() => buildDecision({ coverageComplete: false, findings: 0, status: "ok" })).toThrow(
      /incomplete coverage/,
    );
    expect(() => buildDecision({ coverageComplete: true, findings: 3, status: "ok" })).toThrow(
      /"pass" decision with 3 finding/,
    );
    expect(() =>
      buildDecision({ coverageComplete: true, findings: 0, status: "findings" }),
    ).toThrow(/with no findings/);
    expect(() => buildDecision({ ...complete, verdict: "pass", status: "findings" })).toThrow(
      /contradicts status/,
    );
  });
});

describe("fitnessVerdict — the row-level verdict constructor", () => {
  const base = { name: "cycle-free", evidence: {}, message: "judged" };

  it("refuses a not_applicable whose reason is empty, whitespace, or not a string (I4)", () => {
    // The silent direction: the undefined-only check SHIPPED "" and "   " —
    // the row looked judged while the reader was told nothing.
    for (const notApplicableReason of ["", "   ", 42]) {
      expect(() =>
        fitnessVerdict({ ...base, verdict: "not_applicable", notApplicableReason }),
      ).toThrow(/notApplicableReason/);
    }
  });

  it("keeps refusing a not_applicable without any reason", () => {
    expect(() => fitnessVerdict({ ...base, verdict: "not_applicable" })).toThrow(
      /notApplicableReason/,
    );
  });

  it("builds a verdict row and carries the optional fields it was given", () => {
    expect(fitnessVerdict({ ...base, verdict: "pass" })).toEqual({
      verdict: "pass",
      name: "cycle-free",
      evidence: {},
      message: "judged",
    });
    expect(fitnessVerdict({ ...base, verdict: "fail", rows: [{ edge: "a>b" }] }).rows).toEqual([
      { edge: "a>b" },
    ]);
  });
});
