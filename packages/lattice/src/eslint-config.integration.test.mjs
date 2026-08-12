// Drives `loadEslintBoundaryConfig` and the `config.mjs` dispatch that reaches
// it against REAL files on disk and a REAL, installed `@nx/eslint-plugin` —
// the pure unit tests in `eslint-config.test.mjs` cover `extractBoundaryRule`
// alone, over in-memory arrays; this file is what proves the plugin-defaults
// half and the end-to-end dispatch actually work, per the M3b spec's §8
// done-ness list.
//
// Two fixture roots, deliberately in different places, because a real
// `require("@nx/eslint-plugin")` resolves by walking a file's OWN ancestor
// directories for `node_modules` — every directory under this package
// resolves it whether a test wants that or not, because
// `packages/lattice/node_modules/@nx/eslint-plugin` is this workspace's own
// real, hoisted install (this package now declares the plugin as an optional
// peer, per `package.json`). So:
//
//   - `fixtureRoot()` (plugin present) is a `mkdtemp` directory INSIDE this
//     package, which reaches that real install through the ordinary ancestor
//     walk — no copying, no symlinking, the same route a consumer's own
//     workspace root would use for its own copy.
//   - `pluginlessFixtureRoot()` (plugin absent — refusal #1's fixture) is a
//     `mkdtemp` directory under the OS temp dir instead, the same isolation
//     `packages/lattice/src/conformance/fixture.mjs` uses for its own
//     throwaway trees: no ancestor of `/tmp` carries a `node_modules` at all,
//     so this is the one fixture shape that can actually exercise "the
//     plugin does not resolve" for real, rather than asserting on a mock.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { loadBoundaryConfigFile } from "./config.mjs";
import { loadEslintBoundaryConfig } from "./eslint-config.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

/** Every fixture directory created this run, removed in `afterEach`. */
const created = [];
afterEach(() => {
  while (created.length > 0) rmSync(created.pop(), { recursive: true, force: true });
});

/**
 * A throwaway directory inside this package — `@nx/eslint-plugin` resolves
 * from it through the ordinary ancestor `node_modules` walk, reaching this
 * workspace's own real install.
 *
 * @returns {string} absolute path of the fixture root.
 */
function fixtureRoot() {
  const root = mkdtempSync(join(packageRoot, ".eslint-config-fixture-"));
  created.push(root);
  return root;
}

/**
 * A throwaway directory under the OS temp dir — no ancestor carries a
 * `node_modules`, so `@nx/eslint-plugin` genuinely does not resolve from it.
 * The fixture for refusal #1.
 *
 * @returns {string} absolute path of the fixture root.
 */
function pluginlessFixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "lattice-eslint-config-no-plugin-"));
  created.push(root);
  return root;
}

/**
 * A throwaway directory under the OS temp dir carrying a fake
 * `@nx/eslint-plugin` in its own `node_modules`, so a test can shadow this
 * workspace's real, hoisted install with a chosen `index.cjs` body — Node's
 * ancestor `node_modules` walk checks the nearest directory first.
 *
 * @param {string} indexBody The CommonJS source `index.cjs` gets.
 * @returns {string} absolute path of the fixture root.
 */
function fakePluginFixtureRoot(indexBody) {
  const root = mkdtempSync(join(tmpdir(), "lattice-eslint-config-fake-plugin-"));
  created.push(root);
  const pluginDir = join(root, "node_modules", "@nx", "eslint-plugin");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, "package.json"),
    JSON.stringify({ name: "@nx/eslint-plugin", version: "0.0.0", main: "index.cjs" }),
  );
  writeFileSync(join(pluginDir, "index.cjs"), indexBody);
  return root;
}

/** Writes `eslint.config.mjs` in `root`, exporting `flatConfigSource` as-is. */
function writeFlatConfig(root, flatConfigSource, filename = "eslint.config.mjs") {
  const path = join(root, filename);
  writeFileSync(path, `export default ${flatConfigSource};\n`);
  return path;
}

const CONSTRAINED = `[{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:util"] }]`;

