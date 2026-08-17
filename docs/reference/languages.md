# What each language sees

Two questions per language, and they have different answers:

- **Edges** — what makes `nx affected` mark a project affected. Read from
  manifests.
- **Analysis** — what makes a boundary violation reportable at a
  `file:line:column`. Read from sources.

They are kept separate on purpose. A manifest says a dependency _may_ be used; it
never says a boundary _was crossed_, and `Cargo.toml:1` is not a location anyone
can act on. The two disagreeing is itself information: a declared-but-unused
dependency and an undeclared-but-imported one are both findings.

| extension                                             | language                  | edges from                         | analysis |
| ----------------------------------------------------- | ------------------------- | ---------------------------------- | -------- |
| `.go`                                                 | Go                        | `go.mod`                           | ✅       |
| `.rs`                                                 | Rust                      | `Cargo.toml`                       | ✅       |
| `.py`                                                 | Python                    | `pyproject.toml` (uv, Poetry, PDM) | ✅       |
| `.ts` `.tsx` `.mts` `.cts` `.js` `.jsx` `.mjs` `.cjs` | TypeScript and JavaScript | Nx's own inference                 | ✅       |
| `.vue`                                                | Vue                       | Nx's own inference                 | ✅       |

Anything else is a no-op: the dispatcher is pointed at every tracked file, and
`README.md` is not an error. A file whose extension _is_ on this list but whose
analyzer is missing **throws**, naming the language — that is how the next
language stays loud before its analyzer lands.

## Everything here is read statically

No `go`, no `cargo`, no `uv`, no `python`, no `tsc` process. Manifests are parsed
as data, sources are read as text.

That is not minimalism. Nx computes the project graph on _every_ `nx`
invocation, so a graph that needs four toolchains installed is a graph that fails
on the machine that does not have them — a lint-only CI job, or a contributor who
touches none of the four languages. The cost of that choice is a set of parse
limits, and every one of them is listed below.

**Every limit errs the same way.** The worst case of each is a _spurious record
naming text the file really contains_ — never a missed import. A false alarm gets
argued about and fixed; a missed import is byte-for-byte identical to a clean
file. The limits are pinned by tests, so a fix that changes one has to change the
test that documents it.

---

## Go

**Identity:** one Go module per project, at `<projectRoot>/go.mod`. The module
path is the project's identity, and an import of another project's module path
(exact, or `<modulePath>/...`) is an edge.

**Comments are blanked before anything is matched.** This matters more than it
sounds: a `)` written inside a comment — including the note a blank import
conventionally carries, `_ "github.com/lib/pq" // register the driver (postgres)`
— would close an `import (…)` block early and make every import below it vanish.
No edge, no record, and the file reports clean with a violation sitting in it.

### Limits

- A **raw string literal** containing what looks like an import declaration at
  the start of one of its lines is read as one. This is the only limit a
  `gofmt`-clean tree still meets — the mask keeps raw strings intact deliberately,
  because an import path _is_ a string literal.
- `import` must open its line, after indentation only. `import "a"; import "b"`
  yields the first alone, and inside a block each import needs its own line.
  `gofmt` rewrites both shapes.
- An import path spelled as a raw string rather than a quoted one is not read.
  Legal Go; `gofmt` rewrites it.

### What the record deliberately leaves null

- **`file` is always null.** A Go import names a _package directory_, not a file,
  and which files that directory contributes is a build-constraint question
  needing the toolchain this avoids.
- **`packageName` for an external import is the whole import path.** Where a
  module path ends and a package path begins inside `example.com/a/b/c` is not
  statically knowable — only the module proxy knows — so the full path stands in,
  and a `bannedExternalImports` pattern matches it the same way.
- **`kind` is always `static`.** Go has no dynamic import, no type-only import
  and no re-export form; a blank (`_`) or dot (`.`) import is still a
  compile-time dependency.

### go.work is checked against the graph

A `go.work` at the workspace root decides, through its `use` directives, which
modules a developer's `go build` and gopls load — while the graph covers every
project carrying `<projectRoot>/go.mod`. Nothing ties the two lists together,
and drift between them is byte-for-byte invisible: the dev machine and CI build
different module sets and both look fine on their own. So when a **tracked**
`go.work` exists at the root, `check` compares the lists, both directions are
findings, and either direction fails the run with exit 1:

- **`goWorkMissingUse`** — a `go.mod` project whose directory no `use` entry
  names. The graph judges it; the developer's build skips it.
- **`goWorkStaleUse`** — a `use` entry with no tracked `go.mod` at its
  directory. `go` itself fails on such an entry on every developer machine,
  while CI — which never reads `go.work` — stays green.
