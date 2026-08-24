---
id: 0003-rename-lattice-to-archkeep
status: accepted
---

# Archkeep replaces Lattice as the project's public identity

## Status

Accepted — written before the rename mechanics land, the same order
[0002](0002-custom-rules-one-contract.md) was accepted in. Three points inside
it were decided by the maintainer ahead of the mechanism, and the rest of this
record is bound by them: the on-disk workspace marker file moves from
`lattice.json` to `archkeep.json` as a **hard cutover**, the custom-rule WASM
export names move from `lattice_*` to `archkeep_*` as a **hard cutover**, and
the GitHub repository renames from `ecoma-io/lattice` to `ecoma-io/archkeep`
**immediately after this record merges**, ahead of the source rename that
follows it. Nothing else in this record substitutes for those three; they are
inputs to it.

## Context

"Lattice" today names one npm package, one npm-scoped SDK, a Rust crate, a
PyPI project, a Go module, a VS Code extension, a GitHub org/repo pair, a
Claude Code plugin, a Codex plugin, and the on-disk config filename every
adopting workspace carries at its root. The maintainer decided this project's
public identity becomes **Archkeep**; the GitHub organization, `ecoma-io`,
does not change. This record is the specification for what that costs and how
it is paid — not an argument for the decision, which is the maintainer's to
make and already made.

The two hard-earned facts that shape every choice below:

- **Most of what "Lattice" names is not draft work — it is live, with real
  installs.** `@ecoma-io/lattice` carries seventeen published npm versions;
  `@ecoma-io/lattice-rule-sdk` is live on npm; `lattice-rule-sdk` is live on
  crates.io (21 downloads) and PyPI; the Go module
  `github.com/ecoma-io/lattice/packages/lattice-rule-sdk-go` carries four
  tagged versions (`v0.10.1`, `v0.11.0`, `v0.11.1`, `v0.12.0`) resolvable
  today through `proxy.golang.org`. A rename that treats these as drafts would
  be wrong in the direction this project's own invariant refuses: silent
  breakage nobody sees coming.
- **One of the six is not live at all.** `packages/lattice-vscode` has never
  been published to the VS Code Marketplace — confirmed against the
  Marketplace's own `extensionquery` API and its `items?itemName=` page for
  both `ecoma-io.lattice` and the candidate `ecoma-io.archkeep` (both return
  zero results / `404`), and the package's own README already states this.
  Every install of it that exists today came from a GitHub Release `.vsix`,
  side-loaded. It carries no marketplace-listing history, no review count, no
  install count — the rename question it raises is entirely different from
  the other five, and cheaper.

## Decision

### 1. The canonical identity map

| artifact                     | current                                                    | new                                                          | registry / mechanism                                                                                                                           |
| ---------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine npm package           | `@ecoma-io/lattice`                                        | `@ecoma-io/archkeep`                                         | npm, scoped                                                                                                                                    |
| Engine CLI bin               | `lattice` → `cli.mjs`                                      | `archkeep` → `cli.mjs`                                       | npm `bin`                                                                                                                                      |
| Engine LSP bin               | `lattice-lsp` → `lsp.mjs`                                  | `archkeep-lsp` → `lsp.mjs`                                   | npm `bin`                                                                                                                                      |
| TS rule SDK                  | `@ecoma-io/lattice-rule-sdk`                               | `@ecoma-io/archkeep-rule-sdk`                                | npm, scoped                                                                                                                                    |
| Rust rule SDK                | `lattice-rule-sdk`                                         | `archkeep-rule-sdk`                                          | crates.io                                                                                                                                      |
| Python rule SDK              | `lattice-rule-sdk`                                         | `archkeep-rule-sdk`                                          | PyPI (PEP 503 normalizes to `archkeep-rule-sdk`; also rename the underscore import/package-data name `lattice_rule_sdk` → `archkeep_rule_sdk`) |
| Go rule SDK                  | `github.com/ecoma-io/lattice/packages/lattice-rule-sdk-go` | `github.com/ecoma-io/archkeep/packages/archkeep-rule-sdk-go` | Go module path (the path _is_ the identity; no `/v2` suffix needed, current major is pre-1.0)                                                  |
| VS Code extension            | `ecoma-io.lattice` (never published)                       | `ecoma-io.archkeep`                                          | VS Code Marketplace                                                                                                                            |
| GitHub org/repo              | `ecoma-io/lattice`                                         | `ecoma-io/archkeep`                                          | GitHub (org unchanged)                                                                                                                         |
| Claude Code plugin           | `lattice`                                                  | `archkeep`                                                   | `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`                                                                                |
| Codex plugin                 | `lattice`                                                  | `archkeep`                                                   | `.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`                                                                                |
| Workspace marker file        | `lattice.json`                                             | `archkeep.json`                                              | on-disk config, hard cutover                                                                                                                   |
| Custom-rule WASM ABI exports | `lattice_alloc`, `lattice_describe`, `lattice_evaluate`    | `archkeep_alloc`, `archkeep_describe`, `archkeep_evaluate`   | rule-SDK contract, hard cutover                                                                                                                |
| Nx plugin registration       | `export const name = "lattice"`                            | `"archkeep"`                                                 | literal, `nx.mjs`                                                                                                                              |
| SARIF tool name              | `tool.driver.name = "lattice"`                             | `"archkeep"`                                                 | literal, `src/report/sarif.mjs`                                                                                                                |
| Commitlint scope             | `lattice`                                                  | `archkeep`                                                   | `commitlint.config.mjs` scope-enum                                                                                                             |

