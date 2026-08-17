import { describe, expect, it } from "vitest";

import {
  braceExpansionCount,
  findMatchingProjects,
  globComplexityError,
  globPatternError,
  importPatternError,
  mapGlobToRegExp,
  matchImportWithWildcard,
  MAX_GLOB_EXPANSIONS,
  projectPatternError,
  safeMatchesGlob,
  tagMatches,
  tagPatternError,
} from "./match.mjs";

/**
 * A pattern shaped exactly like the one this file's own measurement used:
 * thirteen sequential two-way brace groups, an expansion count of 2**13 =
 * 8192 — comfortably past `MAX_GLOB_EXPANSIONS` (512). Before
 * `globComplexityError`/`safeMatchesGlob` existed, handing this straight to
 * `path.posix.matchesGlob` cost around 600ms for ONE call on this engine's
 * own hardware (confirmed by hand: `git stash` the fix, drop this file's
 * import of the new exports, and call `require("node:path").posix
 * .matchesGlob("x-nomatch-y", bracePattern())` directly — every test below
 * that asserts speed would time out or visibly stall without the guard).
 */
function bracePattern(groups = 13) {
  return "x" + Array.from({ length: groups }, (_, i) => `{a${i},b${i}}`).join("") + "y";
}

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

describe("braceExpansionCount", () => {
  it("counts a pattern with no braces as one alternative", () => {
    expect(braceExpansionCount("plain/path.ts", 1000)).toBe(1);
    expect(braceExpansionCount("", 1000)).toBe(1);
  });

  it("multiplies across a concatenation of groups", () => {
    expect(braceExpansionCount("x{a,b}y", 1000)).toBe(2);
    expect(braceExpansionCount("x{a,b}{c,d}y", 1000)).toBe(4);
    expect(braceExpansionCount("{a,b}{c,d}{e,f}", 1000)).toBe(8);
  });

  it("sums across a nested union instead of re-multiplying it", () => {
    // {{a,b},c} is the union {a,b,c} (3 alternatives), not 2*2 — the failure
    // mode a naive "count every comma" heuristic falls into.
    expect(braceExpansionCount("{{a,b},c}", 1000)).toBe(3);
    expect(braceExpansionCount("{{{a,b},c},d}", 1000)).toBe(4);
  });

  it("saturates at cap + 1 once the running total would exceed cap, rather than the exact count", () => {
    expect(braceExpansionCount("{a,b}{c,d}{e,f}", 4)).toBe(5); // exact total is 8
    expect(braceExpansionCount("{a,b}{c,d}", 4)).toBe(4); // exact total, still at the cap
  });

  it("stays fast on a pattern engineered to make counting itself expensive", () => {
    // 5000 sequential groups: real brace expansion would need 2**5000
    // alternatives — a number with no realistic finite completion time at
    // all, let alone a fast one. The counter must never try to represent it;
    // it has to saturate and return almost immediately, or this guard
    // becomes the DoS it exists to prevent. The bound below is generous
    // (shared-machine scheduling noise, not this function's own cost,
    // dominates a number this small) and still overwhelming proof: ANY
    // finite completion time is only possible because the guard never
    // attempted the real expansion.
    const pattern = bracePattern(5000);
    const start = performance.now();
    const count = braceExpansionCount(pattern, MAX_GLOB_EXPANSIONS);
    const elapsed = performance.now() - start;
    expect(count).toBe(MAX_GLOB_EXPANSIONS + 1);
    expect(elapsed).toBeLessThan(2000);
  });

  it("does not stack-overflow on a deeply nested pattern", () => {
    let pattern = "a";
    for (let i = 0; i < 20_000; i++) pattern = `{${pattern}}`;
    expect(() => braceExpansionCount(pattern, MAX_GLOB_EXPANSIONS)).not.toThrow();
  });
});

describe("globComplexityError", () => {
  it("accepts a realistic, small brace pattern", () => {
    expect(globComplexityError("src/**/*.{ts,tsx,js,jsx}")).toBeNull();
    expect(globComplexityError("{apps,libs,packages}/*/README.md")).toBeNull();
    expect(globComplexityError(bracePattern(1))).toBeNull();
  });

  it("refuses a pattern whose brace groups expand past the cap, naming the limit", () => {
    const error = globComplexityError(bracePattern(13));
    expect(error).toMatch(new RegExp(`more than ${MAX_GLOB_EXPANSIONS} brace-driven alternatives`));
    expect(error).toMatch(/narrow the brace groups/);
  });

  it("refuses the brace-bomb pattern quickly — the guard must fire before expansion runs away", () => {
    // Before this guard existed, this exact 13-group pattern took around
    // 600ms for path.posix.matchesGlob to resolve ONE call (measured
    // directly against Node 22.22.2 on ordinary hardware — see
    // `MAX_GLOB_EXPANSIONS`'s own doc comment in ./match.mjs) — the audit
    // this fix responds to measured the same shape growing to ~30 minutes at
    // sixteen groups. A guard that took anywhere near that long would not
    // have closed the finding; this asserts it does not.
    const bomb = bracePattern(13);
    const start = performance.now();
    const error = globComplexityError(bomb);
    const elapsed = performance.now() - start;
    expect(error).not.toBeNull();
    // `globComplexityError` never reaches `path.posix.matchesGlob` for a
    // refused pattern — it only ever runs `braceExpansionCount`'s linear
    // scan — so this has no reason to be anywhere near the ~600ms-2.6s this
    // exact pattern cost `path.posix.matchesGlob` per call before this guard
    // existed. Bounded generously against shared-machine scheduling noise,
    // not against this function's own (near-zero) cost.
    expect(elapsed).toBeLessThan(500);
  });
});

describe("safeMatchesGlob", () => {
  it("matches the same way path.posix.matchesGlob does for a pattern under the cap", () => {
    expect(safeMatchesGlob("apps/a/x.go", "apps/**")).toBe(true);
    expect(safeMatchesGlob("libs/a/x.go", "apps/**")).toBe(false);
    expect(safeMatchesGlob("src/index.ts", "src/**/*.{ts,tsx}")).toBe(true);
    expect(safeMatchesGlob("src/index.css", "src/**/*.{ts,tsx}")).toBe(false);
  });

  it("throws quickly on a brace-bomb pattern instead of hanging", () => {
    // `globComplexityError` refuses this pattern before `safeMatchesGlob`
    // ever calls the real matcher — same reasoning as `globComplexityError`'s
    // own timing test above.
    const bomb = bracePattern(13);
    const start = performance.now();
    expect(() => safeMatchesGlob("x-nomatch-y", bomb)).toThrow(/brace-driven alternatives/);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it("stays fast on a normal pattern right at the cap", () => {
    // Unlike the two tests above, an ALLOWED pattern (at, not past, the cap)
    // does reach the real `path.posix.matchesGlob` — so this bound also has
    // to absorb whatever that call itself costs, which this fix does not
    // control. Still two-plus orders of magnitude below the multi-second
    // territory an unguarded brace bomb reaches, so "fast" is not a close
    // call either way.
    const atCap = bracePattern(9); // 2**9 = 512 == MAX_GLOB_EXPANSIONS
    const start = performance.now();
    expect(() => safeMatchesGlob("x-nomatch-y", atCap)).not.toThrow();
    expect(performance.now() - start).toBeLessThan(1500);
  });
});
