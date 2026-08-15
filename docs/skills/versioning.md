# Version synchronization

Every `arch-*` skill carries a `metadata.version` in its frontmatter, and that
version must match the Lattice package version. This page documents how the sync
works, what enforces it, and what happens on release.

## The version chain

```
packages/lattice/package.json (source of truth)
  = .claude-plugin/plugin.json
  = .claude-plugin/marketplace.json (entry version)
  = .codex-plugin/plugin.json
  = packages/lattice-vscode/package.json
  = skills/*/SKILL.md (metadata.version)
```

All six must agree. A mismatch means a consumer's skills claim a version the
engine does not match — which is worse than no version at all, because it reads
as current. The extension is on the list for the same reason: it pairs with the
engine it is released with, and one version is what makes the pairing visible.

## CI enforcement

`scripts/check-skills.mjs` runs in CI and validates:

1. Every SKILL.md `metadata.version` matches the package version
2. `.claude-plugin/plugin.json` version matches the package version
3. `.claude-plugin/marketplace.json` entry version matches the package version
4. `.codex-plugin/plugin.json` version matches the package version
5. `packages/lattice-vscode/package.json` version matches the package version
6. No host-specific frontmatter fields have leaked into canonical skills

A version mismatch fails the build. There is no warning tier.

The conformance test in
`packages/lattice/src/conformance/plugin-catalogue.integration.test.mjs` also
asserts that `plugin.json` and `marketplace.json` versions match the package
version — a second enforcement point, independent of the gate script.

## Release-please automation

The release unit is the repository root, so every version-bearing file sits
inside it. When release-please creates a release PR bumping the root manifest,
the `extra-files` configuration in `release-please-config.json` also bumps:

- `.claude-plugin/plugin.json` (`$.version`)
- `.claude-plugin/marketplace.json` (`$.plugins[0].version`)
- `.codex-plugin/plugin.json` (`$.version`)
- `packages/lattice/package.json` (`$.version`)
- `packages/lattice-vscode/package.json` (`$.version`)

These five files are bumped automatically. The `SKILL.md` files in `skills/` are
YAML frontmatter and are not covered by release-please's generic updater.

## Manual SKILL.md version update

When a release PR is created, the gate script will fail if the `SKILL.md`
versions have not been updated to match the new package version. To fix:

1. Update `metadata.version` in each `skills/*/SKILL.md` to the new version
2. Push the update to the release PR branch
3. CI will pass once the versions match

This manual step is deliberate: it ensures a human reviews the skill content
when the version changes, rather than having the version bumped mechanically
without anyone reading the skills.

## Why skill versions match the package version

Skills call `lattice` CLI commands. If a skill references a command or a
`--format json` field that does not exist in the installed version, the agent
following it will fail in ways that are hard to diagnose — the skill says "run
this" and the CLI says "unknown flag."

By pinning skill versions to the package version, a consumer can tell at a
glance whether their skills match their CLI. A mismatch is a signal to update
one or the other.
