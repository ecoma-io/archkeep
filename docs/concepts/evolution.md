# Evolution

Every evolution command (`history`, `delta`, `change`, `evolution`) records how
the architecture moved between two states. Before the evolution event, each of
them recorded that movement in its own private shape, with no stable identity
and no shared vocabulary — so evolution evidence was not reproducible, not
idempotent, and not comparable across commands. The **evolution event** is the
one canonical record they all emit, and the **event store** is the one
append-only, idempotent place that record lands.

This page is the model. The implementation lives in
`packages/archkeep/src/governance/evolution-event.mjs` (the record, the
identity, the classification predicates) and
`packages/archkeep/src/governance/evolution-store.mjs` (the store), and the two
must not disagree with what is written here.

## The event

```json
{
  "schemaVersion": 1,
  "kind": "transition",
  "source": "delta",
  "id": "92f4…a1c0",
  "dedupeKey": "{\"base\":…,\"head\":…}",
  "recordedAt": { "by": "ci", "tool": "archkeep:v1", "on": "2026-08-30T00:00:00.000Z" },
  "base": { "revision": "abc123", "snapshot": "3f9c…8b21" },
  "head": { "revision": "def456", "snapshot": "c41a…d70e" },
  "evidence": "evidence/baseline.json",
  "declaration": { "file": "change-intent.json", "digest": "7d0c…9e11" },
  "observed": {
    "architectureChanged": true,
    "projects": { "added": ["libs/beta"], "removed": [], "changed": [] },
    "edges": { "added": ["libs/beta>libs/alpha:dep"], "removed": [] },
    "policyChanged": false,
    "providerChanged": false
  },
  "affected": {
    "projects": ["libs/beta"],
    "boundaries": ["libs/beta>libs/alpha:dep"],
    "constraints": [],
    "decisions": []
  },
  "findings": { "introduced": [], "resolved": [], "unknown": [] },
  "fitness": { "verdictDeltas": [] },
  "debt": { "introduced": [], "resolved": [] },
  "classifications": ["CHANGE"],
  "disposition": "accepted",
  "notes": [],
  "provenance": [{ "kind": "git-commit", "ref": "def456" }]
}
```

The record carries **references, never graphs**: `base`/`head` name revisions
and snapshot identities — the hash `snapshotIdentity` computes over exactly the
graph that side was judged over — `findings`/`debt` carry identity strings, and
each `affected` list holds identity strings only. An event is a pointer into the
evidence, not a second copy of it. The two commands that consume a baseline
file (`delta`, `change`) also disclose where that file sat on the writing
machine in a top-level `evidence` reference, the same way a `change` event's
`declaration.file` names the intent file — a storage pointer, deliberately
outside the identity.

