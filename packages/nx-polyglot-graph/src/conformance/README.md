# `src/conformance/` — the differential against ESLint

[`src/rules/`](../rules/README.md) reimplements the fifteen violation types and
eight options of `@nx/enforce-module-boundaries` by reading upstream's source.
Reimplementations diverge, and they diverge silently. This directory is the only
thing in the repository that puts the two verdicts side by side.

The dangerous direction is the **false negative**: this tool reporting clean
where ESLint would have caught something. That is worse than the state it
replaces. Today ESLint is right about JavaScript, TypeScript and Vue and silent
about Go, Rust and Python — and silence you know about beats a green light you
cannot trust.

**46 fixture workspaces, 116 probes, 94 projects.** Every one of upstream's
fifteen message ids is triggered by at least one probe, and 80 of the 116 probes
are near-misses where ESLint must report nothing.

## How it runs

`conformance.integration.test.mjs` materialises every case into one throwaway
workspace under the OS temp dir, then runs both engines over the same files, the
same graph object and the same option values:

- **upstream** — the real rule, through ESLint's programmatic API, with the real
  `@nx/eslint-plugin` out of `node_modules`;
- **this tool** — the real `src/analysis/` analyzers feeding the real
  `evaluate(sites, graph, config)`.

Nothing is stubbed on either side. The eight option values and the fifteen
message ids come off the installed rule's own `defaultOptions` and
`meta.messages`, so a case states only what it overrides and an Nx upgrade moves
both engines' input at once.

```
pnpm nx test nx-polyglot-graph
```

Fixtures exist only while the suite runs, which is what keeps them out of the
workspace's own lint, typecheck and build — the same containment
`src/graph/create-dependencies.integration.test.mjs` uses.

Three other files here check the project against its own declarations rather
than against ESLint, and they are cheap where the differential is not:
`boundary.test.mjs` holds the shipped tool to what it is allowed to depend on,
`stated-counts.integration.test.mjs` holds this file's catalogue sizes to the
catalogue, and `plugin-catalogue.integration.test.mjs` holds the Claude Code
plugin manifests to each other.

### Two mechanics worth knowing before changing anything here

**One workspace root per process.** `@nx/devkit` resolves its workspace root
once, on first load, and never again. So every case lives in a directory under
one root, import aliases and fake package names are workspace-wide and must be
globally unique, and `createFixtureRoot()` has to run before anything imports
nx. `assertNxRootIsFixture` fails loudly if that ordering ever breaks — without
it, upstream would read this repository's files while judging fixture paths and
every result would be an artefact of that.

**Same site, not same column.** ESLint reports the whole statement; this engine
reports the specifier, because that is what an editor should underline. A pair
matches when this engine's position falls inside the range ESLint reported.
Requiring equal columns would mark every pair as a disagreement about nothing;
requiring only the same file would let a diagnostic pointing at the wrong
statement pass as agreement.

## The differential table

`comparable` is the column that keeps the rest honest: it counts the probes of
that row ESLint could parse at all. A `weaker` of 0 is a claim about those
probes and no others, because an engine that never read the file cannot be
diverged from. The paragraph under the table says what that leaves out.

| messageId                                    | agree | stricter | weaker | comparable | verdict          |
| -------------------------------------------- | ----: | -------: | -----: | ---------: | ---------------- |
| `noRelativeOrAbsoluteImportsAcrossLibraries` |     3 |        1 |      1 |          5 | WEAKER — DEFECT  |
| `noRelativeOrAbsoluteExternals`              |     4 |        0 |      0 |          4 | agree            |
| `noCircularDependencies`                     |     1 |        0 |      0 |          1 | agree            |
| `noSelfCircularDependencies`                 |     2 |        1 |      0 |          3 | agree + stricter |
| `noImportsOfApps`                            |     1 |        1 |      0 |          2 | agree + stricter |
| `noImportsOfE2e`                             |     1 |        0 |      0 |          1 | agree            |
| `noImportOfNonBuildableLibraries`            |     1 |        0 |      0 |          1 | agree            |
| `noImportsOfLazyLoadedLibraries`             |     1 |        1 |      0 |          2 | agree + stricter |
| `projectWithoutTagsCannotHaveDependencies`   |     1 |        0 |      0 |          1 | agree            |
| `bannedExternalImportsViolation`             |     4 |        2 |      0 |          4 | agree + stricter |
| `nestedBannedExternalImportsViolation`       |     1 |        0 |      0 |          1 | agree            |
| `noTransitiveDependencies`                   |     2 |        1 |      0 |          3 | agree + stricter |
| `onlyTagsConstraintViolation`                |    10 |       21 |      0 |         11 | agree + stricter |
| `emptyOnlyTagsConstraintViolation`           |     1 |        0 |      0 |          1 | agree            |
| `notTagsConstraintViolation`                 |     2 |        0 |      0 |          2 | agree            |

