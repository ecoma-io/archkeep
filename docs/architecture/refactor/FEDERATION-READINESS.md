# Federation readiness — the runway record

**Phase**: 8. **Status**: recorded (runway only, no machinery). **Gate**:
maintainer-gated ([CON-8](CONSTITUTION.md#con-8--snapshot-and-federation-runway-not-machinery),
[MIGRATION-PLAN.md](MIGRATION-PLAN.md#phase-8--federation-readiness-runway-not-machinery),
[CHK-9](CONTEXT.md#chk-9--phase-7-close-additional-surfaces-2026-09-08)).

This page is the Phase 8 deliverable. It answers the seven adversarial
questions any federation runway must answer before the maintainer would
authorize federation work, states which existing semantics already carry the
federation load, records the OQ-14/GAP-D gate, and leaves a verdict: nothing
speculative exists, and the runways needed are one ADR and one decision.

It is a record, not a ban: CON-8 does not forbid federation — it forbids
building it before a concrete requirement proves it. Each answer below ends
with what would make the runway genuinely needed.

---

## 1. Is federation actually needed now, or only being prepared for?

**Prepared for, not needed.** No consumer surface requests data from another
Archkeep instance, no command reads another repository's graph, no product
moves across physical roots under a single verdict, and nothing here syncs
state between machines.

The engineer's instinct is that "federation" is the obvious next rung for a
governance tool. The refactor's own record separates the two halves of that
instinct:

- **Prepared-for** — the substrate is already explicit: snapshot identity,
  event identity, provenance, and evidence externalization all exist (Q2–Q6
  name them). This runway is already mostly built by the engine's own
  internal contracts, and the engine was not built for federation in mind.
- **Needed** — would require one of: a second Archkeep instance consulted
  for a verdict; evidence produced on one machine re-judged on another; a
  snapshot shipped across a boundary and consumed as truth. None of those
  exist today. `history`, `evolution`, `delta`, and `change` all consume the
  local tree under the local law — they are single-plane, deliberately
  ([DATA-FLOW.md](DATA-FLOW.md#parallel-record-flows-not-verdicts), the
  "records, not verdicts" line).

**What would flip this**: a concrete requirement that a verdict, snapshot,
event, or baseline read a store owned by another root or another machine.
Until then this answer stays "prepared for".

## 2. Which identity is already canonical?

Three families, each one identity, each stated once — ADR
[0008](../../adr/0008-snapshot-identity-per-family.md) is the law that keeps
it one:

| Family             | Canonical identity                                                                                                                                 | Owner                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Graph snapshots    | `snapshotIdentity` — a SHA-256 over `computeDiff`'s universe (`name`, `root`, `type`, `tags`; dependencies; the policy fingerprint or its absence) | `src/commands/history.mjs:126`             |
| Evolution events   | `eventDedupeKey` — the canonical tuple `{base, head, declarationDigest}`, hashed by `eventId` from the same key                                    | `src/governance/evolution-event.mjs:63,79` |
| Evidence snapshots | the bytes — serialization is deterministic, identity is what the captured bytes say                                                                | `src/commands/delta-snapshot.mjs:284`      |

Two edges of that grid:

- **Evolution edge identity** — edges inside an event are identified by
  `edgeEvolutionIdentity` = `source>target:type`, a spelling the store's
  event rows already use, so no event carries a second spelling of "same
  edge" (`src/governance/evolution-event.mjs:212`). The boundary read that
  refuses to accept a ready-made string is the discipline that keeps the
  identity the module's **output**, never its input (`edgeEvolutionIdentity`
  is exported; `evolutionBoundary` refuses a string).
- **Shared policy axis** — graph-snapshot identity includes the policy
  fingerprint (`computePolicyFingerprint`, `src/commands/graph.mjs:180`).
  The intent declaration's own digest (`declarationDigest`) participates in
  the event tuple **only when a declaration exists**; its absence is part of
  the tuple, so "same base/head with a declaration" and "same base/head
  without" are different events and never collide
  (`evolution-event.mjs:50-67`).

**Consequence**: there is no id for "an entire workspace at a version".
Federation's only open identity is the workspace/repository identity — a
statement of _which_ tree produced a snapshot/event, not of _what_ the
architecture is. That is exactly why ADR 0008 excludes provider, provenance,
and root from `snapshotIdentity`: they are facts about the reading, and
including them would hash the same architecture differently on another
machine. If federation ever needs to "address" a remote, the remote is named
by workspace/repository identity, **not** by re-keying the graph identity —
which must stay relocation-invariant.

**What would make this a gap**: a consumer that needs to match a snapshot to
the tree it came from and cannot — because provider/provenance/root
deliberately do not participate. That consumer is federation, and it is the
one not yet built.

## 3. Which existing event/snapshot/provenance formats already solve part of the problem?

Three formats, all committed and all gated against drift:

1. **Graph snapshots** — `history --capture` writes `<seq>-<sha8>.json`, a
   monotonic sequence + snapshot identity suffix. They are **content-
   addressable by construction** (a full graph envelope whose identity
   derives from its own bytes) and deliberately carry no index file — an
   index would be a second copy of facts the snapshot files already state.
   A consumer-dir of these is already a portable, byte-stable "state of the
   architecture at a version" (`src/commands/history.mjs:3-21`).
2. **Evolution events** — `evolution --event-out` writes the one record with
   provenance (`from`/`to` git commits, tool identity), the transition
   classification, and the observed diff, into an append-only store keyed by
   `eventDedupeKey`/`eventId` (`src/commands/evolution.mjs:789-830,1179`).
3. **Evidence snapshots** — `delta` capture serializes the full
   re-judgment record to deterministic bytes (engine name+version +
   rule-name-keyed rows), byte-gated by the evidence gate
   (`src/commands/delta-snapshot.mjs:79-284`).

All three are **already externalizable**: each reads and writes plain
`.json` on a consumer-managed path, deterministic across runs (GAP-A/B
byte-identity), and gated by differentials (GAP-A corpus, GAP-E LSP goldens,
the evidence gate). A "federation protocol" would be a second spelling of
these formats — which [DATA-FLOW.md](DATA-FLOW.md#hazards-where-a-second-path-could-grow)
names as a hazard ("a second path is a drift risk").

**What would make federation need a new format**: a consumer that has to
send one of these across a boundary and lacks a plain-container transport.
Until then `--event-out` + the snapshot dir are the transport.

## 4. Would an apparently new identity duplicate `edgeEvolutionIdentity` or another existing identity?

**Every identity this runway might invent already exists.** Of the seven
adversarial questions, this is the one the refactor's own
[INV-2](INVARIANTS.md#inv-2--one-exitstatus-table) design
(`evolution-event.mjs` refusing a ready-made edge string) already answers in
code:

- An edge inside an event → `edgeEvolutionIdentity` (Q2).
- The graph state an event side references → `snapshotIdentity` via
  `eventSnapshotSide` — the function that keeps the spelling single
  (`src/commands/history.mjs:161`); storage-path/provenance deliberately
  excluded.
- A declaration → `declarationDigest` (Q2).
- The event as a whole → `eventDedupeKey`/`eventId` (Q2).
- The policy axis → `computePolicyFingerprint` (Q2).

The only new identity the runway legitimately names is the **workspace/
repository identity** (who produced the data), which is excluded from every
existing identity on purpose and therefore not in conflict with any of them.
A federation proposal that reaches for a _new graph identity, edge identity,
event identity, or declaration identity_ would be duplicating one of the
five above — and would fail the INV-2/two-spellings discipline.

## 5. Does adding explicit provenance create a second provenance authority?

**It would, if "provenance" is made a first-class field.** The threat is
that a federation layer adds a `provenance:` object next to each snapshot,
event, or baseline row — and then the store has two facts about the reading:
the one the engine recorded, and the one the federation wrapper stamped. They
would usually agree and could silently disagree.

The record already refuses this shape. `snapshotIdentity` excludes
provenance ("facts about the reading, not the architecture"), and evolution
**events carry provenance** as `kind: "git-commit", ref:` entries composed
into the single event record at write time
(`src/commands/evolution.mjs:804-830`) — provenance is **inside the one
record**, produced by the same write as the identity, so there are never two
writes that could disagree. The compose-site, not the field name, is what
keeps provenance single-authority:

- graph snapshots: provider/provenance surface through transition
  classification + capture's provider-equality guard (ADR 0008
  consequences);
- events: the `from`/`to` git refs are composed at write time, gated by
  `eventDedupeKey` determinism.

**What would create a second authority**: a layer that stamps provenance onto
already-written snapshots/events/baselines after the fact. The runway's rule
is that provenance lives at the record's single write site or nowhere.

## 6. Can the current evidence model already be externally serialized?

**Yes, and it is byte-deterministic.** Two evidence surfaces exist:

1. **The JSON envelope** (`schemaVersion: 2`, `src/report/json.mjs`) — the
   read-only contract surface, byte-gated by the envelope goldens
   (VALIDATION-MATRIX tier 2). A verdict, exported as a JSON envelope, is a
   portable, schema-versioned record of the state of a run.
2. **The evidence snapshot** (`delta-snapshot.mjs:284`) — the full
   re-judgment baseline, byte-deterministic (identity = bytes). Two captures
   over one unchanged tree are byte-identical, so a baseline is
   interchangeable with any copy of itself. ADR 0008's refusal of an id
   field is because the bytes already give equality, interchangeability, and
   change-detection.

Both are gated by the GAP-A/GAP-E/evidence differentials (tier 3
byte-identity across runs). There is **no virtual/proposed field** in the
evidence model that exists only for federation — every output field is a
real serialized fact of a run (the MCP `propose` surface marks its outputs
`virtual: true`; they are proposals, not extra evidence fields).

**What would make external serialization a gap**: a consumer that needs to
read a verdict from one machine and re-judge it on another. That is the
federation workload, and its transport — byte-identical JSON — is already in
place.

## 7. Are we introducing abstractions because they are useful, or because "federation" sounds arcane?

This is the refactor's own watchword
([CON-8](CONSTITUTION.md#con-8--snapshot-and-federation-runway-not-machinery)
forbids speculative building;
[MIGRATION-PLAN.md](MIGRATION-PLAN.md#phase-8--federation-readiness-runway-not-machinery)
says "No `FederationService` until a concrete requirement proves it"). The
record's answer: **no abstraction is being introduced here, because no
pre-contract is being defined.** This page introduces:

- **No new type, interface, or service** — nothing a consumer would import.
- **No new identity** — a federation "addressing" abstraction would be a new
  identity, and Q4 shows every existing identity already covers the plane.
- **No new provenance shape** — Q5 shows provenance already lives inside the
  single write.
- **No new serialization** — Q6 shows the formats are already byte-stable and
  portable.

What it _does_ introduce is a **discipline statement**: federation work must
name an existing identity/format it composes, or it is speculation. That is
the anti-"arcane" guard — the moment a proposal needs the word "federation"
to justify a `FederationService`, this record is the question it must answer
first.

**The one abstraction the runway would permit**: a workspace/repository
identity ADR (the only open identity, Q2), written only when a consumer
proves it needs to address a remote tree. Not a framework — a statement.

---

## The OQ-14 / GAP-D gate (maintainer-gated)

Two open items close in [Phase 9](MIGRATION-PLAN.md#phase-9--final-hardening)
and are not decided here. This record restates their gate so the maintainer
finds them at the gate where they belong:

- **OQ-14 — INV-23's semantic-compatibility witness**
  ([OPEN-QUESTIONS.md](OPEN-QUESTIONS.md#maintainer-gated)) — whether a
  cross-version semantic-baseline differential is owed, or the corpus +
  differentials + review discipline suffice. **Phase 9's GAP-D decision.**
- **GAP-C — differential breadth** — governance/provenance/report _values_
  have no differential, only relationship pins
  ([VALIDATION-MATRIX.md](VALIDATION-MATRIX.md#architectural-test-gaps)).

Both close with either the fix or the reasoned no-fix per budget honesty
([CON-0](CONSTITUTION.md#con-0--do-not-trade-semantic-maturity-for-structural-purity)).
Neither is a federation decision; the maintainer gates them at Phase 9
regardless.

**This phase's gate**: same as CON-8 — the maintainer is the only authority
that can turn "prepared for" into "needed". No PR in this phase changes that.

---

## The runway in one line

Federation's substrate — identity, snapshot, provenance, evidence
externalization — is already explicit, single-owned, and byte-differential.
The runways not yet built are exactly two: the workspace/repository **identity
ADR** (Q2/Q4/Q7) and the **GAP-D/OQ-14 semantic-baseline decision** (Phase 9).
Nothing else is missing, and nothing is built speculatively.

## Rejected approaches (recorded here so the "runway" cannot be misread as a mandate)

- **A `FederationService`** — REFUSED by CON-8; no concrete requirement proves
  one. A framework with no consumer is the "arcane" trap Q7 names.
- **New graph/edge/event/declaration identity for federation** — REFUSED by
  Q4: every such identity already exists. Federation's only open identity is
  the workspace/repository one.
- **A provenance field stamped post-hoc** — REFUSED by Q5: provenance lives
  at the single write site or nowhere.
- **A new serialization for remote transport** — REFUSED by Q6: the formats
  are already byte-stable and portable.
- **Abstracting "a remote Archkeep" today** — REFUSED by Q1: no consumer
  needs one.

## Debt budget

- **Gaps before**: none new — federation has no standing gaps, only two open
  decisions (OQ-14/GAP-D) that Phase 9 owns.
- **Gaps closed**: none (runway-only; nothing was broken).
- **Gaps introduced**: none.
- **Net delta**: zero — this phase added documentation and no code, moved no
  boundary, and created no obligation to build anything.
