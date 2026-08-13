# lattice (`packages/lattice`)

Directory-scoped mechanics only — principles live in `AGENTS.md` at the
repository root.
Nx project name `lattice` (tags `type-package`, `scope-nx`), published
as `@ecoma-io/lattice`. Plain-ESM `.mjs` with no build; `typecheck`
is `tsc --noEmit` over the JSDoc (`AGENTS.md`, "No TypeScript here, and why").
The package publishes two entries: the root export (`index.mjs`) is the engine
— discovery and judgment, what `cli.mjs` and `lsp.mjs` both run on — and the
`./nx` subpath (`nx.mjs`) is the Nx-plugin face, the one module `nx.json →
plugins` is allowed to name and the only one Nx loads in the consumer's own
`nx` process. Nx is a peer dependency but an optional one
(`peerDependenciesMeta.nx.optional`): the engine and the CLI run without it,
and only the `./nx` entry and `readProjectGraph`'s Nx discovery path need it
installed.

**This package runs in workspaces it is not part of, and every mechanic below
follows from that.** It is installed from a registry into a tree whose project
names, areas, tag vocabulary, and directory layout it has never seen. Nothing
here may assume any of them — not this repository's, and not any other's. What
it may read is the graph Nx computes, the config the workspace declares, and the
options that config names. `src/conformance/boundary.test.mjs` is the code that
holds that line rather than prose; this repository's own
`module-boundaries.config.mjs` is what proves it, because its tag vocabulary
shares nothing with any workspace the tool was written against.

## What this project is for

Two halves of one gap, and the second is why the layering below exists.

- **Edges.** `nx affected` sees a dependency only as a graph edge, and Nx
  infers none for Go, Rust, or Python. `src/graph/` supplies them.
- **Enforcement.** `@nx/enforce-module-boundaries` reads only JS and TS, so a
  Go project's `layer:`/`scope:`/`license:` tags match no mechanism at all —
  measured: a `.go` file given an import that violates the layer axis showed
  the edge in the graph and its project's `lint` target exited 0, because that
  target runs `eslint project.json` and eslint answers "File ignored because no
  matching configuration was supplied" for `.go`. `src/analysis/` + `src/rules/`
  are where that becomes a real check.

## Layout, and what each layer may know

```
index.mjs              the engine entry — re-exports discovery + judgment
nx.mjs                 Nx plugin entry (`./nx` subpath) — re-export only
cli.mjs, lsp.mjs       executables (bin entries in package.json)
src/options.mjs        what a workspace may tell this tool about itself
src/analysis/          which import is written where, and what it resolves to
src/graph/             analysis reduced to Nx dependency records
src/config.mjs         loads + validates the workspace boundary config
src/workspace.mjs      which projects and files a run covers, and their analysis
src/providers/         where the graph `evaluate()` judges comes from
src/commands/          the preamble a CLI command shares — workspace, provider,
                       files, graph, analysis — composed from the layers above
src/rules/             the boundary rules — `evaluate(sites, graph, config)`
src/report/            rendering violations as text, SARIF, and the versioned
                       JSON envelope
src/lsp/               the language server: lifecycle, index, diagnostics
src/conformance/       the differential against ESLint, and this package's
                       checks on its own declarations
```

- **`nx.mjs` holds no logic.** Nx loads it on every graph computation, so what
  it imports is what every `nx` invocation pays for. Keep it a re-export.
  `index.mjs` is likewise a re-export, one layer up: it names the engine
  primitives `cli.mjs` and `src/lsp/` compose, so neither entry grows logic of
  its own — with one exception. `index.mjs` also exports a `createDependencies`
  that only throws, guarding the misregistration `"plugins": ["@ecoma-io/lattice"]`
  (the bare package name, missing `/nx`): measured against nx 23.1.1, that
  spelling resolves to `index.mjs` and, before this guard, loaded with no
  warning and computed zero polyglot edges — a silent graph, not a loud
  failure. One throwing function is the exception the rule above tolerates;
  anything doing real work still belongs under `src/`.
- **`src/analysis/` never judges.** It reports import sites; whether an import
  is allowed is `src/rules/`' question. An analyzer that filters its own output
  has taken a decision away from the layer that owns it.
- **`src/graph/` is a lossy view of analysis, on purpose.** An Nx edge is
  `{ source, target, sourceFile, type }` and Nx drops anything else, so the two
  layers stay separate rather than one growing fields the other discards.
