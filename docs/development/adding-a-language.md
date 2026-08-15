# Adding a language

This is the keystone of the project's direction: the north star is _every_
language in a repository getting the same enforcement TypeScript already has,
and this page is the path from "not supported" to "supported" without the
intermediate state that would quietly make the tool untrustworthy.

Read [../doctrine/north-star.md](../doctrine/north-star.md) § _How the next language earns its
place_ first. The single most important rule here is not technical:

> **A language ships complete or not at all.** Edges without enforcement is the
> state Nx is already in, and it is the state this project was built to end.

## Before you write anything

Answer these four. If any answer is "we'll work it out later", the language is
not ready.

**1. Is there a real workspace that will run it?** A language added ahead of its
first user is a set of parse limits nobody has ever met, tested against fixtures
written by the same person who wrote the parser.

**2. What is the project's identity?** One manifest per project root is the
modelling assumption everywhere else: `<projectRoot>/go.mod`,
`Cargo.toml [package]`, `pyproject.toml [project]`. Name the equivalent, and name
what a nested second manifest does (today's answer: no edge — split it into its
own project).

**3. What can be read statically, and what cannot?** Nothing here shells out to a
toolchain, because Nx computes the graph on every invocation and a graph that
needs four toolchains installed fails on the machine that has none of them. If
your language's import resolution genuinely requires its compiler, say so now —
that is a design conversation, not an implementation detail.

**4. Which shapes will you misread, and in which direction?** Every existing
analyzer's limits err the same way: the worst case is _a spurious record naming
text the file really contains_, never a missed import. A limit that can drop an
import is not a limit, it is the defect this project exists to prevent.

## The order

Do them in this order. It is chosen so that the tree is never in a state where a
language looks supported and is not.

### 1. Register the extension

`src/analysis/analyze.mjs`:

```js
export const LANGUAGE_BY_EXTENSION = Object.freeze({
  // …
  ".rb": "ruby",
});
```

This is the **one place** an extension is mapped in code, and doing it first is
deliberate: the dispatcher now **throws** for that extension, naming the language,
because the second table (language → analyzer) has no entry. That is how the next
language stays loud before its analyzer lands, and it is why this step comes
before the analyzer rather than after.

### 2. Write the analyzer

```js
analyze({ sourceFile, text, workspace }) -> { imports, failures }
```

`text` arrives already read, so the caller owns the read strategy and a test can
drive the analyzer from an in-memory string. `workspace` is
`{ root, projects, filesOf, readFile }`.

The record shape is frozen in
[`src/analysis/contract.md`](../../packages/lattice/src/analysis/contract.md)
and reproduced as JSDoc types in `analyze.mjs`; the two are edited together.
Analyzers are meant to be written in parallel, and that only works if none of
them gets to reinterpret the shape.

Four decisions the contract has already settled, each of which you will be
tempted to re-litigate:

- **One record per _written_ import**, not per resolved dependency. A file
  importing the same project three times yields three records — five of the
  fifteen rules are decided on the raw specifier and its position.
- **Intra-project relative imports are still emitted.**
- **An analyzer never throws on a malformed file.** It records a failure. A throw
  takes down the run for the file it could not read; an empty return calls it
  clean.
- **An unresolvable specifier is `resolved: null` plus a failure — never
  dropped, never guessed.** A dynamic import with a non-literal argument is one
  record with `kind: "dynamic"`, the argument's source text as `specifier`, and
  `resolved: null`.

#### `spelling` is the field to think hardest about

It is **mandatory**, and `evaluate()` throws on a record that omits it rather than
falling back to the JavaScript shape. Two independent bits:

|                                          | `path` | `relative` |
| ---------------------------------------- | :----: | :--------: |
| `./x`, `../x`, `.`, `..` (JS)            |  yes   |    yes     |
| `/x` (JS)                                |  yes   |     no     |
| `crate::x`, `self::x`, `super::x` (Rust) |   no   |    yes     |
| `.mod`, `..pkg.sub` (Python)             |   no   |    yes     |
| `react`, `serde`, `example.com/m`        |   no   |     no     |

`path` means the specifier is a **filesystem path** — resolvable by path
arithmetic, naming no package. `relative` means it **reaches inside its own
project without going out through the project's public name**.

