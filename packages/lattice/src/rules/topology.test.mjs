import { describe, expect, it } from "vitest";

import {
  belongsToDifferentEntryPoint,
  createFileDependencyIndex,
  entryPointOf,
  findFilesInCircularPath,
  findFilesWithDynamicImports,
  hasBuildExecutor,
  hasDynamicImport,
  isDirectDependency,
} from "./topology.mjs";

const project = (name, data = {}) => ({
  name,
  type: "lib",
  data: { root: `area/${name}`, tags: [], ...data },
});

describe("hasBuildExecutor", () => {
  it("accepts a project declaring one of the named build targets", () => {
    expect(
      hasBuildExecutor(project("a", { targets: { bundle: { executor: "x:y" } } }), ["bundle"]),
    ).toBe(true);
  });

  it("rejects a target declared with an empty executor", () => {
    expect(hasBuildExecutor(project("a", { targets: { build: { executor: "" } } }))).toBe(false);
  });

  it("rejects a project with no targets at all", () => {
    expect(hasBuildExecutor(project("a"))).toBe(false);
  });
});

describe("entryPointOf", () => {
  const entryPoints = [
    { path: "area/a/sub", file: "area/a/sub/index.ts" },
    { path: "area/a/deep/nested", file: "area/a/deep/nested/index.ts" },
  ];

  it("recognises a file that is itself an entry point", () => {
    expect(entryPointOf("area/a/sub/index.ts", "area/a", entryPoints)).toBe("area/a/sub/index.ts");
  });

  it("finds no entry point for a file merely sitting under one, as upstream does not either", () => {
    // Upstream compares a directory that always ends in `/` against an entry
    // point path that never does, so this branch cannot match for entry points
    // built the way it builds them. Kept identical: "no entry point" is the
    // answer that leaves the self-import and lazy-load rules armed.
    expect(entryPointOf("area/a/deep/nested/lib/thing.ts", "area/a", entryPoints)).toBeUndefined();
  });

  it("walks up to a directory entry point that is spelled with a trailing slash", () => {
    expect(
      entryPointOf("area/a/sub/lib/thing.ts", "area/a", [
        { path: "area/a/sub/", file: "area/a/sub/index.ts" },
      ]),
    ).toBe("area/a/sub/index.ts");
  });

  it("answers undefined for a project that declares none", () => {
    expect(entryPointOf("area/a/src/thing.ts", "area/a", undefined)).toBeUndefined();
    expect(entryPointOf("area/a/src/thing.ts", "area/a", [])).toBeUndefined();
  });

  it("terminates for a file outside the project root instead of walking forever", () => {
    expect(entryPointOf("elsewhere/thing.ts", "area/a", entryPoints)).toBeUndefined();
  });
});

describe("belongsToDifferentEntryPoint", () => {
  const withEntryPoints = project("a", {
    entryPoints: [{ path: "area/a/sub", file: "area/a/sub/index.ts" }],
  });

  it("is true when the import lands in an entry point the source file is not in", () => {
    expect(
      belongsToDifferentEntryPoint("area/a/sub/index.ts", "area/a/src/index.ts", withEntryPoints),
    ).toBe(true);
  });

  it("is false when both sides are the same entry point", () => {
    expect(
      belongsToDifferentEntryPoint("area/a/sub/index.ts", "area/a/sub/index.ts", withEntryPoints),
    ).toBe(false);
  });

  it("is false when the project declares no entry points, which keeps the rule armed", () => {
    expect(
      belongsToDifferentEntryPoint("area/a/src/thing.ts", "area/a/src/index.ts", project("a")),
    ).toBe(false);
  });
});

describe("hasDynamicImport", () => {
  const graph = {
    dependencies: {
      a: [{ source: "a", target: "b", type: "dynamic" }],
      b: [{ source: "b", target: "c", type: "static" }],
    },
  };

  it("finds a direct dynamic edge", () => {
    expect(hasDynamicImport(graph, "a", "b")).toBe(true);
  });

  it("does not follow a static edge", () => {
    expect(hasDynamicImport(graph, "a", "c")).toBe(false);
  });

  it("terminates on a cycle of dynamic edges", () => {
    const cyclic = {
      dependencies: {
        a: [{ source: "a", target: "b", type: "dynamic" }],
        b: [{ source: "b", target: "a", type: "dynamic" }],
      },
    };
    expect(hasDynamicImport(cyclic, "a", "z")).toBe(false);
  });
});

describe("isDirectDependency", () => {
  const packageNode = { name: "npm:pkg", type: "npm", data: { packageName: "pkg" } };

  it("accepts a package the project's manifests declare", () => {
    expect(isDirectDependency(project("a", { declaredPackages: ["pkg"] }), packageNode)).toBe(true);
  });

  it("rejects a package they do not", () => {
    expect(isDirectDependency(project("a", { declaredPackages: ["other"] }), packageNode)).toBe(
      false,
    );
  });

  it("rejects when there is no declaration data to check against", () => {
    // Failing closed: an unprovable claim is not a proof.
    expect(isDirectDependency(project("a"), packageNode)).toBe(false);
  });
});

describe("createFileDependencyIndex", () => {
  const edges = [
    { sourceFile: "area/a/one.ts", sourceProject: "a", targetProject: "b", dynamic: false },
    { sourceFile: "area/a/two.ts", sourceProject: "a", targetProject: "b", dynamic: true },
    { sourceFile: "area/a/two.ts", sourceProject: "a", targetProject: "b", dynamic: true },
    { sourceFile: "area/a/self.ts", sourceProject: "a", targetProject: "a", dynamic: false },
    { sourceFile: "area/a/ext.ts", sourceProject: "a", targetProject: null, dynamic: false },
  ];

  it("lists each file once per edge it carries", () => {
    const index = createFileDependencyIndex(edges);
    expect(findFilesInCircularPath(index, [{ name: "a" }, { name: "b" }])).toEqual([
      ["area/a/one.ts", "area/a/two.ts"],
    ]);
  });

  it("keeps the dynamic edges apart from the rest", () => {
    expect(findFilesWithDynamicImports(createFileDependencyIndex(edges), "a", "b")).toEqual([
      "area/a/two.ts",
    ]);
  });

  it("holds no entry for a hop nothing analyzed carries", () => {
    const index = createFileDependencyIndex(edges);
    expect(findFilesInCircularPath(index, [{ name: "b" }, { name: "a" }])).toEqual([[]]);
    expect(findFilesWithDynamicImports(index, "b", "a")).toEqual([]);
  });
});