- **`src/rules/` reads records, never files.** It gets analysis output and the
  loaded config, nothing more. Its own README carries the three upstream
  semantics a reimplementation gets backwards, and every place it is
  deliberately stricter than ESLint — read it before touching a rule.
- **`src/workspace.mjs` is the only layer allowed to answer "which files".**
  An analyzer is handed one file and a rule is handed records, so the question
  lands here — with the git spawn that comes with it: files come from
  `git ls-files`, because the graph JSON carries no file map and a tree walk
  would need ignore rules that drift from `.gitignore`. Projects and tags are a
  different question, answered by a `src/providers/` provider rather than a
  second walk of `project.json` files, which would disagree with Nx wherever a
  plugin contributes an edge. The git spawn here and the Nx spawn in
  `src/providers/nx.mjs` are both injectable, which is what lets a test drive
  the whole pipeline with neither Nx nor git present.
- **`src/providers/` is the only layer allowed to build a graph.**
  `evaluate()` is pure and takes a graph it does not build, so every node and
  edge it judges has to come from somewhere that isn't `src/rules/` itself.
  `src/providers/nx.mjs` gets one from `readProjectGraph`, which asks `nx
graph --file=` for it — the only place the package resolves and spawns the
  Nx CLI. (Not the only place it resolves `nx` at all: `src/nx-json.mjs`
  separately resolves Nx's own JSONC parser to read commented `nx.json`
  files, and is reached from `src/options.mjs` before any provider runs.)
  `readProjectGraph` also merges `nx.json`'s own `workspaceLayout` onto that
  graph — `src/options.mjs`'s `readWorkspaceLayout` reads it,
  `requireCompleteWorkspaceLayout` refuses a partial declaration rather than
  merging it onto the default — so a workspace naming a custom `libsDir`/
  `appsDir` is judged against the layout it actually declared instead of
  Nx's default `libs`/`apps`, the same fact `src/providers/native/model.mjs`
  already required all-or-nothing from `lattice.json`.
  `src/providers/native/` implements the same `ProjectModelProvider` seam
  from `lattice.json` plus the tracked tree, with no Nx installed, so
  `cli.mjs` and `src/lsp/` never need to know which provider they are
  holding. `src/providers/moon.mjs` implements the same seam for a Moonrepo
  workspace, reading the project graph from `moon project-graph --json` and
  normalising Moon's integer-indexed format into the same project-model shape.
  It resolves the `moon` binary from the workspace's `node_modules/.bin`,
  adding that directory to PATH so the CLI and language server find it without
  `pnpm exec`. `src/lsp/workspace-index.mjs` is a **consumer** of the native
  provider rather than a second implementation of it: on a tree whose
  tracked files include `lattice.json` it indexes through
  `nativeProvider.discover`/`buildGraph` (a model that will not load becomes
  a named, self-clearing index gap, never a silently empty index), on an Nx
  tree it discovers from tracked `project.json` files (`discoverProjects`,
  `buildNodes`), and in both shapes `nodeTypeOf` and `buildDependencies`
  come from `src/providers/native/`, not defined a second time. `lsp.mjs` itself holds only the stdio wiring.
- **`src/report/` renders, and decides nothing.** A formatter that filtered
  would be a rule wearing a formatter's name.
- **`src/options.mjs` is the only layer allowed to know what a workspace named
  its files.** Two names live there and nowhere else — the boundary config and
  the shared TypeScript config — because both are Nx _conventions_ a workspace
  may rename, and a tool that hardcoded either would answer confidently about a
  workspace it had misread. Everything downstream takes the resolved name as an
  argument: `loadBoundaryConfig(root, boundaryConfig)`, and `tsConfig` riding on
  the `workspace` object. Its header argues both the promotions and the one
  refusal — there is no `languages` option, because switching a language off is
  indistinguishable in every report from that language having no violations.

## The three consumers of the options, and why the seam is `nx.json`

`nx.json → plugins[].options` already exists in every workspace that registers
this plugin, and Nx threads it into every hook. So the configuration is derived
from a table the consumer already maintains rather than from a new config file —
and a new config file would have needed its own filename option to find itself.
A workspace with no `nx.json` — `lattice.json` at its root instead — states the
same two keys directly on that file's own `boundaryConfig`/`tsConfig` fields
(`src/providers/native/model.mjs`), because there is no `plugins[].options`
table to nest them under; a Moon workspace (`.moon/` directory present, no
`nx.json`) reads those same keys from `lattice.json` too, because Moon's own
configuration does not carry a plugin-options table. `cli.mjs`'s
`optionsForUsage` and `check` are the two places that read either shape, chosen
by which marker file the workspace root carries.

