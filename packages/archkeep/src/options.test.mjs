import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LANGUAGE_BY_EXTENSION } from "./analysis/registry.mjs";

import {
  DEFAULT_OPTIONS,
  MOON_TSCONFIG_CHAIN,
  MOON_TSCONFIG_SOURCE,
  pluginIsRegistered,
  readMoonOptions,
  readPluginOptions,
  readWorkspaceLayout,
  requireCompleteWorkspaceLayout,
  resolveOptions,
} from "./options.mjs";

/** An `nx.json` reader over an in-memory tree, in `readPluginOptions`'s shape. */
const treeWith = (files) => ({ readFile: (path) => files[path] ?? null });

/**
 * What a workspace that declared nothing resolves to: the two convention
 * filenames, plus the provenance saying so. The names are derived from
 * `DEFAULT_OPTIONS` so a convention change moves both sides at once; the
 * provenance is written out, because it is the half under test and a
 * self-deriving `boundaryConfigDeclared` would pin nothing.
 */
const NOTHING_DECLARED = { ...DEFAULT_OPTIONS, boundaryConfigDeclared: false };

describe("readMoonOptions — the tsconfig chain a Moon workspace has instead of a declaration", () => {
  // The paths `readMoonOptions` tests are the ones IT builds
  // (`join(root, name)`), so the injected predicate matches on exactly those —
  // the same convention `./providers/moon.test.mjs` uses for `moonMarkerAt`.
  const rootHolding = (...names) => {
    const present = new Set(names.map((name) => join("/ws", name)));
    return (path) => present.has(path);
  };
  /** A file list that fails the test if it is ever asked for. */
  const unaskedFileList = () => {
    throw new Error("the file list was spent on a workspace that already has a tsconfig");
  };

  it("resolves tsconfig.json in a workspace that has no tsconfig.base.json", () => {
    // The silent direction, and the whole reason the chain exists: fixed at
    // the first name alone, this workspace reads a file that is not there,
    // falls through to the compiler defaults, and every aliased import in it
    // resolves to nothing — a report full of crossings on a tree that may have
    // none. `./providers/moon.test.mjs` drives the same fixture through the
    // real resolver and pins the paths table that comes back.
    const options = readMoonOptions("/ws", {
      exists: rootHolding("tsconfig.json"),
      listFiles: unaskedFileList,
    });
    expect(options).toEqual({
      boundaryConfig: DEFAULT_OPTIONS.boundaryConfig,
      tsConfig: "tsconfig.json",
      tsConfigSource: MOON_TSCONFIG_SOURCE,
      boundaryConfigDeclared: false,
    });
  });

  it("keeps tsconfig.base.json ahead of tsconfig.json when the workspace carries both", () => {
    // The chain is ORDERED, not "whichever we find". A Vue or Angular Moon
    // workspace usually carries both — the root `tsconfig.json` extending the
    // base one — and picking by discovery order would make the verdict depend
    // on the order two names happen to be written in this file.
    const options = readMoonOptions("/ws", {
      exists: rootHolding("tsconfig.base.json", "tsconfig.json"),
      listFiles: unaskedFileList,
    });
    expect(options.tsConfig).toBe("tsconfig.base.json");
    expect(MOON_TSCONFIG_CHAIN.indexOf("tsconfig.base.json")).toBeLessThan(
      MOON_TSCONFIG_CHAIN.indexOf("tsconfig.json"),
    );
  });

  it("names the file it chose, and says the name was convention rather than a declaration", () => {
    // Requirement's first half: a fallback that picks silently is a fact the
    // reader cannot see. The same checkout on two machines — one of them with
    // an untracked `tsconfig.json` — resolves two different paths tables, and
    // with only a name carried, nothing downstream can tell a stated name from
    // a picked one. `tsConfigSource` is that fact, the same shape
    // `./commands/graph.mjs`'s `workspaceLayoutSource` is to `workspaceLayout`
    // — and its absence on the Nx and native options is what makes it mean
    // something here.
    const chosen = readMoonOptions("/ws", {
      exists: rootHolding("tsconfig.json"),
      listFiles: unaskedFileList,
    });
    expect(chosen.tsConfig).toBe("tsconfig.json");
    expect(chosen.tsConfigSource).toBe(MOON_TSCONFIG_SOURCE);
    expect(resolveOptions(undefined)).not.toHaveProperty("tsConfigSource");
  });

  it("refuses, naming both candidates, when neither is there and the tree needs one", () => {
    // Requirement 3, and a deliberate change: before this, such a tree was
    // judged against TypeScript's compiler defaults and reported a crossing
    // for every internal import — measured at several hundred findings on a
    // 94-project workspace with no architecture violation in it. Silence in
    // the loud direction is still silence about the cause: nothing in that
    // report said the paths table had never been found.
    expect(() =>
      readMoonOptions("/ws", {
        exists: rootHolding(".moon"),
        listFiles: () => ["libs/core/index.ts", "apps/web/App.vue", "README.md"],
      }),
    ).toThrow(/tsconfig\.base\.json or tsconfig\.json/u);
  });

  it("does not refuse a Go, Rust and Python workspace for a config nothing in it reads", () => {
    // The other error direction, and it is a real one: those three resolve
    // through their own manifests and never read a tsconfig, so refusing here
    // would break every polyglot Moon workspace that has no TypeScript in it
    // at all. The name carried is the chain's FIRST entry, so the watcher list
    // derived from it still covers the file whose arrival would change the
    // answer.
    const options = readMoonOptions("/ws", {
      exists: rootHolding(".moon"),
      listFiles: () => ["libs/core/main.go", "libs/api/lib.rs", "svc/app/__init__.py"],
    });
    expect(options.tsConfig).toBe(MOON_TSCONFIG_CHAIN[0]);
    expect(options.tsConfigSource).toBe(MOON_TSCONFIG_SOURCE);
  });

  it("does not refuse a plain-JavaScript workspace, which needs no tsconfig at all", () => {
    // The narrowing, and the reason the trigger is a list of EXTENSIONS
    // rather than the obvious list of languages: `LANGUAGE_BY_EXTENSION`
    // maps `.js`, `.jsx`, `.mjs` and `.cjs` to `typescript`, so a
    // language-keyed test refuses this tree — and refusing it is a
    // REGRESSION, not a hardening. JavaScript needs no tsconfig, most such
    // trees have never had one, and every specifier below resolves correctly
    // against the compiler defaults today. Turning a run that is currently
    // right into exit 3 is the one thing this guard must not do.
    const options = readMoonOptions("/ws", {
      exists: rootHolding(".moon"),
      listFiles: () => ["libs/core/index.js", "apps/web/main.mjs", "tools/build.cjs"],
    });
    expect(options.tsConfig).toBe(MOON_TSCONFIG_CHAIN[0]);
    expect(options.tsConfigSource).toBe(MOON_TSCONFIG_SOURCE);
  });

  it("triggers on no extension the analyzer registry does not claim", () => {
    // `TSCONFIG_RESOLVED_EXTENSIONS` is a second copy of extension knowledge
    // `./analysis/registry.mjs` owns. The refusal filter runs `languageOf`
    // first, so the copy can only ever NARROW what the registry claimed —
    // this is what pins that, and it is why the probe set reaches OUTSIDE the
    // registry. An earlier version of this test built its probe set from
    // `Object.keys(LANGUAGE_BY_EXTENSION)` alone and was vacuous in exactly
    // the direction it names: adding `.svelte` to the copy left it green,
    // because `.svelte` was never probed.
    //
    // Derived by probing the exported behaviour rather than by importing the
    // constant: a test that imported it would pin the copy against itself.
    const probes = [...Object.keys(LANGUAGE_BY_EXTENSION), ".svelte", ".json", ".md", ".txt", ""];
    const triggering = probes.filter((extension) => {
      try {
        readMoonOptions("/ws", {
          exists: rootHolding(".moon"),
          listFiles: () => [`libs/core/file${extension}`],
        });
        return false;
      } catch {
        return true;
      }
    });

    // Non-empty is the half that goes red if the refusal stops firing at all.
    expect(triggering.length).toBeGreaterThan(0);
    // And every extension that DOES trigger is one the registry claims for a
    // language that resolves through the paths table.
    for (const extension of triggering) {
      expect(["typescript", "vue"]).toContain(LANGUAGE_BY_EXTENSION[extension]);
    }
    // Named outright, so the narrowing is pinned as a list and not only as a
    // property: these are TypeScript-proper plus Vue, and no JavaScript.
    expect(triggering.sort()).toEqual([".cts", ".mts", ".ts", ".tsx", ".vue"]);
  });

  it("never spends the file list on a workspace that already carries a tsconfig", () => {
    // `listFiles` is a thunk for this: on the language server it is a git
    // spawn, and an ordinary Moon session must not pay a second one per
    // invalidation to answer a question the first `exists` already settled.
    expect(() =>
      readMoonOptions("/ws", {
        exists: rootHolding("tsconfig.base.json"),
        listFiles: unaskedFileList,
      }),
    ).not.toThrow();
  });
});

