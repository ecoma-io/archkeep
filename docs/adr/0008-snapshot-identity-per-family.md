---
id: 0008-snapshot-identity-per-family
status: accepted
---

# Snapshot identity is stated once per snapshot family, and the evidence family's identity is its bytes

## Context

The final foundation audit (2026-09-05, workstream C) asked whether the engine
needs a first-class `snapshotId` before any surface grows one. Two snapshot
families exist, and the question has to be answered for each:

- **Graph snapshots** — what `history --capture` writes and `evolution` events
  carry. Consumed by `computeDiff`'s structural comparison and, since the
  event-identity work, by dedupe decisions across machines.
- **Evidence snapshots** — what `delta` capture and `change` baselines write.
  Loaded whole, re-judged, never diffed by id.

The audit produced an identity matrix for both families
(`packages/archkeep/src/commands/history.mjs`'s `snapshotIdentity` JSDoc owns
the graph family's law; `packages/archkeep/src/commands/delta-snapshot.mjs`'s
`serializeEvidenceSnapshot` owns the evidence family's determinism) and one
executable gap: the project `root` was identity material with no direct pin.

## Decision

Identity is stated exactly once per family, and never twice for one family:

1. **Graph snapshots** are identified by `snapshotIdentity` — a SHA-256 over
   the canonicalized fields `computeDiff` compares (project `name`, `root`,
   `type`, `tags`; dependencies; the policy fingerprint or its absence), and
   nothing else. Evolution event sides consume that function's output through
   `eventSnapshotSide`; they never re-derive a second identity.
2. **Evidence snapshots** carry no identity field, by decision. Their identity
   is their bytes: serialization is deterministic, so two captures over one
   unchanged tree are byte-identical and a baseline is interchangeable with
   any copy of itself. A path names where a baseline is STORED, never what it
   IS — which is why a storage path may not enter an evolution event's
   identity either.

## Rationale

The graph family's projection is exactly `computeDiff`'s universe, so
"identity moved" and "the diff sees an architectural change" are the same
event — a build-target change can neither fabricate a transition nor hide one.
The workspace root, provider, and provenance are excluded because they are
facts about the reading, not the architecture; relocation invariance rests on
the providers' workspace-relative-root contracts
(`packages/archkeep/src/providers/native/model.mjs` refuses absolute and
escaping roots), and the audit's gap — that `root` sensitivity had no direct
pin — is closed by the test beside `snapshotIdentity` in
`packages/archkeep/src/commands/history.test.mjs`.

For the evidence family, byte-determinism already gives every property an id
field could: equality (identical bytes ⟺ identical meaning), interchangeability,
and change detection (`diff` of two baselines is meaningful). An id field would
be a second serialization of a fact the bytes state, and the two could disagree.

## Refused alternatives

- **A `snapshotId` field on evidence snapshots.** No consumer exists that
  needs it, and a disagreement between the id and the bytes would be a new
  silent-failure class invented for nothing: a snapshot re-labeled without
  re-capture would read as a different architecture while describing the same
  one.
- **Content-addressing evidence snapshot files** (naming or deduping baseline
  files by their digest). The same disagreement risk, plus a storage
  convention change no consumer asked for; the caller owns the singleton path.
- **Including provider, provenance, or workspace root in `snapshotIdentity`.**
  The root would make identity machine-dependent — the same workspace would
  hash differently on another machine — and provider/provenance are facts
  about the reading. They surface through the transition classification and
  capture's provider-equality guard instead.

## Consequences

The providers' relative-root contracts are now load-bearing for identity, not
only for model hygiene: a provider that emitted absolute roots would make
every snapshot id machine-dependent without any hash change. The refusal that
prevents it belongs to the provider layer, and stays there. A pure provider
migration deliberately keeps the same graph identity — the capture dedup guard
compares provider separately, so the ledger records the reading that changed,
not a manufactured architecture change.
