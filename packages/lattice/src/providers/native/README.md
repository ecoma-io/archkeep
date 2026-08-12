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

Six things this provider does not attempt, each because reaching further would
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
6. **No tag is ever inferred from `package.json`.** Nx's own built-in
   js/package-json plugin synthesises `npm:public`/`npm:private` from a
   directory's `package.json` `private` field the moment that file exists,
   with no opt-in — this provider does not replicate that inference, by
   design: `discover.mjs` reads a `package.json` only for its `name`, never
   its `private` field, so a native tree gets no tag from `package.json` it did
   not declare or that a `projectRules` row did not add explicitly. The silent
   direction this refusal creates: a workspace migrating from Nx to
   `lattice.json`, carrying `depConstraints` rows keyed on `npm:public` or
   `npm:private`, will see those constraints stop matching anything the moment
   the tree drops `nx.json` — not because the projects changed, but because
   the tag that used to appear automatically no longer does. The fix is one
   line per affected project: add the matching tag to that project's
   `projects.declared` row or to a `projectRules` row that matches it, the
   same way `differential.fixtures.mjs`'s `composite` fixture states
   `npm:private` on `pkgnamed` explicitly rather than relying on inference
   that does not happen here.

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

`differential.integration.test.mjs`'s Oracle 1 covers seven axes across three
fixture pairs, not one pair per axis — the cost driver is the real `nx graph
--file=` spawn, so the axes are packed to hold the file to three spawns total.
The shared machinery it drives — the fixture builders, `diffGraphs`, `LEDGER`,
and the breach checks — lives in `./differential.fixtures.mjs`, a plain module
with no `vitest` import, so a future differential can reuse it without running
this suite's own cases as a side effect of the import.

`simple` (unchanged) stays the minimal, single-violation pair a failure is
diagnosable from without reading a diff row. `composite` packs six
identity/topology axes into one tree — name precedence (a declared name, a
`package.json` name, and a bare `basename(root)` fallback), project type (the
`-e2e` suffix rule), the workspace root itself as a project (`root: ""`), tag
union across all THREE sources at once on one project (a declared row, a
`projectRules` row, and its own `project.json`, all on `parent`), implicit
dependencies (a literal project name spelled on a declared row, a literal name
spelled in `project.json`, and a `tag:`-pattern entry), and a project nested
inside another project's own directory — and asserts each axis by name via
`diffGraphs`, a per-node/per-edge/per-verdict comparison, rather than one
`deepEqual` over two whole graphs. `layout` isolates `workspaceLayout` alone,
because it is workspace-global rather than per-project and folding it into
`composite` would move every other axis's expected shape at once; it is also
the one pair the two providers are expected to disagree on; `readProjectGraph`
in `../nx.mjs` returns `nx graph --file=`'s output verbatim, which carries no
`workspaceLayout` at all (that function's own header), so the Nx side always
falls back to the rule engine's default layout while the native side reads
`lattice.json`'s own `workspaceLayout` field — a real, ledgered gap
(https://github.com/ecoma-io/lattice/issues/31), not a fixture bug, and the
test asserts the ledger explains exactly that one difference and nothing else.

Only ONE direction is ledgerable, and it is enforced structurally rather than
by convention: a `LedgerRow` now carries a `direction` field
(`differential.fixtures.mjs`'s `LEDGER_DIRECTIONS`), and its only member is
`"native-only"` — native reporting something Nx does not. `classifyDifferences`
throws, unconditionally, on any verdict-count difference where Nx's count
exceeds native's, before it ever checks whether a `LEDGER` row matches that
difference's subject and field — no row, however its `reason` is worded, gets
a vote on that direction. `emptyVerdictBreaches` catches the aggregate shape of
the same failure (an engine reporting zero violations on a pair built to
contain one) and `perMessageBreaches` catches it per `messageId` even when
neither side's total is literally zero (`{nx: 3, native: 1}` on one rule is a
breach exactly as much as `{nx: 1, native: 0}` is); both take no `ledger`
parameter at all, so the suppression is not just untested, it has nowhere to be
written.

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

`verify-package.mjs` still proves the provider only against fixtures someone
here built, even installed for real — the checker exits the right code on a
tree this repository authored to exit that code. Two more things close the gap
`verify-package.mjs` cannot: source nobody here wrote, and this repository's
own tree.

`../../../../../scripts/differential-real-trees.mjs`'s native leg answers "does
this provider's discovery-plus-graph pipeline reproduce a real tool's own
answer, on a tree neither of us built." It derives a `lattice.json`-equivalent
model mechanically from a real Nx workspace's own `nx graph --file=` output
(`deriveNativeModel`, one `projects.declared` row per node) — never
hand-authored, so the model is a measurement of the real tree rather than a
fixture this package's author already knew the answer to — runs
`nativeProvider.discover`/`buildGraph` over it, and compares the node set, edge
set, and rule verdicts against the same tree's real Nx-graph-based run,
classified through the differential's existing ledger. The first real run
(2026-08-12, against `code-pushup` at its pinned commit) found a populated
ledger, not an empty one — the expected outcome, argued in that file's own
`LEDGER` doc comment — and every row traces to a real, investigated cause
rather than an unknown: Nx's own root-project spelling (`root: "."`) needing
renormalisation before it reaches `lattice.json`'s dialect (which rejects that
exact spelling by name), and two narrower, pre-existing gaps in the shared
analysis pipeline that this leg surfaced but does not own fixing (a root-"."
project's own files going unowned by `createWorkspace`, and a TypeScript
import-type query the analyzer's AST walk does not visit) — both logged in
`LEDGER` with the reason, and both out of scope for this provider to change:
either fix moves what every consumer's boundary check reports on an unchanged
workspace, which is a breaking change on its own, argued separately from this
provider's own correctness.

`../../../../../.github/workflows/ci.yml`'s "Check this repository's own
module boundaries (native provider)" step answers the other half: does this
provider meet THIS repository's own real source, under a tag vocabulary
(`type:package`, `scope:nx`) nothing under `src/` has any knowledge of — the
same argument the Nx-based self-check step just above it makes for that path.
That step's own comment carries the full account of why this repository
cannot carry a root `lattice.json` alongside its own `nx.json`, and how the
throwaway copy the step runs against is built and proved to share this
repository's real `module-boundaries.config.mjs` — read it there rather than
here, so the mechanism has one description instead of two that could drift.