```json
"plugins": [
  {
    "plugin": "@ecoma-io/lattice/nx",
    "options": { "boundaryConfig": "module-boundaries.config.mjs", "tsConfig": "tsconfig.base.json" }
  }
]
```

Three faces read that one table, each by a different route, and the differences
are load-bearing:

- **The Nx hook** takes `options` from Nx directly and never reads `nx.json`.
  `createDependencies` validates it and then uses nothing from it — deliberately
  both halves. Edge resolution reads language manifests, which are not options;
  validating anyway is what makes a typo'd key fail at the _first_ graph
  computation rather than on whichever later CLI run happens to notice.
- **`cli.mjs`** calls `readPluginOptions(workspaceRoot)`, and `--config`
  overrides `boundaryConfig` for one run.
- **`src/lsp/server.mjs`** calls it at `initialize` and again on every
  invalidation. Its watched-file list is _derived_ from the resolved options
  (`watchedFilesFor`) and includes `nx.json` itself — a server watching only the
  file the old options named would keep watching a filename the workspace had
  stopped using, and every open file would keep showing a verdict from a config
  the server no longer reads.

An unknown key **throws**, at every one of those three doors. A `tsconfigBase`
typed for `tsConfig` that quietly fell back to the default is a full green run
against a rule nobody wrote.

## The one rule the language server exists to hold

**An empty diagnostic list must mean "no violation", and nothing else.** An
editor draws nothing for `[]`, and a developer reads nothing as "checked,
clean" — so a file the server could not analyze is the one case that must
never look like a file with no problems.

Two guards, deliberately: `src/lsp/diagnose.mjs` returns `analyzed: false`
with at least one diagnostic on every path that did not reach a verdict, and
`src/lsp/server.mjs` re-checks that before the bytes leave the process. An
empty list is published from exactly two named places — a completed analysis
that found nothing, and `clearDiagnostics` when a document closes. Anything
that adds a third is the defect this design is built around.

The consequence for a change here: a new failure mode needs a diagnostic, not
a `return`. A `catch` that swallows, an early `return []`, or a guard that
skips a document silently all produce the same wrong answer.

## The analysis contract is frozen — read it before writing an analyzer

`src/analysis/contract.md` fixes the record every language analyzer returns,
and `src/analysis/analyze.mjs` carries the same thing as JSDoc types. They are
edited together. Analyzers for different languages are meant to be written in
parallel, and that only works if none of them gets to reinterpret the shape.

The four decisions most likely to be re-litigated, each settled there with its
reason: the record is a **superset of a graph edge** (five of the fifteen rule
violations are decided on the raw specifier, which `nx graph --file=` does not
emit — measured, every edge it emits carries `source`, `target` and `type` and
nothing else); an **intra-project relative import is still emitted**; an
analyzer **never throws on a malformed file**, it records the failure; a
**dynamic import with a non-literal argument resolves to `null`** and is
reported unresolvable rather than dropped.

TypeScript resolution is `ts.resolveModuleName` — a public API, and `typescript`
is a declared dependency of this package for exactly that reason. Call it; never
reimplement path mapping or extension probing.

Two things that resolver structurally cannot answer, and what `typescript.mjs`
does instead of pretending. A **Node built-in** (`node:fs`, `fs`) has no
package to find, so it is classified by `node:module`'s own `isBuiltin` —
checked after TypeScript, never before, and never against a hand-kept list.
A **relative specifier TypeScript declines** because the extension is not one
it compiles (`.vue`, `.css`, `.svg`) is already a path: it is normalised and
tested for existence, with no extension probing, no `index` lookup and no
`paths` mapping. Anything beyond those two is the second resolver this package
must not grow — including an aliased asset (`@scope/ui/styles/global.css`),
which stays unresolved on purpose because resolving it would mean applying
`paths` here.

## Standing constraints

