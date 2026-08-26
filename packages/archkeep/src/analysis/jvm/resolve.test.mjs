import { describe, expect, it } from "vitest";

import {
  JAVA_DEFAULT_IMPORT_ROOTS,
  KOTLIN_DEFAULT_IMPORT_ROOTS,
  defaultImportRootsFor,
  resolveJvmSpecifier,
  underAnyRoot,
} from "./resolve.mjs";

/** An index with one unambiguous project, one split name, one deep package. */
const index = new Map([
  ["com.acme", [{ project: "acme", file: "a/A.java" }]],
  ["com.acme.core", [{ project: "core", file: "c/C.java" }]],
  [
    "shared.thing",
    [
      { project: "left", file: "l/L.java" },
      { project: "right", file: "r/R.java" },
    ],
  ],
]);

describe("resolveJvmSpecifier", () => {
  const java = { language: "java" };

  it("resolves a first-party import to its owning project", () => {
    expect(resolveJvmSpecifier("com.acme.core.util.Lists", java, index)).toEqual({
      target: "core",
      external: false,
      packageName: null,
    });
  });

  it("falls back to the shallowest claimed prefix's project", () => {
    expect(resolveJvmSpecifier("com.acme.tools.Helper", java, index)).toEqual({
      target: "acme",
      external: false,
      packageName: null,
    });
  });

  it("reports an ambiguity naming every claimant, resolving nothing", () => {
    const resolved = resolveJvmSpecifier("shared.thing.Widget", java, index);
    expect(resolved.target).toBeNull();
    expect(resolved.external).toBe(false);
    expect(resolved.ambiguous).toEqual(["left", "right"]);
    expect(resolved.matchedPrefix).toBe("shared.thing");
  });

  it("classifies an unknown name external with the full written name", () => {
    // Where group ends and artifact begins is not statically knowable; the
    // whole name stands in so bannedExternalImports globs match prefixes.
    expect(resolveJvmSpecifier("org.apache.commons.lang3.StringUtils", java, index)).toEqual({
      target: null,
      external: true,
      packageName: "org.apache.commons.lang3.StringUtils",
      byDefaultImport: false,
    });
  });

  it("marks a default-import root as external by table, not by accident", () => {
    expect(resolveJvmSpecifier("java.lang.String", java, index).byDefaultImport).toBe(true);
    // Sub-packages are NOT covered by the root — they need their own imports
    // and classify as ordinary externals.
    expect(resolveJvmSpecifier("java.util.List", java, index).byDefaultImport).toBe(false);
  });

  it("applies the Kotlin table to Kotlin files without changing the mechanics", () => {
    const kotlin = { language: "kotlin" };
    expect(resolveJvmSpecifier("kotlin.math.abs", kotlin, index)).toEqual({
      target: null,
      external: true,
      packageName: "kotlin.math.abs",
      byDefaultImport: true,
    });
    expect(resolveJvmSpecifier("java.lang.String", kotlin, index).byDefaultImport).toBe(true);
    expect(resolveJvmSpecifier("com.acme.core.Thing", kotlin, index).target).toBe("core");
  });
});

describe("default-import tables", () => {
  it("keeps Java's table to its single documented root", () => {
    expect([...JAVA_DEFAULT_IMPORT_ROOTS]).toEqual(["java.lang"]);
  });

  it("carries Kotlin's nine stdlib roots plus the platform sets", () => {
    expect([...KOTLIN_DEFAULT_IMPORT_ROOTS].filter((root) => root.startsWith("kotlin"))).toEqual([
      "kotlin",
      "kotlin.annotation",
      "kotlin.collections",
      "kotlin.comparisons",
      "kotlin.io",
      "kotlin.ranges",
      "kotlin.sequences",
      "kotlin.text",
      "kotlin.math",
      "kotlin.jvm",
      "kotlin.js",
    ]);
  });

  it("answers unknown languages with an empty table, never a throw", () => {
    expect(defaultImportRootsFor("cobol")).toEqual([]);
  });
});

describe("underAnyRoot", () => {
  it("matches equal names and segment-delimited children only", () => {
    expect(underAnyRoot("java.lang.String", ["java.lang"])).toBe(true);
    expect(underAnyRoot("java.lang", ["java.lang"])).toBe(true);
    // A plain prefix test would call this a match and misclassify it.
    expect(underAnyRoot("java.langx.Utils", ["java.lang"])).toBe(false);
  });
});
