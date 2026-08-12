import { describe, expect, it } from "vitest";

import { DEFAULT_OPTIONS, readPluginOptions, resolveOptions } from "./options.mjs";

/** An `nx.json` reader over an in-memory tree, in `readPluginOptions`'s shape. */
const treeWith = (files) => ({ readFile: (path) => files[path] ?? null });

describe("resolveOptions", () => {
  it("defaults both filenames to the Nx conventions", () => {
    // The point of the defaults: a workspace that follows Nx's conventions
    // registers the plugin and writes no options at all.
    expect(resolveOptions(undefined)).toEqual({
      boundaryConfig: "module-boundaries.config.mjs",
      tsConfig: "tsconfig.base.json",
    });
    expect(resolveOptions(null)).toEqual(DEFAULT_OPTIONS);
    expect(resolveOptions({})).toEqual(DEFAULT_OPTIONS);
  });

  it("returns a fresh object, so one caller cannot move another's defaults", () => {
    const first = resolveOptions({});
    first.tsConfig = "moved.json";
    expect(resolveOptions({}).tsConfig).toBe("tsconfig.base.json");
    expect(DEFAULT_OPTIONS.tsConfig).toBe("tsconfig.base.json");
  });

  it("takes each declared filename over its default, independently", () => {
    expect(resolveOptions({ tsConfig: "tsconfig.json" })).toEqual({
      boundaryConfig: "module-boundaries.config.mjs",
      tsConfig: "tsconfig.json",
    });
    expect(resolveOptions({ boundaryConfig: "boundaries.mjs" })).toEqual({
      boundaryConfig: "boundaries.mjs",
      tsConfig: "tsconfig.base.json",
    });
  });

  it("throws on a misspelled key rather than falling back to the default", () => {
    // The load-bearing case. `tsconfigBase` silently ignored is a full green
    // run against a rule nobody wrote: no path alias resolves, every aliased
    // import reads as unresolvable-or-external, and nothing says why.
    expect(() => resolveOptions({ tsconfigBase: "tsconfig.base.json" })).toThrow(
      /unknown plugin option 'tsconfigBase'/,
    );
    // The message has to name the alternatives, because the fix is a rename and
    // the reader needs the spelling.
    expect(() => resolveOptions({ tsconfigBase: "x" })).toThrow(/boundaryConfig, tsConfig/);
  });

  it("throws on an empty or non-string filename", () => {
    // `""` would build `<root>/` and hand a directory to `import()`, failing
    // far from the typo that caused it.
    expect(() => resolveOptions({ tsConfig: "" })).toThrow(/must be a non-empty string/);
    expect(() => resolveOptions({ boundaryConfig: 7 })).toThrow(/must be a non-empty string/);
    expect(() => resolveOptions({ boundaryConfig: null })).toThrow(/must be a non-empty string/);
  });

  it("throws when the options are not an object at all", () => {
    expect(() => resolveOptions("module-boundaries.config.mjs")).toThrow(/must be an object/);
    expect(() => resolveOptions(["module-boundaries.config.mjs"])).toThrow(/got an array/);
  });
});