- **Static analysis by design.** Resolvers read tracked files only (regex over
  gofmt-canonical Go imports, `smol-toml` for Cargo/pyproject manifests), so
  the graph computes on machines without the language toolchains — a consumer's
  lint-only CI job, and contributors who never touch one of the four languages,
  never need Go/cargo/uv installed. Do not shell out to
  `go list`/`cargo metadata`/`uv` here; the moment a resolver needs the real
  toolchain, graph computation starts failing on machines that never touch that
  language.
- **Edges only, never nodes or targets.** Projects are still declared by
  hand-written `project.json`, and targets are never inferred — resist
  upstreaming the inferred-target model from gonx/@nxlv/python; rejecting it is
  this plugin's reason to exist.
- **No sibling package may be imported from here**, and no third-party package
  beyond Node's built-ins and a short declared list. Self-contained is what makes
  the published artifact honest: a consumer installs this one package and gets a
  working tool. `src/conformance/boundary.test.mjs` enforces both, walking the
  tree so a module added tomorrow is covered, and it is where the allow-list
  itself lives — one entry per package with the reason it earns. The list is NOT
  restated here on purpose: it used to be, it drifted, and prose beside a gate is
  the copy that loses. Adding a dependency means adding it there, in the same
  diff. Two entries whose reason is easy to lose: `vue/compiler-sfc` is reached
  through the `vue` dependency's own public subpath — the `@vue/compiler-sfc`
  package is NOT declared, so importing it by that name would be a phantom
  dependency pnpm's strict layout does not resolve — and it is loaded lazily via
  `createRequire` rather than at module scope, because this tool runs over trees
  with no Vue at all and a top-level import would make a missing `vue` break Go,
  Rust and Python analysis in a workspace with no `.vue` file in it. `nx`'s own
  `parseJson` is reached the same lazy way, for the same class of reason.
- **Never assume any workspace's project names, areas, or tag values** — this
  one's included. Installed from a registry, the tool's own directory is inside
  the consumer's `node_modules` while the tree it judges is above it, which is
  why `loadBoundaryConfig` takes a workspace root rather than walking up from its
  own location, and why every filename it reads is an argument rather than a
  constant. This repository's own boundary config exercises that in CI: its
  vocabulary is `type-package`/`scope-nx` and nothing in `src/` mentions either.
- **One module/crate/package per project root** is the modeling assumption for
  `src/graph/`: identity is `<projectRoot>/go.mod` · `Cargo.toml [package]` ·
  `pyproject.toml [project]`. A nested second manifest inside one project
  yields no edge — split it into its own project instead. **`src/analysis/` is
  deliberately broader**, because it attributes a FILE rather than a manifest:
  a crate or module nested inside a project still belongs to the project whose
  directory contains it. A Tauri app keeping its crate in `src-tauri/` is the
  case that reaches this: the graph draws no Rust edge for it while analysis
  reads its sources. The two disagreeing there is the documented modeling limit
  surfacing, not a bug in either.
