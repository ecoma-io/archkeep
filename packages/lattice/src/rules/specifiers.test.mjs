import { describe, expect, it } from "vitest";

import {
  createProjectRootMappings,
  findProjectForPath,
  findTransitiveExternalDependencies,
  getPackageNameFromImportPath,
  getTargetProjectBasedOnRelativeImport,
  hasBannedDependencies,
  hasBannedImport,
  isAbsoluteImportIntoAnotherProject,
  isBuiltinModuleImport,
  isConstraintBanningProject,
  isRelative,
  normalizeProjectRoot,
} from "./specifiers.mjs";
import { MAX_SPECIFIER_LENGTH } from "./match.mjs";
import { buildReachability } from "./reachability.mjs";

describe("isRelative", () => {
  // Upstream's narrower relative predicate, and the narrowness is the point: it
  // gates path ARITHMETIC below, and a bare `.` or `..` joined onto a directory
  // is not a specifier anyone wrote. Its two-character neighbour — which
  // accepts both and answers about SPELLING — now lives in
  // `../analysis/typescript.mjs`, because spelling is per-language and this
  // layer never learns which language it is holding.
  it("refuses a bare dot and a bare double dot", () => {
    expect(isRelative(".")).toBe(false);
    expect(isRelative("..")).toBe(false);
  });

  it("accepts the two prefixes path arithmetic can resolve, and nothing else", () => {
    expect(isRelative("./a")).toBe(true);
    expect(isRelative("../a")).toBe(true);
    for (const specifier of ["@scope/pkg", "pkg", "/absolute", "super::a", "..pkg"]) {
      expect(isRelative(specifier)).toBe(false);
    }
  });
});

describe("getPackageNameFromImportPath", () => {
  it("keeps both segments of a scoped package and only the first of an unscoped one", () => {
    expect(getPackageNameFromImportPath("@scope/pkg/deep/path")).toBe("@scope/pkg");
    expect(getPackageNameFromImportPath("pkg/deep/path")).toBe("pkg");
    expect(getPackageNameFromImportPath("pkg")).toBe("pkg");
  });
});

describe("isBuiltinModuleImport", () => {
  it("recognises a built-in by its package segment, prefixed or not", () => {
    expect(isBuiltinModuleImport("node:fs")).toBe(true);
    expect(isBuiltinModuleImport("path")).toBe(true);
    expect(isBuiltinModuleImport("node:sqlite")).toBe(true);
    expect(isBuiltinModuleImport("@scope/pkg")).toBe(false);
  });
});

describe("findProjectForPath", () => {
  const mappings = createProjectRootMappings({
    root: { data: { root: "" } },
    alpha: { data: { root: "area/alpha" } },
    nested: { data: { root: "area/alpha/nested" } },
  });

  it("takes the deepest project root containing the path", () => {
    expect(findProjectForPath("area/alpha/nested/src/x.ts", mappings)).toBe("nested");
    expect(findProjectForPath("area/alpha/src/x.ts", mappings)).toBe("alpha");
  });

  it("falls back to a project rooted at the workspace itself", () => {
    expect(findProjectForPath("elsewhere/x.ts", mappings)).toBe("root");
  });

  it("normalises a root of '' to '.' and drops a trailing slash", () => {
    expect(normalizeProjectRoot("")).toBe(".");
    expect(normalizeProjectRoot("area/alpha/")).toBe("area/alpha");
  });
});

describe("getTargetProjectBasedOnRelativeImport", () => {
  const mappings = createProjectRootMappings({
    alpha: { data: { root: "area/alpha" } },
    beta: { data: { root: "area/beta" } },
  });

  it("resolves the path arithmetically, with no extension probing", () => {
    expect(
      getTargetProjectBasedOnRelativeImport(
        "../../beta/src/x",
        "area/alpha/src/index.ts",
        mappings,
      ),
    ).toBe("beta");
  });

  it("declines a specifier that is not relative", () => {
    expect(
      getTargetProjectBasedOnRelativeImport("@scope/pkg", "area/alpha/src/index.ts", mappings),
    ).toBeUndefined();
  });

  it("declines a path that climbs out of the workspace", () => {
    expect(
      getTargetProjectBasedOnRelativeImport(
        "../../../../outside",
        "area/alpha/src/index.ts",
        mappings,
      ),
    ).toBeUndefined();
  });
});

describe("isAbsoluteImportIntoAnotherProject", () => {
  it("takes both the bare and the slash-prefixed form of each configured directory", () => {
    for (const specifier of ["libs/a", "/libs/a", "apps/a", "/apps/a"]) {
      expect(isAbsoluteImportIntoAnotherProject(specifier)).toBe(true);
    }
    expect(isAbsoluteImportIntoAnotherProject("area/a")).toBe(false);
  });
});

