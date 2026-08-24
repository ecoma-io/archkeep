import { describe, expect, it } from "vitest";

import {
  EXPIRED_WAIVER_EVIDENCE,
  expiresAtMs,
  isWaiver,
  remainingMs,
  suppressionFate,
  waiverStatus,
} from "./waiver.mjs";

const NOW = "2026-08-16T10:00:00.000Z";

const waiver = (expiresAt) => ({ path: "area/alpha/src/index.ts", reason: "temporary", expiresAt });

describe("isWaiver", () => {
  it("is true exactly when the row carries expiresAt — the distinguishing field", () => {
    expect(isWaiver(waiver("2026-09-01T00:00:00.000Z"))).toBe(true);
    expect(isWaiver({ path: "a.js", reason: "why" })).toBe(false);
    expect(isWaiver(null)).toBe(false);
  });
});

describe("waiverStatus and remainingMs — the expiration boundaries", () => {
  it("is active strictly before expiresAt, even by a fraction of a millisecond", () => {
    expect(waiverStatus(waiver("2026-09-01T00:00:00.000Z"), NOW)).toBe("active");
  });

  it("is expired the instant now equals expiresAt — 'valid through' means strictly before", () => {
    const atExpiry = waiver("2026-08-16T10:00:00.000Z");
    expect(waiverStatus(atExpiry, NOW)).toBe("expired");
    expect(remainingMs(atExpiry, NOW)).toBe(0);
  });

  it("is expired the moment now passes expiresAt, however slightly", () => {
    const justPast = waiver("2026-08-16T09:59:59.999Z"); // 1ms before NOW
    expect(waiverStatus(justPast, NOW)).toBe("expired");
    expect(remainingMs(justPast, NOW)).toBe(-1);
  });

  it("computes remaining milliseconds with sign — negative when expired", () => {
    expect(remainingMs(waiver("2026-08-17T10:00:00.000Z"), NOW)).toBe(86_400_000);
    expect(remainingMs(waiver("2026-08-16T09:00:00.000Z"), NOW)).toBe(-3_600_000);
  });

  it("expiresAtMs parses the ISO instant to epoch milliseconds", () => {
    expect(expiresAtMs(waiver("2026-08-16T10:00:00.000Z"))).toBe(Date.parse(NOW));
  });
});

describe("suppressionFate — what a row does to the violation it covers", () => {
  it("legacy rows suppress: no expiresAt, no waiver, semantics unchanged", () => {
    expect(suppressionFate({ path: "a.js", reason: "why" }, NOW)).toBe("suppress");
  });

  it("an active waiver waives: the violation is accepted, not removed", () => {
    expect(suppressionFate(waiver("2026-09-01T00:00:00.000Z"), NOW)).toBe("waive");
  });

  it("an expired waiver re-asserts the violation with the evidence constant", () => {
    expect(suppressionFate(waiver("2026-08-01T00:00:00.000Z"), NOW)).toBe("reassert");
    expect(EXPIRED_WAIVER_EVIDENCE).toBe("expired waiver");
  });
});
