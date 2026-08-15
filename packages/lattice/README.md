# lattice

Architecture enforcement for polyglot repositories — dependency graphs and module
boundaries for Go, Rust, Python, TypeScript, JavaScript and Vue, with Nx and
Moon as first-class integrations.

## Why it exists

In a polyglot repository, the languages ESLint cannot parse have `layer:`,
`scope:` and `license:` tags with no mechanism behind them — a Go import that
crosses a boundary passes lint because ESLint answers "File ignored because no
matching configuration was supplied" for `.go`. The same gap affects the
dependency graph: `nx affected` only knows about a dependency if it shows up as
an edge in the project graph, and Nx's own graph inference has no notion of a Go
import, a Cargo path dependency, or a `pyproject.toml` path dependency (uv,
Poetry or PDM). Without Lattice, changing a Go library never marks a sibling Go
project affected — silently defeating `nx affected` for every polyglot project
in the workspace.

Community plugins for the edge problem (gonx, `@nxlv/python`) solve it by also
inferring targets from the toolchain. Lattice deliberately does not: targets stay
hand-written in each `project.json`, so what a target does has one source of
truth. This tool adds the missing edges only.

The enforcement gap has its own answer. `@nx/enforce-module-boundaries` reads
only JavaScript, TypeScript and Vue, so in a Go or Rust project those tags are a
declaration with no enforcer. `src/analysis/` and `src/rules/` are where that
becomes a real check — all fifteen `@nx/enforce-module-boundaries` violation
types, under its eight options, over analysis records rather than an ESLint AST.

Lattice works in any repository — Nx and Moon are first-class integrations, not
dependencies. A workspace that has Nx gets graph reuse and `affected` integration;
a Moonrepo workspace gets the same from Moon's own project graph; a repository
that has neither loses nothing.

## Installing it

```shell
pnpm add -D @ecoma-io/lattice
```

### Any repository

Create a `lattice.json` at the repository root declaring your projects:

```json
{
  "projects": {
    "billing-core": { "root": "libs/billing/core" },
    "billing-api": { "root": "libs/billing/api" }
  }
}
```

The boundary config defaults to `module-boundaries.config.mjs` at the root, and
the TypeScript config to `tsconfig.base.json`. Both are read rather than assumed,
because they are conventions a workspace may rename, and a tool that hardcoded
either would answer confidently about a workspace it had misread. An unknown key
throws rather than falling back to a default: a `tsconfigBase` typed for
`tsConfig` that quietly used the default would produce a full green run against a
rule nobody wrote.

### An Nx workspace

Register the integration in `nx.json` instead, and it reuses the project graph Nx
already computes:

```json
{
  "plugins": [
    {
      "plugin": "@ecoma-io/lattice/nx",
      "options": {
        "boundaryConfig": "module-boundaries.config.mjs",
        "tsConfig": "tsconfig.base.json"
      }
    }
  ]
}
```

Both options default to the values above — the Nx conventions — so a workspace
that follows them can register the integration by name alone. An unknown key
throws rather than falling back to a default for the same reason as above.

`nx` is a peer dependency, and an optional one: it is resolved from your
workspace, so the graph this tool reads is the one your own `nx` command builds,
but nothing here bundles a copy. `lattice check` needs it only for project-graph
discovery; a workspace that never installed `nx` gets a named diagnostic and
exit 3 — never a raw module-resolution stack — rather than a graph built from a
copy this tool shipped, which could disagree with the workspace's own.

### A Moonrepo workspace

A workspace carrying a `.moon/` (or `.config/moon/`) directory at its root is
automatically recognised as a Moonrepo workspace. Lattice reads the project
graph from `moon project-graph --json` — the same one-call contract as the Nx
provider — and derives tags from each project's `moon.yml` declarations,
`layer`, and `stack`. The boundary config defaults to
`module-boundaries.config.mjs` at the root, and the TypeScript config to
`tsconfig.base.json`, the same defaults a native workspace uses.

## The boundary config

One file at the workspace root — the one `boundaryConfig` names — holds the
constraint table and the eight upstream options. It exports `depConstraints` in
exactly the shape `@nx/enforce-module-boundaries` takes, so in a TypeScript or
JavaScript workspace the same file feeds both enforcers and there is one table
rather than two:

```js
export const depConstraints = [
  { sourceTag: "layer:app", onlyDependOnLibsWithTags: ["layer:domain", "layer:util"] },
  {
    sourceTag: "scope:billing",
    onlyDependOnLibsWithTags: ["scope:billing", "scope:shared"],
    description: "Billing services must not reach outside their scope",
    remediation: "Move the shared logic into a scope:shared library",
  },
];

export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};

export const boundarySuppressions = [];
```