The suite prints this table, and every divergence beneath it with its reason —
but only under a reporter that does not swallow a passing test's console output.
Measured on vitest 4.1.10, the plain run above prints no table at all; this one
prints it:

```
pnpm nx test nx-polyglot-graph --args="--reporter=verbose"
```

Read every column against one scope: a row counts an outcome only where both
engines could see the file. ESLint has no parser for `.go`, `.rs` or `.py`, so a
probe in those languages can produce a stricter row and never a weaker one — its
silence is inability, not a verdict. "Agree" and "weaker" are therefore claims
about the readable half of the catalogue, and only there.

The table here is a transcription of that run's output, and the run is the
authority. What a transcription cannot be trusted with is checked instead:
`stated-counts.integration.test.mjs` holds this file's catalogue sizes to the
catalogue, and requires one table row per violation type this engine reports.
The per-row counts are not derivable without running both engines, so those
stay what the run says and nothing else.

## The defect ledger — where this engine is WEAKER than ESLint

**One entry, and it is a declared difference in exemption mechanism rather than
a rule this engine cannot reproduce.** `boundarySuppressions` silences a
violation that ESLint, which does not read that config, still reports — the
weaker half of the two-way divergence two sections below, measured by the probe
that carries the config entry and no directive. A workspace that pairs the two
mechanisms — an `eslint-disable-next-line` beside every `boundarySuppressions`
entry — sees no gap at all.

What that entry is not: a violation this engine failed to find. Every message
id upstream defines is implemented and exercised, and **every violation ESLint
reports at a site both engines can see, this engine reports too.** That is the
guarantee the whole comparison exists to establish, and it is unchanged.

**Where "weaker" can be measured at all.** Only on a file ESLint can parse. A
`.go`, `.rs` or `.py` probe is structurally incomparable — upstream is silent
there by inability, not by judgement — so those probes say nothing about false
negatives in either direction, and the ledger's scope is the readable half of
the catalogue.

The ledger is held to reality from both sides rather than remembered:
`carries exactly the false negatives its own ledger records` compares the false
negatives it observes against the ones the catalogue declares. A new one fails
the run because nothing declares it; a declared one that stopped happening fails
the run because the declaration outlived it. So this list is a measurement, not
a claim — and it cannot rot into one without the run going red.

Two further probes exist because they each caught a false negative that has
since been fixed, and the properties they pin are the two a reader should check
first — a fix with no probe behind it is a fix waiting to be undone. Each is
covered
from both sides — the fixture that produced the finding, and a unit test beside
the code that states the intent without needing ESLint to run:

- a specifier that is a path receives **no** synthesized external node, because
  a package name is what synthesis needs and a path is never one. Refusing it is
  what puts the site back in the `if (!targetProject)` branch, the only place
  `noRelativeOrAbsoluteExternals` is reported (`external-resources-reached-by-path`;
  `isPathSpecifier` in `src/rules/index.mjs`).
- `require.resolve(...)` produces an import site, matching the second callee
  form upstream's `getImportFromRequireCall` admits. A form that produces no
  record leaves not one message missing but **all fifteen rules void on that
  call** (`import-forms-a-boundary-check-must-see`; `isRequireCallee` in
  `src/analysis/typescript.mjs`).

## Decisions — where this engine is deliberately stricter

Every one is declared by the case that produces it, with its reason; the suite
fails on a stricter verdict that carries no declaration.

| divergence                                                                     | direction | verified how                                                                                                                                    |
| ------------------------------------------------------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `data.mfeRemote` absent ⇒ the Module Federation exemption does not apply       | stricter  | `module-federation.config.js` on disk, field off the node: upstream exempts, this reports                                                       |
| `data.entryPoints` absent ⇒ the secondary-entry-point exemption does not apply | stricter  | `package.json` `exports` on disk, field off the node: upstream exempts, this reports                                                            |
| `data.declaredPackages` absent ⇒ the dependency is not shown to be direct      | stricter  | package in the root manifest, field off the node: upstream is silent, this reports `noTransitiveDependencies`                                   |
| `require()` of a lazy-loaded library is reported                               | stricter  | upstream's lazy check requires `node.type === ImportDeclaration`; a call expression never reaches it                                            |
| `import x = require(...)` is judged                                            | stricter  | `TSImportEqualsDeclaration` is in none of upstream's five visitors; the analyzer records it as static                                           |
| an external record with no external node is still checked                      | stricter  | `banned-external-crate-import-in-rust` and `banned-external-module-import-in-python`: the ban is reachable only because the node is synthesized |

