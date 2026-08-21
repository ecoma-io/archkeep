---
id: 0002-custom-rules-one-contract
status: proposed
---

# Custom rules are one contract, not one system per language

## Status

Proposed — this records a direction, not a shipped mechanism: nothing in the
engine loads a custom rule today, and no page under
[reference/](../reference/) claims otherwise. It is written down now, before
the first line of that mechanism, because the one thing no later version can
change without breaking every rule already written is the boundary a rule the
engine did not write must stay inside — and a boundary is a decision, which is
what this registry records. Acceptance carries edits this proposal does not
make itself; they are named under Consequences.

## Context

Lattice judges through fixed vocabularies: the fifteen boundary violations
([reference/violations.md](../reference/violations.md)), the eight options,
and the named fitness conditions
([concepts/fitness-functions.md](../concepts/fitness-functions.md)). Those
cover the questions a constraint table can spell. They cannot cover the
questions an organization's own doctrine asks — a Clean Architecture team's
"no interface declared outside the domain", a DDD team's context-map
conventions, a security team's "nothing under this layer reaches the network
stack". [north-star.md](../doctrine/north-star.md) refuses a rule authoring
UI; it does not refuse rules a workspace authors as code, reviewed like code.
Today there is no way to author one.

Four constraints make the obvious answers wrong, and together they are the
shape of the decision:

- **The extension surface cannot require Node or TypeScript.** The tool
  exists for repositories whose languages ESLint cannot read; a Go-and-Rust
  repository told to install Node and write TypeScript to extend its
  architecture checker has been told the polyglot promise stops at the
  built-ins.
- **A rule needs architecture facts and language facts in one judgment.**
  "The domain never reaches infrastructure" is the same rule in every
  language; "an interface may only be declared in the domain" is a fact only
  a Go reader can supply. A system that can see one but not the other splits
  into per-language systems at exactly the rules that need both.
- **Per-language rule APIs fragment the ecosystem.** If a Go rule, a Rust
  rule and a TypeScript rule have different shapes, lifecycles and verdict
  vocabularies, "a Lattice rule" stops meaning one thing — the split this
  project exists to end, reproduced one level up.
- **Whatever extends must ride the existing chain unchanged** — model →
  analysis → evidence → rule → verdict. Extension anywhere else (a rule that
  parses, a rule that walks the tree, a rule that renders) re-opens seams
  the layering closed, and every one of them is a place a silent result can
  hide.

Everything the decision leans on is already in the tree: the rules layer is
already a pure function over records with no filesystem, no git and no Nx
(`packages/lattice/src/rules/README.md`); fitness already shows rules folded
into `check` by presence, with four verdicts and no flag to forget; every
judgment already speaks one verdict vocabulary
([concepts/evidence.md](../concepts/evidence.md)); the policy already has
exactly one home and rejects unknown law by name
([concepts/policies.md](../concepts/policies.md)); and a rule row already
carries its governance — reason, origin, `decisionRef`
([concepts/provenance.md](../concepts/provenance.md)).

## Decision

Custom rules extend Lattice at exactly one seam — the rule stage — under one
contract, in two tiers, with WebAssembly as the programmatic carrier.

### One seam: the rule stage

A custom rule occupies the position the built-in rules and the fitness
registry already hold: after analysis, before report. It is handed observed
facts and returns a verdict. It never supplies a graph (providers own that),
never chooses or reads files (the workspace layer owns the first, analysis
the second), never renders or filters output (report owns that), and never
touches another rule's verdict.

That seam is what keeps this from becoming a second ESLint. An ESLint rule
receives a file and walks its AST itself, which is why an ESLint rule is
welded to one language's parser. A Lattice rule receives facts an analyzer
already extracted, which is why one contract can serve every language the
analyzers read — and every language they will read later, with no rule
changing.

### A rule is a pure function from evidence to verdict

The contract in one sentence: **evidence in, verdict out, nothing else in
either direction.**

- **In:** a versioned, canonically-serialized bundle of observed facts — the
  project model with its tags, the graph edges, the import records the
  analysis contract fixes (`packages/lattice/src/analysis/contract.md`), the
  resolved policy, and the declared parameters of this rule instance.
