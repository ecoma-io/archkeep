# nx-polyglot-graph

## Why it exists

`nx affected` only knows about a dependency if it shows up as an edge in the Nx
project graph, and Nx's own graph inference has no notion of a Go import, a
Cargo path dependency, or a `[tool.uv.sources]` entry. Without this plugin,
changing a Go library never marks a sibling Go project affected — silently
defeating `nx affected` for every polyglot project in the workspace. Community
plugins for this problem (gonx, `@nxlv/python`) solve it by also inferring
targets from the toolchain. This one deliberately does not: targets stay
hand-written in each `project.json`, so what a target does has one source of
truth. This plugin adds the missing edges only.

The same gap has a second half. `@nx/enforce-module-boundaries` reads only
JavaScript, TypeScript and Vue, so in a Go or Rust project the `layer:`,
`scope:` and `license:` tags are a declaration with no mechanism behind them: a
`.go` file given an import that violates the layer axis shows the edge in the
graph and still passes `lint`, because ESLint answers "File ignored because no
matching configuration was supplied" for `.go`. `src/analysis/` and `src/rules/`
are where that becomes a real check — all fifteen
`@nx/enforce-module-boundaries` violation types, under its eight options, over
analysis records rather than an ESLint AST.

## Installing it

```shell
pnpm add -D @ecoma-io/nx-polyglot-graph
```

Register it in `nx.json`, and tell it what your workspace named its files:

```json
{
  "plugins": [
    {
      "plugin": "@ecoma-io/nx-polyglot-graph",
      "options": {
        "boundaryConfig": "module-boundaries.config.mjs",
        "tsConfig": "tsconfig.base.json"
      }
    }
  ]
}
```

Both options default to the values above — the Nx conventions — so a workspace
that follows them can register the plugin by name alone. Both are read rather
than assumed because they are conventions a workspace may rename, and a tool
that hardcoded either would answer confidently about a workspace it had misread.
An unknown key throws rather than falling back to a default: a `tsconfigBase`
typed for `tsConfig` that quietly used the default would produce a full green
run against a rule nobody wrote.

`nx` is a peer dependency and is resolved from your workspace, so the graph this
tool reads is the one your own `nx` command builds.

## The boundary config

One file at the workspace root — the one `boundaryConfig` names — holds the
constraint table and the eight upstream options. It exports `depConstraints` in
exactly the shape `@nx/enforce-module-boundaries` takes, so in a TypeScript
workspace the same file feeds both enforcers and there is one table rather than
two:

```js
export const depConstraints = [
  { sourceTag: "layer:app", onlyDependOnLibsWithTags: ["layer:domain", "layer:util"] },
  { sourceTag: "scope:billing", onlyDependOnLibsWithTags: ["scope:billing", "scope:shared"] },
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

The `nx-polyglot-graph` bin reads the Nx graph, analyzes every tracked source
file a project owns, and reports every violation with a `file:line:column` a
developer can act on:

```shell
pnpm exec nx-polyglot-graph check
pnpm exec nx-polyglot-graph check --format sarif --output boundaries.sarif
pnpm exec nx-polyglot-graph check --config boundaries.custom.mjs
```

Four exit codes, and the distinction that matters is **3** against **0**:

| code | meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 0    | clean — and every selected file was analyzed                               |
| 1    | violations found                                                           |
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

## Running it in an editor

The `nx-polyglot-graph-lsp` bin speaks the Language Server Protocol over stdio
and publishes one diagnostic per boundary violation, carrying the same
`messageId` `@nx/enforce-module-boundaries` reports for that import. A file it
could not analyze gets a diagnostic saying exactly that — so an empty diagnostic
list from this server always means "no violation", never "not checked".

An editor rather than an ESLint plugin, because an ESLint plugin only runs where
ESLint has a parser. In a workspace that configures one, that is JS, TS **and
Vue** — measured, a `.vue` file importing a banned package draws the same
message from ESLint and from this tool, differing only in the column each
underlines. Go, Rust and Python have no parser at all, and that is the half an
ESLint plugin could never reach.

**Claude Code** installs it as a plugin, from this repository's marketplace:

```shell
claude plugin marketplace add ecoma-io/lattice
claude plugin install nx-polyglot-graph@lattice
```

After that a session gets boundary diagnostics on every edit to a Go, Rust,
Python or Vue file. The server entry is `lspServers` in
`.claude-plugin/plugin.json`, and it claims every extension the analyzers handle
except the JS/TS family: an editor gives one server per file extension, so
claiming those would displace the language server a developer actually needs
there. `.vue` falls on the claimed side of that line and ESLint reads it too,
which makes Vue the one extension both enforcers cover.

**Any other LSP client** launches the same executable:

```text
command                node <workspace>/node_modules/@ecoma-io/nx-polyglot-graph/lsp.mjs
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
Everything comes from the graph Nx computes and the config the workspace
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
