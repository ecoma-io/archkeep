import { describe, expect, it } from "vitest";

import {
  classifyCustomFindings,
  classifyDelta,
  classifyUnresolvableRecords,
  classifyViolations,
  violationIdentity,
} from "./delta-classify.mjs";

/**
 * What the classifier guarantees: every violation and every unresolvable
 * record lands in exactly one of introduced | resolved | unchanged | unknown,
 * and the two silent failure shapes are impossible — a partial fix never
 * reads as "resolved", and an item whose identity cannot be stated never
 * disappears. Each case here asserts the bucket an item must NOT be in as
 * well as the one it must, because a classifier that drops an item produces
 * exactly the empty output a correct one produces for a clean delta
 * (../../../../AGENTS.md: an empty result is a claim, not a shrug).
 */

// ---------------------------------------------------------------------------
// Fixtures — invented names throughout.
// ---------------------------------------------------------------------------

const NOW = "2026-01-01T00:00:00.000Z";
const PAST = "2025-01-01T00:00:00.000Z";
const FUTURE = "2027-01-01T00:00:00.000Z";

const CONSTRAINT = { sourceTag: "scope-invented", onlyDependOnLibsWithTags: ["scope-shared"] };

function violation(overrides = {}) {
  return {
    sourceFile: "libs/alpha/src/service.go",
    line: 10,
    column: 3,
    specifier: "example.invalid/acme/beta",
    kind: "static",
    messageId: "onlyTagsConstraintViolation",
    message: "rendered elsewhere",
    sourceProject: "acme-alpha",
    targetProject: "acme-beta",
    constraint: CONSTRAINT,
    data: {},
    ...overrides,
  };
}

function unresolvableRecord(overrides = {}) {
  return {
    sourceFile: "libs/alpha/src/loader.ts",
    line: 4,
    column: 1,
    specifier: "@acme/phantom",
    kind: "static",
    spelling: { path: false, relative: false, namesOnly: false },
    resolved: null,
    ...overrides,
  };
}

function totalOf(buckets) {
  return (
    buckets.introduced.length +
    buckets.resolved.length +
    buckets.unchanged.length +
    buckets.unknown.length
  );
}

// ---------------------------------------------------------------------------
// violationIdentity
// ---------------------------------------------------------------------------

describe("violationIdentity", () => {
  /**
   * Narrows to the ok arm, failing loudly on a refusal — a refusal reaching
   * an identity assertion must name itself, never read as a passed check.
   *
   * @param {ReturnType<typeof violationIdentity>} result
   */
  function stated(result) {
    if (result.ok === false) {
      throw new Error(`expected a stated identity, got a refusal: ${result.reason}`);
    }
    return result;
  }

  /**
   * Narrows to the refusal arm, failing loudly on a stated identity.
   *
   * @param {ReturnType<typeof violationIdentity>} result
   */
  function refused(result) {
    if (result.ok === true) throw new Error("expected a refusal, got a stated identity");
    return result;
  }

  it("states an identity from messageId, projects, and constraint", () => {
    const result = stated(violationIdentity(violation()));
    expect(result.identity).toEqual({
      messageId: "onlyTagsConstraintViolation",
      sourceProject: "acme-alpha",
      target: "acme-beta",
      targetIsSpecifier: false,
      constraint: CONSTRAINT,
    });
  });

  it("falls back to the specifier as target when no project target exists", () => {
    const result = stated(violationIdentity(violation({ targetProject: null })));
    expect(result.identity.target).toBe("example.invalid/acme/beta");
    expect(result.identity.targetIsSpecifier).toBe(true);
  });

  it("keys the constraint structurally, not referentially", () => {
    const a = stated(violationIdentity(violation({ constraint: { x: 1, y: 2 } })));
    const b = stated(violationIdentity(violation({ constraint: { y: 2, x: 1 } })));
    expect(a.key).toBe(b.key);
  });

  it("refuses a violation with no usable messageId, with a reason", () => {
    const result = refused(violationIdentity(violation({ messageId: undefined })));
    expect(result.reason).toMatch(/no usable messageId/);
  });

  it("refuses a violation naming neither a target project nor a specifier", () => {
    const result = refused(violationIdentity(violation({ targetProject: null, specifier: "" })));
    expect(result.reason).toMatch(/neither a target project nor a specifier/);
  });

  it("refuses a non-object violation, with a reason", () => {
    const result = refused(violationIdentity(null));
    expect(result.reason).toMatch(/null/);
  });

  // The refusal names a primitive BARELY — `typeof` alone, no JSON dump. This
  // module's describer is deliberately not the package-wide one
  // (`../values.mjs`), whose rendering of the same input is
  // `number (42)`; the two sentences must not converge silently, so the exact
  // string is pinned.
  it("names a non-object violation by its bare type, without a dump", () => {
    expect(refused(violationIdentity(42)).reason).toBe("violation is number, not an object");
    expect(refused(violationIdentity("x")).reason).toBe("violation is string, not an object");
  });
});

