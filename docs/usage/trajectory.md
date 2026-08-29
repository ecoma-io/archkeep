# `archkeep trajectory`

Aggregate the deterministic drift trajectory across a directory of graph
snapshots: which signals moved, by how much in total and net, and what
persisted through every observation.

```shell
archkeep trajectory .archkeep/history
archkeep trajectory .archkeep/history --format json
archkeep trajectory .archkeep/history --format json --output trajectory.json
```

`trajectory <dir>` reads the same snapshots as
[`history`](history.md) — the same reader, the same per-transition
classification — and answers the question an event list cannot: **across the
whole series, which deterministic signals fired how often, what did the graph
gain and lose, and what was there at every observation?** Where `history`
shows each transition, `trajectory` counts them.

## What a trend means here

A trend is **a count or a set that changed over an ordered sequence of
observations**. That is all it is.

Archkeep reports trajectories of deterministic evidence rather than inventing
a subjective architecture-health score. Nothing in this command weights a
signal, combines counts into a composite, or decides whether more edges or
fewer signals is "better" — there is no score to game and no threshold to
drift. Every number below is either read off stored snapshot bytes or derived
from them by a stated rule; deciding what the movement means belongs to the
human or agent reading the result
([architecture-authority](../doctrine/architecture-authority.md): Archkeep
computes verdicts from source; it does not reason about them).

The command is also silent about cause. A signal count says how often
something moved between observations; it never says why, and it never implies
a commit caused anything.

## Transition classifications

