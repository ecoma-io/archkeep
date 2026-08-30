# Roadmap

Where Archkeep is going, in stages. This document owns the staged direction —
the maturity ladder that orders the capabilities, and in what order the project
earns them. It deliberately owns nothing finer than that: individual features,
their design and their sequencing live in GitHub issues and milestones, because
a roadmap that lists fifty features is a backlog wearing a roadmap's name, and
it is stale the day the first one ships. [north-star.md](north-star.md)
owns what "finished" means for the capabilities named here and the refusals
that hold on the way; [architecture-authority.md](architecture-authority.md)
owns the system boundary every capability stays inside. When a claim in this
file needs a finish line, that file is the one that binds.

## The thesis

Archkeep is an **architecture governance system for human and agentic software
development** — a deterministic authority that keeps the intended architecture
aligned with the observed architecture while humans and agents continuously
change the codebase. [north-star.md](north-star.md) owns the
full sentence and the argument behind it; this document owns the staged path.

Architecture today lives in documents — READMEs, ADRs, diagrams — that nothing
executes and nothing checks. The code drifts from them silently, and the drift
compounds fastest exactly where review is thinnest: in codebases where agents
produce most of the diffs. Archkeep's answer is to make the architecture itself
machine-readable and its enforcement deterministic, so that "the boundary
holds" is a verdict a pipeline computes rather than a belief a reviewer holds.

## Current / implemented

Everything in this section ships today and is not future work.
A new reader should find these capabilities described as present, not promised.

- **A core independent of Nx, of Moon, and of monorepos.** The engine discovers
  projects, builds the dependency graph and judges boundaries from its own
  model; Nx and Moon are providers of that model rather than its foundation.
  Single-repo, monorepo and polyrepo layouts are first-class.
  ([concepts/integrations.md](../concepts/integrations.md))
- **A multi-language dependency graph read from source.** Go, Rust, Python,
  TypeScript, JavaScript, Vue, and JVM languages — Java and Kotlin imports read
  from source, Maven and Gradle manifests for project identity and static
  dependency edges. All analysis is static — nothing invokes a toolchain to answer
  a question about imports.
  ([reference/languages.md](../reference/languages.md))
- **Architecture as code.** Layers, boundaries, dependency constraints and
  ownership declared in a machine-readable model that is reviewed like code, in
  the repository it governs. ([concepts/boundaries.md](../concepts/boundaries.md))
- **Named law profiles.** A workspace may keep several boundary laws in a
  `profiles` registry and select one by name at check time, stacked on a shared
  `base` — resolved loudly, with no silent fallback to a quieter law.
  ([concepts/profiles.md](../concepts/profiles.md))
- **Six architecture styles shipped as policy packs.** Clean Architecture,
  hexagonal, traditional layering (strict and relaxed), layered modular
  monolith, vertical slices and DDD bounded contexts ride inside the package as
  profile registries, read by the same loader, validated by the same validator
  and enforced by the same path a registry a workspace wrote itself takes. A
  pack saves the blank page, not a mechanism.
  ([usage/presets.md](../usage/presets.md))
- **ADR / decision registry.** `docs/adr/` records name the recorded
  architecture decision a rule, fitness gate, or intent row leans on through a
  `decisionRef`, read with `archkeep adr`; a reference that resolves to nothing
  is `unknown`, never a pass. ([concepts/adr.md](../concepts/adr.md))
- **Deterministic enforcement in CLI and CI.** The verdict is an exit code and
  a machine-readable report; the same tree and the same model always produce
  the same answer. ([reference/exit-codes.md](../reference/exit-codes.md))
