# `archkeep provenance`

Report the governance row schema and the run's origin — who decided each rule, with what tool, and when.

```shell
archkeep provenance
archkeep provenance --format json
```

`provenance` answers the workspace's provenance questions, descriptively:

1. **Repository provenance** — the git commit, remote, and dirty state of the
   tree this run judged. A verdict about code is only as trustworthy as the
   code being described: two runs on different commits can disagree, and a
   report should say which tree it judged.
2. **Decision provenance** — for every governance row the workspace declares,
   whether the row carries an `origin` block naming who decided it and with
   what tool. A row without an origin is flagged `no origin recorded — cannot
attest` rather than read as attested.
3. **Decision lifecycle** — for every recorded ADR decision, who recorded its
   current state: the creator and latest author of the decision's file, the
   decisions it supersedes and is superseded by, and the boundary tags it
   binds. A decision without an attributable history is named
   `no origin recorded — cannot attest`, never silently passed.

## What the report contains

### Repository provenance

- **Commit** — the full SHA of the git HEAD at the time of the run
- **Remote** — the git remote URL, if one exists
- **Dirty** — whether the working tree has uncommitted changes (`true`/`false`)

### Decision provenance

For every governance row in the workspace's declared intent and boundary config:

- **Row type** — which table the row comes from (`depConstraints`,
  `moduleBoundaryOptions`, `boundarySuppressions`, `fitness`, `customRules`,
  `architecture-intent.json`)
- **Location** — the file and line number where the row is defined
- **Origin** — if present, the `{ by, tool, on }` block
  - `by` — who decided (a name, email, or handle)
  - `tool` — which tool or process recorded the decision
  - `on` — when the decision was recorded (optional, present only when the
    workspace injects a shared governance clock)
- **Status** — `attested` if the row carries an origin, `no origin recorded —
cannot attest` if it does not

Rows are walked in the same order the judge counts them, so the output is
deterministic across runs.

### Decision lifecycle

For every decision recorded in the workspace's ADR registry (`docs/adr/`):

- **Status and authority** — the decision's committed state (`active`,
  `superseded`, …) and whether that state is authoritative
- **Created / updated** — the author of the first and latest commits that
  touched the decision's ADR file, with the committed author date (`tool:
git`; the date is read from the commit, never produced by the run)
- **Supersedes / superseded by** — which decisions this one replaced and which
  replaced it, read from the committed records
- **Bindings** — the boundary tags the decision commits to
- **Attribution** — `attested` when the file's git history names its creators,
  `no origin recorded — cannot attest` when it does not (not a repository, or
  the file was never committed)

The lifecycle is read-only evidence about committed records: it never judges a
decision, so no verdict can change.

## Exit codes

| code | meaning                                                           |
| ---- | ----------------------------------------------------------------- |
| 0    | The provenance report was generated.                              |
| 2    | Usage error: unknown flag, wrong argument count.                  |
| 3    | Coverage is incomplete — at least one file could not be analyzed. |

`provenance` never exits 1. It is a descriptive command that reports facts,
not findings.

## The origin block

A governance row may carry the optional `origin` block:

```json
{
  "origin": { "by": "jane@example.com", "tool": "archkeep:v1", "on": "2025-01-15T10:30:00Z" },
  "rationale": "why this row exists",
  "decisionRef": "0012-bind-collaboration",
  "fitnessBindings": ["fitness:hotspot"]
}
```

Only `origin` is a provenance record; the other three keys (`rationale`,
`decisionRef`, `fitnessBindings`) are the decision's context and are owned by
the capabilities that consume them.

A row without the block is a legacy row and stays valid — additivity is the
contract. The block only changes what `archkeep provenance` reports.

## The shared governance clock

The `on` field in an origin is produced only through the shared clock — an
injected `{ now(): string }`. A workspace that wants byte-identity across runs
omits `on` entirely; two runs over unchanged rows without `on` are
byte-identical.

A workspace that records `on` hands the clock a hermetic answer — a build id,
a pinned value — so the claim is reproducible. The provenance module refuses
to produce `on` without a clock, loudly; it never defaults to the wall clock.

An `origin` already committed in a declaration file is a static fact about
committed bytes: reading it needs no clock and is byte-identical across every
read.

## Validation

A malformed origin is rejected where it is read — a constraint row whose
`origin` is missing `by`, an intent row whose `origin` names an unknown key, a
crafted `__proto__` key that would pollute a naive load. `archkeep provenance`
never pretends a row it could not read is attested, and never pretends a row it
could not read exists.

The reference page for the command is
[`../reference/provenance.md`](../reference/provenance.md). The concept that
defines the model and the determinism rules is
[`../concepts/provenance.md`](../concepts/provenance.md).
