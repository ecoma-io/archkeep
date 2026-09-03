# Evidence-Grounded Architectural Advisor

The third and final architecture-intelligence capability the
[roadmap](roadmap.md) gates. It depends on [impact analysis](impact-analysis.md)
**and** [scenario evaluation](scenario-evaluation.md) being trustworthy: the
advisor reads their output as its factual basis, so it opens only after both
deterministic layers have met their exit criteria. It is the one capability
where a model may enter the system — and it is the one where the boundary rules
are the tightest, because judgment is where "reads like authority but is not"
does the most damage.

## Problem statement

A developer or architect has a `check` verdict, an impact statement, and maybe
a scenario comparison — a pile of true facts. What is missing is the
**synthesis**: _why_ did this drift happen, _what are my options_, _what is
the trade-off between them_, given all the factual evidence Archkeep holds?
This is a reading and advisory task, and it is where a reasoning layer earns
its place — not by deciding anything, but by explaining the evidence a
human (or an agent) makes the real Decision from.

## User workflow

1. The advisor is asked a question over the workspace: "why is this boundary
   failing?", "what are my options to migrate off this project?", "which of
   these two scenarios is less disruptive to the decision chain?".
2. The advisor assembles an **Evidence Context** — the canonical facts relevant
   to the question: the graph, the relevant diffs and deltas, the evolution
   events, the decision chain, the impact statement, and (where relevant) the
   scenario comparisons.
3. The advisor explains: it separates **FACT** (every claim that traces to a
   canonical Archkeep output) from **INFERENCE** (connecting reasoning,
   heuristic judgment, or model output), and states uncertainty explicitly.
4. It lays out options and trade-offs — never a single verdict, never a
   directive, and never a change it applies.
5. A human reads the explanation and makes the real Decision. Nothing the
   advisor produces becomes a Decision on its own.

## The Evidence Context is a composition, not a new model

The advisor needs a defined input. That input is **explicitly a composition of
existing canonical outputs — never a new domain model, never an
ArchitecturalState, never a competing representation of the architecture**:

- the project **graph** snapshot;
- the **diff** and **delta** relevant to the question;
- the **evolution events** that produced the current state;
- the **decision chain** (`decisions`, `adr`, decision fitness) for any
  affected or binding Decision;
- the **impact statement** for the entity in question;
- any **scenario comparisons** the user asked about.

The Evidence Context is a view assembled from these, carrying the same
provenance and vocabulary they already have. It invents no new entity: asking
the advisor a question does not conjure a God-object architectural state that
conflates sources of truth. Each fact keeps its own source, resolution and
provenance. A context that cannot be assembled from canonical outputs (a
question about a project the graph cannot see, a decision that resolves to
nothing) is reported as such, never patched with inference.

## The AI has no authority

The advisor carries the tightest form of the boundary in
[architecture-authority.md](architecture-authority.md), which owns the full
argument. The rules, restated for this one capability:

- **It never decides.** No advisor output carries the authority of a verdict;
  no proposal it offers applies itself. Only a human accepting an option
  becomes a real Decision.
- **It is expendable by construction.** Removing the advisor must never change
  what the workspace is told its architecture is. Every verdict, exit code and
  diagnostic is computed, never guessed; the advisor only narrates and reasons
  over them.
- **It never edits the law.** Whatever it reads or suggests, the constraint
  table stays code in the workspace, reviewed like code.
- **FACT versus INFERENCE is mandatory, not stylistic.** A claim that traces to
  a canonical output is FACT and cites it; any connecting reasoning, heuristic
  or model output is INFERENCE and is labelled as such. A reader must always be
  able to tell which is which.
- **Uncertainty is stated, never smoothed.** When the advisor does not know —
  a question outside the determinism guarantee — it says so. A confident guess
  is the silent direction wearing a richer format.

## Scope

The advisor composes the deterministic outputs and reasons over them:

- **Explanation** — why a verdict is what it is, by reading the evidence
  behind it (the impact statement, the decision chain, the evolution events).
- **Option generation** — alternative paths that would address a finding,
  presented as proposals for a human to evaluate; never a directive.
