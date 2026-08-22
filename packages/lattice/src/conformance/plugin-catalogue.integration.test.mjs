/**
 * The manifests that have to agree before this package's language server and its
 * arch-* skills reach an agent session, held to each other. Two hosts read two
 * catalogues — Claude Code `.claude-plugin/marketplace.json`, Codex
 * `.agents/plugins/marketplace.json` — and both are judged here.
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
 * carries `arch-*` agent skills: an installed plugin is cached per version, and a
 * consumer's skills pair with the engine they ship beside — so the version that
 * matters is the plugin's, and the skills themselves carry none
 * (`docs/skills/versioning.md`).
 *
 * Registering the marketplace is the step this file learned late. A catalogue
 * states what the repository offers and nothing reads it on a session's behalf,
 * so the name in `enabledPlugins` has to be backed by an
 * `extraKnownMarketplaces` entry — a settings key, in the same file, that this
 * test once treated as optional decoration beside the catalogue's own name. It
 * was not: measured on Claude Code 2.1.239, a session with the catalogue and no
 * registration loads no skills and starts no server, and says nothing.
 *
 * `../lsp/editor-config.integration.test.mjs` owns the other half — that the
 * routed extensions match the analyzer registry and that the entry point exists.
 * Neither restates the other.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

  it("declares the keys a session depends on, so a typo is loud rather than silently ignored", () => {
    // Claude Code ignores manifest keys it does not know (`claude plugin
    // validate` says so in as many words, and the plugin manifest's own
    // `$comment` quotes it) — which is the silent direction this test exists
    // to refuse: a misspelled `lspServers` installs fine and the language
    // server never starts. The entry the session runs must therefore carry
    // exactly the keys the launch depends on, so a rename is a red test, not
    // a quietly absent server. `skills` is pinned for the same reason — a
    // typo there drops the arch-* skills with no error.
    for (const entry of marketplace.plugins) {
      const manifest = readJson(join(ROOT, entry.source, ".claude-plugin/plugin.json"));

      expect(manifest.lspServers, `${entry.name}: lspServers must exist`).toBeTypeOf("object");
      expect(Object.keys(manifest.lspServers), `${entry.name}: exactly one server`).toEqual([
        "lattice",
      ]);

      const server = manifest.lspServers.lattice;
      expect(server, `${entry.name}: the lattice server entry`).toBeTypeOf("object");
      expect(Object.keys(server), `${entry.name}: server entry keys`).toEqual([
        "command",
        "args",
        "extensionToLanguage",
        "transport",
        "workspaceFolder",
      ]);
      expect(server.command, `${entry.name}: server command`).toBeTypeOf("string");
      expect(Array.isArray(server.args), `${entry.name}: server args`).toBe(true);
      expect(server.args.length, `${entry.name}: server args present`).toBeGreaterThan(0);
      expect(server.extensionToLanguage, `${entry.name}: extension map`).toBeTypeOf("object");
      expect(server.transport, `${entry.name}: stdio transport`).toBe("stdio");

      expect(Array.isArray(manifest.skills), `${entry.name}: skills array`).toBe(true);
      expect(manifest.skills.length, `${entry.name}: skills present`).toBeGreaterThan(0);
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
    // that never starts. The reachable set is what `extraKnownMarketplaces`
    // declares and nothing else — publishing a catalogue does not register it,
    // which is the correction this test carries.
    //
    // It previously counted `marketplace.name` as reachable too, on the reading
    // that a session in this tree registers the repository's own catalogue by
    // finding it. Measured on Claude Code 2.1.239, it does not: with no
    // `extraKnownMarketplaces` entry, `claude plugin marketplace list` answers
    // `No marketplaces configured` and the enabled plugin starts nothing — no
    // skills, no language server, no warning. This test stayed green through
    // all of it, which is what made the hole silent.
    //
    // Deliberately NOT asserted: that every plugin this repository publishes is
    // also enabled here. The catalogue states what the repository OFFERS to
    // consumers; the settings state what a session here USES. A session in this
    // tree does not need the boundary server installed as a plugin, because the
    // conformance suite and the CLI already judge this tree in CI.
    const reachable = new Set(Object.keys(settings.extraKnownMarketplaces ?? {}));

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

  it("registers each extra marketplace as a directory inside this repository", () => {
    // A malformed entry here fails the same silent way: the marketplace is never
    // registered, the plugin string points at nothing, and the session starts
    // without the skills and the server this repository means every contributor
    // to have.
    //
    // `directory` rather than `github` is the deliberate half. Both are sources
    // Claude Code knows how to fetch, but a `github` entry resolves to the
    // default branch, so a pull request editing the server or a skill would be
    // judged by sessions running the version before it. A directory inside the
    // tree runs the working copy under review — the argument the catalogue's own
    // note makes, and the same containment the test above holds the catalogue's
    // entries to.
    for (const [name, entry] of Object.entries(settings.extraKnownMarketplaces ?? {})) {
      expect(entry.source?.source, `${name} names a source type`).toBe("directory");

      const resolved = resolve(ROOT, entry.source.path);
      expect(resolved.startsWith(resolve(ROOT)), `${name} -> ${entry.source.path}`).toBe(true);

      // The registered name is what `enabledPlugins` refers to, and the
      // catalogue at the other end carries a name of its own. Keeping the two
      // equal is what makes the join above decidable from these two files.
      const catalogue = readJson(join(resolved, ".claude-plugin/marketplace.json"));
      expect(catalogue.name, `${name} -> the catalogue it points at`).toBe(name);
    }
  });
});

describe("the plugin catalogue Codex reads", () => {
  // Codex looks for a repository's own catalogue at exactly one path,
  // `$REPO_ROOT/.agents/plugins/marketplace.json`, and reaches the plugin it
  // names through `.codex-plugin/plugin.json`. Same join as above and the same
  // silent failure: a renamed directory or a disagreeing name leaves `codex
  // plugin add` with nothing to install and no reason given. Measured with
  // codex-cli 0.149.0.
  //
  // The Codex catalogue carries no version of its own. Installation reads the
  // version from the plugin manifest — already on the chain
  // `docs/skills/versioning.md` owns — so there is nothing here to drift and no
  // tenth link for that chain to grow.
  const codexMarketplace = readJson(join(ROOT, ".agents/plugins/marketplace.json"));

  it("names a plugin whose Codex manifest is where the entry says it is", () => {
    for (const entry of codexMarketplace.plugins) {
      const pluginRoot = resolve(ROOT, entry.source.path);
      expect(pluginRoot.startsWith(resolve(ROOT)), `${entry.name} -> ${entry.source.path}`).toBe(
        true,
      );

      const manifestPath = join(pluginRoot, ".codex-plugin/plugin.json");
      expect(existsSync(manifestPath), `${entry.name} -> ${entry.source.path}`).toBe(true);

      const manifest = readJson(manifestPath);
      expect(manifest.name, `${entry.name}: the manifest's own name`).toBe(entry.name);
      expect(manifest.skills, `${entry.name}: the skills the plugin ships`).toBeTypeOf("string");
      expect(
        existsSync(resolve(pluginRoot, manifest.skills)),
        `${entry.name}: skills directory ${manifest.skills}`,
      ).toBe(true);
    }
  });

  it("reaches the same skills both hosts ship, so neither can drift into a shorter list", () => {
    // The two catalogues point at one `skills/` directory by different routes.
    // Comparing what each route reaches is what keeps "the same skills on every
    // host" a measured fact rather than a claim about two files nobody compares.
    const claudeSkills = readJson(join(ROOT, ".claude-plugin/plugin.json")).skills.flatMap((dir) =>
      readdirSync(resolve(ROOT, dir), { withFileTypes: true })
        .filter((it) => it.isDirectory())
        .map((it) => it.name),
    );
    expect(claudeSkills.length, "the Claude Code plugin ships skills").toBeGreaterThan(0);

    for (const entry of codexMarketplace.plugins) {
      const pluginRoot = resolve(ROOT, entry.source.path);
      const manifest = readJson(join(pluginRoot, ".codex-plugin/plugin.json"));
      const codexSkills = readdirSync(resolve(pluginRoot, manifest.skills), {
        withFileTypes: true,
      })
        .filter((it) => it.isDirectory())
        .map((it) => it.name);

      expect(codexSkills.sort(), `${entry.name}: skills reached through Codex`).toEqual(
        [...claudeSkills].sort(),
      );
    }
  });
});
