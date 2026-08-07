# The analysis contract

What every language analyzer in this directory returns, fixed here so that
analyzers written independently — Go by one hand, TypeScript by another —
produce records a single rule engine can read without knowing which one it is
holding. The JSDoc types in `analyze.mjs` are the machine-readable half of this
document; this file carries the reasoning, and the two are edited together.

An analyzer answers one question: **which import does this file write, where,
and what does it resolve to.** It judges nothing. Whether an import is allowed
is `../rules/`'s question, and an analyzer that starts filtering its own output
has taken a decision away from the layer that owns it.

## The record

One record per import site — per _written import_, not per resolved
dependency. A file importing the same project three times yields three records.

```js
{
  sourceFile,   // workspace-relative path of the importing file
  line, column, // 1-based, for editor diagnostics
  specifier,    // the RAW string as written
  kind,         // "static" | "dynamic" | "type-only" | "re-export"
  spelling: {   // how it is WRITTEN — per language, never derived downstream
    path,        // a filesystem path rather than a package/module/crate name
    relative,    // reaches inside its own project without leaving it
  },
  resolved: {   // null when unresolvable — record it, never guess
    target,      // project name, or null when external
    file,        // workspace-relative resolved file, or null
    external,    // true when it resolves outside every project
    packageName, // npm/crate/module package name when external
  } | null,
}
```

### Why this is a superset of a graph edge, and why that is the point

An Nx dependency is `{ source, target, sourceFile, type }`: which project
depends on which, and one file to blame. That is everything `nx affected`
needs, and it was everything this tool produced while it only fed the graph.

It is not enough to enforce a boundary. Measured on this workspace,
`nx graph --file=` emits **no `sourceFile` and no import specifier** on any edge
at all: every edge in that output carries `source`, `target` and `type`, and no
other key. A count belongs in the run rather than in this sentence — the
denominator moves with every project added, and the fact that survives it is
that the set of keys does not include provenance. Five of the fifteen violation
types `@nx/enforce-module-boundaries` reports are decided on the raw specifier
itself, not on the project pair it resolves to:

- a relative or absolute path that crosses a project boundary — the projects
  are correct, the _spelling_ is the violation;
- an external import matched against `bannedExternalImports` (this workspace
  bans `@tauri-apps/*` out of `layer:view`), which is a glob over the specifier;
- a deep import into a package's nested path, which the package name alone
  cannot distinguish from an import of its entry point;
- a self-import that goes out through the project's own public alias and back
  in, which resolves to the project it started from and so vanishes from an
  edge list;
- a dynamic `import()`, which is the same edge as a static import and a
  different rule.

So the record keeps `specifier` verbatim and adds `line`/`column`. Both are
what an edge threw away, and neither can be recovered from the graph
afterwards. `line`/`column` are 1-based because that is what an editor
diagnostic and a `file:line:col` terminal report want; converting once here
beats every consumer remembering which convention this tool chose.

### How the specifier is spelled is a per-language fact, so the analyzer states it

`specifier` is the raw text; `spelling` is what that text IS in the language it
was written in. Two bits, because the rules ask two independent questions:

|                                   | `path` | `relative` |
| --------------------------------- | :----: | :--------: |
| `./x`, `../x`, `.`, `..` (JS)     |  yes   |    yes     |
| `/x` (JS)                         |  yes   |     no     |
| `crate::x`, `self::x`, `super::x` |   no   |    yes     |
| `rba_desktop_lib::run` from a bin |   no   |    yes     |
| `.mod`, `..pkg.sub` (Python)      |   no   |    yes     |
| `react`, `serde`, `example.com/m` |   no   |     no     |

`path` says the specifier is a **filesystem path**: resolvable by path
arithmetic against the importing file, and naming no package. It decides
whether a specifier may receive a synthesized external node, and which message
an unresolvable one gets. `relative` says the specifier **reaches inside its
own project without going out through the project's public name** — the
counter-evidence `noSelfCircularDependencies` looks for.

**Why the analyzer answers and not the rules.** The rules layer used to derive
both from the text with one predicate — `.`, `..`, `./`, `../` — which is
JavaScript's shape and only JavaScript's. Measured on this workspace, that
reported two violations that were not: `use super::product_name` and a binary
calling its own package's library crate, both ordinary Rust. Python is the same
exposure with the sign reversed on each bit: `..pkg` is relative and read as a
package name, while a bare `.` is not a path and would have been reported as
one. The analyzer already knows the language and has already resolved the
import; the rules layer knows neither, and a language table there would be a
second registry drifting from `LANGUAGE_BY_EXTENSION`. So the record carries the
fact and the rule reads it.

The field is **mandatory**, and `evaluate()` throws on a record that omits it
rather than falling back to the JavaScript shape. A default is how the next
analyzer inherits this bug silently; a throw is how it is told, once, at the
first record it produces.

### Intra-project imports are emitted too

A relative import that stays inside one project produces no graph edge — there
is no second project for the edge to reach. It is still a record.

