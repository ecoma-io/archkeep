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

/**
 * A permanent-suppression row shaped like `computeWaivers` produces: the raw
 * `boundarySuppressions` fields plus `covered`, and deliberately none of a
 * waiver's term fields (`status`/`remainingMs`/`expiresAt`) — a permanent row
 * has no term for those to describe.
 */
const suppressionRow = (overrides = {}) => ({
  path: "libs/vendored/**",
  reason: "vendored, checked upstream",
  covered: 0,
  ...overrides,
});

describe("formatWaiversReport", () => {
  it("says no waivers when the surface is empty, naming what that means", () => {
    const result = {
      waivers: [],
      covered: 0,
      expired: 0,
      stale: 0,
      suppressions: [],
      suppressed: 0,
    };
    expect(formatWaiversReport(result)).toMatch(/no waivers — every boundary is enforced/);
  });

  it("renders the term, the coverage, and the reason for each waiver", () => {
    const waivers = [waiverRow({ origin: "ticket-1234", covered: 1 })];
    const result = {
      waivers,
      covered: 1,
      expired: 0,
      stale: 0,
      suppressions: [],
      suppressed: 0,
    };
    const text = formatWaiversReport(result);
    expect(text).toContain("currently covers a violation");
    expect(text).toContain("1 current violation");
    expect(text).toContain("reason: the loader resolves no alias here");
    expect(text).toContain("expires: 2026-09-01T00:00:00.000Z");
    expect(text).toContain("origin: ticket-1234");
  });

  it("flags a waiver that covers nothing as stale, loudly", () => {
    const waivers = [waiverRow({ covered: 0 })];
    const result = {
      waivers,
      covered: 0,
      expired: 0,
      stale: 1,
      suppressions: [],
      suppressed: 0,
    };
    const text = formatWaiversReport(result);
    expect(text).toContain("covers nothing right now");
    expect(text).toContain("consider removing it");
  });

  // P1-07: the regression this file exists to guard. Before the fix, a
  // workspace whose ENTIRE `boundarySuppressions` table was permanent rows
  // produced `waivers: []` and this function returned the same "every
  // boundary is enforced" text as a workspace with no suppressions at all —
  // a positive claim about a proposition never measured.
  it("does not claim every boundary is enforced when a permanent suppression is hiding one", () => {
    const suppressions = [
      suppressionRow({ path: "**", reason: "accepted workspace-wide, no expiry", covered: 1 }),
    ];
    const result = { waivers: [], covered: 0, expired: 0, stale: 0, suppressions, suppressed: 1 };
    const text = formatWaiversReport(result);
    expect(text).not.toMatch(/every boundary is enforced/);
    expect(text).toContain("no waivers — nothing is being accepted temporarily");
    expect(text).toContain("1 permanent suppression on the table");
    expect(text).toContain("currently hiding 1 violation");
    expect(text).toContain("- **: permanently hides 1 current violation");
    expect(text).toContain("reason: accepted workspace-wide, no expiry");
  });

  it("names a permanent suppression that currently covers nothing, the same way a stale waiver is named", () => {
    const suppressions = [
      suppressionRow({
        path: "libs/retired/**",
        reason: "kept for the day this path returns",
        covered: 0,
      }),
    ];
    const result = { waivers: [], covered: 0, expired: 0, stale: 0, suppressions, suppressed: 0 };
    const text = formatWaiversReport(result);
    expect(text).toContain("- libs/retired/**: covers nothing right now");
  });

  it("renders both a waiver section and a permanent-suppression section together", () => {
    const waivers = [waiverRow({ covered: 1 })];
    const suppressions = [
      suppressionRow({ path: "libs/legacy/**", reason: "legacy module frozen", covered: 1 }),
    ];
    const result = {
      waivers,
      covered: 1,
      expired: 0,
      stale: 0,
      suppressions,
      suppressed: 1,
    };
    const text = formatWaiversReport(result);
    expect(text).toContain("1 waiver on the table");
    expect(text).toContain("1 permanent suppression on the table");
    // Neither section's claim leaks into the other's summary line.
    expect(text).not.toMatch(/every boundary is enforced/);
  });
});