Those identity strings are delimiter joins — an edge spells
`source>target:type`, a violation finding spells `messageId:source:target`
with `-` written for an absent source project — and every field that carries a
delimiter (`>`, `:`) or the escape character (`\`) is escaped (`\>`, `\:`,
`\\`; a field that is exactly the `-` sentinel escapes to `\-`). The
unescaped `>` and `:` in a stored string are therefore exactly the separators,
so two distinct edges — or two distinct findings — can never join to one
string and dedup into one row (#627, #628). A field carrying none of those
characters is spelled byte for byte as it always was: the escaping is
conditional precisely so the stored events of workspaces whose names never
carried a delimiter do not change.

## Identity: the id and the dedupeKey

An event's `id` is `sha256(canonicalizeJson({ base, head, declarationDigest }))`
— the hash of the canonical tuple, over only three values:

- `base` and `head`, the references to the two states,
- `declarationDigest`, the digest of the change-intent that declared the
  change (absent for transition-kind events, and its absence is part of the
  tuple — an event with a declaration is a different event from the same
  base/head without one).

The `dedupeKey` is **that same canonical tuple** — the plain serialization the
id hashes. One definition, two faces: the id names the event, the key is what
the store dedupes on, so a rerun can never produce an event that names one
tuple and dedupes against another.

**The clock is excluded, and so is the narration.** `recordedAt`, `notes`, and
`provenance` never enter the identity. The consequence is the whole point:
re-running the same transition — at a different time, from a different
worktree, with differently-worded notes — produces the _same_ id and the _same_
dedupeKey, so the store can prove idempotency instead of guessing it. An id
that included `recordedAt` would make every rerun a new event, and re-running
`archkeep change --event-out` over an unchanged transition would append a
duplicate of itself forever.

**Nor does a storage path.** The identity sides carry the state itself — a
`revision` and the snapshot identity — never a file location, so the same
transition judged over the same evidence at a different path (a copied
worktree, a different CI checkout, a machine whose evidence directory lives
elsewhere) is the same event and the store dedupes it. The writing machine's
path reaches the record only through the top-level `evidence` disclosure
described above, which no part of the tuple hashes.

**The identity is only reproducible from committed, clean evidence.** A
commitless head serializes its `head` as `{}`, and a dirty tree names a commit
its evidence does not back — either way two distinct evidence states collapse
onto one event id, and a later transition is silently lost or aliased. So the
two event-writing commands that can run against an uncommitted desk — `delta
--event-out` and `change --event-out` — refuse the write loudly instead
(exit 3), naming the command and the reason. The same run without
`--event-out` is unaffected: the gate is the write, never the verdict.
`history --event-out` needs no gate, because it analyzes committed revisions
in detached worktrees by construction — its events are reproducible by
construction too.

`declarationDigest` covers only the **declarative** parts of a normalized
change-intent — `{ version, base, projects, edges, constraints }`. The prose
`summary` is excluded, because prose is not semantics: two runs whose summary
was re-worded must produce the same digest, or the digest would be a function
of narration rather than of the declared change.

## Classification

`classifyEvolution(input)` decides every class from the evidence signals the
caller supplies — structural diff, `codeDrift`, `policyChanged`, the delta
classification of violations with their waiver state, declared constraint and
intent-row verdicts, and the ADR registry states on both sides. It never
invents a second opinion: each class is a fact about the input.

| Class             | Predicate (all must hold)                                                                                                                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHANGE`          | structural diff between base/head non-empty (projects/edges added, removed, or changed)                                                                                                                                                                          |
| `DRIFT`           | `codeDrift` signal (provenance advanced, no arch/policy change), OR declared intent rows `undeclared`/`unfulfilled` by the head; and NOT merely a policy-only transition; and no `DECISION_CHANGE` asserted (a supersession is `DECISION_CHANGE`, never `DRIFT`) |
| `VIOLATION`       | introduced violations non-empty with at least one not-waived, OR a declared constraint verdict `fail`                                                                                                                                                            |
| `REPAIR`          | resolved violations non-empty, OR drift findings resolved, OR active debt entries closed                                                                                                                                                                         |
| `DECISION_CHANGE` | the ADR lineage moved between base and head: same ADR id with a different status, or a new `supersedes` relation. Requires both sides' registries                                                                                                                |

Multiple classes are allowed — each is an independent fact, and the output is
sorted lexicographically (`["CHANGE","REPAIR","VIOLATION"]`, never the input
order). `[]` classifications appear **only** for a fully comparable, unchanged
pair, and the event says so in its notes — an empty classification list is
never a default, it is a claim that nothing could be classified because there
was nothing to classify.

The `affected` shape mirrors the facts: changed project names, changed edge
identity strings, the constraint/intent rows whose verdict was not clean, and
the ADR ids whose lineage moved — each sorted and de-duplicated.

### The one-sided rule

`DECISION_CHANGE` is the only class that requires both sides of the
transition — the ADR registries at base **and** at head. Exactly one side
recording its registry is "could not be compared", never "no decision
changed": asserting the lineage did not move from one registry would
fabricate a fact about the side the input does not have. Either side absent ⇒
`DECISION_CHANGE` is NOT asserted and a note is added — the mirror of the
`policyOneSided` disclosure history already makes. Both sides absent (the
input carried no decision evidence at all) is comparable and unasserted, with
nothing to disclose, exactly like two snapshots that record no fingerprint on
either side.

## Dispositions

An event's `disposition` is the evaluative stance the record earns:

| Disposition  | When                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `accepted`   | the pair was judged and nothing rejects it — including the fully comparable, unchanged pair with `[]` classifications                      |
| `rejected`   | introduced non-waived violations, a declared constraint `fail`, or declared intent rows `undeclared`/`unfulfilled`                         |
| `no-verdict` | any **verdict-relevant unknown**: an unknown delta entry, an undeterminable declared-constraint verdict, an `unproven` declared-intent row |

`no-verdict` is never a degraded `accepted` and never a disguised `rejected`:
where the event carries a verdict-relevant unknown, the disposition is
`no-verdict` even when other classes fired. Fabricated `accepted`/`rejected`
are the silent direction.

## The empty result is a claim, not a shrug

The repository's invariant applies to evolution with full force. An event with
no classifications means exactly "a fully comparable, unchanged pair" — and
the record says so in its notes. An input that could not be fully classified
never reads as a clean "nothing happened":

- an **unknown delta entry** (a violation the delta classification could not
  place) raises a per-entry note and forces disposition `no-verdict`;
- **one-sided metadata** (one side's ADR registry, one side's policy) raises a
  disclosure note and never reads as "the same";
- an **introduction that is entirely waived** is disclosed as waived, never
  classified `VIOLATION`;
- a **policy-only transition** is disclosed as a policy change, never as
  `DRIFT` and never as an unchanged pair.

A sequence of events whose individual records disclosed what they could and
could not compare is how an evolution history stays honest — the reader can
tell "this transition was clean" from "this transition could not be judged",
because the record itself states which.

## The store

Events land in an append-only store: one file per event,
`<NNNN>-<id8>.json` (`0000-…`, `0001-…`, … — the sequence is zero-based, the
index of the event in the log), where `<id8>` is the first eight hex
characters of the event id.

- **Append-only.** No update, no delete, never. State change is a new event;
  rewriting history is impossible by construction.
- **Idempotent.** `writeEvent` scans the directory for an existing event with
  the same `dedupeKey` _before_ writing. Found ⇒ it returns
  `{ id, duplicate: true }` and writes nothing — the always-present
  `duplicate` sibling, so a consumer can tell "this was a new event" from
  "this was a rerun" without the record's shape depending on directory state.
  Re-running an unchanged transition therefore never grows the store.
- **Atomic.** The write goes to `<path>.json.tmp` opened with `{ flag: "wx" }`
  (refusing rather than following a symlink already sitting there), then
  `rename` over the final name. Reads filter `.tmp` files out, so an
  interrupted write leaves a partial file the store will never read. A planted
  `.tmp` symlink is refused loudly, never followed.
- **Contained.** A write is checked against the workspace root the same way
  `--output` is: a workspace-controlled symlink in an intermediate path
  component is refused loudly rather than silently landing outside the tree,
  while a directory the caller names outside the workspace is the caller's
  explicit choice and proceeds.
- **Validated reads.** `readEvents` validates every file — `schemaVersion`
  exactly `1`, `classifications` a subset of the vocabulary, `disposition` in
  the vocabulary. Any malformed file THROWS (the command layer maps it to
  exit 3): "could not read the store" never reads as "no events recorded". A
  missing directory is `[]` — an absent _optional_ store is not an error, and
  the caller states "no events recorded" itself when that matters.
- **Validated writes.** The write path enforces two laws before anything is
  persisted — identity and vocabulary; the read path enforces the vocabulary
  alone, against the stored bytes. Identity: an event whose `id` or
  `dedupeKey` does not match the canonical tuple is refused — a record that
  lies about its identity would dedupe against the wrong key on rerun and
  manufacture duplicates, the failure shape the store exists to rule out.
  Vocabulary: an event outside it — a wrong `schemaVersion`, a
  `classification` or `disposition` the vocabularies do not name — is refused
  too, so `writeEvent` never persists a record `readEvents` would refuse and
  brick the store on (#738).

A store that cannot be read is never silently appended to: `writeEvent`'s own
dedupe scan throws on a file it cannot parse, because the unreadable file may
itself be the duplicate.

## Where events come from

`--event-out <dir>` on the evolution commands (`change`, `delta`, `evolution`)
writes these events; absent the flag, no file is written and the event's
classification still rides the command's envelope in memory. The debt ledger
links `introducedBy`/`resolvedBy` to event references when a store is linked,
and omits them with a note when it is not — lifecycle refs are never guessed.
