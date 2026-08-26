import { describe, expect, it } from "vitest";

import { resolveCsharpSpecifier } from "./resolve.mjs";

/** An index shaped exactly like `csharpNamespaceIndex` output. */
const index = new Map([
  ["Alpha.Core", [{ project: "alpha", file: "libs/alpha/core.cs" }]],
  ["Alpha.Core.Sub", [{ project: "alpha", file: "libs/alpha/sub.cs" }]],
  [
    "Common.Shared",
    [
      { project: "alpha", file: "libs/alpha/s1.cs" },
      { project: "beta", file: "libs/beta/s2.cs" },
    ],
  ],
]);

describe("resolveCsharpSpecifier", () => {
  it("resolves an exact declared namespace to its single owner", () => {
    expect(resolveCsharpSpecifier("Alpha.Core", index)).toEqual({
      target: "alpha",
      external: false,
      packageName: null,
    });
  });

  it("resolves a deeper specifier by its longest declared prefix", () => {
    expect(resolveCsharpSpecifier("Alpha.Core.Widget", index)).toEqual({
      target: "alpha",
      external: false,
      packageName: null,
    });
  });

  it("prefers the deepest declaration over a shallower one from another project", () => {
    // `Alpha.Core.Sub` is alpha's; a shallow-first answer would still be
    // right here, so pin the discipline where the projects DISAGREE.
    const mixed = new Map([
      ["Top", [{ project: "outer", file: "libs/o/o.cs" }]],
      ["Top.Deep", [{ project: "inner", file: "libs/i/i.cs" }]],
    ]);
    expect(resolveCsharpSpecifier("Top.Deep.Thing", mixed).target).toBe("inner");
    expect(resolveCsharpSpecifier("Top.Other", mixed).target).toBe("outer");
  });

  it("reports every claimant when several projects declare the deepest matched prefix", () => {
    const resolved = resolveCsharpSpecifier("Common.Shared.Util", index);
    expect(resolved.target).toBeNull();
    expect(resolved.external).toBe(false);
    expect(resolved.ambiguous.sort()).toEqual(["alpha", "beta"]);
    expect(resolved.matchedPrefix).toBe("Common.Shared");
  });

  it("classifies everything else external with the whole written name as packageName", () => {
    expect(resolveCsharpSpecifier("System.Collections.Generic", index)).toEqual({
      target: null,
      external: true,
      packageName: "System.Collections.Generic",
    });
    expect(resolveCsharpSpecifier("Serilog.Configuration", index).packageName).toBe(
      "Serilog.Configuration",
    );
  });

  it("keeps segment boundaries — a name that merely starts with a prefix does not match it", () => {
    expect(resolveCsharpSpecifier("Alpha.CoreX.Y", index)).toEqual({
      target: null,
      external: true,
      packageName: "Alpha.CoreX.Y",
    });
  });
});
