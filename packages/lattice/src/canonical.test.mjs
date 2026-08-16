import { describe, expect, it } from "vitest";

import { canonicalizeJson } from "./canonical.mjs";

describe("canonicalizeJson", () => {
  it("serializes semantically-identical objects identically regardless of key order", () => {
    const a = { z: 1, a: { y: 2, b: 3 } };
    const b = { a: { b: 3, y: 2 }, z: 1 };
    expect(canonicalizeJson(a)).toBe(canonicalizeJson(b));
  });

  it("does not re-order array elements — row order is semantic", () => {
    const a = { rows: ["first", "second"] };
    const b = { rows: ["second", "first"] };
    expect(canonicalizeJson(a)).not.toBe(canonicalizeJson(b));
  });

  it("handles nested arrays inside objects and scalars", () => {
    const value = { b: [3, 1, 2], a: [{ x: 1, w: 2 }], c: "text", n: null };
    expect(canonicalizeJson(value)).toBe('{"a":[{"w":2,"x":1}],"b":[3,1,2],"c":"text","n":null}');
  });
});