- **Out:** one verdict in the four-state vocabulary every judgment already
  speaks, under the same evidence obligations
  ([reference/evidence.md](../reference/evidence.md)): positioned findings
  for `fail`, a named reason for `unknown`, a `notApplicableReason` for
  `not_applicable`. The enforcement that refuses a hollow verdict from a
  built-in refuses one from a custom rule, at the same reporting boundary.
- **Nothing else:** no filesystem, no network, no clock, no randomness, no
  environment. Principle 4 ([principles.md](../doctrine/principles.md))
  demands determinism; this contract makes it structural rather than
  reviewed.

### Declarative before programmatic

Two tiers, and the order is a decision rather than a sequencing accident:

- **Tier one — declarative rules.** The fitness condition registry grows new
  named condition types, in the engine, tested there, documented in
  [reference/policy-schema.md](../reference/policy-schema.md); a workspace
  states parameters in its policy and writes no code. `tag-axis-isolation`
  is the proof this tier scales: one declared row replaced a per-partition
  row that had to be restated every time the tree grew
  ([concepts/fitness-functions.md](../concepts/fitness-functions.md)).
- **Tier two — programmatic rules,** for judgments no fixed vocabulary can
  hold. These enter through the contract above, carried as WebAssembly.

A demand a named condition can meet should be met in tier one, because a
declarative rule is language-independent by construction, reviewable as
data, and deterministic with nothing left to prove — and every condition
type added there serves every workspace and every language at once. Teams
reach for code only where data cannot say it.

### The programmatic carrier is WebAssembly

An author writes a rule in the language the repository already speaks — Go,
Rust, TypeScript, Python — compiles it once, and commits the artifact. The
engine executes it with the `WebAssembly` runtime its JavaScript engine
already ships: core WebAssembly only, no WASI, no host imports beyond the
contract's own. The choice is judged against the principles, not taste:

- **Determinism (principle 4).** A WebAssembly instance holds no ambient
  capability: what the host does not grant does not exist. This host grants
  the evidence bytes and nothing else, so "a rule cannot read the clock" is
  not a review comment — it is the absence of a clock.
- **No toolchain at check time (principle 5).** The artifact is compiled by
  its author, wherever the rule is developed. The machine that runs `check`
  — the lint-only CI job, the contributor who never touches that language —
  executes it with no Go, cargo or Python installed, the same property the
  analyzers hold by reading sources statically.
- **One artifact, every machine.** A wasm module is the same bytes on every
  OS and architecture, so the law cannot fork by platform — and cannot
  behave differently on the machine that reviews it than on the machine
  that enforces it, which is what a native binary per platform invites.
- **No new dependency.** Core WebAssembly executes inside the engine the
  tool already requires, so the package's dependency allow-list
  (`packages/lattice/src/conformance/boundary.test.mjs`) does not grow a
  runtime.

The core-only constraint is load-bearing: it is the floor every language
toolchain can target, and it fixes the ABI at the simplest thing that can be
versioned — evidence bytes into linear memory, verdict bytes out. Exact
symbol names and memory ownership live with the implementation and its
reference page when they land, not in this record.

### Language facts are evidence kinds — a rule never parses

"The domain never reaches infrastructure" needs no language; "Go interface",
"Rust visibility", "Python re-export" do. Two ways to hand a rule those
facts were on the table, and the refused one is the important half:

- **Refused: the rule sees source text.** Every rule would grow its own
  parser, every parser its own undeclared limits, every limit a silent
  misread wearing a verdict — one unreviewed analyzer per rule, when
  principle 3 lists what even this repository's own analyzers owe the
  moment they read a language.
- **Decided: the analysis layer grows named, language-namespaced evidence
  kinds** — `go.…`, `rust.…`, `python.…` record families produced by the
  engine's own extractors under the discipline the import record already
  lives by: frozen shape, limits declared in the extractor's header, worst
  case a spurious record and never a silently missing one. The import
  records and the graph are the first kinds; each further kind arrives with
  the extractor that produces it, one at a time, priced by real demand.

