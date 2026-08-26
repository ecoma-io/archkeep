# `archkeep history`

Describe how the architecture evolved across a directory of graph snapshots.

For the same question asked across a range of Git revisions — "at which commit
did an architectural change first become observable?" — see
[evolution.md](evolution.md), which reuses this command's classification over
trees materialized from the commits you name.

```shell
archkeep history .archkeep/history
archkeep history .archkeep/history --format json
archkeep history .archkeep/history --format json --output evolution.json
archkeep history .archkeep/history --capture
archkeep history .archkeep/history --capture --format json
```

`history <dir>` reads every snapshot in a directory and produces one evolution
record: the snapshots in history order and the transition between each
consecutive pair, each transition classified by the signals the snapshots
actually carry. It answers, over time, the question `diff` answers across a
single change: _how did the architecture here evolve, and which of those
changes were real?_ For the aggregate over the whole series — signal counts,
churn, persistence — see [`trajectory`](trajectory.md).

## What a transition classifies

Each transition between consecutive snapshots is classified by evidence the
snapshots carry, never by inference:

- **Architecture change** — the graph diff between the two snapshots.
  Added/removed projects and added/removed/changed edges are a change to the
  architecture itself.
- **Policy / intent change** — the `policy.fingerprint` the snapshots carry.
  In 1.x the boundary law a workspace declares _is_ its stated architectural
  intent, so a fingerprint change is a policy change and an intent change at
  once. There is no separate "intent" field — a snapshot carries no record of
  a team's reasons, so this command never invents one.
- **Provider change** — the `workspace.provider` header. A native → nx → moon
  migration is a change to _how the architecture is read_; structural
  differences on either side of it are provider-artefacts, not architecture,
  and the transition says so.
- **Code drift** — provenance (the git commit) advancing while neither the
  architecture nor the policy changed. That is disclosed as drift: the code
  moved without the architecture moving, which an "architecture evolution"
  lens must name rather than bury.
- **Unchanged** — no architecture, policy, or provider signal changed, and no
  code drift. Only then is a transition reported unchanged.

What a snapshot does not carry is disclosed, never asserted. A fingerprint or
provenance on one snapshot and not the other cannot be read as "the same", so
the transition says it could not be compared rather than calling it unchanged.
And rule-impact cannot be recomputed from stored snapshots (they carry the
graph and the policy fingerprint, not the constraint table or import sites), so
every record names that limit — run `check` at any commit for the boundary
verdict, or `diff` for one transition's rule-impact.

## Capturing snapshots: `--capture`

`--capture` appends a snapshot of the current workspace to the directory,
then produces the record that includes it:

```shell
archkeep history .archkeep/history --capture
```

It writes `<sequence>-<sha8>.json` — a zero-padded monotonic sequence and the
snapshot's architecture identity's first eight hex characters, so filename
byte-sort **is** history order. Each snapshot is a full `graph --format json`
envelope (not a delta), so it is content-addressable and self-validating on
read.

Capture deduplicates: when the current architecture identity already is the
last snapshot, no new file is written and no empty transition is manufactured —
a new file for an unchanged architecture would make history lie about the space
between snapshots. A **changed provider** is not deduplicated: a pure provider
migration (nx → moon with an identical graph and policy) changes how the
architecture is read, so it must surface as a transition rather than be
swallowed by the identity match. The JSON envelope's `result.captured` carries
an always-present `duplicate` boolean (`false` for a fresh write, `true` when
the capture deduplicated against the last snapshot) — the shape is not a
function of history-directory state, so the two captures of an unchanged tree
differ in exactly that one readable field and nothing else.

The write is atomic: the snapshot is first written to `<name>.json.tmp` and then
renamed over the final name, so an interrupted capture leaves a partial file
that `history` ignores rather than reads as a snapshot.

Capture refuses to run when the head graph has incomplete coverage: a snapshot
that under-represents the real architecture would corrupt the history. A
snapshot captured from a dirty (uncommitted) tree is not a reproducible claim —
the record discloses it rather than presenting it as a claim about committed
history.

## The directory is the source of truth

`history <dir>` is pointed at a directory you manage — in CI, as a committed or
artifacts directory; locally, wherever you keep snapshots. There is no index
file and no database. The directory itself is the record:

- Order is filename byte-sort, so replacing or deleting a snapshot is moving
  its file.
- `0001-*.json`, `0002-*.json`, … created by `--capture` are already in order.
- An empty directory is not an empty history — it is no record at all, and the
  command says so (exit 3).
- A snapshot that cannot be read, or parses as an incomplete envelope, stops
  the record loudly rather than degrading it.

The captured snapshots live inside the consumer's own tree (the command takes
an absolute or relative directory), so they are not tied to this machine, a
server, or a database.

## Exit codes

| code | meaning                                                                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | The record was produced.                                                                                                                            |
| 2    | Usage error: wrong argument count, unknown flag, or `--output` pointing inside the history directory (the report would be read back as a snapshot). |
| 3    | The directory is empty or unreadable, a snapshot is unreadable or malformed, or (under `--capture`) the head graph has incomplete coverage.         |

`history` never exits 1. Evolution is not a finding.

## Example

Capture the architecture at a commit, later capture again, and describe the
space between:

```shell
git checkout 1.0.0 && archkeep history .archkeep/history --capture
# ... work happens; boundaries move ...
git checkout main && archkeep history .archkeep/history --capture
archkeep history .archkeep/history --format json
```

The second capture writes a new snapshot only if the architecture actually
changed; the `history` record then classifies the transitions between all the
snapshots.

## Dogfooding: this repository's own migration

This repository's `archkeep` command is dogfooded on its own history: the
snapshots in
`packages/archkeep/e2e/fixtures/evolution/` are real bytes captured from two
points on this repository's own timeline — the commit that migrated the
workspace from Nx to Moonrepo and its parent. Describing that directory yields
a record in which all three signals fire in one transition: the two projects'
tag sets changed (architecture), the declared boundary law changed (policy /
intent), and the provider changed nx → moon. It is the proof that the evolution
mechanism can represent a real architectural evolution a human can review.
