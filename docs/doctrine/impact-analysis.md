# Architectural Impact Analysis

This is the first of the three architecture-intelligence capabilities the
[roadmap](roadmap.md) gates in front of stable 1.0. It is the substrate the
other two read: [scenario evaluation](scenario-evaluation.md) re-runs it over
a hypothetical change, and the [evidence-grounded advisor](evidence-grounded-advisor.md)
reads its output as fact. It is also the one closest to what ships today —
much of it is hardening the deterministic `impact`, `delta`, `evolution` and
decision-chain primitives rather than inventing new machinery.

## Problem statement

Before and during a change, a developer or an agent needs one answer: **what
does this change touch?** Not "is the current tree clean" (that is `check`),
but "if I change project or boundary X, which projects, dependencies,
constraints, recorded Decisions, findings and debt entries are affected, and
what evidence supports each claim?"

Today Archkeep answers fragments of this. `archkeep impact <project>` lists
transitive dependents with their `depConstraints` context. `delta`, `diff`
and `change` classify what actually changed between two revisions. `evolution`
records an `EvolutionEvent` whose `affected` field names the projects,
boundaries, constraints and decisions a concluded transition touched.
`decisions` walks the decision chain. What does not exist is a single,
authoritative, human- and agent-readable **impact statement**: given a change,
enumerate every governed entity it affects, each tied to the reproducible
evidence that supports the claim, and say plainly when the enumeration is
incomplete.

## User workflow

1. A developer or agent changes a project (or a hypothetical change is
   described — the same primitive serves scenario evaluation).
2. Archkeep produces an **impact statement**: the affected projects, edges,
   constraints, recorded Decisions, findings and debt, each with its evidence
   (a graph edge, a diff hunk, a drift signal, an evolution event, a decision
   row).
3. The developer reads _what changed_ and _what it is likely to touch before
   it is made_, in machine-readable form for an agent and in plain text for a
   human, under the law in effect.
4. The human — or the agent, under the same rules an agent follows today —
   proceeds to change, evaluate a scenario, or confirm the impact is smaller
   than feared.

## Scope

Impact Analysis answers **what a change touches**, structurally. It composes
the deterministic primitives that already exist:

- **Reverse reachability** — who transitively depends on a project (`impact`).
- **Edge and boundary impact** — which edges and boundaries an added, removed
  or changed dependency touches.
- **Constraint impact** — which governance rows would newly apply or newly
  fail (`depConstraints`, intent rows, and where available policy), the
  constraint-impact the `impact` command already computes for a subset of rule
  types.
- **Decision impact** — which recorded Decisions (ADRs) bind the affected
  rows, via `decisionRef`, and how their fitness changes.
- **Finding and debt impact** — which findings and `debt` ledger entries are
  introduced, resolved, or left open by the change.
- **Evolution alignment** — the `affected` shape of the `EvolutionEvent`
  (`projects`, `boundaries`, `constraints`, `decisions`) is the same
  vocabulary an impact statement speaks, so a concluded change and a predicted
  one are comparable.

Each affected entity carries its evidence and its status under the funnel of
honesty this repository is judged by: a statement that cannot be completed
explicitly says so rather than presenting a partial list as complete.

## Non-goals — impact is not risk

Impact Analysis says what a change _touches_; it does not say what a change
_will break at runtime_. The following are explicit non-goals:

- **No risk scoring.** No severity, expected-cost, or "how bad" number over an
  affected set. `trajectory` reports facts that moved — churn, persistence —
  never a score, and impact inherits that discipline.
- **No runtime prediction.** No latency, throughput, CPU, memory, availability
  or capacity claims about what the change would do in production. The view is
  structural; runtime belongs to observability.
- **No learned or statistical weighting.** No model decides which affected
  entity a reader should "care most about". The statement is exhaustive and
  the reader (human or agent) applies priority.
- **No judgment about the change's merit.** Impact names what is touched; it
  does not recommend whether to proceed.

A reader who wants "how bad" must build that on top of the exhaustive
structural statement with their own evidence (real benchmarks, real incidents),
never from Archkeep's structural output alone.

## Dependencies

