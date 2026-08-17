import { describe, expect, it } from "vitest";

import { formatWaiversReport } from "./waivers-text.mjs";

/**
 * A waiver row shaped like `computeWaivers` (`../commands/waivers.mjs`)
 * produces: the raw `boundarySuppressions` fields plus the three derived ones
 * `formatWaiversReport` reads (`status`, `remainingMs`, `covered`). Built by
 * hand here rather than through `computeWaivers` itself, so this report-layer
 * test stays self-contained the way `drift-text.test.mjs` does for its own
 * fixtures — the formatter's contract is the plain shape below, not the
 * derivation that produces it.
 */
const waiverRow = (overrides = {}) => ({
  path: "area/app/some.config.ts",
  reason: "the loader resolves no alias here",
  expiresAt: "2026-09-01T00:00:00.000Z",
  status: "active",
  // 2026-08-16T10:00:00.000Z -> 2026-09-01T00:00:00.000Z, the fixed "now" a
  // real run would have compared against.
  remainingMs: 1_346_400_000,
  covered: 0,
  ...overrides,
});

describe("formatWaiversReport", () => {
  it("says no waivers when the surface is empty, naming what that means", () => {
    expect(formatWaiversReport({ waivers: [], covered: 0, expired: 0, stale: 0 })).toMatch(
      /no waivers — every boundary is enforced/,
    );
  });

  it("renders the term, the coverage, and the reason for each waiver", () => {
    const waivers = [waiverRow({ origin: "ticket-1234", covered: 1 })];
    const text = formatWaiversReport({ waivers, covered: 1, expired: 0, stale: 0 });
    expect(text).toContain("currently covers a violation");
    expect(text).toContain("1 current violation");
    expect(text).toContain("reason: the loader resolves no alias here");
    expect(text).toContain("expires: 2026-09-01T00:00:00.000Z");
    expect(text).toContain("origin: ticket-1234");
  });

  it("flags a waiver that covers nothing as stale, loudly", () => {
    const waivers = [waiverRow({ covered: 0 })];
    const text = formatWaiversReport({ waivers, covered: 0, expired: 0, stale: 1 });
    expect(text).toContain("covers nothing right now");
    expect(text).toContain("consider removing it");
  });
});
