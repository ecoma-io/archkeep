# Languages

Two questions per language, and they have different answers:

- **Edges** — what makes the project graph mark a project affected. Read from
  manifests.
- **Analysis** — what makes a boundary violation reportable at a
  `file:line:column`. Read from sources.

They are kept separate on purpose. A manifest says a dependency _may_ be used; it
never says a boundary _was crossed_. The two disagreeing is itself information:
a declared-but-unused dependency and an undeclared-but-imported one are both
findings.

| extension                                             | language                | edges from                         | analysis |
| ----------------------------------------------------- | ----------------------- | ---------------------------------- | -------- |
| `.go`                                                 | Go                      | `go.mod`                           | ✅       |
| `.rs`                                                 | Rust                    | `Cargo.toml`                       | ✅       |
| `.py`                                                 | Python                  | `pyproject.toml` (uv, Poetry, PDM) | ✅       |
| `.ts` `.tsx` `.mts` `.cts` `.js` `.jsx` `.mjs` `.cjs` | TypeScript / JavaScript | provider's own inference           | ✅       |
| `.vue`                                                | Vue                     | provider's own inference           | ✅       |

Anything else is a no-op: the dispatcher is pointed at every tracked file, and
`README.md` is not an error. A file whose extension _is_ on this list but whose
analyzer is missing **throws**, naming the language — that is how the next
language stays loud before its analyzer lands.

## Everything here is read statically

No `go`, no `cargo`, no `uv`, no `python`, no `tsc` process. Manifests are
parsed as data, sources are read as text.

That is not minimalism. The engine computes the project graph on every
invocation, so a graph that needs four toolchains installed is a graph that fails
on the machine that does not have them — a lint-only CI job, or a contributor
who touches none of the four languages. The cost of that choice is a set of
parse limits, and every one of them is listed below.

**Every limit errs the same way.** The worst case of each is a _spurious record
naming text the file really contains_ — never a missed import. A false alarm
gets argued about and fixed; a missed import is byte-for-byte identical to a
clean file. The limits are pinned by tests, so a fix that changes one has to
change the test that documents it.

---

## Go

**Identity:** one Go module per project, at `<projectRoot>/go.mod`. The module
path is the project's identity, and an import of another project's module path
(exact, or `<modulePath>/...`) is an edge.

**Comments are blanked before anything is matched.** This matters more than it
sounds: a `)` written inside a comment — including the note a blank import
conventionally carries, `_ "github.com/lib/pq" // register the driver (postgres)`
— would close an `import (…)` block early and make every import below it vanish.

### Limits

- A **raw string literal** containing what looks like an import declaration at
  the start of one of its lines is read as one.
- `import` must open its line, after indentation only. `import "a"; import "b"`
  yields the first alone, and inside a block each import needs its own line.
- An import path spelled as a raw string rather than a quoted one is not read.

### What the record deliberately leaves null

- **`file` is always null.** A Go import names a _package directory_, not a file.
- **`packageName` for an external import is the whole import path.** Where a
  module path ends and a package path begins is not statically knowable.
- **`kind` is always `static`.** Go has no dynamic import, no type-only import
  and no re-export form.

### go.work is checked against the graph

A `go.work` at the workspace root decides, through its `use` directives, which
modules a developer's `go build` loads — while the graph covers every project
carrying `go.mod`. Drift between them is byte-for-byte invisible, so when a
tracked `go.work` exists, `check` compares the lists. Four findings cover both
directions: `goWorkMissingUse`, `goWorkStaleUse`, `goWorkUnmodeledUse`,
`goWorkOutsideUse`. A `go.work` the parser cannot read fails the run with exit 3
rather than being read as an empty `use` list. A workspace with no `go.work`
pays nothing; there is no switch.

---

## Rust

**Identity:** one crate per project, at `<projectRoot>/Cargo.toml`. Edges come
from `{ path = "…" }` dependencies and from `{ workspace = true }` entries
resolved through the nearest ancestor manifest carrying `[workspace]`.

