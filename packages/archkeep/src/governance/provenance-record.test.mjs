import { describe, expect, it } from "vitest";

import { clockViolations } from "./clock.mjs";
import {
  DECISION_LIFECYCLE_KINDS,
  ORIGIN_KEYS,
  originViolations,
  recordDecisionLifecycle,
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

describe("recordDecisionLifecycle — the decision-lifecycle write surface", () => {
  /**
   * A valid lifecycle event for the record surface, attributed by the shared
   * test clock. Overrides spread over the defaults; the assertion pins the
   * kind to the record surface's own union so a call site stays type-checked
   * against `recordDecisionLifecycle`'s parameter shape.
   *
   * @param {object} overrides
   * @returns {Parameters<typeof recordDecisionLifecycle>[0]}
   */
  const event = (overrides = {}) =>
    /** @type {Parameters<typeof recordDecisionLifecycle>[0]} */ ({
      kind: "status-transition",
      decisionId: "0003-one-contract-four-spellings",
      from: "proposed",
      to: "accepted",
      origin: { by: "jane@example.com", tool: "archkeep:v1" },
      clock: clock(),
      ...overrides,
    });

  it("records a status transition with origin and `on` from the injected clock", () => {
    const record = recordDecisionLifecycle(event());
    expect(record).toEqual({
      kind: "status-transition",
      decisionId: "0003-one-contract-four-spellings",
      from: "proposed",
      to: "accepted",
      origin: { by: "jane@example.com", tool: "archkeep:v1", on: "2026-08-16T00:00:00.000Z" },
    });
    expect(Object.keys(record)).toEqual(["kind", "decisionId", "from", "to", "origin"]);
  });

  it("records a creation — a transition from nothing to proposed", () => {
    const record = recordDecisionLifecycle(event({ from: null, to: "proposed" }));
    expect(record.from).toBeNull();
    expect(record.to).toBe("proposed");
  });

  it("records a supersession — which decision replaced which, attributed", () => {
    const record = recordDecisionLifecycle(
      event({
        kind: "supersession",
        decisionId: "0004-lattice-renamed",
        superseded: ["0003-one-contract-four-spellings"],
      }),
    );
    expect(record).toEqual({
      kind: "supersession",
      decisionId: "0004-lattice-renamed",
      superseded: ["0003-one-contract-four-spellings"],
      origin: { by: "jane@example.com", tool: "archkeep:v1", on: "2026-08-16T00:00:00.000Z" },
    });
    expect(Object.keys(record)).toEqual(["kind", "decisionId", "superseded", "origin"]);
  });

  it("records a bindings change — added and removed constraints", () => {
    const record = recordDecisionLifecycle(
      event({
        kind: "bindings-change",
        decisionId: "0001-boundary-levels",
        added: ["rule:z"],
        removed: ["rule:x"],
      }),
    );
    expect(record).toEqual({
      kind: "bindings-change",
      decisionId: "0001-boundary-levels",
      added: ["rule:z"],
      removed: ["rule:x"],
      origin: { by: "jane@example.com", tool: "archkeep:v1", on: "2026-08-16T00:00:00.000Z" },
    });
    expect(Object.keys(record)).toEqual(["kind", "decisionId", "added", "removed", "origin"]);
  });

  it("non-bindings kinds never carry added/removed — the record carries only the kind's keys", () => {
    const transition = recordDecisionLifecycle(event());
    expect(Object.keys(transition)).toEqual(["kind", "decisionId", "from", "to", "origin"]);
    const supersession = recordDecisionLifecycle(
      event({ kind: "supersession", superseded: ["x"] }),
    );
    expect(Object.keys(supersession)).toEqual(["kind", "decisionId", "superseded", "origin"]);
  });

  it("is byte-identical across calls with the same clock — determinism's write half", () => {
    const first = JSON.stringify(recordDecisionLifecycle(event()));
    const second = JSON.stringify(recordDecisionLifecycle(event()));
    expect(first).toBe(second);
  });

  it("differs across calls with a different clock — the clock is the single door", () => {
    const first = JSON.stringify(recordDecisionLifecycle(event()));
    const second = JSON.stringify(
      recordDecisionLifecycle(event({ clock: { now: () => "2026-08-17" } })),
    );
    expect(first).not.toBe(second);
  });

  it("refuses to run without a clock, loudly — inherited from recordOrigin", () => {
    const { clock: _ignored, ...withoutClock } = event();
    expect(() => recordDecisionLifecycle(/** @type {any} */ (withoutClock))).toThrow(/clock/);
  });

  it("refuses to run without an origin author, loudly", () => {
    expect(() =>
      recordDecisionLifecycle(event({ origin: { by: "", tool: "archkeep:v1" } })),
    ).toThrow(/origin.by/);
  });

  it("refuses a status outside the registry's ADR_STATUSES", () => {
    expect(() => recordDecisionLifecycle(event({ from: "bogus" }))).toThrow(/from: must be/);
    expect(() => recordDecisionLifecycle(event({ to: "bogus" }))).toThrow(/to: must be/);
  });

  it("refuses a status transition that changes nothing", () => {
    expect(() => recordDecisionLifecycle(event({ from: "accepted", to: "accepted" }))).toThrow(
      /changes nothing/,
    );
  });

  it("refuses a supersession that names no replaced decision", () => {
    expect(() => recordDecisionLifecycle(event({ kind: "supersession", superseded: [] }))).toThrow(
      /superseded/,
    );
    expect(() =>
      recordDecisionLifecycle(event({ kind: "supersession", superseded: [""] })),
    ).toThrow(/superseded/);
  });

  it("refuses a bindings change that adds and removes nothing", () => {
    expect(() =>
      recordDecisionLifecycle(event({ kind: "bindings-change", added: [], removed: [] })),
    ).toThrow(/adds nothing/);
  });

  it("refuses a non-array added/removed rather than silently dropping it", () => {
    expect(() =>
      recordDecisionLifecycle(event({ kind: "bindings-change", added: "rule:z", removed: [] })),
    ).toThrow(/added: must be an array/);
  });

  it("refuses an unknown kind and a missing decisionId, each loudly", () => {
    expect(() => recordDecisionLifecycle(event({ kind: "renamed" }))).toThrow(/kind: must be/);
    expect(() => recordDecisionLifecycle(event({ decisionId: "  " }))).toThrow(
      /decisionId: must be/,
    );
  });

  it("does not admit kinds outside DECISION_LIFECYCLE_KINDS — the roster is the single list", () => {
    expect(DECISION_LIFECYCLE_KINDS).toEqual([
      "status-transition",
      "supersession",
      "bindings-change",
    ]);
  });
});
