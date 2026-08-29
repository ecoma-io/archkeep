# `archkeep debt`

Print the architecture-debt ledger: the exemptions, gaps and contradictions a
workspace is carrying, each aged across the snapshot history.

```shell
archkeep debt .archkeep/history
archkeep debt .archkeep/history --format json
archkeep debt .archkeep/history --format json --output debt.json
archkeep debt .archkeep/history --events .archkeep/evolution
```

`debt <dir>` reads every snapshot in the same history directory `history` uses
and answers, over that record: _what architecture debt is this workspace
carrying, how long has each item been carried, and how badly does it bite?_
It is not a finance metaphor — age, count and severity only, no interest.

It is a **report, not a gate**: it never changes a verdict and never exits 1.
`check` remains the only command that fails a build; `debt` exists to make the
same candid facts visible as a tracked, aging ledger.

## What the ledger lists

- **Waivers** — every `boundarySuppressions` row: a violation the workspace
  decided to accept, with the mandatory reason it accepted it. The debt is the
  accepted violation itself.
- **Aspirational gaps** — every `"optional": true` intent row not yet built: a
  stated dependency that does not exist yet. It changes no verdict, but it is
  debt.
- **Drift findings** — the observed architecture contradicting the declared
  intent. A finding in a project that also carries an accepted waiver ranks
  HIGH, and the waiver is still listed — a waiver that is failing today is
  never hidden.
- **Unresolved intent** — a boundary that matched nothing. Its severity reads
  `unknown`, never a clean ledger.

## What "age" means

Age is measured in snapshots, not days. The ledger ages each debt by its
_owning project_: how many consecutive snapshots that project has been part of
the architecture. A waiver's owning project is the project whose root the
suppression path falls under; a drift finding's is its source project. A whole
history of N snapshots gives a project seen in all of them age N; one seen only
now has age 1. With fewer than two snapshots the report says
`ages not yet established` and every age reads 0 — "observed, not yet aged",
never "born yesterday".

## Debt lifecycle

Every ledger entry carries a **stable id** and a **status** (`active` today,
or `resolved`), so a debt can be tracked as it is introduced and retired — not
just counted.

### Stable ids (no clock)

Each entry's `id` is a SHA-256 over its semantic identity — `{kind, source}` —
the same mechanism evolution events use for their ids, never the wall clock, a
sequence or a random. The same fact always hashes to the same id, across runs
and across a waiver's expiry (an `expired-waiver` keeps the id of the same
waiver unexpired). Two runs over the same facts produce identical entry ids and
counts — the ledger is idempotent; the `active`/`resolved` split
is additive and never changes the existing fields.

### Linking an event store

`--events <dir>` points `debt` at the append-only evolution event store
([`evolution`](./evolution.md)); the ledger then reads it so:

- an active entry carries `introducedBy` — the event that first named its id in
  `debt.introduced`;
- a closed entry appears on the `resolved` list with `resolvedBy` — the REPAIR
  event whose `debt.resolved` names the id and whose fact is gone at head.

Absent `--events`, no ref is ever guessed: `introducedBy`/`resolvedBy` are
omitted, `resolved` stays empty, and the report says
`no event store linked — lifecycle refs unavailable`. The **`active` + `resolved`
lists together are the whole lifecycle surface**; a closed entry is retained on
`resolved`, never deleted from history. Introducing then repairing debt makes
the active count decrease while the resolved record is kept (monotonicity).

For the id rule, the entry kinds, age and severity, and the refusals, see
[the reference](../reference/debt.md).

## Docker / sources of truth

`debt` is pointed at the same consumer-managed directory `history` uses — in CI,
as a committed or artifacts directory; locally, wherever you keep snapshots.
There is no index file and no private store: the ledger is rebuilt from the
current boundary config, the tracked `architecture-intent.json`, and the
directory of `graph --format json` snapshots. A snapshot directory that is missing,
malformed, or holds no snapshots at all is a no-verdict, never an empty ledger.

To keep a ledger current, capture snapshots as the architecture evolves:

```shell
archkeep history .archkeep/history --capture
archkeep debt .archkeep/history
```

## Exit codes

| code | meaning                                                                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | The ledger was produced — including a long or alarming one.                                                                                                    |
| 2    | Usage error: wrong argument count or an unknown flag.                                                                                                          |
| 3    | No verdict: missing `architecture-intent.json`, an intent that cannot be verified, incomplete graph coverage, or an unreadable or malformed history directory. |

`debt` never exits 1. Debt is not a finding — the finding exit stays with
`check` and `fitness`.

## Example

```text
debt  .archkeep/history
3 entries across 12 snapshots — a snapshot-relative ledger
1 waivers (accepted boundary violations):
  [waiver] low  apps/admin/legacy.go  (age 12, count 1)
    the accepted violation at 'apps/admin/legacy.go' is still suppressed — owning project 'admin'
1 aspirational gaps (optional allowed rows not built):
  [aspirational-gap] low  optional allowed intent "core" → "notifications" is not yet observed — aspirational, not drift  (age 0, count 1)
    an optional allowed row is not yet built — either build it or remove the row
1 drift findings:
  [drift] high  admin  (age 12, count 1)
    this drift finding is in a project with an accepted waiver — the accepted violation is failing again, resolve it or remove the waiver
total 3 entries · byKind: waiver 1, aspirational-gap 1, drift 1, unresolved 0 · bySeverity: high 1, medium 0, low 2
sampled 2026-08-16T12:18:50.279Z
✔ complete (2 imports in 3 files across 2 projects)
```

An age of 12 next to a waiver means the waiver's owning project has been part
of every one of the 12 snapshots — the debt has been carried the whole record.
The HIGH drift finding is the waiver-return-to-FAIL case: the accepted
violation is failing again. The ledger names it loudly, and the waiver is still
listed.

The `--format json` output is the same ledger in the versioned envelope, with
`result.total`, `result.byKind`, `result.bySeverity`, and `result.agings` —
additive, deterministic, and byte-identical across runs over an unchanged
tree. `result.sampleTime` is the one exception: it is the wall clock at the
moment of the run, not a fact about the workspace, so it differs between two
runs even when nothing else does — `result.coverage.notes` names it on every
run, and [the reference](../reference/json-output.md#result-for-command-debt)
is the exact contract.

For the four entry kinds, the age model, and the refusals, see
[the reference](../reference/debt.md).
