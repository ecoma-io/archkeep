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
    expect(originViolations({ by: "jane@example.com", tool: "lattice:v1" })).toEqual([]);
  });

  it("accepts an origin carrying `on` as a committed static fact", () => {
    expect(
      originViolations({ by: "jane@example.com", tool: "lattice:v1", on: "2026-08-16" }),
    ).toEqual([]);
  });

  it("rejects a non-object origin loudly", () => {
    expect(originViolations("jane")[0]).toContain("origin must be an object");
  });

  it("rejects an array origin loudly", () => {
    expect(originViolations(["jane"])[0]).toContain("origin must be an object");
  });

  it("rejects an empty or missing by", () => {
    expect(originViolations({ tool: "lattice:v1" })[0]).toContain("origin.by");
    expect(originViolations({ by: "  ", tool: "lattice:v1" })[0]).toContain("origin.by");
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

describe("validateOrigin — read-time", () => {
  it("returns the row's own object when valid", () => {
    const row = { by: "jane", tool: "lattice:v1" };
    expect(validateOrigin(row)).toBe(row);
  });

  it("throws one Error naming every violation, prefixed by `at`", () => {
    let error;
    try {
      validateOrigin({ tool: "lattice:v1" }, {}, "forbidden[2].origin");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("forbidden[2].origin.by");
  });
});

describe("recordOrigin — the write surface", () => {
  it("produces {by, tool, on} through the clock, and only those three keys", () => {
    const record = recordOrigin({ by: "jane", tool: "lattice:v1", clock: clock() });
    expect(record).toEqual({
      by: "jane",
      tool: "lattice:v1",
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
