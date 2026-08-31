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
- **A semantic model that deliberately stops at the deterministic core.** The
  structural core and the wave-3 evolution model were re-audited adversarially
  (Phase 4, 2026-08-30) for ownership, data-flow, API, event and runtime
  semantic candidates; none met the authoritative-evidence gate, so none was
  built — the canonical data-flow (declared intent → observed evidence →
  deterministic verdict → event → report) holds with no shortcut.
  ([adr/0007-no-semantic-model-expansion.md](../adr/0007-no-semantic-model-expansion.md))

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
5. **Harden and broaden architectural impact context.** The layer that
   answers "what changes if I touch this" — not a prediction engine, but a
   descriptive impact model that grows in breadth and depth. `impact`,
   `context`, `delta`, and `explain` ship today; the gate is their breadth —
   more constraint dimensions surfaced (fitness functions, debt burden,
   decision lineage), deeper evidence bundles (what exactly a rule judged and
   why), and the full provenance chain from source to verdict. This gate
   hardens the _descriptive_ authority the next gate reads. It is not
   scenario evaluation, and it never assigns a score or a risk level.
   [architecture-authority.md](architecture-authority.md) owns the
   abstractions this gate feeds.
6. **Add deterministic scenario evaluation.** The capability to answer "if we
   apply hypothetical architectural change X to baseline revision R, how
   would the deterministic governance state change?" — reuses Impact's
   descriptive model as its substrate. The answer is a _delta against a
   counterfactual_, not a runtime simulation, a cost estimate, or a risk
   score. Each scenario evaluation produces a full diff of the governance
   state (violations, drift, debt, coverage), every row marked
   `hypothetical` so nothing looks like a real verdict. A scenario is
   never a decision; a decision lives in an ADR or a policy change, and
   scenario evaluation informs it without becoming it. This gate
   depends on gate 5 — impact breadth is the substrate scenario evaluates
   over — and requires gate 6 before gate 7 can use its output.
7. **Build the evidence-grounded architectural advisor.** A read-only advisor
   that explains architectural facts, inferences, uncertainties, and
   options — drawing from canonical evidence (gate 2 provenance), impact
   context (gate 5), and scenario evaluation (gate 6) — and never creates
   its own authority. The advisor:
   - Explains what is known, what is inferred, and what is uncertain.
   - Presents options ranked by tradeoffs, not by a score.
   - Links every claim to its source evidence and the deterministic check
     that proved it.
   - Never writes to the architecture state (no policy, no waiver, no ADR).
   - Never proposes changes autonomously — `discover --propose` already
     exists for that, and its proposals are always marked `proposed`.
     This gate depends on gates 5 and 6 for its substrate, and on the
     five `arch-*` skills' safety constraints for its agent-facing contract.
     It is the read-only consummation of the deterministic core, not a
     replacement for it.

Gates 1–4 are the foundation stable 1.0 stands on. Gates 5–7 are later
maturity on the same line: they follow stable 1.0, they never fork it, and
nothing in them holds the foundation hostage.

## The road to stable 1.0

Stable 1.0 is not "enough features shipped". It is the point where the four
foundation gates — the hardened authority core, first-class architecture
state, deepened reconciliation, broadened change context — hold every
property that makes them an official foundation: **deterministic**,
**explainable**, **reproducible**, **provenance-complete**,
**provider-independent**, **cross-language**, **conformance-hardened**, and
quiet long enough to be trusted with a stability promise. The impact-hardening,
scenario-evaluation and advisory capabilities of gates 5–7 are deliberately
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

## Later maturity: dependency chain — impact, scenario, advisor

Gates 5–7 of the ladder, and "optional" is part of their name: these are later
capabilities on the same development line — not a next product, not a second
platform, and not a stage the foundation waits for. They extend the
deterministic core with a different relationship to the architecture it
already governs: reading and predicting, on top of — never in place of — the
checking and judging.

The three gates form a **strict dependency chain**. Each gate's output is the
next gate's substrate. None can be built before its predecessor earns its gate
conditions.

---

### Gate 5: Impact hardening and breadth expansion

**Problem.** `impact`, `context`, `delta`, and `explain` ship today, but they
answer one question each. An agent or reviewer facing a change must assemble
the picture from several commands and manually reconcile their output. The
constraint dimensions are also narrow: fitness functions, debt burden, decision
lineage, and the full provenance chain are not surfaced in a single impact
report.

