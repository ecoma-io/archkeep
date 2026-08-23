import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { findBoundaryConfigViolations, loadBoundaryConfig } from "../config.mjs";
import {
  braceExpansionCount,
  findMatchingProjects,
  globComplexityError,
  globPatternError,
  importPatternError,
  mapGlobToRegExp,
  matchImportWithWildcard,
  MAX_DELIMITED_SEGMENTS,
  MAX_GLOB_EXPANSIONS,
  MAX_SPECIFIER_LENGTH,
  projectPatternError,
  regexComplexityError,
  safeMatchesGlob,
  tagMatches,
  tagPatternError,
} from "./match.mjs";

/**
 * Every policy this repository ships or governs itself by: the six presets
 * under `presets/`, and the boundary law at the workspace root that
 * `cli.mjs check` runs against this tree in CI.
 *
 * Loaded from the files rather than restated, for the reason
 * `../config.integration.test.mjs` gives about the same root: the corpus that
 * matters is the one a consumer really hands the guard, and a restated copy
 * keeps passing on the day a preset gains a pattern the guard refuses.
 */
const presetsDir = fileURLToPath(new URL("../../presets/", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const shippedPolicies = [
  ...readdirSync(presetsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(presetsDir, name), "utf8"))),
  // Through the real loader rather than a dynamic `import()` of its own: the
  // loader is what a consumer's run uses, and reaching for it here keeps this
  // file free of a second non-literal import for `cli.mjs check` to report as
  // a blind spot in its own tree.
  await loadBoundaryConfig(workspaceRoot, "module-boundaries.config.mjs"),
];

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

  it("counts a minimatch numeric RANGE as its full cardinality, not as one comma-free alternative", () => {
    // `path.posix.matchesGlob` expands `{start..end}` combinatorially even
    // though it contains no comma — the shape `braceExpansionCount` used to
    // see as a single, comma-free alternative and count as 1. Verified
    // directly against the real matcher: `posix.matchesGlob("5", "{1..10}")`
    // is `true` and `posix.matchesGlob("15", "{1..10}")` is `false`, so the
    // group really does stand for all ten of "1".."10", not the four literal
    // characters "1..10".
    expect(braceExpansionCount("{1..10}", 1000)).toBe(10);
    expect(braceExpansionCount("x{1..5}y", 1000)).toBe(5);
    // A descending range still counts by span, not by sign.
    expect(braceExpansionCount("{10..1}", 1000)).toBe(10);
    // A step narrows the count the same way it narrows the real expansion.
    expect(braceExpansionCount("{1..10..2}", 1000)).toBe(5);
  });

  it("counts a minimatch single-letter alpha RANGE the same way", () => {
    // `posix.matchesGlob("c", "{a..e}")` is `true`; the group stands for
    // "a".."e" (5 letters), not the literal four-character string "a..e".
    expect(braceExpansionCount("{a..e}", 1000)).toBe(5);
    expect(braceExpansionCount("{A..E}", 1000)).toBe(5);
  });

  it("does not misread a comma union or a multi-character group as a range", () => {
    // A comma present anywhere in the group defeats range syntax in the real
    // matcher (verified: `posix.matchesGlob("5", "{1..10,x}")` is `false`,
    // while `posix.matchesGlob("1..10", "{1..10,x}")` is `true`) — the
    // group's two alternatives are the literal strings "1..10" and "x".
    expect(braceExpansionCount("{1..10,x}", 1000)).toBe(2);
    // Two-or-more-character endpoints are never range syntax.
    expect(braceExpansionCount("{ab..cd}", 1000)).toBe(1);
  });

  it("refuses a RANGE pattern whose cardinality alone exceeds the cap, in bounded time", () => {
    // The bug this closes: a pattern with zero commas used to be counted as
    // 1 alternative regardless of its range span, so `{1..20000}` sailed
    // through `globComplexityError`'s cap of 512 uncounted — and, unguarded,
    // cost `path.posix.matchesGlob` on the order of a MINUTE for one call
    // (the sibling `{1..300000}` case in this bug's report measured ~110
    // seconds). This only exercises the counter, never the real matcher, so
    // it must return near-instantly regardless.
    const start = performance.now();
    const count = braceExpansionCount("{1..20000}", MAX_GLOB_EXPANSIONS);
    const elapsed = performance.now() - start;
    expect(count).toBe(MAX_GLOB_EXPANSIONS + 1);
    expect(elapsed).toBeLessThan(500);
  });

  it("refuses four chained alpha ranges (26**4 alternatives) without ever materializing them", () => {
    const start = performance.now();
    const count = braceExpansionCount("{a..z}{a..z}{a..z}{a..z}", MAX_GLOB_EXPANSIONS);
    const elapsed = performance.now() - start;
    expect(count).toBe(MAX_GLOB_EXPANSIONS + 1); // exact total is 26**4 = 456976
    expect(elapsed).toBeLessThan(500);
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

  it("refuses a minimatch RANGE pattern the same as an equal-cardinality comma union — this is bug 1's config-load fix", () => {
    // This is the exact silent-guard-failure this fix closes: before it,
    // `braceExpansionCount("{1..20000}", 512)` returned 1 (no comma inside
    // the group), so this pattern sailed past the cap and reached
    // `boundarySuppressions[].path` / `coverage.exempt[].path` /
    // `projectRules[].match` / `projects.infer.include`/`exclude` validation
    // as though it were cheap — every one of those fields is
    // attacker-controlled config (`../../../../SECURITY.md`). Now it is
    // refused loudly at config load, the same way a 20000-way comma union
    // already was.
    const error = globComplexityError("{1..20000}");
    expect(error).not.toBeNull();
    expect(error).toMatch(new RegExp(`more than ${MAX_GLOB_EXPANSIONS} brace-driven alternatives`));
  });

  it("refuses four chained alpha ranges the same way, and stays fast doing it", () => {
    const start = performance.now();
    const error = globComplexityError("{a..z}{a..z}{a..z}{a..z}");
    const elapsed = performance.now() - start;
    expect(error).not.toBeNull();
    expect(elapsed).toBeLessThan(500);
  });

  it("still accepts an ordinary small range and an ordinary small comma group", () => {
    expect(globComplexityError("{1..5}")).toBeNull();
    expect(globComplexityError("v{1..3}/README.md")).toBeNull();
    expect(globComplexityError("{apps,libs,packages}/*/README.md")).toBeNull();
  });
});

