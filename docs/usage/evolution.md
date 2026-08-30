# `archkeep evolution`

Describe how the architecture evolved across a selected range of Git
revisions — and at which analyzed revision an architectural change was first
observable.

```shell
archkeep evolution --base v1.2.0
archkeep evolution --base main~10 --head HEAD
archkeep evolution --base <commit-sha> --head <commit-sha> --format json
archkeep evolution --base v1.0.0 --output evolution.json
```

`history` answers "how did the architecture evolve across the snapshots that
were explicitly captured". `evolution` answers the same question over a range
of commits you name: it resolves both endpoints in your repository,
materializes every selected commit into a temporary worktree, runs the ordinary
analysis over each one, and classifies each consecutive transition with exactly
the machinery `history` uses — the commit SHA standing in for the snapshot
filename.

The division of labor is absolute: **Git is a revision source, not a second
architecture engine.** Git answers which trees to read; Archkeep owns every
judgment about what those trees mean. Nothing here parses diffs, blames lines,
or reads commit messages for meaning.

## What a transition means

Each transition between consecutive revisions carries the same classification
as a `history` transition:

- **Architecture change** — the graph diff between the two analyzed trees.
- **Policy / intent change** — the boundary law's fingerprint, where each
  revision's law is the one its own tree declares. There is no `--config`
  override on purpose: a law carried from outside would attribute policy
  changes to revisions that never made them.
- **Provider change** — how the architecture was read (nx / native / moon).
- **Code drift** — provenance advancing while neither the architecture nor the
  policy changed: code moved without the architecture moving, and the record
  names it rather than burying it.
- **Unchanged** — only when every comparable signal is verifiably unchanged.

What a pair of revisions cannot establish is disclosed, never asserted: a
policy neither side declares cannot be read as "the same", so no drift or
unchanged verdict ever rests on it.

## What attribution means — and does not

A change is attributed to the first analyzed revision where it is observable:

> the alpha → beta edge is first observed at `3f9c…`

That is a fact about **where history shows the change**, not about why it was
made. Commit messages are not evidence this tool can verify, so none are read;
"introduced by", "caused by", and intent language have no basis here and this
command never uses them. Two humans arguing over blame need `git log`; two
humans arguing over _what_ moved and _when_ it became observable can use this
record.

## Revision selection

| flag          | argument | default |                                                                                  |
| ------------- | -------- | ------- | -------------------------------------------------------------------------------- |
| `--base`      | `<rev>`  | (none)  | Required. A commit SHA, branch, tag, or `HEAD~n`; resolved with `git rev-parse`. |
| `--head`      | `<rev>`  | `HEAD`  | The tip; must be a linear descendant of `--base`.                                |
| `--event-out` | `<dir>`  | (none)  | Append one EvolutionEvent per revision pair to `<dir>` (idempotent).             |

The selected set is `[base, …every commit in base..head]`, oldest first —
always bounded by what you named, never a whole-repository traversal. Both
endpoints are peeled to full SHAs and reported as such in JSON, whatever
spelling you typed.

### Merges are refused, not flattened

Every commit inside the range must have exactly one parent. A merge commit
refuses the run loudly, naming its SHA — flattening a merge would pin a whole
branch's architectural changes onto one commit and hide the branch entirely.
There is no `--first-parent` mode; until there is one, select ranges that end
before a merge or start after it.

## Per-pair comparison evidence

Beyond the transition classification above, each transition carries a
comparison attention report — eight questions answered on that one revision
pair — from the envelope fields the command already computed
([`result.transitions[i].comparison`](../reference/json-output.md)) and from
the whole range
([`result.summary`](../reference/json-output.md)):

1. **Observed** — architecture changed, projects and edges added/removed/changed,
   policy/provider/provenance changed.
2. **Drift findings** — drift introduced and resolved between the pair.
3. **Intent debt** — the intent verdict's closed debt and newly opened debt.
4. **Fitness** — per fitness-function verdict deltas across the pair, with
   coverage.
5. **Classifications** — the same `CHANGE`/`DRIFT`/`VIOLATION`/`REPAIR`/
   `DECISION_CHANGE` vocabulary as the transition row.
6. **Disposition** — `accepted` / `rejected` / `no-verdict`.
7. **Affected** — the projects, module boundaries, constraints, and decisions
   the pair touches.
8. **Notes** — every disclosure the pair made.