### 2. Registry availability — measured 2026-08-24, not assumed

Every target below was queried directly against the registry's own API, not a
search engine, per the standing rule that a remembered or assumed answer is
how a document becomes confidently wrong:

| target                                     | endpoint                                           | result                                                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ecoma-io/archkeep` (repo)                 | `api.github.com/repos/ecoma-io/archkeep`           | `404` — free                                                                                                                                                 |
| `ecoma-io` (org)                           | `api.github.com/orgs/ecoma-io`                     | `200` — exists (sanity)                                                                                                                                      |
| `ecoma-io/lattice` (repo)                  | `api.github.com/repos/ecoma-io/lattice`            | `200` — exists (sanity)                                                                                                                                      |
| `@ecoma-io/archkeep`                       | `registry.npmjs.org/@ecoma-io%2Farchkeep`          | `404` — free                                                                                                                                                 |
| `@ecoma-io/archkeep-rule-sdk`              | `registry.npmjs.org/@ecoma-io%2Farchkeep-rule-sdk` | `404` — free                                                                                                                                                 |
| `archkeep-rule-sdk` (unscoped)             | `registry.npmjs.org/archkeep-rule-sdk`             | `404` — free                                                                                                                                                 |
| `archkeep` (unscoped)                      | `registry.npmjs.org/archkeep`                      | `404` — free                                                                                                                                                 |
| `archkeep-rule-sdk`                        | `crates.io/api/v1/crates/archkeep-rule-sdk`        | `404` — free (a request with no descriptive `User-Agent` returns `403` per crates.io's crawler policy — do not mistake that for "taken" on a later re-check) |
| `archkeep`                                 | `crates.io/api/v1/crates/archkeep`                 | `404` — free                                                                                                                                                 |
| `archkeep-rule-sdk`                        | `pypi.org/pypi/archkeep-rule-sdk/json`             | `404` — free                                                                                                                                                 |
| `archkeep`                                 | `pypi.org/pypi/archkeep/json`                      | `404` — free                                                                                                                                                 |
| `github.com/ecoma-io/archkeep-rule-sdk-go` | `proxy.golang.org/.../@v/list`                     | `404` — free                                                                                                                                                 |
| `ecoma-io.archkeep`                        | Marketplace `extensionquery` + `items?itemName=`   | `0` results / `404` — free                                                                                                                                   |

Two adjacent-but-distinct GitHub repositories already exist —
`rphmauriciodev/archkeeper` and `Textbookautist/ArchKeeper` — neither an exact
match for `archkeep` and neither under `ecoma-io`. Noted as a brand-adjacency
fact; not a collision on the target identity and not a blocker.

### 3. Compatibility, per already-published artifact

Nothing published is unpublished. Each registry's own mechanism for "this
moved" is used instead of inventing one:

- **npm** (`@ecoma-io/lattice`, `@ecoma-io/lattice-rule-sdk`): `npm deprecate`
  against the existing package, pointing at the new name. The old versions
  stay installable — anyone pinned to them is unaffected — but every fresh
  `npm install` prints the deprecation warning.
- **crates.io** (`lattice-rule-sdk`): a crate name is reserved permanently
  once published, even if every version is yanked — so the old name is never
  reclaimed by anyone else regardless of what this project does next. No new
  version is published under it; instead the crate's description/homepage
  metadata (an owner-level edit, independent of publishing) is updated to
  point at `archkeep-rule-sdk`. Existing versions are not yanked — a yank
  hides a version from new resolution but does not help anyone already
  depending on it, and there is no reason to make an unrelated project's
  build start failing.
- **PyPI** (`lattice-rule-sdk`): PyPI has no org-level "deprecated" flag
  independent of a release. One final release ships under the old name whose
  long description states the project moved, and no further release follows
  it.
- **Go module** (`.../lattice/packages/lattice-rule-sdk-go`):
  `proxy.golang.org` caches a fetched module version immutably — the four
  versions already tagged stay resolvable through the proxy indefinitely for
  anyone pinned to them, independent of what happens to the source repository
  afterward. New tags land only under the new module path; there is no
  "deprecate" mechanism to invoke because Go modules have none.
- **VS Code extension**: never published — no deprecation mechanics apply.
  The existing GitHub Release `.vsix` history under the old name stays in
  Releases; the next release's notes point at the new extension id for
  anyone who finds an old asset link later.

### 4. Deliberately breaking, not shimmed

Two changes are breaking by the maintainer's explicit choice, not by
oversight, and both are recorded here so a later reader does not mistake
either for an accident:

- **Workspace marker file, `lattice.json` → `archkeep.json`.** Every
  workspace that adopted this project has a `lattice.json` at its root today;
  after this change the engine looks for `archkeep.json` only. This ships as
  a `!` breaking commit, with the upgrade note stated plainly: rename the
  file. No dual-read of both names was chosen — see Refused alternatives.
- **Custom-rule WASM ABI exports, `lattice_*` → `archkeep_*`.** Every
  compiled `.wasm` rule — this repository's four reference rules and any
  third party's — stops loading the moment the host's `REQUIRED_EXPORTS`
  changes, until it is recompiled against the new SDK major version. This is
  the one change in this record whose blast radius reaches code this
  repository does not own and cannot see.
- **CLI/LSP bin names, `lattice`/`lattice-lsp` → `archkeep`/`archkeep-lsp`.**
  Not a code-level shim: the old npm package stays published at its last
  version carrying its old bin names for anyone who never upgrades past it.
  The new package carries the new bins going forward. No single install ever
  exposes both.

### 5. Auto-derived versus literal

Some of what reads as "the LSP is branded Lattice" is a consequence of the
npm package name, not an independent string, and moves for free the moment
the package is renamed:

| identifier                                        | how it moves                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| LSP `initialize` response `serverInfo.name`       | Auto-derived from `package.json` name at runtime — no separate edit |
| Diagnostic `source` field (editor Problems panel) | Derived from the same `serverInfo.name` — no separate edit          |

Everything else in the identity map above is a literal string somewhere in
source or a manifest and must be edited by hand: the Nx plugin's exported
`name`, the SARIF `tool.driver.name`, both AI-agent plugin manifests (and the
conformance test that pins the Claude Code manifest's `lspServers` key —
`packages/lattice/src/conformance/plugin-catalogue.integration.test.mjs` —
which must move in the same commit as the manifest or the gate goes red for
the right reason), the commitlint scope, and the skills' `compatibility:`
frontmatter and CLI-invocation prose (the five skill ids themselves —
`arch-check`, `arch-context`, `arch-change`, `arch-migrate`, `arch-review` —
already carry no "lattice" prefix and do not change).

The AssemblyScript-facing TS SDK carries one further literal that is easy to
miss: a rule's own import statement resolves against the package name inside
`assembly/` sources (documented today as `~lib/@ecoma-io/lattice-rule-sdk.ts`
in the SDK's own README) — this must move to
`~lib/@ecoma-io/archkeep-rule-sdk.ts` in the same change as the `package.json`
rename, or existing example rules fail to compile with no further clue why.

### 6. The GitHub repository

`ecoma-io/archkeep` is confirmed free (§2). It renames immediately after this
record merges — before the source rename in the next PR — so that PR only has
to write each GitHub URL in its final form once, rather than once now and
again after the repo moves. GitHub redirects the old slug for `git`/HTTP
fetches afterward, which is what keeps existing clones and Go-module fetches
of already-tagged versions working; it is not a reason to leave any
in-tree URL depending on that redirect once the source rename lands.

### 7. Sequence and ownership

- **PR1 (this record).** The ADR and its entry in `docs/README.md`'s decision
  records table. No source rename.
- **The GitHub repo rename.** A standalone action, not a PR — executed right
  after PR1 merges, by whoever holds admin on `ecoma-io/lattice`.
- **PR2 — canonical rename.** `packages/lattice` → `packages/archkeep`,
  `packages/lattice-vscode` → `packages/archkeep-vscode`,
  `packages/lattice-rule-sdk-*` → `packages/archkeep-rule-sdk-*`; the CLI/LSP
  bins, the Nx plugin name, the SARIF and diagnostic literals, the workspace
  marker filename, the WASM ABI exports, the Claude Code / Codex / VS Code
  manifests and the conformance test pinning them, the skills'
  `compatibility:` frontmatter and prose (both `skills/` and `.agents/skills/`
  kept byte-identical), the commitlint scope, `module-boundaries.config.mjs`,
  and every `ecoma-io/lattice` GitHub URL across `docs/`, `README.md`,
  `CONTRIBUTING.md` and `.github/ISSUE_TEMPLATE/` (52 occurrences measured;
  `SECURITY.md` already carries none). One owner per package directory; the
  cross-package files — the rule-SDK conformance suite, `commitlint.config.mjs`,
  `module-boundaries.config.mjs` — are single-owner and serialized, not split
  across parallel workers.
- **PR3 — release and publishing.** `release-please-config.json`'s
  `extra-files` list (eight entries today, every path under `packages/lattice*`)
  and its `pull-request-title-pattern`; the publish workflow's package names
  and working directories; and the compatibility actions from §3 themselves —
  each gated on confirming the relevant token (`ECOMA_NPM_ACCESS_TOKEN`,
  `ECOMA_CRATES_API_TOKEN`, `ECOMA_PYPI_API_TOKEN`, `ECOMA_VSCE_PAT`) actually
  has publish permission for the _new_ identity before the job that uses it
  runs for real.
- **Then, the global audit.** Every remaining `lattice`/`Lattice`/`LATTICE`
  occurrence classified as migrated, intentional compatibility, historical/
  changelog, or false positive — none left unclassified.

### 8. What keeps the old name on purpose

Three places keep saying "Lattice" after the rename, and each is a record of
something that was true when it was written rather than a claim about the
tree today:

- **`CHANGELOG.md`.** Every entry describes a release that shipped under the
  old name, from a commit whose scope was `lattice`. Rewriting them would
  make the log describe releases that never happened; the packages those
  entries name are still installable under those exact names.
- **`docs/adr/0001-boundary-levels.md` and
  `docs/adr/0002-custom-rules-one-contract.md`.** An accepted record is
  immutable here — this file's own table in `docs/README.md` says a decision
  that changed is a new record, never an edit to the old one, and this record
  is that new one. 0001 and 0002 decided what they decided about a project
  called Lattice, citing paths that were real when they were accepted. They
  keep both. A reader who wants today's names reads today's tree; a reader
  who wants to know what was decided in 0002 wants the words 0002 was
  accepted with.
- **This record.** It names the old identity throughout, because a
  specification for a rename that could not say what was being renamed from
  would be useless.

The consequence to state plainly: after PR2, those three files cite package
directories and a repository slug that no longer resolve. That is what a
historical record is, and the audit classifies them as such rather than
leaving them to read as missed work. Everything else in the tree migrates.

### 9. Named out of scope

Found during inventory, not this record's to fix:

- `AGENTS.md` states release-please's `extra-files` writes the version into
  "five places"; it holds eight entries today, independent of this rename.
  Pre-existing drift — filed as its own issue, not folded into PR2 or PR3.

## Consequences

- **Six registries, five different "this moved" mechanisms, and none of them
  delete anything.** The old identity stays resolvable everywhere it was ever
  real; only the VS Code extension has no old identity to preserve.
- **Two named breaking changes ship as `!` commits**, each with its own
  upgrade note, per the existing convention that a change to what is reported
  or accepted on an unchanged workspace is breaking even when no API moved.
- **The WASM ABI rename is the one edge this repository cannot verify.**
  Every third-party custom rule compiled against the old export names stops
  loading; this project has no way to know how many exist or reach their
  authors directly — the release notes are the only channel.
- **The repo rename happens before the tree stops citing the old slug**,
  which is a real (if brief) window where the tree's own hardcoded URLs rely
  on GitHub's redirect. PR2 closing quickly after the rename bounds that
  window.
- **One version chain survives unchanged.** The rename touches every
  package's name, not the release-please root component or the single
  version each package moves on together — that discipline is orthogonal to
  branding and this record does not touch it.

## Refused alternatives

- **Dual-reading both `lattice.json` and `archkeep.json` indefinitely** —
  refused. The maintainer chose one on-disk marker filename over two
  supported forever; a permanent OR-check is a permanent second path through
  every reader that touches it, for a cost this project's own principles
  charge against every added surface.
- **Accepting both `lattice_*` and `archkeep_*` WASM exports through a
  deprecation window** — refused for the same reason: one ABI, not a matrix
  of two, once the new SDK major ships.
- **Renaming the GitHub repository last, after PR3's publish dry-runs are
  proven** — refused. Renaming it right after PR1 means PR2 writes every URL
  in its final form once; deferring it would mean writing them twice.
- **Yanking or unpublishing anything already live** — refused everywhere in
  §3. A registry's own deprecation mechanism, where one exists, is preferred
  over erasing a name real installs depend on.
