# Constitution

The refactor program's immutable rules. Everything else in this control plane
— the [invariant registry](INVARIANTS.md), the [migration plan](MIGRATION-PLAN.md),
the [authority map](AUTHORITY-MAP.md) — answers to this page; a phase, a PR, or
an extraction that conflicts with an article here is rejected regardless of
code quality.

This page binds **the refactor**, and inherits rather than restates what the
repository already owns:

- The system boundary, the intent/reality/state vocabulary, and the line
  providers, skills, agents and platform clients may not cross —
  [`docs/doctrine/architecture-authority.md`](../../doctrine/architecture-authority.md).
- The seven binding principles of the engine —
  [`docs/doctrine/principles.md`](../../doctrine/principles.md).
- The compatibility contract (what a breaking change is, even on the 0.x line)
  — the repository root's `AGENTS.md`, "The compatibility contract"
  (the doc-links gate forbids markdown links from `docs/` to outside it, so
  the file is named in plain text).
- The numbered, immutable decision records — [`docs/adr/`](../../adr/). A
  constitution article that contradicts an accepted ADR is resolved by a new
  ADR, never by editing the old one.

Where an article below and a doctrine page would say the same thing, the
doctrine page is the statement and this page links it. The articles here are
the ones doctrine does not already carry: they govern **how the architecture
may change**, not what the architecture is.

## CON-0 — Do not trade semantic maturity for structural purity

