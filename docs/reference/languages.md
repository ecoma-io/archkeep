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

| extension                                             | language                  | edges from                                                    | analysis |
| ----------------------------------------------------- | ------------------------- | ------------------------------------------------------------- | -------- |
| `.go`                                                 | Go                        | `go.mod`                                                      | ✅       |
| `.rs`                                                 | Rust                      | `Cargo.toml`                                                  | ✅       |
| `.py`                                                 | Python                    | `pyproject.toml` (uv, Poetry, PDM)                            | ✅       |
| `.ts` `.tsx` `.mts` `.cts` `.js` `.jsx` `.mjs` `.cjs` | TypeScript and JavaScript | Nx's own inference                                            | ✅       |
| `.vue`                                                | Vue                       | Nx's own inference                                            | ✅       |
| `.java`                                               | Java                      | root `pom.xml` or Gradle `settings.gradle`, plus import sites | ✅       |
| `.kt` `.kts`                                          | Kotlin                    | shared with Java                                              | ✅       |
| `.cs`                                                 | C# / .NET                 | `*.csproj` (`ProjectReference`)                 | ✅       |

Anything else is a no-op: the dispatcher is pointed at every tracked file, and
`README.md` is not an error. A file whose extension _is_ on this list but whose
analyzer is missing **throws**, naming the language — that is how the next
language stays loud before its analyzer lands.

## Everything here is read statically

No `go`, no `cargo`, no `uv`, no `python`, no `tsc`, no `mvn`, no `gradle`, no
JDK process, no `dotnet` CLI. Manifests are parsed as data, sources are read as
text.

That is not minimalism. Nx computes the project graph on _every_ `nx`
invocation, so a graph that needs every toolchain installed is a graph that fails
on the machine that does not have them — a lint-only CI job, or a contributor who
touches none of them. The cost of that choice is a set of parse
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

**`import` opens its line, after indentation only, or follows a `;` on the same
line** — the same statement separator `gofmt` inserts automatically at a
newline, so `import "a"; import "b"` reads both, the same as one per line, and
so do `import ("a"; "b")` inside a block and a block whose opener itself
follows one, `package main; import ("a")`. The path itself may be quoted or,
since Go treats a raw string as an equally legal string literal, backtick-
delimited; both spellings are read the same way, though only the quoted form
is what `gofmt` ever writes.

### Limits

- A **raw string literal** containing what looks like an import declaration at
  the start of one of its lines is read as one. This is the only limit a
  `gofmt`-clean tree still meets — the mask keeps raw strings intact deliberately,
  because an import path _is_ a string literal.

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

**A renamed dependency IS followed, scoped to the project that renamed it.**
`dep = { package = "real", path = "../real" }` in a project's own manifest
makes `use dep::…` — and a bare `dep::item` path with no `use` at all —
resolve to `real`'s project from THAT project's sources. Rust builds a
crate's `extern` prelude from its own `Cargo.toml` alone, so a sibling project
renaming some other dependency to `dep` too has no bearing on what this one's
sources mean by it; the manifest entry is read the same `path`/
`workspace = true` way the edge resolver already reads it, so a `use` naming
the rename lands on the same project the graph edge already points at.

### Limits

- **`use` is matched at the start of a line**, after optional indentation and an
  optional `pub`/`pub(crate)`, read to the first `;`. A `use` inside a raw string
  that starts its own line would be read; a `use` preceded on the same line by an
  attribute or another statement would not. `rustfmt` produces neither.
- **A `use` opening with a brace group** — `use {a::b, c::d};` — is a LIST of
  paths and is read as one: each arm names its own crate at its head, so the
  statement means exactly `use a::b; use c::d;` and produces one record per arm,
  at the arm's own line and column. Nothing is guessed, because nothing is
  ambiguous. Only text that is not a well-formed group — braces that do not
  balance, or anything written after the group's close — keeps the older answer:
  one record with `resolved: null` _and a failure_ beside it. The record is
  never dropped either way.
