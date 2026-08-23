# Version synchronization

Every version-bearing file that ships together carries the Lattice package
version, and the same mechanism keeps them in lockstep. This page documents
how the sync works, what enforces it, and what happens on release.

## The version chain

```
package.json (repository root — what release-please bumps directly)
  = packages/lattice/package.json (the baseline the gate compares against)
  = .claude-plugin/plugin.json
  = .claude-plugin/marketplace.json (entry version)
  = .codex-plugin/plugin.json
  = packages/lattice-vscode/package.json
  = packages/lattice-rule-sdk-rust/Cargo.toml ([package] version)
  = packages/lattice-rule-sdk-ts/package.json
  = packages/lattice-rule-sdk-python/pyproject.toml ([project] version)
      └ packages/lattice-rule-sdk-rust/Cargo.lock (the lattice-rule-sdk entry)
```

All nine must agree. The root `package.json` is the release-please `"."`
component — the one file it bumps directly; the other eight are copies of it
written by `extra-files`.

`Cargo.lock` hangs off the Cargo manifest rather than sitting on the line
because nothing writes it: release-please has no lockfile updater, so the lock
keeps the previous number while the manifest moves. It carries the same version
as everything above it, but the gate compares it against `Cargo.toml`, which is
where the requirement actually comes from — `cargo publish --locked` refuses a
lock that disagrees with its own manifest. `scripts/sync-cargo-lock.mjs` is what
writes it, run by the release lane on release-please's branch. The extension is on the list because it pairs with
the engine it is released with, and one version is what makes the pairing
visible. The rule SDK manifests are on it for the decision
[adr/0002](../adr/0002-custom-rules-one-contract.md) records: every SDK joins
this one chain, so "the SDK for engine 0.x" is a fact a reader takes from the
number rather than a compatibility matrix. The Go SDK carries no manifest
version at all — a Go module's version is its git tag, which is the one place
the release lane speaks for it.

The `arch-*` skills carry **no version** by decision. A consumer's skills are
installed with the plugin that ships them, so the version that matters is the
plugin's — a per-skill `metadata.version` would have to be bumped by hand on
every release, and a version that drifts is worse than none, because it reads
as current. If a skill needs to be paired with a specific engine, the plugin
version is the pairing.

## CI enforcement

`scripts/check-skills.mjs` runs in CI and validates:

1. The repository root `package.json` version matches the package version —
   the baseline itself checked against the file release-please actually bumps
2. `.claude-plugin/plugin.json` version matches the package version
3. `.claude-plugin/marketplace.json` entry version matches the package version
4. `.codex-plugin/plugin.json` version matches the package version
5. `packages/lattice-vscode/package.json` version matches the package version
6. `packages/lattice-rule-sdk-rust/Cargo.toml`'s `[package]` version matches
   the package version — read section-scoped, so a dependency's pin can never
   stand in for the crate's own number
7. `packages/lattice-rule-sdk-ts/package.json` version matches the package
   version
8. `packages/lattice-rule-sdk-python/pyproject.toml`'s `[project]` version
   matches the package version — the same section-scoped TOML read as the
   Cargo check
9. `packages/lattice-rule-sdk-rust/Cargo.lock` records that version for the
   `lattice-rule-sdk` entry — read out of the `[[package]]` array by name,
   because every entry there carries the same header and a header-only match
   would report the first dependency's version as the crate's
10. No host-specific frontmatter field has leaked into canonical skills —
    checked at any depth of parsed frontmatter, so a nested block cannot
    smuggle one past the top-level filter

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
- `packages/lattice-rule-sdk-rust/Cargo.toml` (`$.package.version`, the TOML
  updater)
- `packages/lattice-rule-sdk-ts/package.json` (`$.version`)
- `packages/lattice-rule-sdk-python/pyproject.toml` (`$.project.version`, the
  TOML updater)

That the two rosters agree is itself gated: every `extra-files` entry must name
a file on the chain above, a cross-check derived from the gate script's own
path constants rather than a restated copy (`scripts/check-skills.test.mjs`).
A manifest added to one list without the other turns red on the pull request
instead of being bumped every release and verified by nobody.

These eight files are bumped automatically, and `release.yml` then repairs two
things on release-please's own branch, before CI ever sees the pull request.

The first is formatting: release-please re-serializes a JSON file it touches,
which does not match this repository's Prettier layout, so the repair step runs
Prettier over the JSON `extra-files` and keeps `format:check` green. The two
TOML manifests stay off that list — Prettier has no TOML parser, and no gate
checks TOML layout, so there is nothing there to fix.

One package is bumped by neither mechanism. The Go SDK carries no version
anywhere in its tree, so there is nothing for `extra-files` to write and nothing
for the chain gate to compare: its version is a git tag, and Go's rule for a
module below the repository root is that the tag carries the module's own
directory — `packages/lattice-rule-sdk-go/v<version>`, beside the bare
`v<version>` release-please cuts. `release.yml`'s `publish-go-module` job mints
it from `scripts/tag-go-module.mjs`, which derives the name from `go.mod`'s
module path rather than restating it and refuses a path that does not resolve to
this repository and that directory. It is the one release destination with no
registry: `go get` reads the tag, so the tag is the publish.

The second is the Rust SDK's `Cargo.lock`, which is not a formatting fix and is
the reason this section was rewritten. Nothing in `extra-files` writes a
lockfile, so the manifest moves and the lock does not, and
`cargo publish --locked` — which the release lane runs before it uploads —
refuses to publish through the disagreement. Measured on the 0.10.0 release:
the tag was cut, npm published, and crates.io received nothing, because the
lock still said `0.9.0`. `scripts/sync-cargo-lock.mjs` writes the manifest's
version into the lock, check 9 above is what fails when it has not run, and the
lock rides back to the branch on the same repair commit as the reformatted
JSON.