Clean layering, package count, file size, and directory aesthetics are not
goals. A boundary earns its existence only by making a previously possible
dependency **impossible or unnecessary**, or by buying lifecycle, test, build,
or consumer isolation of real value. Mechanical extraction, architecture
ceremony, god services, distributed monoliths, duplicate domain models, and
abstraction "for the future" are all rejections. A large physical semantic
core is acceptable — even preferred — when it keeps
[authority locality](#con-5--authority-locality) and auditability higher than
a split would.

## CON-1 — One enforcement authority

Archkeep has exactly one semantic enforcement authority. `check` — the
evaluation lane behind it — owns enforcement, evaluation, and verdict. CLI,
MCP, LSP, providers, renderers, reporters, and command facades hold no
judgment of their own. No second engine ("CheckEngine", "MCPCheckEngine",
"CLI evaluator", "Report evaluator", or semantic equivalent) may be created.
What the one authority already states is
[`docs/doctrine/architecture-authority.md`](../../doctrine/architecture-authority.md)'s
"The boundary, stated once"; this article extends it from _what neighbours may
not decide_ to _what this repository may not build while refactoring_.

## CON-2 — Semantic flow is one-way

The canonical flow is preserved and made clearer, never rerouted:

```
input adapters → workspace acquisition → observation/analysis →
canonical representation → evidence → policy/rules/governance inputs →
deterministic evaluation → verdict → projections/surfaces
```

Analyzers do not judge. Providers do not judge. Renderers do not judge.
Proposals never become decisions by themselves. `explain` explains from the
evidence and evaluation the canonical path already produced — it never runs an
independent semantic evaluation that could disagree with `check`. `compare`
operates on canonical snapshots — it never grows a second snapshot semantics.
ADR [0007](../../adr/0007-no-semantic-model-expansion.md)'s verified record
chain (Decision → Intent → … → EvolutionEvent → History / Debt → Report) is
the **lifecycle view** of this flow; this pipeline is the **computation
view**. The record chain binds what is stored; the pipeline binds how it is
computed; neither authorizes the other's vocabulary.

## CON-3 — Generalize computation, not domain vocabulary

The domain keeps its words: Intent, Reality, Observation, Evidence, Rule,
Policy, Evaluation, Decision, Waiver, Verdict, Snapshot, Provenance,
Architecture, Workspace, Repository, Boundary, Dependency, Proposal,
Reconciliation. Computation or infrastructure may be generalized only when the
benefit is concrete. No `Entity`/`Resource`/`Constraint`/`Decision` universal
abstraction over the domain.

## CON-4 — Canonical semantic models

Every important semantic concept has exactly one canonical owner and one
canonical representation (see
[SEMANTIC-MODEL.md](SEMANTIC-MODEL.md)). No `DomainVerdict`/`CheckVerdict`/
`MCPVerdict`/`ReportVerdict` variants carrying the same semantics. Adapters
project canonical facts; they do not redefine them. A refactor that finds two
modules constructing semantically-equal shapes resolves ownership **before**
moving either.

## CON-5 — Authority locality

An engineer must be able to trace one verdict — verdict → evaluation →
rule/policy → evidence → observation → source/provenance — without reading the
whole repository. An extraction that makes the semantic flow harder to audit
is not an improvement. When "cleaner structure" and "auditable semantics"
conflict, semantics wins.

## CON-6 — Semantic conservation

By default, `Authorities_after = Authorities_before`. Canonical vocabulary
does not change. `check`'s semantics do not change without an accepted ADR.
Semantic equivalence outranks implementation similarity. Where a contract
demands byte compatibility, byte compatibility holds; where it demands only
semantic compatibility, implementation details are not needlessly frozen.

## CON-7 — Proposal, reconciliation, decision, waiver, change, explain stay distinct

They are not merged into one "GovernService". `govern` is a product
surface/grouping, not a semantic authority owning the governance lifecycle.
Governance state may be input to effective intent/policy; it never owns
verdict semantics.

## CON-8 — Snapshot and federation: runway, not machinery

Federation is not implemented speculatively. The runway is built by making
project/repository identity, snapshot semantics, provenance, evidence
externalization, and compare semantics explicit (see
[ADR 0008](../../adr/0008-snapshot-identity-per-family.md) for the identity
rule already accepted). A `FederationService` or equivalent appears only when
a concrete requirement proves it necessary.

## CON-9 — Surface ≠ package

CLI verbs are capabilities and product surfaces, not a package layout.
`analyze` observes; `check` evaluates and enforces; `inspect` introspects
canonical state; `compare` operates on canonical snapshots; `explain`
projects causal explanation from canonical evidence; `govern` groups
governance capabilities; `rules` serves the rule catalog. Surfaces stay thin.
A capability facade delegates to the canonical core — it is composition, not
re-implementation.

## CON-10 — Providers observe, they do not decide

Filesystem, git, Nx, Moon, subprocess, and future providers acquire and
normalize observations. No provider constructs an architecture verdict or a
policy judgment. Provider-specific quirks are handled at the
observation/normalization boundary, never inside evaluation. Two neighbors
that are **not** providers and must not be dragged into this article:
language analyzers observe under the frozen record contract (they are the
analysis layer, and they never judge), and custom rules are the rule seam
([ADR 0002](../../adr/0002-custom-rules-one-contract.md)) — declared policy
inputs whose verdict contributions fold into `check` through the one host.

## CON-11 — Determinism

The same semantic inputs produce the same semantic result. Existing
nondeterminism is identified, not extended: no ordering instability,
environment leakage, time dependence, network dependence, or provider hidden
state may enter semantic evaluation. The determinism suite
([`docs/development/testing.md`](../../development/testing.md) owns its shape)
is a refactor gate, not a nice-to-have.

## CON-12 — Differential safety

Every substantial extraction or behavior-adjacent change validates
differentially: old path vs. new path over the same semantic cases, comparing
verdicts, violations, coverage semantics, evidence/provenance semantics, exit
codes, and contract outputs where the contract demands them. A rewrite is
never self-approved by the new implementation's own unit tests alone. Where
semantic equivalence and incidental formatting diverge, semantic equivalence
is compared first.

## Process articles

- **P-A — Documentation precedes code.** Each phase begins by reading this
  control plane and ends by updating it. A code change that moves a boundary,
  an ownership, a canonical type, or a capability's semantics carries its
  document update in the same PR.
- **P-B — Review independence.** The implementer of a change is never its
  final reviewer. Architectural changes get an adversarial reviewer who reads
  the diff, the doctrine, and the tests looking for counterexamples.
- **P-C — Stable IDs.** Invariants are `INV-*`, decisions are `ADR-*` (in
  [`docs/adr/`](../../adr/), continuing the existing numbering), checkpoints
  are `CHK-*`. Reviews, PRs, and tests reference these IDs, not prose
  paraphrases.
- **P-D — Stop conditions.** A phase stops and reports REWORK on: a hidden
  second authority, a new circular dependency, a duplicate canonical model,
  semantic behavior drift, provider judgment, CLI/MCP semantic divergence,
  nondeterminism regression, an unexplained contract regression, or a package
  extraction that cannot demonstrate architectural gain. The full maturity
  gate lives in [MIGRATION-PLAN.md](MIGRATION-PLAN.md).
