# Version synchronization

Every version-bearing file that ships together carries the Lattice package
version, and the same mechanism keeps them in lockstep. This page documents
how the sync works, what enforces it, and what happens on release.

## The version chain

```
packages/lattice/package.json (source of truth)
  = .claude-plugin/plugin.json
  = .claude-plugin/marketplace.json (entry version)
  = .codex-plugin/plugin.json
  = packages/lattice-vscode/package.json
```

All five must agree. The extension is on the list because it pairs with the
engine it is released with, and one version is what makes the pairing visible.

The `arch-*` skills carry **no version** by decision. A consumer's skills are
installed with the plugin that ships them, so the version that matters is the
plugin's — a per-skill `metadata.version` would have to be bumped by hand on
every release, and a version that drifts is worse than none, because it reads
as current. If a skill needs to be paired with a specific engine, the plugin
version is the pairing.

## CI enforcement

`scripts/check-skills.mjs` runs in CI and validates:

1. `.claude-plugin/plugin.json` version matches the package version
2. `.claude-plugin/marketplace.json` entry version matches the package version
3. `.codex-plugin/plugin.json` version matches the package version
4. `packages/lattice-vscode/package.json` version matches the package version
5. No host-specific frontmatter fields have leaked into canonical skills

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

These five files are bumped automatically, and `release.yml` reformats the
`extra-files` after release-please writes them — release-please re-serializes a
JSON file it touches, which does not match this repository's Prettier layout, so
the reformat step keeps `format:check` green on the release pull request.