Nothing in this package defaults a constraint or an option. A default here would
be a second copy of a value that file already states, and the two would disagree
the day one changed.

## Running it in a terminal

The `lattice` bin reads the project graph from the selected provider,
analyzes every tracked source file a project owns, and reports every violation
with a `file:line:column` a developer can act on:

```shell
pnpm exec lattice check
pnpm exec lattice check --format sarif --output boundaries.sarif
pnpm exec lattice check --format json --output boundaries.json
pnpm exec lattice check --config boundaries.custom.mjs
pnpm exec lattice graph
pnpm exec lattice graph --format json --output snapshot.json
pnpm exec lattice diff snapshot.json
pnpm exec lattice diff snapshot.json --config boundaries.mjs
pnpm exec lattice impact billing-core
pnpm exec lattice impact billing-core --config boundaries.mjs
pnpm exec lattice explain libs/billing/main.go:10:5
pnpm exec lattice explain libs/billing/main.go:10:5 --format json
pnpm exec lattice context billing-core
pnpm exec lattice context billing-core --format json
```

`graph` prints the project graph as a deterministic snapshot: two sorted arrays,
one of projects and one of edges, with internal fields stripped and
`workspaceLayout` included. It is descriptive — a snapshot of what is is never a
finding — and never exits 1.

