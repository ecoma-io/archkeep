import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { readProjectGraph } from "./nx.mjs";

const root = mkdtempSync(join(tmpdir(), "lattice-nx-provider-"));
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
      /^lattice: nx is not installed/,
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