- **`goWorkUnmodeledUse`** — a `use` entry whose `go.mod` exists but is not at
  an Nx project root: nested inside a project, or inside no project. It builds
  locally while the boundary check never sees it.
- **`goWorkOutsideUse`** — a `use` path above the workspace root, which no run
  over this workspace can cover.

The comparison follows the graph's model — one module per project root — so a
nested `go.mod` is never _required_ to appear in `use`; it is reported only
when a `use` entry names it, because that is the moment the developer's build
and the graph demonstrably diverge.

Reading is static, per the documented `go.work` grammar (single-line and block
`use`, `//` comments, quoted and raw string paths, absolute and relative
paths); `go` is never invoked, the same refusal as everything else on this
page. A `go.work` the parser cannot read — an unclosed block, an unterminated
string, a `use` without a path, or a keyword outside `go.work`'s own five
(`go`, `toolchain`, `use`, `replace`, `godebug`), which rules out text that is
not a go.work file at all — **fails the run with exit 3** rather than being
read as an empty `use` list, because an empty list here would mean "no drift".
Two declared parse limits: a string may not span a line, and paths are
compared with `/` separators, so a `\`-separated Windows path surfaces as a
drift finding naming the text the file contains — loud, never silent.

A workspace with no root `go.work` pays nothing, and the report says nothing
about it; there is no switch. The check runs on the CLI only, not in the
language server: a drift finding describes the workspace, not any file being
edited, and a workspace-level report pinned to whichever file happens to be
open would put the report where its fix is not.

---

## Rust

**Identity:** one crate per project, at `<projectRoot>/Cargo.toml`. Edges come
from `{ path = "…" }` dependencies and from `{ workspace = true }` entries
resolved through the nearest ancestor manifest carrying `[workspace]` — whose own
entry must itself be a path dependency to point at a project. Registry
(crates.io) dependencies draw no edge.

**Two spellings are reconciled**, and both occur in real trees: Cargo replaces
`-` with `_` for the identifier (`engine-core` is `use engine_core::…`), and a
`[lib] name` overrides the package name outright — a Tauri package declaring
`[lib] name = "app_lib"` makes that the only spelling its own `main.rs` can use.
`[lib] name` wins when present.

### Limits

- **`use` is matched at the start of a line**, after optional indentation and an
  optional `pub`/`pub(crate)`, read to the first `;`. A `use` inside a raw string
  that starts its own line would be read; a `use` preceded on the same line by an
  attribute or another statement would not. `rustfmt` produces neither.
- **A `use` opening with a brace group** — `use {a::b, c::d};` — names no crate
  before the group. It is recorded with `resolved: null` _and a failure_, because
  guessing which arm was meant is exactly the guessing the contract forbids. The
  record is never dropped.
- **Uniform paths are resolved toward the crate.** Since Rust 2018 `use foo::Bar`
  can name an extern crate or a local `mod foo`. A first segment matching another
  project's crate name is read as that crate, so a local module deliberately
  named after a sibling crate produces a spurious record.
- **A renamed dependency is not followed at source level.**
  `dep = { package = "real" }` makes the source spell `dep` while the crate is
  `real`. The manifest resolver still draws the edge, so the dependency is never
  lost — only its source-level location is.
- **`mod` is not an import.** It names a file inside the same crate and crosses
  no boundary.

### One modelling limit worth knowing

Graph identity is one manifest per project root, but _analysis_ attributes a
**file** rather than a manifest — so a crate nested inside a project still belongs
to the project whose directory contains it. A Tauri app keeping its crate in
`src-tauri/` is the case that reaches this: the graph draws no Rust edge for it
while analysis reads its sources. The two disagreeing there is the documented
modelling limit surfacing, not a bug in either.

---

## Python

**Identity:** one package per project, at `<projectRoot>/pyproject.toml`,
named by `[project].name`. An edge exists only where the manifest **explicitly
wires a dependency to a workspace path** — each tool's documented semantics, not
string matching. A name that merely coincides with a sibling package draws no
edge, under any of the three tools read:

- **uv** — a dependency string in `[project].dependencies`,
  `[project.optional-dependencies].*` or `[dependency-groups].*` creates an edge
  only when `[tool.uv.sources]` routes that name to the workspace
  (`{ workspace = true }`) or to a path that is another project's directory.
- **Poetry** — `name = { path = "…" }` in `[tool.poetry.dependencies]` or
  `[tool.poetry.group.<group>.dependencies]`, including each element of the
  multiple-constraints array form. `develop` changes install mode, never whether
  the dependency exists, so it is ignored. The legacy
  `[tool.poetry.dev-dependencies]` table is not read: it appears nowhere in
  current Poetry documentation.
- **PDM** — a requirement string in the same three dependency arrays, in the two
  root-anchored local forms its docs write:
  `name @ file:///${PROJECT_ROOT}/<path>` (pdm-backend) and
  `name @ {root:uri}/<path>` (hatchling), plus the editable
  `-e file:///${PROJECT_ROOT}/<path>` entry in `[dependency-groups]`.
  `[tool.pdm.dev-dependencies]` is not read: current PDM docs route development
  groups through `[dependency-groups]`, which is already scanned.

