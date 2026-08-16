# Architecture debt

`lattice debt <dir>` is the ledger of the architecture debt a workspace is
carrying: the accepted violations, the un-built aspirations, and the drift —
each aged across the snapshot history, ranked by severity, and printed as one
deterministic report. It is an **aging record, not a finance metaphor**: age,
count and severity only, no interest and no compounding. It is also a **report,
not a gate** — it never changes a verdict and never exits 1; `check` stays the
only command that fails a build.

The directory argument is the same consumer-managed history directory
`history` reads (`docs/usage/history.md`): a directory of `graph --format json`
snapshots, the sole source of truth for age. There is no private store — the
ledger is rebuilt at any moment from the same files `check`/`drift`/`graph`
already read.

## The four entry kinds

| kind               | source                                                                      | severity |
| ------------------ | --------------------------------------------------------------------------- | -------- |
| `waiver`           | a `boundarySuppressions` row — a violation the workspace decided to accept  | low      |
| `aspirational-gap` | an `"optional": true` intent row not yet observed — stated, not built       | low      |
| `drift`            | a drift finding — the observed architecture contradicts the declared intent | medium   |
| `unresolved`       | an intent boundary or row that matched no observed project                  | unknown  |

- **waiver** — the debt is the accepted violation itself. The mandatory
  `reason` is why the workspace accepted it.
- **aspirational-gap** — a dependency the intent says may exist (optionally)
  but the tree does not build. It changes no verdict, but it IS debt: an
  undone intention, carried.
- **drift** — a contradiction between intent and observation. A drift finding
  in a project that also carries an accepted waiver is ranked **high**, and the
  waiver is still listed — the ledger must never hide a waiver that is failing
  today.
- **unresolved** — a boundary that matched nothing means the whole comparison
  cannot be trusted, so its severity reads `unknown` — never a clean ledger.

## What "age" means

Age is measured in **snapshots**, not days: how many consecutive snapshots the
_owning project_ of the debt has been part of the architecture. A project
present in every snapshot has age N (N = snapshot count); one observed only in
the head snapshot has age 1. The owning project of a waiver is the head-snapshot
project whose root the suppression path falls under; of a drift finding it is
the finding's source project. An aspirational gap and an unresolved intent name
no project, so they carry age 0.

Snapshots carry the project graph and the policy fingerprint — not the ledger
facts themselves — so age is per-project by design, and the report discloses it:
`agings: false` and age 0 on every entry when the directory holds fewer than two
snapshots means "observed, not yet aged", never "born yesterday". `sampleTime`
rides in the JSON envelope so a reader can see when the ledger was taken.

## Determinism

The same history directory, the same current facts and the same clock produce
the same ledger: entries sort by plain string comparison of kind-then-source,
and two runs over an unchanged tree produce byte-identical JSON.

## Refusals

Three conditions refuse loudly (exit 3) instead of degrading to an empty list:

- **incomplete graph coverage** — every "project missing" would be ambiguous
  between "gone" and "never seen";
- **an intent that cannot be verified** `judgeIntent`'s `unresolved` non-empty —
  "cannot verify" must never read as "no debt";
- **an unreadable or malformed history directory** — the ledger would either be
  empty (a shrug) or age against a record it could not read.

## The empty-result invariant

An empty entry list must mean exactly "no exemptions, gaps or findings", so on
a clean workspace the report prints `✔ no architecture debt` and the aggregates
are printed even when empty. A missing `architecture-intent.json` is also a
refusal, not an empty ledger: a ledger of architecture debt needs the declared
intent to compare against.
