# Agent guidance

For working **on** this repository. Read it before the first edit — the rules
below are the ones a diff gets rejected for violating, and most of them are not
inferable from the code.

## What this repository is

Lattice makes an Nx workspace's dependency graph and module boundaries real for
the languages ESLint cannot parse: Go, Rust and Python. Nx reads TypeScript
imports and so `nx affected` and `@nx/enforce-module-boundaries` work there;
for the other three both go quiet, and quiet is the problem — an under-selecting
`affected` and an absent boundary rule look exactly like a clean workspace.

**The repository holds the toolchain and the one package it exists to ship.**
`packages/nx-polyglot-graph/` is that package — an Nx plugin plus a boundary
checker and a language server over the same engine. Everything else here is the
apparatus that keeps it honest. If you are about to write product code, check
that it is actually what was asked for.

## The invariant everything is judged against

**An empty result is a claim, not a shrug.** An empty diagnostic list must mean
"no violation", and nothing else.

That single sentence decides most review questions, because it makes the two
error directions unequal:

- **Loud** — reporting a violation that is not real. Someone sees it, disagrees,
  files an issue. Self-correcting.
- **Silent** — reporting nothing when a violation exists. Byte-for-byte identical
  to a clean workspace. Nobody files anything. The boundary everyone believes is
  enforced has not run for months.

So: every code path that cannot reach a verdict must say so instead of returning
empty, and every test must have a case that goes red in the silent direction. A
test that only pins the message text is half a test.

## Layout

```
.github/
  workflows/ci.yml         verify → ci-gate (the one required check name)
  workflows/analysis.yml   CodeQL · Scorecard · Semgrep, one workflow
  semgrep/                 this repository's own rules, each with fixtures
  ISSUE_TEMPLATE/          bug · missed violation · feature
  assets/                  logo.svg is the source; the PNGs are rendered
  renovate.json5
.claude-plugin/
  marketplace.json         the catalogue this repository publishes
scripts/
  check-packages.mjs       the gate that makes a green build mean something
  check-packages.test.mjs
packages/
  nx-polyglot-graph/       the plugin, the checker, the language server
module-boundaries.config.mjs   this repository's own boundary law
```

The package carries its own `CLAUDE.md` for everything below this level — the
layer split, the per-language parse limits, the modelling assumptions. It loads
when the work happens inside that directory, which is why none of it is here.

## Rules with teeth

- **A package that runs no target is indistinguishable from no package at all.**
  Three different states of `packages/` produce an identical `exit 0` from
  `nx run-many` — measured against nx 23.1.1 by running it, not by reading
  docs: nothing there (`No tasks were run`); a project there declaring none of
  the targets (**skipped in silence**, no warning line at all); a directory with
  sources but no `package.json` or `project.json` (**invisible** to
  `nx show projects`). `scripts/check-packages.mjs` splits those three apart, and
  its verdict names the targets each package actually runs:

  ```text
  ok   nx-polyglot-graph — lint, test (no build, typecheck)
  ```

  A partial set is the expected answer, not a finding. `nx-polyglot-graph` ships
  as `.mjs` and has nothing to build; declaring an empty `build` that exits 0 to
  make that line read fuller is exactly the placeholder-green the script exists
  to catch. Do not weaken it, and do not "fix" a failure from it by adding a
  target.

- **`check-packages.mjs` derives its target list from `ci.yml`.** It parses the
  `nx run-many -t …` line rather than holding a copy, because CI is where "green"
  is defined and a second copy agrees with the first only until someone edits
  one of them. That is the drift the script exists to catch, so it must not
  contain an instance of it. If you add a target to CI, the script picks it up;
  if you are tempted to add a constant listing targets, you have re-introduced
  the bug.