An axis the pair could not answer is **`n/a` with a reason**, never folded into
silence and never into a fabricated clean answer: an unreadable ADR registry,
an intent that could not be judged, or a fitness block declared on only one
side all read as `n/a — <reason>`. There is no numeric health score anywhere in
the record; a verdict is a word, not a number.

## EvolutionEvent output (`--event-out`)

`--event-out <dir>` appends one EvolutionEvent per revision pair to `<dir>`
([`docs/concepts/evolution.md`](../concepts/evolution.md) owns the event
model). The write is **idempotent**: an event's identity is derived from the
pair's full SHAs (and snapshot ids) alone, so re-running the same range records
a duplicate (`duplicate: true` in the store's answer) and writes nothing new —
the store never guesses idempotency, it proves it. A missing directory is
created on first use. When the flag is absent no event is written and the
output is byte-identical to a run before the flag existed.

## Safety

**Your working tree is never touched.** Every analyzed revision is materialized
with `git worktree add --detach` into a temporary directory and removed before
the run reports — the analysis reads committed state, never your desk.
Uncommitted changes belong to no analyzed revision by construction; when your
tree is dirty, the record says so in `coverage.notes` instead of letting you
assume the tip analysis saw them. All revisions come from one repository —
yours — so cross-repository provenance cannot arise inside a run, and every
transition's origins share it.

**Every failure is loud.** These refuse the run (exit 3) rather than produce a
shorter or emptier record:

- an unknown revision, coincident endpoints, a base off head's ancestry;
- a merge commit inside the range;
- a revision that is not a readable workspace (say, before the workspace model
  was introduced) or whose analysis leaves whole files unread — the same bar
  `history --capture` holds;
- a boundary law a revision names but that will not load;
- any git failure, including a shallow clone whose cut-off sits below
  `--base` — missing history never reads as "unchanged".

## Performance

Cost is O(selected revisions) temporary worktrees × one full analysis each,
performed sequentially with at most one worktree alive at a time. A range of
100 commits runs 100 analyses; wide ranges are slow by construction, so name
the narrowest range that answers your question. The Nx provider additionally
spawns `nx graph` per revision inside its worktree, which needs that
revision's toolchain resolvable; the native provider needs nothing but this
package.

## Determinism

The same repository at the same SHAs produces byte-identical JSON: revisions
are ordered by git's own oldest-first walk, identities are content hashes, no
timestamps, author names, or temp paths appear anywhere in the output. Commit
SHAs are the only time-facing identity in the record, and they are exactly as
stable as the commits themselves.

## Exit codes

| code | meaning                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------ |
| 0    | The record was produced.                                                                                           |
| 2    | Usage error: missing `--base`, an unknown flag, or stray positional arguments.                                     |
| 3    | An unusable selection, a revision that cannot be fully analyzed or read as a workspace, or a failed git operation. |

`evolution` never exits 1. Where the architecture changed is a fact about
history, not a finding about your tree.

## Example

```text
$ archkeep evolution --base v1.0.0
evolution  9a41b2c7de55..f00d1a2b3c45
5 revisions, 4 transitions (11 imports in 6 files across 2 projects)
0  9a41b2c7de55…  1f0e2d3c
1  44ba9ce01a77…  9b8a7d6f
2  c3d4e5f60a19…  1f0e2d3c
3  e5f60718293a…  55443322
4  f00d1a2b3c45…  1f0e2d3c
~ 9a41b2c7de55… → 44ba9ce01a77…  (architecture)
  + 1 added edge
  alpha → beta (static)
~ 44ba9ce01a77… → c3d4e5f60a19…  (code drift)
~ c3d4e5f60a19… → e5f60718293a…  (architecture)
  - 1 removed edge
  alpha → beta (static)
~ e5f60718293a… → f00d1a2b3c45…  (policy)
✔ 2 transitions recorded an architectural change
```

Two architectural transitions around a revert stay visible as a sequence —
nothing collapses into "final state". The JSON envelope carries the same
record with full SHAs (`result.base`, `result.head`, `result.revisions`,
`result.transitions`);
[../reference/json-output.md](../reference/json-output.md) documents the shape.

## What this deliberately is not

No whole-history mining, no causality claims, no blame inference, no health
scores over time, no predictions. Those are the intelligence directions the
repository's roadmap ([../doctrine/roadmap.md](../doctrine/roadmap.md)) stages
for later maturity; this command stops at deterministic, revision-backed
evolution evidence — the same line `history` draws, one revision source over.
