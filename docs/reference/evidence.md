# Evidence and the verdict vocabulary

Every `check --format json` envelope now carries a `decision` object naming the
run's verdict in one canonical vocabulary. This page is the single source of
that vocabulary — the four states, the invariants that hold them together, and
the shape the `decision` field takes in the envelope
([json-output.md](json-output.md)).

The vocabulary exists because the three statuses the envelope has always used —
`"ok"` / `"findings"` / `"no-verdict"` — describe one run's position on one
tree, while the governance wave needs a verdict an evidencing process can
compare across runs, feeds, and capabilities. `status` stays exactly as it was;
`decision` is an additive rendering of the same verdict in the four-state
vocabulary.

## The four states

| verdict          | means                                                                                             | envelope status | exitCode |
| ---------------- | ------------------------------------------------------------------------------------------------- | --------------- | -------- |
| `pass`           | looked, and found nothing to report                                                               | `"ok"`          | `0`      |
| `fail`           | found at least one finding                                                                        | `"findings"`    | `1`      |
| `unknown`        | could not reach a verdict — coverage incomplete, intent unestablished, an analysis threw          | `"no-verdict"`  | `3`      |
| `not_applicable` | the rule did not apply — reserved for Fitness and Waivers, never emitted by engine behavior today | (none)          | (none)   |

The mapping from `status` to `verdict` is one-way and total over the three
statuses the envelope can hold:

| `status`       | `verdict` |
| -------------- | --------- |
| `"ok"`         | `pass`    |
| `"findings"`   | `fail`    |
| `"no-verdict"` | `unknown` |

`not_applicable` has **no source status** in this release. It is the vocabulary
for capabilities that decide a rule does not apply (Fitness functions, Waivers)
rather than that it passed or failed. Engine behavior never emits it: the
envelope refuses a `decision` whose verdict contradicts its `status`, and no
status maps to `not_applicable`, so the state is locked out of every envelope
today. `src/governance/verdict.mjs` is where the vocabulary lives and `isVerdict`
is the membership test.

## The invariants, I1–I5

Each invariant is enforced in code — `buildDecision`
(`src/report/evidence.mjs`) throws rather than emit a decision that violates
one, and the tests pin both directions (the verdict with its evidence builds;
the verdict minus that evidence refuses).

| invariant | rule                                                                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **I1**    | `pass` requires complete coverage. A run that could not fully read the tree can never pass.                                                                              |
| **I2**    | `fail` requires at least one finding. A failing verdict that names no finding leaves the reader guessing what failed.                                                    |
| **I3**    | `unknown` requires a `reason`. `unknown` is a claim that something could not be determined, and the reader has to be able to tell what.                                  |
| **I4**    | `not_applicable` requires `notApplicableReason`. "Did not apply" and "did not run" are indistinguishable without it.                                                     |
| **I5**    | The cardinal rule: an analysis that failed, or a rule that could not determine, must emit `unknown`, **never `pass`**. `pass` is the loudest claim the vocabulary makes. |

I5 is the reason the other three exist. Every code path that cannot reach a
verdict must say so instead of returning an empty success — the same `AGENTS.md`
invariant an empty diagnostic list answers to. A degraded `pass` is the silent
direction: byte-for-byte identical to a clean workspace, and nobody files a bug
about an enforcer that reports nothing.

## The `decision` field in the envelope

`check --format json` places the decision under the envelope's top level,
beside `status` and `exitCode`, which it must agree with:

```json
{
  "schemaVersion": 2,
  "command": "check",
  "status": "findings",
  "exitCode": 1,
  "decision": { "verdict": "fail" },
  "coverage": { "complete": true, "analyzedFiles": 42, "imports": 137 }
}
```

| field                 | type   | meaning                                                                                                                                                                               |
| --------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verdict`             | string | One of `pass` \| `fail` \| `unknown`. (Unreachable for `not_applicable`, see above.)                                                                                                  |
| `reason`              | string | **Always present on `unknown`**, naming which could-not-look condition fired: `"coverage was incomplete"`, the file count that could not be analyzed, an unresolved intent boundary.  |
| `notApplicableReason` | string | Present only on `not_applicable` — which cannot reach an envelope in this release.                                                                                                    |
| `sampleTime`          | string | **Opt-in, never present by default.** An ISO-8601 UTC instant a capability adds when it is an age/count feature. The envelope is otherwise byte-deterministic over an unchanged tree. |

Three consequences follow directly:

- **`decision.verdict` always agrees with `status`.** `jsonEnvelope`
  (`src/report/json.mjs`) throws rather than build an envelope where they
  disagree — the same posture it takes for the `status`/`exitCode` rule. A
  mismatch is a bug in the command that built the envelope, not a workspace
  fact.
- **`pass` never rides incomplete coverage, and `fail` always names a finding
  somewhere in `result`.** Both are claims `buildDecision` refuses to emit
  hollowly, at the verdict layer and independently of the status-level checks.
- **The envelope stays deterministic** over an unchanged tree with an unchanged
  `lattice` version. `sampleTime` is the only time-shaped field, and it appears
  only when a capability passes it explicitly — a decision for a command whose
  verdict must stay reproducible carries no time at all.

## Absence

A workspace predating this feature, and any non-`check` command, is unaffected:
`decision` is absent from those envelopes, and the bytes of the rest of the
envelope are unchanged. `schemaVersion` stays `2` — additive fields do not move
it; only a rename, retype, or removal does (see
[json-output.md](json-output.md)'s stability promise).

## Where the vocabulary lives in code

`src/governance/verdict.mjs` — the closed vocabulary (`VERDICTS`), the
status→verdict map (`VERDICT_FOR_STATUS`), and `isVerdict` / `verdictForStatus`.
`src/governance/clock.mjs` — `referenceTime()`, the zero-argument reference
clock a time-based capability injects a fixed time into, so tests never assert
the wall clock. `src/report/evidence.mjs` — `buildDecision`, the executable
form of I1–I5. The engine's own `check` command is the only caller today, and
it emits only `pass` / `fail` / `unknown`.