Two rules need it. `allowCircularSelfDependency` (off in this workspace, see
`module-boundaries.config.mjs`) is decided entirely on imports whose source and
target are the same project: the file reaching its own project through the
public alias instead of a relative path. And a nested-path ban has to see the
in-project import to know a file bypassed its own barrel.

Dropping these at the analyzer would make those rules unimplementable and the
loss would be silent — nothing downstream can tell "no violation" from
"never looked".

### `resolved: null` means unresolvable, and that is a finding

Resolution is best-effort; pretending is not allowed. When an analyzer cannot
say where a specifier points, `resolved` is `null` and the reason lands in
`failures` (below). It never guesses a target from a name that looks similar,
and it never drops the record.

A **dynamic import with a non-literal argument** is the recurring case —
`import(somePath)`, or an `import()` whose argument is a template literal
interpolating a variable. The site is real, the target is not knowable
statically, and the honest answer is one record with `kind: "dynamic"`, the
source text of the argument as `specifier`, and `resolved: null`. Silently
dropping it is how a boundary gets bypassed by a template literal.

`external: true` marks a specifier that resolves outside every project — an npm
package, a crate, a Go module from the proxy, a stdlib module. `target` is then
`null` and `packageName` carries the package's own name, which is what a
`bannedExternalImports` glob is matched against. For a scoped npm package that
is `@scope/name`, not the deep path: `@tauri-apps/api/window` has
`packageName: "@tauri-apps/api"` and keeps the deep path in `specifier`, so a
rule can match either without re-parsing.

### An analyzer never throws on a malformed file

A parse failure is data, not an exception. The analyzer returns what it did
parse and appends a `failure` naming the file and, where it knows one, the
position. One unparseable file must not blank a whole run: a tool that reports
zero violations because it crashed on file three, and a tool that reports zero
violations because there are none, print the same thing.

The rule holds for I/O too — a file that cannot be read is a failure record,
not a throw.

The one thing that _does_ throw is a language whose analyzer is not written
yet. That is not a malformed input, it is a missing implementation, and it
fails loudly rather than reporting an empty result that reads as "clean".

## The envelope

```js
{
  imports,   // ImportSite[] — every import site, in source order
  failures,  // AnalysisFailure[] — what could not be parsed, read, or resolved
}
```

`failures` carries `{ sourceFile, line, column, reason }`; `line`/`column` are
`null` when the failure is about the file as a whole rather than one position.
Both arrays are always present and always arrays — a consumer never has to
check for `undefined` before iterating.

## The dispatcher

`analyzeFile` picks an analyzer by **file extension** and nothing else. It does
not sniff content, and it does not consult the project's language tags: a
`.go` file in a project tagged `type:lib` is Go, and a project's tags describe
its boundary, not its syntax.

**An unknown extension is a no-op, not an error** — it returns the empty
envelope. The dispatcher is pointed at whatever files a project owns, and a
project's tracked files include `README.md`, `project.json`, `.svg`, and a
lockfile. Treating those as errors would make every run red for reasons no
rule cares about, and the pressure to fix it would be an ignore list that
someone has to keep in sync with reality. An extension with no analyzer simply
has no imports this tool can see, which is the truth.

The registry is `LANGUAGE_BY_EXTENSION` in `analyze.mjs`, and it is the one
place an extension is mapped. A language whose analyzer arrives adds itself
there and nowhere else.

## What an analyzer is handed

```js
analyze({ sourceFile, text, workspace }) -> AnalysisResult
```

`text` is passed in already read, so the caller decides the read strategy and
a test can drive an analyzer from an in-memory string — the same injectable
shape the graph resolvers next door already use.

`workspace` is `{ root, projects, filesOf, readFile }`: the absolute workspace
root, every project as `{ name, root }` with a workspace-relative root, the
tracked-file list per project name, and a workspace-relative reader returning
`null` for a missing file. That is a superset of the `(projects, filesOf,
readFile)` triple the graph resolvers take, plus the absolute `root` that
TypeScript's resolver needs.

### Resolution is delegated, never reimplemented

TypeScript resolution is `ts.resolveModuleName` — a public TypeScript API and
already a declared dependency. `./typescript.test.mjs` is where it is held to
the three answers this analyzer needs: a `tsconfig.base.json` path alias
resolves to the file it names, a secondary entry resolves to its own file rather
than to the package's main one, and a real third-party package comes back
flagged `isExternalLibraryImport`. Reimplementing `tsconfig.base.json` path mapping,
`exports` conditions, and extension probing would be a second answer to a
question TypeScript already answers, and the two would disagree exactly where
it matters.

Where a language has no comparable API — Go's import paths, Cargo's path
dependencies, uv's sources — resolution stays static and manifest-driven, for
the reason that governs this whole directory: the graph has to compute on a
machine with none of those toolchains installed. Each analyzer states its own
parse limits in its header, the way `go.mjs` does.
