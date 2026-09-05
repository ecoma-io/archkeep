# Roadmap

Where Archkeep is going, in stages of trust. This document owns the staged
direction — the maturity model that orders the capabilities, and in what order
the project earns them. It deliberately owns nothing finer than that:
individual features, their design and their sequencing live in GitHub issues
and milestones, because a roadmap that lists fifty features is a backlog
wearing a roadmap's name, and it is stale the day the first one ships.
[north-star.md](north-star.md) owns what "finished" means for the capabilities
named here and the refusals that hold on the way;
[architecture-authority.md](architecture-authority.md) owns the system
boundary every capability stays inside. When a claim in this file needs a
finish line, that file is the one that binds.

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

## The maturity model

One product, one development line, one maturity model. The phases below are
stages of trust on `main` — not versions, not generations: no phase is a 1.x
or 2.x line, a branch, a tag series, or a second contract, and completing a
phase never splits the product. The order is a hierarchy of trust, not a
schedule; the dates are not the commitment.
[architecture-authority.md](architecture-authority.md) owns the abstractions
the phases are named for, and each phase says what ships today versus what the
phase itself must add.

### Roadmap at a glance

| Phase                        | The question it answers                                            | Where it stands today                                                                   |
| ---------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| **1 · Authority**            | Does the enforcement core decide deterministically, and only once? | Foundation in place; the open work is evidence breadth against real trees               |
| **2 · Evidence**             | Is what the authority knows one coherent, reproducible state?      | In place and schema-gated; one-state coherence is the remaining consolidation           |
| **3 · Governance**           | Does every gap between intent and reality become a decision?       | Machinery shipped; depth — a decision path for every difference — is the gate           |
| **4 · Change Intelligence**  | Can change be anticipated from deterministic evidence?             | Deterministic substrate shipped; the three intelligence capabilities are later maturity |
| **5 · Agentic Architecture** | Can agents act inside the authority without becoming it?           | Every surface shipped; the closed loop is later maturity                                |

The hierarchy is the design: nothing later replaces anything earlier, every
later phase stands on the deterministic core the first phase hardens, and
neither of the last two may hold the foundation hostage — no capability in the
intelligence or agentic phases can become a prerequisite of stable 1.0.

### Capability trust levels

A capability's place here is a claim about trust, not about existence. A
command can exist and still not be something the project stakes 1.0 on. Four
words, defined once, used without synonym:

- **Hardened** — implemented, with semantics pinned by executable evidence on
  both sides of its contract: the behavior is regression-protected and the
  silent direction is covered by a test that goes red if a violation stops
  being reported.
- **Implemented** — the behavior ships and its contract is documented and
  tested, but the evidence is not yet both-sides deep, or breadth (real trees,
  real adopters) is still accumulating.
- **Emerging** — the deterministic substrate exists and is used, and the
  capability's intended depth is explicitly open work.
- **Future** — documented direction with a contract document of its own; not
  shipped, and never described here as if it were.

