# Release

How a version of Lattice reaches the people who use it. This is the mechanics;
CONTRIBUTING.md owns the contribution bar, and
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
   its root instead of `nx.json` and no `nx` package installed — and again
   against a third, Moon-shaped workspace (`.moon/workspace.yml` at its root,
   `@moonrepo/cli` resolving from its own `node_modules`).

A gate only proves it runs when it can go red. A version that fails to resolve
at install time cannot be unpublished away, which is why this check runs before
`npm publish` and not after it.

## The two packages, two registries

| package                   | registry            | what publishes it                     |
| ------------------------- | ------------------- | ------------------------------------- |
| `packages/lattice`        | npm                 | release-please tag                    |
| `packages/lattice-vscode` | VS Code Marketplace | the release lane's `publish-vsix` job |

Both publish from the same release lane when the tag lands. The `publish-vsix`
job packs and verifies the `.vsix` and attaches it to the GitHub release on
every release; its marketplace `vsce publish` step skips — loudly, in the job
log — until a marketplace publisher account and its `VSCE_PAT` secret exist,
and runs automatically from the release that follows their arrival.

## The one manual step, and why it is still here

**A release pull request's checks do not start on their own.** Both required
gates (`ci-gate`, `analysis-gate`) land on the release branch as runs with
conclusion `action_required` and zero jobs — created, never started — so the
pull request sits at `mergeable_state: blocked` with nothing red to point at.
Someone has to approve or re-run each of them before the release can merge.

Measured rather than suspected: across every release branch this repository
has cut, **every first attempt is `action_required` and every success carries
`run_attempt: 2`.** It has been a hand on every release since 0.1.0, which is
also why it is written here — an undocumented manual step reads as a broken
lane to whoever meets it first.

The cause is the identity that pushes the reformat commit. That commit lands
through the git-database REST API under `${{ github.token }}` whenever
`RELEASE_APP_ID` is unset (`release.yml`'s reformat step argues why the API
route rather than `git commit`), and GitHub holds workflow runs attributed to
that identity for approval.

The fix is the branch the workflow already has: set `RELEASE_APP_ID` and its
private-key secret so the reformat pushes under the App token that step
already prefers. Until that exists, expect to approve two runs per release —
and note that [roadmap.md](../roadmap.md)'s fourth 1.0 condition, releases
landing without a hand on them, is measured against exactly this.

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
