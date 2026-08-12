# `src/providers/native/` — the `lattice.json` project model

A `ProjectModelProvider` for a workspace with no `nx.json` and no Nx installed:
`model.mjs` loads and validates `lattice.json`, `discover.mjs` resolves the
project list declared∪inferred from it, `coverage.mjs` judges which tracked,
analyzable files none of those projects own, and `graph.mjs` reduces both into
the same `{nodes, dependencies}` shape `../nx.mjs`'s Nx path builds from a real
`nx graph`. `index.mjs` composes the four into `nativeProvider`, the object
`../../../cli.mjs` selects when a workspace root carries `lattice.json` rather than
`nx.json`.

Every module here is reachable with no `nx` package resolvable and no
TypeScript compiler loaded at import time — `index.mjs`'s header documents the
one import (`../../analysis/analyze.mjs`, for `languageOf` in `coverage.mjs`)
that does load `typescript`, and why that one is fine: `typescript` is a
mandatory dependency of this package, unlike `nx`, which is an optional peer
that a workspace running the native path has no reason to install.

## Declared limits

Five things this provider does not attempt, each because reaching further would
either duplicate a fact this package derives elsewhere or answer a question
nobody asked it:

1. **Git is required.** Project discovery and coverage both walk the tracked
   file list `../../workspace.mjs`'s `listTrackedFiles` returns from `git
ls-files`; a tree with no git repository has no file list to discover
   projects or judge coverage from, and `../../../cli.mjs` reports that loudly
   (exit 3) rather than reading an empty list as an empty, clean workspace.
2. **No `externalNodes` are emitted.** `../../rules/specifiers.mjs`'s
   `findTransitiveExternalDependencies` already treats an absent
   `graph.externalNodes` as "none", and `../../rules/index.mjs`'s
   `externalNodeFor` synthesises a node for an external target on demand — a
   provider declaring npm-registry bookkeeping here would be a second source of
   truth for a fact this package already derives from the analysis records.
3. **`data.targets` names, never runs.** `lattice.json`'s declared
   projects may carry a `targets` field (`model.mjs` validates its shape) and
   `graph.mjs` synthesises `{[name]: {executor: "lattice:declared"}}` for each
   declared name, which is enough for `../../rules/topology.mjs`'s
   `hasBuildExecutor` to read the project as buildable and for
   `enforceBuildableLibDependency` to run on a native tree. What it does not
   do is anything an executor or a config would: this provider has no build
   system to ask, so `"lattice:declared"` is a fixed placeholder string, never
   a real executor identity a rule could branch on.
4. **`workspaceLayout` is taken from the model, or absent — never inferred**
   from directory names. A workspace that wants `appsDir`/`libsDir` judged
   states them in `lattice.json`; one that states neither gets the rule
   engine's own default (`../../rules/index.mjs`), the same default the Nx path
   falls back to when Nx's own `workspaceLayout` is unset.
5. **Tag spellings are not validated against any vocabulary.** `lattice.json`
   can declare or infer any string as a tag; whether `layer:adapter` is a tag
   this workspace's boundary config actually constrains is a `module-boundaries.config.mjs`
   question, judged by `../../rules/`, never by this provider.

## Two failure classes, both loud

A **model defect** — a `projectRules` row matching no project, a declared root
with no tracked file, two projects resolving to the same name, a stale
`coverage.exempt` waiver, a workspace describing zero projects — throws out of
`discover()`. `../../../cli.mjs` turns that into exit 3: the workspace description
itself does not hold up against the tree, so nothing downstream of discovery
can be trusted enough to try.

An **unclaimed file** — a tracked, analyzable file no discovered project owns —
is not a defect in the model; it is a coverage hole in the _tree_, and
`coverage.mjs` reports it as a whole-file `fileFailure`
(`../../analysis/source-util.mjs`) riding in `discover()`'s return value rather
than thrown. `../../../cli.mjs` merges it into the same `failures` array a
language analyzer's own unreadable-file failure already occupies, so
`../../report/text.mjs`'s `formatFailures` and the exit-3 `unchecked` count both
need no native-specific branch to report it.

## What proves this provider against a tree it was not tested on

Every test above this line runs against a fixture this package's own tests
built — an in-memory tree, or (`differential.integration.test.mjs`'s Oracle 1)
a synthetic tree constructed under `packages/lattice/` itself, close enough to
resolve this repository's own `node_modules` for the Nx side of that
comparison. Neither is what a real consumer does: `pnpm pack`, `pnpm install`
the tarball into a workspace this repository never built, and run the bin
entries as installed.

`../../../../../scripts/verify-package.mjs` closes that gap for both providers,
not only Nx. It packs the real tarball once and installs it into TWO throwaway
consumer workspaces — one with `nx.json`, one with `lattice.json` and no `nx`
package requested at all — then runs the same three questions against both: the
checker exits 0 on a clean tree and states what it inspected, exits 1 on a
violating one naming the rule and the site, and the language server answers
`initialize` when launched through the symlinked path an installed plugin is
launched by. It also asserts `nx` genuinely does not resolve in the native
consumer's `node_modules` — the optional-peer claim (`../../../CLAUDE.md`'s
"Nx is a peer dependency but an optional one") checked against a real install,
not only against the manifest's `peerDependenciesMeta`. It runs in CI on every
pull request (`../../../../../.github/workflows/ci.yml`'s "Prove the packed
artifact works outside this workspace" step already invoked it for the Nx
path; the native path rides the same invocation, no separate CI step needed)
and again in the release lane before `npm publish`.
