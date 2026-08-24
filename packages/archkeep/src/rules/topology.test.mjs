import { describe, expect, it } from "vitest";

import {
  appIsMFERemote,
  belongsToDifferentEntryPoint,
  circularViolation,
  createFileDependencyIndex,
  entryPointOf,
  findDynamicImportPath,
  findFilesInCircularPath,
  findFilesWithDynamicImports,
  hasBuildExecutor,
  hasDynamicImport,
  isDirectDependency,
  lazyLoadedViolation,
} from "./topology.mjs";
import { buildReachability, expandIgnoredCircularDependencies } from "./reachability.mjs";

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

describe("findDynamicImportPath", () => {
  // The walk is the one `hasDynamicImport` was, so its cases are mirrored here
  // one shape richer — a predicate answers yes/no, this names the route, and
  // `lazyLoadedViolation` renders evidence from the route it decided on.
  const graph = {
    dependencies: {
      a: [{ source: "a", target: "b", type: "dynamic" }],
      b: [{ source: "b", target: "c", type: "static" }],
    },
  };
  /** The dynamic-edge cycle fixture, shared by the equivalence test below. */
  const cyclic = {
    dependencies: {
      a: [{ source: "a", target: "b", type: "dynamic" }],
      b: [{ source: "b", target: "a", type: "dynamic" }],
    },
  };

  it("returns the pair itself for a direct dynamic edge", () => {
    expect(findDynamicImportPath(graph, "a", "b")).toEqual(["a", "b"]);
  });

  it("returns the full chain through an intermediate project", () => {
    const chained = {
      dependencies: {
        a: [{ source: "a", target: "g", type: "dynamic" }],
        g: [{ source: "g", target: "z", type: "dynamic" }],
      },
    };
    expect(findDynamicImportPath(chained, "a", "z")).toEqual(["a", "g", "z"]);
  });

  it("skips static edges at every hop", () => {
    expect(findDynamicImportPath(graph, "a", "c")).toBeNull();
  });

  it("answers null when no path exists", () => {
    expect(findDynamicImportPath(graph, "b", "a")).toBeNull();
    expect(findDynamicImportPath(graph, "missing", "a")).toBeNull();
  });

  it("terminates on a cycle of dynamic edges and answers null", () => {
    expect(findDynamicImportPath(cyclic, "a", "z")).toBeNull();
  });

  it("agrees with hasDynamicImport on every graph above — one walk, two faces", () => {
    // The equivalence IS the fix for #281's first half: if these ever diverge,
    // the rule fires on a chain whose files it then cannot name.
    for (const g of [graph, cyclic]) {
      for (const [from, to] of [
        ["a", "b"],
        ["a", "c"],
        ["a", "z"],
        ["b", "a"],
      ]) {
        expect(hasDynamicImport(g, from, to)).toBe(findDynamicImportPath(g, from, to) !== null);
      }
    }
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

describe("appIsMFERemote", () => {
  it("returns true when data.mfeRemote is true", () => {
    expect(appIsMFERemote(project("a", { mfeRemote: true }))).toBe(true);
  });

  it("returns false when data.mfeRemote is absent — fails closed", () => {
    expect(appIsMFERemote(project("a"))).toBe(false);
  });

  it("returns false when data.mfeRemote is false", () => {
    expect(appIsMFERemote(project("a", { mfeRemote: false }))).toBe(false);
  });
});

describe("circularViolation", () => {
  const alpha = project("alpha");
  const beta = project("beta");
  const graph = {
    nodes: { alpha, beta },
    dependencies: {
      alpha: [{ source: "alpha", target: "beta", type: "static" }],
      beta: [{ source: "beta", target: "alpha", type: "static" }],
    },
  };
  const reach = buildReachability(graph);
  const edges = [
    {
      sourceFile: "area/alpha/src/index.ts",
      sourceProject: "alpha",
      targetProject: "beta",
      dynamic: false,
    },
    {
      sourceFile: "area/beta/src/index.ts",
      sourceProject: "beta",
      targetProject: "alpha",
      dynamic: false,
    },
  ];
  const fileIndex = createFileDependencyIndex(edges);
  const noIgnored = new Map();

  it("returns null when there is no cycle", () => {
    const acyclic = {
      nodes: { alpha, beta },
      dependencies: {
        alpha: [{ source: "alpha", target: "beta", type: "static" }],
      },
    };
    const acyclicReach = buildReachability(acyclic);
    expect(
      circularViolation({
        reach: acyclicReach,
        graph: acyclic,
        sourceProject: alpha,
        targetProject: beta,
        sourceFile: "area/alpha/src/index.ts",
        fileIndex,
        ignored: noIgnored,
      }),
    ).toBeNull();
  });

  it("returns a violation when a cycle exists", () => {
    const result = circularViolation({
      reach,
      graph,
      sourceProject: alpha,
      targetProject: beta,
      sourceFile: "area/alpha/src/index.ts",
      fileIndex,
      ignored: noIgnored,
    });
    expect(result).not.toBeNull();
    expect(result.messageId).toBe("noCircularDependencies");
  });

  it("returns null when the cycle is excused by ignoredCircularDependencies", () => {
    const ignored = expandIgnoredCircularDependencies([["alpha", "beta"]], graph, () => [
      "alpha",
      "beta",
    ]);
    expect(
      circularViolation({
        reach,
        graph,
        sourceProject: alpha,
        targetProject: beta,
        sourceFile: "area/alpha/src/index.ts",
        fileIndex,
        ignored,
      }),
    ).toBeNull();
  });

  it("carries sourceProjectName, targetProjectName, path and filePaths in data", () => {
    const result = circularViolation({
      reach,
      graph,
      sourceProject: alpha,
      targetProject: beta,
      sourceFile: "area/alpha/src/index.ts",
      fileIndex,
      ignored: noIgnored,
    });
    expect(result.data).toMatchObject({
      sourceProjectName: "alpha",
      targetProjectName: "beta",
    });
    expect(result.data.path).toContain("alpha");
    expect(result.data.path).toContain("beta");
    expect(typeof result.data.filePaths).toBe("string");
  });
});

describe("lazyLoadedViolation", () => {
  const alpha = project("alpha");
  const beta = project("beta");
  const graph = {
    nodes: { alpha, beta },
    dependencies: {
      alpha: [{ source: "alpha", target: "beta", type: "dynamic" }],
    },
  };
  const edges = [
    {
      sourceFile: "area/alpha/src/index.ts",
      sourceProject: "alpha",
      targetProject: "beta",
      dynamic: true,
    },
  ];
  const fileIndex = createFileDependencyIndex(edges);

  it("returns null when there is no dynamic import path", () => {
    const staticGraph = {
      nodes: { alpha, beta },
      dependencies: {
        alpha: [{ source: "alpha", target: "beta", type: "static" }],
      },
    };
    expect(
      lazyLoadedViolation({
        graph: staticGraph,
        sourceProject: alpha,
        targetProject: beta,
        resolvedFile: "area/beta/src/index.ts",
        fileIndex,
      }),
    ).toBeNull();
  });

  it("returns a violation when a static import hits a lazy-loaded lib", () => {
    const result = lazyLoadedViolation({
      graph,
      sourceProject: alpha,
      targetProject: beta,
      resolvedFile: "area/beta/src/index.ts",
      fileIndex,
    });
    expect(result).not.toBeNull();
    expect(result.messageId).toBe("noImportsOfLazyLoadedLibraries");
  });

  it("returns null when the target has a secondary entry point (exempt)", () => {
    const withEntryPoint = project("beta", {
      entryPoints: [{ path: "area/beta/sub", file: "area/beta/sub/index.ts" }],
    });
    const graphWithEntry = {
      nodes: { alpha, beta: withEntryPoint },
      dependencies: {
        alpha: [{ source: "alpha", target: "beta", type: "dynamic" }],
      },
    };
    expect(
      lazyLoadedViolation({
        graph: graphWithEntry,
        sourceProject: alpha,
        targetProject: withEntryPoint,
        resolvedFile: "area/beta/sub/index.ts",
        fileIndex,
      }),
    ).toBeNull();
  });

  it("carries targetProjectName and the exact file line in data", () => {
    const result = lazyLoadedViolation({
      graph,
      sourceProject: alpha,
      targetProject: beta,
      resolvedFile: "area/beta/src/index.ts",
      fileIndex,
    });
    expect(result.data).toMatchObject({
      targetProjectName: "beta",
    });
    // Pinned byte for byte: this rendering is the golden a consumer's snapshot
    // or suppression workflow leans on, so only the cases that printed nothing
    // before may ever change its shape.
    expect(result.data.filePaths).toBe("- area/alpha/src/index.ts");
  });

  it("names every hop's file, each annotated with the chain, when the path is transitive", () => {
    // #281's shape: the predicate walked alpha -> gamma -> beta while the
    // evidence lookup read only the direct pair key — a violation announced
    // with an empty list. Evidence now comes off the same walk.
    const gamma = project("gamma");
    const transitiveGraph = {
      nodes: { alpha, beta, gamma },
      dependencies: {
        alpha: [{ source: "alpha", target: "gamma", type: "dynamic" }],
        gamma: [{ source: "gamma", target: "beta", type: "dynamic" }],
      },
    };
    const hopEdges = [
      {
        sourceFile: "area/alpha/src/lazy.ts",
        sourceProject: "alpha",
        targetProject: "gamma",
        dynamic: true,
      },
      {
        sourceFile: "area/gamma/src/loader.ts",
        sourceProject: "gamma",
        targetProject: "beta",
        dynamic: true,
      },
    ];
    const result = lazyLoadedViolation({
      graph: transitiveGraph,
      sourceProject: alpha,
      targetProject: beta,
      resolvedFile: "area/beta/src/index.ts",
      fileIndex: createFileDependencyIndex(hopEdges),
    });
    expect(result).not.toBeNull();
    expect(result.data.filePaths).toBe(
      "- area/alpha/src/lazy.ts (alpha -> gamma -> beta)\n- area/gamma/src/loader.ts (alpha -> gamma -> beta)",
    );
  });

  it("says the chain has no analyzed file behind it instead of printing an empty list", () => {
    // The silent direction made explicit: the graph edge is real (detection
    // never depended on the index), but nothing analyzed names a file on it.
    // An empty string here would read as "checked, clean".
    const result = lazyLoadedViolation({
      graph,
      sourceProject: alpha,
      targetProject: beta,
      resolvedFile: "area/beta/src/index.ts",
      fileIndex: createFileDependencyIndex([]),
    });
    expect(result).not.toBeNull();
    expect(typeof result.data.filePaths).toBe("string");
    expect(result.data.filePaths.startsWith("(")).toBe(true);
    expect(result.data.filePaths).toContain("->");
    expect(result.data.filePaths).toContain("alpha -> beta");
  });
});