describe("isConstraintBanningProject", () => {
  const pkg = { name: "npm:@vendor/shell", type: "npm", data: { packageName: "@vendor/shell" } };

  it("refuses to judge a specifier longer than a specifier can be, loudly", () => {
    // The polynomial residue, closed at the subject rather than at the
    // pattern. `./match.mjs`'s complexity guard bounds the SHAPE of
    // what a policy may compile; the cost is the product of that shape and
    // the subject's length, and nothing upstream of here bounds the second
    // one — a specifier is text read out of a source file, which is
    // attacker-supplied (`../../../../SECURITY.md`).
    //
    // It throws rather than returning `false`, and the direction is the whole
    // point: `false` here is "not banned", which reaches the report as a
    // clean site, byte-for-byte identical to a specifier that was judged and
    // found fine. A throw is exit 3 — the run could not complete
    // (`../../AGENTS.md`) — and an unjudged site is not a clean site.
    const overlong = `@vendor/shell/${"a".repeat(MAX_SPECIFIER_LENGTH)}`;
    expect(() =>
      isConstraintBanningProject(pkg, { bannedExternalImports: ["@vendor/shell/*"] }, overlong),
    ).toThrow(new RegExp(String(MAX_SPECIFIER_LENGTH)));
    // Before the package test, not after: the question the bound answers is
    // "can this be judged at all", which does not depend on whether this
    // particular row had anything to say about it.
    expect(() =>
      isConstraintBanningProject(
        pkg,
        { bannedExternalImports: ["*"] },
        `@other/${"a".repeat(MAX_SPECIFIER_LENGTH)}`,
      ),
    ).toThrow();
  });

  it("judges a specifier of any plausible length exactly as before", () => {
    // The silent direction of the same bound: set it low enough to fire on a
    // real specifier and every run on a real workspace becomes exit 3. The
    // longest specifier the four analyzers can emit is a deep path or a
    // dotted module name, an order of magnitude under this.
    const realistic = `@vendor/shell/${"nested/".repeat(20)}entry`;
    expect(realistic.length).toBeLessThan(MAX_SPECIFIER_LENGTH);
    expect(
      isConstraintBanningProject(pkg, { bannedExternalImports: ["@vendor/shell/*"] }, realistic),
    ).toBe(true);
    expect(
      isConstraintBanningProject(pkg, { bannedExternalImports: ["@vendor/other/*"] }, realistic),
    ).toBe(false);
  });

  it("stays silent about a package the constraint does not name", () => {
    expect(isConstraintBanningProject(pkg, { bannedExternalImports: ["*"] }, "@other/thing")).toBe(
      false,
    );
  });

  it("is not banned when the constraint carries neither list", () => {
    expect(isConstraintBanningProject(pkg, { sourceTag: "zone:x" }, "@vendor/shell")).toBe(false);
  });

  it("bans when bannedExternalImports matches the specifier", () => {
    expect(
      isConstraintBanningProject(
        pkg,
        { bannedExternalImports: ["@vendor/shell"] },
        "@vendor/shell",
      ),
    ).toBe(true);
  });

  it("bans when bannedExternalImports is a glob that matches", () => {
    expect(
      isConstraintBanningProject(pkg, { bannedExternalImports: ["@vendor/*"] }, "@vendor/shell"),
    ).toBe(true);
  });

  it("bans when allowedExternalImports is empty — the vacuous-truth trap", () => {
    // `[].every()` is `true`, so `Boolean(true)` = `true` — an empty
    // allowlist bans every import of that package. This is a known divergence
    // from what a reader might expect ("no restrictions"), documented in the
    // implementation's comment.
    expect(isConstraintBanningProject(pkg, { allowedExternalImports: [] }, "@vendor/shell")).toBe(
      true,
    );
  });

  it("does not ban when allowedExternalImports contains the import", () => {
    expect(
      isConstraintBanningProject(
        pkg,
        { allowedExternalImports: ["@vendor/shell"] },
        "@vendor/shell",
      ),
    ).toBe(false);
  });

  it("bans when allowedExternalImports has entries that do not match", () => {
    expect(
      isConstraintBanningProject(
        pkg,
        { allowedExternalImports: ["@vendor/other"] },
        "@vendor/shell",
      ),
    ).toBe(true);
  });

  it("matches a deep path under the package name", () => {
    expect(
      isConstraintBanningProject(
        pkg,
        { bannedExternalImports: ["@vendor/shell/*"] },
        "@vendor/shell/sub",
      ),
    ).toBe(true);
    // A specifier that is the package itself, not a deep path, also bans when the glob targets deep paths:
    // `@vendor/shell` does not match `/^@vendor\/shell\/.*$/`, but `bannedExternalImports: ["*"]` would.
    expect(isConstraintBanningProject(pkg, { bannedExternalImports: ["*"] }, "@vendor/shell")).toBe(
      true,
    );
  });
});

