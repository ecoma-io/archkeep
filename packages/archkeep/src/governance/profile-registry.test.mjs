import { describe, expect, it } from "vitest";

import {
  listNames,
  loadProfileRegistry,
  profilePolicy,
  profileReferenceViolations,
  profileRegistryViolations,
  resolveProfile,
} from "./profile-registry.mjs";

/** A minimal well-formed registry; each test bends exactly one thing. */
const wellFormed = () => ({
  profiles: [
    {
      name: "base-domain",
      block: {
        depConstraints: [{ sourceTag: "type:domain", onlyDependOnLibsWithTags: ["type:domain"] }],
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
      },
    },
  ],
});

const fullOptions = (overrides = {}) => ({
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
  ...overrides,
});

describe("profileRegistryViolations", () => {
  it("accepts a well-formed registry", () => {
    expect(profileRegistryViolations(wellFormed())).toEqual([]);
  });

  it("accepts the top-level $-schema and version carve-outs", () => {
    expect(
      profileRegistryViolations({
        ...wellFormed(),
        version: 1,
        $schema: "https://example.com/schema",
      }),
    ).toEqual([]);
  });

  it("defaults an absent version to schema 1 — the version check defaults before it checks (B-F18a)", () => {
    // `version` is a stated fact when present; an absent one means "as of
    // schema 1", the version this reader implements. Before the default was
    // applied and then checked, an absent version was silently unverified and
    // a FUTURE schema-2 file with no version would have loaded as if this
    // reader understood it.
    expect(profileRegistryViolations(wellFormed())).toEqual([]);
  });

  it("accepts a `fitness` block alongside the three original block keys (B-F18b)", () => {
    const violations = profileRegistryViolations({
      profiles: [
        {
          name: "measured",
          block: {
            ...wellFormed().profiles[0].block,
            fitness: [
              {
                name: "coverage",
                match: ["*"],
                condition: { type: "coverage-minimum", statement: 100 },
                reason: "every owned file must be analyzed",
              },
            ],
          },
        },
      ],
    });
    expect(violations).toEqual([]);
  });
  it("rejects a wrong version loudly rather than guessing", () => {
    const violations = profileRegistryViolations({ ...wellFormed(), version: 999 });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/expected 1, got/);
  });

  it("rejects a STATED null version — defaulting must apply only to an absent version", () => {
    // A `version ?? 1` default would silently accept a stated `version: null`
    // as schema 1 — the very silence this check exists to refuse. A stated
    // non-1 value refuses; only an absent one defaults.
    const violations = profileRegistryViolations({ ...wellFormed(), version: null });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/expected 1, got null/);
  });

  it("rejects an unknown top-level key", () => {
    const violations = profileRegistryViolations({ ...wellFormed(), profile: [] });
    expect(violations.some((v) => /not a recognised profiles-file key/.test(v))).toBe(true);
  });

  it("rejects a profile with no name — a rule nobody can refer to", () => {
    const violations = profileRegistryViolations({
      profiles: [{ block: wellFormed().profiles[0].block }],
    });
    expect(violations.some((v) => /profiles\[0\].name.*non-empty string/.test(v))).toBe(true);
  });

  it("rejects a duplicate profile name", () => {
    const violations = profileRegistryViolations({
      profiles: [wellFormed().profiles[0], wellFormed().profiles[0]],
    });
    expect(violations.some((v) => /declared more than once/.test(v))).toBe(true);
  });

  // P1-06 (adversarial hardening audit): the duplicate check above compares
  // the raw string, so before NAME_PATTERN existed a name that read as
  // "strict" but carried a hidden zero-width character or a homoglyph from
  // another script was byte-distinct from a real "strict" — both were
  // accepted as "unique" and `--config strict` then resolved to whichever one
  // exactly matched the operator's literal argument, silently enforcing
  // whatever the OTHER, identical-looking profile declared. This is the
  // silent direction this repository runs on: it used to return `[]` for a
  // registry a human reading it would see as declaring "strict" twice.
  it('rejects a name that reads as "strict" but hides a zero-width character', () => {
    const violations = profileRegistryViolations({
      profiles: [
        { name: "strict", block: wellFormed().profiles[0].block },
        { name: "stri​ct", block: wellFormed().profiles[0].block }, // ZERO WIDTH SPACE
      ],
    });
    expect(violations).not.toEqual([]);
    expect(violations.some((v) => /profiles\[1\].name.*non-empty string/.test(v))).toBe(true);
  });

  it('rejects a name that reads as "strict" but substitutes a Cyrillic homoglyph', () => {
    const violations = profileRegistryViolations({
      profiles: [
        { name: "strict", block: wellFormed().profiles[0].block },
        { name: "striсt", block: wellFormed().profiles[0].block }, // U+0441 CYRILLIC ES
      ],
    });
    expect(violations).not.toEqual([]);
    expect(violations.some((v) => /profiles\[1\].name.*non-empty string/.test(v))).toBe(true);
  });

  it("rejects a profile with no block — parses as an empty policy", () => {
    const violations = profileRegistryViolations({
      profiles: [{ name: "ghost" }],
    });
    expect(violations.some((v) => /profiles\[0\].block.*must be a policy block/.test(v))).toBe(
      true,
    );
  });

  it("rejects a block carrying a key policyFrom does not read", () => {
    const violations = profileRegistryViolations({
      profiles: [{ name: "x", block: { depConstraints: [], moduleBoundaryOptions: {}, nope: 1 } }],
    });
    expect(violations.some((v) => /block\.nope.*not a policy block field/.test(v))).toBe(true);
  });

  it("rejects an empty-string base", () => {
    const violations = profileRegistryViolations({
      profiles: [{ name: "x", base: "", block: wellFormed().profiles[0].block }],
    });
    expect(violations.some((v) => /base.*non-empty string/.test(v))).toBe(true);
  });
});