describe("readPluginOptions", () => {
  it("defaults when the tree has no nx.json", () => {
    // The CLI and the language server both run in trees that never registered
    // the plugin. That is not the silent fallback the unknown-key check
    // refuses — nothing was declared, so nothing can be misspelled.
    expect(readPluginOptions("/w", treeWith({}))).toEqual(DEFAULT_OPTIONS);
  });

  it("defaults when nx.json declares no plugins, or none of them is this one", () => {
    expect(readPluginOptions("/w", treeWith({ "/w/nx.json": "{}" }))).toEqual(DEFAULT_OPTIONS);
    expect(
      readPluginOptions(
        "/w",
        treeWith({ "/w/nx.json": '{"plugins":["@nx/eslint/plugin","./tools/other.mjs"]}' }),
      ),
    ).toEqual(DEFAULT_OPTIONS);
  });

  it("reads the options off this plugin's entry, however the entry names it", () => {
    // Three legitimate spellings of the same plugin's Nx face: the published
    // subpath once it resolves from the registry, an in-repo path to that same
    // subpath, and that path without the `.mjs`. Requiring one would make the
    // options invisible in the other two — and invisible options mean the
    // defaults, silently.
    for (const specifier of [
      "@ecoma-io/lattice/nx",
      "./packages/lattice/nx.mjs",
      "./packages/lattice/nx",
      "lattice/nx",
    ]) {
      const nxJson = JSON.stringify({
        plugins: [{ plugin: specifier, options: { tsConfig: "tsconfig.root.json" } }],
      });
      expect(readPluginOptions("/w", treeWith({ "/w/nx.json": nxJson })), specifier).toEqual({
        boundaryConfig: "module-boundaries.config.mjs",
        tsConfig: "tsconfig.root.json",
      });
    }
  });

  it("accepts the bare-string plugin form as declaring no options", () => {
    // Nx's older registration shape. It carries no options, which is different
    // from carrying bad ones.
    expect(
      readPluginOptions("/w", treeWith({ "/w/nx.json": '{"plugins":["@ecoma-io/lattice/nx"]}' })),
    ).toEqual(DEFAULT_OPTIONS);
  });

  it("defaults on the bare engine specifier, since that entry never loaded a plugin", () => {
    // `@ecoma-io/lattice` (no `/nx`) resolves to the engine entry, which
    // exports neither `name` nor `createDependencies` — Nx would not have run
    // this plugin at all. Matching it here would read options for a plugin
    // that was never registered, which is a different silent failure than the
    // one the unknown-key check refuses.
    expect(
      readPluginOptions(
        "/w",
        treeWith({
          "/w/nx.json": JSON.stringify({
            plugins: [{ plugin: "@ecoma-io/lattice", options: { tsConfig: "tsconfig.root.json" } }],
          }),
        }),
      ),
    ).toEqual(DEFAULT_OPTIONS);
  });

  it("tolerates a trailing slash on the workspace root", () => {
    const nxJson = JSON.stringify({
      plugins: [{ plugin: "lattice/nx", options: { boundaryConfig: "law.mjs" } }],
    });
    expect(readPluginOptions("/w/", treeWith({ "/w/nx.json": nxJson })).boundaryConfig).toBe(
      "law.mjs",
    );
  });

  it("reads an nx.json Nx accepts but JSON.parse does not", () => {
    // Nx reads this file through jsonc-parser, so a comment or a trailing comma
    // is an nx.json Nx HAS. Falling back to the defaults here would read the
    // boundary law from a filename this workspace stopped using.
    const nxJson =
      "{\n// the plugin that reads Go, Rust and Python\n" +
      '"plugins":[{"plugin":"lattice/nx","options":{"boundaryConfig":"law.mjs"},}],\n}';
    expect(readPluginOptions("/w", treeWith({ "/w/nx.json": nxJson })).boundaryConfig).toBe(
      "law.mjs",
    );
  });

  it("throws on an nx.json neither parser can read", () => {
    expect(() => readPluginOptions("/w", treeWith({ "/w/nx.json": "{ this is not json" }))).toThrow(
      /cannot read \/w\/nx\.json/,
    );
  });

  it("throws on a bad option in an entry that IS present", () => {
    // The distinction the two branches above draw, from the other side: an
    // absent registration defaults, a present one with a typo fails.
    const nxJson = JSON.stringify({
      plugins: [{ plugin: "lattice/nx", options: { tsconfigBase: "tsconfig.base.json" } }],
    });
    expect(() => readPluginOptions("/w", treeWith({ "/w/nx.json": nxJson }))).toThrow(
      /unknown plugin option 'tsconfigBase'/,
    );
  });
});
