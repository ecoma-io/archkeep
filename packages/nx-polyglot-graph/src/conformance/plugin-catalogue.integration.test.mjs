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
 * What this deliberately does NOT check is the manifest version against the
 * package's `package.json`. They are different facts wearing one word. The
 * manifest version keys Claude Code's plugin cache and moves when the manifest
 * moves; `package.json`'s version is the tool's own and is what the server
 * announces as `serverInfo`. Tying them would force a manifest bump on every
 * release of code the manifest does not contain.
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

  it("keeps every catalogue entry inside this repository, so one commit describes them all", () => {
    // A `source` climbing out of the tree would make an installer's plugins come
    // from somewhere the pull request that changes them cannot review.
    for (const entry of marketplace.plugins) {
      const resolved = resolve(ROOT, entry.source);
      expect(resolved.startsWith(ROOT), `${entry.name} -> ${entry.source}`).toBe(true);
    }
  });

  it("enables only plugins whose marketplace a session can actually reach", () => {
    // `enabledPlugins` is where the two names are joined, and it is a string: a
    // key naming a marketplace nothing registers is not an error, it is a plugin
    // that never starts. Two sources make a marketplace reachable — this
    // repository's own catalogue, and the `extraKnownMarketplaces` the same
    // settings file declares — so the reachable set is derived from both rather
    // than listed here, which is what makes this fail on a rename instead of
    // needing one.
    //
    // Deliberately NOT asserted: that every plugin this repository publishes is
    // also enabled here. The catalogue states what the repository OFFERS to
    // consumers; the settings state what a session here USES. A session in this
    // tree does not need the boundary server installed as a plugin, because the
    // conformance suite and the CLI already judge this tree in CI.
    const reachable = new Set([marketplace.name, ...Object.keys(settings.extraKnownMarketplaces)]);

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
    for (const [name, entry] of Object.entries(settings.extraKnownMarketplaces)) {
      expect(entry.source?.source, `${name} names a source type`).toBe("github");
      expect(entry.source.repo, `${name} names owner/repo`).toMatch(/^[^/\s]+\/[^/\s]+$/u);
    }
  });
});
