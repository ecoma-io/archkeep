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

**48 fixture workspaces, 125 probes, 100 projects.** Every one of upstream's
fifteen message ids is triggered by at least one probe, and 84 of the 125 probes
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
moon run archkeep:test
```

Fixtures exist only while the suite runs, which is what keeps them out of the
workspace's own lint, typecheck and build — the same containment
`src/graph/create-dependencies.integration.test.mjs` uses.

`corpus.integration.test.mjs` is the other half of this directory and answers
a question the differential structurally cannot — see "The labeled corpus"
below, which owns everything about it.

Three other files here check the project against its own declarations rather
than against ESLint, and they are cheap where the differential is not:
`boundary.test.mjs` holds the shipped tool to what it is allowed to depend on,
`stated-counts.integration.test.mjs` holds both catalogues' sizes to the
catalogues, and `plugin-catalogue.integration.test.mjs` holds the Claude Code
plugin manifests to each other.

`rule-sdks.integration.test.mjs` is a differential of a different kind, and it
belongs here for the same reason the ESLint one does: it puts verdicts beside
verdicts. Every rule-authoring SDK ships a reference artifact and a copy of the
same evidence fixtures, and
[`adr/0002`](../../../../docs/adr/0002-custom-rules-one-contract.md) names a
shared conformance suite — not discipline — as what keeps four SDKs one
contract. This is that suite: the fixture copies must be byte-identical, every
committed `.wasm` must load through the engine's real host at the digest its
own package records, and all of them must answer one verdict document per
fixture, which must also be the recorded one. `rule-sdks.mjs` holds the roster
and the expectations; no count is restated here, because the roster is the
catalogue and a number beside it would be the copy that drifts.

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
moon run archkeep:test -- --reporter=verbose
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

## The labeled corpus — where there is no upstream to ask

Everything above compares two engines. On `.go`, `.rs` and `.py` there is only
one, and the four `however-…-is-spelled` cases are the whole of what the
differential can say there: one import written several ways must reach one
verdict. That catches an analyzer blind to a shape. It cannot catch a RULE
that stopped firing, because every spelling of the import would go quiet
together and agree.

`corpus.mjs` is the answer to that: architecture styles — relaxed and strict
layering, onion, clean architecture, hexagonal, DDD bounded contexts, modular
monolith, vertical slices, a microservice repository — built in the four
languages ESLint cannot read, with the verdict decided from the policy and the
import BEFORE the tool was run. There is no oracle, so the labels are the
oracle, and the suite's whole design is about stopping them from becoming a
transcription of what the tool printed.

The styles are not a list of names to be long. Each pair of them is chosen so
one case's silence is the other case's finding, which is what makes either
verdict a claim about the constraint table rather than about the engine's
disposition:

- `layered-architecture-in-go` (relaxed) against `strict-layering-in-go`: the
  same downward edge that skips a tier is silent in the first and reported in
  the second.
- `onion-rings-in-python` against `strict-layering-in-go`: an inward edge
  skipping a ring is what onion is FOR and what strict layering forbids. The
  shape is not new to the corpus — `layered-architecture-in-go` already carries
  it incidentally — but this is where it is labeled on both sides, and where a
  Python package barrel gets to hide an outward dependency behind an
  `__init__.py`. That case's `intent` says why it exists at all when its rows
  are isomorphic to the clean-architecture case's.
- `clean-architecture-dependency-inversion-in-rust` against every layered case:
  an outermost-ring crate whose source dependency points inward at an
  abstraction it implements must stay silent, which is the one shape a reading
  of "the outer layer depends on nothing" would report.
- `vertical-slice-features-in-go` and
  `service-boundaries-with-combo-rows-in-python` against the layered cases: a
  partition axis rather than a layer axis, where the violation is between peers
  and no layer ordering exists to decide it.

**27 fixture workspaces, 108 probes, 101 projects**, carrying 60 labeled findings
and 54 near-miss probes that must produce nothing.

### How it runs, and why it runs the whole command

`corpus.integration.test.mjs` materialises each case into its OWN throwaway
root under the OS temp dir — no shared root, because nothing here loads Nx and
so nothing needs the one-root-per-process discipline the differential lives
under — and then asks the question a consumer asks: `cli.mjs`'s `check`, in
`--format json`, over a native (`archkeep.json`) workspace. Discovery, analysis,
the native graph, the rules and the report all run; the two seams that would
otherwise need a real environment (`git ls-files` and Nx) are the injectable
arguments `check` already takes. A corpus that re-assembled the pipeline itself
could keep passing while the composition a consumer runs came apart.

### The three numbers a probe states, and what each one catches

A probe is one source file, and it makes three independent statements. They
are independent on purpose: each covers a way the other two can be satisfied by
an engine that did nothing.

| the label | what it states                                                       | what its failure means                                                      |
| --------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `reports` | the exact findings this file must produce                            | a missing one is the silent direction; an extra one is a false positive     |
| `imports` | how many import sites the analyzer records here                      | the analyzer stopped reading a shape — the failure a near-miss would hide   |
| `denyAll` | how many findings it produces under a policy that forbids everything | the site is not visible to the engine at all, so its silence proved nothing |

`denyAll` is what makes a near-miss an assertion. Every case tree also carries
a second policy whose single row matches every project, permits a tag nothing
carries, and bans `*`; under it, an import that reaches another project or a
package a ban can match MUST report. Silence under the case's own law, read
against a report under a law that forbids everything, is a verdict about the
policy. A probe silent under both says in its mandatory `why` which unreachable
shape it is — an import that stays inside its own project, or a form no rule
can reach.

The case's findings are compared against the union of its probes' `reports` in
BOTH directions, so a finding no probe claims fails as loudly as a claimed one
that never arrived; and every finding's `line`/`column` is checked against the
fixture text rather than against a literal in the label — the specifier has to
start where the diagnostic points.

### What the corpus reaches

**12 of the 15 message ids, over 7 languages.** The table is derived from the
catalogue by `stated-counts.integration.test.mjs`, which fails when a cell
moves:

| messageId                                    |  Go | Rust | Python | TypeScript | Java | Kotlin |  C# |
| -------------------------------------------- | --: | ---: | -----: | ---------: | ---: | -----: | --: |
| `onlyTagsConstraintViolation`                |  15 |    3 |      4 |          1 |    3 |      2 |   1 |
| `notTagsConstraintViolation`                 |   0 |    2 |      0 |          0 |    0 |      0 |   0 |
| `emptyOnlyTagsConstraintViolation`           |   0 |    0 |      1 |          0 |    0 |      0 |   0 |
| `projectWithoutTagsCannotHaveDependencies`   |   1 |    0 |      2 |          0 |    2 |      2 |   1 |
| `bannedExternalImportsViolation`             |   1 |    1 |      0 |          0 |    2 |      2 |   1 |
| `noTransitiveDependencies`                   |   2 |    0 |      0 |          0 |    0 |      0 |   0 |
| `noCircularDependencies`                     |   0 |    0 |      2 |          0 |    2 |      2 |   0 |
| `noSelfCircularDependencies`                 |   0 |    0 |      1 |          0 |    0 |      0 |   0 |
| `noImportsOfApps`                            |   1 |    0 |      0 |          0 |    0 |      0 |   0 |
| `noImportsOfE2e`                             |   1 |    0 |      0 |          0 |    0 |      0 |   0 |
| `noImportOfNonBuildableLibraries`            |   1 |    0 |      0 |          0 |    0 |      0 |   0 |
| `noRelativeOrAbsoluteImportsAcrossLibraries` |   0 |    0 |      0 |          1 |    0 |      0 |   0 |

TypeScript appears in two cases for two different reasons. One is the modular
monolith: a single constraint table over a tree whose modules are written in
two languages, where the relative crossing in its web module is the axis Go
cannot break — the target project is one the module is allowed to reach, and
the spelling is the violation. The other is
`declared-project-unresolvable-import`, a `no-verdict` case whose whole point is
that the run CANNOT finish judging the tree: an import naming a declared
`@scope`-spelled project with no `tsconfig` `paths` mapping to resolve it is a
whole-file failure, so `check` refuses a verdict over that file (exit 3)
instead of reporting it clean. That case carries no probes by design — a file
the run could not judge carries no boundary-finding label — and its presence is
what lets the labeled corpus assert the SILENT direction of the invariant:
`status: "no-verdict"` and exit 3, told apart byte-for-byte from a clean run.

The three ids no probe reaches are named rather than left to be noticed, and
each needs a mechanism these languages do not have:
`noRelativeOrAbsoluteExternals` needs a specifier that IS a filesystem path,
which `spelling.path` is false for in all of them (`../analysis/contract.md`);
`noImportsOfLazyLoadedLibraries` needs a dynamic import; and
`nestedBannedExternalImportsViolation` needs a project alias colliding with a
nested npm package name. `corpus.mjs`'s `OUT_OF_REACH` states them with those
reasons, and the suite requires the reached and the unreachable ids to add up
to all fifteen — so an id added upstream lands in neither and fails the run.

### What the first run corrected, and how each correction was decided

Labels written in advance are wrong sometimes, and which side gets changed is
the whole question. Three were wrong on the first run:

- **Two claimed a tag violation on an edge that closed a cycle.** The FIXTURE
  was wrong, not the label: `noCircularDependencies` is decided before the tag
  block, so those cases were measuring the cycle rule while claiming to measure
  the tag rule. Both outward edges now point at a project that imports nothing.
- **One claimed a single `notTagsConstraintViolation` where the engine reported
  two.** The LABEL was wrong, and it was corrected only after reading the
  installed plugin: upstream's `findDependenciesWithTags` collects every
  project reachable from the target, so an import of the core violates a
  `notDependOnLibsWithTags` row when the core itself reaches something carrying
  the forbidden tag. The probe now labels both, and says so — a reading of that
  rule which stopped at the direct target would report one of the two and call
  the file half-clean.

The order matters more than the count: a label is evidence only while it is
decided from the policy and the import, and a label edited to match output is a
transcription. When the run disagrees, the question is which of the two is
wrong — and answering it means going to upstream's source or to the fixture,
not to the label.

### Declared limits of this corpus

- **A Rust external ban only reaches the bare `use crate_name;` form.**
  `libs/rs-core/src/shell.rs` carries both spellings and labels the deep one as
  silent, because upstream's own matcher tests the specifier against the
  package name and a `/`-separated prefix and `shellcrate::window::Manager` is
  neither — the same measurement the "`@tauri-apps/*` ban" section above
  records. Pinned as a label rather than hidden: a limit with a probe on it
  cannot quietly become a different limit.
- **Under `banTransitiveDependencies`, a Go standard-library import is
  reported.** `transitive-dependency-ban-in-go` labels `import "fmt"` as a
  finding, because the builtin exemption is Node's own module list
  (`isBuiltinModuleImport`) and knows nothing of Go's standard library, and a
  native tree supplies no `declaredPackages` for the check to clear the import
  against. The loud direction, and pinned so it stays a decision someone can
  read rather than a surprise in a consumer's first run with that option on.
- **Every case runs against the native provider only.** Whether the Nx, native
  and Moon providers agree on one tree is a different question with its own
  measurement (`../providers/native/differential.integration.test.mjs`, whose
  cost driver is a real `nx graph` spawn per fixture pair), and duplicating
  each case here in three provider shapes would pay that cost per case to
  re-answer it.
- **Cycles preempt tags, so an outward violation points at a leaf.** Two cases
  say so in their own `intent`: `noCircularDependencies` is decided before the
  tag block, so a fixture whose outward edge had a path back would measure the
  cycle rule while claiming to measure the tag rule. Both cases learned this
  from the run rather than from the source — the labels were written first and
  were wrong.

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
  any one repository's project names would test a coincidence. The real-tree
  half of the differential lives outside this suite, in
  `../../../../scripts/differential-real-trees.mjs`, precisely so no real
  repository's names leak into these fixtures; condition 3 below says what it
  measures and where it runs.

## What this licenses

**`@nx/enforce-module-boundaries` cannot be dropped from a workspace's ESLint
config today** — but the reason has changed shape. All fifteen message types
agree wherever both engines can see the code, and the only false negative any
probe records is the exemption-mechanism one above; what blocks removal is now
the breadth of the evidence — five real trees is a measurement, not a survey of
what workspaces do — plus the residue conditions 2 and 3 name.

Three things have to become true first, and all three now have a mechanism
holding them rather than a plan.

1. **No false negative this suite has not declared and explained.** Met, and
   held rather than remembered: the
   `carries exactly the false negatives its own ledger records` test fails on a
   new false negative and fails when a recorded one is fixed without the ledger
   moving with it. The one entry the ledger carries is an exemption-mechanism
   difference, not a rule this engine cannot reproduce, and a workspace that
   keeps its `eslint-disable` directives beside its `boundarySuppressions`
   entries closes it. This is the condition that can regress in one commit, so
   it is the one worth re-reading the run for rather than this paragraph.
2. **The stricter list stays a decision, not a surprise.** Met: all three
   fail-closed rows are populated by both adapters from the files upstream
   reads. `data.mfeRemote` comes from the `module-federation.config.{js,ts}`
   beside each app (`../workspace.mjs` → `annotateMFERemotes`), and the two
   `package.json` facts come from `annotatePackageFacts` in the same file —
   `entryPoints` from the project manifest's `exports` the way upstream's
   `parseExports` builds them, quirks reproduced rather than repaired, and
   `declaredPackages` as the union of the root manifest and the project's own,
   the `||` inside upstream's `isDirectDependency`. Both functions are shared
   by the CLI path and the LSP index, so the two faces cannot answer
   differently. The residue, named rather than discovered later: the rows
   still fire on a graph something else built, which is why they stay in the
   table above; upstream's `getEntryPoint` has an `ng-package.json` fallback
   `src/rules/topology.mjs` declares it does not reproduce, so an Angular
   workspace declaring secondary entry points that way still gets the strict
   answer; and a `package.json` neither parser can read keeps its fields
   absent where upstream throws mid-lint — extra reports instead of a crash,
   the loud direction both times.
3. **The differential runs on real trees, not only on fixtures.** Met in
   mechanism, with its scope stated rather than implied. A suite of minimal
   fixtures proves the rules agree about the situations someone thought to
   build; `scripts/differential-real-trees.mjs` at the repository root points
   both engines at real public workspaces — five, with unrelated constraint
   vocabularies, pinned at fixed commits — and requires the same verdict set,
   with every difference either explained in its ledger or failing the run,
   and a zero-verdict answer from either engine failing it too on trees
   measured to contain violations. The evidence lives in the
   `.github/workflows/differential.yml` runs (weekly and on demand — that
   file's header argues why it is not a required check); **a red run there is
   a conformance regression**, not a flake. A red run is consumed rather than logged: `differential.yml`
   writes a verdict envelope and reconciles the `conformance-differential`
   issue (`../../../../scripts/reconcile-differential-issue.mjs` owns that
   lifecycle — findings open or update it, a later green run on the default
   branch closes it, a could-not-look run never touches it), and `release.yml`'s
   `verify-conformance` gate re-runs the differential against the tagged bytes
   before publish, blocking on findings and failing open — loudly, as
   UNVERIFIED — only on could-not-look. Measured 2026-08-18 at the pinned
   commits: upstream reports 26 verdicts on code-pushup and 8 on ng-doc; this
   engine reports the same 26 plus 8 more on code-pushup's
   `code-pushup.preset.ts`, each one a declared `eslint-disable`-directive
   divergence the ledger explains, so the run is clean rather than
   findings-red. On the native leg, both trees agree with the Nx graph node
   for node, edge for edge — code-pushup's 175 edges and 34 verdicts, ng-doc's
   13 edges and 8 verdicts — with only code-pushup's already-ledgered
   `workspace#type` field difference remaining. The corpus grew to five trees
   on 2026-08-29 (telesarch, commitstory, cdwr — two pnpm workspaces and an
   npm one, pinned and measured the same way): cdwr adds a third violating
   tree — upstream 36 verdicts, this engine 49, the 13-verdict residue being
   `tools/cdwr-cli.ts`'s `eslint-disable` directive, ledgered like
   code-pushup's — and cdwr's root `project.json` reproduces code-pushup's
   already-ledgered missing-`projectType` divergence under a different node
   name. telesarch contributes the ledger's first `native-missing` entries:
   27 of nx's project edges the native face cannot draw, every one a pnpm
   workspace link resolving external in the TypeScript analysis — the
   documented no-realpath limit, not a new defect. commitstory agrees
   exactly: 2 nodes, 1 edge, zero verdicts on both engines. The scope: all
   five trees are TypeScript and JavaScript workspaces,
   which is also the entire surface upstream can read — no public Nx tree with
   Go, Rust, Python or Vue sources and a non-trivial constraint table under a
   permissive license existed to pin (both searches and their rejects are
   recorded in the script's tree table), so real-tree agreement covers TypeScript and
   JavaScript for now and five trees remain evidence rather than a survey.

The honest position is still the one the tool already takes: run **both**.
ESLint stays authoritative for JavaScript, TypeScript and Vue, where it is
correct and where agreement is measured on the 39 fixture workspaces ESLint can
read plus the five pinned real trees above — evidence that grows with the tree
table, not a proof over every workspace shape. This tool covers Go,
Rust and Python, where
ESLint reports nothing at all and any enforcement is a strict improvement over
the silence it replaces.
