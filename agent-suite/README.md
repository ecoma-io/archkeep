# The agent-workflow evaluation suite

The ten-scenario harness for [the protocol page](../docs/doctrine/agent-workflow-protocol.md).
Each scenario stages a throwaway fixture workspace, drives the engine CLI
exactly as the protocol dictates, and asserts named envelope fields and exit
codes — the engine-truth half. The protocol half — the claims that the skill
text mandates a step at all — is asserted by the runner from
`bindings.json`, against the shipped `skills/` tree, before a scenario's own
script runs. Nothing scores a fixture it wrote itself.

## What a scenario is

`scenarios/<NN-slug>/` holds exactly three files:

- `run.sh` — bash, self-contained. It creates a throwaway fixture workspace
  under `mktemp -d`, builds the adversarial state, drives the CLI, and scores
  the engine observations it can measure honestly. The runner exports
  `ARCHKEEP_CLI` (absolute path to the engine CLI). It prints one
  `OBSERVED <key>=<value>` line per observation and ends with `SCORE pass` or
  `SCORE fail`.
- `bindings.json` — the non-empty array of requirement ids (from
  `scripts/skill-protocol.mjs`) this scenario exercises. The runner resolves
  them via `unmetBoundRequirements()` and scores the scenario `fail` when the
  shipped skill text no longer states one — that red is the mutation signal
  (#935: the suite used to pass 10/10 with the skill layer deleted). A
  missing, empty, or typo'd binding is `BROKEN`, not a pass.
- `README.md` — the scenario's identity: class, adversarial move, what the
  script measures, and which forcing points the binding covers.

Exit codes: `0` scored pass, `1` scored fail, `2` the scenario is broken
(harness error — the runner reports it separately from a score).

## What is scored

- **Envelope fields and exit codes** — the scenario reads the CLI's JSON
  output and asserts named fields (`reconciliation.verdict`,
  `coverage.coverageGaps`, `result.suppressions[]`, …).
- **Protocol bindings** — the runner flattens each shipped SKILL.md's
  whitespace and requires every anchor of every bound requirement to match.
  An anchor that stopped matching means the claim was deleted or reworded
  past its load-bearing phrases.

## What a pass does and does not prove

A green suite proves two things and is honest about a third it cannot:

1. The engine produces the verdicts, refusals, and disclosures the protocol
   is written against (the scenarios' engine halves).
2. The shipped skill text states every forcing point the scenarios bind (the
   runner's pre-flight).

It does **not** prove an agent follows the skill — an agent choosing its own
commands is a trust boundary no fixture can close. That lane is the
real-agent dogfood, and its result is recorded, never gated.

## Running it

```bash
node agent-suite/run.mjs           # report: the table, exit 0 — scores are data
node agent-suite/run.mjs --gate    # gate: exit 1 unless every scenario scores pass
```

Gate mode is what CI runs on every pull request (the `agent-suite` job in
`.github/workflows/ci.yml`, inside `ci-gate`'s `needs`). To debug one
scenario's binding:

```bash
node agent-suite/protocol-gate.mjs VERIFY-WAIVERS-MANDATORY
```

## Rules the scenarios obey

- Every child process gets an argument array, never a built string.
- A scenario never writes outside its own `mktemp -d` workspace.
- A scenario asserts observations; it never asserts engine internals.
- A score of `fail` is a finding about the workflow, not a harness failure —
  the runner still exits 0 in report mode.
- A scenario never authors the artifact its own score greps.