**User workflow.** An agent calls `archkeep context --plan <project>` and
receives a single document containing: every applicable constraint (tags,
boundaries, fitness functions), every recorded decision in scope, every
relevant debt entry, every active waiver, the current drift state, and the
provenance chain linking each row to its source. The same document is
machine-readable (JSON envelope) and human-readable (text). An agent or
reviewer does not call five commands to understand what a change touches.

**Scope.** Deeper constraint context — fitness gates surfaced alongside
boundary rules; decision lineage resolved in the same report; debt burden per
project; drift state as of the report's snapshot; the full evidence chain
(which source lines fed which verdict rows). New commands or flags may be
added; existing commands may gain output dimensions; no existing command's
contract shrinks.

**Non-goals.** No scenario evaluation (gate 6). No scores, risk levels, or
confidence estimates. No cross-repository queries. No predictive analysis of
any kind — this gate is descriptive only.

**Dependencies.** Gates 1–4 (foundation hardened, state first-class,
reconciliation deepened, context broadened). No new dependencies beyond those.

**Acceptance criteria.** A single `archkeep context --plan <project>` returns
every constraint dimension (tags, boundaries, fitness, decisions, debt, drift,
waivers, provenance) in one document. The output is deterministic and
reproducible. Every constraint row carries a source reference (file, line,
decision ID, or evidence bundle id). An agent consuming the JSON envelope can
make a governance-aware plan without calling any other command.

**Provenance requirements.** Every row in the impact report carries its origin:
which source file, which ADR, which check run, which snapshot. No "inferred"
or "estimated" row appears without a `provenance: inferred` tag and the
evidence that grounds the inference.

**Unsupported behavior.** The report never includes a recommendation (use the
agent's own reasoning for that). It never scores or ranks projects. It never
simulates a change before it is made.

**Exit gate.** All acceptance criteria hold on at least three real-world
workspaces (not only the test fixtures). `archkeep context --plan <project>`
returns deterministically for every project in those workspaces. No existing
command's output contract is weakened (the check-cli-docs-roster gate and the
JSON envelope schema are the contract).

---

### Gate 6: Deterministic scenario evaluation

**Problem.** Today, answering "what if we change project A's boundary" requires
a human or agent to make the change, run `check`, observe the result, and
undo. There is no safe, counterfactual evaluation path. The architecture
governance state is deterministic on real trees; it should also be
deterministic on hypothetical ones.

**User workflow.** An agent invokes a command like `archkeep scenario --base
HEAD --edit <patch-file>` (the command name and syntax are examples; the final
spelling is design work within this gate). The engine applies the hypothetical
edit to a copy of the graph (not the real tree), runs the full deterministic
pipeline (graph build, boundary check, drift, debt), and produces a diff
against the real governance state. Every row in the output is marked
`hypothetical`. The agent reads the diff and decides whether the change is
safe, never modifying the real architecture state.

**Scope.** A single command or subcommand that accepts a hypothetical
architectural change (as a graph edit, a policy edit, or both) and a base
revision, then produces the full deterministic governance diff: violations
(new, removed, unchanged), drift (new, removed, unchanged), debt changes,
coverage changes. The output is a delta against the real state, every row
marked `hypothetical`. Reuses the existing `graph`, `check`, `diff`, `drift`,
`debt` pipeline — no reimplementation of those engines.

**Non-goals.** No runtime simulation (no code execution, no performance
modelling). No cost estimation. No risk scoring. No probabilistic predictions.
No migration plan generation. No cross-repository scenarios. No "scenario
database" or scenario history — each evaluation is stateless and standalone.

**Dependencies.** Gate 5 (impact breadth is the substrate scenario evaluates
over). Gates 1–4 (the deterministic pipeline the scenario invokes). The
existing `graph`, `check`, `diff`, `drift`, `debt` commands — scenario
evaluation composes them rather than reimplementing them.

**Acceptance criteria.** A scenario evaluation produces a full governance diff
against the real state. Every output row is marked `hypothetical`. The
scenario never modifies the real architecture state (no snapshots captured, no
events recorded, no policies changed). Running the same scenario twice produces
the same diff. The exit code is always 0 for a successful evaluation (even if
the hypothetical change introduces violations — those are output, not errors).

**Provenance requirements.** Every `hypothetical` row carries a `scenarioId`
(deterministic from the input) and the base revision. The scenario command
does not produce events, snapshots, or evidence files — it is ephemeral by
design. Its output is the diff, and the diff is the record.

**Unsupported behavior.** The scenario command never creates a snapshot, never
writes to the history directory, never issues a waiver, never modifies policy,
and never captures an evolution event. It never proposes a change — the agent
reading its output decides.