- **The gate scripts take their facts as arguments.** `parseCiTargets` gets
  text, `evaluate` gets records. That is why the tests need no filesystem and no
  mocking library — not a preference, a consequence. A function that reads a
  file _and_ decides something must be split before it can be tested, and the
  split is the improvement. Only `readNxProjects` touches the outside world, and
  it is deliberately untested: a test that stubbed the answer would pin the stub.
- **Child process calls pass an argument array, never a built string.** Every
  value in play here comes from the package tree — directory names, manifest
  fields, project names from `nx show projects` — and all of those are
  attacker-supplied the moment a pull request adds a directory. A directory named
  `a;rm -rf .` stops being a name and becomes two commands. Semgrep enforces
  this (`.github/semgrep/scripts.yaml`) and cubic has a custom rule for it.
- **A gate that returns early must do so loudly.** An early `return` on a
  condition that should have been reported, and a loop that accumulates failures
  into an array nobody checks, both look like success to CI.
- **Never state a rule twice.** Extend the sentence that already owns the topic
  and link to it. Two copies drift, and then nothing says which one binds.
- **Verify before you write.** Any mechanism claim — a flag, an API, a file path
  a tool reads — gets checked against that tool's current documentation or an
  actual run. A remembered API is how a document becomes authoritative and wrong
  at the same time.

## No TypeScript here, and why

The repository runs on `.mjs` with JSDoc. This is not asceticism: Nx loads a
plugin's entry point directly in the process that runs _every_ `nx` invocation,
so the shipped artefact has to be loadable with no build step in the way. That is
also why `nx-polyglot-graph` declares no `build` target and no `typecheck` — there
is no program for `typescript-eslint` to consult, and nothing to emit. The gate
scripts follow the same rule so there is one story rather than two.

Type-checking the JSDoc with `tsc --checkJs` would be a real gain and is not
ruled out; it is a target nobody has added, and adding it is its own pull request
rather than a drive-by.

## What scans this repository

Five things, and they own different halves of "correct". None substitutes for
another.

- **CI (`ci.yml`)** — Prettier, ESLint, `node --test`, `check-packages`, then
  `nx run-many`, and last the tool itself run on this tree. `ci-gate` is the only
  check name the branch ruleset requires, so a job added later tightens the gate
  without touching repository settings. It fails on any needed job that is
  `skipped` or `cancelled`, because `needs` alone only blocks on `failure`.
- **The repository's own module boundaries** — the final CI step runs
  `packages/nx-polyglot-graph/cli.mjs check` against `module-boundaries.config.mjs`
  at this root. Every step before it proves the code correct against fixtures it
  built itself; this is the only one where the enforcer meets real source under a
  tag vocabulary (`type:package`, `scope:nx`) that nothing in `src/` knows about.
  A repository shipping an enforcer it did not run on itself would be answering a
  consumer's first question with a promise.
- **The PR title runs through commitlint.** Squash is the only merge button, so
  the title becomes the subject of the commit on `main` — the one commit message
  that never passes through the `commit-msg` hook. The title reaches the step via
  `env:`, never interpolated into the `run:` body.
- **`analysis.yml`** — CodeQL (`javascript-typescript` **and** `actions`; without
  the `actions` leg every workflow-security query runs zero times), Scorecard,
  and Semgrep. `permissions: read-all` sits at the top level and writes appear
  only at job level, because Scorecard refuses to publish results from a workflow
  holding any workflow-level write permission. Job-level `permissions` _replaces_
  the workflow-level block rather than extending it, so `contents: read` is
  restated in each job that narrows it.
- **cubic** — reviews for the defect class no gate can decide: a path that
  reports nothing. Its scope and reasoning live in `cubic.yaml`, in that file
  rather than here, because a config file is read by whoever is editing it.

**litmus is not on that list, and the distinction is the point.** It is a skill
package about test craft, enabled in `.claude/settings.json` and installed from
the `ecoma-io/litmus` marketplace; it advises a session writing tests. Nothing it
says blocks a merge. Setup is in `CONTRIBUTING.md` — a developer runs no command
for it in the normal case.

