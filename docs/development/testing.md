# Testing

Which suite proves what, and which failure each tier exists to catch.

The commands themselves — setup, what to run before pushing, how a pull request
lands — are CONTRIBUTING.md's and are not repeated here.
This page is about _why_ the suites are split the way they are, and what a new
test has to do to be worth adding.

## The bar every test here is held to

**Every test needs a case that goes red in the silent direction.**

A test that only pins the message text is half a test. It fails when the wording
changes and passes when the analyzer stops finding the import at all — which is
the failure that matters. Concretely, for a rule test: one case where the
violation must be reported, and one near-miss where it must _not_ be, so a rule
that stopped matching anything cannot stay green by finding nothing.

That is the same reason the Semgrep rules each carry a `ruleid:` case as well as
an `ok:` case. A pattern that stopped matching passes every scan by matching
nothing.

## Two suites, and neither covers the other

```shell
pnpm test                                            # node --test over scripts/ only
moon run ...:lint ...:test ...:typecheck             # each package's own target
```

**`pnpm test`** is `node --test` over `scripts/*.test.mjs` — the gate scripts, and
nothing else. Those scripts are what make a green build mean something, and a
broken gate reports nothing rather than reporting a failure. They run first in CI
for exactly that reason.

**`moon run ...:test`** is each package's own target — Vitest in both packages.
For `archkeep` that includes the differential against a real
`@nx/enforce-module-boundaries`; for `archkeep-vscode` it is every decision the
extension makes, driven as pure functions with no editor running.

Running one and assuming the other passed is the most common local mistake. Run
the whole list before pushing; a shorter local run just moves the red to the pull
request.

## The tiers inside the package

### Unit — `*.test.mjs`

Pure functions over injected data. No filesystem, no mocking library.

That is a consequence rather than a preference: **the gate scripts and the
analyzers take their facts as arguments.** `parseCiTargets` gets text, `evaluate`
gets records, an analyzer gets `{ sourceFile, text, workspace }`. A function that
reads a file _and_ decides something has to be split before it can be tested, and
the split is the improvement.

The one deliberate exception is `readMoonProjects`, which touches the outside
world and is untested on purpose — a test that stubbed the answer would pin the
stub.

Two rules specific to this codebase:

- **An analyzer test that would pass against a hard-coded name→project map is
  not a test.** Resolution is driven over an in-memory workspace whose `readFile`
  backs a real fixture tree, so `ts.resolveModuleName` runs for real.
  `typescript.test.mjs` repoints a `tsconfig.base.json` alias without changing the
  specifier and requires the answer to move with it.
- **Positions are computed from the fixture, never written as literals.**
  `src/lsp/diagnostics.test.mjs` finds the expected 0-based position by searching
  the fixture text, so changing the fixture moves both sides and changing the
  conversion moves only one. A diagnostic one line off is worse than no
  diagnostic: it sends every reader to the wrong import, confidently.

Property-based cases use fast-check, with the seed pinned on CI —
`vitest.property-seed.mjs` says why.

### Integration — `*.integration.test.mjs`

Real seams, over throwaway fixture trees. Each one exists for a failure the unit
tier structurally cannot see.

| file                                             | the failure it is for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `graph/create-dependencies.integration.test.mjs` | Nx changing `CreateDependenciesContext`. It reaches through `index.mjs` deliberately — an entry that stopped re-exporting `createDependencies` would drop every polyglot edge while a test pointed at the implementation stayed green                                                                                                                                                                                                                                                                                                       |
| `config.integration.test.mjs`                    | A malformed row in **this repository's own** boundary config, and the proof that the reader takes its filename from a caller — one case asks for a name that does not exist and requires the error to name it back                                                                                                                                                                                                                                                                                                                          |
| `config-spelling.integration.test.mjs`           | A dialect that "loads" a policy SMALLER than what was written — one fewer constraint row, one option silently defaulted instead of read — or a marker/route/filename spelling that silently diverges in verdict from another spelling of the identical law. Covers path source, filename, workspace-root marker, all four config dialects, and where each dialect's stated-vs-defaulted options and suppressions actually come from; every axis carries a red twin the differential must catch, never only a case where the spellings agree |
| `cli.integration.test.mjs`                       | Both halves: the real binary spawned, for the exit-code and usage contract; and `check()`/`runCli()` in-process over a fixture Go workspace with only Nx and git injected, so the exact `file:line:column` a developer acts on is pinned rather than assumed                                                                                                                                                                                                                                                                                |
| `lsp.integration.test.mjs`                       | The server answering over real stdio                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `report/sarif.integration.test.mjs`              | An upload GitHub silently rejects. It builds one result per `messageId` from the real message table and asserts the fields a rejection turns on — a `ruleId` that resolves in the catalogue, a non-empty message, a repository-relative `uri` with a 1-based `startLine`/`startColumn`. **A SARIF test that only checks the file parses is not a test**                                                                                                                                                                                     |
| `lsp/editor-config.integration.test.mjs`         | A language reaching the analyzer registry and not the Nx integration's manifest — checked by the CLI, never by an editor, which reads exactly like a clean tree                                                                                                                                                                                                                                                                                                                                                                             |
| `rules/upstream.integration.test.mjs`            | A copied message or option drifting from the installed `@nx/eslint-plugin`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `analysis/vue.integration.test.mjs`              | The line a reader finally sees, from the real analyzer pair, against positions computed from the fixture                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `conformance/rule-sdks.integration.test.mjs`     | Four rule-authoring SDKs drifting into four laws while all four suites stay green — every SDK's fixture copies held byte-identical, every committed `.wasm` loaded through the engine's real host at its recorded digest, and one verdict document required from all of them per fixture, which must also be the recorded one. Three of the four SDK suites replay their reference rule as native code, so without this the artifact a consumer runs was proven only by its digest                                                          |
| `conformance/corpus.integration.test.mjs`        | A rule that stops firing in Go, Rust or Python, where no upstream engine can disagree — hand-labeled architecture workspaces driven through the whole `check` path, with each near-miss measured against a forbid-everything policy so its silence cannot be an engine that never looked                                                                                                                                                                                                                                                    |