describe("resolveOptions", () => {
  it("defaults both filenames to the Nx conventions", () => {
    // The point of the defaults: a workspace that follows Nx's conventions
    // registers the plugin and writes no options at all.
    expect(resolveOptions(undefined)).toEqual({
      boundaryConfig: "module-boundaries.config.mjs",
      tsConfig: "tsconfig.base.json",
      boundaryConfigDeclared: false,
    });
    expect(resolveOptions(null)).toEqual(NOTHING_DECLARED);
    expect(resolveOptions({})).toEqual(NOTHING_DECLARED);
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
      boundaryConfigDeclared: false,
    });
    expect(resolveOptions({ boundaryConfig: "boundaries.mjs" })).toEqual({
      boundaryConfig: "boundaries.mjs",
      tsConfig: "tsconfig.base.json",
      boundaryConfigDeclared: true,
    });
  });

  it("reports whether boundaryConfig was declared, independently of the value it resolved to", () => {
    // The whole point of the bit, and the case that makes it necessary rather
    // than derivable: these two resolve to the SAME `boundaryConfig` string
    // and mean opposite things. The first workspace never wrote a law and is
    // entitled to be answered on; the second named one, and a `graph` run that
    // cannot find that file is looking at a law somebody renamed or deleted.
    // Nothing downstream of this function can tell them apart from the value.
    const defaulted = resolveOptions({});
    const declaredTheDefaultName = resolveOptions({
      boundaryConfig: DEFAULT_OPTIONS.boundaryConfig,
    });
    expect(declaredTheDefaultName.boundaryConfig).toBe(defaulted.boundaryConfig);
    expect(defaulted.boundaryConfigDeclared).toBe(false);
    expect(declaredTheDefaultName.boundaryConfigDeclared).toBe(true);
  });

  it("does not treat a declared tsConfig — or a declared profiles registry — as a declared law", () => {
    // The narrow reading is the load-bearing one. `boundaryConfigDeclared`
    // answers for exactly one key; a workspace that renamed its tsconfig, or
    // one that enforces by profile name, has still not named a boundary-law
    // FILE, and reading either as "declared" would refuse `graph` on a tree
    // that never had a law — the #265 direction, back again by a side door.
    expect(resolveOptions({ tsConfig: "tsconfig.json" }).boundaryConfigDeclared).toBe(false);
    expect(resolveOptions({ profiles: "profiles.json" }).boundaryConfigDeclared).toBe(false);
  });

  it("refuses boundaryConfigDeclared as an input — provenance is computed, never asserted", () => {
    // It is not in `DEFAULT_OPTIONS`, which is also the known-key roster, so
    // it lands on the unknown-key throw like any other misspelling. A
    // workspace able to write its own provenance could declare a law it never
    // named and re-open the silent path from the other end.
    expect(() => resolveOptions({ boundaryConfigDeclared: true })).toThrow(
      /unknown plugin option 'boundaryConfigDeclared'/,
    );
    expect(Object.keys(DEFAULT_OPTIONS)).not.toContain("boundaryConfigDeclared");
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
    expect(readPluginOptions("/w", treeWith({}))).toEqual(NOTHING_DECLARED);
  });

  it("defaults when nx.json declares no plugins, or none of them is this one", () => {
    expect(readPluginOptions("/w", treeWith({ "/w/nx.json": "{}" }))).toEqual(NOTHING_DECLARED);
    expect(
      readPluginOptions(
        "/w",
        treeWith({ "/w/nx.json": '{"plugins":["@nx/eslint/plugin","./tools/other.mjs"]}' }),
      ),
    ).toEqual(NOTHING_DECLARED);
  });

  it("reads the options off this plugin's entry, however the entry names it", () => {
    // Three legitimate spellings of the same plugin's Nx face: the published
    // subpath once it resolves from the registry, an in-repo path to that same
    // subpath, and that path without the `.mjs`. Requiring one would make the
    // options invisible in the other two — and invisible options mean the
    // defaults, silently.
    for (const specifier of [
      "@ecoma-io/archkeep/nx",
      "./packages/archkeep/nx.mjs",
      "./packages/archkeep/nx",
      "archkeep/nx",
    ]) {
      const nxJson = JSON.stringify({
        plugins: [{ plugin: specifier, options: { tsConfig: "tsconfig.root.json" } }],
      });
      expect(readPluginOptions("/w", treeWith({ "/w/nx.json": nxJson })), specifier).toEqual({
        boundaryConfig: "module-boundaries.config.mjs",
        tsConfig: "tsconfig.root.json",
        boundaryConfigDeclared: false,
      });
    }
  });

  it("accepts the bare-string plugin form as declaring no options", () => {
    // Nx's older registration shape. It carries no options, which is different
    // from carrying bad ones.
    expect(
      readPluginOptions("/w", treeWith({ "/w/nx.json": '{"plugins":["@ecoma-io/archkeep/nx"]}' })),
    ).toEqual(NOTHING_DECLARED);
  });

  it("defaults on the bare engine specifier, since that entry never loaded a plugin", () => {
    // `@ecoma-io/archkeep` (no `/nx`) resolves to the engine entry, whose
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
            plugins: [
              { plugin: "@ecoma-io/archkeep", options: { tsConfig: "tsconfig.root.json" } },
            ],
          }),
        }),
      ),
    ).toEqual(NOTHING_DECLARED);
  });

  it("carries the declared/defaulted provenance out of nx.json, not just the filename", () => {
    // The four ways an Nx tree reaches `boundaryConfig`, and which of them is
    // the workspace naming its own law. Only the last one is: the other three
    // resolve to the identical string by convention, and a `graph` run that
    // cannot find that file on any of them is looking at a workspace that has
    // not written a law yet (#265) rather than one whose law went missing.
    const declaredBy = (nxJson) =>
      readPluginOptions("/w", treeWith(nxJson === null ? {} : { "/w/nx.json": nxJson }))
        .boundaryConfigDeclared;
    expect(declaredBy(null)).toBe(false);
    expect(declaredBy('{"plugins":["archkeep/nx"]}')).toBe(false);
    expect(
      declaredBy(
        JSON.stringify({
          plugins: [{ plugin: "archkeep/nx", options: { tsConfig: "tsconfig.root.json" } }],
        }),
      ),
    ).toBe(false);
    expect(
      declaredBy(
        JSON.stringify({
          plugins: [
            // Deliberately the convention filename: the value is identical to
            // the default, and the provenance still has to differ.
            { plugin: "archkeep/nx", options: { boundaryConfig: DEFAULT_OPTIONS.boundaryConfig } },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("tolerates a trailing slash on the workspace root", () => {
    const nxJson = JSON.stringify({
      plugins: [{ plugin: "archkeep/nx", options: { boundaryConfig: "law.mjs" } }],
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
      '"plugins":[{"plugin":"archkeep/nx","options":{"boundaryConfig":"law.mjs"},}],\n}';
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
      plugins: [{ plugin: "archkeep/nx", options: { tsconfigBase: "tsconfig.base.json" } }],
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
    // which refuses the identical shape for `archkeep.json`.
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
    // partial `archkeep.json` workspaceLayout onto a default either — it
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
      pluginIsRegistered("/w", treeWith({ "/w/nx.json": '{"plugins":["@ecoma-io/archkeep/nx"]}' })),
    ).toBe(true);
  });

  it("is true for the {plugin, options} object form", () => {
    const nxJson = JSON.stringify({
      plugins: [{ plugin: "@ecoma-io/archkeep/nx", options: { tsConfig: "tsconfig.root.json" } }],
    });
    expect(pluginIsRegistered("/w", treeWith({ "/w/nx.json": nxJson }))).toBe(true);
  });

  it("is true for an in-repo path ending '/nx', with or without the extension", () => {
    for (const specifier of ["./packages/archkeep/nx.mjs", "./packages/archkeep/nx"]) {
      const nxJson = JSON.stringify({ plugins: [specifier] });
      expect(pluginIsRegistered("/w", treeWith({ "/w/nx.json": nxJson })), specifier).toBe(true);
    }
  });

  it("is false on the bare engine specifier — that entry never loaded a plugin", () => {
    // The silent-direction case this function exists to catch: a workspace
    // that typed "@ecoma-io/archkeep" (missing "/nx") registered nothing, and
    // `nx affected` under-selects Go/Rust/Python with no warning at all. A
    // weaker test that only checked the true cases would pass just as well if
    // this predicate matched every string containing "archkeep".
    const nxJson = JSON.stringify({ plugins: ["@ecoma-io/archkeep"] });
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
