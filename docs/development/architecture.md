# Architecture

One `check` run, end to end, and why the cuts between layers are where they are.

This page owns the **flow**. What each layer is _allowed to know_ is owned by
[`packages/nx-polyglot-graph/CLAUDE.md`](../../packages/nx-polyglot-graph/CLAUDE.md),
and the record passed between them is frozen in
[`src/analysis/contract.md`](../../packages/nx-polyglot-graph/src/analysis/contract.md).
Those two bind; this page explains how they fit together.

## The two halves

The project closes one gap with two independent mechanisms, and they are wired to
different parts of Nx:

```
                   ┌─ src/graph/     → Nx's createDependencies hook → nx affected
reading a workspace┤
                   └─ src/analysis/  → src/rules/ → src/report/     → the verdict
                          ↑                ↑
                     src/workspace.mjs  src/config.mjs
```

The **edges** half runs inside every `nx` invocation, contributed through the
plugin entry point. The **enforcement** half runs when someone asks — from the
CLI, or from the language server on an edit.

They read different things on purpose. Edges come from manifests, because that is
what a dependency _declaration_ is. Verdicts come from sources, because a
manifest never says a boundary was crossed and `Cargo.toml:1` is not a location
anyone can act on.

## One `check`, in order

`cli.mjs`'s `check()` is the whole pipeline in one function, and it is worth
reading top to bottom — every step is a decision.

### 1. Find the workspace root

`findWorkspaceRoot(cwd)` walks up for an `nx.json`, **from the working directory
and never from this tool's own location**. Installed from a registry, the tool
sits inside `node_modules` while the tree it judges is above it — and under a
pinned harness clone the two are different trees entirely.

### 2. Read the plugin options

`readPluginOptions(root)` reads `nx.json → plugins[].options` for the two
filenames a workspace may have renamed. This happens _before_ the config is
loaded, because it decides _which_ config.

An unknown key throws here, at every one of the three doors that read options —
the Nx hook, the CLI, and the language server. A `tsconfigBase` typed for
`tsConfig` that quietly used the default would be a full green run against a rule
nobody wrote.

### 3. Load the boundary config

`loadBoundaryConfig(root, boundaryConfig)` reads and validates the constraint
table. Validation is shape-only — whether `layer:adapter` may reach
`layer:domain` is the workspace's decision, argued in that file's own comments.

Every problem is accumulated and reported, not just the first, and a malformed
row fails **here** rather than becoming a rule that silently matches nothing. A
constraint matching nothing does not error; it approves.

`--config` overrides the file for one run and **does not move the root**. The
config's location and the tree being judged are separate facts.

### 4. Read the graph, and the file list

Two spawns, and they are the only two things in this pipeline that reach outside
the process:

- **`readGraph(root)`** — `nx graph --file=`. Never a second walk of
  `project.json` files, which would disagree with Nx wherever a plugin
  contributes an edge.
- **`listFiles(root)`** — `git ls-files`. The graph JSON carries no file map, and
  a tree walk would need ignore rules that drift from `.gitignore`.

Both are **injectable parameters**, which is what lets a test drive the real
analysis, the real rules and the real report over a fixture tree — pinning the
exact `file:line:column` a developer would act on — with neither Nx nor git
present.

### 5. Build the workspace view

`createWorkspace({ root, graph, files, tsConfig })` returns the object every
analyzer is handed — `{ root, projects, filesOf, readFile }` — plus `owned`, the
files attributed to a project.

`src/workspace.mjs` is the **only** layer allowed to answer "which files". An
analyzer is handed one file and a rule is handed records, so the question has to
land somewhere, and it lands here with the two spawns that come with it.

Before anything is judged, the graph nodes are annotated with the three facts
`nx graph --file=` cannot carry — `mfeRemote`, `entryPoints` and
`declaredPackages` — read from the same files upstream reads per lint run
(`annotateMFERemotes` and `annotatePackageFacts` in `src/workspace.mjs`, whose
headers own the semantics). The rules fail closed on an absent fact, so
skipping this step would report exemptions upstream grants as violations.

### 6. Select

`selectFiles(owned, paths, { root, cwd })` narrows to the paths named on the
command line, if any. A path outside the tree is a **usage error**, not a silent
empty selection.

This is also where the scoped-run caveat comes from: cycle and lazy-load rules
judge the file graph as a whole, so a scoped run is a fast pre-check and not the
gate.

### 7. Analyze

`analyzeWorkspace(workspace, selected)` dispatches each file through two tables —
extension → language, then language → analyzer.

The dispatch behaviour is deliberate in both directions. An **unrecognised
extension** is a no-op returning the empty envelope; the dispatcher is pointed at
every tracked file and `README.md` is not an error. A language the first table
claims and the second does not **throws**, naming it — that is how the next
language stays loud before its analyzer lands.

Each analyzer returns `{ imports, failures }`. It never judges, and it never
throws on a malformed file — a failure is a record, because an analyzer that
threw would take down the run for the file it could not read, and one that
returned empty would call it clean.

### 8. Judge the workspace's own declarations

Two checks that read no import: when a tracked `go.work` exists at the root,
its `use` list is compared against every project's `go.mod`; and when the
workspace tsconfig declares a `paths` table, each alias is judged for life.
`src/go-work.mjs` and `src/tsconfig-paths.mjs` own the rules and their limits;
[languages.md](../usage/languages.md) is the reader's view. Both ignore any
paths named on the command line — a workspace fact is judged, not files
analyzed — and both run on the CLI only, because their findings describe the
workspace rather than any open file. A `go.work` or tsconfig the tool cannot
read becomes a whole-file failure, exit 3, never an empty list.

### 9. Evaluate

`evaluate(importSites, graph, config)` is the entire rules layer, and it is
**pure**: records and config in, violations out. No filesystem, no git, no Nx.