**Where a declared path lands decides what happens, and one landing is loud.**
Relative paths resolve against the declaring manifest's directory. Another
project's root is an edge. The declaring project itself — its root or anything
under it, such as a vendored wheel — is no edge, because no cross-project wiring
exists. A path that climbs out of the workspace is no edge, as a verdict: what
sits outside the tree is not a workspace project, the same answer a PyPI package
gets. But a path that lands **anywhere else in the tree** — no project's root, or
a file inside another project — **fails graph computation with an error** naming
the manifest, the entry, and where the path landed. A skipped entry there would
be an edge `nx affected` silently never sees on a wiring the manifest plainly
states. A PDM local URL that is not root-anchored (an absolute `file:///…`, which
other build backends write) fails the same way, because without the anchor the
target cannot even be placed relative to the tree. A `pyproject.toml` that is not
valid TOML draws no edges and does **not** fail — Nx recomputes the graph on
every invocation, so a manifest is malformed mid-keystroke in every editing
session; the loud report for that state is the analysis layer's.

**The manifest and the source disagree here more than anywhere else, and that gap
is a real false negative rather than a theoretical one.** A `.py` file writing
`import other_project.thing` with no manifest declaration imports perfectly at
runtime — in a uv workspace both packages are installed and both are on
`sys.path` — while the manifest says nothing at all. Source-level analysis is
what catches it.

**Import roots come from the filesystem**, because that is what Python reads:
`src/<pkg>/__init__.py`, `<pkg>/__init__.py`, and `<mod>.py`, with both
`<projectRoot>/src` and `<projectRoot>` scanned in that order.

**Build-backend layout declarations are read**, because assuming the two default
bases were the whole layout asserted a falsehood rather than admitting a gap: an
import that resolved to nothing was classified `external: true`, and every tag
constraint then evaporated. Four table shapes are read —
`[tool.setuptools] package-dir`, `[tool.setuptools.packages.find] where`,
`[tool.hatch.build.targets.wheel] packages`, and `[tool.poetry] packages` — for
whichever backend is declared.

**Everything else is a failure, never an `external: true`.** An unread
`package-dir` key, a hatch `sources` rewrite, a poetry `to`, invalid TOML, or a
backend this does not read all mean the same thing: some directory may be
importable under a name nothing here knows. The import is recorded with
`resolved: null` and a failure naming the manifest that put the answer out of
reach.

**PEP 420 namespace packages** are handled by indexing every importable dotted
path and matching the **longest** prefix: `import ns.alpha.thing` resolves
through `ns.alpha` to the project that owns it, never through the shared `ns`.
When the longest matching prefix is genuinely owned by more than one project,
that is reported as an ambiguity with `resolved: null` — Python resolves it by
`sys.path` order, which no static reader can know.

### Limits

- **Imports are matched per line**, at any indentation. That is deliberate: it is
  what catches a function-local import and an import under `if TYPE_CHECKING:`,
  both of which cross a boundary. A line continued with `\`, or a second statement
  after `;`, is not followed.
- **A triple-quoted string containing a line that looks like an import** is read
  as one. `#` comments are not, since the `#` precedes the keyword.
- **`if TYPE_CHECKING:` imports stay `kind: "static"`.** They are erased at
  runtime, so `type-only` is tempting — but a TYPE_CHECKING guard is a runtime
  conditional, not a declaration that the dependency is absent. The module is
  still named and the boundary is still crossed. Marking them `type-only` would
  let a rule that exempts erased imports exempt them, which is the bypass this
  tool exists to close.
- **`packageName` for an external import is the top-level import name**, not the
  PyPI distribution name. The two differ (`import PIL` ships as `pillow`) and only
  the import name is knowable from a source file.

---

## TypeScript and JavaScript

**Edges are Nx's own** — Nx already infers them, and a second inference would be
a second answer to a question that has one.

**Resolution is `ts.resolveModuleName`**, TypeScript's public API, driven by the
workspace's `tsConfig`. It is called rather than reimplemented: path mapping and
extension probing have too many correct-looking approximations.

Two things that resolver structurally cannot answer, and what happens instead:

- **A Node built-in** (`node:fs`, `fs`) has no package to find, so it is
  classified by `node:module`'s own `isBuiltin` — checked _after_ TypeScript,
  never against a hand-kept list.
