# Decisions

Two registers live here, and neither duplicates `docs/adr/`:

1. **Accepted ADRs the refactor builds on** — immutable, cited, never edited
   here. A refactor decision that contradicts one resolves by a **new** ADR
   (ADR [0004](../../adr/0004-correct-old-name-deprecation-mechanics.md)
   is the precedent), never by editing the old record.
2. **Program decisions (PD-\*)** — routing and scoping rulings of the refactor
   program that do not rise to an ADR (an ADR records architecture decisions;
   these record how the program runs). Each is dated and carries its
   rationale.

## ADRs the refactor inherits

| ADR                                                              | What it locks for the refactor                                                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [0001](../../adr/0001-boundary-levels.md)                        | engine below the extension; `type-package`/`type-extension` bindings — no extension concerns promoted into the engine |
| [0002](../../adr/0002-custom-rules-one-contract.md)              | one rule seam, wasm core-only, four SDKs, declared-never-discovered; the evidence bundle is public API                |
| [0003](../../adr/0003-rename-lattice-to-archkeep.md)             | the two hard cutover spellings; old names in old records are history, not drift                                       |
| [0004](../../adr/0004-correct-old-name-deprecation-mechanics.md) | corrections are new records; deprecate, never delete — the meta-rule this page follows                                |
| [0005](../../adr/0005-jvm-language-integration.md)               | shared JVM core, thin frontends, static-only permanently                                                              |
| [0006](../../adr/0006-dotnet-language-integration.md)            | mirrors JVM disciplines; obj/bin role-judged (amendment 2026-08-27, #371)                                             |
| [0007](../../adr/0007-no-semantic-model-expansion.md)            | no ownership/data-flow/API/event/runtime boundary semantics; no new semantic primitives (INV-22)                      |
| [0008](../../adr/0008-snapshot-identity-per-family.md)           | identity once per family — graph `snapshotIdentity`, evidence bytes; storage paths never enter identity               |

## Program decisions

- **PD-1 (2026-09-05) — Phase 0 ran six audits, read-only.** Doctrine (WS1),
  core semantics (WS2), commands/surfaces (WS3), governance/state (WS4),
  providers/external surfaces (WS5), tests/contracts (WS6). Five ran as
  supervised Orca workers (run `run_0572508bf9d5`, all settled and released);
  the doctrine audit ran as a directly-supervised agent after its Orca worker
  stalled on prompt delivery — the fallback is recorded here so the
  orchestration record is honest. Findings are absorbed into this control
  plane; the audit reports themselves are session artifacts, not tracked
  documents.
- **PD-2 (2026-09-05) — The cartography's verdict.** The architecture is
  fundamentally sound: one verdict lane verified end-to-end, canonical
  ownership clean across every governance concept, the LSP empty-diagnostics
  invariant intact, proposals structurally unable to decide. The refactor is
  therefore a **hardening and enforcement** program (close gaps, scan the
  claimed laws, prove the extractions), not a rescue. Consequence: no phase
  is permitted to trade verified semantics for structure
  ([CON-0](CONSTITUTION.md#con-0--do-not-trade-semantic-maturity-for-structural-purity)),
  and Phase 4 may legitimately close with "no proven extractions".
- **PD-3 (2026-09-05) — Numbering namespaces.** `INV-*` (invariants),
  `CON-*`/`P-*` (constitution), `G-n` (architectural test gaps),
  `DG-n` (doctrine gaps), `OQ-n` (open questions), `PD-n` (program
  decisions), `R-n` (vocabulary registers), `D-n` (doc-divergence riders in
  Phase 1), `CHK-n` (phase checkpoints, recorded in
  [CONTEXT.md](CONTEXT.md)). ADR numbering continues in `docs/adr/`. One
  namespace per kind; reviews cite ids, never paraphrases
  ([P-C](CONSTITUTION.md#process-articles)).
- **PD-4 (2026-09-05) — GAP-A gates Phase 4.** No structural extraction
  begins before the golden-output corpus exists and the byte-identity
  comparator covers every read-only verb. Reason: without it, "semantic
  equivalence" during a move is unverifiable, which would make every
  extraction self-approved ([CON-12](CONSTITUTION.md#con-12--differential-safety)).
- **PD-5 (2026-09-05) — INV-18 is budgeted, never bypassed.** Any PR moving
  an evidence-named file updates `src/intent/intent-manifest.json` digests in
  the same PR. A red `intent.test.mjs` during a refactor is the tripwire
  working, not a gate to route around.
- **PD-6 (2026-09-05) — How CON-1 is stated after adversarial review.** The
  review falsified the control plane's first formulation ("`verdictFor` is
  the only path from findings to exit 1"): five verdict carriers fold at five
  sites and only `check` goes through `verdictFor`. The corrected statement —
  authority = one law, one status vocabulary, one `EXIT` table, one
  `buildDecision`, carriers agreeing because they evaluate the same law
  (intent J) — is binding for every later phase. Two corollaries: Phase 1
  hardens the fold **class** across all five sites; and no phase may "route a
  sibling carrier through `verdictFor`" as cleanup — `delta`'s findings fold
  classification counts `verdictFor` has no inputs for, so such a reroute is
  a semantic change, not a conformance fix.
- **PD-7 (2026-09-05) — Maintainer steering pass on PR #727.** Before merge,
  the maintainer approved the direction and issued nineteen directives
  hardening the control plane against future-agent misreading. The
  load-bearing ones are now articles and sections rather than this
  paragraph: [CON-1](CONSTITUTION.md#con-1--one-enforcement-authority)'s
  authority/surface distinction with the anti-unification mirror rule; the
  [work-item contract](MIGRATION-PLAN.md#work-item-contract-binding-on-every-unit-from-phase-1-on)
  with per-item classification (and no blanket "no behavior change" claim
  for phases containing correctness hardening); "no proven extraction" as a
  successful Phase 4 outcome, with package/file counts named as
  anti-metrics; Phase 2-A's finding audit before any canonicalization; the
  three [validation levels](VALIDATION-MATRIX.md#validation-levels-how-a-comparison-runs-in-this-order);
  the mandatory [handoff protocol](CONTEXT.md#handoff-protocol-mandatory);
  [P-E](CONSTITUTION.md#process-articles)'s orchestration loop and
  [P-F](CONSTITUTION.md#process-articles)'s ownership locks; the enumerated
  stop conditions; evidence-first exits; the architectural debt budget; the
  [document hierarchy](CONSTITUTION.md#document-hierarchy); and Phase 1's
  PASS/FAIL/DEFER gate table. Recorded here as program history — the
  articles are the binding statement.
