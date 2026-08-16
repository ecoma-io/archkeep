import { describe, expect, it } from "vitest";

import {
  findBoundaryConfigViolations,
  loadBoundaryConfigFile,
  suppressionCovers,
} from "./config.mjs";

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
  it("accepts a constraint row carrying the full governance block", () => {
    expect(
      findBoundaryConfigViolations({
        ...wellFormed(),
        depConstraints: [
          {
            sourceTag: "layer:domain",
            onlyDependOnLibsWithTags: ["layer:util"],
            origin: { by: "jane@example.com", tool: "lattice:v1" },
            rationale: "the domain must never reach outward",
            decisionRef: "adr:0012",
            fitnessBindings: ["fitness:hotspot"],
          },
        ],
      }),
    ).toEqual([]);
  });

  it("accepts a legacy row with no governance block at all — byte-identical parse", () => {
    expect(findBoundaryConfigViolations(wellFormed())).toEqual([]);
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
