import { describe, expect, it } from "vitest";

import {
  findBoundaryConfigViolations,
  loadBoundaryConfigFile,
  policyKeyViolations,
  suppressionCovers,
} from "./config.mjs";
import { MAX_GLOB_EXPANSIONS } from "./rules/match.mjs";

/**
 * Thirteen sequential two-way brace groups — an expansion count of 2**13 =
 * 8192, comfortably past `MAX_GLOB_EXPANSIONS` (512). Before
 * `globComplexityError` existed, handing this straight to
 * `path.posix.matchesGlob` cost around 600ms for ONE call, measured directly
 * against this engine's own copy of it (see `./rules/match.mjs`'s
 * `MAX_GLOB_EXPANSIONS` doc comment for the full measurement).
 */
const bracePattern = () =>
  "x" + Array.from({ length: 13 }, (_, i) => `{a${i},b${i}}`).join("") + "y";

/** A minimal well-formed config; each test bends exactly one thing. */
const wellFormed = () => ({
  depConstraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:util"] }],
  moduleBoundaryOptions: {
    allow: [],
    buildTargets: ["build"],
    enforceBuildableLibDependency: false,
    allowCircularSelfDependency: false,
    checkDynamicDependenciesExceptions: [],
    ignoredCircularDependencies: [],
    banTransitiveDependencies: false,
    checkNestedExternalImports: false,
  },
});

const withOptions = (overrides) => ({
  ...wellFormed(),
  moduleBoundaryOptions: { ...wellFormed().moduleBoundaryOptions, ...overrides },
});

