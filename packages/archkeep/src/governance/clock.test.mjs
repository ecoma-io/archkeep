import { describe, expect, it } from "vitest";

import { clockViolations, referenceTime } from "./clock.mjs";

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

describe("clockViolations", () => {
  // The refusal renders the refused value WITH its JSON. This module's
  // describer is deliberately not the package-wide one (`../values.mjs`): it
  // omits the array branch, which its only call site can never reach anyway —
  // the object check above the describer call runs first, so an array is
  // answered by the `.now` arm, never rendered. The exact sentence is pinned
  // so a later unification cannot silently change what a refusal says.
  it("refuses a non-object clock, naming what was actually there", () => {
    expect(clockViolations(42)).toEqual([
      "clock must be an object with a now() function, got number (42)",
    ]);
    expect(clockViolations(null)).toEqual([
      "clock must be an object with a now() function, got null",
    ]);
  });

  it("refuses a clock whose now is not a function", () => {
    expect(clockViolations({ now: 42 })).toEqual([
      "clock.now must be a function returning a non-empty string",
    ]);
  });
});