The three fail-closed rows are the same decision applied three times: upstream
reads a fact off the filesystem that a rule here may not, so the fact arrives as
an optional graph field and its absence means "the exemption does not apply". An
adapter that supplies the field gets upstream's answer exactly; one that does not
gets a false alarm a maintainer can see, rather than a boundary that quietly
stopped being enforced.

## Decisions — where the two are told about an exemption differently

One divergence is not about a verdict but about the mechanism that removes one,
and it therefore points BOTH ways:

| divergence                                                             | direction | verified how                                                                                                                                                |
| ---------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| upstream honours an `eslint-disable` directive; this engine ignores it | stricter  | `an-exemption-both-enforcers-were-told-about`, its probe carrying the directive and no `boundarySuppressions` entry: ESLint goes quiet, this engine reports |
| this engine honours `boundarySuppressions`; upstream does not read it  | weaker    | the same case, its probe carrying the config entry and no directive: this engine goes quiet, ESLint reports                                                 |

**Why the exemptions do not live in comments.** Reading ESLint's directive
syntax would tie a language-agnostic tool to a JavaScript comment convention
that Go, Rust and Python have no equivalent for, and it would give exemptions a
second home besides `module-boundaries.config.mjs` — which exists precisely so
the boundary law has one. In the shared config every exemption is visible,
reviewable and greppable in one place, and a mandatory `reason` is enforceable
at load in a way a comment never is.

**Why the case also carries the configurations nobody diverges on.** Beside the
two one-mechanism probes above, it carries the same import told to BOTH
mechanisms — the configuration a workspace running both engines is expected to
use, pairing an `eslint-disable-next-line` for ESLint with a
`boundarySuppressions` entry for this engine — and the identical
import told to neither. Both engines go silent on the first and both report on
the second, so the one-mechanism probes are read against a case that is known to
fire rather than one that might have stopped triggering.

Both halves reach the table above as rows, which is the point of building them:
the stricter half as a declared decision, the weaker half as the single entry in
the defect ledger. Neither is prose anyone has to trust, and neither can quietly
change direction without the run going red.

**A suppression can never silence a failure.** It filters violations after every
site has been judged, so it cannot skip the checks that make `evaluate()` throw
— a record naming a project the graph does not contain stays fatal inside a fully
suppressed file, which `src/rules/index.test.mjs` pins. Analysis failures never
reach the rule engine at all: they travel beside the records in the analyzer's
envelope. A verdict is something someone can decide to accept; "I could not tell"
is the absence of one, and a config that could silence it would turn a blind spot
into a green light.

## The languages ESLint cannot read

Measured, not assumed. Asked to lint a `.go` file, ESLint answers:

> File ignored because no matching configuration was supplied.

That is the whole reason this tool exists, and it is pinned as a test. Nine
cases show the tool enforcing where ESLint cannot:

| language | case                                                         | this tool reports                |
| -------- | ------------------------------------------------------------ | -------------------------------- |
| Rust     | `banned-external-crate-import-in-rust`                       | `bannedExternalImportsViolation` |
| Rust     | `paths-inside-a-crate-and-across-one-in-rust`                | `onlyTagsConstraintViolation`    |
| Rust     | `one-crate-crossing-however-the-use-is-spelled`              | `onlyTagsConstraintViolation`    |
| Python   | `banned-external-module-import-in-python`                    | `bannedExternalImportsViolation` |
| Python   | `relative-imports-inside-a-package-and-across-one-in-python` | `onlyTagsConstraintViolation`    |
| Python   | `one-module-crossing-however-the-import-is-spelled`          | `onlyTagsConstraintViolation`    |
| Python   | `one-package-however-its-manifest-places-it`                 | `onlyTagsConstraintViolation`    |
| Go       | `layer-constraint-violation-in-go`                           | `onlyTagsConstraintViolation`    |
| Go       | `one-module-crossing-however-the-go-import-is-spelled`       | `onlyTagsConstraintViolation`    |

