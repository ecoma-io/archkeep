import { describe, expect, it } from "vitest";

import {
  DEFAULT_MANIFEST_NAMES,
  findNativeModelViolations,
  loadNativeModel,
  matchesGlob,
  normalizeNativeModel,
} from "./model.mjs";

/** A minimal well-formed document; each test bends exactly one thing. */
const wellFormed = () => ({ projects: { declared: [] } });

describe("findNativeModelViolations", () => {
  it("accepts a well-formed, mostly-empty document", () => {
    expect(findNativeModelViolations(wellFormed())).toEqual([]);
  });

  // `../../../../../docs/reference/configuration.md`: "Every field below is optional; an
  // empty `{}` is a valid `lattice.json`". Requiring `projects` to already be
  // a plain object made bare `{}` fail shape validation before
  // `./discover.mjs` ever got a chance to report the zero-projects case the
  // docs describe, contradicting the docs on the minimal example they lead
  // with.
  it("accepts a bare {} — every field, including projects, is optional", () => {
    expect(findNativeModelViolations({})).toEqual([]);
  });

  it("accepts every documented top-level key at once", () => {
    expect(
      findNativeModelViolations({
        projects: {
          declared: [{ root: "apps/a", name: "a", type: "app", tags: ["scope:a"] }],
          infer: { manifests: ["go.mod"], include: ["libs/**"], exclude: ["libs/skip/**"] },
        },
        projectRules: [{ match: "libs/**", tags: ["layer:util"] }],
        coverage: { exempt: [{ path: "README.md", reason: "not source" }] },
        workspaceLayout: { appsDir: "apps", libsDir: "libs" },
        boundaryConfig: "module-boundaries.config.mjs",
        tsConfig: "tsconfig.base.json",
      }),
    ).toEqual([]);
  });

  // An unknown key is the expensive typo: read as configuring something, it
  // instead configures nothing, and the workspace believes a knob is turned
  // that this tool never looks at.
  it("rejects an unknown top-level key instead of silently ignoring it", () => {
    const violations = findNativeModelViolations({ ...wellFormed(), tsconfigBase: "x.json" });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/tsconfigBase: not a lattice\.json field/);
  });

  it("rejects anything that is not an object at the top level", () => {
    expect(findNativeModelViolations(null)[0]).toMatch(/expected an object/);
    expect(findNativeModelViolations([])[0]).toMatch(/expected an object/);
    expect(findNativeModelViolations("lattice.json")[0]).toMatch(/expected an object/);
  });

  describe("projects.declared rows", () => {
    it("requires root, and rejects a leading or trailing slash", () => {
      expect(findNativeModelViolations({ projects: { declared: [{ name: "a" }] } })[0]).toMatch(
        /projects\.declared\[0\]\.root: must be a string/,
      );
      expect(
        findNativeModelViolations({ projects: { declared: [{ root: "/apps/a" }] } })[0],
      ).toMatch(/projects\.declared\[0\]\.root: '\/apps\/a' must be workspace-relative/);
      expect(
        findNativeModelViolations({ projects: { declared: [{ root: "apps/a/" }] } })[0],
      ).toMatch(/projects\.declared\[0\]\.root: 'apps\/a\/' must be workspace-relative/);
    });

    it("rejects '.' as a root — the workspace root is written '' instead", () => {
      expect(findNativeModelViolations({ projects: { declared: [{ root: "." }] } })[0]).toMatch(
        /projects\.declared\[0\]\.root: '\.' is not valid — write ''/,
      );
    });

    it("rejects a backslash in a root — paths are matched posix-style", () => {
      expect(
        findNativeModelViolations({ projects: { declared: [{ root: "apps\\a" }] } })[0],
      ).toMatch(/projects\.declared\[0\]\.root: 'apps\\a' must use forward slashes/);
    });

    it("rejects a '.' or '..' segment in a root", () => {
      expect(
        findNativeModelViolations({ projects: { declared: [{ root: "apps/../a" }] } })[0],
      ).toMatch(/projects\.declared\[0\]\.root: 'apps\/\.\.\/a' must be a canonical path/);
    });

    it("rejects a non-object declared row", () => {
      expect(findNativeModelViolations({ projects: { declared: ["apps/a"] } })[0]).toMatch(
        /projects\.declared\[0\]: must be an object/,
      );
    });

    it("rejects an invalid name or type on a declared row", () => {
      const violations = findNativeModelViolations({
        projects: { declared: [{ root: "apps/a", name: "", type: "service" }] },
      });
      expect(violations.some((v) => /\.name: must be a non-empty string/.test(v))).toBe(true);
      expect(violations.some((v) => /\.type: must be one of app, lib, e2e/.test(v))).toBe(true);
    });

    it("rejects an empty string inside a declared row's tag list", () => {
      expect(
        findNativeModelViolations({ projects: { declared: [{ root: "apps/a", tags: [""] }] } })[0],
      ).toMatch(/projects\.declared\[0\]\.tags\[0\]: must not be empty/);
    });

    it("accepts a declared row that carries no optional list keys at all", () => {
      // `stringListViolations(undefined, …)` reads an absent key as "no
      // violations", never as a malformed value.
      expect(findNativeModelViolations({ projects: { declared: [{ root: "apps/a" }] } })).toEqual(
        [],
      );
    });

    // '' names the workspace-root project itself, and it is the one root that
    // legitimately has neither a leading nor a trailing slash to strip.
    it("accepts an empty root as the workspace-root project", () => {
      expect(findNativeModelViolations({ projects: { declared: [{ root: "" }] } })).toEqual([]);
    });

    it("rejects an unknown field on a declared row", () => {
      const violations = findNativeModelViolations({
        projects: { declared: [{ root: "apps/a", owner: "team-a" }] },
      });
      expect(violations[0]).toMatch(/projects\.declared\[0\]\.owner: not a declared-project field/);
    });

    // The matcher's own reason, reported against the ROW that named the bad
    // pattern, before a graph is ever built — `./discover.mjs`'s own tests
    // pin the manifest-sourced half of this (a `project.json`'s
    // `implicitDependencies`); this is the declared half, and until now
    // nothing pinned it: `declaredProjectViolations` calls
    // `stringListViolations(row.implicitDependencies, …, projectPatternError)`
    // at model.mjs:305-311, but no test exercised a row that actually fails
    // it, so a change that quietly stopped passing `projectPatternError`
    // through (reporting only "must be an array of strings" cases and
    // letting `libs/*` sail through as shape-valid) would have gone green
    // here.
    it("rejects a declared row's implicitDependencies entry the matcher cannot expand", () => {
      const violations = findNativeModelViolations({
        projects: { declared: [{ root: "apps/a", implicitDependencies: ["libs/*"] }] },
      });
      expect(violations[0]).toMatch(
        /projects\.declared\[0\]\.implicitDependencies\[0\]: 'libs\/\*' uses glob syntax this engine does not reproduce/,
      );
    });
  });

  describe("projects.infer", () => {
    it("rejects a non-object projects.infer", () => {
      expect(findNativeModelViolations({ projects: { infer: 42 } })[0]).toMatch(
        /projects\.infer: must be an object/,
      );
    });

    it("rejects an empty manifests list, which would silently disable inference", () => {
      expect(findNativeModelViolations({ projects: { infer: { manifests: [] } } })[0]).toMatch(
        /projects\.infer\.manifests: must not be empty/,
      );
    });

    it("rejects an unknown projects.infer field", () => {
      expect(
        findNativeModelViolations({ projects: { infer: { manifest: ["go.mod"] } } })[0],
      ).toMatch(/projects\.infer\.manifest: not an infer field/);
    });
  });

  describe("projectRules rows", () => {
    it("rejects a non-object projectRules row", () => {
      expect(findNativeModelViolations({ projectRules: ["libs/**"] })[0]).toMatch(
        /projectRules\[0\]: must be an object/,
      );
    });

    it("rejects an invalid type on a projectRules row", () => {
      expect(
        findNativeModelViolations({ projectRules: [{ match: "libs/**", type: "service" }] })[0],
      ).toMatch(/projectRules\[0\]\.type: must be one of app, lib, e2e/);
    });

    it("rejects an unknown projectRules field", () => {
      const violations = findNativeModelViolations({
        projectRules: [{ match: "libs/**", tag: ["x"] }],
      });
      expect(
        violations.some((v) => /projectRules\[0\]\.tag: not a projectRules field/.test(v)),
      ).toBe(true);
    });
  });

  describe("coverage", () => {
    it("rejects a non-object coverage.exempt row", () => {
      expect(findNativeModelViolations({ coverage: { exempt: ["README.md"] } })[0]).toMatch(
        /coverage\.exempt\[0\]: must be an object/,
      );
    });

    it("rejects an unknown coverage.exempt field", () => {
      expect(
        findNativeModelViolations({
          coverage: { exempt: [{ path: "README.md", reason: "x", why: "y" }] },
        })[0],
      ).toMatch(/coverage\.exempt\[0\]\.why: not an exempt field/);
    });

    it("rejects a non-object coverage block, and a non-array exempt list", () => {
      expect(findNativeModelViolations({ coverage: 42 })[0]).toMatch(
        /coverage: must be an object when present/,
      );
      expect(findNativeModelViolations({ coverage: { exempt: "README.md" } })[0]).toMatch(
        /coverage\.exempt: must be an array when present/,
      );
    });

    it("rejects an unknown coverage field", () => {
      expect(findNativeModelViolations({ coverage: { exempts: [] } })[0]).toMatch(
        /coverage\.exempts: not a coverage field/,
      );
    });
  });

  describe("workspaceLayout", () => {
    it("rejects a non-object workspaceLayout", () => {
      expect(findNativeModelViolations({ workspaceLayout: "apps" })[0]).toMatch(
        /workspaceLayout: must be an object/,
      );
    });

    it("rejects an unknown workspaceLayout field", () => {
      const violations = findNativeModelViolations({
        workspaceLayout: { appsDir: "apps", libsDir: "libs", srcDir: "src" },
      });
      expect(
        violations.some((v) => /workspaceLayout\.srcDir: not a workspaceLayout field/.test(v)),
      ).toBe(true);
    });
  });

  describe("projects block", () => {
    it("rejects a non-object projects block", () => {
      expect(findNativeModelViolations({ projects: [] })[0]).toMatch(/projects: must be an object/);
    });

    it("rejects a projects.declared that is not an array", () => {
      expect(findNativeModelViolations({ projects: { declared: "apps/a" } })[0]).toMatch(
        /projects\.declared: must be an array when present/,
      );
    });

    it("rejects an unknown projects field", () => {
      expect(findNativeModelViolations({ projects: { declareds: [] } })[0]).toMatch(
        /projects\.declareds: not a projects field/,
      );
    });

    it("rejects a non-array projectRules block", () => {
      expect(findNativeModelViolations({ projectRules: {} })[0]).toMatch(
        /projectRules: must be an array when present/,
      );
    });
  });

  describe("projectRules rows", () => {
    it("requires a non-empty match glob", () => {
      expect(
        findNativeModelViolations({ ...wellFormed(), projectRules: [{ tags: ["x"] }] })[0],
      ).toMatch(/projectRules\[0\]\.match: must be a non-empty glob/);
    });

    // A rule that names neither `tags` nor `type` matches projects and changes
    // nothing about them — dead weight that reads as a constraint to a reader
    // skimming the file, and is invisible to every test that only checks
    // `match` compiles.
    it("rejects a rule that sets neither tags nor type", () => {
      const violations = findNativeModelViolations({
        ...wellFormed(),
        projectRules: [{ match: "libs/**" }],
      });
      expect(violations[0]).toMatch(/projectRules\[0\]: must set 'tags', 'type', or both/);
    });

    it("accepts a rule with only tags, or only type", () => {
      expect(
        findNativeModelViolations({
          ...wellFormed(),
          projectRules: [{ match: "libs/**", tags: ["layer:util"] }],
        }),
      ).toEqual([]);
      expect(
        findNativeModelViolations({
          ...wellFormed(),
          projectRules: [{ match: "apps/**", type: "app" }],
        }),
      ).toEqual([]);
    });
  });

  describe("coverage.exempt rows", () => {
    it("requires a non-empty path", () => {
      expect(
        findNativeModelViolations({
          ...wellFormed(),
          coverage: { exempt: [{ reason: "generated" }] },
        })[0],
      ).toMatch(/coverage\.exempt\[0\]\.path: must be a non-empty glob/);
    });

    // The exact "coverage / waiver reason" failure direction: a waiver with no
    // real reason is worse than none, because it reads as a decision someone
    // made rather than a hole nobody noticed.
    it("rejects a missing, empty, or whitespace-only reason", () => {
      expect(
        findNativeModelViolations({ ...wellFormed(), coverage: { exempt: [{ path: "x" }] } })[0],
      ).toMatch(/coverage\.exempt\[0\]\.reason: must be a non-empty string/);
      expect(
        findNativeModelViolations({
          ...wellFormed(),
          coverage: { exempt: [{ path: "x", reason: "" }] },
        })[0],
      ).toMatch(/reason: must be a non-empty string/);
      expect(
        findNativeModelViolations({
          ...wellFormed(),
          coverage: { exempt: [{ path: "x", reason: "   " }] },
        })[0],
      ).toMatch(/reason: must be a non-empty string/);
    });

    it("accepts a real reason", () => {
      expect(
        findNativeModelViolations({
          ...wellFormed(),
          coverage: { exempt: [{ path: "x", reason: "vendored, not ours to own" }] },
        }),
      ).toEqual([]);
    });
  });

  describe("workspaceLayout", () => {
    it("requires both appsDir and libsDir together, not one alone", () => {
      expect(
        findNativeModelViolations({ ...wellFormed(), workspaceLayout: { appsDir: "apps" } })[0],
      ).toMatch(/workspaceLayout\.libsDir: must be a non-empty string/);
      expect(
        findNativeModelViolations({ ...wellFormed(), workspaceLayout: { libsDir: "libs" } })[0],
      ).toMatch(/workspaceLayout\.appsDir: must be a non-empty string/);
    });

    it("accepts both present, and both absent", () => {
      expect(
        findNativeModelViolations({
          ...wellFormed(),
          workspaceLayout: { appsDir: "apps", libsDir: "libs" },
        }),
      ).toEqual([]);
      expect(findNativeModelViolations(wellFormed())).toEqual([]);
    });
  });

  /** A minimal well-formed inline policy — the object form of `boundaryConfig`. */
  const wellFormedPolicy = () => ({
    depConstraints: [],
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

  describe("boundaryConfig as an inline policy object", () => {
    it("accepts a well-formed inline policy, validated the same way a .json policy file is", () => {
      expect(
        findNativeModelViolations({ ...wellFormed(), boundaryConfig: wellFormedPolicy() }),
      ).toEqual([]);
    });

    // The silent-direction failure this guards: a malformed constraint row
    // inside an inline policy must fail exactly as loudly as the same row
    // would in a separate file — `../../config.mjs`'s
    // `findBoundaryConfigViolations` is the one function both routes share,
    // so a row that "matches nothing and silently approves everything" there
    // has to be caught here too, not only when the policy lives in its own
    // file.
    it("rejects a malformed row inside an inline policy, prefixed so it reads as boundaryConfig's", () => {
      const violations = findNativeModelViolations({
        ...wellFormed(),
        boundaryConfig: {
          ...wellFormedPolicy(),
          depConstraints: [{ onlyDependOnLibsWithTags: ["layer:util"] }],
        },
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatch(
        /^boundaryConfig\.depConstraints\[0\]: must carry exactly one of 'sourceTag'/,
      );
    });

    it("rejects a missing required option inside an inline policy, not a silently-defaulted one", () => {
      const policy = wellFormedPolicy();
      delete policy.moduleBoundaryOptions.banTransitiveDependencies;
      expect(findNativeModelViolations({ ...wellFormed(), boundaryConfig: policy })).toEqual([
        "boundaryConfig.moduleBoundaryOptions.banTransitiveDependencies: missing — every option is stated explicitly",
      ]);
    });

    // An inline policy has no separate file for an editor to validate
    // against, so it takes the standalone `.json` dialect's stricter posture
    // rather than the `.mjs` dialect's tolerance for an export it does not
    // read — `../../config.mjs`'s `policyKeyViolations`, called here with
    // `allowSchema: false` (no `$schema` carve-out either, for the same
    // reason: there is no file an editor validates it against). A typo'd
    // required key (`depConstraint` for `depConstraints`) was already caught
    // before this check existed, because the correctly-spelt key then reads
    // as missing; this is what additionally catches a genuinely EXTRA key
    // beside the three real ones, by name, instead of silently accepting it.
    it("rejects a genuinely extra key inside an inline policy, by name", () => {
      expect(
        findNativeModelViolations({
          ...wellFormed(),
          boundaryConfig: { ...wellFormedPolicy(), extra: "decorative" },
        }),
      ).toEqual([
        "boundaryConfig.extra: not a recognised top-level key — expected one of depConstraints, moduleBoundaryOptions, boundarySuppressions",
      ]);
    });

    it("rejects $schema inside an inline policy too, unlike the standalone .json dialect's carve-out", () => {
      // A standalone `.json` file tolerates `$schema` because an editor writes
      // it in unasked, to validate against a schema on disk. An inline policy
      // has no file for an editor to point a schema at, so `$schema` here
      // states no rule either and is rejected like any other unrecognised key
      // — `../../../../../docs/reference/policy-schema.md`'s "An inline policy, for
      // `lattice.json`" is where a workspace author reads why.
      expect(
        findNativeModelViolations({
          ...wellFormed(),
          boundaryConfig: { ...wellFormedPolicy(), $schema: "./schema.json" },
        }),
      ).toEqual([
        "boundaryConfig.$schema: not a recognised top-level key — expected one of depConstraints, moduleBoundaryOptions, boundarySuppressions",
      ]);
    });

    it("still catches a misspelt required key, because the correctly-spelt one reads as missing", () => {
      const policy = wellFormedPolicy();
      policy.depConstraint = policy.depConstraints;
      delete policy.depConstraints;
      const violations = findNativeModelViolations({ ...wellFormed(), boundaryConfig: policy });
      expect(violations[0]).toMatch(/^boundaryConfig\.depConstraints: must be an exported array/);
    });

    it("rejects a boundaryConfig that is neither a string nor an object", () => {
      expect(findNativeModelViolations({ ...wellFormed(), boundaryConfig: 42 })).toEqual([
        "boundaryConfig: must be a string (a filename) or an object (an inline policy), got number (42)",
      ]);
    });

    it("leaves a string boundaryConfig unchecked here, exactly as before", () => {
      // Deferred to `resolveOptions`/`loadBoundaryConfig` at load time — see
      // this function's own doc comment for why a string is not validated at
      // this layer.
      expect(findNativeModelViolations({ ...wellFormed(), boundaryConfig: "" })).toEqual([]);
    });
  });

  // A version that only reported the first thing wrong would turn fixing a
  // file into fixing it one typo at a time against a tool that never shows the
  // second problem until the first is gone.
  it("reports every violation at once, not just the first", () => {
    const violations = findNativeModelViolations({
      projects: { declared: [{ root: "/bad" }] },
      projectRules: [{ match: "" }],
      coverage: { exempt: [{ path: "x", reason: "" }] },
    });
    expect(violations.length).toBeGreaterThan(1);
    expect(violations.some((v) => v.startsWith("projects.declared[0]"))).toBe(true);
    expect(violations.some((v) => v.startsWith("projectRules[0]"))).toBe(true);
    expect(violations.some((v) => v.startsWith("coverage.exempt[0]"))).toBe(true);
  });
});

describe("normalizeNativeModel", () => {
  it("fills every default except workspaceLayout and infer, which stay undefined when absent", () => {
    const model = normalizeNativeModel(wellFormed());
    // Spec §3.1: an absent `projects.infer` means the declared list is
    // exhaustive — no inference — not "infer with every default filled in."
    // Filling this in unconditionally (the bug this pins against) made
    // `./discover.mjs`'s `model.projects.infer ? inferProjectRoots(...) : []`
    // always truthy, so a workspace with no `projects.infer` key still ran
    // inference over every tracked manifest with the `["**"]` default —
    // silently claiming a vendored `package.json` as a project nobody in
    // `lattice.json` asked to include.
    expect(model.projects.infer).toBeUndefined();
    expect(model.projectRules).toEqual([]);
    expect(model.coverage).toEqual({ exempt: [] });
    expect(model.boundaryConfig).toBe("module-boundaries.config.mjs");
    expect(model.tsConfig).toBe("tsconfig.base.json");
    // The one field a default here would silently defeat: an absent
    // workspaceLayout must reach the rule engine as absent, not as some
    // inferred guess, so `../../rules/index.mjs`'s own fallback is the only
    // place that ever supplies one.
    expect(model.workspaceLayout).toBeUndefined();
    expect("workspaceLayout" in model).toBe(true);
  });

  it("fills only the omitted keys of a present projects.infer, key by key", () => {
    const model = normalizeNativeModel({
      ...wellFormed(),
      projects: { declared: [], infer: { include: ["libs/**"] } },
    });
    expect(model.projects.infer).toEqual({
      manifests: DEFAULT_MANIFEST_NAMES,
      include: ["libs/**"],
      exclude: [],
    });
  });

  it("keeps an explicit empty projects.infer.exclude, distinct from an absent projects.infer", () => {
    const model = normalizeNativeModel({
      ...wellFormed(),
      projects: { declared: [], infer: { manifests: ["go.mod"], include: ["**"], exclude: [] } },
    });
    expect(model.projects.infer).toEqual({ manifests: ["go.mod"], include: ["**"], exclude: [] });
  });

  it("keeps a declared workspaceLayout exactly as written", () => {
    const model = normalizeNativeModel({
      ...wellFormed(),
      workspaceLayout: { appsDir: "applications", libsDir: "packages" },
    });
    expect(model.workspaceLayout).toEqual({ appsDir: "applications", libsDir: "packages" });
  });

  it("passes an inline boundaryConfig object through untouched, bypassing resolveOptions", () => {
    // `resolveOptions` (`../../options.mjs`) throws on any non-string option
    // value, so an inline policy object has to bypass it entirely rather than
    // being rejected the moment `normalizeNativeModel` runs — the object has
    // already passed `findBoundaryConfigViolations` by the time this
    // function sees it (`loadNativeModel` validates before normalizing).
    const policy = {
      depConstraints: [],
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
    };
    const model = normalizeNativeModel({ ...wellFormed(), boundaryConfig: policy });
    expect(model.boundaryConfig).toBe(policy);
    expect(model.tsConfig).toBe("tsconfig.base.json");
  });

  it("still resolves tsConfig normally alongside an inline boundaryConfig object", () => {
    const policy = { depConstraints: [], moduleBoundaryOptions: {} };
    const model = normalizeNativeModel({
      ...wellFormed(),
      boundaryConfig: policy,
      tsConfig: "tsconfig.custom.json",
    });
    expect(model.boundaryConfig).toBe(policy);
    expect(model.tsConfig).toBe("tsconfig.custom.json");
  });

  it("normalizes a declared project row's optional fields to their empty forms", () => {
    const model = normalizeNativeModel({
      projects: { declared: [{ root: "apps/a" }] },
    });
    expect(model.projects.declared).toEqual([
      {
        name: undefined,
        root: "apps/a",
        type: undefined,
        tags: [],
        implicitDependencies: [],
        targets: [],
      },
    ]);
  });
});

describe("loadNativeModel", () => {
  const io = (files) => ({ readFile: (path) => files[path] ?? null });

  it("throws naming the file when it is missing", () => {
    expect(() => loadNativeModel("/repo", io({}))).toThrow(
      /lattice: cannot load \/repo\/lattice\.json: no such file/,
    );
  });

  it("throws with the parse failure when the file is not valid JSON", () => {
    expect(() => loadNativeModel("/repo", io({ "lattice.json": "{not json" }))).toThrow(
      /lattice: cannot load \/repo\/lattice\.json:/,
    );
  });

  // `lattice.json` is never a file Nx itself reads (a workspace that has one
  // has no `nx.json` — `../../../../../docs/reference/configuration.md`), so it must
  // parse JSONC on its own rather than through `../../nx-json.mjs`'s
  // Nx-reaching parser: that parser's fallback, when `nx` cannot be resolved,
  // throws asking for it, and `../../../CLAUDE.md` promises the engine runs
  // with no `nx` installed at all. `./model.mjs` no longer imports
  // `../../nx-json.mjs` at all (removed by this change — grep confirms), so
  // there is no `nx` resolution left on this path to fail: these prove it by
  // behaviour, parsing exactly the two JSONC forms this module's own header
  // documents (a comment, a trailing comma) without any `nx` in play.
  it("accepts a lattice.json with a line comment and a trailing comma — no nx needed", () => {
    const text = `{
      // native, no Nx at all
      "projects": { "declared": [{ "root": "apps/a", "name": "a" }] },
    }`;
    const model = loadNativeModel("/repo", io({ "lattice.json": text }));
    expect(model.projects.declared[0].name).toBe("a");
  });

  it("accepts a lattice.json with a block comment", () => {
    const text = `{
      /* native workspace */
      "projects": { "declared": [] }
    }`;
    expect(loadNativeModel("/repo", io({ "lattice.json": text })).projects.declared).toEqual([]);
  });

  // A comment-looking or comma-looking substring INSIDE a string value must
  // survive: the stripper is string-aware, not a regex over the raw text.
  it("does not mistake `//` or a trailing comma inside a string value for JSONC syntax", () => {
    const text = JSON.stringify({
      projects: { declared: [] },
      coverage: {
        exempt: [{ path: "x", reason: "see http://example.com and a trailing, } note" }],
      },
    });
    const model = loadNativeModel("/repo", io({ "lattice.json": text }));
    expect(model.coverage.exempt[0].reason).toBe("see http://example.com and a trailing, } note");
  });

  it("survives escaped characters inside string values", () => {
    // `\"` and `\\` inside a string are the string's own content, not syntax
    // the comment/comma stripper may read — a `\\` followed by `"` must not
    // end the literal early, and a `\\` followed by `/` must not open a
    // comment.
    const text = '{ "coverage": { "exempt": [{ "path": "x", "reason": "a\\"b\\\\/c" }] } }';
    const model = loadNativeModel("/repo", io({ "lattice.json": text }));
    expect(model.coverage.exempt[0].reason).toBe('a"b\\/c');
  });

  it("survives a string that ends in an escape at the document's very end", () => {
    // An unterminated string closing on a backslash is broken JSON either
    // way; the point is the stripper does not crash on the escaped final
    // character, and the original parse failure is the one reported.
    expect(() => loadNativeModel("/repo", io({ "lattice.json": '{ "projects": "x\\' }))).toThrow(
      /cannot load \/repo\/lattice\.json:/,
    );
  });

  // A file broken for a reason that has nothing to do with comments or
  // trailing commas must still fail loudly, not be swallowed by the JSONC
  // retry.
  it("still throws on a lattice.json that is not valid JSON even once stripped", () => {
    expect(() => loadNativeModel("/repo", io({ "lattice.json": "{ /* unterminated" }))).toThrow(
      /lattice: cannot load \/repo\/lattice\.json:/,
    );
  });

  it("throws combining every shape violation when the file parses but is malformed", () => {
    const text = JSON.stringify({
      projects: { declared: [{ root: "/bad" }] },
      extra: true,
    });
    let error;
    try {
      loadNativeModel("/repo", io({ "lattice.json": text }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    expect(error.message).toMatch(/lattice: \/repo\/lattice\.json is malformed:/);
    expect(error.message).toMatch(/projects\.declared\[0\]\.root/);
    expect(error.message).toMatch(/extra: not a lattice\.json field/);
  });

  it("returns the normalized model when the file is well-formed", () => {
    const text = JSON.stringify({ projects: { declared: [{ root: "apps/a", name: "a" }] } });
    const model = loadNativeModel("/repo", io({ "lattice.json": text }));
    expect(model.projects.declared).toHaveLength(1);
    expect(model.projects.declared[0].name).toBe("a");
    expect(model.boundaryConfig).toBe("module-boundaries.config.mjs");
  });

  it("loads an inline boundaryConfig policy end to end, through parse, validate and normalize", () => {
    const text = JSON.stringify({
      projects: { declared: [{ root: "apps/a", name: "a" }] },
      boundaryConfig: {
        depConstraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] }],
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
    });
    const model = loadNativeModel("/repo", io({ "lattice.json": text }));
    expect(model.boundaryConfig).toEqual({
      depConstraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] }],
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
  });

  it("names the offending row when an inline boundaryConfig policy is malformed", () => {
    const text = JSON.stringify({
      projects: { declared: [] },
      boundaryConfig: { depConstraints: [{ sourceTag: "" }], moduleBoundaryOptions: {} },
    });
    let error;
    try {
      loadNativeModel("/repo", io({ "lattice.json": text }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    expect(error.message).toMatch(/lattice: \/repo\/lattice\.json is malformed:/);
    expect(error.message).toMatch(
      /boundaryConfig\.depConstraints\[0\]\.sourceTag: must be a non-empty string/,
    );
    expect(error.message).toMatch(/boundaryConfig\.moduleBoundaryOptions\.allow: missing/);
  });
});

describe("matchesGlob", () => {
  // A thin re-export of `path.posix.matchesGlob` — this proves the export
  // wires to the real thing, not a second implementation of glob matching.
  it("matches the same way path.posix.matchesGlob does", () => {
    expect(matchesGlob("apps/a/x.go", "apps/**")).toBe(true);
    expect(matchesGlob("libs/a/x.go", "apps/**")).toBe(false);
    expect(matchesGlob("README.md", "README.md")).toBe(true);
  });
});