describe("profileReferenceViolations", () => {
  const base = (name, extra = {}) => ({
    name,
    block: { ...wellFormed().profiles[0].block, depConstraints: [] },
    ...extra,
  });

  it("accepts a chain with no references", () => {
    expect(profileReferenceViolations([base("a")])).toEqual([]);
  });

  it("accepts a valid base chain", () => {
    expect(
      profileReferenceViolations([base("a"), base("b", { base: "a" }), base("c", { base: "b" })]),
    ).toEqual([]);
  });

  // The silent direction this repository runs on: a base named but absent must
  // throw loudly, never read as "no base" (which would shed every inherited row).
  it("throws loudly for a base that names no profile", () => {
    const violations = profileReferenceViolations([base("a", { base: "ghost" })]);
    expect(
      violations.some((v) => /base "ghost" but no profile with that name exists/.test(v)),
    ).toBe(true);
  });

  it("throws loudly for a cycle in the base chain", () => {
    const violations = profileReferenceViolations([
      base("a", { base: "b" }),
      base("b", { base: "a" }),
    ]);
    expect(violations.some((v) => /contains a cycle through/.test(v))).toBe(true);
  });
});

describe("resolveProfile", () => {
  const profiles = (overrides = {}) => [
    {
      name: "base-law",
      block: {
        depConstraints: [{ sourceTag: "type:domain", onlyDependOnLibsWithTags: ["type:domain"] }],
        moduleBoundaryOptions: fullOptions({
          enforceBuildableLibDependency: true,
          allow: ["node:fs"],
        }),
        boundarySuppressions: [{ path: "legacy/**", reason: "legacy accepted" }],
      },
    },
    {
      name: "child-law",
      base: "base-law",
      block: {
        depConstraints: [
          { sourceTag: "type:app", onlyDependOnLibsWithTags: ["type:domain", "type:app"] },
        ],
        // Only the key the child wants to override — a key the child does not
        // state falls through to the base's value unchanged.
        moduleBoundaryOptions: { enforceBuildableLibDependency: false },
        boundarySuppressions: [{ path: "special/**", reason: "special case" }],
      },
    },
    ...(overrides.extra ?? []),
  ];

  it("resolves a profile with no base to its own block", () => {
    const effective = resolveProfile(profiles(), "base-law");
    expect(effective.depConstraints).toHaveLength(1);
    expect(effective.moduleBoundaryOptions.enforceBuildableLibDependency).toBe(true);
    expect(effective.boundarySuppressions).toHaveLength(1);
  });

  // The precedence contract: child depConstraints rows APPEND after base rows,
  // child moduleBoundaryOptions keys OVERWRITE the base's key by key.
  it("appends child depConstraints rows after base rows", () => {
    const effective = resolveProfile(profiles(), "child-law");
    expect(effective.depConstraints.map((r) => r.sourceTag)).toEqual(["type:domain", "type:app"]);
  });

  it("overwrites base moduleBoundaryOptions keys key by key", () => {
    const effective = resolveProfile(profiles(), "child-law");
    expect(effective.moduleBoundaryOptions.enforceBuildableLibDependency).toBe(false);
    // Keys the child does not state fall through to the base's value unchanged.
    expect(effective.moduleBoundaryOptions.allow).toEqual(["node:fs"]);
  });

  it("appends child boundarySuppressions rows after base rows", () => {
    const effective = resolveProfile(profiles(), "child-law");
    expect(effective.boundarySuppressions.map((s) => s.path)).toEqual(["legacy/**", "special/**"]);
  });

  it("appends child fitness rows after base rows — one enforcement path for profiles (B-F18b)", () => {
    const effective = resolveProfile(
      profiles({
        extra: [
          {
            name: "with-fitness",
            block: {
              depConstraints: [],
              moduleBoundaryOptions: fullOptions(),
              fitness: [
                {
                  name: "child-fitness",
                  match: ["*"],
                  condition: { type: "coverage-minimum", statement: 100 },
                  reason: "the child adds its own measure",
                },
              ],
            },
          },
        ],
      }),
      "with-fitness",
    );
    expect(effective.fitness.map((r) => r.name)).toEqual(["child-fitness"]);
  });

  it("resolves a chain of any depth, depth-first, in written order", () => {
    const effective = resolveProfile(
      profiles({
        extra: [
          {
            name: "outer",
            base: "child-law",
            block: {
              depConstraints: [
                { sourceTag: "type:feature", onlyDependOnLibsWithTags: ["type:domain"] },
              ],
              moduleBoundaryOptions: fullOptions(),
              boundarySuppressions: [],
            },
          },
        ],
      }),
      "outer",
    );
    expect(effective.depConstraints.map((r) => r.sourceTag)).toEqual([
      "type:domain",
      "type:app",
      "type:feature",
    ]);
  });

  it("throws loudly for an unknown profile name", () => {
    expect(() => resolveProfile(profiles(), "ghost")).toThrow(/profile "ghost" does not exist/);
  });
});