**Exit gate.** Scenario evaluation produces the same diff for the same input
across three real-world workspaces. The `hypothetical` marking is present on
every output row and absent from every real command's output. No existing
command's contract is weakened. The scenario output format (the JSON envelope
or a new schema) passes the envelope-shape integration test.

---

### Gate 7: Evidence-grounded architectural advisor

**Problem.** An agent or human with a rich impact report (gate 5) and scenario
evaluation results (gate 6) still must interpret both and decide what to do.
The advisor is a read-only layer that explains architectural facts, inferences,
uncertainties, and options — drawing from canonical evidence and never creating
its own authority.

**User workflow.** An agent asks: "project B currently depends on project A
through these paths, which violate the boundary. What are my options?" The
advisor answers with: the relevant violations (from `check`), the relevant
intent and decisions (from `decisions` and `adr`), the relevant impact context
(from gate 5), and scenario evaluations for each option (from gate 6). Each
fact is linked to its source evidence. Options are presented with tradeoffs but
no score. The agent decides — the advisor never does.

**Scope.** A read-only command or subcommand that accepts a natural or
structured query about the architecture and returns: what is known (facts from
canonical commands), what is inferred (derived facts with provenance), what is
uncertain (gaps or ambiguities in the evidence), options with tradeoffs (each
option backed by a scenario evaluation when applicable). The advisor composes
existing commands — it does not implement its own analysis. Every claim links
to its source command and evidence row.

**Non-goals.** No autonomous proposal or decision-making. No scores, ratings,
or risk levels. No migration plans. No natural-language-only interface (the
structured JSON envelope is always available). No learning or adaptation across
sessions (each query is stateless). No agent personality or judgment. No
replacement for the five `arch-*` skills — the advisor informs, it does not
enforce.

**Dependencies.** Gate 5 (impact context as the substrate). Gate 6 (scenario
evaluation for "what if" questions). The five `arch-*` skills' safety
constraints define the agent-facing contract. The existing read-only command
set (`check`, `graph`, `diff`, `delta`, `drift`, `explain`, `context`,
`impact`, `decisions`, `adr`, `debt`, `history`, `report`, `provenance`).

**Acceptance criteria.** The advisor answers at least five distinct
architecture questions drawn from real-world scenarios (defined in the gate's
test plan). Every claim in an answer links to a source command and evidence
row. The advisor never produces output that could be mistaken for a verdict
(no exit codes, no "passed"/"failed" on architecture state). The advisor never
modifies any architecture state. Running the same query twice produces the same
answer. The advisor's JSON output is a valid envelope (or a defined extension
of it) that passes the envelope-shape integration test.

**Provenance requirements.** Every claim carries a `provenance` field with one
of: `measured` (from a deterministic command), `inferred` (derived with a
reproducible rule), `uncertain` (no conclusive evidence either way), or
`scenario` (from a scenario evaluation). Claims with `inferred` or `uncertain`
provenance are clearly marked as such in the human-readable output.

**Unsupported behavior.** The advisor never writes to the architecture state
(no policy, no waiver, no ADR, no snapshot, no event). It never proposes
changes autonomously — `discover --propose` already exists for that. It never
scores, ranks, or recommends a single best option. It never learns from past
queries. It never cross-references repositories. It never answers questions
about runtime behaviour, cost, team structure, or business risk.

**Exit gate.** Five distinct scenarios answered correctly and reproducibly. All
provenance rules enforced in the output. The JSON envelope test passes. No
existing command's contract is weakened. The `arch-*` skills remain the sole
authority on when to invoke governance — the advisor never replaces them.

---

Each of these three gates depends on its predecessor. Gate 5 broadens the
descriptive model gate 6 evaluates over. Gate 6 provides the counterfactual
deltas gate 7 composes into advisory answers. None skips a step. None creates
its own authority. All three remain optional — gates 1–4 earn stable 1.0
without them.

None of these is a platform promise — not a knowledge-graph product, not a
risk-prediction engine, not an autonomous migration planner, not an
architecture-intelligence platform — and none changes the authority boundary:
whatever they become, they remain predictions, proposals and judgments beside
verdicts, never verdicts themselves. This stage is a **direction, not a
commitment to implementation details**. Nothing in it is a dated promise, and
a prediction is allowed to be wrong where a verdict is not. Nothing ahead
weakens what ships today: every later capability sits on top of the
deterministic core, never in place of it — and each must answer the five
questions [architecture-authority.md](architecture-authority.md) puts to the
layer before it is built.

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