**The Vue analyzer is pinned from both sides**, and it is the model for anything
with a coordinate conversion in it: `vue.test.mjs` mocks the TypeScript analyzer
to pin the text handed over — the whole file with everything outside the script
block blanked, so no arithmetic can be wrong — and the integration test drives the
real pair.

### Analyzer coverage on real trees — where there is no oracle at all

`scripts/coverage-real-trees.mjs` asks the question the ESLint differential
structurally cannot. `.go`, `.rs` and `.py` never reach the upstream rule, so
upstream's silence about them is inability rather than a verdict, and there is
nothing to disagree with. This lane needs no oracle: it clones real public
repositories at pinned shas — one Go, one Rust, one Python — runs the real
analyzers over every tracked source file, and holds three counts EXACTLY in
both directions: files read, import records produced, failures reported.

Exactness is legitimate because the sha is pinned: the tree cannot move under
the harness, so any movement is the harness changing. Fewer records is an
analyzer that went quiet on a syntax it used to read — the silent direction,
and the reason the lane exists. **Fewer failures is a breach too**: a failure
that stopped being reported is a file that now looks read.

It runs weekly beside the differential, in the same workflow and with the same
posture — not a required check, because it depends on third-party repositories
being reachable, and a red run is a regression rather than a flake. Its tree
table records what each count means, including the gap its first run found and
the fix that followed: the Rust analyzer could not read a top-level
`use { a::b, c::d };` brace group, which ripgrep writes 29 times, and reading it
as the list of paths it is turned 29 failures into 72 records.

### Conformance — the differential against ESLint

`src/conformance/`
is the only thing in the repository that puts this engine's verdict beside real
ESLint's on the same code. Its catalogue sizes — fixture workspaces, probes,
projects, near-misses — live in that directory's README, held to the catalogue
by `stated-counts.integration.test.mjs`; a copy of the numbers here would drift
with nothing holding it.

Nothing is stubbed on either side. The eight option values and the fifteen
message ids come off the installed rule's own `defaultOptions` and
`meta.messages`, so a case states only what it overrides and an Nx upgrade moves
both engines' input at once.

Two mechanics to know before changing anything there, both documented at length
in that directory's README: **one workspace root per process** (`@nx/devkit`
resolves it once, on first load, and never again), and **same site, not same
column** (ESLint reports the whole statement, this engine reports the specifier,
and a pair matches when this engine's position falls inside ESLint's range).

The real-tree half of that comparison lives outside the package:
`scripts/differential-real-trees.mjs`
drives the same two engines over public Nx workspaces pinned at fixed commits,
from `.github/workflows/differential.yml` rather than from any `test` target —
the conformance README's condition 3 states what it measures and why a red run
there is a regression, and its pure halves (ledger matching, the empty-verdict
claim) are what `scripts/differential-real-trees.test.mjs` pins under
`pnpm test`.

### Conformance — the labeled corpus, where ESLint has no parser

The differential can only speak where ESLint can read the file, which is
JavaScript, TypeScript and Vue. On `.go`, `.rs` and `.py` — the languages this
tool exists for — upstream is silent by inability, so no comparison there can
catch a rule that stopped firing: every spelling of the import would go quiet
together and still agree.

`corpus.mjs` and `corpus.integration.test.mjs` are that half. Architecture
styles built in those three languages, each probe carrying the findings a
person decided in advance, run end to end through `cli.mjs`'s `check` over a
native (`archkeep.json`) workspace. The mechanism that keeps a near-miss from
being an engine that never looked — a second, forbid-everything policy every
case tree carries — and the three numbers each probe states are documented in
that directory's README rather than here, along with the corpus's own sizes,
which `stated-counts.integration.test.mjs` holds to the catalogue.