- **Uniform paths are resolved toward the crate.** Since Rust 2018 `use foo::Bar`
  can name an extern crate or a local `mod foo`. A first segment matching another
  project's crate name is read as that crate, so a local module deliberately
  named after a sibling crate produces a spurious record.
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
  both of which cross a boundary. Python's own statement separators are
  followed rather than dropped at: a `;` opens a fresh statement to check on
  the same line, and a line ending in a bare `\` is joined with the next one
  first, the same explicit line-joining Python itself does — starting only
  from a line that already opens with `from`/`import`, so an unrelated line
  elsewhere that happens to end in `\` (a comment noting a Windows path, say)
  is never pulled into a statement it has nothing to do with.
- **A continuation that still does not parse once joined is a failure, not a
  dropped record.** A backslash landing inside the dotted module name itself —
  between two of its segments, rather than after the whole name or inside the
  name list — is not reassembled into one contiguous name, so this reader
  says it cannot follow the statement instead of silently reading nothing.
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

Three things that resolver structurally cannot answer, and what happens instead:

- **A Node built-in** (`node:fs`, `fs`) has no package to find, so it is
  classified by `node:module`'s own `isBuiltin` — checked _after_ TypeScript,
  never against a hand-kept list.
- **A relative specifier TypeScript declines** because the extension is not one
  it compiles (`.vue`, `.css`, `.svg`) is already a path: it is normalised and
  tested for existence, with no extension probing, no `index` lookup and no
  `paths` mapping.
- **A specifier of any other spelling landing on the same kind of file** — a
  `paths` alias or a `baseUrl` mapping reaching
  `packages/blocks/page-header/src/PageHeader.vue` — resolves to the project
  that owns that file. `.json` reaches this branch too wherever the workspace's
  own compiler options leave TypeScript declining the target: measured, with
  `resolveJsonModule` off it declines in every `moduleResolution` mode, and with
  the option merely absent it declines in all but `bundler` and `nodenext`.

**What that decides is a boundary verdict, not a cosmetic detail.** In a
component library the target of a boundary crossing IS a `.vue` file, and such a
specifier used to resolve to nothing at all — a site with no target, which is
[violations.md](violations.md#the-order-matters) step 4. No `depConstraints` row
is read for one, and at `banTransitiveDependencies`'s own default nothing is
reported for it either, so a real crossing scored a clean run. The site now
names the project it reaches and is judged against the constraint table like any
other edge.

Two things it will not do, both refusals rather than gaps. The target must name
its own extension, so nothing here probes extensions or looks for an `index` —
`./widgets` does not reach `./widgets/index.vue`, and `@scope/ui/Button` does
not reach `Button.vue`. And a specifier whose target is not there is still
unresolved, and reported at the import site that used it; nothing is invented
for a dead alias.

How that answer stays `ts.resolveModuleName`'s own — the guards that keep it to
one question, and why it is not a second resolver — is argued beside the code it
constrains, at `declinedExtensionHostFor` in
`packages/archkeep/src/analysis/typescript.mjs`. It is not restated here.

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

The check judges the alias table itself and never resolves a specifier. That is
not the refusal the resolution section above describes, and the two must not be
read as one: resolution there is `ts.resolveModuleName`'s, `paths` substitution
and all, while a check that resolved a specifier would have to apply `paths`
**here**, in this package — the second resolver it must not grow. What it may
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

## Java

**Identity is the root `pom.xml`'s `(groupId, artifactId)`, on an
`archkeep.json` workspace.** Every tracked root pom anchors a project, named by
the same precedence as every other inferred manifest (declared row first,
directory basename otherwise). groupId inherits along a parent chain found
inside the tracked tree; a parent that is not a tracked pom leaves the child's
coordinates unresolved, which draws its outbound edges but records the pom as a
failure — nobody can name an edge TO it while its coordinates are unknown. On
an Nx tree, nodes come from whatever inference plugins the workspace registers;
this plugin adds import-derived and pom-coordinate edges beside them.

**Versions are read for nothing.** Boundary edges need coordinate matching only,
so `<dependencyManagement>`, BOM imports, version ranges, mediation and profile
activation are out of scope by construction: no code reads a `<version>`
element. `<profiles>` are not read either — reading them would fabricate edges
from configurations that never activate.

**Packages resolve through a content-derived index, because Java does not
require directory = package.** The index reads every tracked `.java` file's
`package` line (masked first, so commented-out declarations cannot claim
ownership) and maps longest declared prefix to project. A `.kt` file's packages
are in the SAME index — a mixed module compiles into one namespace, and both
languages share the same JVM package index.

**Extraction covers the four JLS §7.5 import forms** — single type, on-demand
(`a.b.*`), static single member, static on-demand — over comment-and-literal-
masked text. Comments are blanked, and so are string literals and text blocks:
unlike Go, where the import path IS a string literal, nothing inside a JVM
literal can contribute an import. Java block comments do not nest, and the mask
scans them that way on purpose — treating one as nesting would swallow real
imports below javadoc that quotes a code snippet.

### Limits

- **A multi-line import statement is not read.** The name must sit on the
  declaration's own line. Every formatter formats imports onto one line, so a
  formatted tree never meets this limit; the miss is silent for that import.
- **Fully-qualified names used without an import are invisible.** Same-package
  references and inline FQNs need no import statement, so import-only
  extraction cannot see them. Source-level findings compensate only for what
  manifests miss, not for this.
- **Same-package cross-project references need no import** — the split-package
  shape. Where two tracked projects declare the same deepest package prefix,
  resolution refuses instead of picking: the site reports `resolved: null` with
  a positioned failure naming every claimant, and no edge is drawn against a
  guess.
- **Kotlin backtick-quoted package segments do not resolve** — they match no
  index entry, so imports of such a package classify as external.
- **`.mvn/maven.config` is read at two locations only** — beside the workspace
  root and beside the declaring pom. A deeper `.mvn` directory's properties
  fail loudly wherever a placeholder needed them.
- **A reactor drift is loud**: a `<module>` whose pom.xml is not a tracked file
  fails discovery naming the aggregator — exit 3, never clean-over-a-hole.

**What the record leaves null:** `resolved.file` is always null — an import
names a package, not a file, and which source file supplies a type is a
compiler question this static reader does not answer. `kind` is always
`"static"`; there is no dynamic or type-only import form. `spelling.path` is
always false; `spelling.relative` is true exactly when the import resolved into
its own project — Java has no relative import form, so the bit reads what an
import reached rather than how it was written.

---

## Kotlin

**Identity and edges are the JVM core's, shared with Java.** A mixed module
compiles `.kt` and `.java` sources into one package namespace on one classpath,
so there is ONE package index over BOTH extensions: a Kotlin import resolves
into a package only a Java source declares, and the reverse. Maven coordinates
anchor edges the same way — nothing about the manifest reader knows which
language wrote the sources.

**Extraction covers Kotlin's three import forms** — single, on-demand
(`a.b.*`), aliased (`import a.b.C as D`; the alias is local syntax and changes
no resolution) — with backtick-quoted segments read as identifiers. The match
is newline-terminated because Kotlin omits the semicolon; the imported name must
still start on the import's own line.

**Kotlin block comments NEST**, and the mask scans them by depth — the exact
opposite of Java's rule, which is why one scanner is parameterized per dialect
rather than averaged into a wrong-everywhere middle. Raw strings (`"""…"""`)
take no escapes, so their terminator search is pure; ordinary strings escape as
Java's do.

### Limits

- **A multi-line import statement is not read** — the same pinned limit Java
  states, for the same formatter reason.
- **Fully-qualified names without an import are invisible** — identical gap to
  Java's.
- **Backtick-quoted PACKAGE segments are not indexed** — ``package `odd`.x``
  contributes no index entry, so imports through such a prefix classify as
  external rather than to their project. Backticks in an import's TAIL still
  parse (they resolve by plain prefix or classify external).
- **Directory = package is convention, not law** — which is why the index is
  content-derived in the first place; a file whose `package` line contradicts
  its path is attributed by the line.
- **Default imports are classified by table**: nine stdlib roots plus
  `kotlin.jvm`/`kotlin.js`, cited in `src/analysis/jvm/resolve.mjs`; they change
  only across Kotlin releases.
- **`.kts` build scripts are analyzed as sources**: their imports are real
  dependencies (buildSrc, plugins), and text that only looks like an import
  inside a script string is masked like any literal.

**What the record leaves null:** exactly what Java's record leaves null —
`file` always null, `kind` always `"static"`, `spelling.path` always false,
`spelling.relative` true when the import resolved into its own project.

---

## Gradle

**Identity and reactor structure come from the settings file.** A Gradle
workspace is anchored by `settings.gradle` or `settings.gradle.kts`: the
`rootProject.name` and `include(...)` declarations define which directory
corresponds to which project (ADR 0005 Decision 2). The settings file is
looked for at the workspace root and at each declared project's root — the
two locations a reactor root takes — so a settings file sitting at a root no
declared project owns still anchors the whole reactor; a settings file
anywhere else is unread. Every declared project whose directory a settings
file covers gets its own build file read; a nested second build file inside
one project directory draws no graph edge.

**Edges come from build file dependency declarations.** `build.gradle` /
`build.gradle.kts` `project(":x")` references in ANY configuration draw
edges — `implementation`, `api`, `testImplementation`, `compileOnly`,
`runtimeOnly`, `annotationProcessor`, and custom configurations are all read.
Both Groovy DSL (quotes optional, parentheses optional) and Kotlin DSL (strings
required) are supported. Every scope, including test, draws the same edge — the
same project-granularity rule Maven's reader follows.

**Version catalogs are not read in v1.** `libs.catalog.reference` forms are not
resolved; a catalog entry that cannot be resolved to a workspace project stays
silent (it may be an external Maven coordinate, a version reference, or a bundle).
External `implementation "group:artifact:version"` dependencies are also not read
— they resolve to artifacts from repositories, not to workspace projects, and
belong to the external node synthesis layer when a rule needs a name.

### Limits

- **A multi-line include statement must have its arguments quoted.** The
  settings-file reader handles multi-line `include("a", "b")` but not every
  Groovy DSL variant — the v1 parser expects quoted strings in include calls.
- **`includeBuild` is discovery-only in v1.** Composite builds are detected
  but edges from included builds are not modeled — the reactor reads the
  directory mapping, but project dependencies across composite boundaries draw
  no edge.
- **Block comments in settings files must be well-formed.** The reader strips
  `/* ... */` comments before processing; a malformed block comment that
  doesn't close is treated as malformed input.
- **Version catalog references are not resolved.** `libs.bundles.testing` or
  `libs.versions.lib` are not read in v1 — a catalog entry that cannot be
  resolved to a workspace project stays silent.
- **External dependency coordinates are not read.** `implementation
"group:artifact:version"` forms are not modeled — they belong to the external
  node synthesis layer when a rule needs a name.
- **The root project's own build file needs a declared root.** When the
  workspace root is no declared project, a root `build.gradle` is unread —
  its `project(":x")` references claim nothing. Declare the root as a project
  if its dependencies must be judged.
- **Malformed reactors are loud, not empty.** An `include` onto an untracked
  directory, a `project(":x")` no settings file defines, a reference whose
  directory no declared project owns, a settings-less build file that declares
  project references, and two settings files claiming the same directory all
  fail the whole run (exit 3) naming the file — the go.work precedent. A
  broken reactor read as "no dependencies" would mean "no drift" exactly
  where the tree is most broken.

A Gradle manifest edge is a graph fact, not an import record: it carries
`source`, `target`, `sourceFile` (the declaring build file) and
`type: "static"` — no positions, because a `project(":x")` line is a
declaration, not a use site the report points a reader at.

## C# / .NET

**Identity is the `.csproj` manifest.** The manifest is parsed as XML
(`fast-xml-parser`), and a `<ProjectReference Include="…">` path — written
relative to the declaring `.csproj`'s directory, Windows separators
normalized — is resolved to the project owning the exact `.csproj` the path
lands on. A reference that lands on no tracked project, one with no readable
`Include` attribute, and one whose `Include` holds an MSBuild placeholder
(`$(…)`/`%(…)`) surface as whole-file failures through
`dotnetManifestFailures` and refuse the verdict (exit 3) — the same posture
Maven's reader holds for unresolvable placeholder coordinates, because a
dangling declared reference read as "no edge" erases a dependency silently.
References are collected at any depth under `<Project>` — including
`<Choose>`/`<When>` — and conditions are taken loudly: a conditionally
present reference draws its possibly-spurious edge, the self-correcting
direction. `<Using Include="…">` items ride the reader and draw the edge
their `using` spelling would; when a ProjectReference and a Using name the
same target from one csproj, the declared reference is the one edge kept.

**Analysis is `using` directive extraction from `.cs` files.** The analyzer
reads five forms — `using Namespace;`, `using static ClassName;`,
`using Alias = FullyQualified;`, `global using …;`, and `extern alias X;` —
each with or without the `global::` qualifier on its subject. `using`
_statements_ (inside methods, constructors, or `using` blocks) are
deliberately ignored — they are scoped to a block and never cross a project
boundary — and a directive may sit wherever a fresh declaration may,
including the same line as a brace: `namespace N { using A.B; }` is read.

**The specifier is the subject of `imp===packageName`,** not the full body
text. A dotted `using` like `using Shop.Domain;` produces a site whose
`specifier` is `Shop.Domain`, with the offset pointing at the first
character of the name — the same shape `findBoundaryViolations` decides
against. An alias (`using Alias = Foo.Bar;`) classifies by its right-hand
side, the `global::` qualifier is stripped with the alias's own name, and an
`extern alias X;` site carries `X` alone — every form word stays out of the
specifier so a constraint table matching on `Shop.*` never sees `MyAlias`,
`global::` or `extern alias`.

**Namespace resolution follows longest-prefix walk.** The analyzer builds an
index of all declared `namespace` directives across tracked `.cs` files and
matches an incoming `using` by its longest matching prefix. A namespace owned
by exactly one project resolves to it; one claimed by more than one project
(possibly because C# allows a namespace to span assemblies) is reported as an
ambiguity. A namespace with no declared owner classifies as external — the
same posture as a Go or Rust import hitting no project.

**A UTF-8 BOM is matched, not stripped.** Visual Studio and several .NET
tools prepend `\uFEFF` to `.cs` files; the directive regexes and the
namespace declaration both tolerate the byte the way the JVM package
declaration does, so a first-line directive behind one is read and every
reported offset stays an offset into the bytes on disk.

### Limits

- **A multi-line `using` is not read.** The directive must sit on one line.
  Every formatter formats imports onto one line, so a formatted tree never meets
  this limit; the miss is compensated by the manifest track's independent
  ProjectReference edges.
- **`using` _statements_ (block-scoped) are invisible.** They appear inside
  methods, constructors, and `using` blocks; they are scoped to their block
  and never cross a project boundary, so missing them has no false-negative
  consequence.
- **Fully-qualified names used without a `using` are invisible.** Same as
  Java and Kotlin: an inline FQN needs no directive, so import-only
  extraction cannot see it. Attribute references and reflection are the same
  class of limit.
- **Verbatim identifiers** (`@class`) inside a directive are not read.
- **`<Using Remove>` and `.props` imports are outside static scope** — the
  csproj's own text is everything the reader sees, so a `<Using>` item an
  imported `Directory.Build.props` adds draws no edge.
- **Manifest failures surface as exit 3** through `dotnetManifestFailures`,
  the same posture as a malformed `go.work` or a broken tsconfig: XML that
  does not parse, a missing `Include`, a placeholder path, a reference to no
  tracked project, and an ambiguous `<Using>` namespace all refuse the
  verdict rather than reading as "no dependencies".

**What the record leaves null:** `file` is always null — a `using` names a
namespace, not a file, and which source file supplies a type is a compiler
question this static reader does not answer. `kind` is always `"static"`; C#
has no dynamic or type-only import form. `spelling.path` is always false;
`spelling.relative` is true exactly when the directive resolved into its own
project.
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