- **23 commands — `check`, `change`, `graph`, `diff`, `delta`, `discover`,
  `drift`, `reconcile`, `waivers`, `fitness`, `history`, `trajectory`,
  `evolution`, `health`, `report`, `debt`, `impact`, `explain`, `context`,
  `provenance`, `decisions`, `adr`, `rules`** — each with
  output a script or an agent can consume without parsing prose.
  `history` records the
  architecture's evolution across captured snapshots — the deterministic half
  of "how it got here" — `trajectory` aggregates that same record into
  signal counts, churn and persistence (facts that moved, never a score), and
  `evolution` reads it across a selected range of Git revisions, so "at which
  commit did this first appear" is answered from analyzed trees rather than
  from commit messages; `debt` ages the workspace's waivers, gaps and
  drift across it, and `report` composes health, waivers,
  fitness, the decision registry and provenance into one governance document
  under a single resolved law, so no two sections can answer from two.
  ([reference/cli.md](../reference/cli.md), [usage/history.md](../usage/history.md),
  [usage/trajectory.md](../usage/trajectory.md),
  [usage/evolution.md](../usage/evolution.md),
  [usage/debt.md](../usage/debt.md), [usage/report.md](../usage/report.md))
- **Nx and Moon as first-class integrations, not dependencies.** A workspace
  that has Nx or Moon gets graph reuse and `affected` integration; a repository
  that has neither loses nothing.
  ([integrations/nx.md](../integrations/nx.md),
  [integrations/moon.md](../integrations/moon.md))
- **Architecture snapshots with provenance.** `graph` produces a deterministic
  snapshot carrying the git origin of the run; `diff` warns when a baseline
  cannot be attributed to the same repository.
  ([usage/graph.md](../usage/graph.md), [reference/json-output.md](../reference/json-output.md))
- **Meaningful architecture diff.** `diff` separates structural change from
  policy mismatch from rule impact, and refuses an incomplete baseline.
  ([usage/diff.md](../usage/diff.md))
- **Basic drift detection.** Four drift signals, with no predictive component:
  boundary violations and configuration drift surface through `check`;
  structural drift and its rule impact surface through `diff`; and
  architecture-intent drift has a descriptive face of its own (`drift`) that
  `check` also folds in by presence.
  ([concepts/drift.md](../concepts/drift.md))
- **Fitness functions.** Named, declared quality gates — "the graph stays
  cycle-free", "at least 90% of files are analyzed", "no slice reaches another
  slice" — judged deterministically against the same observed facts `check`
  reads, and folded into `check` by presence so a declared function is enforced
  on every run. `tag-axis-isolation` makes a partition — a module, a bounded
  context, a slice, a service — enforceable without one constraint row per
  partition.
  ([concepts/fitness-functions.md](../concepts/fitness-functions.md),
  [usage/fitness.md](../usage/fitness.md))
