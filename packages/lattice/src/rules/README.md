# `src/rules/` — the boundary rules

`@nx/enforce-module-boundaries` reproduced over analysis records instead of an
ESLint AST, so the same **15 violation types** under the same **8 options**
reach `.go`, `.rs` and `.py` — the languages ESLint cannot read, where a
`layer:`/`scope:`/`license:` tag has no mechanism behind it today. Measured, not
assumed: asked to lint a `.go` file, ESLint answers "File ignored because no
matching configuration was supplied."

**Vue is not on that list, and this file said it was.** `eslint.config.mjs`
supplies `vue-eslint-parser`, the boundary rule block there carries no `files`
filter, and both engines report the same `messageId` and message on the same
`.vue` violation — differing only in column, which is the difference they have
on every `.ts` file too. Two independent runs measured it, and
`banned-external-import-in-a-vue-single-file-component` pins it
(`../conformance/README.md`). Vue was never a blind spot.

Five of those types are decided on the raw import specifier rather than on the
project pair,
which is why the analysis record carries the specifier and its position and why
an Nx graph edge alone cannot serve them (`../analysis/contract.md`, "superset
of a graph edge"). It also carries how the specifier is SPELLED, because that
question has a different answer per language and this layer never learns which
language it is holding.

One entry point:

```js
evaluate(importSites, graph, config) -> Violation[]
```

Pure: analysis records and the loaded config, nothing else — no filesystem, no
git, no Nx. A rule never reads a file, never resolves a specifier, and never
decides which files to visit; a rule that reaches for those turns into a second,
weaker analyzer. That purity is what lets the CLI and the language server share
one verdict, and what lets all fifteen rules be driven from fixtures with no
workspace at all.

| module             | what it owns                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `index.mjs`        | the pipeline, in upstream's order; `allow`; the `Violation` record                                                      |
| `tags.mjs`         | only / not / empty-only, and which constraints a source is held to                                                      |
| `topology.mjs`     | circular, self-circular, apps, e2e, buildable, lazy, transitive                                                         |
| `specifiers.mjs`   | relative-across, relative-externals, banned and nested-banned externals                                                 |
| `messages.mjs`     | the fifteen message templates, copied verbatim from upstream                                                            |
| `match.mjs`        | Nx's three pattern dialects (none of them minimatch), plus the brace-expansion cap in front of `path.posix.matchesGlob` |
| `reachability.mjs` | who reaches whom: the cycle check and the transitive tag check share it                                                 |

## Read these before changing anything here

Each is the opposite of the implementation a reader would write from the message
text alone, and each is marked at its call site.

1. **No matching constraint is an ERROR.** `findConstraintsFor` returning
   nothing means the source project's tags match no row, and upstream reports
   `projectWithoutTagsCannotHaveDependencies`. "No rule said no, so it's fine"
   inverts it, and every mis-tagged project escapes silently.
2. **Several matching constraints are AND.** The result is an array and the loop
   over it is a conjunction. A project on four tag axes is held to all four rows.
3. **`allow` matches the RAW SPECIFIER with Nx's own matcher**, whose fallback
   branch is an unanchored `new RegExp(entry)`. Not the file path, not
   minimatch. A glob library silently changes which escape hatches still work.
4. **The order is the semantics.** Upstream is a chain of `report(); return;`,
   so most sites yield at most one violation and which one depends on the order.
   Two places break that: the npm branch (transitive and banned are both
   reported) and the nested-banned check (one report per offending package).
5. **`bannedExternalImports` is checked in two unrelated places** — directly,
   for an npm target, before any tag rule runs; and nested, only under
   `checkNestedExternalImports`. An npm target returns before the tag block, so
   no external import can ever produce a no-constraint violation.

## Where this engine is deliberately stricter than ESLint

The dangerous failure is a false NEGATIVE — reporting clean while a violation
exists. That is worse than today, where ESLint is right about JS/TS and silent
elsewhere: silence you know about beats a green light you cannot trust. So every
judgement call resolves toward reporting. The ones that change a verdict:

- **Facts upstream reads off disk are optional graph fields, and absent means
  "the exemption does not apply"** — `data.mfeRemote` (`noImportsOfApps`),
  `data.entryPoints` (secondary entry points), `data.declaredPackages`
  (`noTransitiveDependencies`). An adapter that has them supplies them; one that
  does not gets the strict answer.
- **An external record with no external node in the graph is still checked.**
  `src/graph/` deliberately registers no crates, PyPI distributions or Go
  modules as external nodes, and upstream bails when it cannot find one — which
  would leave `bannedExternalImports` unenforceable outside JavaScript. The
  record's own answer is taken instead. Upstream's `node_modules` read is not a
  second way in: it supplies only the `name@version` used to look a node up in a
  map built from `externalNodes`, so an installed package with no node still
  resolves to nothing (measured, `../conformance/README.md`). What that reach
  amounts to in practice is narrower than the mechanism — a JS, TS or Vue
  external record exists only for an installed package, which already has a
  node, so the synthesis changes a verdict only for Go, Rust and Python.
  **A specifier that is a path gets no node, synthesized or otherwise**,
  because a package name is what the mechanism needs and a path is never one;
  `isPathSpecifier` in `index.mjs` is
  the same test the branch that reports `noRelativeOrAbsoluteExternals` uses, so
  a path refused a target is a path that gets reported. "Is a path" is the
  RECORD's answer, not this layer's — a Rust `use` path and a Python dotted
  module are names, and a bare `.` is a path in one language and not in another.
- **`require()` and `require.resolve()` of a lazy-loaded library are reported**,
  where ESLint exempts both. The analysis contract records either call as
  `kind: "static"`, like an `import` statement, and the three cannot be told
  apart from the record.
- **An `ignoredCircularDependencies` pattern this engine cannot expand exactly
  is rejected at config load.** Nx expands them with minimatch, which this
  project may not import, and an ignore list that expands to almost the right set
  hides real cycles.

## What must not land here

- **A second copy of the constraint table.** The table has one home — the
  boundary config at the consumer's workspace root — and `../config.mjs` is the
  only thing that reads it.
- **A workspace's specific project names, areas, or tag values.** This tool is
  installed into trees it has never seen, with names and a tag vocabulary it
  cannot predict. Everything comes from the graph and the config — fixtures
  included.
- **Judgment about which files to analyze.** A rule is handed records.
- **A `messageId` upstream does not use.** The ids are what make a differential
  comparison against ESLint mean anything, and
  `upstream.integration.test.mjs` fails when a copied message or option drifts.