describe("loadEslintBoundaryConfig — real plugin, real files", () => {
  it("reads the constraint table and merges unstated options with the installed plugin's defaults", async () => {
    const root = fixtureRoot();
    const path = writeFlatConfig(
      root,
      `[{ rules: { "@nx/enforce-module-boundaries": ["error", { depConstraints: ${CONSTRAINED} }] } }]`,
    );
    const { depConstraints, options } = await loadEslintBoundaryConfig(path);

    expect(depConstraints).toEqual([
      { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:util"] },
    ]);
    // The one default this workspace's installed @nx/eslint-plugin does NOT
    // hold at its falsy/empty zero-value — a merge that silently dropped
    // defaults (or read them all as `false`/`[]` by coincidence) goes red on
    // this assertion and no other in this file.
    expect(options.buildTargets).toEqual(["build"]);
    // The rest are this package's actual measured defaults, asserted so a
    // regression in the strip-then-merge order is visible: a `depConstraints`
    // default of `[]` merged AFTER the stated table would erase it, which
    // `depConstraints` above already disproves, but the option bag itself
    // must carry none of the plugin's own `depConstraints` key at all.
    expect(options).not.toHaveProperty("depConstraints");
    expect(options.allow).toEqual([]);
    expect(options.enforceBuildableLibDependency).toBe(false);
  });

  it("lets a stated option override the installed plugin's default", async () => {
    const root = fixtureRoot();
    const path = writeFlatConfig(
      root,
      `[{ rules: { "@nx/enforce-module-boundaries": ["error", ` +
        `{ depConstraints: ${CONSTRAINED}, buildTargets: ["build", "e2e-build"] }] } }]`,
    );
    const { options } = await loadEslintBoundaryConfig(path);
    expect(options.buildTargets).toEqual(["build", "e2e-build"]);
  });

  it("refuses when @nx/eslint-plugin does not resolve from the workspace root — never falls back to a built-in table", async () => {
    const root = pluginlessFixtureRoot();
    const path = writeFlatConfig(
      root,
      `[{ rules: { "@nx/enforce-module-boundaries": ["error", { depConstraints: ${CONSTRAINED} }] } }]`,
    );
    await expect(loadEslintBoundaryConfig(path)).rejects.toThrow(
      /@nx\/eslint-plugin does not resolve/u,
    );
  });

  it("refuses a rule switched off, rather than reading it as an empty, fully-permissive table", async () => {
    const root = fixtureRoot();
    const path = writeFlatConfig(root, `[{ rules: { "@nx/enforce-module-boundaries": "off" } }]`);
    await expect(loadEslintBoundaryConfig(path)).rejects.toThrow(/switched off/u);
  });

  it("refuses a rule entry scoped under files with a directory component, naming the files value and the entry", async () => {
    const root = fixtureRoot();
    const path = writeFlatConfig(
      root,
      `[{ files: ["apps/**/*.ts"], rules: { "@nx/enforce-module-boundaries": ["error", { depConstraints: ${CONSTRAINED} }] } }]`,
    );
    await expect(loadEslintBoundaryConfig(path)).rejects.toThrow(/files/u);
  });

  it("accepts a files entry whose every glob is a bare source-extension pattern — the nx g @nx/eslint shape (B1)", async () => {
    const root = fixtureRoot();
    const path = writeFlatConfig(
      root,
      `[{ files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"], ` +
        `rules: { "@nx/enforce-module-boundaries": ["error", { depConstraints: ${CONSTRAINED} }] } }]`,
    );
    const { depConstraints, note } = await loadEslintBoundaryConfig(path);
    expect(depConstraints).toHaveLength(1);
    expect(note).toMatch(/scopes @nx\/enforce-module-boundaries under files/);
  });

  it("refuses when the plugin resolves and loads but its rule exposes no defaultOptions to ground the unstated options against (S5)", async () => {
    const root = fakePluginFixtureRoot(
      // Resolves and loads without throwing, but the rule it exposes carries
      // no `defaultOptions` — the shape this reader has no fallback for.
      'module.exports = { rules: { "enforce-module-boundaries": {} } };\n',
    );
    const path = writeFlatConfig(
      root,
      `[{ rules: { "@nx/enforce-module-boundaries": ["error", { depConstraints: ${CONSTRAINED} }] } }]`,
    );
    await expect(loadEslintBoundaryConfig(path)).rejects.toThrow(/exposes no default options/u);
  });

  it("refuses when the plugin resolves but throws while its own entry point runs — a different problem than 'does not resolve'", async () => {
    const root = fakePluginFixtureRoot(
      // Simulates an incompatible dependency of the plugin's own throwing
      // while its module body executes, distinct from the package simply not
      // being installed.
      'throw new Error("boom: incompatible dependency");\n',
    );
    const path = writeFlatConfig(
      root,
      `[{ rules: { "@nx/enforce-module-boundaries": ["error", { depConstraints: ${CONSTRAINED} }] } }]`,
    );
    await expect(loadEslintBoundaryConfig(path)).rejects.toThrow(/could not be loaded/u);
    await expect(loadEslintBoundaryConfig(path)).rejects.not.toThrow(/does not resolve/u);
  });

  it("refuses when the config throws on import, with the cause rather than a bare crash", async () => {
    const root = fixtureRoot();
    const path = join(root, "eslint.config.mjs");
    // A real flat config reading a relative file at import time — the shape
    // `differential-real-trees-child.mjs`'s header records for code-pushup's
    // own config reading `.node-version`.
    writeFileSync(
      path,
      `import { readFileSync } from "node:fs";\n` +
        `readFileSync(new URL("./does-not-exist", import.meta.url));\n` +
        `export default [];\n`,
    );
    await expect(loadEslintBoundaryConfig(path)).rejects.toThrow(/cannot load/u);
  });
});

describe("loadBoundaryConfigFile dispatching to the ESLint dialect (config.mjs)", () => {
  it("routes an eslint.config.* boundaryConfig through the flat-config reader and validates the result the same way the .mjs dialect does", async () => {
    const root = fixtureRoot();
    const path = writeFlatConfig(
      root,
      `[{ rules: { "@nx/enforce-module-boundaries": ["error", { depConstraints: ${CONSTRAINED} }] } }]`,
    );
    const { depConstraints, options, suppressions } = await loadBoundaryConfigFile(path);
    expect(depConstraints).toHaveLength(1);
    expect(Object.keys(options).sort()).toEqual(
      [
        "allow",
        "allowCircularSelfDependency",
        "banTransitiveDependencies",
        "buildTargets",
        "checkDynamicDependenciesExceptions",
        "checkNestedExternalImports",
        "enforceBuildableLibDependency",
        "ignoredCircularDependencies",
      ].sort(),
    );
    // No mapping exists from the eslint dialect to boundarySuppressions — see
    // `config.mjs`'s dispatch and this module's own header.
    expect(suppressions).toEqual([]);
  });

  it("reuses the SAME row validator the .mjs dialect uses, so a malformed constraint row is refused identically", async () => {
    const root = fixtureRoot();
    // A row naming neither sourceTag nor allSourceTags matches no project and
    // would silently approve every import — `findBoundaryConfigViolations`
    // refuses it for the .mjs dialect today, and the eslint dialect must
    // route through the identical check rather than a second opinion.
    const path = writeFlatConfig(
      root,
      `[{ rules: { "@nx/enforce-module-boundaries": ["error", { depConstraints: [{ onlyDependOnLibsWithTags: ["layer:util"] }] }] } }]`,
    );
    await expect(loadBoundaryConfigFile(path)).rejects.toThrow(
      /exactly one of 'sourceTag' or 'allSourceTags'/u,
    );
  });

  it("refuses a legacy .eslintrc.json boundaryConfig by name, naming the flat config as what is supported", async () => {
    const root = fixtureRoot();
    const path = join(root, ".eslintrc.json");
    writeFileSync(path, "{}\n");
    await expect(loadBoundaryConfigFile(path)).rejects.toThrow(/flat config/u);
    await expect(loadBoundaryConfigFile(path)).rejects.toThrow(/legacy ESLint config/u);
  });

  it("refuses a legacy .eslintrc.js boundaryConfig the same way, before ever importing it", async () => {
    const root = fixtureRoot();
    const path = join(root, ".eslintrc.js");
    // Deliberately unparseable — if the dispatch ever fell through to trying
    // to import this, the failure would be "cannot load", not the named
    // legacy-config refusal this test pins.
    writeFileSync(path, "not valid javascript {{{\n");
    await expect(loadBoundaryConfigFile(path)).rejects.toThrow(/legacy ESLint config/u);
  });

  it("produces the same depConstraints and options an equivalent .mjs config would, for the same stated law", async () => {
    const root = fixtureRoot();
    const eslintPath = writeFlatConfig(
      root,
      `[{ rules: { "@nx/enforce-module-boundaries": ["error", { depConstraints: ${CONSTRAINED}, ` +
        `allow: [], buildTargets: ["build"], enforceBuildableLibDependency: false, ` +
        `allowCircularSelfDependency: false, checkDynamicDependenciesExceptions: [], ` +
        `ignoredCircularDependencies: [], banTransitiveDependencies: false, ` +
        `checkNestedExternalImports: false }] } }]`,
    );
    const mjsPath = join(root, "module-boundaries.config.mjs");
    writeFileSync(
      mjsPath,
      `export const depConstraints = ${CONSTRAINED};\n` +
        `export const moduleBoundaryOptions = {\n` +
        `  allow: [], buildTargets: ["build"], enforceBuildableLibDependency: false,\n` +
        `  allowCircularSelfDependency: false, checkDynamicDependenciesExceptions: [],\n` +
        `  ignoredCircularDependencies: [], banTransitiveDependencies: false,\n` +
        `  checkNestedExternalImports: false,\n` +
        `};\n`,
    );

    const viaEslint = await loadBoundaryConfigFile(eslintPath);
    const viaMjs = await loadBoundaryConfigFile(mjsPath);

    expect(viaEslint.depConstraints).toEqual(viaMjs.depConstraints);
    expect(viaEslint.options).toEqual(viaMjs.options);
  });
});