`diff` compares that snapshot (a file, not a git ref) with the current
workspace, reporting projects and edges added or removed. When a boundary config
is available (via `--config` or the workspace's own declaration), it also
reports which boundary violations the added edges introduce and which the
removed edges resolve. It refuses an incomplete baseline or head, because every
"removed" entry would be ambiguous between "gone" and "never seen". It is
descriptive and never exits 1.

`impact` takes a project name and lists every project that transitively depends
on it — the set a developer needs to consider before changing that project. It
separates direct from transitive dependents and refuses incomplete coverage.
When a boundary config is available, it also shows which constraint rows govern
each dependent's edge and whether it violates them. An empty `dependents` list
is a claim ("nothing depends on this"), not a shrug. It is descriptive and
never exits 1.

`explain` takes a `file:line:column` site and explains the judgment for that
one import: which constraint row matched, which tags applied, whether it is a
violation and why. Constraint rows that carry `description` or `remediation`
show those fields. A site that could not be resolved statically (a dynamic
`import()` with a non-literal argument) gets an `UNRESOLVABLE` verdict with
the reason. `explain` accepts `--config` (same as `check`) because the judgment
depends on which boundary law is in effect. It is descriptive and never exits 1.

`context` takes a project name and shows the architecture constraints that
govern it: the project's tags, which `depConstraints` rows match those tags,
and what each row allows or bans. It answers the question a developer or an AI
agent asks before editing a project — what is this project allowed to reach?
It is the same constraint table `check` judges from, rendered as a readable
summary rather than as a list of violations. It is descriptive and never
exits 1.

`--format json` wraps the same verdict `text` and `sarif` already compute in a
versioned envelope — every field name and `schemaVersion` are a public
contract from this release on, documented in full at
[docs/reference/json-output.md](../../docs/reference/json-output.md). It changes no
exit code and no byte of the other two formats; it is a third rendering of a
verdict every format already carries, for a caller that wants to script
against the result rather than parse a terminal report or a SARIF log.

Four exit codes, and the distinction that matters is **3** against **0**:

| code | meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 0    | clean — and every selected file was analyzed                               |
| 1    | findings — boundary violations, go.work drift, or dead tsconfig aliases    |
| 2    | usage error                                                                |
| 3    | no verdict — the run could not start, or a selected file could not be read |

A checker that could not look must never be mistaken for one that looked and
found nothing, which is why exit 3 exists and why it covers a **partial** run as
well as a total one: an unreadable file, a file with no analyzer, or a
`tsconfig` that will not load each leaves a file the summary counts but no rule
ever judged. Every verdict therefore names what it inspected:

```text
✔ no boundary violations (264 imports in 78 files across 1 project)
```

An import whose specifier is not statically knowable is not that case — the file
was judged and one position in it has no answer. Those are printed under their
own heading as declared blind spots, and the run does not fail on them.

When the workspace has a tracked `go.work` at its root, `check` also compares
its `use` list against every project's `go.mod`: a module in one list and not
the other means a developer's `go build` and CI select different trees, which
is drift nothing else notices. Both directions are findings and exit 1. The
file is read statically — `go` is never invoked — and a `go.work` the reader
cannot parse fails the run with exit 3 rather than being read as an empty `use`
list. A workspace without a root `go.work` pays nothing and hears nothing. The
check runs on the CLI only: a drift finding describes the workspace, not any
file being edited, so the language server does not publish it.

When the workspace tsconfig declares a `paths` table, `check` also judges each
alias for life: an alias mapped only to targets whose directories do not exist
resolves no import — the build breaks on it, or it silently resolves to an
installed package of the same name — and is a finding, exit 1. The table is
read from the same parsed tsconfig the import resolver uses and no specifier is
ever re-resolved; the exact rule and its limits are in
[docs/reference/languages.md](../../docs/reference/languages.md). A tsconfig that will
not load, or a `paths` value that is not an array of strings, fails the run
with exit 3 rather than being read as "no aliases". A workspace whose tsconfig
declares no `paths` pays nothing and hears nothing, and this check too runs on
the CLI only.

## Running it in an editor

The `lattice-lsp` bin speaks the Language Server Protocol over stdio
and publishes one diagnostic per boundary violation, carrying the same
`messageId` `@nx/enforce-module-boundaries` reports for that import. A file it
could not analyze gets a diagnostic saying exactly that — so an empty diagnostic
list from this server always means "no violation", never "not checked".

An editor rather than an ESLint plugin, because an ESLint plugin only runs where
ESLint has a parser. In a workspace that configures one, that is JavaScript,
TypeScript **and Vue** — measured, a `.vue` file importing a banned package draws
the same message from ESLint and from this tool, differing only in the column
each underlines. Go, Rust and Python have no parser at all, and that is the half
an ESLint plugin could never reach.

**Claude Code** installs it as a plugin, from this repository's marketplace:

```shell
claude plugin marketplace add ecoma-io/lattice
claude plugin install lattice@lattice
```

After that a session gets boundary diagnostics on every edit to a Go, Rust,
Python or Vue file. The server entry is `lspServers` in
`.claude-plugin/plugin.json`, and it claims every extension the analyzers handle
except the TypeScript and JavaScript family: an editor gives one server per file
extension, so claiming those would displace the language server a developer
actually needs there. `.vue` falls on the claimed side of that line and ESLint
reads it too, which makes Vue the one extension both enforcers cover.

**Any other LSP client** launches the same executable:

```text
command                node <workspace>/node_modules/@ecoma-io/lattice/lsp.mjs
transport              stdio
initializationOptions  { "workspaceRoot": "<workspace>" }
                       — only when the editor's root is not the workspace root
watched files          the boundary config, **/nx.json, and **/project.json
```

The workspace root is taken from `initializationOptions`, then
`workspaceFolders`, then `rootUri`, then `rootPath`, then the working directory.
Only full text synchronisation is advertised. A client that supports dynamic
registration is asked to watch the three files above — `nx.json` among them,
because that is where the option naming the boundary config lives, and a server
watching only the old filename would keep publishing verdicts from a config it
no longer reads. A client that cannot register dynamically is told so on stderr.

## What it deliberately does not do

It never creates project nodes and never infers or attaches targets — both stay
hand-written in each project's `project.json`. Resolvers never shell out to
`go`, `cargo`, or `uv`; they read only tracked manifest and source files (regex
over gofmt-canonical Go imports, `smol-toml` for `Cargo.toml`/`pyproject.toml`),
so the graph computes on machines that never installed those toolchains. It
never records external packages (crates.io, PyPI, the Go module proxy) as
`externalNodes` — only project-to-project edges matter to `nx affected`.

There is no option to switch a language off, and that absence is the design.
Every report of a disabled language would be byte-for-byte identical to that
language having no violations. Each analyzer already costs nothing in a
workspace without that language, because resolution is keyed on a manifest that
is not there.

And nothing here assumes any workspace's project names, areas, or tag values.
Everything comes from the project graph and the config the workspace
declares — which is what lets this run in trees it has never seen.

## Status

Both halves run, and CI proves it on this repository's own source: the same
`check` command runs against `lattice`'s tag vocabulary, which shares nothing
with the workspace the tool was written against.

`src/conformance/` measures where this engine and ESLint agree and where they do
not, over 46 fixture workspaces built for the purpose — 37 of them in the
languages ESLint can read. Both enforcers are meant
to run side by side: ESLint stays authoritative for JavaScript, TypeScript and
Vue; this tool covers Go, Rust and Python, where ESLint reports nothing at all.

Mechanics, per-language parse limits, and the one-manifest-per-project modeling
assumption are in [`./CLAUDE.md`](./CLAUDE.md).