- **A relative specifier TypeScript declines** because the extension is not one
  it compiles (`.vue`, `.css`, `.svg`) is already a path: it is normalised and
  tested for existence, with no extension probing, no `index` lookup and no
  `paths` mapping.

Anything beyond those two stays unresolved on purpose — including an aliased
asset like `@scope/ui/styles/global.css`, because resolving it would mean
applying `paths` here, which is the second resolver this package must not grow.

**ESLint already covers this language**, and `@nx/enforce-module-boundaries`
should keep running for it. This analyzer exists because the CLI and the language
server judge the whole tree, and a report that skipped TypeScript and JavaScript
would be answering a different question than the one asked.

### The paths table is checked for dead aliases

A `paths` alias whose every target has rotted away resolves no import: the
build breaks on it, or — worse — TypeScript falls back to `node_modules` and an
installed package of the same name answers instead, so every boundary decision
quietly reads the import as external rather than as the workspace source the
alias promised. Nothing else reports either state, so when the workspace
tsconfig declares a `paths` table, `check` judges each alias for life and a
dead one — one message id, **`tsconfigDeadPathAlias`** — **fails the run with
exit 1**, the way a violation does.

The check judges the alias table itself and never resolves a specifier —
resolving one would mean applying `paths` here, which is the second resolver
this package must not grow (the refusal two paragraphs up). What it may
honestly decide instead rests on one measured fact: every candidate TypeScript
can form from a target lives at or below the directory of the target's static
prefix (the text before the first `*`; the whole target when it has none). So
a target is unreachable when that directory does not exist, and an alias is
dead when its target list is empty or every target is unreachable. Targets
resolve against `baseUrl` when set, else against the declaring config file's
directory — TypeScript's own precedence — and the table itself is read from
the same parsed tsconfig `ts.resolveModuleName` uses, `extends` chains
included, so the check and the resolver cannot disagree about what it says.

The honest limits, each the near side of that same line: a missing file whose
directory survives is **not** reported (TypeScript probes other extensions and
`index` candidates there, and reproducing that per-mode set is the refused
resolver); an alias whose pattern holds more than one `*` (which TypeScript
ignores entirely), or a target pointing outside the workspace, is counted
beside the verdict as unjudged, never guessed either way. A tsconfig that does
not load, or a `paths` value that is not an array of strings, **fails the run
with exit 3** rather than being read as "no aliases" — an absent table and a
broken one must not report alike.

A workspace whose tsconfig declares no `paths` — or that has no tsconfig —
pays nothing, and the report says nothing about it; there is no switch. Like
the go.work comparison above, the check runs on the CLI only, not in the
language server, for the same reason: it describes the workspace's table, not
any file being edited.

---

## Vue

**Edges are Nx's own.** Analysis uses the official SFC parser
(`vue/compiler-sfc`, reached through the `vue` dependency's own public subpath)
to find `<script>` blocks, and hands each one to the TypeScript analyzer.

**Positions are mapped by blanking, not by arithmetic.** Each block is analyzed in
a copy of the whole file with every character outside that block replaced by a
space and newlines kept — so the code sits at exactly the offsets, lines and
columns it occupies in the `.vue` file, and every position TypeScript reports is
already a `.vue` position. The obvious implementation (analyze the block, then add
its start line) has an off-by-one on the block's first line and needs a second,
different correction for a second `<script>` block. A diagnostic naming the wrong
line is worse than no diagnostic, so there is no arithmetic left to get wrong.

**The parser is loaded lazily**, on first use. This tool runs over trees with no
Vue at all, and a top-level import would make a missing `vue` break Go, Rust and
Python analysis in a workspace with no `.vue` file in it. A missing parser becomes
a failure record naming what is absent, like anything else this layer could not
do.

**Vue is the one extension both enforcers cover.** A workspace configuring
`vue-eslint-parser` gets real boundary enforcement in `.vue` files from ESLint
too — measured, both engines report the same `messageId` and message on the same
violation, differing only in column. This tool checks it anyway, as a second
opinion the conformance suite holds to the same verdict.

---

## What "not supported" would look like

There is **no option to switch a language off**, and that absence is the design.
A report from a workspace that disabled Go would be byte-for-byte identical to a
report from a workspace whose Go is clean.

A workspace pays nothing for a language it does not have: every resolver keys off
a manifest that is not there, and the Vue parser is not loaded until a `.vue`
file is seen.

When a language you use is not on the table above, the honest state is that the
tool reads _no_ imports in it — and it says so, because a file it cannot analyze
is counted and reported rather than skipped. See
[troubleshooting.md](../usage/troubleshooting.md) § _It reported nothing_.
