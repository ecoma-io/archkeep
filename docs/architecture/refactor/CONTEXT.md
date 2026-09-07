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

| Phase                                               | Status                                                                                            | Record                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------ |
| 0 — Architecture cartography                        | **complete** (PR #727 merged)                                                                     | CHK-0 below              |
| 0.5 — Decision closure & Phase 1 execution baseline | **complete** (PR #729 merged)                                                                     | CHK-1-PREP below         |
| 1 — Authority hardening                             | **complete** (PRs #730–#734 + #736)                                                               | CHK-1-CLOSE below        |
| 2 — Canonical model hardening                       | **complete** — all units + the exit record (PD-15) landed (PRs #740–#749, #753, #754, #757, #759) | CHK-2-A–CHK-2-PD15 below |
| 3 — Boundary enforcement                            | **complete** — all units + the exit checkpoint landed (PRs #762–#765, #766)                       | CHK-3 below              |
| 4 — Internal extraction                             | **complete** — GAP-A + GAP-B closed (PR #767); no proven extraction (CHK-5)                       | CHK-4, CHK-5 below       |
| 5 — Capability facades                              | **complete** (PR #772 merged as 60f0e7d2)                                                         | PD-18, CHK-6             |
| 6 — CLI recomposition                               | **complete** (PR #775)                                                                            | CHK-7 below              |
| 7 — Additional surfaces                             | **complete** — all four units landed (PRs #776, #777, #786, #787)                                 | CHK-9 close below        |
| 8 — Federation readiness                            | **recorded** — runway record landed, no machinery (PR #791)                                       | CHK-10 below             |
| 9 — Final hardening                                 | **recorded** — maturity gate scored, GAP-C/D disposed (PR #792)                                   | CHK-11 below             |

Tracking: issue #725 (the program), PR #727 (Phase 0's control plane), PR
#729 (Phase 0.5), PRs #730–#734 (Phase 1 units A, B, E, F, C), PR #736
(the Phase 1 close), PR #740 (the 2-A adjudication record), PRs #741–#744
(the post-audit fixes: #739's disposition latch, the vscode Moon-marker
walk, the decision-fitness leg, the evolution write-time refusal), PR #745
(the 2-B relationship pins), PRs #746–#748 (the dormant lifecycle-surface
deletion, the one message registry, provenance config through the policy
ladder), PR #749 (the WI-5 ladder preamble), PR #754 (the 2-D
module-header pins), PR #753 (the 2-E register closeout), PR #757
(R1's boundary sentence — the last 2-E tail), and PR #759 (the PD-15
fold-decision record — Phase 2's exit), PRs #762–#765 (Phase 3's units:
the G-1/G-5/G-2 scans, the G-7 orphan detector and its test-support
roster, the intra-`src/` DAG statement, the G-3/G-4/G-6/G-8
dispositions), and PR #766 (the Phase 3 exit checkpoint), and PR #767
(Phase 4 entry gate: golden-output corpus + GAP-A/B), PR #772 (Phase 5:
capability facades), PR #774 (CHK-6), and PR #775 (Phase 6's units + exit
checkpoint), and PR #776 (Phase 7 adjacent hardening: the spawn-budget and
help-roster fixes), PR #777 (GAP-E: the LSP golden-response corpus), PR
#787 (the MCP seam: `adr` preamble into the commands layer), and PR #786
(the 7-A LSP provider convergence, stacked on #777), and PR #791 (Phase 8:
the federation-readiness runway record), and PR #792 (Phase 9: the scored
maturity gate, the GAP-C/GAP-D dispositions, and the final program close).

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

### CHK-2-WI5 — Phase 2 work item, WI-5: the ladder's own prose counts provenance (2026-09-06)

- **ID**: CHK-2-WI5. **Phase**: 2 (work item WI-5). **Status**: complete —
  pending merge of PR #749.
- **Goal**: retire the two documentation claims WI-2's fold made stale —
  `commands/policy.mjs`'s preamble (the "eleven sites"/"eleven callers"
  count and the command enumeration gain `provenance`, with its
  private-walk history named) and `cli.mjs`'s `runProvenance` JSDoc
  (the ladder's refusal named among the exit-3 sources). Comment-only —
  no executable line changed.
- **Invariants touched**: none — prose only. The count the preamble
  states is itself the structural-impossibility claim, so a stale count
  is the drift this unit exists to prevent.
- **Canonical ownership changes**: none.
- **Dependency-boundary changes**: none.
- **Contracts affected and compatibility classification**: none —
  performance/internal by construction: comments cannot move a byte of
  rendered output; no exported API touched.
- **Differential evidence**: the factual claims verified before writing —
  the preamble's eleven named pre-ladder commands counted against its own
  enumeration; `provenance`'s `resolvePolicy` import confirmed at
  `commands/provenance-command.mjs:76`, the fold call in place of the
  removed private walk; the omitted
  exit-3 source confirmed in `runProvenance`'s JSDoc (malformed
  intent/config only). lefthook format, lint (eslint over both touched
  files), packages and commitlint hooks green at the commit; the push
  battery runs on the branch as a whole.
- **Debt budget**: before — one stale count on the exact sentence whose
  job is preventing drift, one JSDoc under-attributing exit 3; closed —
  both; introduced — none; net — negative.
- **Unresolved questions**: the PD decision record for WI-2's named
  behavior deltas (CHK-2-WI2's item 1) stays maintainer-gated and is not
  decided here.
- **Rejected approaches**: riding the fixes on #748 (its file set was
  closed — the preamble and `cli.mjs` sit outside it); filing without an
  issue (#750 filed first under the feature template, duplicate search
  run); widening the preamble rewrite (the "other ten" hand-copy claim
  stays historically true — only the site count and the join are new).
- **Forbidden next moves / next**: none carried. Next: 2-D per
  [MIGRATION-PLAN.md](MIGRATION-PLAN.md#phase-2--canonical-model-hardening).

### CHK-2-D — Phase 2, 2-D: the naming hazards become readable pins (2026-09-06)

- **ID**: CHK-2-D. **Phase**: 2 (unit 2-D). **Status**: complete —
  pending merge of PR #754.
- **Goal**: close the naming-hazards rows by pinning, not renaming — the
  two `verdict.mjs` layers state each other's role and the one-direction
  layering rule (the check lane composes governance's `buildDecision`;
  governance imports nothing of the check lane) and name both
  near-collision pairs with their routing rule (`verdictFor` vs
  `verdictForStatus`; `EXIT_FOR_STATUS`, derived from `EXIT`, vs
  `VERDICT_FOR_STATUS`, an independent frozen map); the four "intent"
  surfaces (the manifest registry, the workspace-declared law, the
  declared-change grammar, and the fileless envelope `result.intent`)
  each name the other three at their entry module, recording PD-13
  outcome (c); `docs/reference/evidence.md` carries the same routing for
  docs readers.
- **Invariants touched**: none — comment-only; INV-18 untouched (no file
  moved, no digest changed).
- **Canonical ownership changes**: none.
- **Dependency-boundary changes**: none.
- **Contracts affected and compatibility classification**: none —
  performance/internal by construction: the TypeScript parser's token
  streams for all five touched `.mjs` files are byte-identical to base,
  and ESM-importing both versions side by side yields identical export
  keys and values (frozen maps included); zero wire bytes.
- **Differential evidence**: independent adversarial review (P-B, second
  worktree) verified comment-only by token-stream and import-identity,
  resolved every citation (PD-13 at DECISIONS.md:299-341; all relative
  module refs exist), confirmed the layering is one-directional (zero
  `../verdict.mjs` imports in `src/governance/`), cross-checked every
  factual assertion in the pins against the code, and ran the
  repository's own boundary check (exit 0; 2524 imports / 597 files /
  9 projects). lefthook format/lint/packages/commitlint green at both
  commits, signed (`%G?` = G).
- **Debt budget**: before — the naming-hazards rows: two same-basename
  modules, two near-collision pairs, and three intent nouns whose
  relationships lived only in review heads; closed — all, as readable
  header pins at the points of use; introduced — none; net — negative.
- **Unresolved questions**: none new. The pins' compression "four
  surfaces, never one type" is SEMANTIC-MODEL's wording of PD-13 (c);
  the cited DECISIONS.md section holds the ruling itself.
- **Rejected approaches**: renaming either `verdict.mjs` (11+ import
  sites, zero wire benefit, and the names are distinct spellings, not
  homonyms — CON-3's "concrete benefit" bar absent); moving `src/intent/`
  (drags INV-18 digests and the readiness roster for a path no consumer
  mistyped); renaming `architecture-intent.json` (public API — SARIF
  artifact URIs and envelope `intent.file` pin it; breaking).
- **Forbidden next moves / next**: none carried. Next: 2-E per
  [MIGRATION-PLAN.md](MIGRATION-PLAN.md#phase-2--canonical-model-hardening).

### CHK-2-E — Phase 2, 2-E: the vocabulary registers meet the landed phases (2026-09-06)

- **ID**: CHK-2-E. **Phase**: 2 (unit 2-E). **Status**: complete —
  pending merge of PR #753.
- **Goal**: close the register table against what has landed — R4
  rewritten from open-gap prose to its landed state (store side:
  `validateEventForWrite` via the shared `eventVocabularyViolation`
  refuses at write what read-side validation refuses, tracking issue
  #738 closed by PR #744; mapping side: the `deltaDisposition`
  throw-latch, tracking issue #739 closed by PR #741; the
  `reconcileDisposition` stranger latch and the rank-fold latch cited
  beside them), R1–R3 and R5–R6 checked accurate and left untouched, R7
  checked with its cross-references resolving; `vscode.md`'s router
  count corrected from four to the eight of `ROUTED_EXTENSIONS`, the
  missing `.cs` row added (Finding C, #742's review); #742's two
  out-of-scope follow-ups folded verbatim as program-tracked items
  outside the register list.
- **Invariants touched**: none — docs only.
- **Canonical ownership changes**: none.
- **Dependency-boundary changes**: none.
- **Contracts affected and compatibility classification**: none —
  performance/internal by construction: prose and tables only; register
  ids R1–R7 unchanged in number and order (grep-verified), so every
  control-plane citation of an id still lands.
- **Differential evidence**: the extension count verified against
  `ROUTED_EXTENSIONS`' authoritative list (eight entries; the test pins
  "eight extensions"); every new R4 citation pinned to symbol-and-lines
  in the adversarial review's detached checkout; issues #738/#739
  confirmed CLOSED and PRs #744/#741 MERGED before the row claimed them;
  with the landing-status annotation disclosed in the lead-in after the
  review's P3; `check-docs-links` green (704 files, no broken
  references); prettier green; lefthook battery green at both commits,
  signed (`%G?` = G).
- **Debt budget**: before — a register row describing a closed gap as
  open (inviting re-solving), an integration doc undercounting the
  routed languages by half, two follow-ups living only in a merged PR's
  body; closed — all three; introduced — one tracked item (the client
  walk's git ceiling) deliberately kept open under the umbrella; net —
  negative.
- **Unresolved questions**: R1's cross-boundary sentence remains open
  and the row says so — no merged work closes it, and claiming closure
  was rejected as fabrication.
- **Rejected approaches**: renumbering or reordering the registers
  (ids are cited across the control plane — CONTEXT, VALIDATION-MATRIX,
  MIGRATION-PLAN); code changes (R4's validation already landed — the
  unit's work was the row, not the gap); folding #742's items into the
  register rows (they are program tracking, not vocabulary).
- **Forbidden next moves / next**: none carried. Next: the Phase 2 exit
  check per
  [MIGRATION-PLAN.md](MIGRATION-PLAN.md#phase-2--canonical-model-hardening).

### CHK-2-R1 — R1's boundary sentence pair lands (2-E tail) (2026-09-06)

- **ID**: CHK-2-R1. **Phase**: 2 (unit 2-E, tail). **Status**: in progress —
  pending merge of PR #757.

- **Goal**: complete the last code-facing 2-E tail — R1's "one sentence each
  way" pair (#755, PR #757). The coverage side already existed
  (`coverage-verdict.mjs:2-3`); this unit writes the status side into
  `completeness.mjs`'s module header ("Not the coverage refusal (register
  R1)") and rewrites the R1 register row to the landed state, citation
  updated to `completeness.mjs:47-53` in the same landing so the row cannot
  go stale inside its own PR.
- **Invariants touched**: none. INV-18: `completeness.mjs` is not a
  manifest-named artifact, and the edit is comment-only.
- **Canonical ownership changes**: none — R1 stays a register, not a defect
  (PD-13); R2–R7 rows untouched, no renumbering.
- **Dependency-boundary changes**: none — no import moves; the
  cross-reference is prose.
- **Contracts affected and compatibility classification**: none —
  performance/internal by construction (comment-only `.mjs` change + prose).
- **Differential evidence**: on base `main` (`2083200`),
  `grep coverageVerdict packages/archkeep/src/commands/completeness.mjs`
  returned nothing (#755's reproduction); after the branch both directions
  name each other. No test pins comments; the push battery (boundary check,
  lint, vitest) is the run evidence.
- **Debt budget**: before — one register row prescribing an unlanded
  sentence pair, one header silent about its nearest vocabulary neighbor;
  closed — both; introduced — 0; net — negative.
- **Unresolved questions**: the WI-2 fold decision record (PD-15) stays
  maintainer-gated — explicitly not decided here; Phase-2 exit recording
  waits on it, and this checkpoint does not declare that exit.
- **Rejected approaches**: deriving one vocabulary from the other (PD-13
  already resolved the semantically-equal shapes as registers, not defects —
  unification is not on the table); embedding the sentence in
  `EVALUATION_STATUS`'s own JSDoc (the pair must read at the module's front
  door, not on one constant).
- **Forbidden next moves / next**: do not author the PD-15 record from this
  branch; do not renumber registers; do not touch landed CHK text. Next:
  control-plane state reconciliation (#756), then the PD-15 ruling gates
  the Phase-2 exit recording per
  [MIGRATION-PLAN.md](MIGRATION-PLAN.md#phase-2--canonical-model-hardening).

### CHK-2-PD15 — Phase 2 exit: the WI-2 fold decision recorded (2026-09-06)

- **ID**: CHK-2-PD15. **Phase**: 2 (exit). **Status**: complete — pending
  merge of PR #759.
- **Gate-table state**: Phase 2's exit condition — the PD-15
  fold-decision record — is satisfied by this PR; the Program state table
  above records Phase 2 complete in this same PR. Phase 3 stays closed
  until the maintainer confirms the exit.
- **Checkpoints completed**: CHK-2-WI2's unresolved question (the fold
  decision) — answered by [PD-15](DECISIONS.md#program-decisions) in this
  PR. No other checkpoint moves; every landed CHK block stands as written.
- **Invariants touched**: none — docs-only. INV-2's one-exit-table
  reading is what PD-15 applies, not amends.
- **Canonical ownership changes**: none — SEMANTIC-MODEL rows untouched.
- **Dependency-boundary changes**: none.
- **Contracts affected and compatibility classification**: classification
  only, no surface moves in this PR — PD-15 records the three WI-2 deltas
  as semantic changes on the 0.x line, to be named in the changelog of
  the minor that next cuts following PR #748's merge, and this PR's own
  delta is docs-only.
- **Differential evidence**: none produced here (docs-only); the
  classification's evidence is CHK-2-WI2's, re-cited by PD-15 —
  byte-identical outputs, the P1-26-class teeth, the coverage-channel
  witness — read against the merged ladder and
  `docs/reference/exit-codes.md`'s documented exit-3 split.
- **Architectural debt budget**: before — one pending maintainer-gated
  record gating the Phase-2 exit; closed — the record; introduced — 0;
  net — negative.
- **Unresolved questions**: none carried. Phase 3 opens only on the
  maintainer's confirmation of the Phase-2 exit (a process gate, not an
  open question).
- **Rejected approaches**: authoring the record inside CHK-2-WI2's own PR
  retroactively (checkpoints are append-only); editing any landed
  checkpoint's wording to say "decided" (this new checkpoint supersedes
  instead); a dedicated issue for a docs-only unit (PD-17 routes refactor
  units through umbrella #725 plus the finding id in the PR body).
- **Forbidden next moves / next**: do not start Phase 3 on this PR — the
  exit awaits the maintainer's confirmation. Next: report the Phase-2
  exit to the maintainer; then Phase 3 per
  [MIGRATION-PLAN.md](MIGRATION-PLAN.md#phase-3--boundary-enforcement).

### CHK-3 — Phase 3 exit: the layer laws scan (2026-09-07)

- **ID**: CHK-3. **Phase**: 3 (exit). **Status**: complete — pending
  merge of PR #766.
- **Gate-table state**: the table row above flips to complete in this PR.
  Phase 3's three exit criteria each hold: (1) every new scan demonstrated
  red on a planted violation — G-1/G-5/G-2 by the synthetic-tree red twins
  in `layer-direction-imports.test.mjs` (#762), where the G-5 roster is
  asserted equal so a second edge and a vanished edge both fail naming
  themselves; G-7 by the planted-orphan probe on a throwaway clone of the
  pushed tree, which failed naming exactly `src/zz-orphan.mjs` (#763),
  plus the roster's bidirectional teeth (rotten name, stale excuse,
  unrostered orphan). (2) The DAG is stated (BOUNDARIES.md, #764) and
  consistent with `module-graph.test.mjs`'s acyclicity — the suite runs
  green on final main. (3) The boundary self-check is green —
  `node packages/archkeep/cli.mjs check` on `cdce8fd`, recorded in this
  PR's evidence comment.
- **Checkpoints completed**: the phase ran as four units, each with its
  own PR and lock table — 3-A the G-1/G-5/G-2 scans (#762), 3-B the G-7
  orphan detector and test-support roster (#763), 3-C the intra-`src/`
  DAG statement (#764), 3-D the G-3/G-4/G-6/G-8 dispositions (#765). No
  per-unit CHK blocks: PD-17 routes refactor units through umbrella #725
  plus the finding id in each PR body; this block is the phase's single
  record.
- **Invariants touched**: INV-13's gap closed — the orphan rule now
  scans (`VALIDATION-MATRIX.md`'s Scanned register, #763).
  INV-20/INV-21 untouched: OQ-4 is NOT claimed by this exit (below).
- **Canonical ownership changes**: none — `SEMANTIC-MODEL.md` rows
  untouched.
- **Dependency-boundary changes**: BOUNDARIES.md grows the intra-`src/`
  dependency DAG (DG-2 closed, #764) and records five pressure-edge
  decisions, all keep-with-reason (analysis→rules, options↔analysis,
  rules↔config, core→governance, report→rules).
  `module-boundaries.config.mjs` is untouched — the scans are conformance
  tests, not tag rows; the config judges cross-project tag edges only.
- **Contracts affected and compatibility classification**: none — all
  four units are test/docs-only; no CLI, schema, output-contract, or
  exit-code surface moves, so no compatibility entry is due.
- **Differential evidence**: `VALIDATION-MATRIX.md`'s Scanned sub-list
  (#765) cites the per-gap witnesses — G-1/G-5/G-2 scans (real-tree edges
  clean; G-5 exactly one edge, rostered) and G-7's entry-rooted walk plus
  the roster (#763). The differential against
  `@nx/enforce-module-boundaries` (inside `archkeep:test`) stays green on
  final main.
- **Architectural debt budget**: before — G-1, G-2, G-5, G-7 unscanned;
  DG-2 unstated; G-3/G-4/G-6/G-8 undispositioned. Closed — G-1/G-2/G-5/G-7
  scanned with red twins; DG-2 stated; G-3/G-6/G-8 recorded
  keep-convention; G-4 dispositioned as scan-worthy and routed as a
  follow-up on umbrella #725 (its own record says follow-up — not claimed
  closed as a scan). Introduced — 0: two recorded follow-ups (the G-4
  scan candidate; the four shipped-but-entry-unreached modules #763's
  roster names) ride the umbrella; they are follow-ups, not new gaps.
  Net — negative.
- **Unresolved questions**: OQ-4 (do INV-20/INV-21 gain scans?) is NOT
  resolved by this phase — no unit adjudicated it, so it carries
  unchanged with its owner; claiming it here would be an unproven field.
  OQ-6 is resolved: the Contract-K exempt-site roster is clock only —
  witness `src/intent/determinism-source-guard.test.mjs`, whose
  `WALL_CLOCK_ALLOWLIST` names exactly the injectable clock seam
  (`governance/clock.mjs:27`) and whose empty-allow-list negative control
  proves the exemption load-bearing; recorded beside
  [INV-16](INVARIANTS.md#inv-16--clock-discipline) and as the register's
  CLOSED — DECIDED entry, in this same PR.
- **Rejected approaches**: adding the layer directions as tag rows in
  `module-boundaries.config.mjs` (the config judges cross-project tag
  edges only — intra-project directions there would be silent by
  construction); re-homing the four shipped-but-entry-unreached modules
  inside Phase 3 (a maintainer re-home-or-accept decision; the roster
  keeps them named and rot-proofed meanwhile); claiming OQ-4 closed here
  (no unit adjudicated it); a separate CHK block per unit (PD-17 keeps
  the append-only ledger single-sourced per phase).
- **Forbidden next moves / next**: do not start Phase 4 on this PR —
  Phase 4 is **blocked by GAP-A** (PD-4) and awaits the maintainer's
  approval to enter. Next: report the Phase-3 exit to the maintainer
  with the two follow-ups (the G-4 scan candidate; the four-module
  finding), then GAP-A's implementation per
  [MIGRATION-PLAN.md](MIGRATION-PLAN.md#phase-4--internal-extraction-proven-gains-only)
  once approved.

### CHK-4 — Phase 4 entry gate: golden-output corpus (2026-09-07)

- **ID**: CHK-4. **Phase**: 4 (entry). **Status**: complete — GAP-A + GAP-B
  closed (PR #767).
- **Goal**: commit the golden-output corpus and byte-identity comparator for
  all 24 read-only CLI verbs, closing Phase 4's entry gate (GAP-A + GAP-B).
- **Invariants protected**: none changed (read-only addition). INV-18
  (determinism-sweep fixture) is the fixture source; the golden-output test
  extends byte-identity coverage from `check` to all 23 non-debt verbs.
- **Architectural change**: none. New files in
  `packages/archkeep/src/corpus/goldens/` (50 golden files for 24 verbs) and
  `packages/archkeep/src/corpus/golden-output.integration.test.mjs` (the gate
  test with `ARCHKEEP_UPDATE_GOLDENS=1` regen). Test file only; no CLI,
  process, or package changes.
- **Evidence**: `golden-output.integration.test.mjs` runs 98 tests (50 GAP-A +
  48 GAP-B) — all PASS with and without `ARCHKEEP_UPDATE_GOLDENS=1`.
  `rules verify` included (no catalog, exit 3, byte-identical). `debt`
  included (committed golden; gate at levels 1+2 only — `sampleTime`
  normalised before JSON structural comparison; text checks exit+non-empty).
  GAP-B runs 4 cold starts per verb for all 23 non-debt verbs (debt's
  `sampleTime` is non-deterministic).
- **Exit gate**: GAP-A + GAP-B closed → Phase 4 extraction may begin.
- **Forbidden next moves**: (1) start Phase 4 extraction before this PR is
  merged; (2) reopen GAP-A or GAP-B without new evidence or a maintainer
  ruling; (3) add `debt` at byte-identity level (GAP-A level 3) until a
  `--reference-time` CLI flag or clock-seam injection is available.
- **Debt budget**: gaps before — GAP-A + GAP-B (Phase 4 entry gate); gaps
  closed — GAP-A + GAP-B (23 verbs byte-identity, debt at levels 1+2); gaps
  introduced — none; net delta — negative: uncertainty removed, no new gap.
- **Validation evidence**: all 98 golden-output tests pass against the
  committed golden files (50 GAP-A + 48 GAP-B); fixture determinism confirmed
  (git dates pinned, deterministic fixture path, 4-run byte-identity probe
  for all 23 non-debt verbs); boundary check clean; docs updated
  (VALIDATION-MATRIX.md, OPEN-QUESTIONS.md, this page).

### CHK-5 — Phase 4 extraction-candidates investigation: no proven extraction (2026-09-07)

- **ID**: CHK-5. **Phase**: 4 (extraction). **Status**: complete.
- **Goal**: investigate the five pressure edges recorded in
  [BOUNDARIES.md](BOUNDARIES.md#the-intra-src-dag) for extraction-candidate
  viability. Per
  [MIGRATION-PLAN.md](MIGRATION-PLAN.md#phase-4--internal-extraction-proven-gains-only):
  "No proven extraction is a successful Phase 4 outcome."
- **Pressure edges investigated** (all verified at HEAD 7b8c85b6, every import
  line confirmed):
  1. `analysis → rules` — `analysis/markdown.mjs:51` imports
     `safeMatchesGlob` from `rules/match.mjs`. **Decision**: keep — pure
     shared primitive (BOUNDARIES.md:118).
  2. `options ↔ analysis` — `analysis/typescript.mjs:85` imports
     `DEFAULT_OPTIONS` from `options.mjs`; `options.mjs:94` imports
     `languageOf` from `analysis/registry.mjs`. **Decision**: keep — frozen
     vocabulary, acyclic at module granularity (BOUNDARIES.md:119).
  3. `rules ↔ config` — `rules/index.mjs:57` imports
     `findBoundaryConfigViolations`/`suppressionCovers` from `config.mjs`;
     `config.mjs:132-141` imports glob/match/message vocabulary from
     `rules/match.mjs` and `rules/messages.mjs`. **Decision**: keep — shared
     vocabulary between validator and validated, acyclic (BOUNDARIES.md:120).
  4. core → `governance/` — `config.mjs:129-131` imports three governance
     registries; `rules/index.mjs:58-59` imports clock/waiver evidence.
     **Decision**: keep — vocabulary and evidence, no verdict logic
     (BOUNDARIES.md:121).
  5. `report → rules` — `report/sarif.mjs:58-65` imports message tables from
     `rules/messages.mjs`. **Decision**: keep — SARIF descriptors derived
     from the one message home; renders, decides nothing (BOUNDARIES.md:122).
- **Invariants protected**: none changed (read-only verification). INV-11
  (verdict core → report layering) and INV-13 (acyclic module graph) remain
  as enforced by the conformance suite.
- **Architectural change**: none. All five edges remain keep decisions — no
  module moved, no boundary created.
- **Evidence**: every documented import verified against source at HEAD
  7b8c85b6; each imported symbol confirmed exported by its target file. No
  post-Phase-3 commit (the newest is #747's message-registry collapse, an
  ancestor of the Phase-3 base 7fd2828) touched any of the six files
  (`analysis/markdown.mjs`, `analysis/typescript.mjs`, `options.mjs`,
  `rules/index.mjs`, `config.mjs`, `report/sarif.mjs`).
- **Debt budget**: gaps before — GAP-A + GAP-B (Phase 4 entry gate, closed
  in CHK-4) plus the five pressure edges to investigate; gaps closed — all
  five edges confirmed keep, no new gap; gaps introduced — none; net delta
  — negative: uncertainty removed.
- **Exit gate**: Phase 4 internal extraction complete — entry gate closed
  (CHK-4) and extraction-candidates investigated (this checkpoint). Phase 5
  (capability facades) unblocked.
- **Forbidden next moves**: (1) reopen any pressure-edge decision without
  new evidence or a maintainer ruling; (2) add extraction work not argued
  from a measured pressure edge; (3) start Phase 5 without maintainer
  approval of Phase 4's exit record.
- **Next**: report Phase 4 exit to maintainer; Phase 5 entry awaits approval.

### CHK-6 — Phase 5 closure & Phase 6 execution baseline (2026-09-07)

- **ID**: CHK-6. **Phase**: 5 (close) + 6 (entry). **Status**: Phase 5
  closed; Phase 6 in progress.
- **Phase 5 closure evidence** (PR #772, merged as `60f0e7d2` on
  2026-09-07T11:54:54Z; `ci-gate` + `analysis-gate` + Verify pass):
  landed the seven pure re-export facades
  `src/commands/{analyze,check,compare,explain,inspect,govern,rules}-capability.mjs`
  (zero judgment by construction), the `loadIntentIfTracked` helper with
  three contract pins, `cli.mjs` verb-import routing through the facades,
  the two exit-1 prose corrections from [PD-18](DECISIONS.md#program-decisions)'s
  scope, the INV-18 manifest digest regen, and the same-PR docs rows
  (AUTHORITY-MAP facade row + DG-4 law, OPEN-QUESTIONS DG-4 annotation,
  SEMANTIC-MODEL consumer column, concepts pointer). Validation battery
  green before merge: `archkeep:test` 5895/5895 (includes the golden
  corpus, exit matrix, envelope and refusal suites), `archkeep:integration`,
  `archkeep-mcp:test` 51/51, `pnpm e2e` 293/293, gate scripts 445/445,
  repository boundary check clean, lint/typecheck/format and the doc gates
  green. Adversarial review APPROVE (round 2; round 1 REWORK — missing
  roster — corrected in the PR). Differential: every verb's corpus output
  identical at levels 1–2 across the facade rerouting; no observable
  surface moved (internal, byte-stable). Defects filed out-of-unit:
  [#770](https://github.com/ecoma-io/archkeep/issues/770) (timing-budget
  flake under artificial CPU saturation; serial differential 35/35),
  [#771](https://github.com/ecoma-io/archkeep/issues/771) (help pins do not
  derive from the roster).
- **Phase 6 entry baseline** (cold audit at `60f0e7d2`; the four
  load-bearing facts re-verified line-by-line before this record):
  1. `cli.mjs` (3984 lines, 24 run drivers + `runCli`) routes every verb
     import through the seven facades (it is their only consumer);
     sanctioned direct imports remain: `commands/policy.mjs` (16
     `resolvePolicy`/`resolveDescribedPolicy` preamble sites),
     `commands/context.mjs` (preamble + help-time reads), containment,
     errors, `architecture-intent/model.mjs` (`INTENT_FILE` + three
     `loadIntentIfTracked` gates), entry-point, options, verdict
     (`EXIT` + `verdictFor`), `providers/native/model.mjs`, workspace.
  2. **Baseline gaps the phase owes** (measured facts, unresolved):
     a direct provider edge — `cli.mjs:163` imports
     `ARCHKEEP_MODEL_FILE`/`loadNativeModel` (governance-target map
     `:509`; the help-time native inline-policy read `~:357-367`), so
     Phase 6's exit criterion "no driver imports an analyzer or provider
     directly" is **not** satisfied today and VALIDATION-MATRIX's G-4
     "holds today" clause is true only for rules/analysis/report; five
     driver-side status→exit folds that re-derive, in the driver, exit
     codes each command already computes for its JSON envelope — and
     which delta's own fold object already carries
     (`delta.mjs:489-558`) — but that no command's returned result
     object exposes. The driver sites are check `:826-844`, delta
     `:1098-1101`, change `:1417-1421`, fitness `:1580-1583`, rules
     verify `:2058-2060`; three of them spell the same
     `{ok, findings, "no-verdict"}` literal in one file, and the
     command-side computations they duplicate sit at
     `delta.mjs:1100-1101`, `change.mjs:1150-1151`,
     `fitness.mjs:294-300`, `rules.mjs:448`. Exit-matrix findings-mode
     exit-1 pins cover 3 of the 5 exit-1 verbs (delta --compare and change
     findings sides live outside the matrix — `cli.integration.test.mjs:9095-9352`,
     `change.test.mjs:904-924`); `--help` byte stability has **no
     enforcing gate** (containment assertions only; the corpus
     `VERB_PLAN` carries no `--help` rows).
  3. **Documented walks that must not fold**: `adr`'s own marker walk and
     `rules`' synthetic context are documented preamble bypasses
     ([DATA-FLOW.md](DATA-FLOW.md) stage 3); `evolution`'s root walk is a
     documented root walk, not a bypass. The five command-side folds stay
     five ([PD-6](DECISIONS.md#program-decisions),
     [INV-25](INVARIANTS.md#inv-25--semantic-authority-count-is-one)) —
     this phase removes only the driver-side duplicate spellings.
- **Decision** (maintainer-delegated per the 2026-09-07 instruction
  "Tiếp tục hoàn thiện các phase còn lại đi", PD-18 precedent; this PR is
  the veto window): Phase 5's exit stands accepted; Phase 6 entry is
  authorized with the work items below. Compatibility classification:
  internal — every work item is byte-stable on the observable surface
  unless the battery proves otherwise.
- **Work items** (each named in the PR body per
  [PD-17](DECISIONS.md#program-decisions)): **WI-1** fold elimination —
  each of the five verdict-bearing commands (`check`, `delta` compare,
  `change`, `fitness`, `rules verify`) surfaces its already-computed
  `exitCode` on its returned result object — an additive internal field
  present on every lane: success, findings, and refusal/no-verdict
  (`delta`'s coverage refusal and `fitness`'s fold refusal both return
  it) — and then each of the five drivers returns that field instead of
  re-deriving it; `rules`' descriptive subcommands (`list`, `info`,
  `add`) gain no field and keep their driver-side exits, so `runRules`
  reads `exitCode` only on the verify lane. The command-side mappings
  are untouched (PD-6); command-level tests pin the return contract per
  lane before any driver flips; INV-2/INV-4 citation refresh lands
  same-PR. **WI-2** provider-edge elimination — re-home the help-time
  native read and the `ARCHKEEP_MODEL_FILE` constant so `cli.mjs` imports
  no `src/providers/**`; a candidate home that adds a new cross-layer edge
  needs a [BOUNDARIES.md](BOUNDARIES.md) pressure-edge row, and G-6's
  filename-knowing law is evaluated first. **WI-3** driver semantics move
  down — the 16 policy-resolution preamble sites, the three
  `loadIntentIfTracked` gates, runHistory's fingerprint capture, the
  discover `--write-intent` payload composition (the `wx`-write mechanics
  stay driver infrastructure), and the per-verb self-footgun target guards
  move into command modules or become command-declared forbidden targets
  enforced by the driver's write door. **WI-4** the G-4 scan — a new
  conformance gate cloning the layer-direction mechanics (direct edges
  only, teeth-first red twin, live floors) asserting `cli.mjs` + `lsp.mjs`
  import no `src/rules/**`, `src/analysis/**`, `src/report/**`,
  `src/providers/**`; entry files only (`src/lsp/**` is Phase 7's);
  unrostered only once WI-2 has removed the provider edge, otherwise
  rostered G-5-style with two-way checking. **WI-5** exit-matrix
  findings-mode pins for `delta --compare` and `change` (seam-injected
  worlds like the existing rows). **WI-6** `--help` byte goldens —
  top-level and per-verb help over the deterministic corpus fixture; a
  level-2 contract pin. **WI-7** same-PR docs: INV-2/INV-4 citations,
  VALIDATION-MATRIX's G-4 row moves to scanned, differential row 10
  wording, and SEMANTIC-MODEL/BOUNDARIES rows only if one actually moves.
- **Non-goals**: no verb/flag/exit/envelope change; no facade content
  change; no command-side fold unification; no change to the documented
  walks; no `src/lsp/**` or MCP work (Phase 7).
- **Validation plan**: full battery — `archkeep:test` (corpus incl. the
  new help goldens, exit matrix incl. the new findings rows,
  `cli.integration`, envelope, refusal-contract, verdict-layering,
  module-graph, layer-direction incl. the new G-4 gate),
  `archkeep:integration`, `archkeep-mcp:test`, `pnpm e2e` (the
  verify-package bin contract), gate scripts, lint/typecheck/format, the
  repository boundary check, the doc gates; INV-18 digest regen for
  `cli.mjs` same-PR. Differentials: rows 1, 10, 12 minimum, plus the
  corpus at levels 1–2 for every touched verb.
- **Canonical ownership changes**: none — no SEMANTIC-MODEL row moves in
  the entry record; WI-7 updates rows only if an implementation actually
  relocates one.
- **Debt budget**: gaps before — the G-4 scan unimplemented (the Phase 3
  follow-up), findings pins 3/5, no help golden, the provider edge
  (baseline facts above); gaps closed by Phase 6 — all four named;
  gaps introduced — none planned; net delta target — negative.
- **Unresolved questions**: OQ-11 (LSP golden scope) and OQ-14 (GAP-D)
  stay maintainer-gated at their own phase gates; Phase 8's CON-8 entry
  records its delegated ruling at entry.
- **Rejected approaches**: keeping the driver folds (they are second
  spellings of `EXIT_FOR_STATUS` the commands already own; keeping them
  keeps the duplication [INV-2](INVARIANTS.md#inv-2--one-exitstatus-table)
  names); rostering the provider edge instead of eliminating it (the exit
  criterion says the edge goes; a roster is the fallback, not the goal);
  folding the documented walks into the shared preamble (documented
  bypasses, DATA-FLOW stage 3); widening the G-4 scan to `src/lsp/**`
  before Phase 7's seam decision (born-red against the current tree).
- **Forbidden next moves**: (1) unify the five command-side folds or route
  sibling carriers through `verdictFor` (PD-6); (2) fold the `adr`/`rules`/
  `evolution` documented walks; (3) let a facade gain judgment; (4) widen
  the G-4 scan past the entry files before Phase 7; (5) start Phase 7
  before this phase's exit checkpoint lands.
- **Next**: implement WI-1..WI-7 in the Phase 6 PR; adversarial review;
  land; checkpoint the Phase 6 close.

### CHK-7 — Phase 6 close: CLI recomposition (2026-09-07)

- **ID**: CHK-7. **Phase**: 6 (close). **Status**: complete — PR #775.
  Maintainer-delegated execution (the PD-18 precedent; the PR is the veto
  window).
- **Units**: WI-1 `181ae814` — every verdict-bearing command's result carries
  `exitCode` on all lanes (success, findings, no-verdict/refusal) and the five
  drivers return it (`cli.mjs` return sites; `verdictFor` gone from the CLI,
  the one copy lives at `src/commands/check.mjs`); WI-2 `eebbdcab` — the
  native-model read the help lane carried moved to
  `src/commands/policy.mjs` (`nativePolicyOptions(root, { readFile })`);
  WI-3 `2ac7a956` — additive `(options, io)` wrappers in all 19 command
  modules, drivers collapsed to wiring, facades pure re-exports (PD-18);
  WI-3 tail `7ea9856a` — the `--write-intent` clobber-refusal DECISION moved
  to `src/commands/discover.mjs` (`intentWriteRefusal`), the CLI keeping the
  write mechanics only, matching `historyOutputRefusal`'s precedent;
  INV-18 re-certification `e84d1f62` and again at `7ea9856a` (the `cli.mjs`
  digest `92427d87…`); WI-4 `bd349f10` — the G-4 entry-surface import scan
  (`src/conformance/entry-surface-imports.test.mjs`); WI-5 `055853af` — the
  findings pins for `delta --compare` and `change` over a real import-record
  delta; WI-6 `03c09a55` — `--help` byte goldens (`help.text`,
  `usage-error.text`) in the corpus gate; WI-7 `50abdc41` — control-plane
  sync (G-4 row, INV-2/INV-4 geography, GAP-A counts, the Phase 6 exit
  wording in MIGRATION-PLAN).
- **Canonical ownership changes**: two, both down the pipeline. (1) The
  help-time native read is a command-layer preamble now — the
  `commands → providers` direction `check` and `context` already hold
  (providers observe; policy resolution evaluates); `ARCHKEEP_MODEL_FILE` is
  still defined once, in `src/options.mjs` (G-6 intact — `model.mjs`
  re-exports it). (2) The write-intent refusal decision belongs to
  `discover` beside the proposal it protects. No SEMANTIC-MODEL row moved;
  no BOUNDARIES row changed — no declared boundary moved.
- **Debt budget**: gaps before — the four named at entry (G-4 unimplemented,
  findings pins 3/5, no help golden, the `cli.mjs` provider edge); gaps
  closed — all four, plus the write-intent guard's CLI ownership (a gap the
  close audit found, not the entry list); gaps introduced — none; net delta —
  negative.
- **Evidence**: full battery `archkeep:test` 218 files / 5930/5930
  (`/tmp/phase6-full-test-3.log`; one load-flake timeout in
  `engines-edge.test.mjs` on an earlier run — green isolated in 3.3 s and in
  the final clean run); exit-matrix 27/27; corpus gate 124/124 including the
  help lane; intent gate 58/58 + G-4 scan 7/7; `archkeep-mcp:test` 51/51;
  gate scripts exit 0; the repository boundary check exit 0 (2601 imports);
  lint, format, typecheck, check-packages, check-docs-links, check-skills
  green; the adversarial review's verdict on the unit tree was correct with
  no blocker/major/minor, and the WI-3 tail commit re-ran its own lanes
  (discover unit + CLI integration 35/35, intent + G-4 65/65).
- **Next**: Phase 7 (additional surfaces) starts only through its own gate —
  the maintainer's steering governs when.

### CHK-8 — Phase 7 progress: GAP-E corpus + LSP provider convergence (2026-09-07)

- **ID**: CHK-8. **Phase**: 7 (mid-phase). **Status**: two units landed on
  this branch — GAP-E `3194e7e` (corpus recorded BEFORE the refactor) and the
  7-A collapse `5df63c0d`. Maintainer-delegated execution (PD-18); Phase 7
  continues — MCP seam unit in flight, VS Code disposition and the provider
  boundary re-measure to close.
- **Units**: GAP-E — `src/corpus/goldens-lsp/` (6 recorded artifacts: the
  `initialize` result, the watcher registration, and four
  `publishDiagnostics` records, two of them EMPTY — the invariant's silent
  direction pinned as bytes) over one Nx-shaped fixture, gated by
  `src/corpus/lsp-golden.integration.test.mjs` spawning the real server over
  stdio; one L3 normalization (`serverInfo.version`, the `sampleTime`
  precedent). 7-A — the private Nx acquisition `workspace-index.mjs` held
  inline moved to `src/providers/nx-static.mjs`
  (`discoverProjects`/`buildNodes`/`readStaticProjectGraph`); the index
  composes it (`workspace-index.mjs:260`) and keeps annotation and edge
  folding caller-side per the seam contract; ownership move only — static
  strategy kept (no spawn per file save), records-not-throws failure policy
  kept, and the `workspaceLayout`-read catch moved with the code verbatim
  (`workspaceLayoutFailure` — the index's own pre-existing behavior, not a
  new shape; the provider's throw contrast is with the CLI's
  `readProjectGraph`, which blanks the run). No input class changes
  verdict.
- **Canonical ownership changes**: one — Nx static acquisition now lives in
  `src/providers/`, where [BOUNDARIES.md](BOUNDARIES.md#provider-seam)'s
  table has its fourth row and
  [AUTHORITY-MAP.md](AUTHORITY-MAP.md#known-divergences-and-pressures)
  divergence 2 is closed. The provider-shape question the table posed
  ("whether the coupling earns a shared shape") is answered no — no consumer
  needs one to compose, and an unused interface is a speculative
  abstraction. No SEMANTIC-MODEL row moved.
- **Debt budget**: gaps before — GAP-E (no recorded LSP responses),
  divergence 2 (LSP-private acquisition), divergence 3 (MCP past-seam
  import); gaps closed — GAP-E and divergence 2; gaps introduced — none; net
  delta — negative (divergence 3 is the MCP unit's, in flight).
- **Evidence**: the corpus is the differential — 4/4 golden cases
  byte-identical across the collapse; LSP + provider suites 294 passed;
  touched suites 79 passed; full package suite 5940/5940 (221 files); tsc,
  eslint, prettier clean; this repository's own boundary check exit 0.
- **Next**: Phase 7 close (MCP seam verdict, VS Code disposition, provider
  re-measure), then Phase 8 under the maintainer's steering.

### CHK-9 — Phase 7 close: additional surfaces (2026-09-08)

- **ID**: CHK-9. **Phase**: 7 (close). **Status**: complete — all four units
  landed through the merge queue: #776 (`4b9435f6`, deflake + roster),
  #777 (`d68abb38`, GAP-E corpus), #787 (`00384b51`, MCP seam), #786
  (`407f8080`, 7-A LSP convergence, stacked on #777, retargeted `main` after
  #777 merged).
- **Units**: 7-A — the LSP-private Nx acquisition in `workspace-index.mjs`
  collapsed into `src/providers/nx-static.mjs` (ownership move, static
  strategy kept; records-not-throws retained; the `workspaceLayout`-read
  catch moved verbatim). 7-B — the LSP golden-response corpus (GAP-E):
  six recorded artifacts incl. the two empty `publishDiagnostics` (the
  invariant's silent direction pinned as bytes) over an Nx-shaped fixture,
  byte-gated by `src/corpus/lsp-golden.integration.test.mjs`. MCP seam — the
  `adr` preamble imported past the `./commands` subpath collapsed into a
  commands-layer driver (`src/commands/adr-for-workspace.mjs`); the MCP
  package now composes the command layer, not the engine's root entry.
  Adjacent hardening (#776): the `custom-rules` wasm budget race, the
  `engines-edge` spawn-budget deflake, and deriving the `--help` roster from
  `COMMAND_NAMES`.
- **Canonical ownership changes**: two. (1) Nx static acquisition now lives
  in `src/providers/` (the provider-seam table's fourth row;
  [BOUNDARIES.md](BOUNDARIES.md#provider-seam)); the shared-shape question
  the table posed is answered **no** — no consumer needs one to compose.
  (2) The MCP `adr` preamble moved beside its command; `engine.mjs` reaches
  past the `./commands` subpath no more. No SEMANTIC-MODEL row moved.
- **Dependency-boundary changes**: none — [BOUNDARIES.md](BOUNDARIES.md)
  gained the fourth provider row but no declared boundary moved; the MCP
  seam's past-seam import (divergence 3) is closed.
- **Contracts and compatibility**: class 1 (ownership moves) internally;
  class 3 (performance/internal) on the wire — the LSP collapse is
  byte-for-byte identical, proven against the GAP-E goldens recorded before
  the change. One additive surface: the `./commands` subpath grew
  `adrForWorkspace` (class 2, new export, nothing removed). No CLI surface,
  config schema, or JSON/SARIF contract moved.
- **Differential evidence**: GAP-E goldens byte-identical across the
  collapse (all 4 cases); LSP + provider suites 294 passed; touched suites
  79 passed; full package suite 5940/5940 (221 files) on the merged `main`;
  `tsc --noEmit`, eslint (0 warnings), prettier, `check-packages`,
  `check-docs-links`, `check-skills`, commitlint green; this repository's
  own boundary check exit 0.
- **Debt budget**: gaps before — GAP-E, divergence 2 (LSP-private
  acquisition), divergence 3 (MCP past-seam import); gaps closed — all
  three; gaps introduced — none; net delta — negative.
- **Unresolved / open decisions**: OQ-14 (GAP-D, the MCP propose-decision
  seam) and GAP-C stay open — recorded for Phase 9. VS Code is deliberately
  untouched (a client whose decisions are pure functions; no analysis
  changed). Phase 8 (federation readiness) is **runway only** — no
  speculative federation framework; the maintainer gates any implementation
  (OQ-14/GAP-D).
- **Rejected approaches**: a shared provider shape (answered no — unused
  interface is speculative); LSP/MCP independent evaluation (rejected — the
  engine's own command layer is the one authority); a static-vs-CLI strategy
  change in the LSP (static kept, no spawn per file save); VS Code analysis
  (rejected — it ships to a marketplace and deliberately does not bundle the
  server).
- **Forbidden next moves / traps**: do not expand the provider seam further
  (no new shared shape); do not re-introduce LSP/MCP independent evaluation;
  do not build a federation framework before the maintainer authorizes it;
  do not touch VS Code analysis. The objective of the next PR: Phase 8's
  runway record (the seven adversarial questions + the OQ-14/GAP-D gate),
  then Phase 9's final audits + falsifiable gate.

### CHK-10 — Phase 8 close: federation readiness runway (2026-09-08)

- **ID**: CHK-10. **Phase**: 8 (runway). **Status**: recorded — the runway
  is built, no machinery. PR #791.
- **Units**: one — the runway record
  [FEDERATION-READINESS.md](FEDERATION-READINESS.md): the seven adversarial
  questions answered, the OQ-14/GAP-D gate restated for Phase 9, and the
  runway's verdict.
- **Canonical ownership changes**: none — no ownership moved.
- **Dependency-boundary changes**: none — [BOUNDARIES.md](BOUNDARIES.md)
  unchanged.
- **Contracts and compatibility**: class 3 (docs-only) — the record states
  no new API, config, identity, serialization, CLI/`./commands` surface, or
  verdict vocabulary. Nothing a consumer imports or runs moves.
- **Differential evidence**: docs-links gate green (722 files); prettier
  clean; no code touched. The runtime suites are unchanged because nothing
  in `src/` moved — the gate's own "resolves against the tracked tree" check
  is the differential for a docs-only change.
- **Debt budget**: gaps before — GAP-C, GAP-D (both Phase 9-owned); gaps
  closed — none (runway-only); gaps introduced — none; net delta — zero.
- **Unresolved / open decisions**: GAP-C (differential breadth) and GAP-D /
  OQ-14 (cross-version semantic baseline) remain open, recorded for Phase 9.
  Phases 9 remains blocked by 8-or-waiver; this record does not change that.
- **Rejected approaches**: a `FederationService` (REFUSED by CON-8 — no
  concrete requirement); new identity/format/provenance abstractions for
  federation (REFUSED by the runway's Q4/Q5/Q6 — every existing contract
  already covers the plane).
- **Forbidden next moves / traps**: do not build a federation framework
  before the maintainer authorizes it; do not add a workspace-repository
  identity ADR before a consumer proves it needs to address a remote tree;
  do not make provenance a post-hoc-stamped field. The objective of the next
  PR: Phase 9's final audits + falsifiable gate (GAP-C/GAP-D dispositions).

### CHK-11 — Phase 9 close: final hardening and the scored maturity gate (2026-09-08)

- **ID**: CHK-11. **Phase**: 9 (close). **Status**: recorded — the full
  matrix ran, the maturity gate is scored, and both remaining gaps are
  disposed. PR #792.
- **Units**: one — the Phase 9 close record: the full validation-matrix
  sweep (below), the REFRACTOR MATURITY GATE scored 11/11
  ([MIGRATION-PLAN.md](MIGRATION-PLAN.md#refractor-maturity-gate)), the
  GAP-C/GAP-D dispositions, and the final program close.
- **Canonical ownership changes**: none — no ownership moved.
- **Dependency-boundary changes**: none — [BOUNDARIES.md](BOUNDARIES.md)
  unchanged.
- **Contracts and compatibility**: class 3 (docs-only) — the record states
  no new API, config, identity, serialization, CLI/`./commands` surface, or
  verdict vocabulary. Nothing a consumer imports or runs moves; the
  5940-suite and gates it cites are the unchanged baseline, not a claim of
  change.
- **Differential evidence / the full matrix**:
  - Full package suite 5940/5940 (221 files) pass on merged `main`
    (measured; matches post-#790).
  - Authority witnesses: `verdict-layering`, `layer-direction-imports`,
    `refusal-contract`, `coverage-loudness` — 74/74 pass (rows 1, 4, 7).
  - Determinism: `check-repeat-byte-identity` + `deterministic-ordering`
    - the 23-verb byte-identity corpus gate — green (row 5).
  - Packed artifact: `verify-package` 55/55 `ok` across Nx/Moon, Maven,
    Gradle, LSP-through-symlink, exit-contract lanes (row 8).
  - Gate scripts: `check-packages`, `check-skills`, `check-docs-links`,
    `check-cli-docs-roster`, `check-installation-prereqs`,
    `check-contributing-parity` — all green. `tsc --noEmit` (archkeep +
    gate-scripts), eslint (0 warnings), prettier — green.
  - This repository's own boundary check (`cli.mjs check`) exit 0.
- **The scored maturity gate** — the 11 rows of
  [REFRACTOR MATURITY GATE](MIGRATION-PLAN.md#refractor-maturity-gate),
  each with the evidence that satisfies it:
  1. _One enforcement authority_ — **HOLD**. INV-25 count stays one:
     the five-role vocabulary + the four folds + the integrity fold
     unchanged; `verdict-layering` green; per-PR adversarial review named
     the count (this record names it: still one).
  2. _Semantic flow one-way_ — **HOLD**. Intra-`src/` DAG stated and
     scanned (G-2/layer-direction, Phase 3); no cycle, no re-derivation.
  3. _Canonical models single-owned_ — **HOLD**. SEMANTIC-MODEL rows with
     zero unresolved hazards; every equivalent representation sits at a
     projection/adapter with its conversion named.
  4. _Providers observe only_ — **HOLD**. G-1 scan green; Moon policy
     adjudicated (Phase 1), contract tested.
  5. _Determinism_ — **HOLD**. 23-verb byte-identity corpus gate +
     `check-repeat-byte-identity` + `deterministic-ordering` green in the
     5940 suite.
  6. _Differential safety_ — **HOLD**. Every structural PR's differential
     recorded (CHK-2…CHK-10); corpus diff closed (GAP-A/B/E).
  7. _Empty-result invariant_ — **HOLD**. `refusal-contract` +
     `coverage-loudness` + LSP two-site green (74/74 witness group);
     red-twin direction exercised.
  8. _Contract stability_ — **HOLD**. Exit matrix, envelope roster, SARIF,
     LSP protocol, MCP surface, exports all green and unchanged; class-1/2/3
     only, changelog would name any class-4/5.
  9. _Docs precede and follow code_ — **HOLD**. Every PR's doc updates
     landed same-PR; docs-links + prereq + roster + parity gates green.
  10. _Review independence_ — **HOLD**. Independent adversarial review per
      architectural PR recorded (each CHK-n cites its review; implementer
      never final reviewer).
  11. _Extraction honesty_ — **HOLD**. Every landed extraction recorded as
      either its demonstrated gain or "no proven extraction" (CHK-5); package
      counts never used as progress evidence.
      Result: **11/11 HOLD**, zero unresolved rows — the gate is satisfied.
- **Debt budget**: gaps before — GAP-C (differential breadth), GAP-D
  (cross-version baseline), OQ-14 (INV-23's witness, Phase 9-gated);
  gaps closed — GAP-C and GAP-D (dispositions below); gaps introduced —
  none; net delta — negative; the two open gaps close here.
- **GAP-C disposition — differential breadth (decided: no-fix)**. GAP-C is
  "governance/provenance/report values have no differential, only
  relationship pins". The measure shows the values ARE guarded: the
  report/ and governance/ surfaces hold 1089/1089 tests across 48 files
  (every text renderer has a `.test.mjs`; envelope + SARIF have
  byte-identity integration pins; the governance rows assert exact values
  via `.toEqual`). The relationship pins plus the byte-identity corpus
  (GAP-A, the 23-verb goldens) plus the unit suites ARE the differential;
  a separate "value differential" harness would duplicate what the corpus
  already proves byte-for-byte on the report surface and what the unit
  suites already pin on the governance surface. Adopt no new harness —
  recorded no-fix per [CON-0](CONSTITUTION.md#con-0--do-not-trade-semantic-maturity-for-structural-purity).
- **GAP-D / OQ-14 disposition — cross-version baseline (decided: no-fix
  now, recommendation for a future tag-adjacent differential)**. GAP-D is
  "nothing diffs engine output at version N vs N+1 over the same tree".
  The corpus + differentials + release-lane discipline are strong: the
  golden corpus is pinned byte-for-byte and gated; the release lane re-runs
  the conformance differential against the TAGGED bytes
  (`release.yml` `verify-conformance`, `--exit-class-of`), which is
  version-adjacent (tag N against real trees). What is genuinely missing —
  engine N vs N+1 on the SAME tree — is the `readiness` script's own
  "quiet-stretch" signal: the last 50 commits include 12 that touched the
  output-contract
  surface without a breaking marker, so the stretch has not held. That is
  not a refactor defect (every one was a class-1/2/3 byte-identical change
  proven against the corpus) but it IS the one honesty gap the corpus
  cannot close: a future release that shifts a verdict without a marker
  would read clean here. OQ-14 closes with the no-fix now (corpus +
  differentials + review discipline suffice), and the recommendation that
  the release lane add a same-tree N-vs-N+1 diff — the exact adoption
  OQ-14's "What closes it" names, when the maintainer authorizes it.
- **Unresolved / open decisions**: none remain — GAP-C, GAP-D, and OQ-14
  are all disposed in this record. The federation runway (Phase 8) stays
  uninstantiated by decision (CON-8); nothing here changes that.
- **Rejected approaches**: a separate value-differential harness for
  GAP-C (rejected — duplicates what the corpus + unit values already
  prove); a mandatory cross-version baseline in the release lane now
  (rejected — without an existing marker discipline it would fail on the
  refactor's own non-breaking commits; recorded as a recommendation, not a
  mandate); any change to VERIFY/analysis-gate scope (rejected — untouched,
  gates stay as CI).
- **Forbidden next moves / traps**: do not invent a new value-differential
  or cross-version harness without the maintainer; do not re-open GAP-C/D
  without new evidence; do not build a federation framework (Phase 8's gate
  still holds). The program's next move is the maintainer's: absorb this
  record, and act on the GAP-D recommendation.

The program is closed in the sense this control plane can close it: Phases
0–9 all recorded, the maturity gate scored 11/11, and every gap either
closed or dispositioned. What remains is the federation runway (by CON-8,
intentionally unbuilt until a concrete requirement).

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
