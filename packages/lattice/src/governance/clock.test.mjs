import { describe, expect, it } from "vitest";

import { referenceTime } from "./clock.mjs";

describe("referenceTime", () => {
  it("returns a parseable ISO-8601 UTC instant", () => {
    const now = referenceTime();
    expect(Number.isNaN(Date.parse(now))).toBe(false);
    // UTC, never locale time: the field that rides an envelope or a record
    // must not vary with the machine's timezone.
    expect(now.endsWith("Z")).toBe(true);
  });

  it("is a function so an injectable clock can replace it without changing call shape", () => {
    // The determinism↔time contract: a feature takes `clock ?? referenceTime`
    // and a test drives it with a fixed constant. Both are plain calls to the
    // same zero-argument function, so neither the feature nor the test cares
    // which one it holds.
    const clock = () => "2026-08-16T10:00:00.000Z";
    expect(clock()).toBe("2026-08-16T10:00:00.000Z");
    expect(typeof referenceTime).toBe("function");
  });
});
