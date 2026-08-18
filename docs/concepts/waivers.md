# Waivers

A boundary violation your workspace is going to live with for a **fixed term**,
as opposed to forever. A suppression accepts a violation permanently; a waiver
accepts it until a deadline, and the moment the deadline passes the boundary it
covered is live again — loudly, never silently.

## The distinction that matters

`boundarySuppressions` holds both. The row's shape decides which one it is:

- a **suppression** is a row with no `expiresAt`. The violation is removed
  from the run's findings, and a run whose violations are all suppressed
  reads clean (exit 0). This is the existing boundary feature, unchanged.
- a **waiver** is a row **with** `expiresAt`. The violation is _not_ removed:
  it stays in the run's findings, marked as accepted until that instant, and
  a run whose only findings are waived is **not** clean (exit 1). Accepting a
  boundary breach for a fixed term is a tracked decision, not a fix.

That single rule is why waiving can never promote `unknown` → `pass`, and why
an empty result still means what it always meant. Waivers are a filter over
verdicts the engine already reached — they annotate a violation, they never
make one disappear. A waiver over a site the analyzer could not resolve covers
nothing, because there is no verdict for it to annotate; the "could not tell"
failure travels beside the records and no waiver ever touches it.

## The lifecycle of a waiver

1. **Active** — before `expiresAt`. The violation it covers is reported under
   an **"accepted violations"** section in every format: the terminal report
   splits it out of the live findings, SARIF keeps the result at `error` level
   with the acceptance facts in its property bag, and the JSON envelope counts
   it in a new `waived` field. The exit code stays `1` — a run with only
   accepted violations is still a failing run, so CI keeps catching the day
   the waiver lapses.
2. **Expired** — at or after `expiresAt`. The waiver stops covering anything,
   and the violation **re-asserts itself in full** with the evidence
   `"expired waiver"` on every format that can carry it. A waiver "valid
   through" a term covers strictly before its expiry instant: `now ===
expiresAt` is already expired.
3. **Stale** — a waiver, active or expired, that currently covers no violation
   at all (the finding it accepted was fixed, or the row's glob never matched
   this run's findings). Lattice never deletes a row for you — waivers are
   recorded, and a stale one is surfaced loudly as dead weight by
   `lattice waivers`, never quietly forgotten.

## The two surfaces

### `check` — enforcement, with the accepted half named

```text
✖ 3 boundary violations, 1 accepted until their expiry (84 imports in 12 files across 3 projects)
```

The accepted violations are counted and their waivers named, but the verdict —
and the exit code — are the same as if nothing had been waived. "Accepted" is
the count word, deliberately not an error: the finding is a tracked decision,
not a new defect a reader must chase. When the term lapses the same report
swaps the acceptance for the `evidence: expired waiver` line, and the
violation is just a violation again.

### `lattice waivers` — the surface, read-only

```shell
lattice waivers
lattice waivers --format json
```

Lists every row with an `expiresAt`: its path, its term, and the current
violations it covers. Coverage is judged against the full finding set — the
table removed — so a row that names a file the tree never visits reads as
covers-nothing, not as quietly doing its job.

A `waivers` run is descriptive, like `graph` or `drift`: it exits 0 whenever
the surface could be read, never 1. The failing verdict is `check`'s alone —
but a run of only waivers shows its own not-clean summary, because a surface
with everything accepted must not read like a linting pass.

## The clock

Waiver expiry is judged against the **shared governance clock**, injectable
and deterministic: a command takes its reference instant from
`referenceTime()`, and a test drives the same command at a fixed `now`. Two
runs over an unchanged tree and an unchanged injected time produce
byte-identical bytes — the determinism rule every governance capability
shares. Expiry is judged at epoch-millisecond precision, so a waiver expiring
mid-day is respected at mid-day, not at midnight.

Without an injected clock — every real `lattice waivers` run — `remainingMs`
is the one field that differs run to run, because it names time remaining as
of right now; `coverage.notes` discloses that in-band, and
[the JSON reference](../reference/json-output.md#result-for-command-waivers)
is the exact contract, including how it is excluded from the envelope's
determinism promise.

## When to use a waiver, and when not to

Use a waiver for a **known, dated breach**: a migration in flight, a vendored
adapter being replaced, a third-party seam that ships in the next release. The
date is the point — it is the promise that the acceptance ends.

Use a suppression for a breach the workspace accepts **without a date**: a
generated artifact, a fixture that shares a package by design. If you cannot
name the day it ends, a waiver's date would be a fiction, and a fiction is
worse than an honest permanent suppression.

What neither may do is silence a **blind spot** — a site the analyzer could
not resolve, a file it could not read. Those are reported as failures on every
path (coverage gaps, no-verdict runs), and a waiver over one covers nothing.
The empty-result invariant is the whole reason: an empty diagnostic list must
mean "no violation", and nothing else.
