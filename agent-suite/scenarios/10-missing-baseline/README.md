# 10 — missing baseline (class F)

Runs the change workflow in a workspace that never captured a baseline, and
scores the engine's refusal.

## Class and adversarial move

- **Class:** F — baseline artifact absent
  (`docs/doctrine/agent-workflow-protocol.md` class table: signal
  "baseline artifact absent"; forced consumption "REVIEW reports INCOMPLETE
  (the refusal shape)").
- **Adversarial move:** the fixture is a healthy, fully tracked repo with a
  well-formed intent at the current commit — but `.archkeep/base.json` was
  never captured. The agent runs `change` anyway.

## Must-catch step

REVIEW — the INCOMPLETE refusal. Binding: `REVIEW-INCOMPLETE-REFUSAL`,
`REVIEW-COMPLETION-BAR`, `BASELINE-CANONICAL-PATH` — asserted against the
shipped skill text by the runner, not by this scenario's script.

## Required observation (engine half)

1. `engine_exit` — the real exit code of `archkeep change` without a
   baseline (observed live: `3`, the fail-closed no-verdict exit).
2. `engine_refusal` — the refusal is observed, not assumed: stderr says
   `cannot read the evidence snapshot …/.archkeep/base.json: ENOENT` and
   stdout carries no JSON envelope.

The refusal shape the review must produce over this state — report
INCOMPLETE, name the missing artifact, emit no verdict-shaped completion —
is the bound skill half. No engine command emits it, and this scenario no
longer pretends to score it: the transcript fixture that "modeled" the
mandated refusal and grepped itself for it (#935) is gone.

## Score history

The engine half was green before the protocol landed and stays green: the
CLI refuses without a captured baseline (exit 3, naming the evidence
snapshot). The transcript-marker half scored whatever its heredoc was
written to say — which is precisely why it no longer exists.
