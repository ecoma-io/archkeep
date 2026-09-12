# 10 — missing baseline (class F)

Runs the change workflow in a workspace that never captured a baseline, then
scores whether the review step reports the refusal instead of completing with
a verdict.

## Class and adversarial move

- **Class:** F — baseline artifact absent
  (`docs/doctrine/agent-workflow-protocol.md` class table: signal
  "baseline artifact absent"; forced consumption "REVIEW reports INCOMPLETE
  (the refusal shape)").
- **Adversarial move:** the fixture is a healthy, fully tracked repo with a
  well-formed intent at the current commit — but `.archkeep/base.json` was
  never captured. The scripted agent runs `change` anyway.

## Must-catch step

REVIEW. The review must report the run as INCOMPLETE and name the missing
baseline artifact; it must not emit a verdict-shaped completion.

## Required observations

`pass` requires ALL of (scoring rule):

1. `engine_exit` — the real exit code of `archkeep change` without a
   baseline (observed live: `3`, the fail-closed no-verdict exit).
2. `engine_refusal` — the refusal is observed, not assumed: stderr says
   `cannot read the evidence snapshot …/.archkeep/base.json: ENOENT` and
   stdout carries no JSON envelope.
3. `marker` — the fixture transcript `$W/review-transcript.md` contains the
   required marker line:

   `Review status: INCOMPLETE — required artifact .archkeep/base.json is missing; no verdict emitted.`

   The marker is transcript-side only: no engine command emits it — the
   skill text owns the refusal shape, and the transcript heredoc in
   `run.sh` models it.

## Score history

Before the skill-text change this scenario scored `SCORE fail` (the red is
on record in the before-scores table on #921):

- The engine half was **green** — engine-enforced then and now: the CLI
  refuses without a captured baseline (exit 3, naming the evidence
  snapshot), so `engine_exit=3` and `engine_refusal=missing-baseline-snapshot`
  hold.
- The marker half was **red** — the then-current unforced review transcript
  documented the refusal and then completed with
  `Review complete. Verdict: PASS — no violations found.` anyway — exactly
  the verdict-shaped completion class F names.

The `review-transcript.md` heredoc in `run.sh` now models the mandated
refusal shape — the review states INCOMPLETE and names the missing
`.archkeep/base.json` instead of emitting a verdict, the shape
`docs/doctrine/agent-workflow-protocol.md` owns (row 10 machine score:
"review reports INCOMPLETE; no verdict-shaped completion emitted") — so the
scenario scores `pass`; a transcript that completes with a verdict over a
missing baseline scores `fail` again.