describe("hasBannedImport", () => {
  const sourceProject = {
    name: "alpha",
    type: "lib",
    data: { root: "area/alpha", tags: ["zone:a"] },
  };
  const targetProject = {
    name: "npm:@vendor/shell",
    type: "npm",
    data: { packageName: "@vendor/shell" },
  };
  const constraint = { sourceTag: "zone:a", bannedExternalImports: ["@vendor/shell"] };
  const depConstraints = [constraint];

  it("returns the matching constraint when the import is banned", () => {
    expect(hasBannedImport(sourceProject, targetProject, depConstraints, "@vendor/shell")).toBe(
      constraint,
    );
  });

  it("returns undefined when no constraint matches the source project", () => {
    const untagged = { name: "beta", type: "lib", data: { root: "area/beta", tags: ["zone:b"] } };
    expect(
      hasBannedImport(untagged, targetProject, depConstraints, "@vendor/shell"),
    ).toBeUndefined();
  });

  it("returns undefined when depConstraints is empty — every import is approved", () => {
    expect(hasBannedImport(sourceProject, targetProject, [], "@vendor/shell")).toBeUndefined();
  });
});

describe("hasBannedDependencies", () => {
  const constraint = { sourceTag: "zone:a", bannedExternalImports: ["@vendor/shell"] };
  const graph = {
    nodes: {
      alpha: { name: "alpha", type: "lib", data: { root: "area/alpha" } },
      beta: { name: "beta", type: "lib", data: { root: "area/beta" } },
    },
    externalNodes: {
      "npm:@vendor/shell": {
        name: "npm:@vendor/shell",
        type: "npm",
        data: { packageName: "@vendor/shell" },
      },
    },
    dependencies: {},
  };
  const externalDependencies = [{ source: "alpha", target: "npm:@vendor/shell", type: "static" }];

  it("returns triples for transitively-reachable banned packages", () => {
    const result = hasBannedDependencies(externalDependencies, graph, constraint, "@vendor/shell");
    expect(result).toHaveLength(1);
    expect(result[0][0]).toBe(graph.externalNodes["npm:@vendor/shell"]);
    expect(result[0][2]).toBe(constraint);
  });

  it("returns empty when no transitive dependency is banned", () => {
    const permissive = { sourceTag: "zone:a", allowedExternalImports: ["*"] };
    expect(hasBannedDependencies(externalDependencies, graph, permissive, "@vendor/shell")).toEqual(
      [],
    );
  });

  it("returns empty when externalDependencies is empty", () => {
    expect(hasBannedDependencies([], graph, constraint, "@vendor/shell")).toEqual([]);
  });

  // `externalNodes` is a plain object — `JSON.parse` of `nx graph --file=` — so
  // `graph.externalNodes[dependency.target]` answered every `Object.prototype`
  // member for a target that is not an external package at all. What reaches
  // `isConstraintBanningProject` is then `Function.prototype.toString`, whose
  // `.data` is `undefined`: measured, `TypeError: Cannot destructure property
  // 'packageName' of 'externalProject.data' as it is undefined`, thrown out of
  // a rule that was asked whether an import is banned. A checker that throws
  // reports nothing, which `../../../../AGENTS.md` ranks below a wrong answer —
  // and this function is exported, so it can be handed a list this module did
  // not build.
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"])(
    "ignores a dependency on %s, which is not an external package",
    (name) => {
      const dependencies = [{ source: "alpha", target: name, type: "static" }];
      expect(() =>
        hasBannedDependencies(dependencies, graph, constraint, "@vendor/shell"),
      ).not.toThrow();
      expect(hasBannedDependencies(dependencies, graph, constraint, "@vendor/shell")).toEqual([]);
    },
  );

  // The same read, one field over. `graph.nodes[dependency.source]` had neither
  // guard, and it is the half whose value LEAVES this function: the triple's
  // second element becomes `childProjectName` in the violation `./index.mjs`
  // renders. A source named `constructor` yields the `Object` CONSTRUCTOR — a
  // truthy object with a `.name` of `"Object"` — so the report named a project
  // no workspace has, from a `Function` standing where a project node belongs.
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"])(
    "yields no project node for a dependency whose source is %s",
    (name) => {
      const dependencies = [{ source: name, target: "npm:@vendor/shell", type: "static" }];
      const result = hasBannedDependencies(dependencies, graph, constraint, "@vendor/shell");
      // Not just "no throw": nothing in the result may be a `Function`, which
      // is what an inherited `Object.prototype` member reads back as.
      for (const [, violatingSource] of result) {
        expect(typeof violatingSource).not.toBe("function");
      }
      expect(result).toEqual([]);
    },
  );

  it("names a project that really is called constructor, rather than dropping it", () => {
    // The other direction, and why the guard is `Object.hasOwn` and not a
    // name-blocklist: an OWN key wins. A workspace may contain a project named
    // `constructor`; its banned dependency is a finding like any other, and the
    // violation must name the project rather than `Object`.
    // Assigned rather than written as an object literal, and typed `any` to
    // get there: a checker reading `nodes.constructor` answers with
    // `Object.prototype.constructor`, which is the very confusion under test.
    // The prototype is deliberately NOT stripped — `JSON.parse` of `nx graph
    // --file=` leaves it in place, and it is what makes the own key meaningful.
    /** @type {any} */
    const nodes = { ...graph.nodes };
    nodes.constructor = { name: "constructor", type: "lib", data: { root: "area/constructor" } };
    const dependencies = [{ source: "constructor", target: "npm:@vendor/shell", type: "static" }];
    const result = hasBannedDependencies(
      dependencies,
      { ...graph, nodes },
      constraint,
      "@vendor/shell",
    );
    expect(result).toHaveLength(1);
    expect(result[0][1]).toBe(nodes.constructor);
  });

  it("reports nothing instead of throwing when the graph carries no nodes at all", () => {
    // Exported, so it is reachable with a graph this module did not build. An
    // absent `nodes` used to throw on the index, and a checker that throws
    // reports nothing at all — worse than a wrong answer.
    const nodeless = { externalNodes: graph.externalNodes, dependencies: {} };
    expect(() =>
      hasBannedDependencies(externalDependencies, nodeless, constraint, "@vendor/shell"),
    ).not.toThrow();
    expect(
      hasBannedDependencies(externalDependencies, nodeless, constraint, "@vendor/shell"),
    ).toEqual([]);
  });
});

