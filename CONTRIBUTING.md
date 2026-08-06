# Contributing to Lattice

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
(pinned via `packageManager`, so Corepack fetches the right one).

```bash
git clone https://github.com/ecoma-io/lattice.git
cd lattice
pnpm install
```

`pnpm install` runs `lefthook install`, which is what puts the Git hooks in
place. If you have ever wondered why a repository's hooks did not run for you: it
is because that step was skipped. Do not skip it.

## The commands

| Command               | What it does                                                                  |
| --------------------- | ----------------------------------------------------------------------------- |
| `pnpm format`         | Prettier, in place                                                            |
| `pnpm format:check`   | Prettier, read-only — what CI runs                                            |
| `pnpm lint`           | ESLint, zero warnings tolerated                                               |
| `pnpm test`           | `node --test` over `scripts/*.test.mjs`                                       |
| `pnpm check-packages` | Asserts every `packages/*` directory is a project Nx can see, with CI targets |

Plus every project's own targets, once there are projects:

```bash
pnpm exec nx run-many -t lint test build typecheck
```

Run all of them before you push. A shorter local run just moves the red to the
pull request.

### Why `check-packages` exists, and what it would catch

This is worth reading once, because it is the least obvious thing in the
repository and it is the reason a green build here means something.

Measured against nx 23.1.1 — by running it, not by reading the docs — three
different states of `packages/` produce an identical exit code 0:

1. **Nothing is there.** `nx run-many -t lint test build typecheck` prints
   `No tasks were run` and exits 0.
2. **A project is there but declares none of those targets.** It is skipped in
   silence. No warning, no line in the summary, exit 0.
3. **A directory is there with sources but no `package.json` or
   `project.json`.** It is invisible to `nx show projects` entirely — nothing is
   even skipped, because as far as Nx is concerned nothing exists.

State 1 is the truth today. What makes the other two a problem is the day
someone adds the first package in shape 2 or 3: the build stays green, and
nobody is told that a package is not being checked.

`scripts/check-packages.mjs` turns each state into a distinct outcome — 3 fails,
2 fails, and 1 prints `0 packages — declared empty`. It reads the list of targets
out of the `nx run-many -t …` line in `.github/workflows/ci.yml` rather than
holding a copy: CI is where "green" is defined, and a second copy would agree
with it only until someone edited one of them. That is exactly the drift the
script exists to catch, so it must not contain an instance of it.

If you add a package, you will meet this check. It is not in your way — it is
telling you Nx cannot see what you just added.

## What the hooks do

- **pre-commit** — Prettier formats the staged files and re-stages what it
  rewrote, then ESLint runs over them, then `check-packages`.
- **commit-msg** — commitlint checks the message shape.
- **pre-push** — `pnpm test`, and `nx show projects` to prove the graph still
  computes. A plugin that throws while the graph is being built breaks every
  `nx` command at once, including the ones that would report the error.

If you are working with an AI coding agent, `.claude/` configures format and lint
to run the moment a file is written, so problems surface while the edit is still
in context rather than at commit time.

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
`graph`, `vscode`, `workspace`, `docs`, `deps`, `ci`. The first two are listed
before their directories exist, so the commit that creates a package is not also
the commit that has to edit `commitlint.config.mjs` to describe itself.

`deps` and `ci` are on that list because Renovate writes them: it opens
`chore(deps):` and `chore(ci):` pull requests, and a scope list without them
would fail commitlint on every dependency update.

```
feat(graph): read go.mod requires into the project graph
fix(graph): report a replace directive pointing outside the workspace
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

Reviews come from a maintainer and from [cubic](https://cubic.dev), which reads
the diff for correctness defects. cubic is advisory: it cannot approve, and it
cannot stand in for a required check.

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
