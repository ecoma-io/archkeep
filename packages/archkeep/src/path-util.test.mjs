/**
 * Tests for path utilities — pure functions, no filesystem needed.
 */

import { describe, expect, it } from "vitest";

import { stripTrailingSlashes } from "./path-util.mjs";

describe("stripTrailingSlashes", () => {
  it("removes a single trailing slash", () => {
    expect(stripTrailingSlashes("a/")).toBe("a");
    expect(stripTrailingSlashes("/")).toBe("");
  });

  it("removes multiple trailing slashes", () => {
    expect(stripTrailingSlashes("a//")).toBe("a");
    expect(stripTrailingSlashes("a///")).toBe("a");
    expect(stripTrailingSlashes("//")).toBe("");
    expect(stripTrailingSlashes("///")).toBe("");
  });

  it("leaves a path without trailing slashes unchanged", () => {
    expect(stripTrailingSlashes("a")).toBe("a");
    expect(stripTrailingSlashes("a/b")).toBe("a/b");
    expect(stripTrailingSlashes("")).toBe("");
  });

  it("handles mixed content with trailing slashes", () => {
    expect(stripTrailingSlashes("a/b/")).toBe("a/b");
    expect(stripTrailingSlashes("a/b//")).toBe("a/b");
    expect(stripTrailingSlashes("a/b/c///")).toBe("a/b/c");
  });

  it("preserves slashes not at the end", () => {
    expect(stripTrailingSlashes("a/b/c")).toBe("a/b/c");
    expect(stripTrailingSlashes("a//b//c")).toBe("a//b//c");
    expect(stripTrailingSlashes("/a/b/c")).toBe("/a/b/c");
  });

  it("handles paths that are all slashes", () => {
    expect(stripTrailingSlashes("////")).toBe("");
  });

  it("is linear-time, not polynomial — a run of slashes mid-string does not blow up", () => {
    // The regex form `replace(/\/+$/u, "")` becomes O(n²) on a string like
    // "a" + "/"×n + "b" because the engine scans from each position within
    // the run. This test guards against re-introducing that class.
    const n = 100000;
    const evil = "a" + "/".repeat(n) + "b";
    const start = process.hrtime.bigint();
    const result = stripTrailingSlashes(evil);
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;

    expect(result).toBe(evil); // nothing to strip, but it must not hang
    expect(elapsed).toBeLessThan(10); // <10ms on modern hardware, not seconds
  });

  it("matches the regex semantics on all edge cases", () => {
    // Proves equivalence with the original `.replace(/\/+$/u, "")` form.
    const cases = [
      "",
      "/",
      "//",
      "a",
      "a/",
      "a//",
      "/a",
      "/a/",
      "//a",
      "//a//",
      "a/b",
      "a/b/",
      "a/b//",
      "a///b///",
    ];
    const regexForm = (s) => s.replace(/\/+$/u, "");

    for (const s of cases) {
      expect(stripTrailingSlashes(s)).toBe(regexForm(s));
    }
  });
});
