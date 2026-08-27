# Contributing to Archkeep

Thank you for being here. This document is the short version of everything a
pull request is judged on, so nothing about the process is a surprise.

By contributing you agree that your work is licensed under the
[Apache License 2.0](LICENSE), and that you have the right to grant that
license — see [Ownership of what you contribute](#ownership-of-what-you-contribute).

## The one rule that decides most questions

**A change is judged on what happens when it is wrong in the quiet direction.**

Everything here reports violations. A defect that makes it report a violation
that is not real is loud: someone sees the error, disagrees with it, and files an
issue. A defect that makes it report _nothing_ is silent — an empty result is
byte-for-byte identical to a clean workspace, so nobody files anything, and the
architecture drifts through a rule everyone believes is running.

Two consequences, and they shape most reviews:

- **A test that only pins the loud direction is not a test.** If your change
  touches a rule or a graph reader, there must be a case that goes red when the
  code stops reporting something it should. "It reports the right message" is
  half a test.
- **Report a missed violation as a bug, not as a gap.** The issue tracker has
  [its own form](.github/ISSUE_TEMPLATE/missed_violation.yml) for it, separate
  from the ordinary bug form, because it is a different severity.

## Setting up

Requirements: **Node ≥ 24** (`.node-version` pins the major) and **pnpm 11**
(pinned via `packageManager`, so Corepack fetches the right one). Everything in
"The commands" below runs on those two — except `moon run`, which reaches the
four rule SDKs and therefore their toolchains; see that section.

```bash
git clone https://github.com/ecoma-io/archkeep.git
cd archkeep
pnpm install
```

`pnpm install` runs `lefthook install`, which is what puts the Git hooks in
place. If you have ever wondered why a repository's hooks did not run for you: it
is because that step was skipped. Do not skip it.

### If you use Claude Code

`.claude/settings.json` is checked in, so the setup is the same for everyone and
you run no command in the normal case. Two things it does:

- **Format and lint on every write.** Hooks in `scripts/editor-hooks/` run the
  moment a file is edited, so a problem surfaces while the edit is still in
  context rather than at commit time.
- **Enables `archkeep@archkeep`** — this repository's own plugin, the one its
  marketplace catalogue (`.claude-plugin/marketplace.json`) publishes. It is the
  language server reporting module-boundary diagnostics as you edit, plus the
  `arch-*` skills; it gates nothing, and no merge depends on it. The same file
  registers that catalogue, under `extraKnownMarketplaces` — enabling a plugin
  names a marketplace, and a name nothing registered resolves to nothing, in
  silence.

Your **first session in this directory prompts you to trust it**. Agreeing is
what lets that plugin run — a checkout you have not vouched for cannot make your
session execute anything. There is deliberately no `SessionStart` hook doing this
automatically, because such a hook would route around the one gate that makes the
arrangement safe.

Nothing else in the repository depends on it. Every gate a pull request must pass
runs in CI and in the Git hooks.

### If you use Codex

You run no command here either, by a different mechanism than Claude Code's:
`.agents/skills/` is a checked-in copy of `skills/`, and Codex reads that
directory in every session in this repository — measured with codex-cli 0.149.0,
all five `arch-*` skills, no plugin, no trust prompt, no install. A copy rather
than a symlink so a Windows checkout (where git materializes symlinks as text
files) loses nothing. If you edit a skill, re-copy it there
(`cp -r skills/* .agents/skills/`); `check-skills` fails CI on any difference
between the two trees, so forgetting is loud.

The plugin route (`codex plugin marketplace add .`, then
`codex plugin add archkeep@archkeep`) exists for installing the skills by name
into sessions outside this repository; it registers and enables per user in
`~/.codex/config.toml` — the tables it writes there never enter scope from a
repository's own `.codex/config.toml`, measured — and it copies the tree into
`~/.codex/plugins/cache/` rather than reading it in place, so an edited skill
needs a re-add. Inside this repository it adds nothing the checked-in copy has not
already provided, and a session with both lists every skill twice.

As with Claude Code, no gate depends on any of this — the editor-time hooks in
`.codex/config.toml` are separate and need no plugin.

## The commands

| Command                                       | What it does                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pnpm format`                                 | Prettier, in place                                                                                           |
| `pnpm format:check`                           | Prettier, read-only — what CI runs                                                                           |
| `pnpm lint`                                   | Every project's `lint` target through Moon — ESLint for the JS/TS half, the language linters for the rest    |
| `pnpm test`                                   | The gate scripts' own tests (`node --test` over `scripts/*.test.mjs`), through Moon                          |
| `pnpm typecheck`                              | The gate scripts' JSDoc (`tsc --noEmit`), through Moon — each package has its own target                     |
| `pnpm check-packages`                         | Asserts every `packages/*` directory plus `scripts/` is a project Moon can see, with CI targets              |
| `node scripts/check-skills.mjs`               | The skills gate: shape, citations, and the plugin-manifest version chain                                     |
| `node scripts/check-docs-links.mjs`           | Fails on any doc reference that cannot resolve — a gone target, a dead anchor                                |
| `node scripts/check-cli-docs-roster.mjs`      | Holds every documented command count and roster to `COMMAND_NAMES` in cli.mjs                                |
| `node scripts/check-docs-claims-parity.mjs`   | Validates factual claims in docs against actual code: violations, presets, MCP tools, and skills counts      |
| `node scripts/check-installation-prereqs.mjs` | Holds installation.md's prerequisites to `packages/archkeep/package.json`                                    |
| `node scripts/check-contributing-parity.mjs`  | Holds this document's roster and hooks to ci.yml and lefthook.yml — this row is part of what it checks       |
| `node scripts/check-artifact-hygiene.mjs`     | Fails on a committed `.wasm` carrying its build machine — a home directory, a credential, a tooling variable |
| `pnpm e2e`                                    | Packs the artifact and drives it as an installed CLI, end to end — CI runs it in two shards                  |

Plus every project's own targets — a different suite, not a superset of the one
above. Locally, the full form:

```bash
moon run ...:lint ...:test ...:typecheck
```

On a pull request, CI runs the affected form of the same roster instead, and
Moon decides what a change can have moved — through each task's declared
`inputs` and the projects' `dependsOn` graph. A one-package change runs that
package; a dependency change runs its consumers; an ESLint-config change runs
every lint that reads it and no typecheck; a documentation-only change runs no
Moon target at all, and says so in the log:

```bash
moon ci ...:lint ...:test ...:typecheck --base="$MOON_BASE"
```

**This one needs more than Node.** Four of the eight packages are custom-rule
SDKs, and each runs its targets in its own language's tooling: `cargo` with the
`clippy` and `rustfmt` components (Rust), `go` with `gofmt` and
`golangci-lint` (Go — the static analysis is golangci-lint's default roster,
which includes `go vet`; `go vet` is not run a second time beside it),
`python3` plus `ruff` 0.15 (Python — check, format check, and compileall).
CI pins the Rust components, Ruff and golangci-lint explicitly and gets the
interpreters from the runner image. Without a toolchain, that language's
targets fail — they do not skip, which is the whole point of `check-packages`
below. If you have not touched an SDK, running one project's targets is fine:

```bash
moon run archkeep:lint archkeep:test archkeep:typecheck
```

The E2E suite is sharded two ways in CI, and on a pull request it only runs
when Moon's affected graph says the engine project moved — an engine change
re-runs it, a documentation-only change skips it loudly (the gate reads the
query, the run is plain vitest):

```bash
moon query projects --affected
pnpm e2e --shard=1/2
```

The artifact proofs — the packed engine tarball installed into consumer
workspaces, and the extension's vsix — are Moon tasks too, gated by the same
affected graph on pull requests:

```bash
moon run archkeep:integration
moon run archkeep-vscode:package
```

Not every SDK declares all three: `check-packages` reports
`archkeep-rule-sdk-python — lint, test (no typecheck)`, and that partial line is
the truthful answer rather than a gap. Python has no type checker in the
toolchain this repository already installs, and a `typecheck` target running
`compileall` would report a passing type check over a file with no types in it
— the placeholder green `check-packages` exists to catch. Do not "fix" a
partial line by adding a target.

None of the four declares a `build` target and none rebuilds its `.wasm`: the
artifact is committed beside its `.sha256`, and each package's
`rebuild-example.sh` is what reproduces it when the rule itself changes. What
proves the committed bytes are the law is
`packages/archkeep/src/conformance/rule-sdks.integration.test.mjs`, which loads
all four through the engine's real host at their recorded digests and requires
one verdict document per fixture from all of them.

And the tool on the tree that ships it, which is the last thing CI does:

```bash
node packages/archkeep/cli.mjs check
```

And, last of all, the packed artifact driven from somewhere that is not this
workspace. It takes a few minutes — it runs a real `pnpm install` — so it is the
one command worth skipping locally unless you touched the package's manifest,
its entry points, or anything it imports:

```bash
node scripts/verify-package.mjs packages/archkeep
```

Everything above runs where the tool's dependencies already exist, so none of it
can see the failure this catches: a package that installs cleanly and throws at
the first `import`. That was this package's real state once — manifest declaring
no dependencies, suite fully green, working only because pnpm hoisted the root's
copies and Node walked up to find them. The script packs the tarball, installs it
into a throwaway workspace with a tag vocabulary nothing in `src/` knows about,
and checks that the Nx plugin draws a Go edge (Nx is a peer dependency;
the artifact must still work inside Nx workspaces), that the checker exits 0 on a clean tree
**and 1 on a violating one**, and that the language server answers when launched
through a symlinked path. A gate only proves it runs when it can go red.

The VS Code extension has its own packaging pair, and CI runs both on every
pull request so a change that breaks packaging turns this build red instead of
the release lane weeks later:

```bash
node scripts/package-vsix.mjs packages/archkeep-vscode dist/archkeep-vscode.vsix
node scripts/verify-vsix.mjs dist/archkeep-vscode.vsix
```

`package-vsix` stages the tracked files and packs them where npm can resolve
the runtime dependencies, and `verify-vsix` proves the resulting `.vsix` holds
what an install needs — `vsce package` exiting 0 proves none of that. Run them
when you touch `packages/archkeep-vscode`; skip them otherwise, as with
`verify-package` above.

Run all of them before you push. A shorter local run just moves the red to the
pull request.

### Why `check-packages` exists, and what it would catch

This is worth reading once, because it is the least obvious thing in the
repository and it is the reason a green build here means something.

Measured against Moon — by running it, not by reading the docs — three
different states of `packages/` produce an identical exit code 0:

1. **Nothing is there.** `moon run` prints nothing to run and exits 0.
2. **A project is there but declares none of those targets.** It is skipped in
   silence. No warning, no line in the summary, exit 0.
3. **A directory is there with sources but no `moon.yml`.** It is invisible
   to `moon projects` entirely — nothing is even skipped, because as far as
   Moon is concerned nothing exists.

State 2 and 3 are the ones that cost you: the build stays green and nobody is
told a package is not being checked.

`scripts/check-packages.mjs` turns each state into a distinct outcome — 3 fails,
2 fails, and 1 prints `0 packages — declared empty`. A package that legitimately
runs only some of the targets is reported as exactly that, and it is the expected
answer rather than a finding:

```text
ok   archkeep — lint, test, typecheck (no build)
```

`archkeep` ships as `.mjs` and has nothing to build. Adding an empty `build` target
to make that line read fuller is the placeholder-green the script exists to catch,
so do not.

It reads the list of targets out of the `moon run ...:…` line in
`.github/workflows/ci.yml` rather than holding a copy: CI is where "green" is
defined, and a second copy would agree with it only until someone edited one of
them. That is exactly the drift the script exists to catch, so it must not
contain an instance of it.

If you add a package, you will meet this check. It is not in your way — it is
telling you Moon cannot see what you just added.

## What the hooks do

| hook         | commands it runs, in order                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------- |
| `pre-commit` | `prettier` over the staged files, re-staging what it rewrote; `eslint` over them; `check-packages` |
| `commit-msg` | `commitlint`, checking the message shape                                                           |
| `pre-push`   | `pnpm test`; `moon projects` to prove the graph still computes                                     |

A provider that throws while the graph is being built breaks every Moon command
at once, including the ones that would report the error — which is why
proving the graph computes is worth its one second in pre-push.

If you are working with an AI coding agent, the same three gates — format,
lint, and the doc-reference check — run the moment a file is written, in
Claude Code (`.claude/settings.json`), opencode (`.opencode/plugins/`), and
Codex (`.codex/config.toml`). All three reach the shared scripts in
`scripts/editor-hooks/`, so problems surface while the edit is still in
context rather than at commit time — see
[If you use Claude Code](#if-you-use-claude-code).

Bypassing a hook with `--no-verify` is occasionally the right call during a
rebase. It is never the right way to land a change.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/), enforced by
commitlint.

```
<type>(<scope>): <subject>
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
`ci`, `chore`, `revert`.

**Scope is optional**, and when used it names which package the change lands in:
`archkeep`, `vscode`, `workspace`, `docs`, `deps`, `ci`.

`deps` and `ci` are on that list because Renovate writes them: it opens
`chore(deps):` and `chore(ci):` pull requests, and a scope list without them
would fail commitlint on every dependency update.

```
feat(archkeep): read go.mod requires into the project graph
fix(archkeep): report a replace directive pointing outside the workspace
chore(deps): update dependency nx to v23.1.2
```

A breaking change is marked with `!` after the type or scope, and explained in a
`BREAKING CHANGE:` footer. A change to what is reported on an unchanged
workspace is a breaking change even when no API moved — a consumer's CI turns
red on code they did not touch.

### If your commit was AI-assisted

Add a trailer naming the tool: `Assisted-by: <tool>`, or `Generated-by: <tool>`
where the tool produced substantially the whole commit. A pull request
description can be edited later and no clone carries it; the commit trailer
travels with the code.

**One trailer per pull request, on the last commit** — not one per commit.
Squashing concatenates the full message of every commit on the branch into the
body of the single commit that lands, trailers and all, so a trailer repeated
across five commits arrives in history five times.

## Tests

Tests live beside the code they test, and they run under `node --test`. There is
no framework and no mocking library, which is a consequence rather than a
preference: the logic here takes its facts as arguments — a workflow's text, a
list of project records — so a test needs no filesystem and nothing to stub.

Keep it that way. A function that reads a file _and_ decides something has to be
split before it can be tested, and the split is the improvement.

Two things a reviewer will check:

- **A test pins intent, not just current output.** If the logic that matters
  could change without failing your test, the test is not doing its job.
- **A test is titled by the behaviour it pins**, never by the phase of work that
  added it. `a directory with no manifest fails instead of being skipped as
invisible`, not `check-packages fix round 2`.

Before trusting a new check, break the thing it checks and watch the test go red.
A test nobody has seen fail is a test nobody knows can.

## The rules Semgrep enforces

`.github/semgrep/` holds this repository's own analysis rules, and the Analysis
workflow fails on any of them. They cover the one boundary where this repository
executes anything:

- **`workflows.yaml`** — an action not pinned to a full commit SHA, a
  `${{ github.event.* }}` expression interpolated into a `run:` block, and
  `pull_request_target`.
- **`scripts.yaml`** — `shell: true` on a `child_process` call, and `exec`/
  `execSync` with a command built by interpolation. Both matter because the
  values in play come from the package tree: directory names, manifest fields,
  project names. Those are attacker-supplied the moment a pull request adds a
  directory.

Every rule has fixtures beside it where each line is marked `ruleid:` (must be
reported) or `ok:` (must not be). That pairing is what stops a rule from being
quietly widened or narrowed — without the positive case, a pattern that stopped
matching still passes every scan, by finding nothing. CI runs the fixtures before
it runs the scan.

Run them the way CI does, which needs Docker but no local Semgrep install:

```bash
IMG=semgrep/semgrep:1.172.0   # the workflow pins the digest too
docker run --rm -v "$PWD":/src -w /src $IMG \
  semgrep --test --config .github/semgrep .github/semgrep
docker run --rm -v "$PWD":/src -w /src $IMG \
  semgrep scan --config .github/semgrep --exclude .github/semgrep --error --quiet
```

Two constraints on that directory are not obvious, and each was measured against
semgrep 1.172.0 rather than assumed:

- **Fixtures are in `.prettierignore`, and must stay there.** `semgrep --test`
  binds an annotation to the line immediately below it; the blank line Prettier
  inserts after each one detaches every annotation from its case, turning a
  passing run into a failing one.
- **A `.yaml` fixture needs a top-level `rules: []` key and a `.test.` infix.**
  `--config` treats every YAML file in the directory as a candidate rule file,
  and one without that key aborts the whole run with exit 7.

## Opening a pull request

1. Branch from `main`.
2. Make the change, with tests, and run the full command list above.
3. Fill in the pull request template honestly — especially **Could this fail
   silently?**. Writing "no" is fine when it is true; leaving it blank is not.
4. Keep it focused. Unrelated cleanup found along the way is welcome as its own
   pull request — mixed into this one it makes the real change unreviewable.

Reviews come from a maintainer. No automated reviewer is configured: the defect
class no deterministic gate can decide — a path that reports nothing — is owned
by the maintainer reading the diff.

### How a pull request lands

**Squash, always.** Merge commits and rebase merges are switched off in
repository settings and refused by the branch rules, so "Squash and merge" is the
only button. Three things follow, and the first is the reason for a check you
will see in CI:

- **The pull request title becomes the subject of the commit on `main`**, so the
  title itself must be a valid Conventional Commit. CI checks it with the same
  commitlint configuration the `commit-msg` hook uses, so a valid message has one
  definition rather than two. Your own commit messages are kept — they land in
  the body of the squash commit — but only the title reaches the first line, and
  the first line is what `git log --oneline` and any release tooling read.
- **One release-worthy change per pull request.** A pull request holding a
  `feat:` and an unrelated `fix:` gets one subject line, so it announces one of
  them. If you have two, send two.
- **You do not need to sign your commits.** `main` requires signatures, and
  GitHub signs the squash commit it creates — the commits on your branch are
  never the ones that land, so no key, no setup, nothing to configure. (This is
  also why rebase merging is off rather than merely unfashionable: GitHub cannot
  sign a rebase, so a rebase merge into `main` is refused outright.)

## How a release happens

Nothing you need to do — but worth knowing, because it explains a pull request
you will see open on `main` that nobody wrote.

[release-please](https://github.com/googleapis/release-please) reads the
Conventional Commit subjects since the last tag and keeps one pull request open
holding the next version and the changelog it derived. **That pull request is the
release proposal**: merging it tags, and the tag publishes
`@ecoma-io/archkeep` to npm. So the subject line you write is what
decides the next version number — `feat:` moves the minor, `fix:` the patch, and
a `!` or a `BREAKING CHANGE:` footer the major.

Two details that are easy to trip over:

- **Do not hand-edit `CHANGELOG.md` or the version in `package.json`.**
  release-please owns both and rewrites them on the next run. `CHANGELOG.md` is
  in `.prettierignore` for the same reason: its generated layout and Prettier's
  preferred one disagree, and neither yields.
- **The release pull request's title is `chore(archkeep): release <version>`**,
  not release-please's default. The default names the target branch as the scope
  (`chore(main): …`), and `main` is not in `commitlint.config.mjs`'s `scope-enum`
  — the release pull request would fail a required check and could never merge.

Before anything is published, CI packs the real tarball and installs it into a
throwaway workspace (`scripts/verify-package.mjs`, described in the commands
above). That step runs on every pull request too, so a change that breaks the
package for someone who is not this workspace fails the change rather than the
release.

## Reporting problems

- **A missed violation** — its own form. Higher severity than a wrong message,
  and it earns a permanent regression fixture.
- **Bugs and proposals** — the other issue forms. The questions they ask are the
  ones that decide whether something is actionable.
- **Security vulnerabilities** — never a public issue. Follow
  [SECURITY.md](SECURITY.md).

## Ownership of what you contribute

You keep the copyright in your contribution and license it to the project under
Apache-2.0, which includes the patent grant that license carries.

Please only send work you have the right to send. If you are employed as a
developer, your employment agreement may assign what you write to your employer
even on your own time and your own hardware — in which case you need their
permission before contributing, not after. Anything you did not write yourself,
including substantial output from an AI tool, must be disclosed as described
above.

## Code of Conduct

Everyone taking part is held to the [Code of Conduct](CODE_OF_CONDUCT.md).
Reports go to john.itvn@gmail.com.
