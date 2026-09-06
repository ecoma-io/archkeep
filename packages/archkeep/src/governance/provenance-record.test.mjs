import { describe, expect, it } from "vitest";

import { clockViolations } from "./clock.mjs";
import {
  ORIGIN_KEYS,
  originViolations,
  recordOrigin,
  validateOrigin,
} from "./provenance-record.mjs";

const clock = () => ({ now: () => "2026-08-16T00:00:00.000Z" });

describe("originViolations — shape", () => {
  it("accepts a minimal {by, tool} origin", () => {
    expect(originViolations({ by: "jane@example.com", tool: "archkeep:v1" })).toEqual([]);
  });

  it("accepts an origin carrying `on` as a committed static fact", () => {
    expect(
      originViolations({ by: "jane@example.com", tool: "archkeep:v1", on: "2026-08-16" }),
    ).toEqual([]);
  });

  it("rejects a non-object origin loudly", () => {
    expect(originViolations("jane")[0]).toContain("origin must be an object");
  });

  it("rejects an array origin loudly", () => {
    expect(originViolations(["jane"])[0]).toContain("origin must be an object");
  });

  it("rejects an empty or missing by", () => {
    expect(originViolations({ tool: "archkeep:v1" })[0]).toContain("origin.by");
    expect(originViolations({ by: "  ", tool: "archkeep:v1" })[0]).toContain("origin.by");
  });

  it("rejects an empty or missing tool", () => {
    expect(originViolations({ by: "jane" })[0]).toContain("origin.tool");
    expect(originViolations({ by: "jane", tool: "" })[0]).toContain("origin.tool");
  });

  it("rejects a non-string on", () => {
    expect(originViolations({ by: "jane", tool: "l", on: 42 })[0]).toContain("origin.on");
  });

  it("rejects an unknown key by name", () => {
    expect(originViolations({ by: "jane", tool: "l", why: "x" })[0]).toContain(
      "origin.why: unknown key",
    );
  });

  it("reports only permitted keys once — ORIGIN_KEYS is the single list", () => {
    expect(ORIGIN_KEYS).toEqual(["by", "tool", "on"]);
  });
});

describe("originViolations — error-path", () => {
  it("rejects null origin — a null origin is not 'no claim', it is a misread", () => {
    expect(originViolations(null)[0]).toContain("origin must be an object");
  });

  it("rejects undefined origin — an absent origin is the caller's bug, not a fact", () => {
    expect(originViolations(undefined)[0]).toContain("origin must be an object");
  });

  it("rejects a number origin — a plain number cannot be an object", () => {
    expect(originViolations(42)[0]).toContain("origin must be an object");
  });

  it("rejects a boolean origin — true is not a governance record", () => {
    expect(originViolations(true)[0]).toContain("origin must be an object");
  });

  it("rejects an origin with only `by` — tool is mandatory", () => {
    expect(originViolations({ by: "jane@example.com" })[0]).toContain("origin.tool");
  });

  it("rejects an origin with only `tool` — by is mandatory", () => {
    expect(originViolations({ tool: "archkeep:v1" })[0]).toContain("origin.by");
  });

  it("rejects an origin with null by — null is not a string", () => {
    expect(originViolations({ by: null, tool: "archkeep:v1" })[0]).toContain("origin.by");
  });

  it("rejects an origin with null tool — null is not a string", () => {
    expect(originViolations({ by: "jane", tool: null })[0]).toContain("origin.tool");
  });

  it("rejects an origin with a number tool — the tool name must be a string", () => {
    expect(originViolations({ by: "jane", tool: 7 })[0]).toContain("origin.tool");
  });

  it("rejects an origin with multiple unknown keys — every unknown is named", () => {
    const messages = originViolations({ by: "jane", tool: "l", extra: "x", reason: "y" });
    expect(messages.some((m) => m.includes("extra"))).toBe(true);
    expect(messages.some((m) => m.includes("reason"))).toBe(true);
  });

  it("rejects an origin where `on` is an empty string — a committed date that reads empty is a lie", () => {
    expect(originViolations({ by: "jane", tool: "l", on: "" })[0]).toContain("origin.on");
  });
});

describe("originViolations — null-prototype safety", () => {
  it("rejects a crafted __proto__ key as unknown rather than polluting", () => {
    // JSON.parse of '{"by":"jane","tool":"l","__proto__":{"polluted":true}}'
    // yields an own key, but object-literal `__proto__` sets the prototype.
    const crafted = JSON.parse('{"by":"jane","tool":"l","__proto__":{"polluted":true}}');
    const messages = originViolations(crafted);
    expect(messages.some((m) => m.includes("__proto__") && m.includes("unknown key"))).toBe(true);
    expect({}.polluted).toBeUndefined();
  });

  it("does not read inherited keys — a polluted Object.prototype cannot smuggle one", () => {
    // x.protoKey here is inherited, not own; an origin with only valid own
    // keys must pass despite the polluted prototype.
    const plain = (() => {
      const o = JSON.parse('{"by":"jane","tool":"l"}');
      return o;
    })();
    /** @type {any} — deliberately polluting the shared prototype under test. */
    const prototype = Object.prototype;
    const previous = prototype.buildStatus;
    try {
      prototype.buildStatus = "polluted";
      expect(originViolations(plain)).toEqual([]);
      expect(Object.keys(plain).includes("buildStatus")).toBe(false);
    } finally {
      if (previous === undefined) delete prototype.buildStatus;
      else prototype.buildStatus = previous;
    }
  });

  it("rejects an on that is a crafted object", () => {
    const crafted = JSON.parse('{"by":"jane","tool":"l","on":{"__proto__":{}}}');
    expect(originViolations(crafted)[0]).toContain("origin.on");
  });
});