Impact Analysis is a gate on the maturity ladder. It depends on:

- The deterministic authority core (gate 1): a trustworthy graph and verdict
  before anyone trusts an impact statement built on it.
- First-class architecture state (gate 2): `graph`, `diff`, `history`,
  `trajectory`, `evolution`, `provenance`, `drift` as one consistent state
  model — an impact statement stitches these together, so their consistency is
  a precondition, not a convenience.
- Broadened change context (gate 4): `context --plan`, `impact`, `delta` and
  `explain` — the per-change questions this capability elevates into a full
  statement.
- **Deepened reconciliation (gate 3) is deliberately adjacent, not a
  dependency.** Reconciliation classifies the gap between intent and reality;
  impact enumerates what a change touches. They inform each other but neither
  blocks the other.

## Acceptance criteria

The capability exists when, on real trees (not only fixtures), a change to any
architecture entity produces an impact statement that:

1. **Names every governed entity it touches** — projects, edges, constraints,
   Decisions, findings and debt — with no silent omission when the enumeration
   is incomplete (a gap must be reported as gap, exactly as `impact` refuses
   incomplete coverage today).
2. **Ties each claim to reproducible evidence** — every affected entity cites
   the graph edge, diff hunk, drift signal, evolution event, or decision row
   it rests on.
3. **Speaks one vocabulary with `EvolutionEvent.affected`** — `projects`,
   `boundaries`, `constraints`, `decisions` — so a predicted impact and a
   concluded evolution are comparable.
4. **Reads the law in effect** — an impact statement reports under the
   boundary config and profile that would gate the change, and says which law
   it ran under.
5. **Is machine-readable and deterministic** — a script can consume it, and
   two runs over an unchanged tree produce identical output, like every other
   analysis here.
6. **States its own limits** — any constraint or rule class it did not
   evaluate (e.g. the rule types `impact`'s constraint-context does not judge:
   npm bans, circular dependencies, lazy-load rules) is named, never silently
   folded in.

## Evidence and provenance requirements

Impact is a **prediction** (in the vocabulary of
[architecture-authority.md](architecture-authority.md), where a prediction is
allowed to be wrong but must be labelled). Every claim in an impact statement
is one of:

- **A fact** — a reproducible deterministic output: an edge exists, a row
  resolves, a decision binds. Traces to a core output.
- **A prediction** — a statement about what _would_ be touched. Labelled as
  prediction, and its evidence base (the diff, the reverse-reachability, the
  decision bindings) is named.

The statement carries provenance the way `graph` and `diff` do — the git
origin of the run, the config in effect — so a reader can attribute every
claim.

## Failure and unsupported semantics

- **Incomplete coverage is a loud failure.** If the graph has whole-file
  analysis failures, or a needed comparison cannot be completed, the impact
  statement says so (mirroring `impact`'s exit-3 refusal) rather than printing
  a plausible-looking partial list. A confident incomplete statement is the
  silent direction in a richer format.
- **Unsupported rule classes are named.** Rule types the constraint-impact
  path does not evaluate are listed as un-evaluated, never implied clean.
- **No verdict is weakened.** An impact statement never changes what `check`
  or any verdict would report; it composes them.

## Test expectations

Every labelled claim goes red when its label is missing — the silent
direction for this capability is output that reads authoritative and is not.
Concretely:

- A change that touches a decision reports the decision and the decision's
  updated fitness; a test asserts the decision is present and its evidence is
  named.
- A change whose constraint impact could not be fully evaluated reports the
  gap; a test asserts incomplete coverage is loud, never silent.
- A statement over an unchanged tree is empty-in-a-claimed-way (the "nothing
  depends on this" case is distinguishable from "could not look"), mirroring
  the invariant in [principles.md](principles.md).

## Exit criterion for this phase

The capability moves to the next gate when a change to any governed entity, on
a real workspace, reliably enumerates every affected entity, decision and
governance artifact with per-claim evidence — and a reviewer can trust that
enumeration as much as a `check` verdict. Until then, the deterministic
fragments (`impact`, `delta`, `diff`, `evolution`, `context --plan`), which
already ship, remain the honest answer.