The analyzer answers this and the rules do not, because the rules layer never
learns which language it is holding. That was measured rather than assumed: when
the rules derived both bits from JavaScript's shape, ordinary Rust
(`use super::product_name`, and a binary calling its own package's library crate)
produced two violations that were not real, and Python was the same exposure with
the sign reversed on both bits.

If your language has no relative import form at all, say what the bit means
instead and argue it in the header — Go's answer is "`relative` is true exactly
when the import resolved back into the source file's own project", because Go has
no relative form and its compiler already forbids the cycle the rule looks for.

### 3. Write the limits header, in the same commit

Not in an issue. Not in a follow-up. The headers of `go.mjs`, `rust.mjs` and
`python.mjs` are the model: each names the shapes it misreads, and each argues
that the worst case is a spurious record rather than a missed import.

A shape discovered later and fixed without the header gaining a line is one of
the four drift signals the north star lists.

Pin each limit with a test, so a future fix has to change the test that documents
it.

### 4. Add the graph resolver

`src/graph/create-dependencies.mjs` reduces manifests to Nx's edge shape:
`{ source, target, sourceFile, type }`. Nx drops everything else, which is why
this layer is a deliberately lossy view of analysis rather than a second use of
the same records.

The resolver contract is shared and injectable:
`resolve(projects, filesOf, readFile)`.

Two things to get right, both learned the hard way in Python:

- **Follow the ecosystem's real semantics, not string matching.** A Python edge
  exists only where the manifest explicitly wires a dependency to a workspace
  path — a `[tool.uv.sources]` route, a Poetry `{ path = "…" }`, a PDM
  root-anchored local URL — each shape taken from that tool's current
  documentation, cited in the resolver's header. A name that merely coincides
  with a sibling package is not a dependency, and a declared path the resolver
  cannot attribute to any project's root fails graph computation rather than
  being dropped: the hook's only outputs are edges and an error, and a dropped
  entry is an edge `nx affected` silently never sees.
- **Never classify an unresolved first-party import as external.** That is a
  positive assertion that a project is a third-party package, and every tag
  constraint then evaporates — the rules return from their npm branch before the
  constraint block. Unresolved means `resolved: null` and a failure.

### 5. Route it to the editor

`.claude-plugin/plugin.json` at the repository root, under
`lspServers.*.extensionToLanguage`. The manifest lives at the root because the
marketplace entry's `source` is `"./"` — the plugin is the whole repository —
and the server it launches is `packages/lattice/lsp.mjs`.

A JSON manifest cannot import anything, so this list is a second copy of
`LANGUAGE_BY_EXTENSION` — allowed only because
`src/lsp/editor-config.integration.test.mjs` keeps the copy honest and fails the
day the two disagree.

**And a third copy**, in `packages/lattice-vscode/src/languages.mjs`. A client
has to name the file types it routes before any server is running, so it cannot
ask the server what they are; `routed-extensions.integration.test.mjs` in that
package holds it to the manifest above on the same terms. Both tests fail on a
language added in one place and not the others, which is the only thing that
makes three copies allowed.

What goes wrong without this step is quiet: the language is checked by the CLI
and never by an editor, so every project written in it keeps showing no boundary
problems in the buffer. That reads exactly like a clean tree.

**Bump the manifest `version`** — here, in `.claude-plugin/marketplace.json`,
in `.codex-plugin/plugin.json`, in `packages/lattice/package.json` and in
`packages/lattice-vscode/package.json` (the extension routes the new extension
too — `src/languages.mjs` is where, and `routed-extensions.integration.test.mjs`
holds it), which must all match. An installed plugin is cached per version, so
an unbumped edit reaches nobody, and `scripts/check-skills.mjs` fails when they
drift.

### 6. If you need a parser dependency

Read the allow-list in
[`src/conformance/boundary.test.mjs`](../../packages/lattice/src/conformance/)
first — it is where the list lives, one entry per package with the reason it
earns, and adding a dependency means adding it there in the same diff. The list
is deliberately not restated in prose anywhere: it used to be, it drifted, and
prose beside a gate is the copy that loses.

Two patterns the existing dependencies establish:

- **Load it lazily.** `vue/compiler-sfc` is reached through `createRequire` on
  first use, not at module scope, because this tool runs over trees with no Vue
  at all — a top-level import would make a missing `vue` break Go, Rust and
  Python analysis in a workspace with no `.vue` file in it.
- **A missing parser is a failure record**, naming what is absent, like anything
  else the layer could not do. It never throws.

Declare it as an **optional peer dependency** if it is only needed for that one
language, following `vue` in `package.json`.

### 7. Conformance fixtures

`src/conformance/` is the differential against real ESLint. Where does your
language fit?

- **ESLint cannot read it** (the Go/Rust/Python case): the fixtures prove _this
  engine_ reaches every rule, and the comparison records that ESLint reports
  nothing. That asymmetry is the finding.
- **ESLint can read it** (the Vue case): both engines run on the same files and
  must produce the same `messageId` at the same site. Vue is the precedent, and
  the reason this repository once wrongly documented Vue as a blind spot — the
  correction is pinned by a fixture so it cannot drift back.

Either way, `stated-counts.integration.test.mjs` holds the conformance README's
catalogue sizes to the catalogue, so the numbers in that file move with your
fixtures rather than being remembered.

### 8. Tests

[testing.md](testing.md) covers the tiers. The two rules specific to a new
analyzer:

- **A test that would pass against a hard-coded name→project map is not a test.**
  Resolution is driven over an in-memory workspace whose `readFile` backs a real
  fixture tree.
- **Every test needs a case that goes red in the silent direction.** A test that
  only pins the message text is half a test — it cannot fail when the analyzer
  stops finding the import at all.

### 9. Documentation

Four files, and none of them optional:

| file                                                       | what to add                                                                             |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [`docs/reference/languages.md`](../reference/languages.md) | A section: identity, what the analyzer reads, every limit, what the record leaves null  |
| [`docs/doctrine/north-star.md`](../doctrine/north-star.md) | A row in the state table — and it must be honest about which of the four cells are real |
| `packages/lattice/README.md`                               | The npm landing page mentions the language set; it must stand alone                     |
| `packages/lattice-vscode/README.md`                        | The marketplace page names the routed extensions one by one                             |

## The definition of done

All four of these, or the language is _partly_ supported and should say so rather
than implying otherwise with a checkmark:

|                                                                                                | proved by                                                       |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Edges** — changing a project marks its dependents affected                                   | the graph integration test, over a real Nx context              |
| **Enforcement** — all fifteen violation types reachable                                        | the rules suite, driven from that language's fixtures           |
| **Editor** — a violation is a diagnostic at the edit                                           | the integration manifest, held to the analyzer registry by test |
| **Declared limits** — every unreadable shape written down, all erring toward a spurious record | the analyzer's own header, pinned by tests                      |

## And one thing you will be tempted by

There is **no `languages` option**, and adding one is not a small convenience —
it is a change of direction. A report from a workspace that switched a language
off is byte-for-byte identical to a report from a workspace whose code in that
language is clean, which is precisely the silence this project exists to end.

A workspace already pays nothing for a language it does not have: every resolver
keys off a manifest that is not there.