/**
 * Every pattern the six shipped presets and this repository's own boundary law
 * carry, paired with the validator its field actually reaches. Read out of the
 * real files rather than copied here: a copy proves the copy loads, and the
 * failure this guards against is a workspace whose config stops loading —
 * which reports no violations at all, indistinguishable from a boundary law
 * that was switched off.
 *
 * @returns {{ field: string, value: string, validate: (pattern: string) => string|null }[]}
 */
function shippedPatterns(policies) {
  /** @type {Record<string, (pattern: string) => string|null>} */
  const validators = {
    sourceTag: tagPatternError,
    onlyDependOnLibsWithTags: tagPatternError,
    notDependOnLibsWithTags: tagPatternError,
    bannedExternalImports: globPatternError,
    allowedExternalImports: globPatternError,
    allow: importPatternError,
    checkDynamicDependenciesExceptions: importPatternError,
  };
  /** @type {{ field: string, value: string, validate: (pattern: string) => string|null }[]} */
  const found = [];
  /**
   * @param {unknown} value
   * @param {string} key
   */
  const walk = (value, key) => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, key);
      return;
    }
    if (value && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) walk(child, childKey);
      return;
    }
    if (typeof value === "string" && validators[key]) {
      found.push({ field: key, value, validate: validators[key] });
    }
  };
  for (const policy of policies) walk(policy, "");
  return found;
}

