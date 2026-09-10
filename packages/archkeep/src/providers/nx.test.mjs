import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { readProjectGraph } from "./nx.mjs";

const root = mkdtempSync(join(tmpdir(), "archkeep-nx-provider-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Carries every top-level key the provider contract names, not only `nodes`:
// the first test asserts deep equality against this whole object, so a
// `readProjectGraph` that quietly dropped `dependencies` (or a field like
// `workspaceLayout` that a future Nx emits) goes red here instead of
// surfacing as rules silently evaluating an edgeless graph.
const graph = {
  nodes: {
    outer: { name: "outer", type: "lib", data: { root: "libs/outer" } },
    inner: { name: "inner", type: "lib", data: { root: "libs/outer/inner" } },
  },
  dependencies: {
    outer: [{ source: "outer", target: "inner", type: "static" }],
  },
  workspaceLayout: { appsDir: "apps", libsDir: "libs" },
};

describe("reading the project graph", () => {
  it("asks Nx for the graph as JSON and returns its nodes and dependencies", () => {
    const run = (_file, args, cwd) => {
      expect(cwd).toBe(root);
      expect(args).toContain("graph");
      const target = args.find((arg) => arg.startsWith("--file="))?.slice("--file=".length);
      writeFileSync(target, JSON.stringify({ graph }));
      return "";
    };
    expect(readProjectGraph(root, { run })).toEqual(graph);
  });

  it("fails loudly on a graph with no projects, rather than judging a tree it cannot see", () => {
    const run = (_file, args) => {
      const target = args.find((arg) => arg.startsWith("--file="))?.slice("--file=".length);
      writeFileSync(target, JSON.stringify({ graph: {} }));
      return "";
    };
    expect(() => readProjectGraph(root, { run })).toThrow(/no `graph.nodes`/);
  });

  it("names the missing peer instead of surfacing a raw MODULE_NOT_FOUND, when nx is not installed", () => {
    // `nx` is a real, installed dependency of THIS repository, so nothing
    // above can drive the "not installed" path without faking the resolver —
    // this is the silent-direction case the M0 gate exists to pin: a bare
    // `require.resolve` failure here would otherwise reach the CLI as an
    // unnamed `MODULE_NOT_FOUND` stack, indistinguishable from this tool's own
    // bug rather than an absent optional peer.
    const resolveNx = () => {
      throw Object.assign(new Error("Cannot find module 'nx/package.json'"), {
        code: "MODULE_NOT_FOUND",
      });
    };
    // `run` must never be reached: the failure happens before there is
    // anything to spawn, so a `run` that throws proves it was never called.
    const run = () => {
      throw new Error("run should not have been called — nx resolution must fail first");
    };
    expect(() => readProjectGraph(root, { run, resolveNx })).toThrow(
      /^archkeep: nx is not installed/,
    );
  });

  it("lets a resolver failure that is not MODULE_NOT_FOUND surface as itself", () => {
    // An installed nx whose `exports` map stopped exposing `./package.json`
    // fails resolution with a different code. Calling that "nx is not
    // installed" would send the reader to install a package they already
    // have — the wrapper claims only the absent-package case.
    const resolveNx = () => {
      throw Object.assign(new Error("Package subpath './package.json' is not defined by exports"), {
        code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
      });
    };
    const run = () => {
      throw new Error("run should not have been called — nx resolution must fail first");
    };
    expect(() => readProjectGraph(root, { run, resolveNx })).toThrow(
      /^Package subpath '\.\/package\.json' is not defined by exports/,
    );
  });
});

describe("merging nx.json's workspaceLayout onto the graph", () => {
  // `nx graph --file=` itself emits no `workspaceLayout` (this file's own
  // header, and `readProjectGraph`'s) — every `run` below writes a graph with
  // none, so these tests exercise the merge step alone rather than a fixture
  // that accidentally does the merge's job for it.
  const graphWithoutLayout = {
    nodes: { outer: { name: "outer", type: "lib", data: { root: "libs/outer" } } },
    dependencies: { outer: [] },
  };
  const runWritingLayoutlessGraph = (_file, args) => {
    const target = args.find((arg) => arg.startsWith("--file="))?.slice("--file=".length);
    writeFileSync(target, JSON.stringify({ graph: graphWithoutLayout }));
    return "";
  };

  it("a declared, complete layout is present on the returned graph", () => {
    const declared = { appsDir: "applications", libsDir: "packages" };
    const result = readProjectGraph(root, {
      run: runWritingLayoutlessGraph,
      readLayout: () => declared,
    });
    expect(result.workspaceLayout).toEqual(declared);
  });

  it("nothing declared leaves `workspaceLayout` absent from the graph, not defaulted", () => {
    // Silent direction: an always-present defaulted object here would erase
    // the declared-vs-undeclared distinction `readLayout` exists to preserve —
    // every caller downstream (`../rules/index.mjs`'s `DEFAULT_WORKSPACE_LAYOUT`
    // fallback) would then be judging against a value this test never proved
    // the workspace actually declared. `readLayout` is an injectable seam
    // precisely so this case is testable with no `nx.json` on disk at all.
    const result = readProjectGraph(root, {
      run: runWritingLayoutlessGraph,
      readLayout: () => null,
    });
    expect("workspaceLayout" in result).toBe(false);
  });

  it("a readLayout failure propagates out of readProjectGraph rather than being swallowed", () => {
    const readLayout = () => {
      throw new Error("archkeep: nx.json's workspaceLayout must be an object, got string");
    };
    expect(() => readProjectGraph(root, { run: runWritingLayoutlessGraph, readLayout })).toThrow(
      /workspaceLayout must be an object/,
    );
  });

  it("a declared-but-incomplete layout throws rather than silently defaulting the missing key", () => {
    // The parity refusal `requireCompleteWorkspaceLayout` (`../options.mjs`)
    // exists for: `../rules/specifiers.mjs`'s `isAbsoluteImportIntoAnotherProject`
    // reads both `appsDir` and `libsDir` off one object with no per-key
    // fallback, so an `appsDir`-less object here would silently evaluate
    // every `apps/…` import against `undefined` instead of refusing —
    // exactly the silent direction the invariant rules out, and the same
    // refusal `../providers/native/model.mjs` already applies to
    // `archkeep.json`'s identically-shaped field.
    const result = () =>
      readProjectGraph(root, {
        run: runWritingLayoutlessGraph,
        readLayout: () => ({ libsDir: "packages" }),
      });
    expect(result).toThrow(/workspaceLayout declares libsDir but is missing appsDir/);
  });
});

describe("refusing drifted project nodes", () => {
  // `nx graph --file=` output is forwarded to the rules layer unmodified, and
  // every node field is read verbatim there (`data.root` →
  // `../rules/specifiers.mjs`'s `createProjectRootMappings`, `type` →
  // `../rules/index.mjs`'s project-node filter, `data.tags` →
  // `../rules/tags.mjs`). Nx 23.2.0's own contract — `type` exactly one of
  // `app`/`e2e`/`lib`, `data` a configuration with a string `root` and, when
  // present, a `tags` array — is what each mutated node below drifts from. The
  // refusal must name the drifter: a bare shape error deep in evaluation would
  // name neither the project nor the field, exactly the silent direction this
  // suite exists to pin.
  const healthy = {
    name: "alpha",
    type: "lib",
    data: { root: "libs/alpha", tags: ["layer:domain"] },
  };
  const runWritingGraph = (nodes) => (_file, args) => {
    const target = args.find((arg) => arg.startsWith("--file="))?.slice("--file=".length);
    writeFileSync(target, JSON.stringify({ graph: { nodes, dependencies: {} } }));
    return "";
  };
  const drift = (mutated) => ({
    alpha: mutated,
    beta: { name: "beta", type: "lib", data: { root: "libs/beta", tags: [] } },
  });

  it("refuses a node whose type is not one of app, lib, e2e, naming the project", () => {
    expect(() =>
      readProjectGraph(root, { run: runWritingGraph(drift({ ...healthy, type: "application" })) }),
    ).toThrow(/node 'alpha' has type "application" .* expected one of "app", "e2e", "lib"/);
  });

  it("refuses a node whose data is missing, naming the project", () => {
    const { data, ...withoutData } = healthy;
    void data;
    expect(() => readProjectGraph(root, { run: runWritingGraph(drift(withoutData)) })).toThrow(
      /node 'alpha' has no data object/,
    );
  });

  it("refuses a node whose data.root is missing, naming the project", () => {
    expect(() =>
      readProjectGraph(root, {
        run: runWritingGraph(drift({ ...healthy, data: { tags: ["layer:domain"] } })),
      }),
    ).toThrow(/node 'alpha' has no string data\.root/);
  });

  it("refuses a node whose data.tags is a string, not an array, naming the project", () => {
    expect(() =>
      readProjectGraph(root, {
        run: runWritingGraph(
          drift({ ...healthy, data: { root: "libs/alpha", tags: "layer:domain" } }),
        ),
      }),
    ).toThrow(
      /node 'alpha' has data\.tags of type string .* expected an array of non-empty strings/,
    );
  });

  it("refuses a node whose data.tags carries a non-string entry, naming it", () => {
    expect(() =>
      readProjectGraph(root, {
        run: runWritingGraph(
          drift({ ...healthy, data: { root: "libs/alpha", tags: ["layer:domain", 7] } }),
        ),
      }),
    ).toThrow(/node 'alpha' has data\.tags\[1\].*got a number/);
  });

  it("refuses a node whose data.tags carries an empty string entry, naming it", () => {
    expect(() =>
      readProjectGraph(root, {
        run: runWritingGraph(
          drift({ ...healthy, data: { root: "libs/alpha", tags: ["layer:domain", ""] } }),
        ),
      }),
    ).toThrow(/node 'alpha' has data\.tags\[1\].*got an empty string/);
  });

  it("refuses a node that is not an object, naming the project", () => {
    expect(() => readProjectGraph(root, { run: runWritingGraph(drift(null)) })).toThrow(
      /node 'alpha' is not an object/,
    );
  });

  it("refuses a graph.nodes that is not a project map, rather than judging an empty one", () => {
    // `Object.entries([])` is empty, so an array would flow downstream as "no
    // projects" — the same silent emptiness the no-`graph.nodes` guard refuses.
    expect(() => readProjectGraph(root, { run: runWritingGraph([]) })).toThrow(
      /no `graph\.nodes` object/,
    );
  });
});