Every transition in the JSON envelope also carries the canonical evolution
classes — `classifications`, the same vocabulary and predicates the
[`evolution` command's events](../concepts/evolution.md#classification) use:
`CHANGE`, `DRIFT`, `VIOLATION`, `REPAIR`, and `DECISION_CHANGE`. The classes
are computed by the one classification function (`classifyEvolution`) from the
signals a transition's own record carries — never a second opinion, and never
a class the evidence does not support.

For trajectories, only `CHANGE` and `DRIFT` can appear: the tenet that stored
snapshots hold no findings means no violation, repair, or decision-change
evidence ever exists in a transition's record, and
[the one-sided rule](../concepts/evolution.md#the-one-sided-rule) means a
pair whose metadata could not be compared carries `[]` with a disclosure
note, never a fabricated class.

## The observation basis: snapshots are not commits

One observation is **one stored `graph --format json` snapshot** — a capture
point. The result names its basis (`observations.basis` is
`"graph_snapshots"`), and no field converts observations into days, weeks,
commits, or capture attempts:

- Capture deduplicates unchanged architectures, so N observations means
  "N recorded states", not "N commits examined" and not "N runs".
- Two teams capturing at different cadences produce different counts for the
  same amount of real change. Compare trajectories within one history
  directory; do not compare raw counts across directories captured on
  different schedules.
- A hand-copied snapshot file is an observation like any other — the
  directory is the record, whatever wrote its files. Two byte-identical files
  are two observations recording the same state (an `unchanged` transition
  between them), exactly as they are for `history`; delete duplicates before
  aggregating if that is not what you meant to record.

## What the aggregate reports

**Signals** (independent counters over the consecutive pairs, not a partition
— one pair can fire several at once):

| field          | meaning                                                                        |
| -------------- | ------------------------------------------------------------------------------ |
| `architecture` | pairs whose graph diff moved (projects or edges added/removed/changed)         |
| `policy`       | pairs where both fingerprints were present and differed                        |
| `provider`     | pairs where the provider header changed (nx → native → moon)                   |
| `codeDrift`    | provenance advanced while architecture AND policy verifiably stayed            |
| `incomparable` | pairs whose fingerprint or provenance could not be compared (one side missing) |
| `unchanged`    | pairs where every comparable signal was compared and none moved                |

These reuse `history`'s classification unchanged — same records, same notes,
one law. Two aggregate-specific rules follow from the invariant that an empty
result is a claim (the repository AGENTS.md):

1. **An incomparable pair never counts as `unchanged`.** `history` labels such
   a transition "unchanged" but carries the caveat as a note beside it; an
   aggregate has no notes line, so the exclusion IS the disclosure. The
   specific caveats are counted under `disclosures` (`policyOneSided`,
   `provenanceOneSided`, `crossRepo`).
2. **Code drift is never asserted on unverifiable metadata.** It requires both
   sides to carry provenance and both sides' fingerprints to have been compared
   and equal — exactly what `history` requires per transition.

**Structure**, one block for projects and one for edges. Identities are
[`diff`'s own](../usage/diff.md): a project is its `name`; an edge is its
`(source, target, type)` triple — so an edge type flip counts as one removal
plus one addition, not as a mysterious "change".

| field                          | meaning                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `first`, `current`             | counts in the first / last observation                                                                                 |
| `delta`                        | `current − first` — net movement                                                                                       |
| `addedEvents`, `removedEvents` | cumulative transition events — churn. Add → remove → add is two additions and one removal                              |
| `changedEvents`                | projects only: metadata churn (tags/type/root). Edges have none: under the triple identity a type change IS remove+add |
| `introduced`, `resolved`       | endpoint sets only: in last-not-first / in first-not-last                                                              |
| `persistent`                   | present in EVERY observation, first through last                                                                       |

Events and endpoints answer different questions on purpose. Over
0 → 2 → 3 → 1 → 0 edges, the endpoint fields read `delta 0, introduced 0,
resolved 0` while the events read `added 3, removed 3` — the series churned
and returned, and both halves of that sentence are reported rather than one
hiding the other.

## The trends block

`result.trends` is the per-class answer over the SAME comparable transitions
the axes count: how often each evolution class fired, and the
violations-introduced vs resolved totals. It is a block of counts with a
stated `basis` — never a score, never a weighted aggregate, never a
judgment ([the invariant above](#what-a-trend-means-here) applies to it).

| field                   | meaning                                                                                                                                                                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `byClass`               | `{CHANGE, DRIFT, VIOLATION, REPAIR, DECISION_CHANGE}` — one count per class, over comparable transitions whose `classifications` carry it. A transition may carry several classes and counts in each; a comparable transition carrying none (`[]`) counts in `comparableTransitions` but in no bucket |
| `violationsIntroduced`  | How many transitions added violations. For snapshot-sourced transitions this is always `0` — see the `note`                                                                                                                                                                                           |
| `violationsResolved`    | How many transitions resolved violations. Same evidence limit as `violationsIntroduced`                                                                                                                                                                                                               |
| `comparableTransitions` | `transitions.count − transitions.incomparable` — the exact subset the counts are a claim about                                                                                                                                                                                                        |
| `basis`                 | `"comparable transition classifications"` — what the counts are, as a value                                                                                                                                                                                                                           |
| `note?`                 | A disclosure present on every block: stored snapshots carry no findings, so `VIOLATION`/`REPAIR` and the `violations-*` totals are `0` because no finding could be classified, never because none occurred                                                                                            |

The counts share the axes' comparability rule exactly: a pair whose
`policyOneSided` or `provenanceOneSided` disclosed it cannot be compared is
counted under `transitions.incomparable` and nowhere else — it is neither a
class bucket nor part of `comparableTransitions`. That is why the block can
be `null` while the trajectory itself is available: a history whose every
transition was incomparable has no comparable classification basis, and
`trends` says so instead of printing zeros.

No numeric health score exists anywhere on this surface — `byClass` counts
`CHANGE` as often as `DRIFT`, arithmetic the reader is free to do, and no
field does it for you.

## Unknown evidence, sparse history, and what is refused

- **Empty directory** — exit 3, no envelope. Zero snapshots is no record at
  all, never a clean trajectory.
- **Malformed or unreadable snapshot** — exit 3. A broken observation stops
  the run loudly instead of quietly dropping out of every average.
- **One snapshot** — exit 0 with `available: false` and
  `unavailableReason: "insufficient_history"`. There is no consecutive pair
  to classify, so every derived field (`delta`, the event counts,
  `introduced`, `resolved`, `persistent`) and `trends` is `null` —
  explicitly unavailable, never zero. A zero would claim stability over a
  history that cannot show movement.
- **Two snapshots** — deltas and event counts become available; they describe
  exactly one transition. Persistence across two observations means only
  "present in both", which is all the evidence supports.
- **Every transition incomparable** — `available: true` but `trends: null`:
  no comparable transition exists to derive a classification basis from, and
  a zero-filled block would claim "no change" over evidence the run could not
  compare. The `transitions.incomparable` count says why.
- **Dirty captures and missing provenance** are counted, not hidden:
  `observations.dirtyProvenance` and `observations.withProvenance` tell you
  how much of the series the code-drift signal could actually speak about.

```json
{
  "result": {
    "observations": {
      "count": 5,
      "basis": "graph_snapshots",
      "first": "0001-bd99dc43.json",
      "last": "0005-16b61777.json",
      "withProvenance": 5,
      "dirtyProvenance": 0
    },
    "available": true,
    "unavailableReason": null,
    "transitions": {
      "count": 4,
      "architecture": 2,
      "policy": 1,
      "provider": 0,
      "codeDrift": 1,
      "incomparable": 0,
      "unchanged": 0
    },
    "disclosures": { "policyOneSided": 0, "provenanceOneSided": 0, "crossRepo": 0 },
    "projects": {
      "first": 3,
      "current": 5,
      "delta": 2,
      "addedEvents": 4,
      "removedEvents": 2,
      "changedEvents": 1,
      "introduced": 3,
      "resolved": 1,
      "persistent": 2
    },
    "edges": {
      "first": 8,
      "current": 11,
      "delta": 3,
      "addedEvents": 9,
      "removedEvents": 6,
      "resolved": 4,
      "persistent": 5
    },
    "trends": {
      "byClass": {
        "CHANGE": 2,
        "DRIFT": 1,
        "VIOLATION": 0,
        "REPAIR": 0,
        "DECISION_CHANGE": 0
      },
      "violationsIntroduced": 0,
      "violationsResolved": 0,
      "comparableTransitions": 4,
      "basis": "comparable transition classifications",
      "note": "transition classifications carry no violation or repair evidence — stored snapshots hold the graph and the policy fingerprint, not findings"
  }
}
```

Read aloud, that example says: five recorded states, four transitions; two of
them moved the graph, one changed the declared law, one advanced code without
moving either. Three projects arrived since the start and one left; four
project-additions and two removals happened in total. Seven edges exist now
that did not at the start; nine additions and six removals happened in total;
five edges and two projects were present at every single observation. The
trends block adds the classification reading: two transitions were `CHANGE`,
one was `DRIFT`, all four were comparable, and the violation/repair counts
are `0` because snapshots carry no findings — that last half is stated, never
left to read. It does NOT say whether any of that is good.

## What trajectory deliberately does not do

- **No violation-level trajectory.** Stored snapshots carry no findings — no
  constraint table, no import sites — so no boundary violation has a stable
  identity across them, and none is invented. `delta` classifies real
  violations between two live points; [`debt`](debt.md) ages today's ledger
  facts across snapshots. Run `check` at any commit for a point-in-time
  verdict. The `trends` block inherits the limit: its `VIOLATION`/`REPAIR`
  and `violations-*` fields are `0` with a note, never a silent claim.
- **No Git.** The command reads stored snapshots only. It reconstructs no
  historical commits, spawns no git log, and works on a directory copied to a
  machine with no repository at all.
- **No prediction, no AI, no scoring.** No model projects the trajectory
  forward; nothing aggregates into a health score — the `trends` block is
  raw per-class counts with no weighting, threshold, or direction adjective;
  no natural language is generated beyond the fixed sentences above.
- **No second definition of time.** Age-in-snapshots remains
  [`debt`'s semantics](debt.md); this command adds no clock, no calendar, and
  no conversion from observations to any unit of time.

## Exit codes

| code | meaning                                                                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | The trajectory was produced — including the one-snapshot `insufficient_history` answer, which is a fact about the directory, not a failure.         |
| 2    | Usage error: wrong argument count, unknown flag, or `--output` pointing inside the history directory (the report would be read back as a snapshot). |
| 3    | The directory is empty or unreadable, a snapshot is unreadable or malformed, or the workspace root could not be established.                        |

`trajectory` never exits 1. Aggregation is not a verdict.

## Example

```shell
git checkout v1.0.0 && archkeep history .archkeep/history --capture
# ... work happens ...
git checkout main && archkeep history .archkeep/history --capture
archkeep trajectory .archkeep/history
```

An agent consuming `--format json` can answer, mechanically: what changed
recently (`history`'s last transition), which structural entities persisted
(`projects.persistent`, `edges.persistent`), whether churn exceeds net
movement (`addedEvents + removedEvents` against `abs(delta)`), how much
history actually supports the claim (`observations.count` and
`observations.withProvenance`) — and it gets `null`s, never zeros, wherever
the directory cannot support an answer.
