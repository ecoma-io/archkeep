import { describe, expect, it } from "vitest";

import {
  createProjectRootMappings,
  findProjectForPath,
  getPackageNameFromImportPath,
  getTargetProjectBasedOnRelativeImport,
  isAbsoluteImportIntoAnotherProject,
  isBuiltinModuleImport,
  isConstraintBanningProject,
  isRelative,
  normalizeProjectRoot,
} from "./specifiers.mjs";

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

  it("stays silent about a package the constraint does not name", () => {
    expect(isConstraintBanningProject(pkg, { bannedExternalImports: ["*"] }, "@other/thing")).toBe(
      false,
    );
  });

  it("is not banned when the constraint carries neither list", () => {
    expect(isConstraintBanningProject(pkg, { sourceTag: "zone:x" }, "@vendor/shell")).toBe(false);
  });
});
