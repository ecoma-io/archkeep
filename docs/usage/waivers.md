# `archkeep waivers`

List term-bound suppressions and permanent suppressions, with their current coverage.

```shell
archkeep waivers
archkeep waivers --format json
```

`waivers` reports every row in `boundarySuppressions` that carries an `expiresAt`
(term-bound waivers) alongside every row that does not (permanent suppressions).
For each row it lists the path, the term, the reason, and which violations it
currently covers. Coverage is judged against the full finding set with the table
removed — so a row that names a file the tree never visits reads as
covers-nothing, not as quietly doing its job.

This is the only surface that names permanent suppressions. A permanent row never
appears in `check`'s findings at all (that removal is the mechanism working as
designed), and a tree with no waivers but at least one permanent suppression
does **not** read as "every boundary is enforced": that claim is true only when
this command measured both halves of the table and found each one empty.

## What the report contains

For every row in `boundarySuppressions`:

- **Path** — the glob pattern or file path the row names
- **Term** — for waivers, the `expiresAt` instant; for permanent suppressions,
  `none`
- **Reason** — the mandatory `reason` field
- **Coverage** — how many violations this row currently covers, zero-indexed.
  A stale waiver (one that covers nothing) is surfaced loudly as dead weight,
  never silently forgotten
- **Status** — for waivers, `active` or `expired` based on the current shared
  governance clock; for permanent suppressions, `permanent`

The report also lists coverage acceptances from `coverage.unowned` rows — a
third table that accepts files owned by no project, judged by nothing — so "no
waivers — every boundary is enforced" is never claimed over a table that is
accepting coverage holes unmeasured.

## Exit codes

| code | meaning                                                           |
| ---- | ----------------------------------------------------------------- |
| 0    | The suppressions table was read and reported.                     |
| 2    | Usage error: unknown flag, wrong argument count.                  |
| 3    | Coverage is incomplete — at least one file could not be analyzed. |

`waivers` never exits 1. A run with only waived violations still exits 1 in
`check`, but `waivers` itself is descriptive: it reports the state of the
table, never a finding.

## The shared governance clock

Waiver expiry is judged against an injectable, deterministic clock. A command
takes its reference instant from `referenceTime()`, and a test drives the same
command at a fixed `now`. Two runs over an unchanged tree and an unchanged
injected time produce byte-identical bytes — the determinism rule every
governance capability shares.

Without an injected clock — every real `archkeep waivers` run — `remainingMs`
is the one field that differs run to run, because it names time remaining as
of right now. See [the JSON reference](../reference/json-output.md) for the
exact contract, including how this field is excluded from the envelope's
determinism promise.

## Stale rows

A row that currently covers no violation is **stale** — the finding it accepted
was fixed, or the glob never matched this run's findings. Archkeep never deletes
a row for you — waivers are recorded, and a stale one is surfaced loudly. A
stale waiver is dead weight in the table; a stale permanent suppression is
unjustified silence. Both are findings for a human reviewer to address.

The reference page for the command is [`../reference/provenance.md`](../reference/provenance.md).
The concept that defines the lifecycle and distinction is
[`../concepts/waivers.md`](../concepts/waivers.md).