The two "paths inside" cases carry the near-miss half as well, and it is the
half they were built for: the same file spelling an import that stays inside its
own project must produce nothing. Both engines being unable to read `.rs` and
`.py` is what makes that half easy to get wrong — nothing on the ESLint side
disagrees with a false positive there. Measured on the untouched tree, that is
exactly what happened: `use super::product_name` and a binary calling its own
package's library crate were both reported as `noSelfCircularDependencies`,
because the rules layer decided relativeness with `.`, `..`, `./`, `../` —
JavaScript's shape, in a language that spells the same idea `crate::`. The
record now carries the answer per language (`../analysis/contract.md`), and
these two cases are what stop it regressing behind a silent ESLint.

### One import, every spelling — the assertion that needs no ESLint

The four `however-…-is-spelled` cases exist because the rest of this half
cannot catch its own mistakes. Where ESLint has no parser, the only other
statement about a probe is the `tool: [...]` a person wrote by hand, and that
agrees with the engine by construction — including when the engine is wrong
about a shape nobody thought to write. Every defect found by adversarial review
in this half was such a shape: a comment containing `)` inside a Go
`import (…)` block, a Python package placed by `package-dir` rather than under
`src/`, a `use` spelled `pub(crate) use`.

So a probe may carry a `spelling` key naming the import it writes, and the
suite requires every probe sharing one key to reach the **same** verdict —
compared against the engines' actual output, never against what the probe
claims. A form the analyzer silently drops disagrees with its own siblings and
takes the run red, with no ESLint involved and nobody needing to have guessed
the right answer in advance. A group of one is reported too: a spelling group
that lost its siblings asserts nothing, and would otherwise die quietly.

**Vue is not on that list, and that is a finding.** A `.vue` file gets
`vue-eslint-parser` in a workspace that configures one, and the upstream
boundary rule carries no `files` filter, so the rule already runs inside
single-file components wherever that parser is set up. The
`banned-external-import-in-a-vue-single-file-component`
case confirms it: ESLint reports the banned import, and the two engines agree.
Vue was never a blind spot.

## Four claims put to the test — two corrected, two confirmed

Each was recorded in `src/rules/README.md` or at its call site as settled, and
each was then measured against the installed rule. Two did not survive. The
other two did, and they are kept here because a reader who doubts them should
not have to redo the work.

### "Upstream bails when it cannot find an external node" — confirmed

The graph's `externalNodes` are a precondition, not one of two ways in.
`TargetProjectLocator` builds its `npmProjects` map **from** `externalNodes`
alone; the `node_modules` read supplies only the `name@version` used to look a
node up in that map, and `findNpmProjectFromImport` ends
`if (!matchingExternalNode) return null;`. `runtime-lint-utils.js` then returns
`projectGraph.nodes[target] || projectGraph.externalNodes?.[target]`, and the
rule bails on `undefined` — "if target is not found (including node internals)
we bail early", in upstream's own comment.

Measured against `smol-toml@1.7.1` — a package installed in both runs, so the
only thing that differed is `externalNodes`:

```
externalNodes populated: findProjectFromImport("smol-toml") -> "npm:smol-toml"
externalNodes emptied:   findProjectFromImport("smol-toml") -> undefined
```

So synthesizing the node is what makes `bannedExternalImports` reachable at all
where `src/graph/` registers none, exactly as `src/rules/README.md` states.

Its **reach** is narrower than the mechanism, for a reason that has nothing to
do with the locator. A JS, TS or Vue external record exists only where
TypeScript resolved the specifier, which means the package is installed — and an
installed package Nx has in its lockfile already carries an npm node, so there
is nothing left to synthesize (measured on the workspace this suite was written
against: 0 of its 49 direct dependencies lacked one). A package that is on
neither is recorded unresolvable,
this engine synthesizes nothing, and both stay silent
(`banned-external-import-of-a-package-that-is-not-installed`). The analyzers
that name a package without needing it installed are Go's, Rust's and Python's,
and those are the only places the synthesis changes a verdict.

### "The `@tauri-apps/*` ban works from `.rs` and `.py`" — corrected

Only for the bare form. `isConstraintBanningProject` opens with
`imp !== packageName && !imp.startsWith(`${packageName}/`)`, a test written for
npm's `/` separator. A Rust `use rustshell::window::Manager` has specifier
`rustshell::window::Manager` and package name `rustshell`; neither branch
matches, so the ban is silent. Same for Python's `import pyshell.window`.

Measured both ways in the Rust and Python cases: `use rustshell;` and
`import pyshell` are reported; the deep forms are not. A ban on a shell crate is
therefore close to unenforceable in Rust, where the bare `use` form is unusual.

### "`getEntryPoint`'s directory branch is dead upstream" — corrected

