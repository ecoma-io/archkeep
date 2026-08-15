import { describe, expect, it } from "vitest";

import {
  findMatchingProjects,
  globPatternError,
  importPatternError,
  mapGlobToRegExp,
  matchImportWithWildcard,
  projectPatternError,
  tagMatches,
  tagPatternError,
} from "./match.mjs";

/**
 * These are the three dialects a reimplementation gets wrong quietly. Each test
 * below fails against a glob library that "obviously" does the same thing — the
 * simple cases agree, and the disagreements are exactly the ones that decide
 * whether an escape hatch still works.
 */

describe("matchImportWithWildcard", () => {
  it("takes a trailing /** across every segment beneath the prefix", () => {
    expect(matchImportWithWildcard("@scope/pkg/**", "@scope/pkg/a/b/c")).toBe(true);
    expect(matchImportWithWildcard("@scope/pkg/**", "@scope/other/a")).toBe(false);
  });

  it("takes a trailing /* within one segment only", () => {
    expect(matchImportWithWildcard("@scope/pkg/*", "@scope/pkg/a")).toBe(true);
    expect(matchImportWithWildcard("@scope/pkg/*", "@scope/pkg/a/b")).toBe(false);
    expect(matchImportWithWildcard("@scope/pkg/*", "@other/pkg/a")).toBe(false);
  });

  it("takes an interior /**/ as a prefix and a suffix", () => {
    expect(matchImportWithWildcard("@scope/**/testing", "@scope/pkg/deep/testing")).toBe(true);
    expect(matchImportWithWildcard("@scope/**/testing", "@scope/pkg/deep/runtime")).toBe(false);
  });

  it("treats a pattern with no wildcard as an unanchored regular expression", () => {
    // The trap: not an equality check, and not a glob. `.` is any character and
    // there are no anchors, so an entry matches far more than it reads.
    expect(matchImportWithWildcard("@scope/pkg", "prefix-@scope/pkgsuffix")).toBe(true);
    expect(matchImportWithWildcard("@scope.pkg", "@scopeXpkg")).toBe(true);
    expect(matchImportWithWildcard("", "anything at all")).toBe(true);
  });
});

describe("mapGlobToRegExp", () => {
  it("anchors the pattern and turns every run of stars into .*", () => {
    expect(mapGlobToRegExp("@vendor/shell*").test("@vendor/shell/window")).toBe(true);
    expect(mapGlobToRegExp("@vendor/shell*").test("other/@vendor/shell")).toBe(false);
    expect(mapGlobToRegExp("@vendor/**/deep").test("@vendor/a/b/deep")).toBe(true);
  });

  it("leaves every other regex metacharacter meaning what regex means by it", () => {
    expect(mapGlobToRegExp("@vendor/shell").test("@vendorXshell")).toBe(false);
    expect(mapGlobToRegExp("a.c").test("abc")).toBe(true);
  });
});

describe("tagMatches", () => {
  it("matches a plain tag exactly", () => {
    expect(tagMatches(["zone:x"], "zone:x")).toBe(true);
    expect(tagMatches(["zone:xy"], "zone:x")).toBe(false);
  });

  it("matches every project through a bare star", () => {
    expect(tagMatches([], "*")).toBe(true);
  });

  it("matches a slash-delimited tag as a regular expression", () => {
    expect(tagMatches(["zone:x"], "/^zone:/")).toBe(true);
    expect(tagMatches(["grade:open"], "/^zone:/")).toBe(false);
  });

  it("matches a tag containing a star as an anchored glob", () => {
    expect(tagMatches(["zone:x"], "zone:*")).toBe(true);
    expect(tagMatches(["other:zone:x"], "zone:*")).toBe(false);
  });

  it("returns false when tags are empty and the pattern is not bare star", () => {
    expect(tagMatches([], "zone:x")).toBe(false);
  });
});

describe("pattern validation", () => {
  it("accepts the patterns the matchers can use", () => {
    expect(importPatternError("@scope/*")).toBeNull();
    expect(globPatternError("@vendor/shell*")).toBeNull();
    expect(tagPatternError("/^zone:/")).toBeNull();
    expect(projectPatternError("tag:zone:x")).toBeNull();
    expect(projectPatternError("*")).toBeNull();
    expect(projectPatternError("!alpha")).toBeNull();
  });

  it("reports a pattern that cannot be compiled, rather than throwing from a rule", () => {
    expect(importPatternError("@scope/(pkg")).toMatch(/not a valid import pattern/);
    expect(globPatternError("[unclosed")).toMatch(/not a valid import glob/);
    expect(tagPatternError("/(unclosed/")).toMatch(/not a valid tag pattern/);
  });

  it("reports a project pattern whose glob syntax this engine does not reproduce", () => {
    expect(projectPatternError("libs/*")).toMatch(/does not reproduce/);
    expect(projectPatternError("tag:zone:{x,y}")).toMatch(/does not reproduce/);
  });
});