- **Custom rules under one contract.** A workspace declares its own rules as
  committed WebAssembly artifacts in the policy's `customRules` list — written
  in any language whose toolchain emits a no-import core-wasm module, judged
  by the same deterministic engine over the same observed facts, folded into
  `check` by presence with verdicts in the same four-state vocabulary, and
  loud on every failure path. Four SDKs ship from this repository on the same
  version chain — Rust, Go (TinyGo's freestanding target), TypeScript-syntax
  AssemblyScript, and Python (a RustPython carrier) — each proven by a
  committed reference artifact whose verdicts are byte-identical across all
  four, with each build story's measured limits declared in its package
  ([adr/0002](../adr/0002-custom-rules-one-contract.md) records the staging).
  ([concepts/custom-rules.md](../concepts/custom-rules.md),
  [reference/custom-rules.md](../reference/custom-rules.md))
- **Architecture planning facts for agents.** `context` and `impact` answer the
  questions an agent asks before and during a change, in machine-readable form;
  `explain` explains a finding after it is reported.
  ([concepts/agentic-development.md](../concepts/agentic-development.md))
- **Architecture intent as a machine-readable contract.** The boundary config
  is the declared intent: boundaries, allowed and forbidden relationships, and
  the constraints a workspace states about its own structure. Intent is
  validated against the observed architecture with no AI-generated intent and
  no semantic inference.
  ([concepts/boundaries.md](../concepts/boundaries.md))
- **A stated and gated `schemaVersion` promise.** The JSON envelope's field
  names and its version are a public contract said out loud where consumers
  read it, and held by a gate rather than by discipline: every command's
  envelope is reduced to a field roster and compared against a recorded
  snapshot in both directions, over a command list taken from the CLI's own
  table so a command added later cannot ship an unmeasured shape.
  ([reference/json-output.md](../reference/json-output.md))
- **Agentic governance.** The five `arch-*` skills teach agents when to ask the
  authority and how to read its answers; Claude Code, Codex and opencode run
  the same editor gates; the repository dogfoods its own enforcer in CI.
  ([skills/overview.md](../skills/overview.md),
  [architecture-authority.md](architecture-authority.md))

## The maturity ladder

One product, one development line, one ladder. The stages below are
**maturity gates on `main`** — not versions, not generations: no gate is a
1.x or 2.x line, a branch, a tag series, or a second contract, and passing a
gate never splits the product. The order is the commitment; the dates are
not. [architecture-authority.md](architecture-authority.md) owns the
abstractions the gates are named for, and each gate says what ships today
versus what the gate itself must add.

1. **Harden the deterministic authority core.** The verdict, the exit-code
   contract, the four-state vocabulary, coverage on every result, the
   provider-independent graph, the cross-language analyzers, and the
   conformance proof that holds them together. Most of this ships today; the
   gate is its hardening — conformance evidence broadened to real trees,
   parse limits held, determinism proven on workspaces nobody here designed.
   Every later gate stands on this one, and none of them retires it.
2. **Make architecture state first-class.** A workspace's architecture is
   one state — intent, observed reality, constraints, decisions, exceptions,
   evidence — changing through transitions, not a bag of adjacent commands.
   The mechanisms ship today (`graph` snapshots, `diff`, `history`,
   `trajectory`, `evolution`, `provenance`, `drift`); the gate is their
   consistency as one state model — one vocabulary, one evidence contract,
   one provenance story across all of them.
3. **Deepen architecture reconciliation.** The gap between intent and
   reality identified and classified element by element, so every difference
   becomes a decision. `reconcile`, `change`, `discover`'s proposal-only
   candidates and the waiver lifecycle ship today; the gate is depth —
   finer classification of the gap, and a decision path (fix, waive,
   re-declare) for every difference reconciliation can find.
4. **Broaden architecture change context and impact.** Before and during a
   change: which boundaries are affected, which constraints and recorded
   decisions are in play, what the blast radius is. `context`, `impact`,
   `delta` and `explain` ship today; the gate is breadth — the questions an
   agent or a reviewer asks before touching a boundary, answered in
   machine-readable form every time.
5. **Add the three architecture-intelligence capabilities, in order.** The
   layer that reads, evaluates and explains on top of the core — first
   **Architectural Impact Analysis**, then **Scenario Evaluation**, then the
   **Evidence-Grounded Architectural Advisor**, each gated by the one before
   it (see the section below). Optional and later by design, and each
   capability arrives through the door
   [architecture-authority.md](architecture-authority.md) puts in front of
   the layer, and none is required by the gates above.
6. **Close the agentic feedback loop.** An agent draws its architectural
   context from Archkeep, makes the change inside it, and Archkeep verifies
   and reconciles the result deterministically — the loop closed by the
   authority, never by the agent's own judgment. The `arch-*` skills, the
   MCP tools and the read-only command set are the loop's shape today; the
   gate is the loop running end to end without a human assembling the
   pieces.

Gates 1–4 are the foundation stable 1.0 stands on. Gates 5–6 are later
maturity on the same line: they follow stable 1.0, they never fork it, and
nothing in them holds the foundation hostage.

## The road to stable 1.0

Stable 1.0 is not "enough features shipped". It is the point where the four
foundation gates — the hardened authority core, first-class architecture
state, deepened reconciliation, broadened change context — hold every
property that makes them an official foundation: **deterministic**,
**explainable**, **reproducible**, **provenance-complete**,
**provider-independent**, **cross-language**, **conformance-hardened**, and
quiet long enough to be trusted with a stability promise. The intelligence
capabilities of gate 5 and the full agentic loop of gate 6 are deliberately
absent from that list: they extend a finished foundation rather than block
it, and no capability on those gates may hold the deterministic authority
hostage by being made a prerequisite of it.

Almost everything the foundation needs is already implemented and listed
above. What remains before a **stable 1.0** is hardening of the proof, not a
new feature list — one item, and it is evidence rather than code:

Stable 1.0 is approached through a release candidate, named by one
`Release-As:` commit when the conditions below read met — the 2026-08-28
candidates are parked and the release line returned to 0.x in the interim
(maintainer decision, 2026-08-29). The conditions below decide when the
contract stops being a candidate and becomes the version that holds.
[docs/development/release.md](../development/release.md#release-stages-the-0x-line-and-the-parked-candidate)
owns the mechanics.

- **Breadth of conformance evidence.** The differential against
  `@nx/enforce-module-boundaries` runs over real public workspaces, weekly and
  on demand, as a non-required check that is still treated as a regression when
  it goes red; more real trees is the remaining gap, not a missing feature. A
  second lane beside it measures what the Go, Rust and Python analyzers read on
  real repositories, where no upstream exists to disagree with — the languages
  the differential structurally cannot cover.
  ([development/testing.md](../development/testing.md))

The VS Code marketplace listing is deliberately **not** on that list. The
client exists, the `.vsix` attaches to every release, and the publisher
account exists; the marketplace carries no prerelease versions, so the
listing starts at the stable cut
([integrations/vscode.md](../integrations/vscode.md) owns that status) —
and 1.0 does not wait for it.

### What 1.0 waits for, and how each condition is read

The item above is the remaining work. These four are how the project knows it
is done — conditions rather than a date, in keeping with this document's
refusals, and each read off something that already runs rather than off
anyone's judgement of readiness. A fifth stood here until the `schemaVersion`
promise was both stated and gated; it is listed among the shipped capabilities
above rather than deleted, because a condition that was met is part of how the
project got here.

The first three exist because the ways this project can be wrong are not
symmetric. A feature list can be finished by writing code; a claim that the
engine is stable can only be finished by the engine failing to surprise anyone
over a stretch of time in which it had the chance to.

1. **The real-tree differential green, run after run.** Not one green run — a
   run of them, on the weekly schedule, with no red in between that was not a
   genuine conformance finding. One green run says the lane works; a series says
   the engine and upstream have stopped disagreeing in ways nobody predicted.
2. **A workspace outside this repository running `check` as a blocking gate.**
   Self-enforcement (`AGENTS.md`, "The repository's own module boundaries")
   proves the tool runs on a tree whose vocabulary it does not know. It cannot
   prove what a tree nobody here designed does to it. Until some other
   repository has failed a build on a Archkeep verdict and been right to, the
   parse limits are a list of shapes that were imagined rather than met.
   [gate-attestation.md](../reference/gate-attestation.md) is the evidence
   shape such a repository publishes, and what readiness accepts for this row.
3. **A quiet stretch in what an unchanged workspace is told.** `AGENTS.md`
   makes a change to what is reported on an unchanged workspace a breaking
   change; 1.0 is the version where that promise starts costing something. So
   the last condition before it is a stretch of commits during which no fix
   changed a verdict on a tree that did not change — measured from the log,
   which names each such fix, not from memory.
4. **Releases that land without a hand on them.** Tag, npm, and the attached
   `.vsix` agreeing, more than once in a row. The 0.5.0 tag that npm never
   received is the failure this condition exists to have stopped happening.

`scripts/check-readiness.mjs` is what reads these four rather than anyone
remembering them — `pnpm readiness` prints one row each, and says `unmeasured`
for the two whose evidence lives outside this repository rather than guessing.
The fifth condition sitting here for six releases after it was met is the
failure that script exists to have stopped happening.

None of the four is a feature, and that is the point: what separates 0.x from
1.0 here is evidence, and evidence is something the project accumulates rather
than something it implements.

## Later maturity: architecture intelligence, in three capabilities

Gate 5 of the ladder, and "optional" is part of its name: this is later
maturity on the same development line — not a next product, not a second
platform, and not a stage the foundation waits for. It extends the
deterministic core with a different relationship to the architecture it
already governs: **reading, evaluating and explaining**, on top of — never in
place of — the checking and judging.

This section names the direction as exactly three capabilities, in a fixed
order, each gated by the one before it. The gating is the whole design:
nothing here is a dated promise, and each phase has an explicit exit
criterion that must already hold before the next one starts. The three are,
by user value rather than by an "AI generation" label:

1. **Architectural Impact Analysis** — given an architectural or code
   change, state which architecture entities, boundaries, dependencies,
   Decisions, constraints, findings and debt are affected, each with the
   provenance and evidence the claim rests on.
2. **Scenario Evaluation** — evaluate a hypothetical architectural change
   against a base revision without mutating the repository or recording a
   real evolution event, reusing the deterministic impact and governance
   evaluation to report which consequences would be observable. Explicitly
   not a runtime or system simulation: no latency, throughput, CPU, memory,
   availability or business-risk prediction.
3. **Evidence-Grounded Architectural Advisor** — a reasoning and advisory
   layer that explains architecture and governance findings and lays out
   options and trade-offs, grounded in canonical Archkeep facts, Intent,
   Decisions, Constraints, Evidence, Evolution history and Scenario results.
   It never becomes an authority, never decides architecture, never turns a
   proposal into a Decision by itself, and marks every factual claim as
   evidence-traced or as inference/uncertainty.

Each of the three is a separate contract document that owns its
implementation shape:

- [Impact analysis](impact-analysis.md) — input/output, diff semantics, the
  direct/indirect/governance impact split, provenance, coverage and
  unsupported cases, and why impact is never risk.
- [Scenario evaluation](scenario-evaluation.md) — base revision, hypothetical
  changes, virtual isolation from canonical history, deterministic
  re-evaluation, current-versus-scenario comparison, and why a Scenario is
  never a Decision.
- [Evidence-grounded advisor](evidence-grounded-advisor.md) — the evidence
  context a reasoning layer reads, FACT versus INFERENCE, uncertainty,
  provider abstraction, prompt/context boundaries, failure behavior, and why
  the AI has no authority.

### Gate 5, narrowed

The maturity-ladder's gate 5 — "add the intelligence and proposal
capabilities" — resolves into these three, in this order. The order is a
dependency, not a preference:

- **Impact Analysis first.** It is the substrate the other two read, and it
  is mostly deterministic hardening of what already ships: `impact`
  (reverse reachability with constraint context), the `EvolutionEvent`'s
  `affected` shape (projects, boundaries, constraints, decisions), `delta`,
  `diff`, `debt` and the decision chain (`decisions`, `adr`, provenance).
  The gate is that a change to any architecture entity reliably enumerates
  every affected entity, decision and governance artifact with evidence — on
  real trees, not only on fixtures.
- **Scenario Evaluation only when impact is stable and a real use case
  exists.** A hypothetical change is evaluated by re-running the deterministic
  impact and governance path in a virtual, non-mutating mode over a base
  revision — so it needs the impact primitive to be trustworthy first. No
  Scenario is ever written to canonical history, and none is a Decision.
- **Evidence-Grounded Advisor only when the two deterministic layers are
  trustworthy.** It reads canonical facts and Scenario results and produces
  explanations, options and inferences — expendable by construction, never
  load-bearing for a verdict.

Nothing ahead weakens what ships today: every capability sits on top of the
deterministic core, never in place of it, and each must answer the five
questions [architecture-authority.md](architecture-authority.md) puts to the
layer before it is built. That file also owns the vocabulary this section
uses — **verdict**, **evidence**, **prediction**, **proposal**, **judgment** —
and the boundary none of the three crosses.

### The workflow the three capabilities serve

The three capabilities exist for one loop, and the loop keeps the boundary
visible. A developer proposes a change; impact names what it touches;
scenarios evaluate one or more paths against the current architecture; the
advisor explains the evidence and the options; a human makes a Decision; the
change is implemented; Archkeep validates the evolution. What is marked
**shipped** already exists as the deterministic substrate; what is marked
**future** is the summit of a gated capability:

1. **Propose the change** (human or agent) — the working tree or a
   hypothetical description. _Shipped:_ the tree.
2. **Identify impact** — `impact`, `delta`, `diff`, `debt`, the decision
   chain. _Shipped:_ reverse reachability, `context --plan`, `EvolutionEvent
affected`. _Future:_ full Architectural Impact Analysis enumerating every
   governed entity with evidence.
3. **Evaluate the scenario** — a hypothetical path re-evaluated against a
   base revision. _Future:_ Scenario Evaluation. Never a simulation, never a
   Decision, never written to history.
4. **Explain the evidence and options** — the advisor reads canonical facts
   and scenario results, marks FACT from INFERENCE, and lays out options.
   _Future:_ Evidence-Grounded Advisor. Never authoritative, never edits the
   law.
5. **Decide** — a human accepts or refuses. A Decision becomes an ADR with a
   `decisionRef`. _Shipped:_ the Decision model and `decisions` chain.
6. **Implement** — the accepted change lands.
7. **Validate the evolution** — `check`, `fitness`, `drift`, `evolution`,
   `history`, `trajectory`; a real `EvolutionEvent` records it. _Shipped:_ a
   working deterministic audience.

The loop is the story of where the three capabilities sit and why a Scenario
and a Decision are never the same event.

## What this roadmap refuses

- **Dates.** A date on an open-source roadmap is a promise nobody is paid to
  keep. Order is the commitment; time is not.
- **A feature list.** Features live in issues, where they can be discussed,
  rejected and closed without this document lying in the meantime.
- **A phase 3.** When the capabilities above are real, what comes after them
  will be visible from there, and not before.
- **A second line, or a next generation.** The ladder is one development
  line: gates, not versions. Nothing here produces a 1.x line beside a 2.x
  line, a parallel `next` branch, or a second generation of the product — a
  proposal framed as a generation change is refused the way a proposal to
  move the authority is.
- **Moving the authority.** Any capability that would let an agent, a provider,
  a skill or CI decide whether an architecture is valid — rather than report
  whether it holds — is refused by the boundary in
  [architecture-authority.md](architecture-authority.md). The
  roadmap stages breadth and reading; it never stages that line.

### What the intelligence capabilities are not

The three capabilities above are bounded in what they will and will not
become. The following are explicit non-goals — not merely absent today, but
refused on boundary and architectural grounds:

- **ML-based architectural learning.** No statistical model, embedding
  space, or learned pattern library will drive any verdict, proposal or
  evaluation. The deterministic authority stays source-driven, not
  data-driven.
- **Autonomous architect.** No capability decides or executes
  architectural changes on its own. Every path toward mutation — whether
  migration, boundary edit, or constraint change — leads through a human
  accepting a proposal.
- **Optimizer.** No "find the best architecture" facility, no scoring
  function, no multi-objective ranking over hypothetical topologies.
  Archkeep evaluates and reports; it does not rank.
- **Full runtime simulation.** No model of what the architecture does at
  runtime — no load test, no latency prediction, no capacity model.
  The view is structural; runtime belongs to observability.
- **Generic architecture generation.** No facility that produces
  architecture from a description, a conversation, or a document. Archkeep
  governs an existing architecture; it does not author one.
- **Runtime prediction.** No forecasting of what will break at runtime,
  under what load, or at what scale. The structural view says what is
  connected and what is governed; runtime belongs elsewhere.
- **Autonomous migration planning or execution.** Scenarios are
  read-only evaluations. If the advisor recommends a migration path, a
  human still evaluates and applies it — Archkeep never executes a
  migration itself.
- **Vector or semantic memory for AI reasoning.** The advisor reads
  canonical Archkeep sources — graph, diff, delta, evolution, decisions,
  intent, evidence — not an embedding index. Uncertainty is labeled,
  never smoothed by similarity.
- **God-object architectural state.** Each capability reads from its
  own deterministic substrate. There is no unified mutable "architectural
  state" object that accumulates and conflates sources of truth — that
  shape is how the boundary becomes invisible.
