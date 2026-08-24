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

## The two packages, two registries

| package                    | registry            | what publishes it                     |
| -------------------------- | ------------------- | ------------------------------------- |
| `packages/archkeep`        | npm                 | release-please tag                    |
| `packages/archkeep-vscode` | VS Code Marketplace | the release lane's `publish-vsix` job |

Both publish from the same release lane when the tag lands. The `publish-vsix`
job packs and verifies the `.vsix` and attaches it to the GitHub release on
every release; its marketplace `vsce publish` step skips — loudly, in the job
log — until a marketplace publisher account and its `ECOMA_VSCE_PAT` secret
exist, and runs automatically from the release that follows their arrival.

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