describe("validateOrigin — error-path", () => {
  it("throws for null input — null is not a valid origin", () => {
    expect(() => validateOrigin(null)).toThrow(/origin must be an object/);
  });

  it("throws for undefined input — an absent origin cannot be validated", () => {
    expect(() => validateOrigin(undefined)).toThrow(/origin must be an object/);
  });

  it("throws for an origin with only `tool` — by is mandatory even at read time", () => {
    expect(() => validateOrigin({ tool: "archkeep:v1" })).toThrow(/origin.by/);
  });

  it("throws with a user-supplied `at` prefix naming the exact path", () => {
    expect(() => validateOrigin({}, {}, "policy.depConstraints[0].origin")).toThrow(
      /policy\.depConstraints\[0\]\.origin\.by/,
    );
  });
});

describe("validateOrigin — determinism", () => {
  it("is byte-identical across 10 calls with the same valid input", () => {
    const input = { by: "jane@example.com", tool: "archkeep:v1" };
    const results = Array.from({ length: 10 }, () => validateOrigin(input));
    const first = JSON.stringify(results[0]);
    for (let i = 1; i < results.length; i++) {
      expect(JSON.stringify(results[i])).toBe(first);
    }
  });

  it("returns the same object reference — validateOrigin does not clone", () => {
    const input = { by: "jane@example.com", tool: "archkeep:v1" };
    expect(validateOrigin(input)).toBe(input);
  });
});

describe("validateOrigin — read-time", () => {
  it("returns the row's own object when valid", () => {
    const row = { by: "jane", tool: "archkeep:v1" };
    expect(validateOrigin(row)).toBe(row);
  });

  it("throws one Error naming every violation, prefixed by `at`", () => {
    let error;
    try {
      validateOrigin({ tool: "archkeep:v1" }, {}, "forbidden[2].origin");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("forbidden[2].origin.by");
  });
});

describe("recordOrigin — the write surface", () => {
  it("produces {by, tool, on} through the clock, and only those three keys", () => {
    const record = recordOrigin({ by: "jane", tool: "archkeep:v1", clock: clock() });
    expect(record).toEqual({
      by: "jane",
      tool: "archkeep:v1",
      on: "2026-08-16T00:00:00.000Z",
    });
    expect(Object.keys(record)).toEqual(["by", "tool", "on"]);
  });

  it("is byte-identical across calls with the same clock — determinism's write half", () => {
    const first = JSON.stringify(recordOrigin({ by: "jane", tool: "l", clock: clock() }));
    const second = JSON.stringify(recordOrigin({ by: "jane", tool: "l", clock: clock() }));
    expect(first).toBe(second);
  });

  it("differs across calls with a different clock — the clock is the single door", () => {
    const first = JSON.stringify(recordOrigin({ by: "jane", tool: "l", clock: clock() }));
    const other = JSON.stringify(
      recordOrigin({ by: "jane", tool: "l", clock: { now: () => "2026-08-17" } }),
    );
    expect(first).not.toBe(other);
  });

  it("refuses to run without a clock, loudly — on is never produced by magic", () => {
    // @ts-expect-error — a missing clock is exactly the misuse being tested.
    expect(() => recordOrigin({ by: "jane", tool: "l" })).toThrow(/clock/);
  });

  it("refuses an invalid author before touching the clock", () => {
    expect(() => recordOrigin({ by: "", tool: "l", clock: clock() })).toThrow(/origin.by/);
  });

  it("refuses a clock that answers a non-string", () => {
    /** @type {import("./clock.mjs").Clock} — a lying clock under test. */
    const lyingClock = /** @type {any} */ ({ now: () => 42 });
    expect(() => recordOrigin({ by: "jane", tool: "l", clock: lyingClock })).toThrow(/clock/);
  });

  it("refuses a clock that answers an empty string", () => {
    expect(() => recordOrigin({ by: "jane", tool: "l", clock: { now: () => "" } })).toThrow(
      /clock/,
    );
  });
});

describe("clockViolations", () => {
  it("accepts a simple now() string clock", () => {
    expect(clockViolations(clock())).toEqual([]);
  });

  it("rejects null, a non-object, a missing now, and a bad answer — each loudly", () => {
    expect(clockViolations(null)[0]).toContain("clock must be an object");
    expect(clockViolations("tick")[0]).toContain("clock must be an object");
    expect(clockViolations({})[0]).toContain("clock.now must be a function");
    expect(clockViolations({ now: () => 42 })[0]).toContain("must return a non-empty string");
    expect(clockViolations({ now: () => "" })[0]).toContain("must return a non-empty string");
  });
});

describe("recordOrigin — 10-run determinism", () => {
  it("produces byte-identical output across 10 consecutive calls with the same inputs", () => {
    const args = { by: "jane@example.com", tool: "archkeep:v1", clock: clock() };
    const results = Array.from({ length: 10 }, () => recordOrigin({ ...args }));
    const first = JSON.stringify(results[0]);
    for (let i = 1; i < results.length; i++) {
      expect(JSON.stringify(results[i])).toBe(first);
    }
  });

  it("the first and tenth calls produce the exact same object keys", () => {
    const make = () =>
      recordOrigin({ by: "jane@example.com", tool: "archkeep:v1", clock: clock() });
    const results = Array.from({ length: 10 }, make);
    const firstKeys = Object.keys(results[0]);
    const lastKeys = Object.keys(results[results.length - 1]);
    expect(firstKeys).toEqual(lastKeys);
  });
});