- Known, pinned parse limits (see each analyzer's header + tests): Go block
  imports are read to the first `)` and commented-out imports inside a block
  still count; Rust reads `use` only at the start of a line and resolves a
  uniform path toward the crate, and a renamed `package = "…"` dependency is
  followed by the manifest resolver alone; Python matches per line, so a
  continued line or a triple-quoted string that looks like an import is
  misread. The worst case of every one is a spurious record naming text the
  file really contains — never a missed project.
- **Graph edges and source records answer different questions, and both stay.**
  A Python manifest edge requires an explicit workspace wiring under the
  declaring tool's documented semantics — a `[tool.uv.sources]` route, a Poetry
  `{ path = "…" }`, a PDM root-anchored local URL; no declaration, no edge,
  even when the name matches a sibling package — while `analyzePython` reads
  the `.py` sources, where an undeclared `import other_project.thing` imports
  fine at runtime and crosses the boundary anyway. Neither replaces the other;
  a declared-but-unused dependency and an undeclared-but-imported one are both
  findings.
- External packages (crates.io, PyPI, Go module proxy) are deliberately NOT
  added as `externalNodes` — only project↔project edges matter to
  `nx affected`, and external-node bookkeeping is where the community
  plugins grow their complexity.

## The boundary rules live at the consumer's workspace root

One file there — named by the `boundaryConfig` option, `module-boundaries.config.mjs`
unless the workspace says otherwise — is the single home of the constraint table
and the eight `@nx/enforce-module-boundaries` options. `src/config.mjs` reads it,
and in a TypeScript workspace the same file is what the workspace's own ESLint
config feeds to `@nx/enforce-module-boundaries`, so both enforcers answer from
one table. Nothing here restates a constraint, and nothing here defaults an
option — a default would be a second copy of a value that file already states,
and the two would disagree the day one changed.

`src/config.mjs` validates shape only. Whether `layer:adapter` may reach
`layer:domain` is the workspace's decision, argued in that config's comments.

The file that name resolves to may be an `.mjs`/`.js` module (`import()`ed), a
`.json` file (`JSON.parse`d, never JSONC), or an ESLint flat config named by
basename (`eslint.config.*`) rather than extension —
[`docs/usage/policy-file.md`](../../docs/usage/policy-file.md) is the dialect
reference for all three. `src/config.mjs`'s `loadBoundaryConfigFile` is the
one dispatch site, and it tests basename STRICTLY BEFORE extension: an
`eslint.config.*` name always reaches `src/eslint-config.mjs`, and a legacy
`.eslintrc*` name is always refused by name, before either one's usually
`.mjs`/`.js` extension can reach the module dialect and half-succeed on a
config that was never meant to be read as one. Only once neither basename
matches does the extension decide between the `.mjs`/`.js` module dialect and
the `.json` file dialect. `src/eslint-config.mjs` reads the constraint table
off that file's own `@nx/enforce-module-boundaries` entry rather than a
second, hand-kept copy, and refuses loudly on every shape it cannot map onto
one. All three dialects hand their data to the one `findBoundaryConfigViolations`
function above, through the shared `policyFrom` tail — never a second copy of
what a constraint row or an option may hold. A native workspace's
`lattice.json` accepts a fourth spelling for the same field: the policy
inline, as an object rather than a filename (`src/providers/native/model.mjs`),
validated by that same function before `cli.mjs`'s native branch ever reads it.

Not every face reads every dialect. `src/lsp/boundary-config.mjs` dispatches
basename-then-extension a second time rather than calling
`loadBoundaryConfigFile` — for the `.mjs`/`.js` and `.json` dialects it does
read, it needs the `.mjs`/`.js` arm's `import()` to carry a revision the
module cache would otherwise ignore across edits, which `loadBoundaryConfigFile`
has no reason to do for a process that loads a config once and exits — but it
shares the same `policyKeyViolations`/`policyFrom` validators, so a `.json`
`boundaryConfig` reaches the identical verdict from the language server as it
does from `cli.mjs` and the Nx hook. Two spellings stay out of its reach: the
ESLint flat-config dialect is refused by the same basename check, by name,
before any `import()` runs — this server was not built against either of that
dialect's two mechanisms (`@nx/eslint-plugin` resolution, revision-suffixed
import), and reusing it without working through both would be a guess dressed
as support; and `src/lsp/server.mjs`'s `readWorkspaceOptions` refuses to start
over a native root whose `boundaryConfig` is the inline-object form, loudly,
because this server only ever watches and re-reads a policy _file_ —
`../../docs/usage/policy-file.md`'s "An inline policy, for `lattice.json`"
names that limitation on the consumer-facing side, and its ESLint-dialect
section names the language-server gap on the other.

## What is a stub, and how each one says so

Nothing that cannot enforce reports success — see the invariant in `AGENTS.md`
at the repository root. Concretely:

- `analyzeFile` dispatches through two tables — extension → language, language
  → analyzer — and **throws** for a language the first table claims and the
  second does not, naming it. That is how the next language stays loud before
  its analyzer lands. An unrecognised extension is a no-op returning the empty
  envelope: the dispatcher is pointed at every tracked file, and `README.md`
  is not an error.
