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
- **22 commands — `check`, `change`, `graph`, `diff`, `delta`, `discover`,
  `drift`, `reconcile`, `waivers`, `fitness`, `history`, `trajectory`,
  `evolution`,
  `health`, `report`, `debt`, `impact`, `explain`, `context`, `provenance`,
  `adr`** — each with
  output a script or an agent can consume without parsing prose. `history` records the
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
5. **Add the intelligence and proposal capabilities.** The layer that reads
   and predicts on top of the core. Optional and later by design — each
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

Stable 1.0 is approached through a release candidate: `1.0.0-rc.1` proposes
this contract as it stands; the conditions below decide when the same contract
stops being a candidate and becomes the version that holds.
[docs/development/release.md](../development/release.md#release-stages-the-100-rc1-candidate)
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

## Later maturity: the intelligence capabilities

Gate 5 of the ladder, and "optional" is part of its name: these are later
capabilities on the same development line — not a next product, not a second
platform, and not a stage the foundation waits for. They extend the
deterministic core with a different relationship to the architecture it
already governs: reading and predicting, on top of — never in place of — the
checking and judging.

- **Deeper architecture intent** — richer, machine-readable intent beyond the
  dependency constraint table.
- **Semantic architecture understanding** — the architecture as a meaning to be
  read, not only a graph to be checked.
- **Advanced drift detection** — drift that is anticipated or explained, on top
  of the deterministic drift already reported.
- **Architecture evolution intelligence** — how the architecture changed and
  why, on top of the deterministic snapshot-and-diff history already kept.
- **Change risk analysis and architectural impact prediction** — what a change
  is _likely_ to break, not only what it _demonstrably_ breaks.
- **Migration planning and architecture recommendations** — proposed paths,
  offered to a human to accept or refuse.
- **Cross-repository architecture intelligence** — reasoning across more
  than one repository at a time; an optional later reading, never a
  cross-repository authority or a universal architecture graph.
- **Agent-assisted architecture planning** — planning help that extends the
  facts already provided, while the agent remains the decision-maker.
- **Potentially AI-assisted reasoning** — where intelligence is not a verdict.

None of these is a platform promise — not a knowledge-graph product, not a
risk-prediction engine, not an autonomous migration planner, not an
architecture-intelligence platform — and none changes the authority
boundary: whatever they become, they remain predictions, proposals and
judgments beside verdicts, never verdicts themselves. This stage is a
**direction, not a commitment to implementation details**. The list above
names the headroom; nothing in it is a dated promise, and a prediction is
allowed to be wrong where a verdict is not. Nothing ahead weakens what ships
today: every intelligence capability sits on top of the deterministic core,
never in place of it — and each must answer the five questions
[architecture-authority.md](architecture-authority.md) puts to the layer
before it is built.

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