describe("regexComplexityError", () => {
  it("accepts the ordinary policy shapes, however many wildcards they carry", () => {
    // Every entry here is a pattern a real `allow`, `bannedExternalImports` or
    // tag glob is written in, and every one of them carries MORE unbounded
    // repetitions than this engine will re-split. That is the point: what
    // costs time is not how many wildcards a pattern has, it is whether
    // anything after them can fail. `mapGlobToRegExp` anchors what it builds,
    // so a glob's last wildcard runs to the end of the specifier and nothing
    // is ever retried — measured, `^.*-.*-.*$` costs 0.0ms against a
    // 2000-character subject of only dashes where `^.*-.*-.*x$` costs 1483ms.
    for (const [dialect, pattern] of [
      ["glob", "@acme/*/*/*"],
      ["glob", "libs/*/*/*"],
      ["glob", "**/*/*/*"],
      ["glob", "@scope/**/testing/**"],
      ["import", "a*b*c*d"],
      ["import", "^@myorg/.*$"],
      ["tag", "/^scope:.*:.*:.*$/"],
      ["tag", "/^\\w+(\\.\\w+)*$/"],
      ["tag", "/^(ui|core)+\\//"],
      ["tag", "/(a|b)+/"],
      ["tag", "/^.*-.*-.*$/"],
    ]) {
      const validate =
        dialect === "glob"
          ? globPatternError
          : dialect === "import"
            ? importPatternError
            : tagPatternError;
      expect(validate(pattern), `${dialect} ${pattern}`).toBeNull();
    }
  });

  it("refuses every catastrophic family, by shape rather than by name", () => {
    // The exponential ones first — each reachable from a boundary config with
    // no code execution at all, since a `.json` policy is read by `JSON.parse`
    // and every value in it arrives in a pull request — then the polynomial
    // ones, which are slower to bite and just as fatal: measured on Node
    // v24.16.0, `a+a+a+a+$` costs 694ms against a 140-character subject that
    // does not match, and `^a.*a.*a.*z$` costs 1.5 seconds against a
    // 2000-character one.
    for (const source of [
      "(a+)+$",
      "(a|aa)+",
      "(a*)*",
      "([a-z]+)*",
      "((a+))+",
      "(?:a+)+",
      "(a{2,}){2,}",
      "^(a|a?)+$",
      "\\b(x+x+)+y",
      "([^;]*)*$",
      "^(\\s*a)+$",
      "^(?:a|b|ab)*$",
      "(a+)*b",
      "([a-z]+)+@",
      "(x{1,100}){1,100}",
      "(a+?)+",
      "a+a+a+a+$",
      "[a-z]+[a-z]+[a-z]+[a-z]+$",
      "^a.*a.*a.*z$",
      "^.*-.*-.*x$",
    ]) {
      expect(regexComplexityError(source), source).not.toBeNull();
    }
  });

  it("turns on what follows the last wildcard, not on how many there are", () => {
    // The pair the calibration is built from, one character apart. Reversing
    // this test is what the old cap did: it counted the wildcards, refused
    // both, and took `@acme/*/*/*` down with them.
    expect(regexComplexityError("^.*-.*-.*$")).toBeNull();
    expect(regexComplexityError("^.*-.*-.*x$")).not.toBeNull();
    expect(regexComplexityError("^scope:.*:.*:.*$")).toBeNull();
    expect(regexComplexityError("^scope:.*:.*:.*x$")).not.toBeNull();
    // And the same distinction one level down: a chain of the SAME delimiter
    // ending in a wildcard is free at any length this engine allows, because
    // a subject with enough delimiters to make the search wide is a subject
    // that matches. One requirement of a different character is all it takes
    // to make the search both wide and doomed.
    expect(regexComplexityError(".*/.*/.*/.*")).toBeNull();
    expect(regexComplexityError(".*/.*/.*/.*/x")).not.toBeNull();
    expect(regexComplexityError("^.*c.*c.*c.*$")).toBeNull();
    expect(regexComplexityError("^.*c.*c.*c$")).not.toBeNull();
  });

  it("refuses past the delimited-segment cap even when every delimiter agrees", () => {
    // The exemption above is a cap, not a licence: the small search that
    // survives still grows with the segment count. Measured against a
    // 2000-character subject one delimiter short of matching, eight segments
    // cost 0.0ms, sixteen cost 3.6ms and twenty cost 69.1ms.
    // Anchored, because that is the shape `mapGlobToRegExp` compiles and the
    // shape the measurement was taken on.
    const chain = (count) => `^${Array.from({ length: count }, () => ".*").join("/")}$`;
    expect(regexComplexityError(chain(MAX_DELIMITED_SEGMENTS + 1))).toBeNull();
    expect(regexComplexityError(chain(MAX_DELIMITED_SEGMENTS + 2))).not.toBeNull();
  });

  it("decides a repeated group on ambiguity, not on there being a quantifier in it", () => {
    // `^\w+(\.\w+)*$` is the idiom the old rule refused and the reason this
    // one asks a different question: `\.` and `\w` cannot match the same
    // character, so every iteration of the group is pinned by its leading dot
    // and there is nothing to backtrack through. Measured, it is 0.0ms against
    // a 2000-character subject built to defeat it.
    expect(regexComplexityError("^\\w+(\\.\\w+)*$")).toBeNull();
    expect(regexComplexityError("(a|b)+")).toBeNull();
    expect(regexComplexityError("^(ui|core)+/")).toBeNull();
    expect(regexComplexityError("(ab)+")).toBeNull();
    expect(regexComplexityError("(a{2})+")).toBeNull();
    expect(regexComplexityError("(a+)?")).toBeNull(); // `?` runs a body once
    // The neighbouring spellings that are ambiguous, each differing from one
    // of the above by which characters the group's parts share.
    expect(regexComplexityError("^\\w+(\\w\\w+)*$")).not.toBeNull();
    expect(regexComplexityError("(a|ab)+")).not.toBeNull();
    expect(regexComplexityError("(\\.\\w+\\.)+")).not.toBeNull();
  });

  it("judges an alternation by its worst branch, not by whichever came first", () => {
    // The engine tries every branch, so one costly branch is a costly
    // pattern. A comparison that ranked branches by degree alone would let a
    // safe branch standing in front of a dangerous one decide the verdict,
    // and the two spellings below differ by nothing but that order.
    expect(regexComplexityError("^.*/.*/.*/.*$|^a.*a.*a.*z$")).not.toBeNull();
    expect(regexComplexityError("^a.*a.*a.*z$|^.*/.*/.*/.*$")).not.toBeNull();
    // And neither order refuses a pattern whose branches are all ordinary.
    expect(regexComplexityError("^.*/.*/.*/.*$|^@a/.*$")).toBeNull();
    expect(regexComplexityError("^@a/.*$|^.*/.*/.*/.*$")).toBeNull();
  });

  it("counts the retry an unanchored pattern pays at every position in the subject", () => {
    // A whole factor of the subject's length, and invisible in the pattern's
    // wildcard count: measured on Node v24.16.0 against a 1024-character
    // subject, `a.*b.*c` costs 61ms where `^a.*b.*c` costs 0.29ms, because
    // without the anchor the engine starts the same search again at every
    // position. `mapGlobToRegExp` anchors what it compiles, so no glob pays
    // it — which is why the same two wildcards are fine in a glob and are not
    // fine written by hand into an `allow` entry with a literal after them.
    expect(regexComplexityError("^a.*b.*c")).toBeNull();
    expect(regexComplexityError("a.*b.*c")).not.toBeNull();
    expect(globPatternError("@scope/*/*")).toBeNull();
  });

  it("finds the repetitions a group hides, wherever the group hides them", () => {
    // Three hiding places, each one measured at a factor of the subject's
    // length against a 1024-character subject: a group that runs at most once
    // (`[^/]{2,}.?:{1,4}(?:.*)?x$`, 7.6 seconds), a branch of an alternation
    // (`.*b?([a-z]([^/]{1,4}|[^/]*))xb?$`, 458ms), and a chain of neighbours
    // that can trade the same text between them (`^[a-z]+b+[a-z]{2,}\d{2,}`,
    // 188ms). A count that looked only at the top-level chain read all three
    // as ordinary.
    expect(regexComplexityError("[^/]{2,}.?:{1,4}(?:.*)?x$")).not.toBeNull();
    expect(regexComplexityError(".*b?([a-z]([^/]{1,4}|[^/]*))xb?$")).not.toBeNull();
    expect(regexComplexityError("^[a-z]+b+[a-z]{2,}\\d{2,}")).not.toBeNull();
    // And the same shapes where the parts cannot trade text stay accepted:
    // `\.` separates `\d+` from `\d+` and is in neither of them, which is
    // what makes a version pattern cheap and `[a-z]+b+` expensive.
    expect(regexComplexityError("^v\\d+\\.\\d+\\.\\d+$")).toBeNull();
    expect(regexComplexityError("a*b*c*d")).toBeNull();
    expect(regexComplexityError("(?:@scope/)?internal")).toBeNull();
  });

  it("reads a regex the way the engine does, not the way a naive scan would", () => {
    // Each `null` here would be a false refusal of a legitimate pattern; each
    // refusal a catastrophic pattern let through.
    expect(regexComplexityError("[*+*+*+]+")).toBeNull(); // metacharacters in a class are literal
    expect(regexComplexityError("\\*\\+\\*\\+\\*")).toBeNull(); // escaped, so not quantifiers
    expect(regexComplexityError("(?:ab)+")).toBeNull(); // `(?:` is an opener, not a `?` quantifier
    expect(regexComplexityError("a+?b+?c")).toBeNull(); // `+?` is one lazy quantifier, not two
    expect(regexComplexityError("a{b}c")).toBeNull(); // a `{` that is not a quantifier
    expect(regexComplexityError("(a+?)+")).not.toBeNull(); // lazy inside is still ambiguous
    expect(regexComplexityError("(?=(a+)+)x")).not.toBeNull(); // inside a lookahead still runs
  });

  it("treats what it cannot resolve as matching anything, which refuses rather than excuses", () => {
    // The direction of every fallback in the model, asserted rather than
    // assumed. A construct it does not resolve exactly — a complement class,
    // a backreference, a property escape, a negated class — reads as "matches
    // any character", so it overlaps whatever sits beside it and the
    // repetition around it is refused. Read the other way, as some narrow set,
    // each of these would be EXCUSED, and an excused repetition is a run that
    // does not come back.
    expect(regexComplexityError("(\\W\\w+)+")).not.toBeNull();
    expect(regexComplexityError("(\\1a)+")).not.toBeNull();
    expect(regexComplexityError("(\\p{L}a)+")).not.toBeNull();
    expect(regexComplexityError("(\\k<n>a)+")).not.toBeNull();
    expect(regexComplexityError("([^x]+a)+")).not.toBeNull();
    // And the escapes it does resolve keep their narrow answer, so a group
    // whose parts really are disjoint is still pinned by its leading atom.
    expect(regexComplexityError("(\\n\\w+)+")).toBeNull();
    expect(regexComplexityError("([a-c]\\d+)+")).toBeNull();
    expect(regexComplexityError("(\\x2ea\\u0062)+")).toBeNull();
    expect(regexComplexityError("(-[a-z]+)+")).toBeNull();
  });

  it("names the sub-pattern a reader has to find in their own config", () => {
    // Not the wording — the SPAN. A refusal quoting `a+)+` names nothing a
    // reader can search their policy for, which is how a correct diagnosis
    // becomes an unactionable one.
    expect(regexComplexityError("x(a|aa)+y")).toContain("(a|aa)+");
    expect(regexComplexityError("\\b(x+x+)+y")).toContain("(x+x+)+");
  });

  it("refuses rather than models a pattern nested past what it reads", () => {
    // The safe direction for a guard that cannot decide: a deep pattern is
    // refused loudly at config load, where the alternative is a walk that
    // recurses as deep as a pull request tells it to.
    expect(regexComplexityError(`${"(".repeat(64)}a${")".repeat(64)}`)).not.toBeNull();
    expect(regexComplexityError("((((((a))))))")).toBeNull();
  });

  it("accepts every pattern this repository actually ships", () => {
    // Read out of the six presets and this workspace's own boundary law, not
    // copied: the corpus that matters is the one a consumer will really hand
    // this guard, and a copy here would keep passing on the day a preset
    // gained a pattern the guard refuses.
    const patterns = shippedPatterns(shippedPolicies);
    expect(patterns.length).toBeGreaterThan(40);
    for (const { field, value, validate } of patterns) {
      expect(validate(value), `${field}: ${value}`).toBeNull();
    }
  });
});

