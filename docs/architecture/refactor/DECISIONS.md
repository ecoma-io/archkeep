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

From PD-8 on, each record carries, compactly in itself, the fields a review
needs to check its grounding: **ID · Date · Question · Evidence · Decision ·
Scope · Alternatives rejected · Consequences · Compatibility impact · Owner ·
Verification/acceptance evidence · Supersedes/superseded by** (when one
exists). A record never restates the constitution — a field whose answer is
"nothing" says so and stops.

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
  _(Narrowed 2026-09-05 by [PD-8](#program-decisions): `rules verify` is not
  an architecture-enforcement carrier — its fold is the artifact-integrity
  contract's, not the architecture law's. The five-fold-site count stands.)_
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
- **PD-8 (2026-09-05) — `rules verify` is a bounded artifact-integrity
  verification authority (closes OQ-13).**
  - _Question_: is `rules verify`'s exit-1 fold a second semantic authority,
    or part of the one enforcement authority's carrier roster?
  - _Evidence_ (source, read 2026-09-05): the fold computes a three-state
    status — `ok`/`findings`/`no-verdict` — over **catalog-integrity**
    findings (digest mismatch, contract-version mismatch, host refusal, an
    artifact escaping its directory) at
    `packages/archkeep/src/commands/rules.mjs:445-448`, folded to exit at
    `packages/archkeep/cli.mjs:2017-2019`. Its envelope is built through the
    shared `jsonEnvelope` and held by the same `EXIT_FOR_STATUS` latch
    (`src/report/json.mjs:88-96`), but it constructs no Decision object and
    never calls `verdictFor` or `evaluateRun` — the `delta`/`change`
    envelopes carry a `decision`; `rules verify`'s carries a `result` over
    the catalog. It reads no workspace graph (the documented `rules` bypass
    of `resolveCommandContext`: synthetic native context, catalog only). The
    consumer-facing contracts already name the domain honestly
    ([exit-codes.md](../../reference/exit-codes.md): "a rule-catalog integrity
    finding").
  - _Decision_: `rules verify` is a **bounded artifact-integrity verification
    authority**. It verifies declared rule artifacts against their catalog; it
    does not evaluate architecture law, does not participate in the
    architecture-enforcement evaluation lane, and is **not** a "second
    architecture authority" in the sense [CON-1](CONSTITUTION.md#con-1--one-enforcement-authority)
    and [INV-25](INVARIANTS.md#inv-25--semantic-authority-count-is-one) forbid —
    that cap counts **architecture semantic enforcement** authorities, and
    both articles now state the scope as such. What `rules verify` shares
    with the lane is the **contract**, not the **law**: the status vocabulary,
    the `EXIT` table, and the envelope latch. Its exit/status behavior follows
    the artifact-integrity contract (a negative verification is exit 1; an
    unreadable catalog is exit 3), not the architecture-verdict contract.
  - _Scope_: the authority map's carrier vocabulary and decision-rights rows,
    and the wording of CON-1, INV-4, INV-25. Not in scope: any change to
    `rules verify`'s implementation, exit codes, or output.
  - _Alternatives rejected_: naming it a second judgment surface inside the
    enforcement authority (blurs the one-law statement); folding its
    vocabulary into the lane's (its findings are not architecture findings
    and `verdictFor` has no inputs for them); a `RulesVerifyEngine`/
    `IntegrityEngine` abstraction (no proven gain —
    [CON-0](CONSTITUTION.md#con-0--do-not-trade-semantic-maturity-for-structural-purity)).
  - _Consequences_: the enforcement-carrier roster is **four** (`check` plus
    three siblings); the "same law" sentence applies to those four only; the
    fold-site hardening of Phase 1-A still covers `rules.mjs:445-448`, as an
    input-validation hardening under the artifact-integrity contract — not a
    lane migration.
  - _Compatibility impact_: none — no observable surface moves.
  - _Owner_: the Phase 0.5 decision-closure session (this PR); carried into
    AUTHORITY-MAP, CON-1, INV-4, INV-25 in the same PR.
  - _Verification/acceptance evidence_: doc gates green; the hostile-reader
    misreading list ([CONTEXT.md](CONTEXT.md#chk-1-prep--phase-05--decision-closure--phase-1-execution-baseline-2026-09-05))
    re-derived with none surviving. _Re-verified from source 2026-09-05
    (Phase 1-B)_: the status fold is the three-state ternary at
    `src/commands/rules.mjs:445-446`, folded to the envelope `exitCode` from
    the shared `EXIT` table at `rules.mjs:448`, and to the process exit at
    `cli.mjs:2040-2042` — the map's fold-roster bullet names the same site
    (`cli.mjs:2040-2042`; 2039 is the comment naming all three codes). The
    envelope is built through
    the shared `jsonEnvelope` at `rules.mjs:479-494` and held by the
    `EXIT_FOR_STATUS` refusal at `src/report/json.mjs:92` (comment `:88-91`,
    thrown message `:93-98`; the status-keyed view is derived from `EXIT` at
    `src/verdict.mjs:37-42`), and it carries `result`, never `decision`
    (`delta.mjs:1085-1094` and `change.mjs:1147-1156` do carry one). No lane
    symbol is imported (`rules.mjs:58-66`); `rulesVerifyCommand` is consumed
    only by `cli.mjs` (import `:138`, dispatch `:1999`) and re-exported by
    `commands.mjs:54`. AUTHORITY-MAP's carrier entry, fold-roster bullet, and
    decision-rights row re-read true against this source — its five exit-1
    verbs match [exit-codes.md](../../reference/exit-codes.md) — so no
    amendment was needed. Pins as measured: the envelope side is held through
    the real latch (`rules.test.mjs` ok→0 `:183-184`; findings→1 `:125-126`,
    `:170-171`, `:223-224`; the unreadable-catalog throw `:77-83`), the
    spawned exit-1 side by `exit-matrix.integration.test.mjs:626-630`, and
    the verb's spawned exit-3 side by that matrix's `ok` row `:622`
    (`rules list` over the catalogless fixture world — the same dispatch
    catch). One side is unpinned — a spawned clean-catalog exit 0 for
    `rules verify`: the matrix's fixture deliberately drives the findings
    side (`:412-413`), and a behavioral pin rides 1-A per this unit's
    isolation rule, so this documentation unit adds none and no code was
    touched. Measured for 1-A: the ternary's `no-verdict` arm is
    unreachable today — every rule lands in exactly `findings` or `passed`,
    and the `unknown` array at `rules.mjs:362` is never pushed — so exit 3 on
    an unreadable catalog arrives through the dispatch catch at
    `cli.mjs:2023-2025`, not the status fold.
  - _Supersedes_: the carrier-roster wording of
    [PD-6](#program-decisions) (five carriers → four enforcement carriers
    plus the integrity surface); PD-6's five-fold-site count stands.
- **PD-9 (2026-09-05) — The capability vocabulary is product documentation,
  owned by `docs/concepts/architecture.md` (closes OQ-1, closes DG-5).**
  - _Question_: who owns the words analyze / check / inspect / compare /
    explain / govern / rules — semantic-domain objects, package names, or
    what?
  - _Evidence_: `docs/concepts/architecture.md` exists and already describes
    every command's capability under "The 24 commands"; `docs/README.md`'s
    ownership map lists it as the concepts owner for the engine model; the
    control plane uses the seven words as its own refactor vocabulary
    ([CON-9](CONSTITUTION.md#con-9--surface--package)).
  - _Decision_: the seven words are **product capability vocabulary** — names
    of product capabilities, not semantic-domain objects and not package
    names. Their normative conceptual owner is the concept documentation,
    `docs/concepts/architecture.md`; the control plane holds no second owner
    and creates no new vocabulary page. [CON-9](CONSTITUTION.md#con-9--surface--package)
    keeps only the refactor constraint — surface ≠ package — and cites the
    concept owner for the words.
  - _Scope_: documentation ownership only. No CLI spelling, no
    implementation, no new control-plane page.
  - _Alternatives rejected_: a new doctrine page (a second home beside an
    existing concepts owner); ownership by the control plane (wrong layer —
    it binds the refactor, not the product).
  - _Consequences_: Phase 5's facade work names groupings from the concept
    page's vocabulary; per
    [PD-11](#program-decisions), regrouping verbs across the words is a
    maintainer-gated surface change.
  - _Compatibility impact_: none.
  - _Owner_: `docs/concepts/architecture.md` (product side); the control
    plane cites it.
  - _Verification/acceptance evidence_: the concept page carries the words
    and their one-sentence semantics; docs gates green.
  - _Supersedes_: nothing — closes [OQ-1](OPEN-QUESTIONS.md#closed--decided)
    and DG-5.
- **PD-10 (2026-09-05) — The event-identity law's home is ADR-0008 plus the
  owning module; no ADR-0009 (closes OQ-2, closes DG-3).**
  - _Question_: does the event-identity law need its own numbered record
    (ADR-0009) or a section in the semantic model page?
  - _Evidence_: ADR
    [0008](../../adr/0008-snapshot-identity-per-family.md) (accepted,
    immutable) states the family law the events already live under: identity
    once per family; graph identity is `snapshotIdentity` over `computeDiff`'s
    universe; the evidence family's identity is its bytes; storage paths
    never enter identity; event sides consume `eventSnapshotSide` and never
    re-derive a second identity. The event-identity composition —
    `eventId`/`eventDedupeKey` over `{base, head, declarationDigest}` — is
    implemented and pinned in `src/governance/evolution-event.mjs` (headers
    plus the [INV-6](INVARIANTS.md#inv-6--event-identity-and-append-only-store)
    witnesses: base/head/declaration sensitivity, clock/narration excluded),
    landed by PR #724. Accepted ADRs are immutable; corrections are new
    records ([ADR 0004](../../adr/0004-correct-old-name-deprecation-mechanics.md)).
  - _Decision_: **no ADR-0009.** ADR-0008 remains the normative source for the
    snapshot/event identity family semantics it already accepted; the event
    composition lives as implementation annotation in the owning module's
    headers, witnessed by its tests; [SEMANTIC-MODEL.md](SEMANTIC-MODEL.md)
    stays the living ownership map pointing at the owner. No new ADR for
    housekeeping; no duplicate semantic source.
  - _Scope_: documentation pointers only.
  - _Alternatives rejected_: ADR-0009 restating the composition (housekeeping,
    not a new architectural decision); a duplicate statement in the semantic
    model page (two homes for one law).
  - _Consequences_: a genuinely new architectural decision about event
    identity would still be a new ADR — this record decides only where the
    existing law lives.
  - _Compatibility impact_: none.
  - _Owner_: [SEMANTIC-MODEL.md](SEMANTIC-MODEL.md)'s event-identity row
    (living map); `src/governance/evolution-event.mjs` headers (implementation
    annotation).
  - _Verification/acceptance evidence_: the map row cites ADR-0008 and the
    owner; docs gates green.
  - _Supersedes_: nothing — closes [OQ-2](OPEN-QUESTIONS.md#closed--decided)
    and DG-3.
- **PD-11 (2026-09-05) — CLI capability regrouping is a product-surface
  semantic change (closes OQ-3).**
  - _Question_: is regrouping CLI verbs into capability surfaces
    behavior-free when verb spelling, exit codes, and output stay identical?
  - _Evidence_: the capability grouping changes which words own which verbs —
    the public surface's mental model and ownership semantics — before any
    byte moves; the compatibility contract (root `AGENTS.md`) classifies by
    meaning, not by bytes.
  - _Decision_: **no — capability regrouping is a product-surface semantic
    change.** Phase 5's regrouping carries its own explicit maintainer
    decision record before implementation; it is never bundled with
    mechanical extraction; it is never described as a pure internal refactor;
    spelling stability is a compatibility constraint and does not make a
    regrouping behavior-free.
  - _Scope_: the classification of one work item; no surface moves in this
    record.
  - _Alternatives rejected_: treating regrouping as in-scope 0.x-minor
    cleanup bundled into Phase 5's mechanical work.
  - _Consequences_: Phase 5 gains a maintainer gate ahead of its facade work
    (recorded in [MIGRATION-PLAN.md](MIGRATION-PLAN.md#phase-5--capability-facades)'
    entry criteria).
  - _Consequences for vocabulary_: the groupings are named from
    `docs/concepts/architecture.md`'s words ([PD-9](#program-decisions)).
  - _Compatibility impact_: classification guidance only — the contract in
    root `AGENTS.md` remains the decider of compatibility classes.
  - _Owner_: the maintainer (the Phase 5 gate is theirs).
  - _Verification/acceptance evidence_: MIGRATION-PLAN's Phase 5 entry names
    the gate; hostile-reader misreading 3 and 11 excluded.
  - _Supersedes_: nothing — closes [OQ-3](OPEN-QUESTIONS.md#closed--decided).
- **PD-12 (2026-09-05) — Decisions before implementation.** Every
  architecture-affecting question is classified **before** the code that
  would depend on it, as exactly one of: already decided by doctrine or an
  accepted ADR; decided by a program decision (this page);
  **verification-required** ([OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) names the
  owner, the evidence, and the closing outcome); or **maintainer-gated**
  (only the maintainer decides). "Open" is never a license to choose: a
  worker may investigate and may propose; the coordinator or maintainer
  decides. Recorded here as program history — the binding statement is
  [P-G](CONSTITUTION.md#process-articles).
- **PD-13 (2026-09-06) — The 2-A canonical semantic audit's adjudication
  (closes OQ-5, OQ-7, OQ-10).**
  - _Question_: for each audited concept — Finding, Evidence, Observation,
    Evaluation, Violation, Decision, Verdict, Policy, Intent, Snapshot,
    Provenance — is the engine's existing ownership a canonical domain
    object (a), a shared construction contract (b), or no canonical object
    with relationships pinned (c); does the provider ladder become an
    architectural model or stay an implementation boundary; and what is each
    bounded-derivation behavior's per-item verdict.
  - _Evidence_: four read-only audits over `eee9d22` — a constructor census
    per concept (path:line for every family member), a bounded-derivation
    dossier, a register/drift sweep, and the OQ-7 probes. OQ-7's evidence is
    **executed**: the same clean workspace, `fitness` emits a drift-free
    `pass` (`fitness.mjs:221-240` feeds verdict-shape intent), `decisions`
    emits `fail` (`decisions.mjs:126-136` feeds the raw model, which
    `fitness-rules.mjs:632-668` default-fails on). Filed as
    [#737](https://github.com/ecoma-io/archkeep/issues/737); fix = work item
    WI-1, Phase 2 correctness hardening (0.x minor, silent-direction
    regression test required).
  - _Decision_: per-concept rulings, all maintainer-approved 2026-09-06 —
    **Finding (c)** (violationOf stays the import-site lane record;
    families→count keys→`verdictFor` pinned as relationships;
    `check.mjs:519-523` the edge-verdict normalization seam); **Evidence (c)**
    (five families, two identity conventions, never unified;
    `report/evidence.mjs`'s misnomer = WI-3); **Observation (a)** (the
    `src/analysis/` record family — constructors in `analysis/analyze.mjs`
    (`analyzerFor:209`, `analyzeFile:235`), shape law
    `src/analysis/contract.md` — family-consistent construction);
    **Evaluation (c)** (`evaluation-primitives.mjs` hosts helpers, never a
    canonical object); **Violation (a)** (one canonical object,
    `violationOf` — the rules lane's canonical record and normalization
    target); **Decision — two meanings,
    split by meaning** (the run-envelope decision object: governance-owned,
    `verdict.mjs`/`buildDecision`; the ADR-record family: ADR 0008's home;
    never one type); **Verdict (a) per module** (`fitnessVerdict` co-located
    by family; `judgeIntent`'s `.verdict` field collision = WI-4);
    **Policy (a)** (`policy.mjs` owns the disposition ladder; its
    `:34-47` "eleven sites" comment is stale (the audit measured 16 call
    sites) — plus the
    `provenance-command.mjs:267` bypass = WI-2, fold-or-ADR);
    **Intent (c)** (four surfaces — architecture-intent, intent contracts,
    declared-change grammar `src/commands/change-intent.mjs`, run envelope
    intent shape); **Snapshot (a) per family** (two snapshot concepts —
    declaration `snapshotIdentity` vs observation `captureDelta` — never
    mixed); **Provenance (a) per family** (`recordDecisionLifecycle`
    dormant = WI-6, wire-or-delete). The ladder **stays an implementation
    boundary** (no named-type model); D2's "no second consumer" holds only
    for intermediate stages in isolation — the trigger class for revisiting
    is **mid-ladder entry** (a second path entering between stages), not
    downstream consumption. Bounded-derivation verdicts (per-item, closing
    the seam table's pending markers): `judgeCoverage` (b), `moon:declared`
    targets synthesis (b), `nodeTypeFromLayer` (b, unknown-layer `lib`
    fallback recorded), `isRoot` root-target suppression (b, twin with
    Nx's own rule), `nodeTypeOf` lib default (b; the `lib` fallback pinned
    at `native/discover.mjs:64-69`),
    `isDotnetGeneratedOutput` (b), the seventh candidate (no verdict — the
    config-key roster at
    [`docs/reference/configuration.md:32-97`](../../reference/configuration.md)
    is the bounded source list, not a derivation).
  - _Scope_: documentation-contract records only; no code. The work items
    it names (WI-1 #737 fix; WI-2 policy bypass fold-or-ADR; WI-3
    `report/evidence.mjs` rename; WI-4 `judgeIntent` field rename; WI-5
    `policy.mjs` comment correction; WI-6 lifecycle wire-or-delete) are
    their own gate items.
  - _Alternatives rejected_: a canonical Finding object (collapses distinct
    per-surface grammars no defect class needs unified — CON-3); unifying
    Evidence (five meanings, two identity conventions); one Evaluation type
    (distinct carriers); a named-type ladder model (no mid-ladder consumer;
    zero behavioral drift to buy the type with); widening
    `workspaceLayoutSource` (PD-14).
  - _Consequences_: 2-B proceeds as relationship pins (outcome (c));
    #738 and [#739](https://github.com/ecoma-io/archkeep/issues/739),
    filed from the same audit and maintainer-ruled bugs, are separate fix
    PRs; SEMANTIC-MODEL/BOUNDARIES/MOON-POLICY rows update in the same PR
    as this record.
  - _Compatibility impact_: none — docs only. WI-1, when it lands, is a
    0.x minor with the behavior change named in the changelog.
  - _Owner_: [SEMANTIC-MODEL.md](SEMANTIC-MODEL.md) (living map),
    [BOUNDARIES.md](BOUNDARIES.md) (seam verdicts),
    [MOON-POLICY.md](MOON-POLICY.md) (promoted rows).
  - _Verification/acceptance evidence_: docs gates green on the recording
    PR; every ruling cites measured `path:line` from the audit payloads;
    OQ-7's evidence is an executed differential, not an argument.
  - _Supersedes_: nothing.
- **PD-14 (2026-09-06) — `workspaceLayoutSource` keeps its two-value
  vocabulary (closes OQ-15).**
  - _Question_: does the two-value vocabulary overclaim provenance — a
    Moon-inferred layout reporting `"declared"`
    ([ADR 0010](../../adr/0010-moon-workspace-layout-inference.md))?
  - _Evidence_: ADR 0010's own consequences clause names the widening as
    its own compatibility-classified change; the 2-A audit's register sweep
    surfaced the reading ambiguity, and OQ-15's no-issue outcome named
    exactly the correction recorded here.
  - _Decision_: **two values kept**; the corrected meaning is the
    documented contract — the graph carries the layout **key**
    (config-named or Moon-derived), and the `"declared"` slot records the
    key's presence, not who named it. Widening to a third value remains
    available as its own compatibility-classified change.
  - _Scope_: documentation; the contract sentence lives once in
    [BOUNDARIES.md](BOUNDARIES.md)'s provider seam section.
  - _Alternatives rejected_: widening now (an output-contract change with
    no consumer need measured); per-provider sub-status inside the
    existing values (a second vocabulary in one field).
  - _Consequences_: the vocabulary's meaning is stated once and cited;
    ADR 0010's cost record stands.
  - _Compatibility impact_: none.
  - _Owner_: [BOUNDARIES.md](BOUNDARIES.md) (provider seam).
  - _Verification/acceptance evidence_: the row moves to CLOSED — DECIDED
    in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md); the contract sentence is in
    the seam section of the same PR.
  - _Supersedes_: nothing.
- **PD-17 (2026-09-06) — Refactor-unit issue routing.**
  - _Question_: does the cross-repo gate (issue → branch → draft PR per
    unit) require a dedicated issue for every refactor work item?
  - _Evidence_: seven landed refactor PRs (#730–#736, #740) link umbrella
    #725 and no unit carried its own issue; the template roster
    (bug_report, feature_request, missed_violation) has no refactor form —
    feature_request is capability-shaped and would fabricate fields for a
    deletion; defects always filed their own templated issues (#735,
    #737, #738, #739).
  - _Decision_ (maintainer, this session): refactor program units track
    via umbrella #725 plus their finding id named in the PR body; defects
    continue to route through their own templated issues.
  - _Scope_: Phases 2–9 work items. _Alternatives rejected_: per-unit
    issues (form mismatch; ceremony without a receiver); a new issue
    template (a program-process concern, not a repo defect class).
  - _Consequences_: the PR body plus the finding id are the unit's gate
    trail; the WI-6 PR (#746) complies as opened.
  - _Compatibility impact_: none. _Owner_: the maintainer.
  - _Verification/acceptance evidence_: this record; PR bodies naming
    their finding ids. _Supersedes_: nothing.