Three cheaper files sit beside those two and check the project against its own
declarations rather than against ESLint: `boundary.test.mjs` holds the shipped
tool to what it may depend on, `stated-counts.integration.test.mjs` holds the
README's catalogue sizes to the catalogue, and
`plugin-catalogue.integration.test.mjs` holds the Claude Code plugin manifests
to each other.

The same script carries a second, native-provider leg over the same pinned
trees — never a second clone, never a second script. It derives a
`archkeep.json`-equivalent model mechanically from the graph JSON the upstream
leg already fetched (`deriveNativeModel`), runs `nativeProvider.discover`/
`buildGraph` over it, and compares the node set, edge set, and rule verdicts
against that same tree's real Nx-graph-based run — reusing `LEDGER` and
`classifyDifferences` with its own `"native-extra"`/`"native-missing"`
direction pair rather than a parallel mechanism
(`packages/archkeep/src/providers/native/README.md`'s "What proves this
provider against a tree it was not tested on" has the fuller account,
including what the first real run against `code-pushup` found and why a
populated ledger there is the expected outcome, not a regression). The tool
run on this tree, described just below, has a native-provider twin too:
`.github/workflows/ci.yml`'s "Check this repository's own module boundaries
(native provider)" step runs the checker against a throwaway copy of this
same tracked tree with `nx.json` swapped for a tracked
`.github/native-selfcheck/archkeep.json`, and asserts that copy reads the
byte-identical `module-boundaries.config.mjs` the Nx-based step just above it
judged — so a disagreement between the two is a provider defect, never two
copies of the law drifting apart.

### The gates that are not tests

Three things in CI prove something no unit test can, and they are worth knowing
about because a change can break them without breaking a single test:

- **`check-packages`** — asserts every directory under `packages/` is a project
  the graph can see, declaring at least one CI target. Without it, `moon run`
  exits 0 on three different states and only one of them is good: nothing there,
  something there with no matching target (**skipped in silence**), or a
  directory with sources and no `moon.yml` (**invisible** to `moon projects`).
- **`check-docs-links`** — fails on any doc reference that cannot resolve:
  a markdown link whose target file is gone, a `#anchor` that names no heading,
  a `docs/…` citation pointing at nothing. Prettier formats a broken link and
  marks it correct; this gate is where "does the link land" is answered.
- **The tool run on this tree** — the final `check` step, over
  `module-boundaries.config.mjs` at the root. Everything above it proves the code
  correct against fixtures it built itself; this is the only step where the
  enforcer meets real source under a tag vocabulary nothing in `src/` knows.
- **`verify-package.mjs`** — packs the real tarball, installs it into a throwaway
  workspace, and drives what a consumer actually buys. Every other gate runs where
  the tool's dependencies already exist, which is why none of them could see the
  state this package was really in once: zero declared dependencies, green suite,
  and a `import ts from "typescript"` that would have thrown on a consumer's disk.

## Coverage

V8 provider, 80% floor on lines, functions, branches and statements. **80 is a
floor, not a target** — it exists so a change that deletes coverage fails instead
of passing quietly. Both suites sit well above it.

The four numbers live in `coverage.config.json` at the root, and each package's
`vitest.config.mjs` reads them. They started as literals in the one package that
had tests, with a note saying they would hoist the day a second package earned a
test target — because four numbers copied into two configs are not a hardcode,
they are an unsynced config. `archkeep-vscode` was that second package. The file
is read rather than imported: JSON has no import, and a relative import from
inside a project up to a root-level file is a violation this repository's own
checker reports.

**Three files are deliberately absent from the coverage `include`, all for one
reason.** `cli.mjs` and `lsp.mjs` call `process.exit` and are driven end-to-end
as spawned subprocesses; `extension.mjs` only runs inside a VS Code extension
host. In-process V8 coverage sees none of the three. That is the exclusion's
reason, not a convenience — and it is why each of them holds wiring only:
everything with a decision in it lives under `src/`, where coverage can see it.

## Where a regression fixture goes

A **missed violation** — an import that crosses a boundary and produced no output
— is the worst class of bug this project has, and it earns a permanent regression
fixture rather than just a fix. Which tier depends on what was silent:

| what was silent                      | where the fixture goes                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| an import the analyzer did not see   | that analyzer's unit tests, plus a line in its limits header if the shape stays unreadable                                                       |
| a rule that should have fired        | `src/conformance/` — `cases.mjs` in a language ESLint reads, so its verdict is the check; `corpus.mjs` in Go, Rust or Python, where the label is |
| an edge that never reached the graph | `graph/create-dependencies.integration.test.mjs`                                                                                                 |
| a file the editor never received     | `lsp/editor-config.integration.test.mjs`                                                                                                         |
