# The agent-workflow evaluation suite

The ten-scenario harness [the protocol page](../docs/doctrine/agent-workflow-protocol.md)
specifies: each scenario is a scripted fixture workspace plus a scripted
agent-behavior transcript, scored by exit codes and named envelope fields —
nothing judges prose. The suite runs **before** the skill-text change
(proving which failures exist today) and **after** it (proving the forcing
function), and both score tables land in the skill-change pull request.

## What a scenario is

`scenarios/<NN-slug>/` holds exactly two files:

- `run.sh` — bash, self-contained. It creates a throwaway fixture workspace
  under `mktemp -d`, builds the adversarial state, drives the CLI exactly as
  the scenario's transcript dictates, and scores the required observations.
  The runner exports `ARCHKEEP_CLI` (absolute path to the engine CLI); the
  script owns everything else. It prints one `OBSERVED <key>=<value>` line
  per observation and ends with `SCORE pass` or `SCORE fail`.
- `README.md` — the scenario's identity: class, adversarial move, required
  observation, and what today's (pre-skill-change) score means.

Exit codes: `0` scored pass, `1` scored fail, `2` the scenario is broken
(harness error — the runner reports it separately from a score).

## What is scored

Two observation kinds, both machine-checkable:

- **Envelope fields** — the scenario reads the CLI's JSON output and asserts
  named fields (`reconciliation.verdict`, `coverage.coverageGaps`, …).
- **Transcript markers** — for skill-side forcing, the transcript the scripted
  agent produces is itself a fixture artifact, and the required line must
  appear in it. A marker that no engine command emits stays red until the
  skill text that produces it exists — that red is the measurement, not a bug.

## Running it

```bash
node agent-suite/run.mjs           # report: the table, exit 0 — scores are data
node agent-suite/run.mjs --gate    # gate: exit 1 unless every scenario scores pass
```

The report mode is how the before-table is produced; the gate mode is what
CI runs on every pull request (the `agent-suite` job in
`.github/workflows/ci.yml`, inside `ci-gate`'s `needs`) and what the
skill-change pull request ran after the text landed.

## Rules the scenarios obey

- Every child process gets an argument array, never a built string.
- A scenario never writes outside its own `mktemp -d` workspace.
- A scenario asserts observations; it never asserts engine internals.
- A score of `fail` is a finding about the workflow, not a harness failure —
  the runner still exits 0 in report mode.
