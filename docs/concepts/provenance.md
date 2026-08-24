# Provenance

Every governance row is a decision: a constraint that packages may only depend
on packages, a boundary that `packages` must never reach `extensions`, a
project that is required to exist. Provenance is the answer to "who decided
that, with what tool, and when?" — and its absence is a finding, never a shrug.

## The two halves

`archkeep provenance` answers two questions, descriptively:

1. **Repository provenance** — the git commit, remote, and dirty state of the
   tree this run judged. A verdict about code is only as trustworthy as the
   code being described: two runs on different commits can disagree, and a
   report should say which tree it judged.
2. **Decision provenance** — for every governance row the workspace
   declares, whether the row carries an `origin` block naming who decided it
   and with what tool. A row without an origin is indistinguishable from a rule
   that appeared by editing the file directly, so the command flags it
   `no origin recorded — cannot attest` rather than reading it as attested.

Provenance is **descriptive**, like `graph` and `diff`: it never changes a
verdict, and it never exits 1. Its finding is about documentation, not about the
architecture — a row that changes the architecture still changes it, attested
or not.

## The origin record

A row may carry the governance block, of which `origin` is the first key:

```json
{
  "origin": { "by": "jane@example.com", "tool": "archkeep:v1" },
  "rationale": "why this row exists",
  "decisionRef": "0012-bind-collaboration",
  "fitnessBindings": ["fitness:hotspot"]
}
```

The complete block — `origin`, `rationale`, `decisionRef`, `fitnessBindings` —
is the shared row schema every governance row may carry, defined once and
validated by every row's loader so no two copies can drift. Only `origin` is a
provenance record; the other three keys are the decision's context and are
owned by the capabilities that consume them.

`origin` itself is three keys:

- `by` — who decided, a non-empty string (a name, an email, a handle). Free
  form; no format is enforced.
- `tool` — which tool or process recorded the decision, a non-empty string
  (`archkeep:v1`, `claude`, an ADR editor).
- `on` — when the decision was recorded, optional.

**A row without the block is a legacy row and stays valid.** Additivity is the
contract: a workspace that never writes an origin runs exactly as it did
before, byte-for-byte. The block only changes what `archkeep provenance`
reports.

## Determinism — why `on` exists and when it does not

Determinism is absolute: identical inputs produce identical bytes, and no
wall-clock time may enter a model. `on` is the only key that threatens that, so
it has one rule and one door:

- `on` is produced **only** through the shared clock — an injected
  `{ now(): string }`. There is no other way for it to appear.
- A workspace that wants byte-identity across runs **omits `on` entirely**.
  Two runs over unchanged rows without `on` are byte-identical.
- A workspace that records `on` hands the clock a hermetic answer — a build id,
  a pinned value — so the claim is reproducible.

The provenance module refuses to produce `on` without a clock, loudly; it never
defaults to the wall clock.

## Reading committed origins

An `origin` already committed in a declaration file is a **static fact** about
committed bytes: reading it needs no clock, never touches the wall clock, and
is byte-identical across every read. `archkeep provenance` reads origins; it
does not write them. If a workspace wants fresh rows to carry `on`, the tool
that writes those rows does so through the clock, not this command.

## Validation is loud

A malformed origin is rejected where it is read — a constraint row whose
`origin` is missing `by`, an intent row whose `origin` names an unknown key, a
crafted `__proto__` key that would pollute a naive load. The same loud refusal
a malformed `architecture-intent.json` already earns. `archkeep provenance`
never pretends a row it could not read is attested, and never pretends a row it
could not read exists.

## What a report says

Every governance row in the workspace's declared intent and boundary config is
walked in the same order the judge counts them. Attested rows are listed with
their origin; unattested rows are flagged `no origin recorded — cannot attest`.
An empty `unattested` list must mean exactly "every governance row carries an
origin" — nothing else. See
[the reference page](../reference/provenance.md) for the report shapes.
