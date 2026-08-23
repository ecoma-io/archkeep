# Agent guidance

For working **on** this repository. Read it before the first edit — the rules
below are the ones a diff gets rejected for violating, and most of them are not
inferable from the code.

## What this repository is

Lattice makes an Nx workspace's dependency graph and module boundaries real for
the languages ESLint cannot parse: Go, Rust and Python. Nx reads TypeScript and
JavaScript imports and so `nx affected` and `@nx/enforce-module-boundaries` work
there; for the other three both go quiet, and quiet is the problem — an
under-selecting `affected` and an absent boundary rule look exactly like a clean
workspace.

**The repository holds the toolchain and the engine it exists to ship.**
`packages/lattice/` is that engine — an Nx plugin plus a boundary
checker and a language server, one analysis behind three faces.
`packages/lattice-vscode/` is a client of it and holds no analysis at all; it
ships to a marketplace rather than to npm, and it deliberately does not bundle
the server. The four `packages/lattice-rule-sdk-*/` are bindings rather than
engines: each is one language's typed way to author a custom rule and build it
to the wasm the engine already runs, so none of them holds analysis either and
none may grow a second opinion about what a verdict means — one contract, four
spellings, and `packages/lattice/src/conformance/rule-sdks.integration.test.mjs`
is the gate that keeps it one (`docs/adr/0002-custom-rules-one-contract.md`
records the decision). Everything else here is the apparatus that keeps them
honest. If you are about to write product code, check that it is actually what
was asked for.

The repository also ships the `arch-*` agent architecture skills in `skills/`
at the root: host-independent behavioral protocols that teach an AI agent when
and how to use Lattice commands. `scripts/check-skills.mjs` is the CI gate that
validates them, and its `EXPECTED_SKILLS` list is the roster — not restated
here, because this paragraph's own copy of it is what drifted the last time a
skill was added. See `docs/skills/overview.md` for the architecture, and
`docs/skills/versioning.md` for the single-version chain that gate holds, so a
version bump that lands in the package but nowhere else is a red gate, not a
silent drift. The skills themselves carry no version by decision; the plugin
manifest is the version that matters.

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
  workflows/ci.yml         verify → ci-gate (a required check name)
  workflows/analysis.yml   CodeQL · Semgrep · Gitleaks → analysis-gate
  semgrep/                 this repository's own rules, each with fixtures
  ISSUE_TEMPLATE/          bug · missed violation · feature
  assets/                  logo.svg is the source; the PNGs are rendered
  renovate.json5
.claude-plugin/
  marketplace.json         the catalogue this repository publishes
  plugin.json              the plugin manifest that catalogue entry points at
.codex-plugin/
  plugin.json              the same plugin manifest, for Codex's reader
.agents/plugins/
  marketplace.json         the catalogue Codex reads, at the one path it looks
                           for a repository's own. Publishing is all it does:
                           registration AND enablement are per user there, in
                           `~/.codex/config.toml`, with no counterpart to the
                           `.claude/settings.json` entry that does it for
                           everyone on the Claude Code side
.agents/skills/            the checked-in copy of `skills/` that closes that
                           gap: the Agent Skills shared project directory, read
                           by every Codex session here with no install. A copy,
                           not a symlink — Windows checkouts materialize
                           symlinks as text files — and `check-skills` fails on
                           any byte of drift between the two trees
docs/
  README.md                the index, and the map of which file owns what —
                           docs/'s own subtree included, which is why it is
                           not drawn here: the drawn copy is what went stale
                           when doctrine/ arrived
scripts/
  check-packages.mjs       the gate that makes a green build mean something
  check-packages.test.mjs
  check-docs-links.mjs     the gate that fails on a doc reference which cannot
                           resolve — deleted target, nameless #anchor, a docs/…
                           citation pointing at nothing
  check-docs-links.test.mjs
  editor-hooks/            the PostToolUse gates shared by every agent: format,
                           lint, and check-docs-links after each file edit.
                           Claude Code's settings.json, the opencode plugin in
                           .opencode/plugins/, and the Codex adapter in
                           .codex/config.toml all reach these same scripts
packages/
  lattice/                 the plugin, the checker, the language server
  lattice-vscode/          the VS Code client for that server
  lattice-rule-sdk-rust/   the four custom-rule SDKs — one contract, four
  lattice-rule-sdk-go/     spellings. Each ships a reference rule, five shared
  lattice-rule-sdk-ts/     evidence fixtures, and a committed `.wasm` with its
  lattice-rule-sdk-python/ digest; each README owns its build story and limits