describe("findBoundaryConfigViolations", () => {
  it("accepts a well-formed table and passes every documented row shape", () => {
    expect(findBoundaryConfigViolations(wellFormed())).toEqual([]);
    expect(
      findBoundaryConfigViolations({
        ...wellFormed(),
        depConstraints: [
          { sourceTag: "layer:view", bannedExternalImports: ["@tauri-apps/*"] },
          { allSourceTags: ["scope:shared", "type:lib"], notDependOnLibsWithTags: ["type:app"] },
          { sourceTag: "license:apache", allowedExternalImports: ["*"] },
        ],
      }),
    ).toEqual([]);
  });

  // The failure this exists to catch is not a crash. A row matching no project
  // never errors — it approves every import the workspace makes, quietly.
  it("rejects a row that names no source, because such a row approves everything", () => {
    const violations = findBoundaryConfigViolations({
      ...wellFormed(),
      depConstraints: [{ onlyDependOnLibsWithTags: ["layer:util"] }],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/depConstraints\[0\].*exactly one of 'sourceTag'/s);
  });

  it("rejects a row naming both source forms, which the rule schema cannot read", () => {
    const violations = findBoundaryConfigViolations({
      ...wellFormed(),
      depConstraints: [{ sourceTag: "type:lib", allSourceTags: ["type:lib", "scope:shared"] }],
    });
    expect(violations[0]).toMatch(/exactly one of 'sourceTag' or 'allSourceTags'/);
  });

  it("requires allSourceTags to name at least two tags, since one is the other form", () => {
    const violations = findBoundaryConfigViolations({
      ...wellFormed(),
      depConstraints: [{ allSourceTags: ["type:lib"] }],
    });
    expect(violations[0]).toMatch(/allSourceTags.*at least 2 strings/);
  });

  // A misspelt field is the expensive typo: the rule accepts the row, enforces
  // the half it recognises, and drops the ban entirely.
  it("rejects an unrecognised constraint field instead of silently dropping it", () => {
    const violations = findBoundaryConfigViolations({
      ...wellFormed(),
      depConstraints: [{ sourceTag: "layer:view", bannedExternalImport: ["@tauri-apps/*"] }],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/bannedExternalImport: not a constraint field/);
  });

  it("accepts description and remediation on a constraint row, because they give a rule a name and a fix", () => {
    expect(
      findBoundaryConfigViolations({
        ...wellFormed(),
        depConstraints: [
          {
            sourceTag: "layer:domain",
            notDependOnLibsWithTags: ["layer:infrastructure"],
            description: "Domain isolation",
            remediation: "Depend on an application-owned interface",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("rejects an empty description, because an empty name explains less than none", () => {
    const violations = findBoundaryConfigViolations({
      ...wellFormed(),
      depConstraints: [{ sourceTag: "layer:domain", description: "" }],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/description: must be a non-empty string/);
  });

  it("rejects an empty remediation, because an empty fix is the same as none", () => {
    const violations = findBoundaryConfigViolations({
      ...wellFormed(),
      depConstraints: [{ sourceTag: "layer:domain", remediation: "" }],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/remediation: must be a non-empty string/);
  });

  it("rejects a non-string description or remediation", () => {
    const violations = findBoundaryConfigViolations({
      ...wellFormed(),
      depConstraints: [{ sourceTag: "layer:domain", description: 42, remediation: true }],
    });
    expect(violations).toHaveLength(2);
    expect(violations[0]).toMatch(/description: must be a non-empty string/);
    expect(violations[1]).toMatch(/remediation: must be a non-empty string/);
  });

  it("requires every tag list to hold strings", () => {
    const violations = findBoundaryConfigViolations({
      ...wellFormed(),
      depConstraints: [{ sourceTag: "type:lib", onlyDependOnLibsWithTags: "type:lib" }],
    });
    expect(violations[0]).toMatch(/onlyDependOnLibsWithTags: must be an array of strings/);
  });

  // An empty entry throws nothing and reads like nothing, which is why it
  // survives review: in a tag list it silently never matches, and in `allow` it
  // compiles to a regex that matches every import in the workspace.
  it("rejects an empty entry in any list, naming the entry's own index", () => {
    expect(
      findBoundaryConfigViolations({
        ...wellFormed(),
        depConstraints: [{ sourceTag: "type:lib", onlyDependOnLibsWithTags: ["type:lib", ""] }],
      })[0],
    ).toMatch(/depConstraints\[0\]\.onlyDependOnLibsWithTags\[1\]: must not be empty/);
    expect(findBoundaryConfigViolations(withOptions({ allow: [""] }))[0]).toMatch(
      /moduleBoundaryOptions\.allow\[0\]: must not be empty/,
    );
    expect(
      findBoundaryConfigViolations({
        ...wellFormed(),
        depConstraints: [{ allSourceTags: ["type:lib", ""] }],
      })[0],
    ).toMatch(/allSourceTags\[1\]: must not be empty/);
  });

  // Every one of these reaches a `new RegExp` inside a matcher. Uncaught, the
  // throw arrives from the middle of a run with no idea which row produced it.
  it("rejects a pattern that will not compile, in whichever matcher will build it", () => {
    expect(
      findBoundaryConfigViolations({
        ...wellFormed(),
        depConstraints: [{ sourceTag: "/(unclosed/" }],
      })[0],
    ).toMatch(/depConstraints\[0\]\.sourceTag: '\/\(unclosed\/' is not a valid tag pattern/);
    expect(
      findBoundaryConfigViolations({
        ...wellFormed(),
        depConstraints: [{ sourceTag: "type:lib", bannedExternalImports: ["[unclosed"] }],
      })[0],
    ).toMatch(/bannedExternalImports\[0\]: '\[unclosed' is not a valid import glob/);
    expect(findBoundaryConfigViolations(withOptions({ allow: ["@scope/(pkg"] }))[0]).toMatch(
      /allow\[0\]: '@scope\/\(pkg' is not a valid import pattern/,
    );
  });

  // Nx expands these with minimatch; this workspace's second enforcer cannot,
  // and an ignore list that expands to almost the right set hides real cycles.
  it("rejects an ignored-cycle pattern whose expansion cannot be reproduced exactly", () => {
    expect(
      findBoundaryConfigViolations(
        withOptions({ ignoredCircularDependencies: [["libs/*", "b"]] }),
      )[0],
    ).toMatch(/ignoredCircularDependencies\[0\]\[0\]: 'libs\/\*' uses glob syntax/);
    expect(
      findBoundaryConfigViolations(
        withOptions({ ignoredCircularDependencies: [["tag:zone:x", "*"]] }),
      ),
    ).toEqual([]);
  });

  it("reports the index of every bad row, so a long table names its offenders", () => {
    const violations = findBoundaryConfigViolations({
      ...wellFormed(),
      depConstraints: [{ sourceTag: "type:lib" }, {}, "type:app"],
    });
    expect(violations.some((v) => v.startsWith("depConstraints[1]"))).toBe(true);
    expect(violations.some((v) => v.startsWith("depConstraints[2]"))).toBe(true);
    expect(violations.some((v) => v.startsWith("depConstraints[0]"))).toBe(false);
  });

  it("rejects a table that is not an array", () => {
    expect(findBoundaryConfigViolations({ ...wellFormed(), depConstraints: undefined })[0]).toMatch(
      /depConstraints: must be an exported array/,
    );
  });

  // Defaulting a missing option would put a second copy of its value here, and
  // the two would answer differently the day the config changed.
  it("rejects a missing option rather than substituting a value of its own", () => {
    const config = wellFormed();
    delete config.moduleBoundaryOptions.banTransitiveDependencies;
    expect(findBoundaryConfigViolations(config)).toEqual([
      "moduleBoundaryOptions.banTransitiveDependencies: missing — every option is stated explicitly",
    ]);
  });

  it("holds each option to its own type", () => {
    expect(
      findBoundaryConfigViolations(withOptions({ banTransitiveDependencies: "false" }))[0],
    ).toMatch(/banTransitiveDependencies: must be boolean/);
    expect(findBoundaryConfigViolations(withOptions({ buildTargets: "build" }))[0]).toMatch(
      /buildTargets: must be string\[\]/,
    );
    expect(
      findBoundaryConfigViolations(
        withOptions({ ignoredCircularDependencies: [["a", "b", "c"]] }),
      )[0],
    ).toMatch(/ignoredCircularDependencies: must be pair\[\]/);
    expect(
      findBoundaryConfigViolations(withOptions({ ignoredCircularDependencies: [["a", "b"]] })),
    ).toEqual([]);
  });

  // B-F20/D-15: `hasBuildExecutor` compares `buildTargets` entries to a
  // project's declared targets with `===`, so a glob entry (`"build:*"`) can
  // never match any target. It used to load exit-0 and silently select
  // nothing — the exact silent direction this file exists to end. Now it is
  // refused at load, naming the entry and explaining exact-match semantics.
  it("rejects a buildTargets entry carrying glob syntax — a pattern can never match an exact target name", () => {
    expect(findBoundaryConfigViolations(withOptions({ buildTargets: ["build:*"] }))[0]).toMatch(
      /moduleBoundaryOptions\.buildTargets\[0\]: 'build:\*' is a glob, but buildTargets/,
    );
    expect(findBoundaryConfigViolations(withOptions({ buildTargets: ["*"] }))[0]).toMatch(
      /moduleBoundaryOptions\.buildTargets\[0\]: '\*' is a glob/,
    );
  });

  it("still accepts exact buildTargets names — the documented exact-match semantics", () => {
    expect(
      findBoundaryConfigViolations(withOptions({ buildTargets: ["build", "bundle"] })),
    ).toEqual([]);
  });

  // Two ends of the same shared table, through this face: a lone `(` is
  // refused exactly like `*` because the refusal is per character, and a
  // backslash is admitted because the table does not carry it — the same
  // asymmetry `../rules/match.test.mjs` pins for `projectPatternError`, read
  // here through the `GLOB_METACHARACTERS` re-export in `../config.mjs`.
  it("refuses a parenthesised buildTargets entry and admits a backslashed one", () => {
    expect(findBoundaryConfigViolations(withOptions({ buildTargets: ["a(b"] }))[0]).toMatch(
      /moduleBoundaryOptions\.buildTargets\[0\]: 'a\(b' is a glob/,
    );
    expect(findBoundaryConfigViolations(withOptions({ buildTargets: ["a\\b"] }))).toEqual([]);
  });

  it("rejects an option the rule does not have, which would otherwise read as configured", () => {
    expect(
      findBoundaryConfigViolations(withOptions({ enforceBuildableLibDependencies: true }))[0],
    ).toMatch(/enforceBuildableLibDependencies: not an option/);
  });

  it("rejects anything that is not a module object", () => {
    expect(findBoundaryConfigViolations(null)[0]).toMatch(/expected a module object/);
    expect(findBoundaryConfigViolations([])[0]).toMatch(/expected a module object/);
  });

  it("rejects an options export that is not an object", () => {
    expect(findBoundaryConfigViolations({ ...wellFormed(), moduleBoundaryOptions: [] })[0]).toMatch(
      /moduleBoundaryOptions: must be an exported object/,
    );
  });
});

describe("findBoundaryConfigViolations — the governance block (Contract 2)", () => {
  it("accepts a constraint row carrying the full governance block when the binding is declared", () => {
    expect(
      findBoundaryConfigViolations({
        ...wellFormed(),
        fitness: [
          {
            name: "hotspot",
            match: ["*"],
            condition: { type: "coverage-minimum", statement: 100 },
            reason: "measured",
          },
        ],
        depConstraints: [
          {
            sourceTag: "layer:domain",
            onlyDependOnLibsWithTags: ["layer:util"],
            origin: { by: "jane@example.com", tool: "archkeep:v1" },
            rationale: "the domain must never reach outward",
            decisionRef: "adr:0012",
            fitnessBindings: ["fitness:hotspot"],
          },
        ],
      }),
    ).toEqual([]);
  });

  it("rejects a fitnessBindings entry that names no declared fitness rule (F05)", () => {
    // The F04/F05 reproduction: a row bound to `fitness:hotspot` with no
    // fitness function named `hotspot` declared anywhere in this policy. The
    // resolution half of the governance block (`row-schema.mjs`'s `io.resolve`)
    // was dead until now; a binding that names nothing is a load error, not a
    // silently-verified claim.
    const violations = findBoundaryConfigViolations({
      ...wellFormed(),
      depConstraints: [
        {
          sourceTag: "layer:domain",
          onlyDependOnLibsWithTags: ["layer:util"],
          fitnessBindings: ["fitness:hotspot"],
        },
      ],
    });
    expect(
      violations.some((v) => v.includes("fitnessBindings[0]") && v.includes("does not resolve")),
    ).toBe(true);
  });

  it("accepts a legacy row with no governance block at all — byte-identical parse", () => {
    expect(findBoundaryConfigViolations(wellFormed())).toEqual([]);
  });

  it("names a non-array fitness export instead of throwing a raw TypeError (F05 default io.resolve)", () => {
    // findBoundaryConfigViolations builds its default io.resolve from
    // declaredFitnessNames(module) BEFORE findFitnessViolations validates the
    // `fitness` shape. Before the fix, `({}).map` (an object, not an array)
    // threw "fitness.map is not a function" — a raw, unprefixed TypeError
    // naming no path/key, not the contracted "archkeep: … is malformed:
    // fitness: …" message. The named violation must fire instead, exactly as
    // it does for the correctly-shaped `fitness: ["row"]` case.
    const violations = findBoundaryConfigViolations({ ...wellFormed(), fitness: {} });
    expect(violations.some((v) => v.startsWith("fitness: must be an array of fitness rows"))).toBe(
      true,
    );
  });

  it("names a fitness list holding a non-object row instead of throwing on `.name`", () => {
    // Same default-io.resolve path: `[null].map((row) => row.name)` threw
    // "Cannot read properties of null (reading 'name')" before the fix — a
    // raw TypeError, not the named `fitness[0]: must be an object` violation
    // `findFitnessViolations` is supposed to report.
    const violations = findBoundaryConfigViolations({ ...wellFormed(), fitness: [null] });
    expect(violations.some((v) => v.startsWith("fitness[0]: must be an object"))).toBe(true);
  });

  it("rejects an invalid origin loudly, naming the row", () => {
    const violations = findBoundaryConfigViolations({
      ...wellFormed(),
      depConstraints: [{ sourceTag: "x", onlyDependOnLibsWithTags: ["y"], origin: { tool: "l" } }],
    });
    expect(violations.some((v) => v.startsWith("depConstraints[0].origin.by"))).toBe(true);
  });

  it("accepts an origin carrying a committed `on` — a static file fact needs no clock to read", () => {
    expect(
      findBoundaryConfigViolations({
        ...wellFormed(),
        depConstraints: [
          {
            sourceTag: "x",
            onlyDependOnLibsWithTags: ["y"],
            origin: { by: "jane", tool: "l", on: "2026-08-16" },
          },
        ],
      }),
    ).toEqual([]);
  });

  it("rejects an empty rationale and an empty fitnessBindings list", () => {
    const violations = findBoundaryConfigViolations({
      ...wellFormed(),
      depConstraints: [
        {
          sourceTag: "x",
          onlyDependOnLibsWithTags: ["y"],
          rationale: "",
          fitnessBindings: [],
        },
      ],
    });
    expect(violations.some((v) => v.includes("rationale: must be a non-empty string"))).toBe(true);
    expect(violations.some((v) => v.includes("fitnessBindings: must not be empty"))).toBe(true);
  });

  it("does not reject a governance key as an unknown constraint field", () => {
    // The unknown-key loop must recognize the four governance keys; before
    // Contract 2 a row carrying `origin` was rejected by name.
    expect(
      findBoundaryConfigViolations({
        ...wellFormed(),
        depConstraints: [
          { sourceTag: "x", onlyDependOnLibsWithTags: ["y"], origin: { by: "j", tool: "l" } },
        ],
      }),
    ).toEqual([]);
  });
});

describe("boundarySuppressions", () => {
  const withSuppressions = (boundarySuppressions) => ({ ...wellFormed(), boundarySuppressions });

  it("accepts a path glob with a reason, with or without a messageId filter", () => {
    expect(
      findBoundaryConfigViolations(
        withSuppressions([
          { path: "area/app/some.config.js", reason: "the loader cannot resolve the alias" },
          {
            path: "area/*/other.config.js",
            messageId: "noRelativeOrAbsoluteImportsAcrossLibraries",
            reason: "same, scoped to the one violation type it draws",
          },
        ]),
      ),
    ).toEqual([]);
  });

  it("treats an absent list as suppressing nothing rather than as a missing option", () => {
    // The eight options are rejected when unstated because a default here would
    // be a second copy of something ESLint also reads. A suppression has no
    // second reader, and an empty one is the answer that cannot hide anything.
    expect(findBoundaryConfigViolations(wellFormed())).toEqual([]);
    expect(findBoundaryConfigViolations(withSuppressions([]))).toEqual([]);
  });

  it("rejects an entry with no reason, which is the whole point of the shape", () => {
    // An unexplained suppression is indistinguishable from a boundary that
    // quietly stopped being enforced, and it is the one that rots: nobody can
    // tell later whether the exemption still applies.
    const violations = findBoundaryConfigViolations(
      withSuppressions([{ path: "area/app/some.config.js" }]),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/boundarySuppressions\[0\]\.reason: must be a non-empty string/);
  });

  it("rejects a reason that is only whitespace, which explains as little as none", () => {
    expect(
      findBoundaryConfigViolations(withSuppressions([{ path: "a.js", reason: "   " }]))[0],
    ).toMatch(/reason: must be a non-empty string/);
  });

  it("rejects a missing or empty path, which would match nothing and read as an exemption", () => {
    expect(findBoundaryConfigViolations(withSuppressions([{ reason: "why" }]))[0]).toMatch(
      /boundarySuppressions\[0\]\.path: must be a non-empty glob/,
    );
    expect(
      findBoundaryConfigViolations(withSuppressions([{ path: "", reason: "why" }]))[0],
    ).toMatch(/path: must be a non-empty glob/);
  });

  // P1-16: a brace-bomb path glob is a denial-of-service, not an ordinary bad
  // pattern — `path.posix.matchesGlob`'s brace-group expansion is
  // combinatorial, and this is the only check standing between a crafted
  // `boundarySuppressions[].path` and a CI run that hangs for minutes.
  it("rejects a path whose brace groups would expand past the cap", () => {
    const violations = findBoundaryConfigViolations(
      withSuppressions([{ path: bracePattern(), reason: "why" }]),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/boundarySuppressions\[0\]\.path:/);
    expect(violations[0]).toMatch(new RegExp(`more than ${MAX_GLOB_EXPANSIONS} brace-driven`));
  });

  it("accepts a real, small brace pattern for a path — a regression guard against over-refusing", () => {
    expect(
      findBoundaryConfigViolations(
        withSuppressions([
          { path: "area/**/*.config.{js,mjs,cjs}", reason: "loader cannot resolve the alias" },
        ]),
      ),
    ).toEqual([]);
  });

  it("rejects a messageId this engine cannot report, which would suppress nothing", () => {
    expect(
      findBoundaryConfigViolations(
        withSuppressions([{ path: "a.js", messageId: "noRelativeImports", reason: "why" }]),
      )[0],
    ).toMatch(/messageId: .* is not a violation type this engine reports/);
  });

  it("rejects a field the shape does not have, usually a misspelling of one it does", () => {
    expect(
      findBoundaryConfigViolations(
        withSuppressions([{ path: "a.js", reason: "why", messageIds: ["x"] }]),
      )[0],
    ).toMatch(/messageIds: not a suppression field/);
  });

  it("rejects an entry that is not an object, and a list that is not an array", () => {
    expect(findBoundaryConfigViolations(withSuppressions(["a.js"]))[0]).toMatch(
      /boundarySuppressions\[0\]: must be an object/,
    );
    expect(findBoundaryConfigViolations(withSuppressions({}))[0]).toMatch(
      /boundarySuppressions: must be an exported array/,
    );
  });

  describe("waiver rows — expiresAt turns a suppression into a waiver", () => {
    it("accepts an expiresAt instant and an origin on the same row as a suppression", () => {
      expect(
        findBoundaryConfigViolations(
          withSuppressions([
            {
              path: "area/app/some.config.js",
              reason: "temporary acceptance while the alias lands",
              expiresAt: "2026-09-01T00:00:00.000Z",
              origin: "ticket-1234",
            },
          ]),
        ),
      ).toEqual([]);
    });

    it("rejects an expiresAt that does not parse as an ISO instant — a term that cannot be read cannot be honoured", () => {
      expect(
        findBoundaryConfigViolations(
          withSuppressions([{ path: "a.js", reason: "why", expiresAt: "not-a-date" }]),
        )[0],
      ).toMatch(/expiresAt: must be a full ISO-8601 instant/);
    });

    it("rejects an empty expiresAt, which would read as permanent", () => {
      expect(
        findBoundaryConfigViolations(
          withSuppressions([{ path: "a.js", reason: "why", expiresAt: "" }]),
        )[0],
      ).toMatch(/expiresAt: must be a full ISO-8601 instant/);
    });

    it("rejects a date-only expiresAt, which is interpreted in the machine's local zone", () => {
      expect(
        findBoundaryConfigViolations(
          withSuppressions([{ path: "a.js", reason: "why", expiresAt: "2026-09-01" }]),
        )[0],
      ).toMatch(/must be a full ISO-8601 instant with an explicit UTC\/offset/);
    });

    it("rejects an epoch-number expiresAt — a waiver that expires immediately", () => {
      expect(
        findBoundaryConfigViolations(
          withSuppressions([{ path: "a.js", reason: "why", expiresAt: "0" }]),
        )[0],
      ).toMatch(/must be a full ISO-8601 instant with an explicit UTC\/offset/);
    });

    it("rejects a TZ-less datetime, which means different things under different TZ environments", () => {
      expect(
        findBoundaryConfigViolations(
          withSuppressions([{ path: "a.js", reason: "why", expiresAt: "2026-09-01 03:00" }]),
        )[0],
      ).toMatch(/must be a full ISO-8601 instant with an explicit UTC\/offset/);
    });

    it("accepts an offset-bearing instant, the same instant under every TZ", () => {
      expect(
        findBoundaryConfigViolations(
          withSuppressions([
            { path: "a.js", reason: "why", expiresAt: "2026-09-01T03:00:00.000+02:00" },
          ]),
        ),
      ).toEqual([]);
    });

    it("rejects a calendar-impossible expiresAt that Date.parse would silently shift — a term that means a different day than written", () => {
      // February (28 days) and September (30 days) both catch roll-over of a
      // day the month cannot hold — the same code path, exercised at two month
      // lengths so a fix that special-cases one length can't fake green.
      for (const expiresAt of ["2026-02-30T00:00:00.000Z", "2026-09-31T00:00:00.000Z"]) {
        expect(
          findBoundaryConfigViolations(
            withSuppressions([{ path: "a.js", reason: "why", expiresAt }]),
          )[0],
        ).toMatch(/silently shifted to another day/);
      }
    });

    it("rejects an hour-out-of-range expiresAt that Date.parse would roll over", () => {
      expect(
        findBoundaryConfigViolations(
          withSuppressions([
            { path: "a.js", reason: "why", expiresAt: "2026-01-01T24:00:00.000Z" },
          ]),
        )[0],
      ).toMatch(/silently shifted to another day/);
    });

    it("rejects an origin that is not a non-empty string", () => {
      expect(
        findBoundaryConfigViolations(
          withSuppressions([{ path: "a.js", reason: "why", origin: "" }]),
        )[0],
      ).toMatch(/origin: must be a non-empty string/);
    });

    it("rejects a misspelled waiver field through the same key check as every other field", () => {
      expect(
        findBoundaryConfigViolations(
          withSuppressions([{ path: "a.js", reason: "why", expireAt: "2026-09-01T00:00:00.000Z" }]),
        )[0],
      ).toMatch(/expireAt: not a suppression field/);
    });
  });
});

describe("customRules — the fifth top-level law", () => {
  /** A row every case below bends exactly one field of. */
  const wellFormedRule = () => ({
    name: "no-interface-outside-domain",
    artifact: "tools/rules/no_interface_outside_domain.wasm",
    sha256: "a".repeat(64),
    reason: "interfaces are the domain's ports; declaring one elsewhere inverts the direction",
  });

  const withCustomRules = (customRules) => ({ ...wellFormed(), customRules });

  it("accepts a well-formed row, with and without the optional params table", () => {
    expect(findBoundaryConfigViolations(withCustomRules([wellFormedRule()]))).toEqual([]);
    expect(
      findBoundaryConfigViolations(
        withCustomRules([
          { ...wellFormedRule(), params: { domainTag: "layer:domain", depth: 2, deny: ["x"] } },
        ]),
      ),
    ).toEqual([]);
  });

  it("treats an absent list as declaring no custom rules, the same as an absent suppression list", () => {
    expect(findBoundaryConfigViolations(wellFormed())).toEqual([]);
  });

  // Unlike `boundarySuppressions`, where `[]` exempts nothing and so cannot
  // hide anything, a `customRules` list is LAW: present but empty reads as a
  // workspace that judges by its own rules while judging by none.
  it("rejects a list that is present but empty, and one that is not an array", () => {
    expect(findBoundaryConfigViolations(withCustomRules([]))).toEqual([
      "customRules: must not be empty — a list present but empty reads as law while judging nothing",
    ]);
    expect(findBoundaryConfigViolations(withCustomRules({}))[0]).toMatch(
      /customRules: must be an array of custom-rule rows/,
    );
  });

  it("names the row index of every malformed row, so a long list points at its offender", () => {
    const violations = findBoundaryConfigViolations(
      withCustomRules([wellFormedRule(), "a-rule", { ...wellFormedRule(), name: "second-rule" }]),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^customRules\[1\]: must be an object, got string/);
  });

  it("rejects a name that is not a usable rule name, naming the field", () => {
    for (const name of [
      "No-Interface",
      "no interface",
      "-leading",
      "trailing-",
      "",
      42,
      undefined,
    ]) {
      const violations = findBoundaryConfigViolations(
        withCustomRules([{ ...wellFormedRule(), name }]),
      );
      expect(violations[0], JSON.stringify(name)).toMatch(
        /^customRules\[0\]\.name: must be a non-empty name of lowercase letters and digits/,
      );
    }
  });

  // A name is a selector rather than a label: it is what the row is identified
  // by — `docs/adr/0002-custom-rules-one-contract.md` keys a custom rule's
  // findings on it — so two rows sharing one leave every later message about
  // "that rule" ambiguous, with no way to tell which row it came from.
  it("rejects two rows declaring the same name, naming the duplicate", () => {
    const violations = findBoundaryConfigViolations(
      withCustomRules([wellFormedRule(), { ...wellFormedRule(), artifact: "tools/rules/b.wasm" }]),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(
      /^customRules\[1\]\.name: "no-interface-outside-domain" is declared more than once/,
    );
  });

  it("rejects a missing or empty artifact, which names no bytes to load at all", () => {
    expect(
      findBoundaryConfigViolations(withCustomRules([{ ...wellFormedRule(), artifact: "" }]))[0],
    ).toMatch(/^customRules\[0\]\.artifact: must be a non-empty workspace-relative path/);
    const row = wellFormedRule();
    delete row.artifact;
    expect(findBoundaryConfigViolations(withCustomRules([row]))[0]).toMatch(
      /^customRules\[0\]\.artifact: must be a non-empty workspace-relative path/,
    );
  });

  // The containment half `./containment.mjs` owns, asked at load: an artifact
  // that resolves outside the tree is law from somewhere a reviewer of this
  // repository never reads.
  it("rejects an artifact that leaves the workspace, in either separator family", () => {
    for (const artifact of ["../x.wasm", "tools/../../x.wasm", "..\\x.wasm"]) {
      expect(
        findBoundaryConfigViolations(withCustomRules([{ ...wellFormedRule(), artifact }]))[0],
        artifact,
      ).toMatch(/^customRules\[0\]\.artifact: .* leaves the workspace/);
    }
  });

  it("rejects an absolute artifact path, POSIX-rooted or drive-rooted", () => {
    // The drive-letter spelling is refused on every platform, not only on
    // Windows: a policy is committed once and read everywhere, so a
    // `C:`-rooted artifact must not read as a directory named `C:` on the
    // POSIX runner that enforces it.
    for (const artifact of ["/etc/rules/x.wasm", "\\rules\\x.wasm", "C:\\rules\\x.wasm"]) {
      expect(
        findBoundaryConfigViolations(withCustomRules([{ ...wellFormedRule(), artifact }]))[0],
        artifact,
      ).toMatch(/^customRules\[0\]\.artifact: .* is absolute/);
    }
  });

  it("accepts an artifact inside the tree, including one reached through a '..' that stays inside", () => {
    for (const artifact of ["x.wasm", "tools/rules/x.wasm", "tools/../tools/rules/x.wasm"]) {
      expect(
        findBoundaryConfigViolations(withCustomRules([{ ...wellFormedRule(), artifact }])),
        artifact,
      ).toEqual([]);
    }
  });

  it("rejects a sha256 that no digest can equal — wrong length, wrong alphabet, or uppercase", () => {
    // Uppercase is refused rather than folded: the hash is compared against
    // `node:crypto`'s own lowercase hex digest, and a loader that lowercased
    // one side would be a second opinion about which bytes were declared.
    for (const sha256 of ["abc", "a".repeat(63), "A".repeat(64), "z".repeat(64), 42, undefined]) {
      expect(
        findBoundaryConfigViolations(withCustomRules([{ ...wellFormedRule(), sha256 }]))[0],
        JSON.stringify(sha256),
      ).toMatch(/^customRules\[0\]\.sha256: must be 64 lowercase hex characters/);
    }
  });

  it("rejects a missing or whitespace-only reason, exactly as a suppression's is rejected", () => {
    const row = wellFormedRule();
    delete row.reason;
    expect(findBoundaryConfigViolations(withCustomRules([row]))[0]).toMatch(
      /^customRules\[0\]\.reason: must be a non-empty string/,
    );
    expect(
      findBoundaryConfigViolations(withCustomRules([{ ...wellFormedRule(), reason: "   " }]))[0],
    ).toMatch(/^customRules\[0\]\.reason: must be a non-empty string/);
  });

  // The silent direction for `params`: `JSON.stringify` drops a function, a
  // symbol and an `undefined` outright and renders NaN as null, so a rule
  // would be judged under parameters that differ from the ones written — with
  // nothing anywhere reporting that they differ.
  it("rejects a params value JSON cannot carry, naming the path to it", () => {
    expect(
      findBoundaryConfigViolations(
        withCustomRules([{ ...wellFormedRule(), params: { deny: () => true } }]),
      )[0],
    ).toMatch(/^customRules\[0\]\.params\.deny: must be JSON data, got function/);
    expect(
      findBoundaryConfigViolations(
        withCustomRules([{ ...wellFormedRule(), params: { limits: { depth: Number.NaN } } }]),
      )[0],
    ).toMatch(/^customRules\[0\]\.params\.limits\.depth: must be a finite number/);
    expect(
      findBoundaryConfigViolations(
        withCustomRules([{ ...wellFormedRule(), params: { tags: ["ok", new Map()] } }]),
      )[0],
    ).toMatch(/^customRules\[0\]\.params\.tags\[1\]: must be JSON data/);
    expect(
      findBoundaryConfigViolations(
        withCustomRules([{ ...wellFormedRule(), params: { deny: undefined } }]),
      )[0],
    ).toMatch(/^customRules\[0\]\.params\.deny: must be JSON data, got undefined/);
  });

  it("rejects a params table that refers back into itself, which has no serialization at all", () => {
    // A cycle is the one unserializable shape that THROWS rather than
    // vanishing, and it would throw from wherever the evidence is built —
    // naming no row. Caught here, by name, like every other row problem.
    const params = { nested: {} };
    params.nested.back = params;
    expect(
      findBoundaryConfigViolations(withCustomRules([{ ...wellFormedRule(), params }]))[0],
    ).toMatch(/^customRules\[0\]\.params\.nested\.back: refers back to a value that contains it/);
  });

  it("rejects params that is not an object at all", () => {
    for (const params of [[], "domainTag", null]) {
      expect(
        findBoundaryConfigViolations(withCustomRules([{ ...wellFormedRule(), params }]))[0],
        JSON.stringify(params),
      ).toMatch(/^customRules\[0\]\.params: must be an object of JSON data when present/);
    }
  });

  // The misspelt-field class, on this row family: a `artefact`/`sha`/`param`
  // typo would otherwise load, carry the half this reader understood, and drop
  // the rest of the declaration.
  it("rejects an unknown row key by name", () => {
    const violations = findBoundaryConfigViolations(
      withCustomRules([{ ...wellFormedRule(), artefact: "tools/rules/x.wasm" }]),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^customRules\[0\]\.artefact: not a custom-rule field/);
    expect(violations[0]).toMatch(/name, artifact, sha256, params, reason/);
  });

  it("accepts the governance block, through the same schema a constraint row uses", () => {
    expect(
      findBoundaryConfigViolations({
        ...wellFormed(),
        fitness: [
          {
            name: "hotspot",
            match: ["*"],
            condition: { type: "coverage-minimum", statement: 100 },
            reason: "measured",
          },
        ],
        customRules: [
          {
            ...wellFormedRule(),
            origin: { by: "jane@example.com", tool: "archkeep:v1" },
            rationale: "the domain owns its ports",
            decisionRef: "adr:0002",
            fitnessBindings: ["fitness:hotspot"],
          },
        ],
      }),
    ).toEqual([]);
  });

  it("rejects a fitnessBindings entry naming no declared fitness rule, as a constraint row does", () => {
    // The resolution half of the governance block, reached through the same
    // `io.resolve` the constraint rows get — a rule that reads as measured
    // while nothing measures it is the silent direction.
    const violations = findBoundaryConfigViolations(
      withCustomRules([{ ...wellFormedRule(), fitnessBindings: ["fitness:hotspot"] }]),
    );
    expect(
      violations.some(
        (v) => v.startsWith("customRules[0].fitnessBindings[0]") && v.includes("does not resolve"),
      ),
    ).toBe(true);
  });

  it("rejects an invalid origin and an empty rationale, naming the row", () => {
    const violations = findBoundaryConfigViolations(
      withCustomRules([{ ...wellFormedRule(), origin: { tool: "l" }, rationale: "" }]),
    );
    expect(violations.some((v) => v.startsWith("customRules[0].origin.by"))).toBe(true);
    expect(violations.some((v) => v.startsWith("customRules[0].rationale"))).toBe(true);
  });

  // The silent-direction case for the top-level name itself, and the reason
  // `policyKeyViolations` reads the `.mjs` dialect's exports too: a misspelt
  // `customRule` export must be refused by name, never ignored as a helper —
  // an ignored law is a law nobody enforces while the policy says otherwise.
  it("refuses a misspelled customRule export by name rather than ignoring it", () => {
    expect(
      policyKeyViolations({ ...wellFormed(), customRule: [] }, { allowSchema: false })[0],
    ).toMatch(/^customRule: not a recognised top-level key/);
    expect(
      policyKeyViolations(withCustomRules([wellFormedRule()]), { allowSchema: false }),
    ).toEqual([]);
  });
});

describe("suppressionCovers", () => {
  const violation = (sourceFile, messageId = "noRelativeOrAbsoluteImportsAcrossLibraries") => ({
    sourceFile,
    messageId,
  });

  it("matches an exact path and a glob over it", () => {
    expect(
      suppressionCovers(
        { path: "area/app/tailwind.config.js" },
        violation("area/app/tailwind.config.js"),
      ),
    ).toBe(true);
    expect(
      suppressionCovers(
        { path: "area/*/tailwind.config.js" },
        violation("area/app/tailwind.config.js"),
      ),
    ).toBe(true);
    expect(
      suppressionCovers({ path: "area/**/*.config.js" }, violation("area/one/two/x.config.js")),
    ).toBe(true);
  });

  it("does not spill onto a neighbouring file the glob does not name", () => {
    // A suppression that covered more than it says is the failure mode: the
    // next file added beside it inherits an exemption nobody decided on.
    expect(
      suppressionCovers(
        { path: "area/app/tailwind.config.js" },
        violation("area/app/vite.config.js"),
      ),
    ).toBe(false);
    expect(
      suppressionCovers(
        { path: "area/*/tailwind.config.js" },
        violation("area/a/b/tailwind.config.js"),
      ),
    ).toBe(false);
  });

  it("covers every violation type when no messageId is named, and only one when it is", () => {
    expect(suppressionCovers({ path: "a.js" }, violation("a.js", "noImportsOfApps"))).toBe(true);
    expect(
      suppressionCovers({ path: "a.js", messageId: "noImportsOfApps" }, violation("a.js")),
    ).toBe(false);
  });

  // Defence in depth for P1-16: `suppressionRowViolations` already refuses a
  // brace-bomb path at config load (see the `boundarySuppressions` describe
  // above), but `suppressionCovers` is the actual call site that would reach
  // `path.posix.matchesGlob` — it must refuse the same pattern on its own,
  // quickly, rather than trust that validation already ran.
  it("throws quickly on a brace-bomb path instead of hanging", () => {
    const start = performance.now();
    expect(() => suppressionCovers({ path: bracePattern() }, violation("x-nomatch-y"))).toThrow(
      /brace-driven alternatives/,
    );
    const elapsed = performance.now() - start;
    // `globComplexityError` refuses this pattern before `safeMatchesGlob`
    // (which `suppressionCovers` now calls) ever reaches the real matcher, so
    // this has no reason to be anywhere near the ~600ms-1.6s this exact
    // pattern cost per call before the guard existed (measured directly, both
    // standalone and inside this suite). Bounded generously against
    // shared-machine scheduling noise, not against this call's own cost.
    expect(elapsed).toBeLessThan(500);
  });
});

describe("policyKeyViolations — the $schema carve-out is accepted AND checked", () => {
  it("accepts a non-empty string $schema when allowSchema is set", () => {
    expect(
      policyKeyViolations({ ...wellFormed(), $schema: "./schema.json" }, { allowSchema: true }),
    ).toEqual([]);
  });

  it("rejects a $schema that is not a non-empty string — accepted is not the same as unchecked", () => {
    expect(policyKeyViolations({ ...wellFormed(), $schema: 42 }, { allowSchema: true })).toEqual([
      "$schema: must be a non-empty string naming the schema the editor should validate against, got number (42)",
    ]);
    expect(policyKeyViolations({ ...wellFormed(), $schema: "" }, { allowSchema: true })[0]).toMatch(
      /\$schema: must be a non-empty string/,
    );
    // A whitespace-only `$schema` states nothing an editor can validate
    // against — the same false-green class as an empty string. Accepted must
    // not mean "any string".
    expect(
      policyKeyViolations({ ...wellFormed(), $schema: "   " }, { allowSchema: true })[0],
    ).toMatch(/\$schema: must be a non-empty string/);
  });

  it("still refuses $schema when allowSchema is off — the .mjs dialect has no editor hook to point it at", () => {
    expect(
      policyKeyViolations({ ...wellFormed(), $schema: "./schema.json" }, { allowSchema: false })[0],
    ).toMatch(/\$schema: not a recognised top-level key/);
  });
});

describe("findBoundaryConfigViolations — the coverage acceptance table", () => {
  // The sixth top-level key: `coverage.unowned` rows record the acceptance of
  // files no project owns (Nx/Moon only — the native refusal is
  // `resolvePolicy`'s and the inline model's, tested beside them). The row
  // semantics copy the native `coverage.exempt` row exactly
  // (`./providers/native/model.mjs`'s `exemptRowViolations`): mandatory
  // reason, unknown keys refused by name, brace-bomb paths refused at load.
  it("accepts a well-formed unowned list, and an empty one — empty accepts nothing, which hides nothing", () => {
    expect(
      findBoundaryConfigViolations({
        ...wellFormed(),
        coverage: { unowned: [{ path: "tools/**", reason: "generated release tooling" }] },
      }),
    ).toEqual([]);
    expect(findBoundaryConfigViolations({ ...wellFormed(), coverage: { unowned: [] } })).toEqual(
      [],
    );
  });

  it("rejects a missing, empty, or whitespace reason, naming the field", () => {
    for (const row of [
      { path: "tools/**" },
      { path: "tools/**", reason: "" },
      { path: "tools/**", reason: "   " },
    ]) {
      expect(
        findBoundaryConfigViolations({ ...wellFormed(), coverage: { unowned: [row] } }),
      ).toEqual([
        expect.stringContaining("coverage.unowned[0].reason: must be a non-empty string"),
      ]);
    }
  });

  it("rejects an unknown key in a row, and an unknown key beside 'unowned', by name", () => {
    expect(
      findBoundaryConfigViolations({
        ...wellFormed(),
        coverage: { unowned: [{ path: "a/**", reason: "vendored", pathes: "typo" }] },
      }),
    ).toEqual([
      expect.stringContaining("coverage.unowned[0].pathes: not a coverage.unowned field"),
    ]);
    // `exempt` is the native spelling of the same decision — a likely paste
    // from `archkeep.json` — so the refusal has to name the one key this
    // table does hold.
    expect(
      findBoundaryConfigViolations({ ...wellFormed(), coverage: { unowned: [], exempt: [] } }),
    ).toEqual([
      expect.stringContaining("coverage.exempt: not a coverage field — expected 'unowned'"),
    ]);
  });

  it("rejects a non-object coverage, a missing unowned, an empty path, and a brace-bomb path", () => {
    expect(findBoundaryConfigViolations({ ...wellFormed(), coverage: [] })[0]).toMatch(
      /coverage: must be an object/,
    );
    expect(findBoundaryConfigViolations({ ...wellFormed(), coverage: {} })[0]).toMatch(
      /coverage\.unowned: must be an array/,
    );
    expect(
      findBoundaryConfigViolations({
        ...wellFormed(),
        coverage: { unowned: [{ path: "", reason: "vendored" }] },
      })[0],
    ).toMatch(/coverage\.unowned\[0\]\.path: must be a non-empty glob/);
    expect(
      findBoundaryConfigViolations({
        ...wellFormed(),
        coverage: { unowned: [{ path: bracePattern(), reason: "vendored" }] },
      })[0],
    ).toMatch(/coverage\.unowned\[0\]\.path: .*expands to more than/);
  });
});

describe("findBoundaryConfigViolations — markdown, the document track", () => {
  // The seventh top-level key: `markdown` reads machine-readable markers out
  // of tracked documents (`./analysis/markdown.mjs`) and turns them into
  // graph edges the existing tag rows judge. The shape law lives here, and it
  // is refused at load for the same reason every other dead shape is: a track
  // that reads nothing judges nothing while reading as enforced.
  const wellFormedMarkdown = () => ({
    include: ["docs/**/*.md"],
    markers: [{ pattern: "^<!-- @api (\\S+) -->$", edge: "resolvedExportOwner" }],
  });

  const withMarkdown = (markdown) => ({ ...wellFormed(), markdown });

  it("accepts a well-formed block and treats an absent one as declaring no document track", () => {
    expect(findBoundaryConfigViolations(withMarkdown(wellFormedMarkdown()))).toEqual([]);
    expect(findBoundaryConfigViolations(wellFormed())).toEqual([]);
  });

  it("accepts several include globs and several marker rows", () => {
    expect(
      findBoundaryConfigViolations(
        withMarkdown({
          include: ["docs/**/*.md", "guide.md"],
          markers: [
            { pattern: "^<!-- @api (\\S+) -->$", edge: "resolvedExportOwner" },
            { pattern: "@see\\s+(\\w+)", edge: "resolvedExportOwner" },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("rejects a non-object markdown", () => {
    expect(findBoundaryConfigViolations(withMarkdown("docs"))).toEqual([
      expect.stringContaining("markdown: must be an object carrying 'include' and 'markers'"),
    ]);
  });

  it("rejects a missing, empty, or non-string include list, naming the entry", () => {
    expect(
      findBoundaryConfigViolations(withMarkdown({ markers: wellFormedMarkdown().markers })),
    ).toEqual([expect.stringMatching(/^markdown\.include: must be a non-empty array/)]);
    expect(
      findBoundaryConfigViolations(withMarkdown({ ...wellFormedMarkdown(), include: [] })),
    ).toEqual([expect.stringMatching(/^markdown\.include: must be a non-empty array/)]);
    expect(
      findBoundaryConfigViolations(withMarkdown({ ...wellFormedMarkdown(), include: [42] })),
    ).toEqual([
      expect.stringMatching(/^markdown\.include\[0\]: must be a non-empty workspace-relative glob/),
    ]);
  });

  it("rejects an absolute include glob, which can never match a workspace-relative path", () => {
    expect(
      findBoundaryConfigViolations(
        withMarkdown({ ...wellFormedMarkdown(), include: ["/docs/**/*.md"] }),
      ),
    ).toEqual([
      expect.stringContaining(
        "markdown.include[0]: '/docs/**/*.md' is an absolute path — an include glob is matched " +
          "against workspace-relative document paths",
      ),
    ]);
  });

  it("rejects a brace-bomb include glob at load, the same family refusal a suppression path gets", () => {
    expect(
      findBoundaryConfigViolations(
        withMarkdown({ ...wellFormedMarkdown(), include: [bracePattern()] }),
      ),
    ).toEqual([expect.stringMatching(/markdown\.include\[0\]: .*expands to more than/)]);
  });

  it("rejects a marker list that is missing, empty, or not an array — a present list is law", () => {
    expect(
      findBoundaryConfigViolations(withMarkdown({ ...wellFormedMarkdown(), markers: [] })),
    ).toEqual([
      expect.stringContaining(
        "markdown.markers: must be a non-empty array of {pattern, edge} rows",
      ),
    ]);
    expect(
      findBoundaryConfigViolations(withMarkdown({ ...wellFormedMarkdown(), markers: "x" })),
    ).toEqual([expect.stringMatching(/^markdown\.markers: must be a non-empty array/)]);
  });

  it("rejects a pattern that does not compile, naming the compile error", () => {
    expect(
      findBoundaryConfigViolations(
        withMarkdown({
          ...wellFormedMarkdown(),
          markers: [{ pattern: "(unclosed", edge: "resolvedExportOwner" }],
        }),
      ),
    ).toEqual([
      expect.stringMatching(
        /^markdown\.markers\[0\]\.pattern: '\(unclosed' is not a valid regular expression under the 'u' flag/,
      ),
    ]);
  });

  it("rejects a pattern with no capture group, which resolves nothing while reading as enforced", () => {
    expect(
      findBoundaryConfigViolations(
        withMarkdown({
          ...wellFormedMarkdown(),
          markers: [{ pattern: "^<!-- @api \\S+ -->$", edge: "resolvedExportOwner" }],
        }),
      ),
    ).toEqual([expect.stringMatching(/^markdown\.markers\[0\]\.pattern: .* has no capture group/)]);
  });

  it("rejects an edge kind this reader cannot draw, naming the one kind it can", () => {
    expect(
      findBoundaryConfigViolations(
        withMarkdown({
          ...wellFormedMarkdown(),
          markers: [{ pattern: "(\\S+)", edge: "static" }],
        }),
      ),
    ).toEqual([
      expect.stringContaining(
        'markdown.markers[0].edge: string ("static") is not an edge kind this reader can draw — ' +
          'expected "resolvedExportOwner"',
      ),
    ]);
  });

  it("rejects unknown keys at the row level and at the block level, by name", () => {
    expect(
      findBoundaryConfigViolations(
        withMarkdown({
          ...wellFormedMarkdown(),
          markers: [{ pattern: "(\\S+)", edge: "resolvedExportOwner", kind: "typo" }],
        }),
      ),
    ).toEqual([
      expect.stringContaining(
        "markdown.markers[0].kind: not a markdown marker field — expected 'pattern' and 'edge'",
      ),
    ]);
    expect(
      findBoundaryConfigViolations(withMarkdown({ ...wellFormedMarkdown(), globs: ["docs/**"] })),
    ).toEqual([
      expect.stringContaining(
        "markdown.globs: not a markdown field — expected 'include' and 'markers'",
      ),
    ]);
  });
});

describe("loadBoundaryConfigFile", () => {
  it("throws on a legacy .eslintrc basename", async () => {
    await expect(loadBoundaryConfigFile("/tmp/.eslintrc.json")).rejects.toThrow(
      /legacy ESLint config/,
    );
  });

  it("throws on an unsupported extension", async () => {
    await expect(loadBoundaryConfigFile("/tmp/config.yaml")).rejects.toThrow(
      /unsupported boundaryConfig extension '\.yaml'/,
    );
  });

  it("throws on a file with no extension", async () => {
    await expect(loadBoundaryConfigFile("/tmp/config")).rejects.toThrow(
      /unsupported boundaryConfig extension '\(none\)'/,
    );
  });

  it("throws on a nonexistent .mjs file", async () => {
    await expect(loadBoundaryConfigFile("/tmp/nonexistent-boundary-config.mjs")).rejects.toThrow(
      /cannot load/,
    );
  });
});
