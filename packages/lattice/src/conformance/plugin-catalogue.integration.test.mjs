/**
 * The manifests that have to agree before this package's language server reaches
 * a Claude Code session, held to each other.
 *
 * A plugin is reached by a string — `<plugin>@<marketplace>` — that names two
 * things declared in different files: the plugin's own `plugin.json` and the
 * catalogue's `marketplace.json`. Rename either and the string still parses, the
 * settings file still loads, and the plugin simply never starts. There is no
 * error, because nothing looked.
 *
 * The version is the same shape of copy. It is written twice, once in each
 * manifest, and the plugin's own note says they must match — which is a
 * constraint stated in prose beside two values nothing compares. An installed plugin
 * is cached per version, so a mismatch is not cosmetic: Claude Code and the
 * catalogue disagree about which build a session is running.
 *
 * The manifest version is also synchronized with the package's `package.json`.
 * The three must agree: `plugin.json` version == `marketplace.json` version ==
 * `package.json` version. This is enforced by the conformance test below and by
 * release-please's `extra-files` configuration, which bumps the manifest versions
 * in lockstep with the package release. The sync exists because the plugin now
 * carries `arch-*` agent skills that must ship at the same version as the tool,
 * and a mismatch would mean a consumer's skills claim a version the engine does
 * not match.
 *
 * `../lsp/editor-config.integration.test.mjs` owns the other half — that the
 * routed extensions match the analyzer registry and that the entry point exists.
 * Neither restates the other.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The workspace root, counted from this file rather than searched for.
 *
 * The walk-up-until-found form this test used to have was load-bearing when the
 * tool lived at an unknown depth inside a larger tree. Here it is not: this file
 * is at a fixed place in its own repository, and a search would only be able to
 * fail later and less clearly — landing on a parent directory that happened to
 * contain a marketplace manifest, and judging that tree instead.
 */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const marketplace = readJson(join(ROOT, ".claude-plugin/marketplace.json"));
const settings = readJson(join(ROOT, ".claude/settings.json"));

describe("the plugin catalogue this repository publishes", () => {
  it("lists an entry whose manifest is where the entry says it is", () => {
    // The `source` is a path Claude Code follows. A directory renamed under it
    // leaves an entry pointing at nothing, which reads as a plugin that exists.
    for (const entry of marketplace.plugins) {
      const manifestPath = join(ROOT, entry.source, ".claude-plugin/plugin.json");
      expect(existsSync(manifestPath), `${entry.name} -> ${entry.source}`).toBe(true);
      expect(readJson(manifestPath).name).toBe(entry.name);
    }
  });

  it("gives every entry the version its own manifest declares", () => {
    for (const entry of marketplace.plugins) {
      const manifest = readJson(join(ROOT, entry.source, ".claude-plugin/plugin.json"));
      expect(entry.version, `${entry.name} in marketplace.json`).toBe(manifest.version);
    }
  });

  it("synchronizes the manifest version with the package version", () => {
    const pkg = readJson(join(ROOT, "packages/lattice/package.json"));
    for (const entry of marketplace.plugins) {
      const manifest = readJson(join(ROOT, entry.source, ".claude-plugin/plugin.json"));
      expect(manifest.version, `${entry.name} plugin.json`).toBe(pkg.version);
      expect(entry.version, `${entry.name} marketplace.json`).toBe(pkg.version);
    }
  });

  it("keeps every catalogue entry inside this repository, so one commit describes them all", () => {
    // A `source` climbing out of the tree would make an installer's plugins come
    // from somewhere the pull request that changes them cannot review. `"./"`
    // — the marketplace root — is the inside case at its limit: the whole
    // repository is the plugin, which is what lets the plugin manifest, the
    // skills and the server travel together at one version.
    const repoRoot = resolve(ROOT);
    for (const entry of marketplace.plugins) {
      const resolved = resolve(ROOT, entry.source);
      expect(resolved.startsWith(repoRoot), `${entry.name} -> ${entry.source}`).toBe(true);
    }
  });

  it("enables only plugins whose marketplace a session can actually reach", () => {
    // `enabledPlugins` is where the two names are joined, and it is a string: a
    // key naming a marketplace nothing registers is not an error, it is a plugin
    // that never starts. Two sources make a marketplace reachable — this
    // repository's own catalogue, and the `extraKnownMarketplaces` the same
    // settings file declares (absent here because this session uses only the
    // repository's own marketplace) — so the reachable set is derived from both
    // rather than listed here, which is what makes this fail on a rename instead
    // of needing one.
    //
    // Deliberately NOT asserted: that every plugin this repository publishes is
    // also enabled here. The catalogue states what the repository OFFERS to
    // consumers; the settings state what a session here USES. A session in this
    // tree does not need the boundary server installed as a plugin, because the
    // conformance suite and the CLI already judge this tree in CI.
    const reachable = new Set([
      marketplace.name,
      ...Object.keys(settings.extraKnownMarketplaces ?? {}),
    ]);

    const enabled = Object.keys(settings.enabledPlugins ?? {});
    expect(enabled.length).toBeGreaterThan(0);
    for (const key of enabled) {
      const [plugin, market] = key.split("@");
      expect(plugin, `${key} names a plugin`).toBeTruthy();
      expect([...reachable], `${key} names a marketplace this repository registers`).toContain(
        market,
      );
      expect(settings.enabledPlugins[key]).toBe(true);
    }
  });

  it("declares each extra marketplace as a source Claude Code knows how to fetch", () => {
    // A malformed entry here fails the same silent way: the marketplace is never
    // registered, the plugin string points at nothing, and the session starts
    // without the skills the repository meant every contributor to have.
    for (const [name, entry] of Object.entries(settings.extraKnownMarketplaces ?? {})) {
      expect(entry.source?.source, `${name} names a source type`).toBe("github");
      expect(entry.source.repo, `${name} names owner/repo`).toMatch(/^[^/\s]+\/[^/\s]+$/u);
    }
  });
});