describe("loadProfileRegistry", () => {
  const treeWith = (files) => ({ readFile: (path) => files[path] ?? null });

  it("throws loudly when the file is missing — never reads as an empty registry", () => {
    expect(() => loadProfileRegistry("/w/profiles.json", treeWith({}))).toThrow(
      /cannot read profiles file/,
    );
  });

  it("parses and validates a registry from a file", () => {
    const registry = loadProfileRegistry(
      "/w/profiles.json",
      treeWith({
        "/w/profiles.json": JSON.stringify(wellFormed()),
      }),
    );
    expect(listNames(registry)).toEqual(["base-domain"]);
  });

  it("throws on malformed JSON with the file named", () => {
    expect(() =>
      loadProfileRegistry("/w/profiles.json", treeWith({ "/w/profiles.json": "{not json" })),
    ).toThrow(/cannot parse profiles file \/w\/profiles\.json/);
  });

  it("throws on a registry defect, naming the file and the row", () => {
    expect(() =>
      loadProfileRegistry(
        "/w/profiles.json",
        treeWith({
          "/w/profiles.json": JSON.stringify({
            profiles: [{ name: "a", base: "ghost", block: wellFormed().profiles[0].block }],
          }),
        }),
      ),
    ).toThrow(/is malformed/);
  });

  // P1-06: reproduces the audit's exact finding end to end, at the loader
  // `../../cli.mjs`'s `check` actually calls. Before NAME_PATTERN, this file
  // loaded successfully — two profiles named "strict" (one with a zero-width
  // space after "stri") were both accepted as unique, so
  // `profilePolicy(path, "strict", …)` deterministically resolved the one
  // whose bytes exactly matched, with nothing ever having surfaced that a
  // second, indistinguishable-looking "strict" existed in the same file.
  it("throws rather than silently loading two profiles whose names are visually indistinguishable", () => {
    expect(() =>
      loadProfileRegistry(
        "/w/profiles.json",
        treeWith({
          "/w/profiles.json": JSON.stringify({
            profiles: [
              { name: "strict", block: wellFormed().profiles[0].block },
              { name: "stri​ct", block: wellFormed().profiles[0].block }, // ZERO WIDTH SPACE
            ],
          }),
        }),
      ),
    ).toThrow(/is malformed/);
  });

  it("honors the injected readFile seam — a counting stub proves the real fs is never reached", () => {
    let calls = 0;
    const io = {
      readFile: (path) => {
        calls++;
        return path.endsWith("profiles.json") ? JSON.stringify(wellFormed()) : null;
      },
    };
    const registry = loadProfileRegistry("/w/profiles.json", io);
    expect(listNames(registry)).toEqual(["base-domain"]);
    expect(calls).toBe(1);
  });
});

describe("profilePolicy", () => {
  const treeWith = (files) => ({ readFile: (path) => files[path] ?? null });
  const registryJson = JSON.stringify({
    profiles: [
      {
        name: "nx-package-law",
        block: {
          depConstraints: [{ sourceTag: "type:domain", onlyDependOnLibsWithTags: ["type:domain"] }],
          moduleBoundaryOptions: fullOptions(),
          boundarySuppressions: [],
        },
      },
    ],
  });

  it("feeds a profile's effective block through the SAME policyFrom tail", () => {
    const policy = profilePolicy(
      "/w/profiles.json",
      "nx-package-law",
      "/w/law",
      treeWith({
        "/w/profiles.json": registryJson,
      }),
    );
    expect(policy).toEqual({
      depConstraints: [{ sourceTag: "type:domain", onlyDependOnLibsWithTags: ["type:domain"] }],
      options: fullOptions(),
      suppressions: [],
    });
  });

  it("throws a policyFrom-class error for a malformed block inside a profile", () => {
    expect(() =>
      profilePolicy(
        "/w/profiles.json",
        "nx-package-law",
        "/w/law",
        treeWith({
          "/w/profiles.json": JSON.stringify({
            profiles: [
              {
                name: "nx-package-law",
                block: { depConstraints: "not-an-array", moduleBoundaryOptions: fullOptions() },
              },
            ],
          }),
        }),
      ),
    ).toThrow(/is malformed/);
  });
});
