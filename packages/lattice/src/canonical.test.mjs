/**
 * `canonicalizeJson` backs `computePolicyFingerprint`
 * (`./commands/graph.mjs`) and the intent fingerprint
 * (`./architecture-intent/intent-fingerprint.mjs`), so its one job is that
 * two documents which differ must never serialize to the same string — a
 * fingerprint collision is silent by construction, indistinguishable from
 * "these two are the same document" (`../../../AGENTS.md`, "An empty result is
 * a claim, not a shrug" — the same failure shape: nothing here raises, the
 * two callers just quietly agree on a fingerprint they should not share).
 */
import { describe, expect, it } from "vitest";

import { canonicalizeJson } from "./canonical.mjs";

describe("canonicalizeJson", () => {
  it("sorts plain-object keys at every depth", () => {
    expect(canonicalizeJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalizeJson({ b: { d: 1, c: 2 }, a: 1 })).toBe('{"a":1,"b":{"c":2,"d":1}}');
  });

  it("never reorders array elements — order is semantic for depConstraints/forbidden rows", () => {
    expect(canonicalizeJson({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
    expect(
      canonicalizeJson([
        { b: 1, a: 2 },
        { d: 3, c: 4 },
      ]),
    ).toBe('[{"a":2,"b":1},{"c":4,"d":3}]');
  });

  it("treats an object carrying a literal own '__proto__' key as an ordinary key, not a prototype write", () => {
    // `JSON.parse` on this text produces an object with an own key literally
    // named "__proto__" — JSON has no prototype syntax, so this is data, not
    // magic. Before this fix, `sorted[keyName] = current[keyName]` on a plain
    // `{}` accumulator special-cased that assignment (it sets the object's
    // prototype instead of creating an own property), so the key silently
    // disappeared from the serialization.
    const withProto = JSON.parse('{"a":1,"__proto__":{"y":2}}');
    expect(Object.keys(withProto)).toContain("__proto__");
    const serialized = canonicalizeJson(withProto);
    expect(serialized).toContain("__proto__");
    expect(serialized).toContain('"y":2');
    expect(serialized).toBe('{"__proto__":{"y":2},"a":1}');
  });

  it("fingerprints two documents that differ only in a __proto__ field DIFFERENTLY", () => {
    // This is the collision this bug closes: on the old implementation,
    // `canonicalizeJson(withProto) === canonicalizeJson(without)` — two
    // different policy/intent documents producing one indistinguishable
    // fingerprint. Fails on the original canonical.mjs (both sides were
    // '{"a":1}').
    const withProto = JSON.parse('{"a":1,"__proto__":{"y":2}}');
    const without = JSON.parse('{"a":1}');
    expect(canonicalizeJson(withProto)).not.toBe(canonicalizeJson(without));
  });

  it("preserves a __proto__ key nested inside an array element and inside a deeper object", () => {
    const nested = JSON.parse('{"rows":[{"a":1,"__proto__":{"y":2}}]}');
    const serialized = canonicalizeJson(nested);
    expect(serialized).toBe('{"rows":[{"__proto__":{"y":2},"a":1}]}');

    const deeper = JSON.parse('{"outer":{"inner":{"a":1,"__proto__":{"z":3}}}}');
    const deeperSerialized = canonicalizeJson(deeper);
    expect(deeperSerialized).toContain('"__proto__":{"z":3}');
    expect(deeperSerialized).not.toBe(canonicalizeJson(JSON.parse('{"outer":{"inner":{"a":1}}}')));
  });

  it("still round-trips ordinary values with no __proto__ involved", () => {
    expect(canonicalizeJson("plain string")).toBe('"plain string"');
    expect(canonicalizeJson(42)).toBe("42");
    expect(canonicalizeJson(null)).toBe("null");
    expect(canonicalizeJson({})).toBe("{}");
  });
});
