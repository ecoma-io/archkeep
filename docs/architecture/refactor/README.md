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

Phase 0 (architecture cartography) is complete — the pages below are
populated from six read-only audits, verified against the tree, and are the
program's working map. Nothing in `packages/` has been touched yet; nothing
moves before a phase's entry criteria hold (see
[CONTEXT.md](CONTEXT.md) for state and the last checkpoint):

| page                                         | owns                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| [CONSTITUTION.md](CONSTITUTION.md)           | The refactor's immutable rules — the trade this program refuses to make |
| [INVARIANTS.md](INVARIANTS.md)               | The `INV-*` registry: every invariant, its witness, its honest gaps     |
| [AUTHORITY-MAP.md](AUTHORITY-MAP.md)         | Who may decide what, where judgment lives, and where it is forbidden    |
| [SEMANTIC-MODEL.md](SEMANTIC-MODEL.md)       | Canonical vocabulary and the one owner of each semantic concept         |
| [DATA-FLOW.md](DATA-FLOW.md)                 | The canonical semantic pipeline, input adapters to surfaces             |
| [BOUNDARIES.md](BOUNDARIES.md)               | Allowed dependency direction; enforced versus declared-only             |
| [MIGRATION-PLAN.md](MIGRATION-PLAN.md)       | Phases 1–9, entry/exit criteria, the maturity gate                      |
| [VALIDATION-MATRIX.md](VALIDATION-MATRIX.md) | Invariant/contract/differential coverage; test tiers and gaps           |
| [CONTEXT.md](CONTEXT.md)                     | The restart briefing: current state for any agent resuming the program  |
| [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md)       | Open questions and the doctrine-gap register — never silently decided   |
| [DECISIONS.md](DECISIONS.md)                 | ADRs the refactor inherits; program decisions (`PD-*`)                  |