"Implemented" and "trusted" are different rows, and this document keeps them
different: what makes a capability hardened is the evidence behind it, and the
evidence bar is stated in [the section below](#the-road-to-stable-10).

`packages/archkeep/src/intent/intent-manifest.json` is the mechanical half of
this section: a machine-readable manifest that declares each load-bearing
v1.0 contract — provider independence, the empty-result invariant, snapshot
identity, determinism, provider parity, the check-agreement contract — with
its supporting evidence, classified by an explicit taxonomy in which only a
behavioral test, an end-to-end test, or an architecture test counts as proof.
It currently reads **13 contracts, all proven, zero unproven** — and a
contract that loses its evidence loses its row.

## Phase 1 — Authority

**Maturity goal.** The enforcement core decides, deterministically, and only
once.

**The invariant it protects.** Exactly one enforcement authority — `check` —
nothing that cannot look reports clean, and no verdict depends on which
provider, workspace shape, or language toolchain happened to be present.

**What it requires.**

- **The boundary law as a reviewed, machine-readable file.** One constraint
  table at the workspace root — four dialects accepted, one validator —
  extended by `architecture-intent.json` when a workspace declares it.
  ([concepts/boundaries.md](../concepts/boundaries.md),
  [concepts/policies.md](../concepts/policies.md)) — **hardened**.
- **The verdict system.** `check` is the gate and the only command holding all
  four exit codes; `fitness`, `delta` and `change` are verdict-carriers on
  their own questions under the same boundary law as `check`, and
  `rules verify` is the verdict-carrier for the rule catalog's
  **artifact-integrity** law — a different law, sharing only the status
  vocabulary and exit table; every other command only ever reads. The
  four-state vocabulary (`pass`/`fail`/`unknown`/`not_applicable`), coverage
  on every result, and `ok` refused over
  incomplete coverage — enforced in the envelope builder, not just documented.
  ([reference/exit-codes.md](../reference/exit-codes.md)) — **hardened**: the
  exit-code matrix drives all 24 commands on both sides of their exit
  contract, with a roster guard so an undecided command fails the suite.
- **Provider independence.** The engine discovers projects, builds the graph
  and judges boundaries from its own model; Nx and Moon are providers of that
  model, selected by one marker and refused loudly when the markers disagree.
  ([concepts/integrations.md](../concepts/integrations.md)) — **hardened**:
  an architecture test walks the core's imports, and the provider parity and
  differential suites assert identical verdicts across the three providers.
- **Static, cross-language analysis.** Eight languages read statically — Go,
  Rust, Python, TypeScript and JavaScript, Vue, Java, Kotlin, C#/.NET — under
  one frozen record contract, with no toolchain invoked to answer a question
  about imports and every parse limit documented, each limit erring toward
  naming text the file really contains rather than staying silent.
  ([reference/languages.md](../reference/languages.md)) — **implemented**, with
  one open hardening item: the real-tree evidence lane for the languages no
  upstream differential can reach (see [stable 1.0](#the-road-to-stable-10)).
- **Deterministic custom rules.** A workspace's own rules as committed
  WebAssembly artifacts — no imports, one contract, four SDKs (Rust, Go,
  AssemblyScript, Python) whose committed reference artifacts are required to
  answer identical verdicts through the real host. Folding into `check` by
  presence, in the same four-state vocabulary.
  ([concepts/custom-rules.md](../concepts/custom-rules.md)) — **implemented**,
  contract-hardened by the conformance suite; real-tree breadth still
  accumulating.
- **Law profiles and the preset packs.** Several boundary laws in one
  workspace, selected by name, stacked on a shared base, resolved loudly — and
  six architecture styles shipped as packs read by the same loader, validated
  by the same validator, enforced by the same path a workspace-written
  registry takes. ([concepts/profiles.md](../concepts/profiles.md),
  [usage/presets.md](../usage/presets.md)) — **implemented**.

**Evidence required.** Determinism sweeps (byte-identical reruns), the
conformance differential against `@nx/enforce-module-boundaries`, the
packed-artifact verification of the installed CLI, and the envelope-shape gate
that pins every command's JSON roster in both directions.

**Tests and conformance.** The differential (48 fixture workspaces, 125
probes, 100 projects — every upstream violation id triggered, and
weaker-than-upstream a defect by definition), five pinned real public
workspaces on a schedule, provider parity and differential suites, the
rule-SDK conformance gate, and the metamorphic suites that prove irrelevant
edits cannot move the facts.

**What you can do because of it.** Gate a build on `check` in any of the three
workspace shapes, in any shipped language, and have a green exit mean
"analyzed and clean".

**Depends on.** Nothing — this is the foundation every later phase stands on,
and none of them retires it.

**Exit criteria.**

- Verdicts are deterministic and byte-reproducible on unchanged trees.
- One enforcement authority; the verdict vocabulary is one vocabulary
  everywhere it appears.
- Coverage is explicit on every result; could-not-look never reads as clean.
- Provider parity is asserted, not assumed.
- All analyzers sit under one frozen record contract; parse limits are stated
  and tested.
- Custom rules stay deterministic under the wasm contract.

**Done means:** a consumer gates a build on `check` in any workspace shape and
any shipped language, and the differential and parity evidence behind that
verdict is green, run after run, on trees nobody here designed.

## Phase 2 — Evidence

**Maturity goal.** What the authority knows is one coherent, reproducible
state — not a bag of adjacent reports.

**The invariant it protects.** An architecture fact is reproducible and
attributable: snapshots are byte-identical across runs, provenance travels
with them, the envelope is schema-versioned, and no command fabricates
evidence over a tree it did not read.

**What it requires.**

- **Architecture snapshots with provenance.** `graph` produces a deterministic
  snapshot carrying the git origin of the run and a policy fingerprint naming
  the exact law that governed it; `diff` warns when a baseline cannot be
  attributed to the same repository.
  ([usage/graph.md](../usage/graph.md),
  [reference/json-output.md](../reference/json-output.md)) — **hardened**
  (snapshot identity is contract D in the intent manifest: byte-identical
  reruns, asserted end-to-end).
- **A stated and gated `schemaVersion` promise.** The envelope's field names
  and version are a public contract held by a gate, not by discipline: every
  command's envelope is reduced to a field roster and compared against a
  recorded snapshot in both directions, over a command list taken from the
  CLI's own table.
  ([reference/json-output.md](../reference/json-output.md)) — **hardened**.
- **A meaningful architecture diff.** `diff` separates structural change from
  policy mismatch from rule impact — three different questions, never blended
  — and refuses an incomplete baseline.
  ([usage/diff.md](../usage/diff.md)) — **hardened** (contract F).
- **The temporal commands, each owning one question.** `delta` classifies how
  violations moved across a captured baseline — per-change rule impact, with
  one spelling for edge identity owned by `classifyEvolution`. `history`
  describes consecutive transitions across captured snapshots; `trajectory`
  aggregates that record into signal counts and churn (facts that moved, never
  a score); `evolution` reads it across a Git revision range, so "at which
  commit did this first appear" is answered from analyzed trees.
  ([usage/history.md](../usage/history.md),
  [usage/trajectory.md](../usage/trajectory.md),
  [usage/evolution.md](../usage/evolution.md)) — **implemented**; the
  evolution event model was re-audited and its soundness gaps closed in
  2026-08, and the identity spelling was unified to one.
- **Coverage as semantics.** `coverage.complete` true only when `notAnalyzed`
  is empty — enforced, not correlated; whole-file failures, site-level blind
  spots, and out-of-verdict coverage gaps are three distinct reported shapes,
  never folded into clean.
  ([reference/json-output.md](../reference/json-output.md)) — **hardened**.

**Evidence required.** Byte-identical determinism sweeps over snapshots and
every temporal command; the schema-roster gate; the refusal of incomplete
baselines; provenance fields on every governance row.

**Tests and conformance.** Determinism end-to-end suites, the diff/delta
envelope gates, and the structural-refusal suites that pin every
could-not-attribute, could-not-read path as exit 3 rather than an empty result.

**What you can do because of it.** Capture a snapshot, come back months later,
and get the same diff, history, and evolution answers byte-for-byte — each
temporal command answering a different question about the same recorded state.

**Depends on.** [Phase 1](#phase-1--authority) — evidence about architecture
is only as trustworthy as the verdict core that produces it.

**Exit criteria.**

- Snapshots are byte-identical across runs and versions of the tree.
- Every evidence artifact is attributable: provenance on governance rows, a
  fingerprint naming the law.
- The temporal semantics stay separate: structural diff ≠ policy mismatch ≠
  rule impact ≠ drift ≠ proposal — no command answers another's question.
- Nothing produces evidence over an unread tree; every path that cannot read
  says so loudly.

**Done means:** a snapshot captured today still reproduces its diff, history
and evolution answers byte-for-byte after months of `main` moving — and no
command's answer depends on another command's vocabulary.

## Phase 3 — Governance

**Maturity goal.** Every gap between intent and reality becomes a decision —
fix, waive, or re-declare — recorded where the repository can see it.

**The invariant it protects.** `check` remains the only enforcement authority.
The governance artifacts — ADR, Decision, Waiver, fitness — explain, record,
and constrain; none of them is a second authority, and none of them can make
an unchanged workspace's verdict move.

**What it requires.**

- **Intent as a machine-readable contract.** `architecture-intent.json`
  declares named boundaries, forbidden and allowed relationships, judged by a
  pure, provider-neutral judge; a boundary that matches no observed project
  reads as no-verdict loudly, never as "intent passes".
  ([reference/architecture-intent.md](../reference/architecture-intent.md)) —
  **implemented**.
- **Drift as a descriptive face.** `drift` compares observed against declared
  and never exits 1 on its own; `check` folds it in by presence, so the
  authority still enforces what drift reports.
  ([concepts/drift.md](../concepts/drift.md)) — **implemented** (contract M in
  the intent manifest: clean still states its comparison facts, and every
  could-not-judge path is loud).
- **Reconciliation and proposal-only candidates.** `reconcile` classifies the
  gap element by element; under `--propose` it emits ranked candidates marked
  `proposed` and `notAuthoritative` — never written to the intent file. Same
  for `discover --propose`.
  ([concepts/reconciliation.md](../concepts/reconciliation.md)) —
  **implemented**.
- **The waiver lifecycle.** A row with a deadline keeps the violation visible
  as accepted until the term lapses — and then re-asserts itself loudly;
  a permanent acceptance is a different row shape with a different review
  story. ([concepts/waivers.md](../concepts/waivers.md)) — **implemented**.
- **Decisions that ground constraints.** A constraint row may cite an ADR via
  `decisionRef`; a citation that resolves to nothing is `unknown`, never a
  pass. `decisions` walks the full chain behind one recorded decision.
  ([concepts/adr.md](../concepts/adr.md)) — **implemented**.
- **Fitness functions.** Declared predicates — cycle-free graphs, coverage
  floors, tag-axis partitions — judged deterministically against the same
  observed facts `check` reads, folded into `check` by presence. A failing
  function is a finding, not a print job.
  ([concepts/fitness-functions.md](../concepts/fitness-functions.md)) —
  **implemented**.
- **Change intents.** A per-change declaration of expected architectural
  consequences, reconciled against the actual delta; undeclared material
  changes are findings.
  ([usage/change.md](../usage/change.md)) — **implemented**.
- **The aging surfaces.** `debt` ages waivers, gaps and drift across
  snapshots; `health` reports metrics that say `unknown` rather than zero when
  they cannot be computed; `report` composes health, waivers, fitness, the
  decision registry and provenance into one governance document under one
  resolved law. ([usage/debt.md](../usage/debt.md),
  [usage/report.md](../usage/report.md)) — **implemented**.
- **Reconciliation depth.** Finer classification of the gap, and a decision
  path — fix, waive, re-declare — for every difference reconciliation can
  find. The machinery above is this phase's substrate; **depth is the phase's
  open work** — **emerging**.

**Evidence required.** Waiver expiry and permanent-row behavior tested on both
sides; `decisionRef` resolution and its unknown path tested; proposal
non-authority asserted (the intent file stays byte-identical); fitness folded
into `check` end-to-end.

**Tests and conformance.** The governance suites over waiver, fitness,
decision-chain and change-intent behavior; the envelope gates for each
governance command; and the soundness suites that pin "a citation that resolves
to nothing is unknown, never clean".

**What you can do because of it.** Answer any difference the tool reports with
a tracked decision — a fix, a dated waiver, or a re-declared boundary — each a
reviewed diff rather than a conversation.

**Depends on.** [Phase 1](#phase-1--authority) (governance artifacts may never
become a second authority) and [Phase 2](#phase-2--evidence) (a decision is
only as good as the evidence it cites).

**Exit criteria.**

- Every reconciliation finding carries a decision path: fix, waive, or
  re-declare.
- The waiver lifecycle is loud at both ends: acceptance visible, expiry
  re-asserting.
- No governance artifact creates a second enforcement authority, and the
  intent file is byte-identical after every proposal run.
- A citation that resolves to nothing reports `unknown`, never a pass.

**Done means:** any difference between declared and observed architecture can
be answered by fix, waive, or re-declare — and each answer lands as a reviewed
diff the repository can enforce.

## Phase 4 — Change Intelligence

**Maturity goal.** Change anticipated from deterministic evidence — before it
lands and before it is real — never guessed.

**The invariant it protects.** Evidence and verdicts are deterministic and
authoritative; predictions, proposals and judgments are not, and are marked as
such wherever they appear. The intelligence layer reads the deterministic
core; it never sits inside a verdict, never alters one, and a scenario is
hypothetical — it cannot mutate architecture state, record history, or become
a Decision or a Verdict without an explicit human governance step.

**What it requires.**

- **The deterministic substrate — shipped.** `impact` names what depends on
  what (reverse reachability, deterministic by contract G); `context --plan`
  hands the governing constraints to an agent before it edits; `explain`
  returns the full judgment for one import site; `delta`'s rule impact names
  which rules a change moved; and `scenario` evaluates a hypothetical change
  as a read-only projection marked `virtual` and `notAuthoritative`.
  ([concepts/agentic-development.md](../concepts/agentic-development.md)) —
  **implemented**, under the check-agreement contract (J in the intent
  manifest): wherever these commands evaluate, their verdicts agree with
  `check`, and every narrowing (per-edge verdicts cover `depConstraints`
  only) is disclosed where an agent will read it.
- **Architectural Impact Analysis** — a change to any architecture entity
  reliably enumerates every affected entity, decision and governance artifact
  with evidence, on real trees. The substrate is mostly built; the gate is
  breadth and evidence on trees nobody here designed. — **emerging**, the
  first of the three intelligence capabilities.
- **Scenario Evaluation** — a hypothetical change re-evaluated against a base
  revision in virtual, non-mutating isolation; explicitly not a runtime
  simulation. Gated on impact being stable and a real use case existing.
  ([scenario-evaluation.md](scenario-evaluation.md)) — **future**, and the
  shipped `scenario` command is its deterministic projection, not the
  capability at intended maturity.
- **Evidence-Grounded Architectural Advisor** — explanations, options and
  trade-offs laid over canonical facts, marked FACT from INFERENCE,
  expendable by construction, never load-bearing for a verdict. Gated on both
  deterministic layers being trustworthy.
  ([evidence-grounded-advisor.md](evidence-grounded-advisor.md)) —
  **future**.

**Evidence required.** The check-agreement contract asserted wherever a
command evaluates; every narrowing disclosed in output; scenario output
carrying `virtual` and `notAuthoritative` on every shape it prints.

**Tests and conformance.** The intent-manifest contracts G, H, I, J and their
behavioral, end-to-end and architecture tests; the disclosure tests that keep
the depConstraints narrowing visible.

**What you can do because of it.** Ask the before-change questions — what does
this touch, which constraints are in play, what would this hypothetical move —
in machine-readable form, with every answer agreeing with the authority.

**Depends on.** [Phase 2](#phase-2--evidence) — intelligence over architecture
is only as trustworthy as the evidence state it reads — and
[Phase 3](#phase-3--governance) for the decision semantics it must not bypass.

**Exit criteria.**

- Wherever a command evaluates, its verdicts agree with `check`, and every
  narrowing is disclosed where the consumer reads.
- Scenarios never mutate state, never record history, never become a Decision
  or a Verdict without a human governance step.
- Every intelligence output is marked as evidence-traced fact or as
  inference — and no intelligence output carries an exit code.

**Done means:** the before-change questions are answered in machine-readable
form by commands whose verdicts provably agree with `check` — and the three
intelligence capabilities, when they arrive, arrive through the boundary
[architecture-authority.md](architecture-authority.md) puts in front of the
layer, each gated by the one before it.

## Phase 5 — Agentic Architecture

**Maturity goal.** Agents operate inside the authority — they consume it, and
they never become it.

**The invariant it protects.** Agent surfaces consume the same authority
humans and CI consume: no agent-facing tool accepts a weaker boundary config,
no skill teaches an agent to edit policy to reach green, and the loop closes
through the authority's verdict, never through the agent's own judgment.

**What it requires.**

- **Agent-facing tools over one engine.** An MCP server exposing nine
  read-only tools — context before editing, the authoritative check, impact,
  drift, explain, graph, history, a proposal mode carrying
  `requiresApproval: true`, and a scenario tool — every tool calling the
  engine's own command layer in process, so an agent sees the same envelope a
  pipeline sees. No tool writes, and no tool accepts a weaker law.
  ([integrations/mcp.md](../integrations/mcp.md)) — **implemented**.
- **Skills that teach the protocol.** Five host-independent `arch-*` skills —
  read the constraints, change inside them, check, report evidence — never
  modify policy to reach green, validated by a repository gate so a skill
  cannot drift from the roster.
  ([skills/overview.md](../skills/overview.md)) — **implemented**.
- **Editor surfaces with the one invariant.** A language server whose empty
  diagnostic list means "no violation", and nothing else; a VS Code client
  that ships no analysis of its own, resolves the workspace's server, and
  routes the polyglot languages to it — TS/JS deliberately left to the
  workspace's ESLint setup.
  ([integrations/vscode.md](../integrations/vscode.md)) — **implemented**.
- **The repository's own enforcement, in CI.** This repository runs its own
  checker on its own tree, and the agent harnesses (Claude Code, Codex,
  opencode) run the same editor gates. Self-enforcement proves the tool runs
  on a tree whose vocabulary it does not know.
  ([development/repository.md](../development/repository.md)) —
  **implemented**.
- **External workspaces gating on it.** The readiness condition is
  attestation-shaped: a repository outside this one runs `check` as a blocking
  gate and publishes the evidence shape
  [gate-attestation.md](../reference/gate-attestation.md) defines. Adoption
  exists; **attested readiness is the open half** — **emerging**.
- **The closed agentic loop.** Declare → context → change → observe →
  evidence → verdict → CI, running end to end on a tree nobody here designed
  without a human assembling the pieces. **future** — the phase's summit, on
  the same line, never a fork.

**Evidence required.** The no-override property asserted on every agent
surface; the skills gate; the MCP server composing the engine's own `./commands`
layer rather than a second implementation; the attestation evidence shape
verified, not asserted.

**Tests and conformance.** The MCP composition suites, the skills gate, the
LSP invariant suites (empty diagnostics only from two named places), and the
packed-artifact verification that installs the CLI the way a consumer does.

**What you can do because of it.** Point a coding agent at a governed
repository and have it read the constraints first, change inside them, verify
with the same `check` CI uses, and report evidence — with no path by which the
agent weakens the law it is judged by.

**Depends on.** All four earlier phases — an agent surface is a consumer of
authority, evidence, governance semantics and change intelligence, and it is
the one layer that must never be mistaken for any of them.

**Exit criteria.**

- Every agent surface consumes the engine's own command layer and the same
  verdict vocabulary; no second implementation exists.
- No agent-facing tool accepts a weaker boundary config, and no skill teaches
  policy editing to reach green.
- The authority boundary holds for autonomous operation: proposals carry
  approval requirements, and declaring or changing intent stays a human,
  reviewed act.
- External adoption is attested, not anecdotal: the evidence shape is
  published and verified.

**Done means:** an agent can run the full loop — declare, context, change,
observe, evidence, verdict, CI — on a tree nobody here designed, with the
authority boundary held at every step, and the repository can see it happen
through published attestation.

## The road to stable 1.0

Stable 1.0 is not "enough features shipped". It is the point where the
foundation phases — **Authority**, **Evidence**, **Governance** — hold every
property that makes them an official foundation: **deterministic**,
**explainable**, **reproducible**, **provenance-complete**,
**provider-independent**, **cross-language**, **conformance-hardened**, and
quiet long enough to be trusted with a stability promise. The capabilities of
the Change Intelligence and Agentic phases are deliberately absent from that
list: they extend a finished foundation rather than block it, and no capability
in those phases may hold the deterministic authority hostage by being made a
prerequisite of it.

Almost everything the foundation needs is already implemented, and its
load-bearing claims are the intent manifest's contracts — the mechanical
Evidence-Complete gate [defined above](#capability-trust-levels). What
separates 0.x from 1.0 here is not
a missing feature; it is evidence, and evidence is something the project
accumulates rather than something it implements.

### The 1.0 exit criteria

The structural criteria are the phases' own: [Phase 1](#phase-1--authority)
and [Phase 2](#phase-2--evidence) exit criteria read met, and with them:

- **Exactly one enforcement authority.** `check` is the gate; `fitness`,
  `delta` and `change` are verdict-carriers on their own questions under the
  same boundary law, and `rules verify` is the bounded artifact-integrity
  verification surface for the rule catalog (it verifies rule artifacts, not
  the architecture — one law fewer, not one authority more); ADR, Decision,
  Waiver and fitness create no second authority.
- **Verdicts are deterministic and reproducible** — byte-identical output on
  unchanged trees, swept and asserted.
- **Verdicts are evidence-backed** — every verdict cites the constraint row,
  the recorded decision, or the provenance behind it, and the intent manifest's
  executable-proof bar holds for the contracts 1.0 leans on.
- **Coverage is explicit** — `ok` requires complete coverage, enforced in the
  envelope builder; unknown and incomplete analysis cannot masquerade as
  success.
- **Provider independence** — identical semantics across Nx, Moon and native,
  asserted by parity and differential suites, not assumed.
- **One analysis, one semantics** — language and analyzer differences never
  create competing verdict semantics: one frozen record contract, one judge,
  one envelope, and parse limits that err loud.
- **A coherent architecture state** — snapshots, diff, delta, history,
  trajectory, evolution and provenance answer from one state model, one
  vocabulary, one evidence contract.
- **Governance without second authorities** — fitness judged inside the
  enforcement model; proposals never decisions; scenarios hypothetical.
- **Custom rules preserve the contract** — wasm under one deterministic
  contract, conformance-gated across all four SDKs.
- **Intelligence cannot alter authoritative verdicts** — intelligence beside
  verdicts, never inside them, whatever the later phases ship.
- **Agent surfaces consume the same authority** — no override, no weaker law,
  no second implementation behind the agent-facing tools.
- **Load-bearing claims are Evidence-Complete** — the intent manifest's
  executable-proof taxonomy reads all-proven for every contract 1.0 rests on.

On top of the structural criteria sit four measurable conditions. The first
three exist because the ways this project can be wrong are not symmetric: a
feature list can be finished by writing code, but a claim that the engine is
stable can only be finished by the engine failing to surprise anyone over a
stretch of time in which it had the chance to.

1. **The real-tree differential green, run after run.** Not one green run — a
   run of them, on the weekly schedule, with no red in between that was not a
   genuine conformance finding. One green run says the lane works; a series
   says the engine and upstream have stopped disagreeing in ways nobody
   predicted.
2. **A workspace outside this repository running `check` as a blocking gate.**
   Self-enforcement proves the tool runs on a tree whose vocabulary it does
   not know. It cannot prove what a tree nobody here designed does to it.
   Until some other repository has failed a build on an Archkeep verdict and
   been right to, the parse limits are a list of shapes that were imagined
   rather than met.
   [gate-attestation.md](../reference/gate-attestation.md) is the evidence
   shape such a repository publishes, and what readiness accepts for this row.
3. **A quiet stretch in what an unchanged workspace is told.** The
   compatibility contract makes a change to what is reported on an unchanged
   workspace a breaking change; 1.0 is the version where that promise starts
   costing something. So the last condition before it is a stretch of commits
   during which no fix changed a verdict on a tree that did not change —
   measured from the log, which names each such fix, not from memory.
4. **Releases that land without a hand on them.** Tag, npm, and the attached
   `.vsix` agreeing, more than once in a row. The 0.5.0 tag that npm never
   received is the failure this condition exists to have stopped happening.

`scripts/check-readiness.mjs` is what reads these four rather than anyone
remembering them — `pnpm readiness` prints one row each, and says `unmeasured`
for the two whose evidence lives outside this repository rather than guessing.
`unmeasured` is not a failure and not a pass: it is the third state this
repository insists on everywhere else.

### One remaining evidence gap, named

The item below is the remaining _work_, as distinct from the conditions above
— which are _measurements_, not tasks:

- **Breadth of conformance evidence.** The differential against
  `@nx/enforce-module-boundaries` runs over real public workspaces, weekly and
  on demand; more real trees is the remaining gap, not a missing feature. A
  second lane beside it measures what the Go, Rust and Python analyzers read
  on real repositories, where no upstream exists to disagree with — the
  languages the differential structurally cannot cover.
  ([development/testing.md](../development/testing.md))

The VS Code marketplace listing is deliberately **not** on any of these lists.
The client exists, the `.vsix` attaches to every release, and the publisher
account exists; the marketplace carries no prerelease versions, so the listing
starts at the stable cut
([integrations/vscode.md](../integrations/vscode.md) owns that status) — and
1.0 does not wait for it.

### How 1.0 is approached

Stable 1.0 is approached through a release candidate, named by one
`Release-As:` commit when the conditions above read met — the 2026-08-28
candidates are parked and the release line returned to 0.x in the interim
(maintainer decision, 2026-08-29). The conditions decide when the contract
stops being a candidate and becomes the version that holds.
[docs/development/release.md](../development/release.md#release-stages-the-0x-line-and-the-parked-candidate)
owns the mechanics.

## Later maturity: architecture intelligence, in three capabilities

The Change Intelligence phase, and "optional" is part of its name: this is
later maturity on the same development line — not a next product, not a second
platform, and not a stage the foundation waits for. It extends the
deterministic core with a different relationship to the architecture it
already governs: **reading, evaluating and explaining**, on top of — never in
place of — the checking and judging.

This section names the direction as exactly three capabilities, in a fixed
order, each gated by the one before it. The gating is the whole design:
nothing here is a dated promise, and each capability has an explicit exit
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

### The three capabilities, narrowed

The Change Intelligence phase resolves into these three, in this order. The
order is a dependency, not a preference:

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
- **A second line, a next generation, a sequel.** The maturity model is one
  development line: phases, not versions. Nothing here produces a 1.x line
  beside a 2.x line, a parallel `next` branch, or a second generation of the
  product — a proposal framed as a generation change is refused the way a
  proposal to move the authority is.
- **Moving the authority.** Any capability that would let an agent, a provider,
  a skill or CI decide whether an architecture is valid — rather than report
  whether it holds — is refused by the boundary in
  [architecture-authority.md](architecture-authority.md). The
  roadmap stages breadth and reading; it never stages that line.