A rule **declares** the kinds it needs. The engine supplies every declared
kind or answers `unknown` for that rule with the missing kind named — it
never evaluates a rule over facts it does not hold, because a verdict
computed from partial evidence is a pass nobody earned. A rule that needs a
fact no kind carries is a feature request for an extractor, not a license
to parse.

This is also what keeps a language-aware rule inside the one ecosystem: a
Go-aware rule and a language-neutral rule differ only in the kinds they
declare — same shape, same lifecycle, same verdicts, same report.

### Declared in the policy, never discovered

A custom rule enters a workspace the way every other law does: a row in the
one policy file ([concepts/policies.md](../concepts/policies.md)), under a
fifth recognized top-level name held to the same rejected-by-name discipline
as the four that exist. A sketch — the exact field set lands with the loader
change that reads it:

```js
export const customRules = [
  {
    name: "no-interface-outside-domain",
    artifact: "tools/arch-rules/no_interface_outside_domain.wasm",
    sha256: "…",
    params: { domainTag: "layer:domain" },
    reason:
      "interfaces are the domain's ports; declaring one anywhere else inverts the dependency direction",
  },
];
```

- **`reason` is mandatory**, exactly as it is for a suppression and a
  fitness row: a rule with no reason is indistinguishable from a rule
  nobody would defend. The row accepts the same governance block a
  constraint row carries
  ([concepts/provenance.md](../concepts/provenance.md)), so a custom rule
  can name the decision that created it.
- **`sha256` pins the artifact's bytes.** A wasm file is not
  human-readable; the hash is what makes "the law CI ran is the law review
  saw" checkable — for a tracked artifact and for one resolved out of an
  installed package alike. A mismatch is a load error, never a quieter law.
- **Nothing is discovered.** No glob over `*.wasm`, no convention
  directory: a rule that was not declared judges nothing, because law from
  nowhere is the authority leak
  [architecture-authority.md](../doctrine/architecture-authority.md) exists
  to refuse — and a deleted artifact must fail the run that still declares
  it, never silently narrow the law.

### Failure is loud, in the machinery that exists

Custom rules fold into `check` by presence — no flag, for the reason the
fitness page states once
([concepts/fitness-functions.md](../concepts/fitness-functions.md)). A
finding from a custom rule is a finding like any other: exit 1, rendered by
the same report, accepted only through the same declared suppressions and
waivers. Every way a rule can fail maps onto exit codes that already mean
the right thing ([reference/exit-codes.md](../reference/exit-codes.md)):

| the path                                                                                                     | the answer                                                              |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| artifact missing, hash mismatch, not valid wasm, contract not exported                                       | the law could not be loaded — the 3-class, like a malformed config      |
| rule traps, exceeds its bounded time or memory, returns bytes that do not parse, or returns a hollow verdict | that rule is `unknown` with the cause named; any `unknown` keeps exit 3 |
| rule declares an evidence kind or contract version this engine cannot supply                                 | `unknown` with the gap named — never an approximation                   |

No new exit code, no new report channel, and no path on which a declared
rule silently does not run — the row where a rule "skips" is absent from
that table on purpose.

### SDKs are bindings, held by one conformance suite

An SDK per language — Go, Rust, TypeScript, Python — owns exactly three
things: typed bindings for the evidence and verdict shapes, the build story
from that language to a core-wasm artifact, and a test harness that replays
golden evidence fixtures against the author's rule locally. What an SDK may
never own is semantics: no SDK-specific fields, no dialect, no second
verdict vocabulary.

What holds four SDKs to one contract is a gate, not discipline: a shared
conformance suite — evidence fixtures with expected verdicts that every
SDK's reference rules must reproduce — the same arrangement that already
keeps this engine honest against ESLint
(`packages/lattice/src/conformance/`). An SDK ships when it clears the
whole bar — bindings, build story, harness, green conformance — or it does
not ship, the complete-or-not-at-all rule
[north-star.md](../doctrine/north-star.md) already applies to languages.
The distance to that bar differs by language today, and Python's toolchain
path to wasm is the longest; a Python team is not thereby locked out — tier
one is language-blind, and the contract accepts an artifact from any
toolchain that can produce one.