**Two spellings are reconciled:** Cargo replaces `-` with `_` for the identifier,
and a `[lib] name` overrides the package name outright. `[lib] name` wins when
present.

### Limits

- **`use` is matched at the start of a line**, after optional indentation and an
  optional `pub`/`pub(crate)`, read to the first `;`.
- **A `use` opening with a brace group** names no crate before the group. It is
  recorded with `resolved: null` _and a failure_.
- **Uniform paths are resolved toward the crate.** A first segment matching
  another project's crate name is read as that crate.
- **A renamed dependency is not followed at source level.** The manifest resolver
  still draws the edge, so the dependency is never lost — only its source-level
  location is.
- **`mod` is not an import.** It names a file inside the same crate and crosses
  no boundary.

---

## Python

**Identity:** one package per project, at `<projectRoot>/pyproject.toml`, named
by `[project].name`. An edge exists only where the manifest **explicitly wires a
dependency to a workspace path** — each tool's documented semantics, not string
matching. A name that merely coincides with a sibling package draws no edge.

Three tools are read:

- **uv** — a dependency string creates an edge only when `[tool.uv.sources]`
  routes that name to the workspace.
- **Poetry** — `name = { path = "…" }` in the relevant dependencies sections.
- **PDM** — a requirement string in the two root-anchored local forms its docs
  write.

**Where a declared path lands decides what happens, and one landing is loud.**
Another project's root is an edge. The declaring project itself is no edge. A
path that climbs out of the workspace is no edge, as a verdict. But a path that
lands **anywhere else in the tree** — no project's root, or a file inside
another project — **fails graph computation with an error** naming the manifest
and the entry.

**The manifest and the source disagree here more than anywhere else.** A `.py`
file writing `import other_project.thing` with no manifest declaration imports
perfectly at runtime while the manifest says nothing at all. Source-level
analysis is what catches it.

**Build-backend layout declarations are read.** Four table shapes are supported —
setuptools, hatch, poetry — for whichever backend is declared.

**PEP 420 namespace packages** are handled by indexing every importable dotted
path and matching the longest prefix. When the longest matching prefix is
genuinely owned by more than one project, that is reported as an ambiguity.

### Limits

- **Imports are matched per line**, at any indentation. A line continued with `\`
  is not followed.
- **A triple-quoted string containing a line that looks like an import** is read
  as one.
- **`if TYPE_CHECKING:` imports stay `kind: "static"`.** They are erased at
  runtime, so `type-only` is tempting — but a TYPE_CHECKING guard is a runtime
  conditional, not a declaration that the dependency is absent.
- **`packageName` for an external import is the top-level import name**, not the
  PyPI distribution name.

---

## TypeScript and JavaScript

**Edges come from the project-model provider** — not re-inferred. Resolution is
`ts.resolveModuleName`, the compiler's public API, driven by the workspace's
tsConfig. A Node built-in is classified by `node:module`'s own `isBuiltin`. A
relative specifier the compiler declines (wrong extension) is normalised and
tested for existence.

**The paths table is checked for dead aliases.** A `paths` alias whose every
target has rotted away resolves no import: the build breaks on it, or TypeScript
falls back to `node_modules` and an installed package of the same name answers
instead. When the workspace tsconfig declares a `paths` table, `check` judges
each alias for life and a dead one fails the run with exit 1.

---

## Vue

**Edges come from the project-model provider.** Analysis uses the official SFC
parser to find `<script>` blocks, and hands each one to the TypeScript analyzer.

**Positions are mapped by blanking, not by arithmetic.** Each block is analyzed
in a copy of the whole file with every character outside that block replaced by a
space and newlines kept. A diagnostic naming the wrong line is worse than no
diagnostic, so there is no arithmetic left to get wrong.

**The parser is loaded lazily**, on first use. A missing parser becomes a
failure record naming what is absent.

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

---

- Each violation the analysis can report → [../reference/violations.md](../reference/violations.md)
- The full per-language edge resolution → [../integrations/nx.md](../integrations/nx.md)
- How to add a language → [../development/adding-a-language.md](../development/adding-a-language.md)