Dead for one key shape, alive for another, and the difference is a single
character. `joinPathFragments(file, '../')` keeps its trailing slash, and an
entry point's `path` is `joinPathFragments(projectRoot, basePath)` where
`basePath` is the `exports` **key**:

| `exports` key  | entry `path`      | can the walked `parent` match it? |
| -------------- | ----------------- | --------------------------------- |
| `"./sub"`      | `libs/a/sub`      | no                                |
| `"./src/sub"`  | `libs/a/src/sub`  | no                                |
| `"./src/sub/"` | `libs/a/src/sub/` | **yes**                           |

Two cases prove both halves. With `"./src/sub"`, a file inside the entry point's
directory importing that entry point is **not** reported — the walk finds
nothing, the two entry points differ, the exemption applies
(`self-import-from-inside-a-secondary-entry-point-directory`). With `"./src/sub/"`,
the walk matches, the two entry points are equal, and
`noSelfCircularDependencies` **is** reported by both engines
(`secondary-entry-point-declared-with-a-trailing-slash`).

This engine reproduces both, so parity holds either way. The claim should read
"dead for every `exports` key without a trailing slash", which is the modern
form and so nearly all of them.

### "`nestedBannedExternalImportsViolation` is near-unreachable" — confirmed

The check is passed the specifier of the import being judged,
which by that point in the pipeline resolves to a **project**, while
`isConstraintBanningProject` demands that specifier be a nested **package**'s
name. It can only fire where a project's import alias and a transitively
reachable package name are the same string. The case builds exactly that
collision and both engines report; change the alias so it no longer collides and
both go silent.

Reproduced rather than repaired, deliberately: fixing it here would report what
ESLint does not, and parity is what makes this comparison mean anything.

## What the suite does not cover

- **Message text.** Verdicts are compared by id and site. Two messages carry
  file lists built from different indexes — upstream reads Nx's cached
  `projectFileMap`, this engine derives one from the records it was handed — so
  `noCircularDependencies` and `noImportsOfLazyLoadedLibraries` agree on the
  verdict and print different chains. The run reports which pairs those are.
- **Columns.** See "same site, not same column" above.
- **Scale.** Every fixture is minimal. Nothing here says how either engine
  behaves on a graph with hundreds of projects.
- **`ignoredCircularDependencies` glob patterns.** `src/config.mjs` rejects the
  patterns it cannot reproduce, so there is nothing to compare; only exact
  project names are exercised.
- **A real workspace.** These are synthetic trees. That is deliberate — this
  tool is installed into workspaces it has never seen, and a fixture built on
  any one repository's project names would test a coincidence.

## What this licenses

**`@nx/enforce-module-boundaries` cannot be dropped from a workspace's ESLint
config today** — but the reason has changed shape. All fifteen message types
agree wherever both engines can see the code, and the only false negative any
probe records is the exemption-mechanism one above; what blocks removal is now
the other two conditions below, neither of which is about correctness on the
fixtures.

Three things have to become true first, and one of them is.

1. **No false negative this suite has not declared and explained.** Met, and
   held rather than remembered: the
   `carries exactly the false negatives its own ledger records` test fails on a
   new false negative and fails when a recorded one is fixed without the ledger
   moving with it. The one entry the ledger carries is an exemption-mechanism
   difference, not a rule this engine cannot reproduce, and a workspace that
   keeps its `eslint-disable` directives beside its `boundarySuppressions`
   entries closes it. This is the condition that can regress in one commit, so
   it is the one worth re-reading the run for rather than this paragraph.
2. **The stricter list stays a decision, not a surprise.** Every fail-closed row
   fires on a graph field `src/graph/` does not populate today.
   Removing ESLint would put those false alarms in front of contributors on real
   code, so either the adapter supplies `mfeRemote`, `entryPoints` and
   `declaredPackages`, or each absence is accepted with its noise understood.
3. **The differential runs on real trees, not only on fixtures.** A suite of
   minimal fixtures proves the rules agree about the situations someone thought
   to build. Pointing both engines at a real workspace — more than one, with
   unrelated vocabularies — and requiring the same verdict set, is what would
   prove they agree about the situations nobody thought of.

Until then the honest position is the one the tool already takes: run **both**.
ESLint stays authoritative for JavaScript, TypeScript and Vue, where it is
correct and where agreement is measured on the 37 fixture workspaces ESLint can
read rather than on the code contributors actually write. This tool covers Go,
Rust and Python, where
ESLint reports nothing at all and any enforcement is a strict improvement over
the silence it replaces.