// ---------------------------------------------------------------------------
// classifyViolations — the four buckets
// ---------------------------------------------------------------------------

describe("classifyViolations", () => {
  it("classifies a head-only violation as introduced, absent everywhere else", () => {
    const result = classifyViolations({ base: [], head: [violation()], now: NOW });
    expect(result.introduced).toHaveLength(1);
    expect(result.introduced[0].reason).toBe("absent at base");
    expect(result.introduced[0].headSites).toHaveLength(1);
    expect(result.resolved).toHaveLength(0);
    expect(result.unchanged).toHaveLength(0);
    expect(result.unknown).toHaveLength(0);
  });

  it("classifies a base-only violation as resolved", () => {
    const result = classifyViolations({ base: [violation()], head: [], now: NOW });
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].baseCount).toBe(1);
    expect(result.resolved[0].headCount).toBe(0);
    expect(result.introduced).toHaveLength(0);
    expect(result.unchanged).toHaveLength(0);
  });

  it("classifies equal occurrence counts as unchanged — the policy-tightening shape", () => {
    // Both sides were re-judged under ONE current law, so a violation a policy
    // edit condemned on both sides is the same identity twice: unchanged,
    // never a fabricated "introduced".
    const result = classifyViolations({ base: [violation()], head: [violation()], now: NOW });
    expect(result.unchanged).toHaveLength(1);
    expect(result.introduced).toHaveLength(0);
    expect(result.resolved).toHaveLength(0);
  });

  it("counts duplicate sites in one file as a multiset of 2", () => {
    const twice = [violation({ line: 10 }), violation({ line: 20 })];
    const result = classifyViolations({ base: [], head: twice, now: NOW });
    expect(result.introduced).toHaveLength(1);
    expect(result.introduced[0].headCount).toBe(2);
    expect(result.introduced[0].headSites.map((s) => s.line)).toEqual([10, 20]);
  });

  it("classifies occurrence growth as introduced, with a reason naming both counts", () => {
    const result = classifyViolations({
      base: [violation()],
      head: [violation({ line: 10 }), violation({ line: 20 })],
      now: NOW,
    });
    expect(result.introduced).toHaveLength(1);
    expect(result.introduced[0].reason).toBe("occurrence growth: 1 at base, 2 at head");
    expect(result.unchanged).toHaveLength(0);
  });

  it("classifies a shrink that leaves occurrences as unchanged — NEVER resolved", () => {
    const result = classifyViolations({
      base: [violation({ line: 10 }), violation({ line: 20 })],
      head: [violation({ line: 10 })],
      now: NOW,
    });
    // The silent direction this case exists for: a partial fix reading as a
    // clean boundary. The identity must be absent from `resolved`.
    expect(result.resolved).toHaveLength(0);
    expect(result.unchanged).toHaveLength(1);
    expect(result.unchanged[0].note).toMatch(/occurrencesReduced: 2 at base, 1 at head/);
    expect(result.unchanged[0].headCount).toBe(1);
  });

  it("ignores the file in identity: a renamed file with the same import is unchanged", () => {
    const result = classifyViolations({
      base: [violation({ sourceFile: "libs/alpha/src/old-name.go" })],
      head: [violation({ sourceFile: "libs/alpha/src/new-name.go" })],
      now: NOW,
    });
    expect(result.unchanged).toHaveLength(1);
    expect(result.introduced).toHaveLength(0);
    expect(result.resolved).toHaveLength(0);
  });

  it("never guesses a project rename: it becomes a loud introduced+resolved pair", () => {
    const result = classifyViolations({
      base: [violation({ sourceProject: "acme-old" })],
      head: [violation({ sourceProject: "acme-new" })],
      now: NOW,
    });
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].sourceProject).toBe("acme-old");
    expect(result.introduced).toHaveLength(1);
    expect(result.introduced[0].sourceProject).toBe("acme-new");
    expect(result.unchanged).toHaveLength(0);
  });

  it("splits identities when a different constraint row condemns the same edge", () => {
    const result = classifyViolations({
      base: [violation()],
      head: [
        violation({
          constraint: { sourceTag: "scope-invented", notDependOnLibsWithTags: ["scope-sealed"] },
        }),
      ],
      now: NOW,
    });
    expect(result.resolved).toHaveLength(1);
    expect(result.introduced).toHaveLength(1);
  });

  it("classifies an unidentifiable violation as unknown, never dropping it", () => {
    const bad = violation({ messageId: undefined });
    const result = classifyViolations({ base: [], head: [violation(), bad], now: NOW });
    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0].reason).toMatch(/no usable messageId/);
    expect(result.unknown[0].violation).toBe(bad);
    // Nothing vanished: both inputs are accounted for across the buckets.
    expect(totalOf(result)).toBe(2);
  });

  it("classifies a violation with neither target nor specifier as unknown with that reason", () => {
    const bad = violation({ targetProject: null, specifier: "" });
    const result = classifyViolations({ base: [bad], head: [], now: NOW });
    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0].reason).toMatch(/neither a target project nor a specifier/);
    expect(totalOf(result)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// classifyViolations — waiver annotation, never filtering
// ---------------------------------------------------------------------------

describe("classifyViolations waiver annotation", () => {
  it("keeps a suppressed NEW violation in introduced, annotated waived:true", () => {
    // The invisibility case: a wide glob covers the new violation, and a
    // classifier that FILTERED on it would show nothing at all. The entry
    // must exist AND carry the annotation.
    const row = { path: "**", reason: "invented blanket acceptance" };
    const result = classifyViolations({
      base: [],
      head: [violation()],
      suppressions: [row],
      now: NOW,
    });
    expect(result.introduced).toHaveLength(1);
    expect(result.introduced[0].waived).toBe(true);
    expect(result.introduced[0].waivedBy).toBe(row);
  });

  it("annotates waived:true with waivedBy under an ACTIVE waiver", () => {
    const row = { path: "libs/alpha/**", reason: "invented term", expiresAt: FUTURE };
    const result = classifyViolations({
      base: [violation()],
      head: [violation()],
      suppressions: [row],
      now: NOW,
    });
    expect(result.unchanged).toHaveLength(1);
    expect(result.unchanged[0].waived).toBe(true);
    expect(result.unchanged[0].waivedBy).toBe(row);
  });

  it("annotates waived:false under an EXPIRED waiver — it covers nothing", () => {
    const row = { path: "libs/alpha/**", reason: "invented term", expiresAt: PAST };
    const result = classifyViolations({
      base: [violation()],
      head: [violation()],
      suppressions: [row],
      now: NOW,
    });
    expect(result.unchanged).toHaveLength(1);
    expect(result.unchanged[0].waived).toBe(false);
    // Annotation, never filtering: the entry itself is still present.
    expect("waivedBy" in result.unchanged[0]).toBe(false);
  });

  it("annotates waived:false when the glob does not cover the site", () => {
    const row = { path: "libs/beta/**", reason: "invented other place" };
    const result = classifyViolations({
      base: [],
      head: [violation()],
      suppressions: [row],
      now: NOW,
    });
    expect(result.introduced[0].waived).toBe(false);
  });

  it("annotates waived:false when the row names a different messageId", () => {
    const row = { path: "**", messageId: "noImportsOfApps", reason: "invented narrow row" };
    const result = classifyViolations({
      base: [],
      head: [violation()],
      suppressions: [row],
      now: NOW,
    });
    expect(result.introduced[0].waived).toBe(false);
  });

  it("judges a resolved entry's waive status against its base sites", () => {
    const row = { path: "libs/alpha/**", reason: "invented acceptance" };
    const result = classifyViolations({
      base: [violation()],
      head: [],
      suppressions: [row],
      now: NOW,
    });
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].waived).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// classifyUnresolvableRecords — the records' OWN category
// ---------------------------------------------------------------------------

describe("classifyUnresolvableRecords", () => {
  it("considers only records whose analysis did not resolve", () => {
    const resolvedRecord = unresolvableRecord({
      resolved: { target: "acme-beta", file: null, external: false, packageName: null },
    });
    const result = classifyUnresolvableRecords({ base: [resolvedRecord], head: [resolvedRecord] });
    expect(totalOf(result)).toBe(0);
  });

  it("classifies introduced / resolved / unchanged by specifier and kind", () => {
    const stays = unresolvableRecord({ specifier: "@acme/stays" });
    const goes = unresolvableRecord({ specifier: "@acme/goes" });
    const arrives = unresolvableRecord({ specifier: "@acme/arrives" });
    const result = classifyUnresolvableRecords({
      base: [stays, goes],
      head: [stays, arrives],
    });
    expect(result.introduced.map((e) => e.specifier)).toEqual(["@acme/arrives"]);
    expect(result.resolved.map((e) => e.specifier)).toEqual(["@acme/goes"]);
    expect(result.unchanged.map((e) => e.specifier)).toEqual(["@acme/stays"]);
    expect(result.unknown).toHaveLength(0);
  });

  it("keeps static and dynamic imports of one specifier as two identities", () => {
    const result = classifyUnresolvableRecords({
      base: [unresolvableRecord({ kind: "static" })],
      head: [unresolvableRecord({ kind: "dynamic" })],
    });
    expect(result.resolved.map((e) => e.kind)).toEqual(["static"]);
    expect(result.introduced.map((e) => e.kind)).toEqual(["dynamic"]);
  });

  it("classifies a shrink that leaves sites as unchanged with a note, never resolved", () => {
    const result = classifyUnresolvableRecords({
      base: [unresolvableRecord({ line: 4 }), unresolvableRecord({ line: 8 })],
      head: [unresolvableRecord({ line: 4 })],
    });
    expect(result.resolved).toHaveLength(0);
    expect(result.unchanged).toHaveLength(1);
    expect(result.unchanged[0].note).toMatch(/occurrencesReduced: 2 at base, 1 at head/);
  });

  it("separates one specifier in two projects when sourceProjectOf attributes", () => {
    const inAlpha = unresolvableRecord({ sourceFile: "libs/alpha/src/loader.ts" });
    const inBeta = unresolvableRecord({ sourceFile: "libs/beta/src/loader.ts" });
    const sourceProjectOf = (record) =>
      record.sourceFile.startsWith("libs/alpha/") ? "acme-alpha" : "acme-beta";
    const result = classifyUnresolvableRecords({
      base: [inAlpha],
      head: [inAlpha, inBeta],
      sourceProjectOf,
    });
    // Without attribution the two files would merge into one unchanged
    // identity and beta's new site would vanish — the silent shape.
    expect(result.introduced).toHaveLength(1);
    expect(result.introduced[0].sourceProject).toBe("acme-beta");
    expect(result.unchanged).toHaveLength(1);
    expect(result.unchanged[0].sourceProject).toBe("acme-alpha");
  });

  it("classifies a record with no specifier as unknown, never dropping it", () => {
    const bad = unresolvableRecord({ specifier: "" });
    const result = classifyUnresolvableRecords({ base: [], head: [unresolvableRecord(), bad] });
    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0].reason).toMatch(/no usable specifier/);
    expect(result.unknown[0].record).toBe(bad);
    expect(totalOf(result)).toBe(2);
  });

  it("classifies a record whose attribution throws as unknown with the cause", () => {
    const result = classifyUnresolvableRecords({
      base: [],
      head: [unresolvableRecord()],
      sourceProjectOf: () => {
        throw new Error("invented attribution failure");
      },
    });
    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0].reason).toMatch(/invented attribution failure/);
    expect(totalOf(result)).toBe(1);
  });

  it("never annotates waivers — an unresolvable record has no verdict to cover", () => {
    const result = classifyUnresolvableRecords({ base: [], head: [unresolvableRecord()] });
    expect(result.introduced).toHaveLength(1);
    expect("waived" in result.introduced[0]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyDelta — wiring both classifications
// ---------------------------------------------------------------------------

describe("classifyDelta", () => {
  it("returns both blocks, each classified over its own evidence", () => {
    const row = { path: "**", reason: "invented blanket acceptance" };
    const result = classifyDelta({
      baseViolations: [],
      headViolations: [violation()],
      baseRecords: [unresolvableRecord({ specifier: "@acme/goes" })],
      headRecords: [unresolvableRecord({ specifier: "@acme/arrives" })],
      suppressions: [row],
      now: NOW,
      sourceProjectOf: () => "acme-alpha",
    });
    expect(result.violations.introduced).toHaveLength(1);
    // The suppressions and the shared now reached the violation side…
    expect(result.violations.introduced[0].waived).toBe(true);
    // …and the attribution reached the record side.
    expect(result.unresolvable.introduced[0].sourceProject).toBe("acme-alpha");
    expect(result.unresolvable.resolved.map((e) => e.specifier)).toEqual(["@acme/goes"]);
  });

  it("runs without the optional inputs, defaulting to no annotation and no attribution", () => {
    const result = classifyDelta({
      baseViolations: [violation()],
      headViolations: [violation()],
      baseRecords: [],
      headRecords: [unresolvableRecord()],
    });
    expect(result.violations.unchanged).toHaveLength(1);
    expect(result.violations.unchanged[0].waived).toBe(false);
    expect(result.unresolvable.introduced[0].sourceProject).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// classifyCustomFindings
// ---------------------------------------------------------------------------

/** One custom finding as a rule's verdict document states it. */
function customFinding(overrides = {}) {
  return {
    id: "reached-ring",
    message: "the app layer reached a ring internal",
    sourceFile: "libs/app/main.go",
    line: 7,
    column: 2,
    project: "acme-app",
    ...overrides,
  };
}

/** A judged two-sided rule entry, as customRulesForDelta returns one. */
function judgedRule({ base = [], head = [] } = {}) {
  return { name: "no-app-to-ring", sha256: "a".repeat(64), baseFindings: base, headFindings: head };
}

describe("classifyCustomFindings", () => {
  it("classifies a head-only finding introduced and a base-only one resolved — neither vanishes", () => {
    const result = classifyCustomFindings({
      judged: [
        judgedRule({
          base: [customFinding({ id: "old-reach" })],
          head: [customFinding()],
        }),
      ],
    });
    expect(result.introduced).toHaveLength(1);
    expect(result.introduced[0]).toMatchObject({
      rule: "no-app-to-ring",
      findingId: "reached-ring",
      ruleId: "custom/no-app-to-ring/reached-ring",
      project: "acme-app",
      baseCount: 0,
      headCount: 1,
      reason: "absent at base",
    });
    expect(result.introduced[0].headSites).toEqual([
      { file: "libs/app/main.go", line: 7, column: 2 },
    ]);
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].findingId).toBe("old-reach");
    expect(result.unchanged).toEqual([]);
    expect(result.unknown).toEqual([]);
  });

  it("classifies equal counts unchanged and growth introduced with the reason named", () => {
    const result = classifyCustomFindings({
      judged: [
        judgedRule({
          base: [customFinding()],
          head: [customFinding(), customFinding({ line: 20 })],
        }),
      ],
    });
    expect(result.introduced).toHaveLength(1);
    expect(result.introduced[0].reason).toBe("occurrence growth: 1 at base, 2 at head");
  });

  it("keeps a shrunk-but-present finding unchanged — a partial fix never reads as resolved", () => {
    // The silent direction: two occurrences down to one must NOT land in
    // resolved, where the remaining finding would read as a clean rule.
    const result = classifyCustomFindings({
      judged: [
        judgedRule({
          base: [customFinding(), customFinding({ line: 20 })],
          head: [customFinding()],
        }),
      ],
    });
    expect(result.resolved).toEqual([]);
    expect(result.unchanged).toHaveLength(1);
    expect(result.unchanged[0].note).toMatch(/occurrencesReduced: 2 at base, 1 at head/u);
  });

  it("keeps the same finding id in two projects as two identities, never merged", () => {
    const result = classifyCustomFindings({
      judged: [
        judgedRule({
          base: [customFinding({ project: "acme-app" })],
          head: [customFinding({ project: "acme-admin" })],
        }),
      ],
    });
    // A cross-project move is a loud introduced/resolved pair — the same
    // no-rename-guessing posture the violation classifier takes.
    expect(result.introduced).toHaveLength(1);
    expect(result.introduced[0].project).toBe("acme-admin");
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].project).toBe("acme-app");
  });

  it("keys a finding naming no project on null rather than dropping it", () => {
    const result = classifyCustomFindings({
      judged: [
        judgedRule({ head: [customFinding({ project: undefined, sourceFile: undefined })] }),
      ],
    });
    expect(result.introduced).toHaveLength(1);
    expect(result.introduced[0].project).toBeNull();
  });

  it("routes a finding with no usable id to unknown with a reason — never guessed into a bucket", () => {
    // The silent direction: an id-less finding that simply vanished would
    // make this delta byte-identical to one where the rule reported nothing.
    const result = classifyCustomFindings({
      judged: [judgedRule({ head: [customFinding({ id: "" })] })],
    });
    expect(result.introduced).toEqual([]);
    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0]).toMatchObject({ classification: "unknown", rule: "no-app-to-ring" });
    expect(result.unknown[0].reason).toContain("no usable id");
  });

  it("notes on every classified entry of a rule that a no-id finding fell out of its grouping", () => {
    // The silent direction: a no-id finding drops out of the grouping, so its
    // identical counterpart on the other side reads introduced or resolved
    // with nothing to match against. The unknown entry keeps the exit loud;
    // the classified entries must SAY the grouping may be incomplete rather
    // than presenting their buckets as a full account of the rule.
    const result = classifyCustomFindings({
      judged: [
        judgedRule({
          base: [customFinding(), customFinding({ id: "" })],
          head: [customFinding(), customFinding({ id: "second-reach" })],
        }),
      ],
    });
    expect(result.unknown).toHaveLength(1);
    expect(result.unchanged[0].note).toContain(
      "classification for this rule may be incomplete: 1 finding had no usable id",
    );
    expect(result.introduced[0].note).toContain("may be incomplete");
  });

  it("extends an existing occurrence note rather than overwriting it", () => {
    const result = classifyCustomFindings({
      judged: [
        judgedRule({
          base: [customFinding(), customFinding({ line: 20 }), customFinding({ id: null })],
          head: [customFinding()],
        }),
      ],
    });
    expect(result.unchanged[0].note).toMatch(/occurrencesReduced: 2 at base, 1 at head/u);
    expect(result.unchanged[0].note).toContain("may be incomplete: 1 finding had no usable id");
  });

  it("scopes the incomplete-classification note to the rule that produced the no-id finding", () => {
    const result = classifyCustomFindings({
      judged: [
        judgedRule({ base: [customFinding({ id: "" })], head: [customFinding()] }),
        { ...judgedRule({ head: [customFinding()] }), name: "clean-rule" },
      ],
    });
    const cleanEntry = result.introduced.find((entry) => entry.rule === "clean-rule");
    const noisyEntry = result.introduced.find((entry) => entry.rule === "no-app-to-ring");
    expect(noisyEntry.note).toContain("may be incomplete");
    expect("note" in cleanEntry).toBe(false);
  });

  it("turns every unknownRules entry into one unknown entry carrying its reason", () => {
    const result = classifyCustomFindings({
      judged: [],
      unknownRules: [{ name: "drifted-rule", reason: "the law itself moved" }],
    });
    expect(result.unknown).toEqual([
      { classification: "unknown", rule: "drifted-rule", reason: "the law itself moved" },
    ]);
  });

  it("attaches NO waived annotation — suppressions key on messageIds custom findings lack", () => {
    const result = classifyCustomFindings({ judged: [judgedRule({ head: [customFinding()] })] });
    expect("waived" in result.introduced[0]).toBe(false);
  });
});
