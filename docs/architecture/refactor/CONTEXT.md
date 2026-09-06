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

| Phase                                               | Status                              | Record                      |
| --------------------------------------------------- | ----------------------------------- | --------------------------- |
| 0 — Architecture cartography                        | **complete** (PR #727 merged)       | CHK-0 below                 |
| 0.5 — Decision closure & Phase 1 execution baseline | **complete** (PR #729 merged)       | CHK-1-PREP below            |
| 1 — Authority hardening                             | **complete** (PRs #730–#734 + #736) | CHK-1-CLOSE below           |
| 2 — Canonical model hardening                       | in progress — 2-B pinned (PR #745)  | CHK-2-A, CHK-2-B below      |
| 3 — Boundary enforcement                            | not started                         | blocked by 2                |
| 4 — Internal extraction                             | not started                         | **blocked by GAP-A** (PD-4) |
| 5 — Capability facades                              | not started                         | blocked by 4                |
| 6 — CLI recomposition                               | not started                         | blocked by 5                |
| 7 — Additional surfaces                             | not started                         | blocked by 6                |
| 8 — Federation readiness                            | not started                         | maintainer-gated            |
| 9 — Final hardening                                 | not started                         | blocked by 8 (or waiver)    |

Tracking: issue #725 (the program), PR #727 (Phase 0's control plane), PR
#729 (Phase 0.5), PRs #730–#734 (Phase 1 units A, B, E, F, C), PR #736
(the Phase 1 close), PR #740 (the 2-A adjudication record), and this PR
(#745 — the 2-B relationship pins, branch `refactor-2b-relationship-pins`).

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
- **Close-time hostile review** (2026-09-06, constitution article P-B): a
  ten-vector adversarial pass over this PR's seam contract and the
  reconciled control plane, findings dispositioned in this same PR — two
  blocking (the Moon row omitted the `moon:declared` targets synthesis the
  native row's twin already recorded; the LSP row's failure cell claimed
  "nothing escapes the index build as a throw" while one throw class does)
  plus the minor set (empty-graph guards are presence-guards; annotation
  is caller-side on all paths, not LSP-only; `buildGraph`'s site; the
  test-count roster above), each fixed or roster-defined here. The VS Code
  two-marker gap the review surfaced is filed as #735 rather than ridden
  onto a docs PR.
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
  identity suites 143 tests (1-E — the `diff`, `trajectory`, and
  `evolution-event` suites composed); Moon suite 177 tests (1-C — the
  `moon` and `adr-registry` suites composed);
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

### CHK-2-A — Phase 2, 2-A canonical semantic audit (2026-09-06)

- **ID**: CHK-2-A. **Phase**: 2 (item 2-A). **Status**: complete — the
  adjudication is recorded ([PD-13](DECISIONS.md#program-decisions),
  [PD-14](DECISIONS.md#program-decisions)) and maintainer-approved;
  pending merge of PR #740.
- **Goal**: adjudicate the canonical semantic audit — one outcome per
  audited concept (a/b/c), the provider ladder's standing, per-item
  verdicts for the bounded-derivation candidates — and close the open
  questions the audits raised, before any 2-B code.
- **Invariants touched**: none in code (a docs-only record). R4's
  documented validation timing corrected to the measured behavior (write
  validates identity; vocabulary is read-time); INV-9's
  policy-adjudication half closes with
  [BOUNDARIES.md](BOUNDARIES.md)'s verdict ledger.
- **Canonical ownership changes**: no owner moved, no rename.
  [SEMANTIC-MODEL.md](SEMANTIC-MODEL.md) gains the 2-A outcomes table;
  Decision's two meanings are split by meaning (envelope =
  `buildDecision` in `governance/verdict.mjs`; ADR record =
  `adr-registry`); trajectory's consumption edges are stated (OQ-10).
- **Dependency-boundary changes**: none inside `packages/`;
  [BOUNDARIES.md](BOUNDARIES.md)'s seam table resolves its four
  `verdict-pending` markers into the recorded ledger — seven candidates,
  six verdicts (b), one no-verdict — plus the `workspaceLayoutSource`
  vocabulary contract ([PD-14](DECISIONS.md#program-decisions)).
- **Contracts affected and compatibility classification**:
  DOCUMENTATION-CONTRACT CLARIFICATION only. WI-1 (#737's fix) will be a
  0.x minor when it lands; #738/#739 take the same lane in their own PRs.
- **Differential evidence**: the audit's own — four read-only audits over
  `eee9d22`, plus OQ-7 **executed**: the same clean workspace emits a
  drift-free `pass` from `fitness` and `fail` from `decisions` (root
  measured at `decisions.mjs:126-136` vs `fitness.mjs:221-240`).
- **Architectural debt budget**: before — four open questions (OQ-5/7/10/
  15), four verdict-pending seam markers, R4's mis-stated timing, the
  unscoped byte-identity claim in
  [`docs/concepts/reconciliation.md`](../../concepts/reconciliation.md);
  closed — all of them; introduced — work items WI-1..WI-6 (recorded,
  owner-named; WI-1 = #737's approved fix); net — negative.
- **Unresolved questions**: none new. OQ-4/6/9 remain VERIFICATION
  REQUIRED (Phase 3 / GAP-A); OQ-8/11/14 maintainer-gated. WI-2 (fold the
  provenance bypass or ADR it) and WI-6 (`recordDecisionLifecycle`
  wire-or-delete) carry maintainer gates at their own PRs.
- **Rejected approaches**: a canonical Finding object (CON-3); unifying
  Evidence or Evaluation into one type; a named-type ladder model (its
  revisit trigger renamed to mid-ladder entry); widening
  `workspaceLayoutSource` (PD-14 keeps two values); folding #738/#739
  fixes into this docs PR (separate correctness-hardening PRs).
- **Forbidden next moves and the next objective**: do not start 2-B
  before this PR merges; do not canonicalize a Finding, Evidence, or
  Evaluation object (ruled (c)); do not alter the seam's recorded
  verdicts without a new adjudication; do not fix #737/#738/#739 on this
  branch. Next: **2-B — relationship pins** per outcome (c)
  ([MIGRATION-PLAN.md](MIGRATION-PLAN.md#phase-2--canonical-model-hardening)),
  and in parallel WI-1 through its own gate (#737 → branch → draft PR).

### CHK-2-737 — Phase 2, correctness fix: decisions' fitness mirrors the sanctioned construction (#737 → PR #743) (2026-09-06)

- **ID**: CHK-2-737. **Phase**: 2 correctness-hardening unit. **Status**:
  complete — pending merge of PR #743.
- **Goal**: close #737 — the audit found decisions' `fitnessVerdictsFor`
  constructing its verdicts independently of `fitness.mjs`'s sanctioned
  construction: a second spelling of one law, free to diverge silently.
  Fix: mirror `fitness.mjs`'s construction byte-for-byte behind a
  cross-reference header — no shared module, PD-13's restatement-over-seams
  precedent — and harden the refusal path: `driftForCheck` refusals
  (unreadable/invalid `architecture-intent.json`, unregistered-plugin
  graph) now exit 3 from `decisions` as they already did from `fitness`.
- **Invariants touched**: INV-18 / PD-5 — the intent manifest's `cli.mjs`
  evidence digest is re-pinned in this same PR (same-PR re-certification;
  Contract B's recorded digest now matches the shipped bytes).
- **Canonical ownership changes**: none — `fitness.mjs` stays the sole
  owner of the construction; decisions restates it at its own seam.
- **Dependency-boundary changes**: none.
- **Contracts affected and compatibility classification**: behavior change
  on the refusal path only — `decisions` exits 3 where it previously
  proceeded from an unverified manifest; verdict outputs byte-identical
  for every non-refusal input. Classified CORRECTNESS HARDENING, lands on
  the 0.x line. The exit-3 consequence is disclosed in the PR body
  ("Consumer impact").
- **Differential evidence**: an independent adversarial review APPROVED —
  the mirror construction verified byte-for-byte against `fitness.mjs`;
  `intent.test.mjs` 58/58 after the digest re-pin; the full
  check-packages battery green across all nine packages (lefthook
  pre-commit); CI re-run green on the re-pinned head.
- **Debt budget**: before — a free-to-diverge second construction plus a
  fail-open refusal path (the silent direction #737); closed — the mirror
  with a cross-ref header and fail-closed refusals; introduced — the
  maintenance duty the mirror owes (bound by its header and the digest
  tripwire); net — negative.
- **Unresolved questions**: none new.
- **Rejected approaches**: a shared module for the two constructions
  (PD-13 (c) — the seams are the point); leaving exit code 0 on refusal
  (a refusal answered as success is the invariant's silent direction);
  widening the manifest schema (no consumer asked).
- **Forbidden next moves / next**: none carried. Next: #742's closeout,
  then 2-C after #745 merges.

### CHK-2-B — Phase 2, 2-B relationship pins (2026-09-06)

- **ID**: CHK-2-B. **Phase**: 2 (item 2-B). **Status**: complete —
  pending merge of PR #745.
- **Goal**: implement 2-A's outcome (c) for Finding — the four judgment
  sites and the `check.mjs` normalization seam carry the relationship
  pins in their own headers, where a refactor actually edits.
- **Invariants touched**: none behaviorally — comment/header-only change;
  [CON-1](CONSTITUTION.md#con-1--one-enforcement-authority) and INV-25
  restated, not moved. INV-18's tripwire ran green: the manifest holds no
  evidence entries for the five touched files, so no digest update was
  owed.
- **Canonical ownership changes**: none — no owner moved, no rename, no
  new type; the pins bind the already-adjudicated relationships.
- **Dependency-boundary changes**: none.
- **Contracts affected and compatibility classification**: none — zero
  executable, test, registry, or manifest bytes changed; outputs
  byte-identical.
- **Differential evidence**: comment-only diff proven two-directionally
  (`+50/−1`; the −1 is the replaced one-line JSDoc above `violationOf`);
  targeted suites green (rules/index, edge-constraints, go-work,
  tsconfig-paths); CI `ci-gate` + `analysis-gate` green; an independent
  adversarial review APPROVED — the comment-only claim re-proven, pins
  re-verified against [AUTHORITY-MAP.md](AUTHORITY-MAP.md) and
  [SEMANTIC-MODEL.md](SEMANTIC-MODEL.md), suites regenerated.
- **Debt budget**: before — the families' relationships lived only in
  this control plane, invisible at the sites a refactor edits; closed —
  the pins sit at the sites; introduced — none; net — negative.
- **Unresolved questions**: none new. Phase 2 remaining: 2-C, 2-D
  (+WI-3/4/5), 2-E, the correctness fixes (#737 → #743, #738 → #744,
  #739 → #741), WI-6 (#746); WI-2 ruled (fold into `policy.mjs`'s
  ladder, maintainer 2026-09-06) and dispatches after #741 merges.
  [PD-17](DECISIONS.md#program-decisions) records the refactor-unit
  issue routing.
- **Rejected approaches**: a shared Finding module
  ([PD-13](DECISIONS.md#program-decisions) ruled (c)); line-number
  citations in headers (drift); control-plane-only pins (the sites are
  what a refactor edits).
- **Forbidden next moves / next**: 2-C (message registries) must not
  start before this PR merges — its files (`go-work.mjs`,
  `tsconfig-paths.mjs`) overlap this PR's files. Next: 2-C per
  [MIGRATION-PLAN.md](MIGRATION-PLAN.md#phase-2--canonical-model-hardening).

### CHK-2-738 — Phase 2, correctness fix: evolution-store write validation (#738 → PR #744) (2026-09-06)

- **ID**: CHK-2-738. **Phase**: 2 correctness-hardening unit. **Status**:
  complete — pending merge of PR #744.
- **Goal**: close #738 — the evolution store's write path persisted events
  whose identity fields or disposition vocabulary it had not validated, so
  bytes the read path later narrates were never checked at the door that
  could refuse them.
- **Invariants touched**: INV-6's write half — the store now validates
  identity and vocabulary before persisting. The INV-6 gap-line rewrite is
  deliberately deferred to #741's closeout: it names both halves, and one
  edit in one PR beats a two-PR conflict in INVARIANTS.md.
- **Canonical ownership changes**: none.
- **Dependency-boundary changes**: none.
- **Contracts affected and compatibility classification**: behavior change
  at the write door only — invalid identity or vocabulary is now refused
  before persist; read-path messages byte-identical (differential-proven).
  Classified CORRECTNESS HARDENING, lands on the 0.x line per the
  program's standing classification.
- **Differential evidence**: an independent adversarial review APPROVED —
  it re-ran a 9-case byte-identity differential of read-path messages;
  `evolution-store.test.mjs` green; CI `ci-gate` + `analysis-gate` green.
- **Debt budget**: before — a store write that could not refuse malformed
  identity or vocabulary (the silent data-integrity gap #738); closed —
  write-side validation; introduced — none; net — negative.
- **Unresolved questions**: none new. The read-side vocabulary validation
  and the disposition-latch throw land via #741.
- **Rejected approaches**: folding into the 2-A docs PR (correctness
  fixes ride their own repro-first PRs); answering stranger statuses with
  `no-verdict` (that shape belongs to the disposition latch, #739 → #741).
- **Forbidden next moves / next**: none carried. Next: #741 merges, then
  WI-2 (the `provenance-command.mjs` bypass fold into `policy.mjs`'s
  ladder) dispatches — P-F holds one disposition law per PR.

### CHK-2-739 — Phase 2, correctness fix: disposition latch (#739 → PR #741) (2026-09-06)

- **ID**: CHK-2-739. **Phase**: 2 correctness-hardening unit. **Status**:
  complete — pending merge of PR #741.
- **Goal**: close #739 — `reconcileDisposition` accepted stranger statuses
  (anything outside `ok`/`findings`/`no-verdict`) by falling through to a
  default mapping, so an out-of-vocabulary byte could flow into a recorded
  disposition instead of being refused. Fix shape: latch-and-throw at the
  mapping site, matching `verdictFor`'s input-latch discipline; every
  in-vocabulary mapping, `ok→accepted` included, byte-identical.
- **Invariants touched**: INV-6's read half — the read path now validates
  vocabulary against stored bytes and the mapping latches throw on
  strangers. This PR carries the full INV-6 gap-line rewrite (both halves,
  per CHK-2-738's deferral); #744 merges first, so the rewritten line cites
  landed evidence when this PR lands.
- **Canonical ownership changes**: none.
- **Dependency-boundary changes**: none.
- **Contracts affected and compatibility classification**: behavior change
  — stranger statuses now throw instead of silently mapping;
  `buildEvolutionSummary` exported for the pin (precedent:
  `deltaDisposition`). Classified CORRECTNESS HARDENING, lands on the 0.x
  line per the program's standing classification.
- **Differential evidence**: an independent adversarial review APPROVED —
  byte-identity of all in-vocabulary mappings proven, exports map
  untouched; `delta-events.test.mjs` + `evolution.test.mjs` green (319
  tests across the 12-file delta/evolution family); package-wide
  `typecheck` exit 0 after the strict-checkJs test-argument fix;
  CI `ci-gate` + `analysis-gate` green on the fix head, and this
  docs-only delta re-runs it.
- **Debt budget**: before — a disposition mapping that could not refuse a
  stranger byte (the silent-vocabulary gap #739); closed — latch-and-throw
  plus read-side validation; introduced — none; net — negative.
- **Unresolved questions**: none new.
- **Rejected approaches**: answering strangers with `no-verdict` (a
  stranger byte is a contract breach, not a verdict); widening the
  vocabulary (no consumer asked); a shared latch module across
  delta/evolution (P-F: one disposition law per PR, no new seam).
- **Forbidden next moves / next**: WI-2 (the `provenance-command.mjs`
  bypass fold into `policy.mjs`'s ladder) dispatches only after this PR
  merges — P-F holds one disposition law per PR; PD-15 (the fold ruling)
  records on WI-2's own PR.

### CHK-2-735 — Phase 2, correctness fix: vscode client workspace-marker copy (#735 → PR #742) (2026-09-06)

- **ID**: CHK-2-735. **Phase**: 2 correctness-hardening unit. **Status**:
  complete — pending merge of PR #742.
- **Goal**: close #735 — the vscode client's `WORKSPACE_MARKERS` in
  `workspace-root.mjs` had drifted from the server's marker list in
  `commands/context.mjs`: a folder the server accepts as a workspace
  root the client could refuse. Fix: the client list re-pinned to the
  server's four markers (`nx.json`, `archkeep.json`,
  `.moon/workspace.yml`, `.config/moon/workspace.yml`), the copy bound
  by tests in both directions.
- **Invariants touched**: CON-1 adjacent — one workspace-root law, two
  faces; the pins make the copy's drift loud instead of silent. Removal
  detection is explicit: the primary markers are pinned by literal name
  (review Finding A, folded), so deleting any entry turns the suite red.
- **Canonical ownership changes**: none — the server's `commands/context.mjs`
  list stays the law; the client restates it at its own seam (PD-13's
  restatement precedent), with the walk-bounds divergence documented in
  the header (Finding B, folded): the server stops at the enclosing git
  top level; the client walk climbs to the filesystem root as a pure
  function over an editor-supplied folder and spawns no git.
- **Dependency-boundary changes**: none.
- **Contracts affected and compatibility classification**: none — the
  client's activation behavior converges to the server's; vscode-package
  only, no engine surface touched.
- **Differential evidence**: an independent adversarial review APPROVED
  with its findings folded in-branch; the full package suite 50/50 and
  the walk file 12/12; CI `ci-gate` + `analysis-gate` green; the marker
  list compared entry-by-entry against `src/commands/context.mjs` in review.
- **Debt budget**: before — a silent copy that could gate activation on
  the wrong roots (the drift #735); closed — pinned copy plus a
  documented divergence; introduced — the copy's maintenance duty, bound
  by its pins; net — negative.
- **Unresolved questions**: none new. Review Findings C (vscode-facing
  prose still Nx-centric; `.cs` missing from a documented route list)
  and D are recorded follow-ups for the 2-E docs PR.
- **Rejected approaches**: importing the server's list at runtime (the
  vscode package is a pure-function client and must not bundle the
  engine); a shared constants package (a new surface for one list).
- **Forbidden next moves / next**: none carried. Next: 2-E folds
  Finding C.

### CHK-2-WI6 — Phase 2, WI-6: delete the dormant decision-lifecycle write surface (#746) (2026-09-06)

- **ID**: CHK-2-WI6. **Phase**: 2 work item WI-6. **Status**: complete —
  pending merge of PR #746. The maintainer's delete ruling is recorded as
  [PD-16](DECISIONS.md#program-decisions) (below, in DECISIONS).
- **Goal**: execute WI-6 — the dormant `recordDecisionLifecycle` surface
  (the writer, `DECISION_LIFECYCLE_KINDS`, the `DecisionLifecycleRecord`
  typedef, its two test blocks, and the stale
  `docs/concepts/provenance.md` section claiming it live) deleted;
  `recordOrigin` stays the single `on` producer, consumed by row-schema,
  delta, and evolution.
- **Invariants touched**: CON-6 semantic conservation — deleting an
  unreachable write surface moves no verdict; INV-8's write-door census
  shrinks by one dormant door. The canonical row is repaired in this PR:
  SEMANTIC-MODEL's "Origin / decision-lifecycle records" names one owner
  again (independent review flagged the stale co-owner cell; it lands
  here, coordinator-side, per P-A).
- **Canonical ownership changes**: one owner **removed** —
  `recordDecisionLifecycle` leaves the canonical table; `recordOrigin`
  is sole owner of the row. That removal is the work item, not drift.
- **Dependency-boundary changes**: none.
- **Contracts affected and compatibility classification**: none reachable
  — SAFE/internal-only verified TRUE: the exports map, entry re-exports,
  and CLI roster never named the surface; the CLI roster gate ran green.
- **Differential evidence**: an independent adversarial review APPROVED —
  census regenerated (zero live consumers at main, whole-tree), the
  surviving half untouched, the diff re-measured `+0/−349` with no drift,
  the 18-file/478-test consumer sweep reproduced, and
  `tsc -p tsconfig.json` clean; CI green (all twelve checks).
- **Debt budget**: before — a dormant write surface implying an engine
  capability that never existed, with docs claiming it; closed — deleted
  with its tests and stale prose; introduced — none; net — negative.
- **Unresolved questions**: none new. Dormant-marked historical records
  (SEMANTIC-MODEL's lifecycle note at :174, CHK-2-A, the DECISIONS
  history) stay as history.
- **Rejected approaches**: folding the surface into `decisions` (invents
  a write the engine never had); keeping it dormant behind a pin (a pin
  defending bytes nothing calls is maintained weight).
- **Forbidden next moves / next**: none carried. Next: 2-C (#747) —
  with this PR merged, every Phase-2 fix unit will have landed.

### CHK-2-C — Phase 2, 2-C: the three message registries collapse to one home (2026-09-06)

- **ID**: CHK-2-C. **Phase**: 2 (item 2-C). **Status**: complete —
  pending merge of PR #747.
- **Goal**: execute 2-C — the message-template registries' one home with
  per-domain tables: `GO_WORK_MESSAGES`/`GO_WORK_MESSAGE_IDS` and
  `TSCONFIG_PATHS_MESSAGES`/`TSCONFIG_PATHS_MESSAGE_IDS` moved verbatim
  from `src/go-work.mjs` and `src/tsconfig-paths.mjs` into
  `src/rules/messages.mjs`; `MESSAGES`/`MESSAGE_IDS`/`renderMessage`
  untouched; `report/sarif.mjs` derives its descriptors from the one
  module.
- **Invariants touched**: CON-4 (canonical semantic models) — one home
  for message templates, the out-of-home spellings removed. Byte-identity
  is structural, not asserted: finding construction renders sentences
  inline and never stores table strings.
- **Canonical ownership changes**: none — the tables moved homes; the
  owning concept (the message vocabulary) keeps one owner, now literal:
  every full template literal appears exactly once under
  `packages/archkeep/src`.
- **Dependency-boundary changes**: none — the moved tables joined the
  same module's exports; no import edge changed shape.
- **Contracts affected and compatibility classification**: none —
  performance/internal: rendered bytes identical, no exported API moved
  (the tables were module-private), no message changed. Verified TRUE by
  the unmodified pins and the differential evidence below.
- **Differential evidence**: independent adversarial review APPROVED —
  16/16 byte-falsification checks identical (both moved tables, both id
  arrays, `renderMessage` over all 15 boundary ids including the
  missing-data-key case, `sarifRules()` JSON old vs new); the pin files
  (`messages.test.mjs`, `upstream.integration.test.mjs`) diff-empty vs
  base and passing; VALIDATION-MATRIX differential rows 1 and 12 green;
  full suite 215 files / 5778 tests green; eslint, tsc, prettier and
  check-docs-links green.
- **Debt budget**: before — two verbatim table copies a refactor could
  silently diverge; closed — one home, duplication grep-verified zero;
  introduced — none; net — negative.
- **Unresolved questions**: none new. The `architecture-intent/judge.mjs`
  docstring pointer folded in this PR (comment-only).
- **Rejected approaches**: per-domain modules (three files again — one
  shape, three spellings); re-exporting the old paths as aliases (a
  compatibility surface for a module-private table); touching
  `renderMessage` (the pins own its bytes).
- **Forbidden next moves / next**: none carried. Next: 2-D per
  [MIGRATION-PLAN.md](MIGRATION-PLAN.md#phase-2--canonical-model-hardening).

### CHK-2-WI2 — Phase 2 work item, WI-2: provenance joins the shared policy ladder (2026-09-06)

- **ID**: CHK-2-WI2. **Phase**: 2 (work item WI-2). **Status**: complete —
  pending merge of PR #748.
- **Goal**: fold `provenance`'s private boundary-law resolution (the
  `loadConfigOverride ?? loadBoundaryConfig` read plus its inline
  `configRows` walk) into `commands/policy.mjs`'s shared `resolvePolicy`
  ladder; the attestation walk and report rendering untouched; zero
  `loadConfigOverride` references remain under `packages/`.
- **Invariants touched**: the ladder stays the one boundary-law path —
  every command that reads a law resolves it through `resolvePolicy`
  (`commands/policy.mjs`'s preamble;
  [BOUNDARIES.md](BOUNDARIES.md) policy-ladder section).
- **Canonical ownership changes**: boundary-law resolution for
  `provenance` moves from a command-private walk to the ladder; no new
  owner — one fewer off-ladder consumer.
- **Dependency-boundary changes**: none — `provenance-command.mjs`
  already imports from `commands/` (`./policy.mjs`); no edge changed
  shape.
- **Contracts affected and compatibility classification**: semantic —
  three reachable deltas on shapes no current fixture exercises: profiled
  workspaces resolve through the registry (the private walk misread the
  profile name as a filename — the P1-26 defect class); malformed laws
  exit 3 via `policyFrom`; a native tree whose `boundaryConfig` file
  carries a `coverage` key refuses with the ladder's second-channel
  error (previously rendered a report, exit 0). Classification PENDING a
  PD decision record — maintainer-gated follow-up, not decided here; the
  compatibility contract names a change to what is reported on an
  unchanged workspace a breaking-class semantic change on the 0.x line.
- **Differential evidence**: adversarial scout verdict APPROVE — old vs
  new `provenanceCommand` byte-identical over the ladder's string-law,
  well-formed inline-object and absent-law shapes; scoped suites 285/285;
  the P1-26-class case has teeth proven by stash-reverting the fold (its
  test fails); the coverage-channel refusal has a new witness (exit 3
  naming `archkeep.json`'s `coverage.exempt`); the repo fixture's
  `provenance` renders byte-identical pre/post fold; the full pre-push
  gate battery green.
- **Debt budget**: before — one command resolving the law off-ladder,
  the P1-26 class reachable there; closed — zero off-ladder consumers;
  introduced — two witness tests; net — negative.
- **Unresolved questions**: (1) the PD decision record for the named
  deltas — maintainer-gated, written separately, never silently;
  (2) two doc nits parked to WI-5: `commands/policy.mjs`'s preamble still
  says "eleven sites"/"eleven callers" (provenance makes twelve) and
  `cli.mjs`'s `runProvenance` JSDoc omits the ladder refusal among its
  exit-3 sources. Both outside this PR's closed file set.
- **Rejected approaches**: `--config` on `provenance` (a second
  resolution surface no consumer asked for); keeping the private walk
  (the defect class stays reachable); folding report rendering into the
  ladder (report bytes are pinned — not this work item's contract).
- **Forbidden next moves / next**: the two WI-5 doc fixes must not ride
  this PR (closed file set). Next: WI-5 (comment-only), then 2-D per
  [MIGRATION-PLAN.md](MIGRATION-PLAN.md#phase-2--canonical-model-hardening).

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
