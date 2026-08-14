# Release

How a version of Lattice reaches the people who use it. This is the mechanics;
[CONTRIBUTING.md](../../CONTRIBUTING.md) owns the contribution bar, and
[testing.md](testing.md) owns the suite that must pass before anything ships.

## What happens automatically

[release-please](https://github.com/googleapis/release-please) reads the
Conventional Commit subjects since the last tag and keeps one pull request open
holding the next version and the changelog it derived. **Merging that pull
request is the release**: it tags the commit, and the tag publishes
`@ecoma-io/lattice` to npm.

The subject line you write decides the next version number — `feat:` moves the
minor, `fix:` the patch, and a `!` or a `BREAKING CHANGE:` footer the major.

### What release-please owns

Do not hand-edit these. It rewrites both on its next run:

- `CHANGELOG.md` — in `.prettierignore` because its generated layout and
  Prettier's preferred one disagree.
- The version in `packages/lattice/package.json`.

### The release pull request title

`chore(lattice): release <version>` — not release-please's default. The
default names the target branch as the scope (`chore(main): …`), and `main` is
not in `commitlint.config.mjs`'s `scope-enum`, so the default title would fail
a required check and could never merge.

## What happens before anything is published

CI packs the real tarball and installs it into a throwaway workspace
(`scripts/verify-package.mjs`), on every pull request as well as before
publishing. That step proves four things a consumer's first hour asks:

1. Nx loads the plugin and draws a Go edge.
2. The checker exits 0 on a clean tree and **1** on a violating one.
3. The language server answers `initialize` through the symlinked path an
   installed plugin is launched by.
4. All three of those work against a second workspace with `lattice.json` at
   its root instead of `nx.json`, and no `nx` package installed.

A gate only proves it runs when it can go red. A version that fails to resolve
at install time cannot be unpublished away, which is why this check runs before
`npm publish` and not after it.

## The two packages, two registries

| package                   | registry            | what publishes it     |
| ------------------------- | ------------------- | --------------------- |
| `packages/lattice`        | npm                 | release-please tag    |
| `packages/lattice-vscode` | VS Code Marketplace | manual `vsce publish` |

The npm package publishes automatically when the release tag lands. The VS Code
extension publishes manually, because it requires a marketplace publisher
account and the CLI tool `vsce`.

## Breaking changes

A change to what is reported on an unchanged workspace is a **breaking change**
even when no API moved — a consumer's CI turns red on code they did not touch.
Mark it with `!` after the type or scope, and explain it in a `BREAKING CHANGE:`
footer.

The `schemaVersion` field in the JSON envelope (`--format json`) moves only for
a breaking change to that schema: a field renamed, retyped, or removed. A
consumer that reads an unrecognised `schemaVersion` should refuse to parse the
rest of the envelope rather than guess.

## What does not ship

- **A `languages` option.** A report from a workspace that switched a language
  off is byte-for-byte identical to one whose code in that language is clean —
  the silence this tool exists to end. A workspace already pays nothing for a
  language it does not have: every resolver keys off a manifest that is not
  there.
- **Build targets or inferred targets.** Projects are declared by hand-written
  `project.json`, and targets are never inferred — that is this tool's reason
  to exist.
- **A second copy of the constraint table.** It has one home: the file at the
  consumer's workspace root.