describe("the three Nx dialects refuse a catastrophic pattern at config load", () => {
  /**
   * The pattern the audit measured, and the reason this guard exists:
   * `importPatternError("(a+)+$")` returned `null` — accepted, written into
   * the policy, and then run per import site. Against a subject of `a`s that
   * never matches, one call cost 12ms at 20 characters, 201ms at 24, 775ms at
   * 26 and 12.4 seconds at 30 on Node v24.16.0 — four times the work for
   * every two characters, so an import specifier of ordinary length is hours
   * of CPU and a slightly longer one never returns.
   */
  const catastrophic = "(a+)+$";

  /**
   * A policy carrying the whole option table, because `../config.mjs`
   * requires every one of the eight to be stated — so what the assertions
   * below report on is the patterns and nothing else.
   *
   * @param {object} extra
   */
  const policy = (extra) => ({
    moduleBoundaryOptions: {
      allow: [],
      buildTargets: ["build"],
      enforceBuildableLibDependency: false,
      allowCircularSelfDependency: false,
      checkDynamicDependenciesExceptions: [],
      ignoredCircularDependencies: [],
      banTransitiveDependencies: false,
      checkNestedExternalImports: false,
      ...extra.moduleBoundaryOptions,
    },
    depConstraints: extra.depConstraints,
  });

  it("names the row and the reason, so a config load fails on the offender", () => {
    // The end of the path this fix closes: `../config.mjs` is where a policy
    // is validated, and a violation there is what makes `cli.mjs check` exit
    // 3 instead of running the pattern. Asserted from here because this is
    // the file that decides the reason; `../config.mjs` only prefixes the row.
    const violations = findBoundaryConfigViolations(
      policy({
        depConstraints: [
          { sourceTag: "type-package", bannedExternalImports: ["@vendor/*", catastrophic] },
        ],
      }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^depConstraints\[0\]\.bannedExternalImports\[1\]: /);
    expect(violations[0]).toContain(catastrophic);
  });

  it("still loads a policy whose patterns are ordinary", () => {
    // The silent direction of this guard is refusing a workspace's real
    // config: a policy that no longer loads reports no violations at all, and
    // an over-eager complexity check would be indistinguishable from a
    // boundary law that had been switched off.
    expect(
      findBoundaryConfigViolations(
        policy({
          depConstraints: [
            {
              sourceTag: "layer:app",
              onlyDependOnLibsWithTags: ["layer:*", "/^layer:(domain|ports)$/", "*"],
              bannedExternalImports: ["@vendor/*", "*/testing/*", "@scope/*/src/*"],
            },
          ],
          moduleBoundaryOptions: { allow: ["@scope/**", "^@myorg/.*$"] },
        }),
      ),
    ).toEqual([]);
  });

  it("reports the same refusal through each of the three validators", () => {
    expect(importPatternError(catastrophic)).not.toBeNull();
    expect(globPatternError(catastrophic)).not.toBeNull();
    expect(tagPatternError(`/${catastrophic}/`)).not.toBeNull();
    // And the benign spellings of the same three still validate.
    expect(importPatternError("@scope/**")).toBeNull();
    expect(globPatternError("@vendor/shell*")).toBeNull();
    expect(tagPatternError("/^zone:/")).toBeNull();
  });

  it("throws rather than running the pattern, in each matcher that compiles one", () => {
    // Defence in depth, the same arrangement `safeMatchesGlob` has below: a
    // caller that skipped config-load validation still cannot reach the
    // compiled pattern. The subject is 40 characters, where the measurements
    // above put a single unguarded call in the region of hours — so the
    // margin under this bound is not a factor of ten, it is a factor of
    // roughly ten million, and no amount of load on a shared machine makes
    // this assertion a close call.
    const subject = `${"a".repeat(40)}!`;
    const start = performance.now();
    expect(() => matchImportWithWildcard(catastrophic, subject)).toThrow(/repeats a group/);
    expect(() => mapGlobToRegExp(catastrophic)).toThrow(/repeats a group/);
    expect(() => tagMatches([subject], `/${catastrophic}/`)).toThrow(/repeats a group/);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("counts a glob's wildcards after mapping, not before", () => {
    // `mapGlobToRegExp` collapses a RUN of stars into one `.*` before
    // anything is compiled, so the cap is counted on what actually runs.
    // Counting the raw spelling instead would refuse `@scope/**` for
    // carrying two stars — a pattern from this repository's own fixtures.
    expect(globPatternError("@scope/**")).toBeNull();
    expect(globPatternError("**/*.css")).toBeNull();
    expect(mapGlobToRegExp("@scope/**").test("@scope/a/b")).toBe(true);
  });

  it("refuses a glob and its regex spelling alike, because they compile to one thing", () => {
    // `a*b*c*d` is two different patterns depending on which field it lands
    // in, and only one of them is cheap. As an `allow` entry it is handed to
    // `RegExp` as written, where `a*` and `b*` cannot match the same
    // character and the cost is quadratic — 12ms against a 2000-character
    // subject. As a GLOB every star becomes `.*`, which gives three wildcards
    // that CAN re-split the same text in front of a `d` that never comes:
    // measured, 529ms against a 2000-character subject on Node v24.16.0, and
    // 4.5 seconds against 4000. The guard follows the compiled form, so the
    // two spellings get different answers on purpose.
    expect(importPatternError("a*b*c*d")).toBeNull();
    expect(globPatternError("a*b*c*d")).not.toBeNull();
    expect(regexComplexityError("^a.*b.*c.*d$")).not.toBeNull();
  });
});

describe("MAX_SPECIFIER_LENGTH", () => {
  it("refuses to match a specifier longer than a specifier can be", () => {
    // The other multiplicand. Every pattern that survives config load is
    // still quadratic in the length of a subject that does not match, and
    // nothing upstream bounds that length — a specifier is text read out of
    // a source file. Measured on Node v24.16.0, the worst pattern the cap
    // still allows costs 0.58ms against a 1024-character subject and 9.16ms
    // against 4096.
    const specifier = "@scope/".concat("a".repeat(MAX_SPECIFIER_LENGTH));
    expect(() => matchImportWithWildcard("^@scope/.*$", specifier)).toThrow(
      new RegExp(String(MAX_SPECIFIER_LENGTH)),
    );
    // The cheap branches are behind the same door, deliberately: one rule
    // about what may come through is easier to hold than four rules about
    // what each branch does with it.
    expect(() => matchImportWithWildcard("@scope/**", specifier)).toThrow();
  });

  it("leaves a specifier of any plausible length alone", () => {
    // The silent direction: a bound low enough to fire on a real specifier
    // would turn every run on a real workspace into exit 3. This is the
    // longest thing the four analyzers can emit — a deep path — and it is an
    // order of magnitude under the bound.
    const realistic = `../${"some-nested-directory/".repeat(8)}module-under-test`;
    expect(realistic.length).toBeLessThan(MAX_SPECIFIER_LENGTH);
    expect(matchImportWithWildcard("^\\.\\./.*$", realistic)).toBe(true);
    expect(matchImportWithWildcard("@scope/**", realistic)).toBe(false);
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

  it("throws quickly on a RANGE-bomb pattern instead of running the real matcher for ~110 seconds", () => {
    // Verified directly (not asserted here — see this bug's report): a single
    // unguarded `safeMatchesGlob(..., "{1..300000}")` call cost roughly 110
    // seconds against `path.posix.matchesGlob` before this fix. This test
    // only has to prove the guard now fires before that call is ever made.
    const start = performance.now();
    expect(() => safeMatchesGlob("x-nomatch-y", "{1..20000}")).toThrow(/brace-driven alternatives/);
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
