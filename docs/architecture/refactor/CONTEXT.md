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
the verified map, and each phase re-verifies what it touches.

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

- **ID**: CHK-0. **Phase**: 0. **Status**: complete, pending review.
- **Goal**: map the architecture as it is — authority, semantic model, data
  flow, boundaries, tests — with every load-bearing claim verified against
  the tree, and lock the control plane before any code change.
- **Invariants protected**: none changed (read-only phase). All 24 INV rows
  were inventoried with witnesses and gaps ([INVARIANTS.md](INVARIANTS.md)).
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
  the corrected claim is the one these pages now carry.
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
- The audit reports behind CHK-0 were session artifacts (`/tmp`); the control
  plane is the durable record — anything load-bearing from them is already
  in these pages with citations.
