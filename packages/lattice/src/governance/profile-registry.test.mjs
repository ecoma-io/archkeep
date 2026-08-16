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

  it("rejects a wrong version loudly rather than guessing", () => {
    const violations = profileRegistryViolations({ ...wellFormed(), version: 999 });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/expected 1, got/);
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
