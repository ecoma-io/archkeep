# Context

The program's state, for any agent (or maintainer) bootstrapping cold. This
page is updated at the end of every phase
([P-A](CONSTITUTION.md#process-articles)); after a context compaction it is
the authority, not conversation memory.

## Bootstrap order for a new session

1. This page (state + last checkpoint).
2. [CONSTITUTION.md](CONSTITUTION.md) (the articles + process).
3. [MIGRATION-PLAN.md](MIGRATION-PLAN.md) (your phase's entry/exit criteria).
4. The control-plane pages your phase touches
   ([AUTHORITY-MAP.md](AUTHORITY-MAP.md), [SEMANTIC-MODEL.md](SEMANTIC-MODEL.md),
   [DATA-FLOW.md](DATA-FLOW.md), [BOUNDARIES.md](BOUNDARIES.md),
   [INVARIANTS.md](INVARIANTS.md), [VALIDATION-MATRIX.md](VALIDATION-MATRIX.md)).
5. Repository law: root `AGENTS.md`, `packages/archkeep/AGENTS.md`, the
   owning issue and PR for the current phase.

Do not rely on remembered facts about the codebase — the Phase 0 pages carry
the verified map, and each phase re-verifies what it touches. The lead agent
works the same way: **conversation memory is never a source of truth**
([P-A](CONSTITUTION.md#process-articles)); when this page and a conversation
disagree, this page wins until a landed PR corrects it.

## Handoff protocol (mandatory)

After every architectural PR — before it is merged — the coordinator updates
this page so that a fresh agent with **no conversation history** can continue
the program from here alone. Each PR's handoff entry records:

1. the current phase and its gate-table state;
2. checkpoints completed (ids);
3. invariant ids touched, and how;
4. canonical ownership changes ([SEMANTIC-MODEL.md](SEMANTIC-MODEL.md) rows);
5. dependency-boundary changes ([BOUNDARIES.md](BOUNDARIES.md) rows);
6. contracts affected and their compatibility classification;
7. differential evidence — which rows, which verdict, at which
   [validation level](VALIDATION-MATRIX.md);
8. the architectural debt budget: gaps before, gaps closed, gaps introduced,
   net delta;
9. unresolved questions and open decisions;
10. rejected approaches — what was tried and why it lost;
11. explicit forbidden next moves (the traps this PR discovered), and the
    exact objective of the next PR.

A missing field is a review defect, not a style preference.

## Program state

| Phase                                               | Status                                    | Record                       |
| --------------------------------------------------- | ----------------------------------------- | ---------------------------- |
| 0 — Architecture cartography                        | **complete** (PR #727 merged)             | CHK-0 below                  |
| 0.5 — Decision closure & Phase 1 execution baseline | **complete** (PR #729 merged)             | CHK-1-PREP below             |
| 1 — Authority hardening                             | **complete** (PRs #730–#734 + this PR)    | CHK-1-CLOSE below            |
| 2 — Canonical model hardening                       | ready — entry brief in MIGRATION-PLAN 2-A | entry: Phase 1 exit recorded |
| 3 — Boundary enforcement                            | not started                               | blocked by 2                 |
| 4 — Internal extraction                             | not started                               | **blocked by GAP-A** (PD-4)  |
| 5 — Capability facades                              | not started                               | blocked by 4                 |
| 6 — CLI recomposition                               | not started                               | blocked by 5                 |
| 7 — Additional surfaces                             | not started                               | blocked by 6                 |
| 8 — Federation readiness                            | not started                               | maintainer-gated             |
| 9 — Final hardening                                 | not started                               | blocked by 8 (or waiver)     |

Tracking: issue #725 (the program), PR #727 (Phase 0's control plane), PR
#729 (Phase 0.5), PRs #730–#734 (Phase 1 units A, B, E, F, C), and this PR
(Phase 1-D + the Phase 1 close, branch `johnitvn/phase1-d-seam-contract`).

## Checkpoints

### CHK-0 — Phase 0, architecture cartography (2026-09-05)

- **ID**: CHK-0. **Phase**: 0. **Status**: complete; maintainer steering
  pass applied ([PD-7](DECISIONS.md#program-decisions)); pending merge.
- **Goal**: map the architecture as it is — authority, semantic model, data
  flow, boundaries, tests — with every load-bearing claim verified against
  the tree, and lock the control plane before any code change.
- **Invariants protected**: none changed (read-only phase). All 24 INV rows
  the audits found were inventoried with witnesses and gaps
  ([INVARIANTS.md](INVARIANTS.md)); INV-25 (semantic authority count) was
  added by the steering pass in this same PR — the registry now holds 25.
- **Architectural change**: none. Documents created:
  CONSTITUTION, AUTHORITY-MAP, SEMANTIC-MODEL, DATA-FLOW, BOUNDARIES,
  INVARIANTS, MIGRATION-PLAN, VALIDATION-MATRIX, CONTEXT (this page),
  OPEN-QUESTIONS, DECISIONS; this directory's README (index) updated;
  `docs/README.md` ownership row added.
- **Evidence**: six read-only audits (doctrine; core semantics;
  commands/surfaces; governance/state; providers/external surfaces;
  tests/contracts) — five as supervised Orca workers, one as a directly
  supervised agent after its Orca worker stalled on prompt delivery
  ([PD-1](DECISIONS.md#program-decisions)). Two of the loudest provider
  findings were independently spot-checked against source before being
  recorded (Moon edge-vocabulary inversion; the MCP root-import seam
  widening). Audit recommendations: PASS ×5, staged-REWORK ×1 (providers —
  its findings became AUTHORITY-MAP divergences and Phase 1/7 work, not
  blockers). An independent adversarial review
  ([P-B](CONSTITUTION.md#process-articles)) then tried to falsify the control
  plane: 25+ citations spot-checked (all but one verified exact), the
  write-door census survived a code-level cross-check — and the review
  **falsified this map's first formulation of CON-1's instantiation**
  ("`verdictFor` is the only path to exit 1": in truth five verdict carriers
  fold at five sites, only `check` through `verdictFor`). AUTHORITY-MAP,
  INV-2/INV-4, and Phase 1's hardening scope were rewritten on that evidence;
  the corrected claim is the one these pages now carry. The maintainer then
  reviewed PR #727, approved the direction, and issued a nineteen-directive
  steering pass ([PD-7](DECISIONS.md#program-decisions)) — absorbed as
  CON-1's lane/surface distinction, the work-item contract, Phase 1's
  per-item classification and gate table, Phase 2-A, the validation levels,
  the handoff protocol, P-E/P-F, the enumerated P-D stops, evidence-first
  exits, the debt budget, and the document hierarchy — after which an
  independent hostile-reader pass re-read all twelve pages trying to derive
  the nine enumerated misreadings (check-only entry, fold unification,
  Phase-1-as-cleanup-bucket, mandatory Finding object, byte-identity
  everywhere, mandatory federation, verb-per-package, Clean-Architecture
  layering, package-count-as-progress): all nine EXCLUDED, and the three
  internal contradictions plus five residual traps it surfaced (byte-identity
  rows vs the level taxonomy, GAP-A's stdout-vs-levels wording, the INV-row
  count, two DATA-FLOW witness-claim caveats, the "exit code computed outside
  the table" literalism, the Phase 2 exit row ambiguity, Phase 5's OQ
  preconditions, the fixture-corpus name collision, T4's pinned-text
  boundary) were fixed in the same pass.
- **Tests**: none run against the engine (read-only phase); the control plane
  itself is checked by the repository's doc gates.
- **Dependency-graph delta**: none (no code touched).
- **Semantic-ownership delta**: none (no code touched).
- **Risks carried forward**: the doc-divergence riders D1–D6 (Phase 1);
  GAP-A/B (Phase 4 gate), GAP-E (Phase 7), GAP-C/D (Phase 9 recorded
  decisions); registers R1–R7 (Phase 1–2); the silent-default verdict-fold
  inputs across the five carrier sites (Phase 1, INV-4 gap).
- **Rollback point**: revert this PR; no other state exists.
- **Next-phase entry criteria**: Phase 0 accepted (PR merged) → Phase 1 per
  [MIGRATION-PLAN.md](MIGRATION-PLAN.md#phase-1--authority-hardening).

### CHK-1-PREP — Phase 0.5, decision closure & Phase 1 execution baseline (2026-09-05)

- **ID**: CHK-1-PREP. **Phase**: 0.5 (between Phase 0 and Phase 1).
  **Status**: complete; pending merge of this PR.
- **Goal**: close the decisions the evidence already supported, convert every
  remaining question into an owned, gated work item, and turn Phase 1 from an
  abstract checklist into a lock-scoped, PR-sized execution baseline.
  Documentation-only; no code touched.
- **Architectural change**: none. Pages updated: CONSTITUTION (CON-1 scope
  sentence, CON-9 owner pointer, new article
  [P-G](CONSTITUTION.md#process-articles)); AUTHORITY-MAP (carrier
  vocabulary, fold-roster bullet, decision-rights row for `rules verify`,
  may-not-add prohibitions); INVARIANTS (INV-4, INV-25); SEMANTIC-MODEL
  (catalog-integrity row); DATA-FLOW (stage 8); MIGRATION-PLAN (Phase 1
  rebuilt as units 1-A..1-F with locks, gate table, Phase 5 entry,
  cross-cutting rules); OPEN-QUESTIONS (rebuilt as the decision register);
  DECISIONS (record format + PD-8..PD-12); this page; the refactor README;
  `docs/concepts/architecture.md` (the capability words);
  `docs/README.md` (ownership row).
- **Decisions closed** (records in
  [DECISIONS.md](DECISIONS.md#program-decisions)):
  - **PD-8** (OQ-13): `rules verify` is a bounded **artifact-integrity
    verification authority** — outside the architecture enforcement lane; it
    shares the contract (status vocabulary, `EXIT` table, envelope latch),
    not the law; not a "second architecture authority"; the fold-site
    hardening (1-A) still covers `rules.mjs:445-448` as an input-validation
    hardening under its own contract.
  - **PD-9** (OQ-1/DG-5): the capability words are product vocabulary owned
    by `docs/concepts/architecture.md`; CON-9 keeps the constraint and cites
    the owner; no new control-plane vocabulary page.
  - **PD-10** (OQ-2/DG-3): no ADR-0009 — ADR-0008 stays normative for the
    family semantics it accepted; the `{base, head, declarationDigest}`
    composition stays implementation annotation in `evolution-event.mjs`
    witnessed by its tests; SEMANTIC-MODEL stays the living map.
  - **PD-11** (OQ-3): CLI capability regrouping is a **product-surface
    semantic change**; Phase 5's regrouping carries its own maintainer
    decision record before implementation, never bundled with mechanical
    extraction.
  - **PD-12** (record; binding statement is
    [P-G](CONSTITUTION.md#process-articles)): decisions before
    implementation — four-class classification policy; "open" is not a
    license to choose.
- **Verification-required**: OQ-4 (Phase 3), OQ-5/OQ-7/OQ-10 (Phase 2),
  OQ-6 (Phase 3), OQ-9 (GAP-A work, Phase 4 entry), OQ-12 (Phase 1-F). Each
  row in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) names its owner, evidence,
  closing condition, and no-issue outcome.
- **Maintainer-gated**: OQ-8 (GAP-A implementation, Phase 4 entry),
  OQ-11 (Phase 7 entry), OQ-14 (Phase 9 GAP-D).
- **Phase 1 execution baseline** (details in
  [MIGRATION-PLAN.md](MIGRATION-PLAN.md#phase-1--authority-hardening)): six
  PR-sized units with locks —
  1-A `authority-boundary/verdict-folds`; 1-B `authority-boundary/rules-integrity`
  (documentation-only; must not edit `src/commands/rules.mjs` or `cli.mjs`);
  1-C → 1-D `provider-seam` (serialized pair; 1-C's records feed 1-D's
  table); 1-E `state-identity` (headers first, distinct type only if
  demonstrably insufficient); 1-F `documentation-truth` (each rider
  sentence-scoped).
- **Phase 1 PR ordering**: recommended **1-A first** (it hardens the
  evidence every later phase trusts), then the remaining groups may proceed
  per lock disjointness: `{1-A}`, `{1-B, 1-E, 1-F}` and `{1-C → 1-D}` may
  overlap once 1-A lands; 1-C precedes 1-D. Disjointness is proven by the
  dependency graph ([P-F](CONSTITUTION.md#process-articles)), and
  1-B's file isolation keeps it clear of 1-A's territory.
- **Exact next PR target**: **Phase 1-A — verdict-fold hardening** (lock
  `authority-boundary/verdict-folds`; scope, evidence, and rollback in
  [MIGRATION-PLAN.md](MIGRATION-PLAN.md#phase-1-a--verdict-fold-hardening)).
- **Forbidden next moves**: (1) begin any Phase 1 implementation outside the
  six units' scopes and locks; (2) route `rules verify` through
  `buildDecision`/`verdictFor` or into the lane, or create
  `RulesVerifyEngine`/`IntegrityEngine`; (3) add a Finding object before
  2-A's adjudication; (4) start Phase 4 before GAP-A is closed (PD-4);
  (5) regroup verbs before Phase 5's maintainer record (PD-11); (6) draft
  ADR-0009 for event identity, or create a new capability-vocabulary page;
  (7) reopen OQ-1/2/3/13 without new evidence or a maintainer ruling;
  (8) let a worker PR amend the constitution, invariant registry, or
  authority map autonomously (P-E); (9) treat "open" as a decision license
  (P-G).
- **Debt budget**: gaps before — the decision layer itself: OQ-1/2/3/13
  undecided, no classification policy, and the authority map's false
  "same law" claim about `rules verify`; gaps closed — those four OQs, the
  map error corrected across six pages, the P-G policy, and Phase 1 turned
  from 5 abstract items into 6 lock-scoped units; gaps introduced — none
  (documentation-only, no code, no tests, no manifests touched); net delta —
  negative: uncertainty removed, no new gap; the code gap register (G-n,
  GAP-n, INV gaps, D1–D6, R1–R7) unchanged in size.
- **Validation evidence**: the repository's document gates green —
  `check-docs-links`, `check-docs-claims-parity`, `format:check`, `lint`,
  `pnpm test`, `typecheck` — plus a full control-plane consistency pass and
  an independent hostile-reader pass (12 misreadings attempted, none
  derivable); no code diff, no package diff, no generated-artifact drift.
- **Next-phase entry criteria**: Phase 0.5 accepted (PR #729 merged) →
  begin **Phase 1-A** per
  [MIGRATION-PLAN.md](MIGRATION-PLAN.md#phase-1--authority-hardening).

### CHK-1-CLOSE — Phase 1, authority hardening (2026-09-06)

- **ID**: CHK-1-CLOSE. **Phase**: 1. **Status**: complete; every exit-gate
  row PASS with reviewed evidence
  ([MIGRATION-PLAN.md](MIGRATION-PLAN.md#phase-1--authority-hardening)).
- **Goal**: harden the verdict-fold inputs against the silent direction
  (1-A); verify the `rules verify` classification against source (1-B);
  adjudicate the Moon provider's policy surface per item (1-C); define the
  provider seam as a source-verified contract (1-D); pin the two
  edge-identity spellings against each other (1-E); close the six
  documentation divergences (1-F). Contract clarity throughout; no
  abstraction created.
- **Units**:
  - 1-A → PR #730 (`1e72eb0`): refusal latches at all five fold sites
    (`verdictFor`, delta/change/fitness folds, `rules verify` fold, CLI
    exit folds); red-by-construction twins planted, demonstrated red,
    restored; valid-input fixtures byte-identical; exit-matrix green.
    Behavior change by design (malformed inputs now refuse instead of
    folding to zero), named in the changelog.
  - 1-B → PR #731 (`b31aaa6`): dated PD-8 verification extension in
    DECISIONS.md; AUTHORITY-MAP re-read true against source; every line
    ref re-measured after 1-A's merge; no `packages/` change.
  - 1-C → PR #734 (`e58b29d`): MOON-POLICY.md adjudicates all five embedded
    policies — three contract-backed normalizations (root-edge domain
    exclusion; the #262 vocabulary inversion; the #280 scope collapse) and
    two recorded provider policies
    ([ADR 0009](../../adr/0009-moon-derived-tags-provider-policy.md),
    [ADR 0010](../../adr/0010-moon-workspace-layout-inference.md)); registry
    roster pin; no silent retention.
  - 1-D → this PR: the six-column per-provider contract table in
    [BOUNDARIES.md](BOUNDARIES.md#provider-seam) — Acquisition,
    Normalization, Bounded derivation, Failure/loudness, Canonical output,
    Consumer — for Nx, native, Moon, and the LSP's private path; the
    responsibility ladder (Acquisition → Normalization → Bounded derivation
    → Canonical engine input → Evaluation) stated once and cited by
    Phase 2-A; LSP divergence registered as "collapses in Phase 7" with its
    Current/Target/Phase/Reason block. No `packages/` change; no new
    abstraction (the Phase 7 coupling note records the three provider-object
    shapes without proposing an interface).
  - 1-E → PR #732 (`63ed90d`): both identity headers cross-referenced
    (ADR-0008 + INV-6); headers-first chosen over a distinct type, review
    upheld; identity suites green; manifest digests updated.
  - 1-F → PR #733 (`3c8deb0`): all six riders closed; D6 re-measured
    against the GitHub rulesets API at fix time; coordinator review caught
    and fixed two defects before merge (a false custom-rule
    `not_applicable` emission claim; a missing fourth emission site).
- **Invariants touched**: INV-2/INV-4 gap (five fold sites now refuse
  malformed inputs; twins pin the silent direction); INV-6 (1-E pins);
  INV-9 adjudication half (1-C) and seam-table half (1-D); INV-18 digests
  updated in 1-A, 1-E, 1-F. INV-2's gap column and INV-4's wording now
  reflect the latch; INV-9's "policy adjudication" half closed.
- **Canonical ownership changes**: none — no semantic moved, no rename, no
  new canonical object. PD-8's classification verified from source; the
  observed/normalized/derived/evaluated/decided ladder is documented as an
  implementation boundary pending 2-A's ruling.
- **Dependency-boundary changes**: none inside `packages/`; BOUNDARIES.md's
  provider-seam section becomes the contract table the LSP collapse (Phase 7) and import-direction scan (Phase 3) cite.
- **Contracts affected and compatibility classification**: 1-A —
  Semantic change on the 0.x line (minor, behavior change named in the
  changelog: what an unchanged-but-malformed workspace is told differs);
  1-B–1-F — documentation/contract clarification, code pin-only.
- **Differential evidence**: exit-matrix green (1-A, both CI legs);
  identity suites 143 tests (1-E); Moon suite 177 tests (1-C);
  `check-docs-claims-parity` green in CI for every landed PR; the docs
  gates (`check-docs-links`, `format:check`) green locally for this PR.
- **Provider seam status**: contract landed; both faces share
  `requireSingleProjectModel`; Moon items 4–5 recorded as provider-owned
  derived inputs with enforcement consequences (cited, not re-judged);
  the LSP private path (:398–533) registers as temporary divergence.
- **Unresolved questions**: OQ-15 (new, `workspaceLayoutSource` provenance
  overclaim — owner Phase 2-A); OQ-4/5/6/7/9/10 unchanged (Phases 2/3,
  GAP-A); OQ-8/11/14 maintainer-gated; OQ-12 closed by 1-F's D6 (dated
  ruleset measurement). Divergence 1 and 4 closed;
  divergences 2 (LSP) and 3 (MCP seam) remain, owned by Phase 7.
- **Deferred findings**: none BLOCKER for Phase 2. The workspaceLayoutSource
  vocabulary widening is a recorded cost (ADR 0010), not a blocker; the
  LSP/MCP divergences pre-date Phase 1 and carry Phase 7 ownership.
- **Rejected approaches**: fold unification through `verdictFor` (PD-6 —
  semantics change, not conformance); routing `rules verify` through
  `buildDecision`/`verdictFor` (PD-8); a distinct edge-identity type (1-E
  demonstrated headers suffice); `IProvider`-style seam abstraction for
  symmetry (1-D: contract clarity, no interface); "provider = observation
  only" as the seam sentence (replaced by the four-stage ledger); widening
  `workspaceLayoutSource` in this PR (its own compatibility-classified
  change, owned by Phase 2-A); closing historical findings that current
  main already invalidated.
- **Debt budget**: before — five unhardened fold sites, an unadjudicated
  Moon policy surface, six stale doc sentences, unpinned identity
  spellings, an unverified PD-8 record, an undefined provider seam; closed
  — all six; introduced — the recorded-not-fixed `workspaceLayoutSource`
  provenance cost (now OQ-15; ADR-0010 names it) and the Phase-7 LSP/MCP
  citations (pre-existing, now cited from the seam table, not new); net —
  negative: uncertainty removed with no new gap.
- **Validation evidence**: `check-docs-links` (0), `format:check` (0),
  targeted suites as listed above, `moon run`-equivalent CI legs per PR.
  Claims-parity green in CI. Semantic correctness is argued from the
  per-PR reviewed evidence recorded above, not from gates alone.
- **Next-phase entry criteria**: Phase 1 exit recorded (this PR merged) →
  begin **Phase 2-A — Canonical semantic audit**, whose entry brief is
  written into
  [MIGRATION-PLAN.md](MIGRATION-PLAN.md#phase-2--canonical-model-hardening).
  No code; no package moves; no Finding canonicalization before 2-A's
  recorded, maintainer-approved adjudication.

## Conventions maintained here

- Phase completions append a CHK-n block above, never edit an old one.
- Status changes in the table land in the same PR that earns them.
- Every CHK-n reports the architectural debt budget
  ([MIGRATION-PLAN.md](MIGRATION-PLAN.md#cross-cutting-rules)): gaps before,
  gaps closed, gaps introduced, net delta.
- Every architectural PR's handoff fills all eleven fields of the
  [handoff protocol](#handoff-protocol-mandatory) above.
- The audit reports behind CHK-0 were session artifacts (`/tmp`); the control
  plane is the durable record — anything load-bearing from them is already
  in these pages with citations.