module-boundaries.config.mjs   this repository's own boundary law
coverage.config.json           the coverage floor the two `.mjs` packages read
```

`lattice` carries its own `AGENTS.md` for everything below this level —
the layer split, the per-language parse limits, the modelling assumptions. It
loads when the work happens inside that directory, which is why none of it is
here. Each host reaches it its own way: Claude Code through the one-line
`CLAUDE.md` import beside it (the same arrangement as this root's `CLAUDE.md`,
for the reason that file's comment states), Codex by assembling the AGENTS.md
chain from the root down (`project_doc_max_bytes` in `.codex/config.toml` is
raised past the two files' measured size, because past that limit Codex
truncates the chain with no warning line), and opencode through the
`instructions` glob in `opencode.json`, because it does not walk into
subdirectories on its own. `lattice-vscode` has none: it is a client whose
every decision is a pure function under `src/`, and its README says what it
refuses and why.

## Rules with teeth

- **A package that runs no target is indistinguishable from no package at all.**
  Three different states of `packages/` produce an identical `exit 0` from
  `moon run` — measured by running it: nothing there (`no projects found`);
  a project there declaring none of the targets (**skipped in silence**, no
  warning line at all); a directory with sources but no `moon.yml`
  (**invisible** to `moon projects`). `scripts/check-packages.mjs` splits
  those three apart, and its verdict names the targets each package actually
  runs:

  ```text
  ok   lattice — lint, test, typecheck (no build)
  ```

  A partial set is the expected answer, not a finding. `lattice` ships as `.mjs` and
  has nothing to build; declaring an empty `build` that exits 0 to make that line
  read fuller is exactly the placeholder-green the script exists to catch. Do not
  weaken it, and do not "fix" a failure from it by adding a target.

- **`check-packages.mjs` derives its target list from `ci.yml`.** It parses the
  `moon run ...:<target>` line rather than holding a copy, because CI is where
  "green" is defined and a second copy agrees with the first only until someone
  edits one of them. That is the drift the script exists to catch, so it must not
  contain an instance of it. If you add a target to CI, the script picks it up;
  if you are tempted to add a constant listing targets, you have re-introduced
  the bug.
- **`check-docs-links.mjs` resolves every reference against the tracked
  tree.** A markdown link's target must exist (a directory counts — git cannot
  track an empty one), a `#anchor` must name a heading in its own file, and a
  `docs/…` citation resolves from the workspace root while a `../docs/…` one
  resolves from its carrying file — the same rule the citation bullet below
  states. Prettier formats a broken link; this gate is the only thing that
  knows it is broken.
- **The gate scripts take their facts as arguments.** `parseCiTargets` gets
  text, `evaluate` gets records. That is why the tests need no filesystem and no
  mocking library — not a preference, a consequence. A function that reads a
  file _and_ decides something must be split before it can be tested, and the
  split is the improvement. Only `readMoonProjects` touches the outside world, and
  it is deliberately untested: a test that stubbed the answer would pin the stub.
- **Child process calls pass an argument array, never a built string.** Every
  value in play here comes from the package tree — directory names, manifest
  fields, project names from `moon projects` — and all of those are
  attacker-supplied the moment a pull request adds a directory. A directory named
  `a;rm -rf .` stops being a name and becomes two commands. Semgrep enforces
  this (`.github/semgrep/scripts.yaml`); `cubic.yaml` carries a custom rule for
  it as well, which is not currently reviewing anything — see the cubic bullet
  under "What scans this repository". Semgrep is the half that actually runs.
- **A gate that returns early must do so loudly.** An early `return` on a
  condition that should have been reported, and a loop that accumulates failures
  into an array nobody checks, both look like success to CI.
- **Never state a rule twice.** Extend the sentence that already owns the topic
  and link to it. Two copies drift, and then nothing says which one binds.
- **Verify before you write.** Any mechanism claim — a flag, an API, a file path
  a tool reads — gets checked against that tool's current documentation or an
  actual run. A remembered API is how a document becomes authoritative and wrong
  at the same time.
- **A comment may only cite a document in this repository, and only by a path
  that resolves from where it is written.** This file and
  `packages/lattice/AGENTS.md` are the two that exist; there is no
  numbered rule list anywhere here, so a citation of the form "Rule 14" or "root
  `CLAUDE.md`" points at nothing a reader can open. The extraction arrived
  carrying thirty of them, plus prose justifying real behaviour with mechanisms
  that only exist in the workspace it came from — a comment is worse than absent
  when it explains correct code by a fact that is not true here, because the
  next reader has no way to tell which half is stale. The same applies to
  fixtures: an invented project name (`acme/libs/alpha`, `example.com/acme/beta`)
  reads as invented, while a real path from another tree reads as a fact about
  this one.

## No TypeScript here, and why