### The SDKs live in this repository, under the gates that exist

The SDKs are packages of this monorepo — `packages/lattice-rule-sdk-rust`,
`-go`, `-ts`, `-python` as each arrives — not four repositories. Three
reasons, and the third is the deciding one:

- **A gate only binds what sits in its tree.** The conformance suite above is
  the mechanism that keeps four SDKs one contract, and it only works as a
  same-diff discipline: a contract change and every SDK's answer to it land
  together, the same edited-together arrangement the analysis contract
  already runs with its JSDoc half. Split across repositories, the suite
  runs against pinned yesterday's SDKs, and green stops meaning current.
- **`packages/` is where placeholder-green is already caught.**
  `scripts/check-packages.mjs` refuses a package that runs no CI target, and
  Moon tasks are plain commands — `cargo test`, `go test`, `pytest` declare
  exactly the way `vitest run` does today. An SDK outside `packages/` would
  sit outside the one gate built to notice a package that stopped meaning
  anything.
- **One version chain, one sentence.** The releasable unit here is the
  repository — [skills/versioning.md](../skills/versioning.md) owns the
  chain — so "contract N ships in engine 0.x" stays one sentence across
  engine and SDKs instead of a compatibility matrix.

The cost, named: this repository's CI grows the language toolchains that
build and test the SDKs. That touches no refusal — principle 5 is about what
the shipped engine needs at check time in a consumer's tree, not about what
this repository needs to build its own artifacts.

### One name on every registry, one version through the existing lane

The short names are not available where it matters, and that is measured,
not assumed: on 2026-08-21, crates.io already carries `lattice` and
`lattice-sdk`, and PyPI carries `lattice`; `lattice-rule-sdk` is free on
both. So the published name is **`lattice-rule-sdk`** everywhere a registry
needs one — `lattice-rule-sdk` on crates.io and PyPI,
`@ecoma-io/lattice-rule-sdk` on npm — and it is also the truer name: this is
the SDK for authoring rules, not for driving the engine. A registry that
already names the language does not repeat it; the tree, which holds four,
does — hence the directory suffixes. Go's name is its path,
`github.com/ecoma-io/lattice/packages/lattice-rule-sdk-go`, and the length
is an accepted cost of the monorepo decision above.

Versioning and release ride what exists rather than growing a second lane:

- **Every SDK joins the one version chain.** The Cargo, PyPI and npm
  manifests join release-please's `extra-files` and the `check-skills` chain
  in the same change that lands each package — the arrangement
  [skills/versioning.md](../skills/versioning.md) already holds for the five
  files it lists.
- **Go's version is the tag.** A Go module carries no manifest version, and
  Go's own rule for a module below the repository root is a tag prefixed
  with the module's directory — so the release lane mints
  `packages/lattice-rule-sdk-go/v<version>` beside the bare `v<version>` it
  already tags.
