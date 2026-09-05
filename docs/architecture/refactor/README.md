# Architecture refactor control plane

The control plane for the architecture refactor program tracked in
[#725](https://github.com/ecoma-io/archkeep/issues/725): semantic core,
capability facades, provider boundary, thin surfaces — restructured without
trading one grain of the maturity the engine has already paid for.

This directory is the program's source of truth. It does **not** restate what
the repository's doctrine already owns: the system boundary and the
intent/reality/state vocabulary are
[`docs/doctrine/architecture-authority.md`](../../doctrine/architecture-authority.md)'s,
the binding principles are
[`docs/doctrine/principles.md`](../../doctrine/principles.md)'s, and decisions
land in [`docs/adr/`](../../adr/) as numbered records. Every page here links
to those instead of quoting them, and the refactor is bound by all of them.

Bootstrap state — the pages below are being populated by the Phase 0
architecture cartography (audit first, code later; nothing moves before the
map exists and is accepted):

| page (planned)         | owns                                                                    |
| ---------------------- | ----------------------------------------------------------------------- |
| `CONSTITUTION.md`      | The refactor's immutable rules — the trade this program refuses to make |
| `INVARIANTS.md`        | The `INV-*` registry: every invariant, its existing owner, its test     |
| `AUTHORITY-MAP.md`     | Who may decide what, where judgment lives, and where it is forbidden    |
| `SEMANTIC-MODEL.md`    | Canonical vocabulary and the one owner of each semantic concept         |
| `DATA-FLOW.md`         | The canonical semantic pipeline, input adapters to surfaces             |
| `BOUNDARIES.md`        | Allowed dependency direction; forbidden dependencies, enforced or not   |
| `MIGRATION-PLAN.md`    | Phases, PRs, exit criteria, rollback points                             |
| `VALIDATION-MATRIX.md` | Invariant/contract/differential coverage; the test tier registry        |
| `CONTEXT.md`           | The restart briefing: current state for any agent resuming the program  |
| `OPEN-QUESTIONS.md`    | Semantic ambiguities under research — never silently decided            |