The repository runs on `.mjs` with JSDoc. This is not asceticism: Nx loads a
plugin's entry point directly in the process that runs _every_ `nx` invocation,
so the shipped artefact has to be loadable with no build step in the way. That is
why neither package declares a `build` target — there is nothing to emit, and an
artefact that needed emitting would break the sentence above.

The JSDoc is type-checked all the same, because checking is not building: each
package's `typecheck` target runs `tsc -p tsconfig.json` with `noEmit` and
`checkJs`, which reads the JSDoc as the program and writes nothing, and
`pnpm typecheck` does the same for the gate scripts, which are not an Nx
project. Each `tsconfig.json` argues its own compiler options in its header;
all three extend the root `tsconfig.base.json`, whose first duty is still the
boundary checker's import resolution — its header owns that story.

## What scans this repository

Seven things, and they own different halves of "correct". None substitutes for
another.

- **CI (`ci.yml`)** — Prettier, ESLint, `node --test`, `check-packages`,
  `check-skills`, `check-docs-links`, then `moon run`, the tool itself run on
  this tree, and last the packed artifact driven from outside the workspace.
  `ci-gate` is a check name the branch ruleset requires, so a job added later
  tightens the gate without touching repository settings. It fails on any
  needed job that is `skipped` or `cancelled`, because `needs` alone only
  blocks on `failure`. The ruleset's other required context is **`Semgrep`**,
  named directly — measured on 2026-08-22, not assumed. `analysis-gate` is
  NOT required, which this sentence claimed for months: CodeQL or Gitleaks
  going red turns that gate red and still lets a merge through, so the
  aggregate is a signal to read rather than a wall.
- **The repository's own module boundaries** — the final CI step runs
  `packages/lattice/cli.mjs check` against `module-boundaries.config.mjs`
  at this root. Every step before it proves the code correct against fixtures it
  built itself; this is the only one where the enforcer meets real source under a
  tag vocabulary (`type-package`, `scope-nx`) that nothing in `src/` knows about.
  A repository shipping an enforcer it did not run on itself would be answering a
  consumer's first question with a promise.
- **The packed artifact, installed somewhere else** —
  `scripts/verify-package.mjs` runs `pnpm pack` and installs the tarball into
  throwaway workspaces this repository never built, one per provider face the
  package ships — an Nx root, a `lattice.json` root with no `nx` package
  installed at all, a Moon root — and drives the questions a consumer's first
  hour asks: the plugin loads and draws an edge Nx cannot infer, the checker's
  exit contract holds on a clean tree and a violating one, the language server
  answers `initialize` through the symlinked path an installed plugin is
  launched by, and the optional-peer claim about `nx` is checked against an
  actual install rather than only against `peerDependenciesMeta`. Every other
  gate runs where the tool's dependencies already exist, which is why none of
  them can see a manifest that resolves nothing — the state this package was
  actually in, and green, until this script existed. It runs in CI and again
  in the release lane before `npm publish`, because a version that fails to
  resolve at install time cannot be unpublished away. The check-by-check
  roster and each workspace's argument live in the script's own header — the
  copy beside the code it describes; the fuller retelling this bullet once
  carried is a copy that already drifted once.
- **Release (`release.yml`)** — release-please keeps one pull request open
  holding the next version of the root component `"."`, which is every package
  and skill this repository ships at once, written into five places by
  `extra-files` — the chain `docs/skills/versioning.md` owns and `check-skills`
  holds on every PR, so a bump cannot land half-applied. Everything else the
  lane does to stay honest — the Prettier reformat of release-please's output,
  the un-prefixed outputs both publish jobs steer on, the `paths_released`
  tripwire that fails the lane loudly when a release was cut that no publish
  job can see, the pre-publish conformance re-run and the waiver expression in
  the publish jobs' `if:` that must never widen — is argued in `release.yml`'s
  own comments, next to the gates they guard. The lane measures, it does not
  assume; the fuller retelling this bullet once carried is a copy that already
  drifted once.
- **The PR title runs through commitlint.** Squash is the only merge button, so
  the title becomes the subject of the commit on `main` — the one commit message
  that never passes through the `commit-msg` hook. The title reaches the step via
  `env:`, never interpolated into the `run:` body.
- **`analysis.yml`** — CodeQL (`javascript-typescript` **and** `actions`; without
  the `actions` leg every workflow-security query runs zero times), Semgrep,
  and Gitleaks (a blocking scan of the whole history — a secret removed in a
  later commit is still a leak while it sits in the tree).
  `permissions: read-all` sits at the top level and writes appear only at job
  level. Job-level `permissions` _replaces_ the workflow-level block rather
  than extending it, so `contents: read` is restated in each job that narrows
  it.