- **One publish job per registry**, each behind the same pre-publish
  conformance re-run and never-widening waiver expression the existing
  publish jobs hold (`release.yml`'s own comments own that argument), and
  each with its `scripts/verify-package.mjs`-shaped proof: the packed
  artifact installed into a throwaway workspace of that language, driven
  through a consumer's first hour before anything is published.

### The order the mechanisms land in

Stages, not dates — [roadmap.md](../doctrine/roadmap.md) refuses dates and
this record refuses them with it. Each stage carries its own proof, and no
stage's checkmark is implied by the one before:

1. **Declarative growth.** New condition types as real demand names them —
   no new surface, no new package, each documented in
   [reference/policy-schema.md](../reference/policy-schema.md) as it lands.
2. **The contract, engine-side.** The evidence bundle and its canonical
   serialization; the fifth policy name across the dialects; the wasm host
   in the rule stage; the failure taxonomy wired to the existing exit
   codes; the finding namespace in all three report faces. Proven before
   any SDK exists: a hand-built wasm fixture rule drives `check` end to
   end, and the packed-artifact verification grows the consumer-side probe
   — the contract is proven from the outside first, the same direction
   `scripts/verify-package.mjs` already proves the package from.
3. **The golden fixtures, then the first SDK: Rust.** Fixtures generated
   from the engine, then `packages/lattice-rule-sdk-rust` clearing the
   whole bar the SDK section states, with the crates.io lane in the same
   stage. Rust goes first because `wasm32-unknown-unknown` is the one
   mainstream toolchain that emits a no-import module today.
4. **TypeScript, Go, Python — in the order their build stories clear the
   no-import host, measured.** Go's mainstream wasm targets assume a WASI
   or JavaScript host, so its story must be proven against this host before
   its SDK is announced; the SDK section already prices Python's distance.
5. **The first language-namespaced evidence kind**, arriving with the first
   real rule that needs it — extractor and contract addendum in one change.
   May overlap stages three and four.

The measure of "shipped" does not move: it stays the last consequence
below — one SDK, one kind, one real workspace blocking on a custom rule.

### Refused alternatives, each by name

- **An in-process JavaScript plugin API — the ESLint model.** It would
  re-impose Node and TypeScript on the repositories the polyglot promise
  exists for, and an in-process module runs with the engine's own
  privileges: purity would be a promise, where the carrier above makes it a
  property.
- **A native subprocess per rule — the LSP model.** Right for surfaces,
  wrong for law: per-platform binaries, the author's toolchain on every
  machine that runs `check` (against principle 5), and no capability
  boundary a reviewer can lean on.
- **A rule DSL of Lattice's own.** A new language to learn is the
  fragmentation pain relocated, and a DSL rich enough for real judgments
  grows toward a bad general-purpose language. The declarative tier is the
  honest scope of a DSL — named conditions with parameters — and it already
  exists to grow.
- **Rules that read source.** Refused where the evidence-kind decision is
  made, above; listed here so the refusals are one list.

## Consequences

- **The chain survives extension.** Model → analysis → evidence → rule →
  verdict, with custom code confined to the fourth stage. Everything this
  licenses — built-ins, declarative rows, SDK rules, organization packs —
  converges on one engine, one evidence model, one verdict vocabulary, one
  report.
- **The evidence bundle becomes public API.** Its schema is versioned like
  the JSON envelope ([reference/json-output.md](../reference/json-output.md))
  and grows additively within a version. An engine change that alters what
  an evidence kind reports can change a custom rule's verdict on an
  unchanged workspace — from the first shipped kind onward, the evidence
  contract carries the same breaking-change discipline `AGENTS.md` already
  applies to what is reported.
- **A workspace's rule changing that workspace's verdicts is the
  workspace's own change** — the law moved, reviewed like code. The
  engine's compatibility promise covers what it feeds a rule, never what
  the rule concludes.
- **Custom findings live in their own namespace**, keyed by the rule's
  declared name; the fifteen upstream message ids stay reserved for the
  boundary rules ([reference/violations.md](../reference/violations.md)),
  so the differential against ESLint keeps meaning what it means. A rule's
  self-description contributes the catalogue entry the SARIF and JSON
  envelopes resolve against.
- **The authority line does not move.** A custom rule widens what a
  workspace can judge, never who decides
  ([architecture-authority.md](../doctrine/architecture-authority.md)): it
  is declared law in the tree, agents remain consumers of its verdicts, and
  no rule can waive, suppress, or amend anything — acceptance stays with
  the declared suppressions and waivers
  ([concepts/waivers.md](../concepts/waivers.md)).
- **Acceptance carries the edits this proposal does not make.**
  [roadmap.md](../doctrine/roadmap.md) stages the capability — tier one
  extends what its 2.x direction already names "deeper architecture
  intent"; the contract tier is staged by name as part of accepting this
  record. The consumer-facing reference and concepts pages arrive with the
  mechanisms they describe, not before. `SECURITY.md` gains the
  committed-artifact supply-chain paragraph. The policy loader's fifth
  top-level name lands with the loader change that reads it.
- **The first shipped version is measured by the invariant, not the SDK
  count.** One SDK, one language-namespaced evidence kind and one real
  workspace running a custom rule as a blocking gate prove more than four
  SDKs proving each other — the same evidence-over-features posture the
  roadmap's 1.0 conditions take.