### The Semgrep directory has two non-obvious constraints

Both measured against semgrep 1.172.0, neither documented:

- **Fixtures must stay in `.prettierignore`.** `semgrep --test` binds a
  `ruleid:`/`ok:` annotation to the line immediately below it. The blank line
  Prettier inserts after each comment detaches every annotation from its case,
  turning a passing run into a failing one.
- **A `.yaml` fixture needs a top-level `rules: []` key and a `.test.` infix.**
  `--config` treats every YAML file in the directory as a candidate rule file,
  and one without that key aborts the whole run with exit 7 — the scan finds
  nothing and the failure does not look like a fixture problem.

Every rule has both a `ruleid:` case that must match and an `ok:` case that must
not. The positive case is the load-bearing half: without it, a pattern that
stopped matching anything still passes every scan, by finding nothing.

## Commands

```bash
pnpm install            # also installs the Git hooks (lefthook)
pnpm format             # Prettier, in place
pnpm format:check       # what CI runs
pnpm lint               # ESLint, zero warnings
pnpm test               # node --test over scripts/*.test.mjs — the gate scripts only
pnpm check-packages     # every packages/* directory, and which CI targets it runs
pnpm exec nx run-many -t lint test build typecheck   # each package's own suite
node packages/nx-polyglot-graph/cli.mjs check        # this tree's own boundaries
```

`pnpm test` and `nx run-many` are not the same suite and neither covers the other:
the first is `node --test` over `scripts/`, the second is each package's own
`test` target — which for `nx-polyglot-graph` is Vitest, including the
differential against a real `@nx/enforce-module-boundaries`.

Semgrep the way CI runs it, needing Docker but no local install:

```bash
IMG=semgrep/semgrep:1.172.0
docker run --rm -v "$PWD":/src -w /src $IMG \
  semgrep --test --config .github/semgrep .github/semgrep
```

Run the whole list before pushing. A shorter local run just moves the red to the
pull request.

## Commits

Conventional Commits, commitlint-enforced. Scopes: `graph`, `vscode`,
`workspace`, `docs`, `deps`, `ci`. The first two are listed before their
directories exist so the commit that creates a package is not also the commit
that has to edit `commitlint.config.mjs` to describe itself. `deps` and `ci`
exist because Renovate writes them.

A change to what is reported on an unchanged workspace is a **breaking change**
even when no API moved — a consumer's CI turns red on code they did not touch.

If a commit was AI-assisted, it carries `Assisted-by: <tool>`, or
`Generated-by: <tool>` where the tool produced substantially the whole commit.
**One trailer per pull request, on the last commit.** Squashing concatenates
every commit message on the branch into the body of the one that lands, trailers
and all, so a trailer repeated five times arrives in history five times.

## Brand assets

`.github/assets/logo.svg` is the source; the PNGs beside it are rendered from it
with headless Chrome. Edit the SVG, re-render, never touch a PNG by hand. Two
things that cost time when rediscovered: the SVG must be **inlined into the
render HTML**, because an `<img src="logo.svg">` subresource does not load in
that context and yields a broken-image placeholder that looks like a rendered
file; and ImageMagick produces grayscale here, so it is not the tool. Verify a
re-render by colour histogram, not by eye — the placeholder failure above passed
a glance.

Colours are Ecoma design tokens (`--primary` #335170, `--agent` #9B4D2C), the
same pair litmus declares. Changing one is a brand decision, not a styling one.

## Human-facing documents

`README.md` owns what the project is and why. `CONTRIBUTING.md` owns the
contribution bar, the commands and how a pull request lands. `SECURITY.md` owns
the threat model, and it is not boilerplate here: a gate that reports nothing on
crafted input is a security-relevant false negative, and package-tree values
reaching a shell is a command injection. Read it before touching `scripts/`.

When one of those documents and this file would say the same thing, the
human-facing one says it and this one links.
