# Scenario Evaluation

The second of the three architecture-intelligence capabilities the
[roadmap](roadmap.md) gates. It depends on [impact analysis](impact-analysis.md)
being trustworthy — a scenario is evaluated by re-running the deterministic
impact and governance path over a hypothetical change, so it can only be as
honest as the impact primitive it reuses. It opens only when the gating
criterion on the impact phase has been met.

## Problem statement

"Before I make this change, what would the architecture look like if I did?"
A developer or architect wants to evaluate one or more hypothetical
architectural changes — move this dependency, change this boundary row, split
this project — and see the structural and governance consequences, without
committing anything, and without recording anything in the canonical
evolution history.

Today Archkeep has no such surface. `delta`, `diff` and `change` compare real
revisions that exist. `discover --propose` and `reconcile --propose` describe
candidate changes but never evaluate the would-be state. There is no
"what-if": evaluating a change that is not yet real is exactly what the
intelligence layer adds, and it is the one capability where the risk of
implying more than it delivers is highest.

## User workflow

1. A developer describes a **hypothetical change** — a project dependency
   added or removed, a boundary row changed, a project split or merged, a
   constraint relaxed or tightened.
2. Archkeep names the **base revision** (a real, attributable state of the
   workspace) and computes the scenario's structural impact by re-running
   impact analysis and the governance evaluation (constraints, intent rows,
   decision bindings, fitness) _as if_ the change had been applied.
3. Archkeep reports what would be observable — which consequences are
   structural and derivable, and which are out of scope — under the law in
   effect.
4. The human compares the current state with one or more scenarios, reasons
   over the evidence, and either abandons the idea or proceeds to make a real
   Decision and implement it.

## What a Scenario is and is not

The single most important sentence in this contract: **a Scenario is never a
Decision.**

- A Scenario is a **virtual, read-only evaluation** of a hypothetical state.
  It is not written to canonical history, produces no `EvolutionEvent`, and
  mutates nothing.
- A real Decision is the record of a concluded transition — an ADR with a
  `decisionRef`, and an `EvolutionEvent` disposition recorded when the change
  actually lands. Only a human (or an agent under the same rules) accepting
  an option and implementing it produces a real Decision.
- The boundary is absolute: a scenario evaluation that wrote a real event, or
  whose proposal could self-apply, would blur "what could happen" into "what
  happened" — the exact silent direction this repository refuses.

Scenarios are **predictions and proposals** in the vocabulary of
[architecture-authority.md](architecture-authority.md): allowed to be wrong,
never folded into a verdict, and offered for a human to accept or refuse.

## Scope

Scenario Evaluation evaluates **deterministic structural and governance
consequences** by reusing the impact primitive and the same evidence the core
produces:

- Which projects, edges, boundaries and constraints the hypothetical change
  would touch (impact analysis).
- Which governance rows would newly apply or newly fail, and how decision
  bindings and their fitness would move.
- Which findings and debt entries would be introduced or resolved.
- A **current-versus-scenario comparison**, so the reader sees the delta the
  change would produce, not a bare hypothetical list.

The core mechanism is **deterministic re-evaluation over a base revision**: the
scenario's would-be state is derived by applying the hypothetical change to a
real, attributable base and running the existing checks, then labeling the
result as virtual. There is no new analysis authority and no second opinion.

## Non-goals — a Scenario is not a simulation

A Scenario is a structural and governance what-if. It is explicitly **not**:

- **A runtime or system simulation.** No model of execution, no latency,
  throughput, CPU, memory, availability or capacity claims. The view is
  structural; runtime belongs to observability.
- **A risk forecast.** No "how likely is this to break in production" number.
  Impact and scenarios say what is connected and what is governed; risk needs
  its own evidence.
- **An optimizer.** No ranking of scenarios by merit, no "best" answer, no
  scoring function. Scenarios are presented as comparable structural facts;
  a human applies priority.
- **A generator.** No facility that proposes scenarios from prose or
  description. A scenario is named by the developer; Archkeep evaluates it.
- **An autonomous migration planner.** A scenario may inform a migration, but
  Archkeep never plans or executes it autonomously — the human evaluates and
  applies.

## Dependencies

Scenario Evaluation is gated behind Impact Analysis. It also relies on the
foundation phases (Authority, Evidence, Governance) and the Change
Intelligence phase's shipped substrate, and on the proposal-only discipline
`discover --propose` / `reconcile --propose` already establish. The
`EvolutionEvent`'s `affected` and `classifications` shapes are reused for the
comparison, so a scenario delta speaks the same vocabulary as a concluded
evolution.

## Acceptance criteria

A scenario evaluation exists when:

1. **It is read-only and side-effect free.** No mutation of the workspace, no
   canonical history write, no `EvolutionEvent` emitted. The scenario's
   virtual status is part of its output.
2. **It names a real base revision.** A scenario always compares against an
   attributable state (a revision, a snapshot), never an in-memory guess.
3. **It reuses the deterministic path.** Consequences are derived by applying
   the hypothetical change to the base and re-running existing checks — no
   parallel analysis that could disagree with the core.
4. **It labels current-versus-scenario.** The reader sees the delta the change
   would produce, with the evidence for each would-be difference.
5. **It is deterministic and machine-readable.** Two runs over the same base
   and scenario produce identical output.
6. **It states its own limits.** Any consequence it does not evaluate
   (non-structural, out-of-scope rule classes, anything runtime) is named,
   never implied clean.

## Evidence and provenance requirements

Every scenario consequence is a labelled **prediction or proposal**:

- A structural fact derivable from the applied change traces to the base
  snapshot and the applied diff.
- A governance consequence traces to the constraint, intent row, decision
  binding or fitness gate it re-evaluated.
- Everything a scenario reports is `virtual: true` and `notAuthoritative` in
  the sense established by the `--propose` surfaces — the reader must not be
  able to confuse a scenario result with a real verdict.

## Failure and unsupported semantics

- **An unattributable base is a loud failure.** If the base revision cannot
  be attributed (mirroring `diff`'s warning when a baseline cannot be
  attributed to the same repository), the scenario refuses rather than
  guessing.
- **Incomplete evaluation is loud.** An unsupported rule class or an
  incomparable decision registry means the scenario says what it could not
  evaluate — never "the change is clean".
- **No scenario mutates.** Any proposed path that would self-apply is refused
  by construction; only a human accepting an option becomes a real Decision.

## Test expectations

The silent direction for a scenario is output that reads like a real verdict
or a real evolution record. Tests must go red when:

- A scenario output lacks its `virtual`/`notAuthoritative` label.
- A scenario appears in canonical history or emits an `EvolutionEvent`.
- A consequence is reported without its evidence (base revision + applied
  diff + re-evaluated row).
- An unattributable base or an unevaluated consequence reads as clean.

## Exit criterion for this phase

Scenario Evaluation moves to the admissible boundary of the advisor phase once
a developer can evaluate a hypothetical change against a real base, get a
deterministic, evidence-tied current-versus-scenario comparison, and be certain
it never touches canonical history and never reads as a verdict. Until then,
the deterministic `--propose` surfaces remain the honest answer for "what
could change", and impact analysis the honest answer for "what it would touch".
