import { describe, expect, it } from "vitest";

import { evaluate, MESSAGE_IDS } from "./index.mjs";

/**
 * The engine is driven entirely from fixtures — no analyzer, no workspace, no
 * Nx. That is what the frozen analysis contract buys: a rule takes records, so
 * the records can be written by hand.
 *
 * Every project name, root and tag below is invented for these tests. Nothing
 * here may be read as a fact about this repository (`../../CLAUDE.md` — the
 * tool runs over consumers' trees, whose names it has never seen).
 *
 * Each rule gets its violating case AND the near miss that must stay silent.
 * The near misses are the tests that matter: a suite of violations alone still
 * passes when a rule is replaced by `return []`'s opposite — a rule that always
 * fires.
 *
 */

/**
 * How the JavaScript family spells a specifier — the answer
 * `specifierSpelling` in `../analysis/typescript.mjs` gives, restated because a
 * unit test here may not import a project-internal module unmocked (root
 * `CLAUDE.md`), and mocking the thing whose output shape is the point would
 * make these fixtures state nothing. The real one is pinned beside itself in
 * `typescript.test.mjs`, and the conformance suite drives both together over
 * one tree — a drift between them shows up there rather than hiding here.
 */
const jsSpelling = (specifier) => {
  const relative = [".", ".."].includes(specifier) || /^\.\.?\//u.test(specifier);
  return { path: relative || specifier.startsWith("/"), relative };
};

const project = (name, { type = "lib", root = `area/${name}`, tags = [], ...data } = {}) => ({
  name,
  type,
  data: { root, tags, ...data },
});

const graphOf = (projects, extra = {}) => ({
  nodes: Object.fromEntries(projects.map((p) => [p.name, p])),
  dependencies: {},
  ...extra,
});

/**
 * An import of `@fixture/beta` from a file in `alpha`, resolved to `beta`.
 *
 * `spelling` is filled in from the specifier with the JavaScript family's own
 * shape, because that is the language every `.ts` fixture below is written in —
 * a fixture that stated it by hand would drift from the specifier beside it. A
 * case testing another language's spelling passes `spelling` explicitly, which
 * is exactly what an analyzer for that language does.
 */
const site = (overrides = {}) => {
  const specifier = overrides.specifier ?? "@fixture/beta";
  return {
    sourceFile: "area/alpha/src/index.ts",
    line: 3,
    column: 1,
    kind: "static",
    spelling: jsSpelling(specifier),
    resolved: {
      target: "beta",
      file: "area/beta/src/index.ts",
      external: false,
      packageName: null,
    },
    ...overrides,
    specifier,
  };
};

const external = (packageName, specifier = packageName) =>
  site({
    specifier,
    resolved: { target: null, file: null, external: true, packageName },
  });

