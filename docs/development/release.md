# Release

How a version of Archkeep reaches the people who use it. This is the mechanics;
CONTRIBUTING.md owns the contribution bar, and
[testing.md](testing.md) owns the suite that must pass before anything ships.

## What happens automatically

[release-please](https://github.com/googleapis/release-please) reads the
Conventional Commit subjects since the last tag and keeps one pull request open
holding the next version and the changelog it derived. **Merging that pull
request is the release**: it tags the commit, and the tag publishes
`@ecoma-io/archkeep` to npm.

The subject line you write decides the next version number — `feat:` moves the
minor, `fix:` the patch, and a `!` or a `BREAKING CHANGE:` footer the major.

### What release-please owns

Do not hand-edit these. It rewrites both on its next run:

- `CHANGELOG.md` — in `.prettierignore` because its generated layout and
  Prettier's preferred one disagree.
- The version in `packages/archkeep/package.json`.

### The release pull request title

`chore(archkeep): release <version>` — not release-please's default. The
default names the target branch as the scope (`chore(main): …`), and `main` is
not in `commitlint.config.mjs`'s `scope-enum`, so the default title would fail
a required check and could never merge.

## Release stages: the 1.0.0-rc.1 candidate

The repository crosses from 0.x to the compatibility contract through a release
candidate: a proposed contract shipped for that proposal to be judged, not a
stable release. The version is `1.0.0-rc.1`, flagged as a prerelease on GitHub. That
release run is also the evidence this file's publish notes argue from: PyPI,
crates.io and the Go tag published, and every npm publish job failed — so the
candidate never reached npm, read off the registry rather than inferred from
the failed jobs. Why each refusing step refuses is stated where the step is
described: the dist-tag note below for npm, the `publish-vsix` description
for the marketplace. The stable 1.0 is the same contract once the
[readiness conditions](../doctrine/roadmap.md#what-10-waits-for-and-how-each-condition-is-read)
hold and the maintainer cuts it; `main` is the one line that contract holds on
(CONTRIBUTING.md, "Which branch a change lands on").

**How the candidate is cut.** A commit on `main` whose message carries a
`Release-As: 1.0.0-rc.1` footer forces exactly that version for exactly one
release — the release-please strategy reads the newest `Release-As` note and
returns it verbatim (measured against release-please 17.6.0, the version
release-please-action v5.0.0 bundles), so the run that follows computes
normally again and the mechanism self-expires behind the tag it cuts. The
config-file `release-as` key upstream deprecated is not used: one commit, one
cut, no persistent state to forget.

**Iterating the candidate.** Each deliberate iteration needs its own
`Release-As:` commit — `1.0.0-rc.2`, `1.0.0-rc.3` — because the default
strategy from a prerelease version carries the suffix onto a bumped base
(`1.0.1-rc.1`, not `1.0.0-rc.2`). An RC is named explicitly rather than
incremented.

**Graduation to stable.** Cutting stable `1.0.0` is one
`Release-As: 1.0.0` commit. After that, the default strategy computes
normally: `fix` → `1.0.1`, `feat` → `1.1.0`, `!` → `2.0.0`.

**Prerelease flagging is automatic.** The `prerelease: true` configuration
key flags the GitHub release as a prerelease only while the version itself
carries a prerelease suffix or the major is still 0 — the same version gates
it in release-please's release building — so the `1.0.0-rc.1` cut is flagged,
the stable `1.0.0` that graduates from it is not, and the key stays with
nothing to remove.

**npm dist-tag note.** npm refuses to publish a prerelease version without
an explicit dist-tag — a bare `npm publish` of `1.0.0-rc.1` exits with
"You must specify a tag using --tag when publishing a prerelease version"
(measured on npm 11; the release run for that version failed its npm publish
jobs on exactly this refusal). The publish jobs therefore derive the tag from
the version's own prerelease identifier up to its first dot: `1.0.0-rc.1`
publishes under `rc`, and a later `rc.2` moves that tag rather than
accumulating `rc.1`, `rc.2`, ... A stable version publishes bare and holds
`latest`, as before. Consumers pinning a `^0.15.0` range are unaffected
either way: semver ranges exclude prereleases, so the range resolves to the
highest stable 0.x, never to the candidate; `npm i @ecoma-io/archkeep@rc` is

The VS Code Marketplace is stricter than npm: it cannot carry a version with
a prerelease suffix at all — vsce refuses the publish before contacting the
marketplace, and its `--pre-release` flag does not bypass that check (it
selects a target; measured in the vsce source the lane installs). A
candidate's `.vsix` therefore lives on its GitHub release only, and the
stable cut is the first version the marketplace receives.

## What happens before anything is published

CI packs the real tarball and installs it into a throwaway workspace
(`scripts/verify-package.mjs`), on every pull request as well as before
publishing. That step proves four things a consumer's first hour asks:

1. Nx loads the plugin and draws a Go edge.
2. The checker exits 0 on a clean tree and **1** on a violating one.
3. The language server answers `initialize` through the symlinked path an
   installed plugin is launched by.
4. All three of those work against a second workspace with `archkeep.json` at
   its root instead of `nx.json` and no `nx` package installed — and again
   against a third, Moon-shaped workspace (`.moon/workspace.yml` at its root,
   `@moonrepo/cli` resolving from its own `node_modules`).

A gate only proves it runs when it can go red. A version that fails to resolve
at install time cannot be unpublished away, which is why this check runs before
`npm publish` and not after it.

## What the lane publishes, and where

| artifact                            | registry            | what publishes it                                     |
| ----------------------------------- | ------------------- | ----------------------------------------------------- |
| `packages/archkeep`                 | npm                 | the `publish` job, from the release-please tag        |
| `packages/archkeep-mcp`             | npm                 | the `publish-mcp` job                                 |
| `packages/archkeep-rules`           | npm                 | the `publish-rules` job                               |
| `packages/archkeep-rule-sdk-ts`     | npm                 | the `publish-ts-sdk` job                              |
| `packages/archkeep-rule-sdk-go`     | the Go module proxy | the `publish-go-module` job, whose publish is the tag |
| `packages/archkeep-rule-sdk-python` | PyPI                | the `publish-pypi` job                                |
| `packages/archkeep-rule-sdk-rust`   | crates.io           | the `publish-crates` job                              |
| `packages/archkeep-vscode`          | VS Code Marketplace | the `publish-vsix` job                                |

All publish from the same release lane when the tag lands. The `publish-vsix`
job packs and verifies the `.vsix` and attaches it to the GitHub release on
every release; its marketplace `vsce publish` step skips — loudly, in the job
log and the step summary — when the version carries a semver prerelease
suffix (the marketplace cannot carry one, so a candidate's `.vsix` lives on
its GitHub release and the stable cut is the first version the marketplace
receives) or when the `ECOMA_VSCE_PAT` secret is absent.

## The manual step this lane used to need

**A release pull request's checks did not start on their own.** Both required
gates (`ci-gate`, `analysis-gate`) landed on the release branch as runs with
conclusion `action_required` and zero jobs — created, never started — so the
pull request sat at `mergeable_state: blocked` with nothing red to point at,
and someone had to approve or re-run each of them before the release could
merge.

Measured rather than suspected: across every release branch this repository
had cut up to 0.7.1, **every first attempt was `action_required` and every
success carried `run_attempt: 2`.** A hand on every release since 0.1.0,
absorbed each time by whoever cut it, which is why it is written down here
even now that it is fixed — the same measurement is how anyone tells whether
it has come back.

The cause was the identity pushing the reformat commit. That commit lands
through the git-database REST API (`release.yml`'s reformat step argues why
the API route rather than `git commit`), and it ran under
`${{ github.token }}` because the App-token step above it was gated on a
`vars.RELEASE_APP_ID` variable that no one had set — while the organisation's
credentials existed the whole time, as the secrets `ECOMA_APP_ID` and
`ECOMA_APP_KEY`. GitHub holds workflow runs attributed to the workflow token
for approval, so the gate never firing is what produced the block.

The lane now hoists that secret into a job-level `env` and gates the
App-token step on it, so the reformat pushes under an ordinary actor whose
events start CI normally.

The gate cannot read the secret directly, and the reason is worth knowing
because GitHub's documentation contradicts itself: the context-availability
table lists `secrets` among the contexts for `jobs.<job_id>.steps.if`, while
the secrets guide states that "Secrets cannot be directly referenced in `if:`
conditionals" and prescribes the hoist. The runtime sides with the guide —
measured, not reasoned: gating on `secrets.ECOMA_APP_ID` took the release
lane to a **startup failure**, a run with zero jobs and no log to read, which
is the least diagnosable red a workflow can produce. Read the table, believe
the guide.

[roadmap.md](../doctrine/roadmap.md)'s fourth 1.0 condition — releases landing without
a hand on them — is measured against exactly this, and the first release cut
after the fix is what settles whether it is met.

## Breaking changes

A change to what is reported on an unchanged workspace is a **breaking change**
even when no API moved — a consumer's CI turns red on code they did not touch.
Mark it with `!` after the type or scope, and explain it in a `BREAKING CHANGE:`
footer.

The `schemaVersion` field in the JSON envelope (`--format json`) moves only for
a breaking change to that schema: a field renamed, retyped, or removed. A
consumer that reads an unrecognised `schemaVersion` should refuse to parse the
rest of the envelope rather than guess.

## Deprecating the Lattice names

One-time, and manual on purpose: these are registry operations, not repository
state, so no workflow here can be the record of whether they happened. The
decision behind each — including why nothing is unpublished or yanked — is
[ADR 0003](../adr/0003-rename-lattice-to-archkeep.md) §3, corrected for
crates.io and Go by
[ADR 0004](../adr/0004-correct-old-name-deprecation-mechanics.md) — read that
record before repeating either of its two claims from memory. The upgrade path
they point consumers at is
[getting-started/upgrading-from-lattice.md](../getting-started/upgrading-from-lattice.md).

Run each only once the same identity has actually published under its new name,
so the notice never points at something that does not exist yet.

```bash
# npm — the old versions stay installable; every fresh install prints the notice
npm deprecate "@ecoma-io/lattice" \
  "renamed to @ecoma-io/archkeep — see https://github.com/ecoma-io/archkeep/blob/main/docs/getting-started/upgrading-from-lattice.md"
npm deprecate "@ecoma-io/lattice-rule-sdk" \
  "renamed to @ecoma-io/archkeep-rule-sdk — see https://github.com/ecoma-io/archkeep/blob/main/docs/getting-started/upgrading-from-lattice.md"
```

- **crates.io** has no deprecate verb, and no owner-level metadata edit either:
  `description`/`homepage` are read from `Cargo.toml` only at publish time and
  are frozen into that version forever. The only way to carry a notice is one
  more `lattice-rule-sdk` release whose `Cargo.toml` and `README.md` say so —
  ADR 0004 records the one already published, `0.12.1`. Do not yank the prior
  versions: a yank hides a version from new resolution and helps nobody
  already depending on it.
- **PyPI** has no release-independent deprecation flag. A notice takes one
  final `lattice-rule-sdk` release whose long description says the project
  moved, and no release after it — ADR 0004 records the one already published,
  `0.12.1`.
- **Go** supports a `// Deprecated:` comment placed directly before the
  `module` directive in `go.mod`, read by `go get`, `go list -m -u`, and
  pkg.go.dev once a tag carrying it becomes `@latest` for that module path.
  `proxy.golang.org` caches fetched versions immutably regardless of the
  notice, so every existing tag stays resolvable for anyone pinned to it
  whatever happens to the source; new tags land only under the new module
  path except the one deprecation tag itself — ADR 0004 records
  `packages/lattice-rule-sdk-go/v0.12.1`, already pushed.
- **The VS Code extension** needs nothing. It never reached the Marketplace
  under the old name — measured against the `extensionquery` API, not assumed.

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