- **Trade-off reasoning** — comparing options or scenarios by the structural
  facts they touch, with the impact and scenario evidence named.
- **Uncertainty declaration** — where a question needs runtime, business
  value, or information Archkeep does not hold, the advisor says so instead of
  fabricating.

## Non-goals

- **No authority, no autonomous action.** The advisor never decides, never
  forks, never edits the law, never executes a migration.
- **No learned or vector memory of the architecture.** The advisor reads
  canonical sources — graph, diff, delta, evolution, decisions, intent,
  evidence — **not** an embedding index. Uncertainty is labeled, never smoothed
  by similarity retrieval.
- **No "generate an architecture".** No facility that authors architecture
  from a conversation. Archkeep governs an existing architecture.
- **No risk or runtime scoring.** The advisor may reason over structural facts;
  it does not add latency, capacity or probability claims it cannot evidence.
- **No replacement for a verdict.** The advisor never substitutes a summary for
  the verdict an unchanged workspace would have received, and never makes a
  green result mean "probably fine".

## Dependencies

The advisor depends on both prior capabilities and on the foundation phases
(Authority, Evidence, Governance, and the Change Intelligence phase's shipped
substrate). Its testability rests on **its deterministic components producing the
same output from the same inputs**, and on **every model contribution being
labelled, its inputs recorded, and removably degrading the answer** rather than
invalidating it — the standard [architecture-authority.md](architecture-authority.md)
sets for any model on the layer.

## Acceptance criteria

The advisor exists when:

1. **Every factual claim is evidence-traced.** FACT claims cite their canonical
   source; INFERENCE claims are labelled and can be stripped without changing
   the underlying facts.
2. **Its Evidence Context is a composition with provenance.** The context the
   advisor reads names its constituent sources; an unassemblable context is
   reported, not patched.
3. **It is expendable.** Removing it changes no verdict, exit code or
   diagnostic; a test asserts the deterministic outputs are identical with and
   without the advisor.
4. **It offers, never imposes.** Options and trade-offs are proposals;
   acceptance and application are human (or agent-under-the-same-rules) acts.
5. **It fails loudly and states uncertainty.** A question it cannot answer from
   canonical facts is answered with "I don't know why / that is outside what
   Archkeep can evidence" rather than a plausible guess.

## Evidence and provenance requirements

An advisor output has two labelled classes, and the label is the contract:

- **FACT** — traces to a canonical Archkeep output (graph edge, diff hunk,
  evolution event, decision row, impact statement, scenario result). Cites it.
- **INFERENCE** — connecting reasoning, heuristic or model output. Labelled as
  inference/uncertainty, its inputs recorded, never presented as fact.

A reader can always redact the INFERENCE and recover the full set of facts the
advisor read — the advisor adds no fact of its own.

## Failure and unsupported semantics

- **Unassemblable context is a loud failure.** If the question cannot be
  grounded (no graph, unresolvable decision, unattributable base), the advisor
  says so rather than generating around the gap.
- **Model unavailability degrades, never invalidates.** If the reasoning model
  is absent, the advisor's deterministic components still answer what they can;
  the missing judgment is declared, not faked.
- **No authority leak.** Any output that reads like a verdict, proposes to
  self-apply, or edits the law is refused by construction.

## Test expectations

The silent direction for the advisor is **output that reads authoritative and
is not** — the exact erosion signal
[architecture-authority.md](architecture-authority.md) names. Tests must go red
when:

- A FACT claim lacks its citation.
- An INFERENCE claim is unlabelled (indistinguishable from fact).
- Removing the advisor changes a verdict, exit code, or diagnostic.
- The advisor's output implies a change it can apply.
- A question it cannot evidence is answered with a confident guess.

## Exit criterion for this phase

The advisor is acceptable when a reader can ask it a hard architecture
question, get an explanation whose facts are all evidence-traced and whose
reasoning is all labelled, strip the reasoning and lose nothing factual — and
be certain the advisor never decided anything. Until both deterministic layers
are trustworthy and the boundary is proven with tests, the explainable
deterministic core remains the honest answer.