- `cli.mjs check` keeps four distinct exit codes, and the distinction that
  matters is **3** (the run could not complete — no workspace, malformed
  config, `nx graph` or `git` failed) against **1** (findings — boundary
  violations, go.work drift, or dead tsconfig path aliases; `src/go-work.mjs`
  and `src/tsconfig-paths.mjs` own those checks' semantics and limits) and
  **0** (clean). A checker that could not look must never be mistaken for one
  that looked and found nothing; **2** stays a usage error. Exit 0 was the
  bug. A malformed go.work is the 3-class on purpose: read as an empty use
  list it would mean "no drift", which is the silent direction — and a
  tsconfig that will not load, or a `paths` value that is not an array of
  strings, is the 3-class for the same reason: read as "no aliases" it would
  silence the paths check exactly where the table is most broken.
  `check` also states what it inspected — imports, files, projects — beside
  every verdict, because "no violations" is a claim about coverage too. `check`
  is, so far, the only command `cli.mjs`'s `COMMANDS` table holds — exit 1 is
  its exit code alone, and every verb the table might grow later only ever
  reads, so a future command that finds something reports it without claiming
  the boundary-violation exit code that means specifically this.
  `--format json` (`check` only, for now) wraps the same verdict in the
  versioned envelope `src/report/json.mjs` builds and `docs/usage/json-output.md`
  documents — a third rendering, changing no exit code and no byte of the text
  or SARIF report.
- `lsp.mjs` advertises `textDocumentSync` because it now serves it. What it
  still does not advertise is everything else: no hover, no definition, no
  incremental sync. A capability is a promise, and incremental sync in
  particular stays unadvertised until it can be proven correct, because one
  mis-applied ranged edit puts every later diagnostic on the wrong line.

## Tests

- **An analyzer test that would pass against a hard-coded name→project map is
  not a test.** Resolution is driven over an in-memory workspace whose
  `readFile` backs a real fixture tree, so `ts.resolveModuleName` runs for
  real; `typescript.test.mjs` repoints a `tsconfig.base.json` alias without
  changing the specifier and requires the answer to move with it.
- **The Vue analyzer's positions carry two tiers, and it needs both.**
  `vue.test.mjs` mocks the TypeScript analyzer to pin the text handed over —
  the whole file with everything outside the script block blanked, so no
  arithmetic can be wrong. `vue.integration.test.mjs` drives the real pair and
  checks the line a reader finally sees, against positions computed from the
  fixture rather than written as literals. A diagnostic naming the wrong line
  is worse than none, so it is pinned from both sides.
- The resolver contract is shared and injectable:
  `resolve(projects, filesOf, readFile)`. Unit tests inject in-memory files;
  `src/graph/create-dependencies.integration.test.mjs` drives the real entry
  point over a tmpdir fixture with the Nx context shape. When Nx changes that
  shape (watch `CreateDependenciesContext` in nx's `public-api.d.ts` on
  upgrades), the integration test is the tripwire. It reaches through
  `nx.mjs` deliberately — an entry that stopped re-exporting
  `createDependencies` would drop every polyglot edge while a test pointed at
  the implementation stayed green.
- `src/config.integration.test.mjs` loads **this repository's own** root
  boundary config, so a malformed constraint row fails here rather than as a
  rule that silently matches nothing. It is also the proof the reader takes its
  filename from a caller: one case asks for a name that does not exist and
  requires the error to name it back.
- `cli.mjs` and `lsp.mjs` are driven as spawned subprocesses, which in-process
  V8 coverage cannot see — hence their absence from `vitest.config.mjs`'s
  coverage `include`; a process boundary is the exclusion's reason, not a
  convenience.
  `cli.integration.test.mjs` therefore does both: it spawns the real binary for
  the exit-code and usage contract, and calls `check()`/`runCli()` in-process
  over a fixture Go workspace — real analyzer, real rules, real report, with
  only Nx and git injected — so the exact `file:line:column` a developer acts
  on is pinned rather than assumed.
- **A SARIF test that only checks the file parses is not a test.** The failure
  guarded against is an upload GitHub silently rejects, so
  `report/sarif.integration.test.mjs` builds one result per `messageId` from
  the real message table and asserts the fields a rejection turns on: a
  `ruleId` that resolves in the catalogue, a non-empty message, and a
  repository-relative `uri` with a 1-based `startLine`/`startColumn`.
- That is also why `lsp.mjs` holds only wiring: everything with a decision in
  it lives under `src/lsp/`, where coverage can see it.
- **The language server's coordinate conversion is pinned from the fixture,
  never from a literal.** `src/lsp/diagnostics.test.mjs` computes the expected
  0-based position by searching the fixture text, so changing the fixture
  moves both sides and changing the conversion moves only one. A diagnostic
  one line off is worse than no diagnostic: it sends every reader to the wrong
  import, confidently.
- **The editor configuration is tested against the analyzer registry.** A
  `.lsp.json`-style manifest cannot import anything, so its extension list is
  a second copy of `LANGUAGE_BY_EXTENSION`;
  `src/lsp/editor-config.integration.test.mjs` is what keeps that copy honest,
  the same arrangement `messages.mjs` has with
  `upstream.integration.test.mjs`.