describe("findMatchingProjects", () => {
  const nodes = {
    alpha: { data: { root: "area/alpha", tags: ["zone:x"] } },
    beta: { data: { root: "area/beta", tags: ["zone:y"] } },
    alpha_helper: { data: { root: "area/alpha-helper", tags: ["zone:x"] } },
    "alpha-e2e": { data: { root: "area/alpha-e2e", tags: [] } },
  };

  it("returns nothing for an empty pattern list", () => {
    expect(findMatchingProjects([], nodes)).toEqual([]);
    expect(findMatchingProjects([""], nodes)).toEqual([]);
  });

  it("selects every project through a bare star", () => {
    expect(findMatchingProjects(["*"], nodes).sort()).toEqual(Object.keys(nodes).sort());
  });

  it("selects by exact name before anything else", () => {
    expect(findMatchingProjects(["beta"], nodes)).toEqual(["beta"]);
  });

  it("selects by tag and by directory when the pattern says which", () => {
    expect(findMatchingProjects(["tag:zone:x"], nodes).sort()).toEqual(["alpha", "alpha_helper"]);
    expect(findMatchingProjects(["directory:area/beta"], nodes)).toEqual(["beta"]);
  });

  it("treats an unlabeled pattern as a word-bounded name match where - ends a word and _ does not", () => {
    // Upstream's own regex, reproduced: `alpha` selects `alpha_helper` but not
    // `alpha-e2e`. A plain substring match would take both.
    expect(findMatchingProjects(["name:alph"], nodes).sort()).toEqual([]);
    expect(findMatchingProjects(["alph"], nodes).sort()).toEqual([]);
    const bareAlpha = findMatchingProjects(["alpha"], nodes);
    expect(bareAlpha).toContain("alpha");
    expect(bareAlpha).not.toContain("alpha-e2e");
  });

  it("falls back to directories only when no name matched", () => {
    expect(findMatchingProjects(["area/beta"], nodes)).toEqual(["beta"]);
  });

  it("prepends a wildcard when the list opens with an exclusion", () => {
    expect(findMatchingProjects(["!beta"], nodes).sort()).toEqual(
      Object.keys(nodes)
        .filter((n) => n !== "beta")
        .sort(),
    );
    expect(findMatchingProjects(["!tag:zone:x"], nodes).sort()).toEqual(["alpha-e2e", "beta"]);
  });

  it("skips a cross-workspace reference that could never match", () => {
    expect(findMatchingProjects(["nx-cloud:something"], nodes)).toEqual([]);
  });

  it("returns empty when a tag pattern selects nothing", () => {
    expect(findMatchingProjects(["tag:zone:nonexistent"], nodes)).toEqual([]);
  });

  it("refuses a pattern it cannot reproduce rather than selecting an approximation", () => {
    expect(() => findMatchingProjects(["area/*"], nodes)).toThrow(/does not reproduce/);
  });

  it("removes an excluded project that the expanding wildcard just selected", () => {
    // `["*", "!beta"]` — the exclusion names a real node, so the delete must
    // remove exactly that node from the wildcard's selection.
    expect(findMatchingProjects(["*", "!beta"], nodes).sort()).toEqual(
      Object.keys(nodes)
        .filter((name) => name !== "beta")
        .sort(),
    );
  });

  it("returns nothing when the list is made only of empty patterns", () => {
    expect(findMatchingProjects(["", ""], nodes)).toEqual([]);
  });

  it("skips an empty or cross-workspace pattern inside a longer list", () => {
    // "nx-cloud:" patterns and empty strings are skipped per entry, so the
    // rest of the list still selects.
    expect(findMatchingProjects(["*", "", "nx-cloud:somewhere"], nodes).sort()).toEqual(
      Object.keys(nodes).sort(),
    );
  });

  it("reads a pattern that matches nothing as selecting nothing", () => {
    // An unlabeled word that is neither a project name nor a root selects
    // nothing, without error — the waterfall ends at the directory pass.
    expect(findMatchingProjects(["nonexistent"], nodes)).toEqual([]);
  });

  it("treats a labeled pattern with an unknown label as the unlabeled waterfall", () => {
    // `mystery:thing` — no valid label, no node of that name — falls through
    // to the name pass and then the directory pass, selecting nothing.
    expect(findMatchingProjects(["mystery:thing"], nodes)).toEqual([]);
  });

  it("matches a bare word by the word-bounded regex when it is not an exact name", () => {
    // `_` is not a word boundary, so `x` selects `a_x` while `-x` inside
    // `alpha-e2e` never matches `e2e`... the boundary rules are upstream's,
    // reproduced exactly.
    const sparse = { a_x: { data: { root: "area/a_x", tags: [] } } };
    expect(findMatchingProjects(["x"], sparse)).toEqual(["a_x"]);
  });

  it("excludes a regex-matched name the same way it excludes an exact one", () => {
    const sparse = {
      a_x: { data: { root: "area/a_x", tags: [] } },
      keep: { data: { root: "area/keep", tags: [] } },
    };
    expect(findMatchingProjects(["*", "!x"], sparse)).toEqual(["keep"]);
  });

  it("excludes by directory pattern, the mirror of the inclusion test", () => {
    expect(findMatchingProjects(["!directory:area/beta"], nodes).sort()).toEqual(
      Object.keys(nodes)
        .filter((name) => name !== "beta")
        .sort(),
    );
  });

  it("reads a project with no tags key through the tag matcher", () => {
    // `node.data?.tags || []` — a node without a tags key is untagged, and a
    // tag pattern simply does not select it.
    const sparse = { untagged: { data: { root: "area/untagged" } } };
    expect(findMatchingProjects(["tag:zone:x"], sparse)).toEqual([]);
  });
});
