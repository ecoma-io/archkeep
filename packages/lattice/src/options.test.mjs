import { describe, expect, it } from "vitest";

import {
  DEFAULT_OPTIONS,
  pluginIsRegistered,
  readPluginOptions,
  readWorkspaceLayout,
  requireCompleteWorkspaceLayout,
  resolveOptions,
} from "./options.mjs";

/** An `nx.json` reader over an in-memory tree, in `readPluginOptions`'s shape. */
const treeWith = (files) => ({ readFile: (path) => files[path] ?? null });

describe("resolveOptions", () => {
  it("defaults both filenames to the Nx conventions", () => {
    // The point of the defaults: a workspace that follows Nx's conventions
    // registers the plugin and writes no options at all.
    expect(resolveOptions(undefined)).toEqual({
      boundaryConfig: "module-boundaries.config.mjs",
      tsConfig: "tsconfig.base.json",
      intentConfig: "architecture-intent.config.mjs",
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
      intentConfig: "architecture-intent.config.mjs",
    });
    expect(resolveOptions({ boundaryConfig: "boundaries.mjs" })).toEqual({
      boundaryConfig: "boundaries.mjs",
      tsConfig: "tsconfig.base.json",
      intentConfig: "architecture-intent.config.mjs",
    });
    expect(resolveOptions({ intentConfig: "intent.mjs" })).toEqual({
      boundaryConfig: "module-boundaries.config.mjs",
      tsConfig: "tsconfig.base.json",
      intentConfig: "intent.mjs",
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
        intentConfig: "architecture-intent.config.mjs",
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
    // `@ecoma-io/lattice` (no `/nx`) resolves to the engine entry, whose
    // `createDependencies` only throws (`index.mjs`) — Nx loads it and fails
    // loudly at the first graph computation, so this plugin never ran.
    // Matching it here would read options for a plugin that was never
    // registered, which is a different silent failure than the one the
    // unknown-key check refuses.
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

describe("readWorkspaceLayout", () => {
  it("returns a partial declaration verbatim, never merged with a default", () => {
    // The caller has to be able to tell "declared the default" from
    // "declared nothing" — merging here would destroy that distinction.
    expect(
      readWorkspaceLayout(
        "/w",
        treeWith({ "/w/nx.json": '{"workspaceLayout":{"libsDir":"packages"}}' }),
      ),
    ).toEqual({ libsDir: "packages" });
  });

  it("returns null when nx.json declares no workspaceLayout key", () => {
    expect(readWorkspaceLayout("/w", treeWith({ "/w/nx.json": "{}" }))).toBeNull();
  });

  it("returns null when the tree has no nx.json at all", () => {
    expect(readWorkspaceLayout("/w", treeWith({}))).toBeNull();
  });

  it("throws when workspaceLayout is not an object", () => {
    // Silent direction: reading a malformed value as "no layout declared"
    // would drop the rule back to the default layout on exactly the
    // workspace whose configuration is wrong.
    expect(() =>
      readWorkspaceLayout("/w", treeWith({ "/w/nx.json": '{"workspaceLayout":"packages"}' })),
    ).toThrow(/workspaceLayout must be an object/);
  });

  it("throws on a non-string workspaceLayout value", () => {
    expect(() =>
      readWorkspaceLayout("/w", treeWith({ "/w/nx.json": '{"workspaceLayout":{"libsDir":5}}' })),
    ).toThrow(/workspaceLayout\.libsDir must be a non-empty string/);
  });

  it("throws on an empty-string workspaceLayout value", () => {
    expect(() =>
      readWorkspaceLayout("/w", treeWith({ "/w/nx.json": '{"workspaceLayout":{"libsDir":""}}' })),
    ).toThrow(/workspaceLayout\.libsDir must be a non-empty string/);
  });

  it("throws on a workspaceLayout key this tool does not know, rather than ignoring it", () => {
    // Parity with `./providers/native/model.mjs`'s `workspaceLayoutViolations`,
    // which refuses the identical shape for `lattice.json`.
    expect(() =>
      readWorkspaceLayout("/w", treeWith({ "/w/nx.json": '{"workspaceLayout":{"srcDir":"src"}}' })),
    ).toThrow(/workspaceLayout\.srcDir is not a workspaceLayout field/);
  });

  it("reads through an nx.json Nx accepts but JSON.parse does not", () => {
    const nxJson = '{\n// a comment\n"workspaceLayout":{"libsDir":"packages","appsDir":"apps"},\n}';
    expect(readWorkspaceLayout("/w", treeWith({ "/w/nx.json": nxJson }))).toEqual({
      libsDir: "packages",
      appsDir: "apps",
    });
  });

  it("throws on an nx.json neither parser can read — the same message shape readPluginOptions produces", () => {
    expect(() =>
      readWorkspaceLayout("/w", treeWith({ "/w/nx.json": "{ this is not json" })),
    ).toThrow(/cannot read \/w\/nx\.json/);
  });
});

describe("requireCompleteWorkspaceLayout", () => {
  it("passes null through unchanged", () => {
    expect(requireCompleteWorkspaceLayout(null)).toBeNull();
  });

  it("passes a complete declaration through unchanged", () => {
    const declared = { appsDir: "applications", libsDir: "packages" };
    expect(requireCompleteWorkspaceLayout(declared)).toEqual(declared);
  });

  it("throws on a partial declaration, naming what is present and what is missing", () => {
    // The parity refusal: `./providers/native/model.mjs` never merges a
    // partial `lattice.json` workspaceLayout onto a default either — it
    // refuses the whole file. A caller here defaulting the missing key would
    // let the Nx path disagree with the native path on the same declared
    // object, which is exactly what this function exists to rule out.
    expect(() => requireCompleteWorkspaceLayout({ libsDir: "packages" })).toThrow(
      /workspaceLayout declares libsDir but is missing appsDir/,
    );
    expect(() => requireCompleteWorkspaceLayout({ appsDir: "applications" })).toThrow(
      /workspaceLayout declares appsDir but is missing libsDir/,
    );
  });
});

describe("pluginIsRegistered", () => {
  it("is true for the bare-string form", () => {
    expect(
      pluginIsRegistered("/w", treeWith({ "/w/nx.json": '{"plugins":["@ecoma-io/lattice/nx"]}' })),
    ).toBe(true);
  });

  it("is true for the {plugin, options} object form", () => {
    const nxJson = JSON.stringify({
      plugins: [{ plugin: "@ecoma-io/lattice/nx", options: { tsConfig: "tsconfig.root.json" } }],
    });
    expect(pluginIsRegistered("/w", treeWith({ "/w/nx.json": nxJson }))).toBe(true);
  });

  it("is true for an in-repo path ending '/nx', with or without the extension", () => {
    for (const specifier of ["./packages/lattice/nx.mjs", "./packages/lattice/nx"]) {
      const nxJson = JSON.stringify({ plugins: [specifier] });
      expect(pluginIsRegistered("/w", treeWith({ "/w/nx.json": nxJson })), specifier).toBe(true);
    }
  });

  it("is false on the bare engine specifier — that entry never loaded a plugin", () => {
    // The silent-direction case this function exists to catch: a workspace
    // that typed "@ecoma-io/lattice" (missing "/nx") registered nothing, and
    // `nx affected` under-selects Go/Rust/Python with no warning at all. A
    // weaker test that only checked the true cases would pass just as well if
    // this predicate matched every string containing "lattice".
    const nxJson = JSON.stringify({ plugins: ["@ecoma-io/lattice"] });
    expect(pluginIsRegistered("/w", treeWith({ "/w/nx.json": nxJson }))).toBe(false);
  });

  it("is false when nx.json has no plugins key, or no nx.json at all", () => {
    expect(pluginIsRegistered("/w", treeWith({ "/w/nx.json": "{}" }))).toBe(false);
    expect(pluginIsRegistered("/w", treeWith({}))).toBe(false);
  });

  it("throws on an nx.json neither parser can read — the same posture as readPluginOptions", () => {
    expect(() =>
      pluginIsRegistered("/w", treeWith({ "/w/nx.json": "{ this is not json" })),
    ).toThrow(/cannot read \/w\/nx\.json/);
  });
});