That purity is not tidiness — it is what lets the CLI and the language server
share one verdict, and what lets all fifteen rules be driven from fixtures with
no workspace at all. A rule that reached for a file would become a second, weaker
analyzer.

Read [`src/rules/README.md`](../../packages/nx-polyglot-graph/src/rules/README.md)
before touching anything in here. It carries the five upstream semantics a
reimplementation gets backwards — starting with _no matching constraint is an
error, not a pass_ — and every place this engine is deliberately stricter than
ESLint.

### 10. Suppress

Suppressions are applied **after** every import has been judged. A suppression
removes a _verdict_ and never a _failure_, so a file listed in
`boundarySuppressions` is still fully analyzed and anything it could not resolve
is still reported. You cannot use a suppression to silence a blind spot.

### 11. Report

`src/report/` renders and decides nothing. A formatter that filtered would be a
rule wearing a formatter's name, and it would disagree with the engine the first
time either changed.

Two formats, two audiences: `text.mjs` produces the `file:line:column` a terminal
turns into a link, and `sarif.mjs` produces what GitHub code scanning accepts.

### 12. Exit

```js
if (result.violations > 0 || result.goWorkDrift > 0 || result.tsconfigPathsDead > 0) {
  return EXIT.violations; // 1
}
return result.unchecked > 0 ? EXIT.error : EXIT.ok; // 3 or 0
```

`unchecked` is counted inside `check()` rather than recomputed by the caller,
deliberately: the exit code and the report must agree about which failures mean
"not covered", and one predicate is how they do.

**This is the line the whole design turns on.** Exit 0 was the bug — a checker
that could not look must never be mistaken for one that looked and found nothing.

## The other two entry points

### The Nx hook

`index.mjs` re-exports `createDependencies` and holds **no logic at all**. Nx
loads it on every graph computation, so what it imports is what every `nx`
invocation pays for.

`src/graph/` reduces analysis to Nx's edge shape —
`{ source, target, sourceFile, type }` — and Nx drops everything else. That is
why the two layers stay separate rather than one growing fields the other
discards.

The hook validates its options and then uses nothing from them, and both halves
are deliberate: edge resolution reads manifests, which are not options, but
validating anyway makes a typo'd key fail at the _first_ graph computation rather
than on whichever later CLI run happens to notice.

### The language server

`lsp.mjs` holds only stdio wiring; everything with a decision in it lives under
`src/lsp/`, where coverage can see it.

The one structural difference from the CLI: **`src/lsp/` is the only layer
allowed to build a graph.** `evaluate` is pure and takes a graph it does not
build; under Nx that graph comes from Nx, and a language server has no Nx. So
`src/lsp/workspace-index.mjs` builds the same shape from the tracked
`project.json` files, reproducing Nx's own `getProjectType` — including the
`-e2e` suffix rule — rather than inventing a second answer.

The server's invariant is the CLI's, sharpened: **an empty diagnostic list must
mean "no violation", and nothing else.** Two guards enforce it —
`src/lsp/diagnose.mjs` returns `analyzed: false` with at least one diagnostic on
every path that did not reach a verdict, and `src/lsp/server.mjs` re-checks that
before the bytes leave the process. An empty list is published from exactly two
named places. Anything that adds a third is the defect this design is built
around.

### The editor client

`packages/lattice-vscode` is a client of that server, and the only part of this
project outside the engine package. It contains no analysis: it finds the Nx
workspace root, finds
the server the workspace installed, starts it over stdio, and shows whether it is
running.

Two seams there are worth knowing because both mirror cuts made above.
`extension.mjs` holds VS Code wiring only, so every decision — which root, which
server, what to say when there is none — is a pure function under `src/` that a
test drives without an editor, exactly as `lsp.mjs` relates to `src/lsp/`. And
the server is resolved from the workspace rather than bundled, which is the
invariant applied to versions: a marketplace-pinned analyzer could disagree with
the workspace's own about the same import, and both would report confidently.

The client's own version of "an empty result is a claim" is a language status
item. A terminal has an exit code for _could not look_; an editor has nowhere to
print one, so a window where the server never started is pixel-identical to a
clean one unless something says otherwise.

## Why the cuts are where they are

Four seams, each justified by a specific failure it prevents.

**Analysis never judges.** An analyzer that filtered its own output would have
taken a decision away from the layer that owns it — and a rule change would then
need an analyzer change in every language.

**Rules never read files.** Purity is what makes one verdict serve three
surfaces. It is also what makes the differential against ESLint possible: both
engines can be handed the same records and the same options.

**The report decides nothing.** Two renderers of one verdict cannot disagree
about what is a violation.

**Options are the only layer that knows what a workspace named its files.**
Everything downstream takes a resolved name as an argument. A tool that hardcoded
either convention would answer confidently about a workspace it had misread.

## What must never land

- **A second copy of the constraint table.** It has one home: the file at the
  consumer's workspace root.
- **A second resolver.** TypeScript resolution is `ts.resolveModuleName`, a
  public API. Path mapping and extension probing have too many correct-looking
  approximations.
- **A dependency on any sibling package**, or a third-party package outside the
  short allow-list that
  [`src/conformance/boundary.test.mjs`](../../packages/nx-polyglot-graph/src/conformance/)
  holds. A consumer installs one package and gets a working tool.
- **Any workspace's project names, areas or tag values** — this repository's
  included. Fixtures too.
- **A shell-out to a language toolchain.** The moment a resolver needs the real
  toolchain, graph computation starts failing on machines that never touch that
  language.

## Next

- Adding a language → [adding-a-language.md](adding-a-language.md)
- Which suite proves what → [testing.md](testing.md)
- The direction all of this serves → [../north-star.md](../north-star.md)