- **cubic — configured, and currently not running.** It is meant to review the
  defect class no gate can decide: a path that reports nothing. Its scope and
  reasoning live in `cubic.yaml`, in that file rather than here, because a config
  file is read by whoever is editing it. What it actually does on this repository
  today is return `conclusion=neutral` with the title `AI review line limit
reached` — the free tier's review budget was spent elsewhere before this
  repository existed, and cubic has never posted a review on any pull request
  here. `gh pr checks` renders that as `skipping`, which reads identically to a
  job that is still running and to one gated off by `if:`; the three are only
  distinguishable through `gh api repos/OWNER/REPO/commits/SHA/check-runs`.
  Nothing blocks on it — it is not in `ci-gate`'s `needs` — so the effect is not
  a red build but a silent hole exactly where this list claims coverage. **Until
  that budget is paid for, the defect class in this bullet has no owner: it falls
  to the maintainer reading the diff.** The configuration stays because it is
  correct for the day the limit lifts, and because `.github/semgrep/scripts.yaml`
  and the child-process rule above both cite it.

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
pnpm typecheck          # tsc --noEmit over scripts/ — each package has its own target
pnpm check-packages     # every packages/* directory, and which CI targets it runs
node scripts/check-skills.mjs    # skills gate: shape, cites, and the manifest version chain
node scripts/check-docs-links.mjs # doc-reference gate: links, #anchors, citations
node scripts/check-cli-docs-roster.mjs # roster gate: documented command count/roster vs COMMAND_NAMES
node scripts/check-installation-prereqs.mjs # prereq gate: installation.md's table vs package.json
node scripts/check-contributing-parity.mjs # parity gate: CONTRIBUTING vs ci.yml and lefthook.yml
node scripts/sync-cargo-lock.mjs # writes Cargo.toml's version into Cargo.lock — the chain link release-please cannot write
pnpm readiness          # the four 1.0 conditions, read off git and a registry — a report
moon run ...:lint ...:test ...:typecheck   # each package's own suite
node packages/lattice/cli.mjs check        # this tree's own boundaries
```

`pnpm test` and `moon run` are not the same suite and neither covers the other:
the first is `node --test` over `scripts/`, the second is each package's own
`test` target — which for `lattice` is Vitest, including the
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

Conventional Commits, commitlint-enforced. `commitlint.config.mjs`'s
`scope-enum` is the roster and argues each entry beside it — not restated here,
for the reason the skills roster is not: this paragraph's own copy is what went
stale when the four rule SDKs arrived. One entry per package, plus the four
that name a change owning no package — `workspace`, `docs`, `deps`, `ci`;
`vscode` is listed before its own directory existed, so the commit that creates
a package is not also the commit that has to edit that file to describe
itself.

A change to what is reported on an unchanged workspace is a **breaking change**
even when no API moved — a consumer's CI turns red on code they did not touch.

If a commit was AI-assisted, it carries `Assisted-by: <tool>`, or
`Generated-by: <tool>` where the tool produced substantially the whole commit.
**One trailer per pull request, on the last commit.** Squashing concatenates
every commit message on the branch into the body of the one that lands, trailers
and all, so a trailer repeated five times arrives in history five times.

## Human-facing documents

**`docs/README.md` holds the ownership map**, and it is the file to read before
adding a page or moving a paragraph — it says which document owns each topic and,
for the two places that deliberately overlap, which copy binds. It is not
reproduced here.

Three things that map does not decide, because they sit outside `docs/`:

- **`README.md` is a landing page.** Pitch, install, and links onward. It states
  no rule and documents no option; anything that would need maintaining as the
  tool changes belongs in `docs/` with a link from the README.
- **`CONTRIBUTING.md` owns the contribution bar**, the commands and how a pull
  request lands. It stays at the repository root because GitHub surfaces it in
  the issue and pull-request UI from nowhere else. `docs/development/` owns how
  the thing works inside, never how to contribute to it.
- **`SECURITY.md` owns the threat model**, and it is not boilerplate here: a gate
  that reports nothing on crafted input is a security-relevant false negative,
  and package-tree values reaching a shell is a command injection. Read it before
  touching `scripts/`.

When one of those documents and this file would say the same thing, the
human-facing one says it and this one links.

**Every document here is English, and there is no translated variant of any of
them.** The package once carried `README.vi.md` and `README.zh.md` beside its
English one, with frontmatter and a language-switcher nav line; both are gone.
They arrived with the extraction from a workspace that mandates a three-language
triad and runs a gate over it, and neither half of that survived the move — no
gate here checks a translation, and this repository's own root `README.md` never
followed the convention anyway. What was left was two files a contributor had to
keep in sync by hand, indefinitely, against no check: a translation that silently
falls behind the English is worse than an absent one, because it reads as
current. Adding a language back is a decision that first names what keeps it
honest.