/** All eight options at the values `@nx/enforce-module-boundaries` defaults to. */
const options = (overrides = {}) => ({
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

const config = (depConstraints = [], optionOverrides = {}) => ({
  depConstraints,
  options: options(optionOverrides),
});

/** A table every fixture source project satisfies, so unrelated rules stay quiet. */
const permissive = [{ sourceTag: "*", onlyDependOnLibsWithTags: ["*"] }];

const idsOf = (violations) => violations.map((v) => v.messageId);

const twoLibs = () =>
  graphOf([project("alpha", { tags: ["zone:x"] }), project("beta", { tags: ["zone:y"] })]);

describe("evaluate", () => {
  describe("noRelativeOrAbsoluteImportsAcrossLibraries", () => {
    it("reports a relative path that lands inside another project", () => {
      const violations = evaluate(
        [
          site({
            specifier: "../../beta/src/thing",
            resolved: {
              target: "beta",
              file: "area/beta/src/thing.ts",
              external: false,
              packageName: null,
            },
          }),
        ],
        twoLibs(),
        config(permissive),
      );
      expect(idsOf(violations)).toEqual(["noRelativeOrAbsoluteImportsAcrossLibraries"]);
      expect(violations[0]).toMatchObject({
        sourceFile: "area/alpha/src/index.ts",
        line: 3,
        column: 1,
        sourceProject: "alpha",
        targetProject: "beta",
      });
    });

    it("stays silent for a relative path that stays inside its own project", () => {
      const violations = evaluate(
        [
          site({
            specifier: "./thing",
            resolved: {
              target: "alpha",
              file: "area/alpha/src/thing.ts",
              external: false,
              packageName: null,
            },
          }),
        ],
        twoLibs(),
        config(permissive),
      );
      expect(violations).toEqual([]);
    });

    it("reports an absolute path under the workspace layout even inside the same project", () => {
      // The spelling is the violation: upstream reports `libs/x/...` without
      // ever checking that it crosses a boundary.
      const graph = graphOf([project("alpha", { root: "libs/alpha", tags: ["zone:x"] })]);
      const violations = evaluate(
        [
          site({
            sourceFile: "libs/alpha/src/index.ts",
            specifier: "libs/alpha/src/thing",
            resolved: {
              target: "alpha",
              file: "libs/alpha/src/thing.ts",
              external: false,
              packageName: null,
            },
          }),
        ],
        graph,
        config(permissive),
      );
      expect(idsOf(violations)).toEqual(["noRelativeOrAbsoluteImportsAcrossLibraries"]);
    });

    it("respects a workspace layout that renames the app and lib directories", () => {
      const graph = graphOf([project("alpha", { root: "packages/alpha", tags: ["zone:x"] })], {
        workspaceLayout: { libsDir: "packages", appsDir: "programs" },
      });
      const violations = evaluate(
        [
          site({
            sourceFile: "packages/alpha/src/index.ts",
            specifier: "packages/alpha/src/thing",
            resolved: null,
          }),
        ],
        graph,
        config(permissive),
      );
      expect(idsOf(violations)).toEqual(["noRelativeOrAbsoluteImportsAcrossLibraries"]);
    });
  });

  describe("noRelativeOrAbsoluteExternals", () => {
    it("reports a relative path that reaches outside every project", () => {
      const violations = evaluate(
        [site({ specifier: "../../../outside/thing", resolved: null })],
        twoLibs(),
        config(permissive),
      );
      expect(idsOf(violations)).toEqual(["noRelativeOrAbsoluteExternals"]);
    });

    it("reports a bare '..', which counts as a path here though not as one earlier", () => {
      // `isRelativePath` accepts `.` and `..`; `isRelative` — used to decide
      // whether to resolve the specifier as a path at all — does not.
      const violations = evaluate(
        [site({ specifier: "..", resolved: null })],
        twoLibs(),
        config(permissive),
      );
      expect(idsOf(violations)).toEqual(["noRelativeOrAbsoluteExternals"]);
    });

    it("stays silent for an unresolved package name, which is not a path", () => {
      const violations = evaluate(
        [site({ specifier: "some-package", resolved: null })],
        twoLibs(),
        config(permissive),
      );
      expect(violations).toEqual([]);
    });

    it("stays silent for a relative import in a language whose specifiers are names", () => {
      // Python writes `from . import x`, and the analyzer records the specifier
      // as `.` — which the JavaScript shape reads as a path and this message
      // then blames for "a relative or absolute path". It is a module name.
      // When such an import cannot be resolved the honest output is the analysis
      // FAILURE the analyzer already recorded, not a violation about paths.
      const violations = evaluate(
        [
          site({
            sourceFile: "area/alpha/src/pkg/mod.py",
            specifier: ".",
            spelling: { path: false, relative: true },
            resolved: null,
          }),
        ],
        twoLibs(),
        config(permissive),
      );
      expect(violations).toEqual([]);
    });

    it("reports a path that RESOLVED to a file no project owns", () => {
      // The record resolved — the file exists — and belongs to no project, so
      // it arrives external with no package name. Deriving one from the path
      // yields `".."`, and a target, however synthetic, skips the only branch
      // that reports this message: the site went from a violation to silence,
      // which is the false negative direction that is never a decision.
      const violations = evaluate(
        [
          site({
            specifier: "../../../outside/present",
            resolved: {
              target: null,
              file: "outside/present.ts",
              external: true,
              packageName: null,
            },
          }),
        ],
        twoLibs(),
        config(permissive),
      );
      expect(idsOf(violations)).toEqual(["noRelativeOrAbsoluteExternals"]);
      expect(violations[0].targetProject).toBeNull();
    });

    it("reports an absolute path that resolved outside every project", () => {
      // `getPackageNameFromImportPath("/outside/present")` is the empty string,
      // so the synthesized node was `npm:` — a package with no name.
      const violations = evaluate(
        [
          site({
            specifier: "/outside/present",
            resolved: {
              target: null,
              file: "outside/present.ts",
              external: true,
              packageName: null,
            },
          }),
        ],
        twoLibs(),
        config(permissive),
      );
      expect(idsOf(violations)).toEqual(["noRelativeOrAbsoluteExternals"]);
    });

    it("refuses an external node to a path only, never to a package name", () => {
      // The exclusion is scoped by the SPELLING of the specifier, and the scope
      // is load-bearing in both directions. Widen it and the synthesis stops
      // working, which is what makes a ban reachable at all in Go, Rust and
      // Python — the graph registers no external nodes for those. Narrow it and
      // a path is handed a package that does not exist. One record of each
      // shape, one graph, one ban: both must land.
      const banning = [{ sourceTag: "zone:x", bannedExternalImports: ["rustshell*"] }];
      const violations = evaluate(
        [
          external("rustshell"),
          site({
            specifier: "../../../outside/rustshell",
            resolved: {
              target: null,
              file: "outside/rustshell.rs",
              external: true,
              packageName: null,
            },
          }),
        ],
        twoLibs(),
        config(banning),
      );
      expect(idsOf(violations)).toEqual([
        "bannedExternalImportsViolation",
        "noRelativeOrAbsoluteExternals",
      ]);
      expect(violations[0].targetProject).toBe("npm:rustshell");
    });
  });

  describe("noCircularDependencies", () => {
    const cyclicGraph = () =>
      graphOf([project("alpha", { tags: ["zone:x"] }), project("beta", { tags: ["zone:y"] })], {
        dependencies: { beta: [{ source: "beta", target: "alpha", type: "static" }] },
      });

    it("reports an import whose target already depends back on the source", () => {
      const violations = evaluate([site()], cyclicGraph(), config(permissive));
      expect(idsOf(violations)).toEqual(["noCircularDependencies"]);
      expect(violations[0].message).toContain("alpha -> beta -> alpha");
    });

    it("names the files carrying each hop of the cycle", () => {
      const sites = [
        site(),
        site({
          sourceFile: "area/beta/src/index.ts",
          specifier: "@fixture/alpha",
          resolved: {
            target: "alpha",
            file: "area/alpha/src/index.ts",
            external: false,
            packageName: null,
          },
        }),
      ];
      const violations = evaluate(sites, cyclicGraph(), config(permissive));
      expect(violations[0].message).toContain("- area/beta/src/index.ts");
    });

    it("brackets a hop that several files carry, one file per line", () => {
      const sites = [
        site(),
        site({
          sourceFile: "area/beta/src/index.ts",
          specifier: "@fixture/alpha",
          resolved: {
            target: "alpha",
            file: "area/alpha/src/index.ts",
            external: false,
            packageName: null,
          },
        }),
        site({
          sourceFile: "area/beta/src/other.ts",
          specifier: "@fixture/alpha",
          resolved: {
            target: "alpha",
            file: "area/alpha/src/index.ts",
            external: false,
            packageName: null,
          },
        }),
      ];
      const violations = evaluate(sites, cyclicGraph(), config(permissive));
      expect(violations[0].message).toContain(
        "[\n    area/beta/src/index.ts,\n    area/beta/src/other.ts\n  ]",
      );
    });

    it("stays silent when the target does not depend back on the source", () => {
      const violations = evaluate([site()], twoLibs(), config(permissive));
      expect(violations).toEqual([]);
    });

    it("stays silent for a pair named in ignoredCircularDependencies, in either direction", () => {
      const violations = evaluate(
        [site()],
        cyclicGraph(),
        config(permissive, { ignoredCircularDependencies: [["alpha", "beta"]] }),
      );
      expect(violations).toEqual([]);
    });

    it("selects ignored pairs by tag as well as by name", () => {
      const violations = evaluate(
        [site()],
        cyclicGraph(),
        config(permissive, { ignoredCircularDependencies: [["tag:zone:x", "tag:zone:y"]] }),
      );
      expect(violations).toEqual([]);
    });
  });

  describe("noSelfCircularDependencies", () => {
    const selfImport = () =>
      site({
        specifier: "@fixture/alpha",
        resolved: {
          target: "alpha",
          file: "area/alpha/src/other.ts",
          external: false,
          packageName: null,
        },
      });

    it("reports a file reaching its own project through the public alias", () => {
      const violations = evaluate([selfImport()], twoLibs(), config(permissive));
      expect(idsOf(violations)).toEqual(["noSelfCircularDependencies"]);
      expect(violations[0].message).toContain('"@fixture/alpha"');
    });

    it("stays silent when allowCircularSelfDependency permits it", () => {
      const violations = evaluate(
        [selfImport()],
        twoLibs(),
        config(permissive, { allowCircularSelfDependency: true }),
      );
      expect(violations).toEqual([]);
    });

    it("stays silent when the same file is reached relatively", () => {
      const violations = evaluate(
        [
          site({
            specifier: "./other",
            resolved: {
              target: "alpha",
              file: "area/alpha/src/other.ts",
              external: false,
              packageName: null,
            },
          }),
        ],
        twoLibs(),
        config(permissive),
      );
      expect(violations).toEqual([]);
    });

    it("stays silent when the alias reaches a different entry point of the same project", () => {
      const graph = graphOf([
        project("alpha", {
          tags: ["zone:x"],
          entryPoints: [{ path: "area/alpha/sub", file: "area/alpha/sub/index.ts" }],
        }),
      ]);
      const violations = evaluate(
        [
          site({
            specifier: "@fixture/alpha/sub",
            resolved: {
              target: "alpha",
              file: "area/alpha/sub/index.ts",
              external: false,
              packageName: null,
            },
          }),
        ],
        graph,
        config(permissive),
      );
      expect(violations).toEqual([]);
    });

    it("takes 'reached relatively' from the record, so another language's spelling counts", () => {
      // The bug this pins reported `use super::product_name` and a Rust binary
      // calling its own package's library crate as self-circular, on an
      // untouched tree. Neither is a round trip out through a public alias:
      // Rust spells an intra-project reference `crate::`/`self::`/`super::`, or
      // — between the bin and lib targets Cargo compiles from one package —
      // the library crate's own name, which is the ONLY spelling there is.
      const rustSelfImports = ["super::product_name", "rba_desktop_lib::"].map((specifier) =>
        site({
          sourceFile: "area/alpha/src/main.rs",
          specifier,
          spelling: { path: false, relative: true },
          resolved: { target: "alpha", file: null, external: false, packageName: null },
        }),
      );
      expect(evaluate(rustSelfImports, twoLibs(), config(permissive))).toEqual([]);
    });

    it("still reports a self-import the record says was NOT spelled relatively", () => {
      // The near miss for the case above: same shape, same language, one bit
      // different. Without it, `spelling.relative` could be read as "always
      // exempt a non-JavaScript record" and every test above would still pass.
      const violations = evaluate(
        [
          site({
            sourceFile: "area/alpha/src/main.rs",
            specifier: "unrelated_crate::thing",
            spelling: { path: false, relative: false },
            resolved: { target: "alpha", file: null, external: false, packageName: null },
          }),
        ],
        twoLibs(),
        config(permissive),
      );
      expect(idsOf(violations)).toEqual(["noSelfCircularDependencies"]);
    });
  });

  describe("noImportsOfApps", () => {
    it("reports an import of an application", () => {
      const graph = graphOf([
        project("alpha", { tags: ["zone:x"] }),
        project("beta", { type: "app", tags: ["zone:y"] }),
      ]);
      expect(idsOf(evaluate([site()], graph, config(permissive)))).toEqual(["noImportsOfApps"]);
    });

    it("stays silent for an application exposing a module federation remote", () => {
      const graph = graphOf([
        project("alpha", { tags: ["zone:x"] }),
        project("beta", { type: "app", tags: ["zone:y"], mfeRemote: true }),
      ]);
      expect(evaluate([site()], graph, config(permissive))).toEqual([]);
    });
  });

  describe("noImportsOfE2e", () => {
    it("reports an import of an e2e suite", () => {
      const graph = graphOf([
        project("alpha", { tags: ["zone:x"] }),
        project("beta", { type: "e2e", tags: ["zone:y"] }),
      ]);
      expect(idsOf(evaluate([site()], graph, config(permissive)))).toEqual(["noImportsOfE2e"]);
    });

    it("stays silent for an import of a library", () => {
      expect(evaluate([site()], twoLibs(), config(permissive))).toEqual([]);
    });
  });

  describe("noImportOfNonBuildableLibraries", () => {
    const buildable = { build: { executor: "@fixture/builder:build" } };

    it("reports a buildable library importing one with no build target", () => {
      const graph = graphOf([
        project("alpha", { tags: ["zone:x"], targets: buildable }),
        project("beta", { tags: ["zone:y"] }),
      ]);
      expect(
        idsOf(
          evaluate([site()], graph, config(permissive, { enforceBuildableLibDependency: true })),
        ),
      ).toEqual(["noImportOfNonBuildableLibraries"]);
    });

    it("stays silent when the imported library is buildable too", () => {
      const graph = graphOf([
        project("alpha", { tags: ["zone:x"], targets: buildable }),
        project("beta", { tags: ["zone:y"], targets: buildable }),
      ]);
      expect(
        evaluate([site()], graph, config(permissive, { enforceBuildableLibDependency: true })),
      ).toEqual([]);
    });

    it("stays silent when the target's build executor is an empty string", () => {
      // `hasBuildExecutor` requires `executor !== ''`, so this source is not
      // buildable either and the check has nothing to say.
      const graph = graphOf([
        project("alpha", { tags: ["zone:x"], targets: { build: { executor: "" } } }),
        project("beta", { tags: ["zone:y"] }),
      ]);
      expect(
        evaluate([site()], graph, config(permissive, { enforceBuildableLibDependency: true })),
      ).toEqual([]);
    });

    it("stays silent while enforceBuildableLibDependency is off", () => {
      const graph = graphOf([
        project("alpha", { tags: ["zone:x"], targets: buildable }),
        project("beta", { tags: ["zone:y"] }),
      ]);
      expect(evaluate([site()], graph, config(permissive))).toEqual([]);
    });
  });

  describe("noImportsOfLazyLoadedLibraries", () => {
    const lazyGraph = () =>
      graphOf([project("alpha", { tags: ["zone:x"] }), project("beta", { tags: ["zone:y"] })], {
        dependencies: { alpha: [{ source: "alpha", target: "beta", type: "dynamic" }] },
      });

    it("reports a static import of a library that is also lazy-loaded", () => {
      const violations = evaluate([site()], lazyGraph(), config(permissive));
      expect(idsOf(violations)).toEqual(["noImportsOfLazyLoadedLibraries"]);
      expect(violations[0].message).toContain('"beta"');
    });

    it("follows a chain of dynamic edges to the lazy-loaded library", () => {
      const graph = graphOf(
        [
          project("alpha", { tags: ["zone:x"] }),
          project("beta", { tags: ["zone:y"] }),
          project("gamma", { tags: ["zone:y"] }),
        ],
        {
          dependencies: {
            alpha: [{ source: "alpha", target: "gamma", type: "dynamic" }],
            gamma: [{ source: "gamma", target: "beta", type: "dynamic" }],
          },
        },
      );
      expect(idsOf(evaluate([site()], graph, config(permissive)))).toEqual([
        "noImportsOfLazyLoadedLibraries",
      ]);
    });

    it("stays silent for the dynamic import itself", () => {
      expect(evaluate([site({ kind: "dynamic" })], lazyGraph(), config(permissive))).toEqual([]);
    });

    it("stays silent for a type-only import, which is erased before runtime", () => {
      expect(evaluate([site({ kind: "type-only" })], lazyGraph(), config(permissive))).toEqual([]);
    });

    it("stays silent for a specifier listed in checkDynamicDependenciesExceptions", () => {
      expect(
        evaluate(
          [site()],
          lazyGraph(),
          config(permissive, { checkDynamicDependenciesExceptions: ["@fixture/*"] }),
        ),
      ).toEqual([]);
    });

    it("stays silent when nothing lazy-loads the target", () => {
      expect(evaluate([site()], twoLibs(), config(permissive))).toEqual([]);
    });
  });

  describe("projectWithoutTagsCannotHaveDependencies", () => {
    it("reports a source project no constraint row matches", () => {
      // The inversion: no rule said no, and upstream still errors. Read it the
      // natural way and every mis-tagged project escapes the boundary.
      const violations = evaluate(
        [site()],
        twoLibs(),
        config([{ sourceTag: "zone:absent", onlyDependOnLibsWithTags: ["zone:y"] }]),
      );
      expect(idsOf(violations)).toEqual(["projectWithoutTagsCannotHaveDependencies"]);
    });

    it("reports a source project with no tags at all", () => {
      const graph = graphOf([project("alpha"), project("beta", { tags: ["zone:y"] })]);
      expect(
        idsOf(
          evaluate(
            [site()],
            graph,
            config([{ sourceTag: "zone:x", onlyDependOnLibsWithTags: ["zone:y"] }]),
          ),
        ),
      ).toEqual(["projectWithoutTagsCannotHaveDependencies"]);
    });

    it("stays silent once one row matches and the dependency satisfies it", () => {
      expect(
        evaluate(
          [site()],
          twoLibs(),
          config([{ sourceTag: "zone:x", onlyDependOnLibsWithTags: ["zone:y"] }]),
        ),
      ).toEqual([]);
    });

    it("stays silent for an untagged project importing an external package", () => {
      // An npm target returns before the tag block is ever reached, so no
      // external import can produce this violation however untagged its source.
      const graph = graphOf([project("alpha")]);
      expect(
        evaluate([external("some-package")], graph, config([{ sourceTag: "zone:x" }])),
      ).toEqual([]);
    });

    it("stays silent when the constraint table is empty", () => {
      expect(evaluate([site()], twoLibs(), config([]))).toEqual([]);
    });
  });

  describe("bannedExternalImportsViolation", () => {
    const banning = [{ sourceTag: "zone:x", bannedExternalImports: ["@vendor/shell*"] }];

    it("reports a banned external package imported by a matching source", () => {
      const violations = evaluate(
        [external("@vendor/shell", "@vendor/shell/window")],
        twoLibs(),
        config(banning),
      );
      expect(idsOf(violations)).toEqual(["bannedExternalImportsViolation"]);
      expect(violations[0].message).toContain('tagged with "zone:x"');
      expect(violations[0].constraint).toEqual(banning[0]);
    });

    it("stays silent for an external package the row does not name", () => {
      expect(evaluate([external("@vendor/other")], twoLibs(), config(banning))).toEqual([]);
    });

    it("bans only the deep paths when the pattern names them", () => {
      const deepOnly = [{ sourceTag: "zone:x", bannedExternalImports: ["@vendor/shell/*"] }];
      expect(
        idsOf(
          evaluate(
            [external("@vendor/shell", "@vendor/shell/window")],
            twoLibs(),
            config(deepOnly),
          ),
        ),
      ).toEqual(["bannedExternalImportsViolation"]);
      expect(evaluate([external("@vendor/shell")], twoLibs(), config(deepOnly))).toEqual([]);
    });

    it("treats an allowedExternalImports list as everything-else-banned", () => {
      const allowList = [{ sourceTag: "zone:x", allowedExternalImports: ["@vendor/shell"] }];
      expect(evaluate([external("@vendor/shell")], twoLibs(), config(allowList))).toEqual([]);
      expect(
        idsOf(
          evaluate(
            [external("@vendor/shell", "@vendor/shell/window")],
            twoLibs(),
            config(allowList),
          ),
        ),
      ).toEqual(["bannedExternalImportsViolation"]);
    });

    it("treats an empty allowedExternalImports list as banning the package entirely", () => {
      // `[].every()` is true, so an empty allowlist reads as "no restrictions"
      // and means the exact opposite.
      const allowNothing = [{ sourceTag: "zone:x", allowedExternalImports: [] }];
      expect(idsOf(evaluate([external("@vendor/shell")], twoLibs(), config(allowNothing)))).toEqual(
        ["bannedExternalImportsViolation"],
      );
    });

    it("checks a package that the graph never registered as an external node", () => {
      // Crates, PyPI distributions and Go modules are deliberately absent from
      // `externalNodes`. Upstream would find no target and bail, which would
      // leave every ban unenforceable outside JavaScript.
      const violations = evaluate(
        [external("@vendor/shell", "@vendor/shell/window")],
        twoLibs(),
        config(banning),
      );
      expect(idsOf(violations)).toEqual(["bannedExternalImportsViolation"]);
      expect(violations[0].targetProject).toBe("npm:@vendor/shell");
    });

    it("prefers the graph's own external node when it has one", () => {
      const graph = graphOf([project("alpha", { tags: ["zone:x"] })], {
        externalNodes: {
          "npm:@vendor/shell": {
            name: "npm:@vendor/shell",
            type: "npm",
            data: { packageName: "@vendor/shell", version: "1.0.0" },
          },
        },
      });
      const violations = evaluate([external("@vendor/shell")], graph, config(banning));
      expect(violations[0].targetProject).toBe("npm:@vendor/shell");
    });
  });

  describe("nestedBannedExternalImportsViolation", () => {
    /**
     * Upstream matches the ban against the CURRENT specifier, not against the
     * nested package's name, so the rule can only fire where a project's import
     * alias and a transitively reachable package name are the same string. That
     * is `@nx/eslint-plugin` 23.1.1's behaviour, reproduced rather than
     * corrected: this engine's job is to agree with ESLint's verdict.
     */
    const nested = () =>
      graphOf([project("alpha", { tags: ["zone:x"] }), project("beta", { tags: ["zone:y"] })], {
        externalNodes: {
          "npm:@vendor/shell": {
            name: "npm:@vendor/shell",
            type: "npm",
            data: { packageName: "@vendor/shell" },
          },
        },
        dependencies: {
          beta: [{ source: "beta", target: "npm:@vendor/shell", type: "static" }],
        },
      });

    const aliasCollision = () =>
      site({
        specifier: "@vendor/shell/sub",
        resolved: {
          target: "beta",
          file: "area/beta/src/index.ts",
          external: false,
          packageName: null,
        },
      });

    const banning = [{ sourceTag: "zone:x", bannedExternalImports: ["@vendor/shell*"] }];

    it("reports the child project that pulls in the banned package", () => {
      const violations = evaluate(
        [aliasCollision()],
        nested(),
        config(banning, { checkNestedExternalImports: true }),
      );
      expect(idsOf(violations)).toEqual(["nestedBannedExternalImportsViolation"]);
      expect(violations[0].message).toContain("Nested import found at beta");
    });

    it("stays silent while checkNestedExternalImports is off", () => {
      expect(evaluate([aliasCollision()], nested(), config(banning))).toEqual([]);
    });

    it("stays silent when the specifier is not the banned package's own name", () => {
      expect(
        evaluate([site()], nested(), config(banning, { checkNestedExternalImports: true })),
      ).toEqual([]);
    });
  });

  describe("noTransitiveDependencies", () => {
    it("reports an external package the importing project does not declare", () => {
      expect(
        idsOf(
          evaluate(
            [external("some-package")],
            twoLibs(),
            config(permissive, { banTransitiveDependencies: true }),
          ),
        ),
      ).toEqual(["noTransitiveDependencies"]);
    });

    it("stays silent for a package the importing project declares", () => {
      const graph = graphOf([
        project("alpha", { tags: ["zone:x"], declaredPackages: ["some-package"] }),
      ]);
      expect(
        evaluate(
          [external("some-package")],
          graph,
          config(permissive, { banTransitiveDependencies: true }),
        ),
      ).toEqual([]);
    });

    it("stays silent for a node built-in, which no manifest declares", () => {
      expect(
        evaluate(
          [external("node:fs")],
          twoLibs(),
          config(permissive, { banTransitiveDependencies: true }),
        ),
      ).toEqual([]);
    });

    it("reports an unresolvable specifier that is not a path", () => {
      expect(
        idsOf(
          evaluate(
            [site({ specifier: "some-package", resolved: null })],
            twoLibs(),
            config(permissive, { banTransitiveDependencies: true }),
          ),
        ),
      ).toEqual(["noTransitiveDependencies"]);
    });

    it("stays silent while banTransitiveDependencies is off", () => {
      expect(evaluate([external("some-package")], twoLibs(), config(permissive))).toEqual([]);
    });

    it("reports both the transitive use and the ban when an import is each", () => {
      // The npm branch is one of two places upstream does not return after
      // reporting, so a single import site yields two violations.
      const violations = evaluate(
        [external("@vendor/shell")],
        twoLibs(),
        config([{ sourceTag: "zone:x", bannedExternalImports: ["@vendor/shell*"] }], {
          banTransitiveDependencies: true,
        }),
      );
      expect(idsOf(violations)).toEqual([
        "noTransitiveDependencies",
        "bannedExternalImportsViolation",
      ]);
    });
  });

  describe("onlyTagsConstraintViolation", () => {
    const table = [{ sourceTag: "zone:x", onlyDependOnLibsWithTags: ["zone:y"] }];

    it("reports a dependency carrying none of the permitted tags", () => {
      const graph = graphOf([
        project("alpha", { tags: ["zone:x"] }),
        project("beta", { tags: ["zone:elsewhere"] }),
      ]);
      const violations = evaluate([site()], graph, config(table));
      expect(idsOf(violations)).toEqual(["onlyTagsConstraintViolation"]);
      expect(violations[0].message).toContain('can only depend on libs tagged with "zone:y"');
      expect(violations[0].constraint).toEqual(table[0]);
    });

    it("stays silent when the dependency carries one of the permitted tags", () => {
      expect(evaluate([site()], twoLibs(), config(table))).toEqual([]);
    });

    it("holds a source to every matching row, not to any one of them", () => {
      // Four rows match; the dependency satisfies three. An OR implementation
      // passes this — which is the whole failure this test exists to catch.
      const fourAxes = [
        { sourceTag: "type:lib", onlyDependOnLibsWithTags: ["type:lib"] },
        { sourceTag: "zone:x", onlyDependOnLibsWithTags: ["zone:x", "zone:y"] },
        { sourceTag: "layer:inner", onlyDependOnLibsWithTags: ["layer:inner"] },
        { sourceTag: "grade:open", onlyDependOnLibsWithTags: ["grade:open"] },
      ];
      const graph = graphOf([
        project("alpha", { tags: ["type:lib", "zone:x", "layer:inner", "grade:open"] }),
        project("beta", { tags: ["type:lib", "zone:y", "layer:outer", "grade:open"] }),
      ]);
      const violations = evaluate([site()], graph, config(fourAxes));
      expect(idsOf(violations)).toEqual(["onlyTagsConstraintViolation"]);
      expect(violations[0].constraint).toEqual(fourAxes[2]);
    });

    it("matches source and target tags through the wildcard, regex and glob forms", () => {
      const graph = graphOf([
        project("alpha", { tags: ["zone:x"] }),
        project("beta", { tags: ["zone:y"] }),
      ]);
      expect(
        evaluate(
          [site()],
          graph,
          config([{ sourceTag: "/^zone:/", onlyDependOnLibsWithTags: ["zone:*"] }]),
        ),
      ).toEqual([]);
      expect(
        idsOf(
          evaluate(
            [site()],
            graph,
            config([{ sourceTag: "zone:*", onlyDependOnLibsWithTags: ["/^other:/"] }]),
          ),
        ),
      ).toEqual(["onlyTagsConstraintViolation"]);
    });

    it("matches a combo row only when the source carries every one of its tags", () => {
      const combo = [
        { allSourceTags: ["zone:x", "grade:open"], onlyDependOnLibsWithTags: ["zone:nothing"] },
      ];
      const bothTags = graphOf([
        project("alpha", { tags: ["zone:x", "grade:open"] }),
        project("beta", { tags: ["zone:y"] }),
      ]);
      const violations = evaluate([site()], bothTags, config(combo));
      expect(idsOf(violations)).toEqual(["onlyTagsConstraintViolation"]);
      expect(violations[0].message).toContain('tagged with "zone:x" and "grade:open"');

      // Only one of the two tags: the row does not match, so no row matches —
      // which is an error of its own, not a pass.
      const oneTag = graphOf([
        project("alpha", { tags: ["zone:x"] }),
        project("beta", { tags: ["zone:y"] }),
      ]);
      expect(idsOf(evaluate([site()], oneTag, config(combo)))).toEqual([
        "projectWithoutTagsCannotHaveDependencies",
      ]);
    });
  });

  describe("emptyOnlyTagsConstraintViolation", () => {
    const table = [{ sourceTag: "zone:x", onlyDependOnLibsWithTags: [] }];

    it("reports a dependency that carries any tag at all", () => {
      const violations = evaluate([site()], twoLibs(), config(table));
      expect(idsOf(violations)).toEqual(["emptyOnlyTagsConstraintViolation"]);
      expect(violations[0].message).toContain("cannot depend on any libs with tags");
    });

    it("stays silent for a dependency with no tags", () => {
      const graph = graphOf([project("alpha", { tags: ["zone:x"] }), project("beta")]);
      expect(evaluate([site()], graph, config(table))).toEqual([]);
    });

    it("is a different verdict from having no matching row at all", () => {
      const noRow = evaluate([site()], twoLibs(), config([{ sourceTag: "zone:absent" }]));
      const emptyRow = evaluate([site()], twoLibs(), config(table));
      expect(idsOf(noRow)).toEqual(["projectWithoutTagsCannotHaveDependencies"]);
      expect(idsOf(emptyRow)).toEqual(["emptyOnlyTagsConstraintViolation"]);
    });
  });

  describe("notTagsConstraintViolation", () => {
    const table = [{ sourceTag: "zone:x", notDependOnLibsWithTags: ["grade:closed"] }];

    it("reports a forbidden tag carried by the dependency itself", () => {
      const graph = graphOf([
        project("alpha", { tags: ["zone:x"] }),
        project("beta", { tags: ["grade:closed"] }),
      ]);
      const violations = evaluate([site()], graph, config(table));
      expect(idsOf(violations)).toEqual(["notTagsConstraintViolation"]);
      expect(violations[0].message).toContain("- beta");
    });

    it("reports a forbidden tag reached through the dependency's own dependencies", () => {
      const graph = graphOf(
        [
          project("alpha", { tags: ["zone:x"] }),
          project("beta", { tags: ["zone:y"] }),
          project("gamma", { tags: ["grade:closed"] }),
        ],
        { dependencies: { beta: [{ source: "beta", target: "gamma", type: "static" }] } },
      );
      const violations = evaluate([site()], graph, config(table));
      expect(idsOf(violations)).toEqual(["notTagsConstraintViolation"]);
      expect(violations[0].message).toContain("- beta -> gamma");
    });

    it("stays silent when nothing reachable from the dependency carries the tag", () => {
      const graph = graphOf(
        [
          project("alpha", { tags: ["zone:x"] }),
          project("beta", { tags: ["zone:y"] }),
          project("gamma", { tags: ["grade:closed"] }),
        ],
        { dependencies: { alpha: [{ source: "alpha", target: "gamma", type: "static" }] } },
      );
      expect(evaluate([site()], graph, config(table))).toEqual([]);
    });
  });

  describe("allow", () => {
    it("exempts a specifier matched by a wildcard entry from every rule", () => {
      const graph = graphOf([
        project("alpha", { tags: ["zone:x"] }),
        project("beta", { type: "app", tags: ["zone:y"] }),
      ]);
      expect(evaluate([site()], graph, config(permissive, { allow: ["@fixture/*"] }))).toEqual([]);
      expect(idsOf(evaluate([site()], graph, config(permissive)))).toEqual(["noImportsOfApps"]);
    });

    it("matches an entry with no wildcard as an unanchored regular expression", () => {
      // Nx's fallback branch is `new RegExp(entry).test(specifier)`. A glob
      // library would anchor it, and the escape hatch would stop working.
      const graph = graphOf([
        project("alpha", { tags: ["zone:x"] }),
        project("beta", { type: "app", tags: ["zone:y"] }),
      ]);
      expect(evaluate([site()], graph, config(permissive, { allow: ["fixture/bet"] }))).toEqual([]);
    });

    it("matches a trailing /** across path segments and a trailing /* within one", () => {
      const graph = graphOf([
        project("alpha", { tags: ["zone:x"] }),
        project("beta", { type: "app", tags: ["zone:y"] }),
      ]);
      const deep = site({ specifier: "@fixture/beta/deep/path" });
      expect(evaluate([deep], graph, config(permissive, { allow: ["@fixture/**"] }))).toEqual([]);
      expect(idsOf(evaluate([deep], graph, config(permissive, { allow: ["@fixture/*"] })))).toEqual(
        ["noImportsOfApps"],
      );
    });
  });

  describe("inputs it refuses to judge", () => {
    it("rejects a malformed constraint table, naming the offending row", () => {
      expect(() =>
        evaluate([site()], twoLibs(), { depConstraints: [{}], options: options() }),
      ).toThrow(/depConstraints\[0\]/);
    });

    it("rejects a config with an option left unstated rather than choosing one", () => {
      const partial = options();
      delete partial.banTransitiveDependencies;
      expect(() => evaluate([site()], twoLibs(), { depConstraints: [], options: partial })).toThrow(
        /banTransitiveDependencies: missing/,
      );
    });

    it("rejects a graph with no nodes map", () => {
      expect(() => evaluate([site()], {}, config(permissive))).toThrow(/needs a project graph/);
    });

    it("rejects a record naming a project the graph does not contain", () => {
      const graph = graphOf([project("alpha", { tags: ["zone:x"] })]);
      expect(() => evaluate([site()], graph, config(permissive))).toThrow(
        /resolved to project 'beta'/,
      );
    });

    it("rejects a record carrying no spelling instead of reading the specifier itself", () => {
      // Deriving it here is what the engine used to do, with JavaScript's shape,
      // and it is how an analyzer for the next language would inherit the same
      // two false positives without anyone noticing. The record states it or the
      // run stops — and it stops before any verdict, not at whichever branch
      // happens to ask first.
      const bare = site();
      delete bare.spelling;
      expect(() => evaluate([bare], twoLibs(), config(permissive))).toThrow(/no `spelling`/);
    });

    it("ignores an import from a file that belongs to no project", () => {
      expect(
        evaluate([site({ sourceFile: "elsewhere/script.ts" })], twoLibs(), config(permissive)),
      ).toEqual([]);
    });

    it("ignores a record that resolved to neither a project nor a package", () => {
      expect(
        evaluate(
          [
            site({
              specifier: "unknown",
              resolved: { target: null, file: null, external: false, packageName: null },
            }),
          ],
          twoLibs(),
          config(permissive),
        ),
      ).toEqual([]);
    });
  });

  describe("suppressions", () => {
    /** A relative import that crosses into another project — a real violation. */
    const crossing = () =>
      site({
        specifier: "../../beta/src/thing",
        resolved: {
          target: "beta",
          file: "area/beta/src/thing.ts",
          external: false,
          packageName: null,
        },
      });

    const suppressed = (suppressions, sites = [crossing()]) =>
      evaluate(sites, twoLibs(), { ...config(permissive), suppressions });

    it("removes a violation the workspace decided to accept, with its reason", () => {
      expect(
        suppressed([
          {
            path: "area/alpha/src/index.ts",
            reason: "the bundler loading this file resolves no alias",
          },
        ]),
      ).toEqual([]);
    });

    it("leaves every other file alone, so a suppression covers what it names", () => {
      expect(
        idsOf(suppressed([{ path: "area/alpha/src/other.ts", reason: "a different file" }])),
      ).toEqual(["noRelativeOrAbsoluteImportsAcrossLibraries"]);
    });

    it("removes only the violation type it names when it names one", () => {
      expect(
        idsOf(
          suppressed([
            { path: "area/alpha/src/index.ts", messageId: "noImportsOfApps", reason: "not this" },
          ]),
        ),
      ).toEqual(["noRelativeOrAbsoluteImportsAcrossLibraries"]);
    });

    it("suppresses nothing when the config declares none", () => {
      expect(idsOf(evaluate([crossing()], twoLibs(), config(permissive)))).toEqual([
        "noRelativeOrAbsoluteImportsAcrossLibraries",
      ]);
    });

    it("rejects a suppression with no reason before it can silence anything", () => {
      expect(() => suppressed([{ path: "area/alpha/src/index.ts" }])).toThrow(
        /boundarySuppressions\[0\]\.reason/,
      );
    });

    it("cannot silence a failure, because the engine still judges the file it covers", () => {
      // The load-bearing ordering: suppressions filter VERDICTS, they do not
      // skip sites. A file-level skip would also skip the checks that make this
      // throw — and "I could not tell" is not something anyone can decide to
      // accept. The record below names a project the graph does not have, in a
      // file a suppression covers completely.
      const graph = graphOf([project("alpha", { tags: ["zone:x"] })]);
      expect(() =>
        evaluate([site()], graph, {
          ...config(permissive),
          suppressions: [{ path: "area/alpha/**", reason: "covers the whole project" }],
        }),
      ).toThrow(/resolved to project 'beta'/);
    });
  });

  describe("the violation record", () => {
    it("carries the position, the specifier and the rendered message", () => {
      const graph = graphOf([
        project("alpha", { tags: ["zone:x"] }),
        project("beta", { type: "e2e", tags: ["zone:y"] }),
      ]);
      const [violation] = evaluate([site({ line: 12, column: 8 })], graph, config(permissive));
      expect(violation).toEqual({
        sourceFile: "area/alpha/src/index.ts",
        line: 12,
        column: 8,
        specifier: "@fixture/beta",
        kind: "static",
        messageId: "noImportsOfE2e",
        message: "Imports of e2e projects are forbidden",
        sourceProject: "alpha",
        targetProject: "beta",
        constraint: null,
        data: {},
      });
    });

    it("judges every site it is given, in the order they arrive", () => {
      const graph = graphOf([
        project("alpha", { tags: ["zone:x"] }),
        project("beta", { type: "e2e", tags: ["zone:y"] }),
      ]);
      const violations = evaluate(
        [site({ line: 1 }), site({ line: 2 })],
        graph,
        config(permissive),
      );
      expect(violations.map((v) => v.line)).toEqual([1, 2]);
    });

    it("only ever produces ids @nx/enforce-module-boundaries also uses", () => {
      const graph = graphOf([
        project("alpha", { tags: ["zone:x"] }),
        project("beta", { type: "app", tags: ["zone:y"] }),
      ]);
      const violations = evaluate([site(), external("@vendor/shell")], graph, config(permissive));
      expect(violations.length).toBeGreaterThan(0);
      for (const violation of violations) expect(MESSAGE_IDS).toContain(violation.messageId);
    });
  });
});
