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

| Phase                         | Status                 | Record                      |
| ----------------------------- | ---------------------- | --------------------------- |
| 0 — Architecture cartography  | **complete** (this PR) | CHK-0 below                 |
| 1 — Authority hardening       | not started            | entry: Phase 0 accepted     |
| 2 — Canonical model hardening | not started            | blocked by 1                |
| 3 — Boundary enforcement      | not started            | blocked by 2                |
| 4 — Internal extraction       | not started            | **blocked by GAP-A** (PD-4) |
| 5 — Capability facades        | not started            | blocked by 4                |
| 6 — CLI recomposition         | not started            | blocked by 5                |
| 7 — Additional surfaces       | not started            | blocked by 6                |
| 8 — Federation readiness      | not started            | maintainer-gated            |
| 9 — Final hardening           | not started            | blocked by 8 (or waiver)    |

Tracking: issue #725 (the program), PR #727 (Phase 0's control plane).

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