describe("findTransitiveExternalDependencies", () => {
  const externalNodes = {
    "npm:@vendor/shell": {
      name: "npm:@vendor/shell",
      type: "npm",
      data: { packageName: "@vendor/shell" },
    },
  };

  it("collects the external dependencies of every transitively reachable project", () => {
    const nodes = { alpha: { name: "alpha" }, beta: { name: "beta" } };
    const dependencies = {
      alpha: [{ source: "alpha", target: "beta", type: "static" }],
      beta: [{ source: "beta", target: "npm:@vendor/shell", type: "static" }],
    };
    const graph = { nodes, externalNodes, dependencies };
    const reach = buildReachability({ nodes, dependencies });
    expect(findTransitiveExternalDependencies(graph, reach, { name: "alpha" })).toEqual([
      { source: "beta", target: "npm:@vendor/shell", type: "static" },
    ]);
  });

  // Both maps this walk indexes are plain objects, and both were read without a
  // membership test. A project literally named `constructor` (the name comes
  // from a workspace manifest, so a pull request supplies it) reaches the
  // `graph.dependencies?.[projectName]` read, which answers with the `Object`
  // CONSTRUCTOR — a function, so `?? []` does not replace it and `for…of` then
  // rejects it: measured, `TypeError: function is not iterable`. The whole
  // `checkNestedExternalImports` rule dies on one project name.
  it("does not read a dependency list off Object.prototype for a project that declares none", () => {
    const nodes = Object.create(null);
    nodes.alpha = { name: "alpha" };
    nodes.constructor = { name: "constructor" };
    const dependencies = { alpha: [{ source: "alpha", target: "constructor", type: "static" }] };
    const graph = { nodes, externalNodes, dependencies };
    const reach = buildReachability({ nodes, dependencies });

    expect(() => findTransitiveExternalDependencies(graph, reach, { name: "alpha" })).not.toThrow();
    expect(findTransitiveExternalDependencies(graph, reach, { name: "alpha" })).toEqual([]);
  });

  // The other half of the same read: an INTERNAL project named like a prototype
  // member was classified as an external package, because
  // `externalNodes["toString"]` is `Function.prototype.toString` and truthy. It
  // was then pushed into the external-dependency list and handed to
  // `isConstraintBanningProject`, which destructures its absent `.data`.
  it("does not classify an internal project named like a prototype member as an external package", () => {
    const nodes = Object.create(null);
    nodes.alpha = { name: "alpha" };
    nodes.toString = { name: "toString" };
    const dependencies = Object.create(null);
    dependencies.alpha = [{ source: "alpha", target: "toString", type: "static" }];
    dependencies.toString = [{ source: "toString", target: "npm:@vendor/shell", type: "static" }];
    const graph = { nodes, externalNodes, dependencies };
    const reach = buildReachability({ nodes, dependencies });

    // Exactly one entry: the real npm target. The internal `toString` project
    // is a project, not a package, and must not appear.
    expect(findTransitiveExternalDependencies(graph, reach, { name: "alpha" })).toEqual([
      { source: "toString", target: "npm:@vendor/shell", type: "static" },
    ]);
  });
});
