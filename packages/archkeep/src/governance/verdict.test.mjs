import { describe, expect, it } from "vitest";

import { isVerdict, VERDICT_FOR_STATUS, VERDICTS, verdictForStatus } from "./verdict.mjs";

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
