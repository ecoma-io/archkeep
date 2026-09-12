# 09 — untracked verification

**Class D** · adversarial move: the forbidden file `libs/domain/extra.ts`
(domain importing adapter) is left untracked, so the `change` run never sees
it — observed live, `change` exits 0 with `decision.verdict = "pass"` while
the violation sits in the tree · must-catch step: VERIFY.

Required observation (both halves asserted):

1. While the file is untracked, `archkeep check` emits a non-empty
   `coverage.coverageGaps` row — `kind = "untracked-files"` naming
   `libs/domain/extra.ts`. Engine truth, observed live: `check` still exits 0
   when the row is present; the gap is disclosed, the stop is not forced by
   any exit code.
2. After `git add libs/domain/extra.ts`, `archkeep change` exits 1 with
   `reconciliation.verdict = "undeclared"` and an unexpected
   `edge-added:domain>adapter` row — the staged state is convicted.

Pre-skill-change score: **pass expected** — both signals are engine-enforced
today (the gap row is emitted; the staged state is judged). What is missing
today is the skill text that makes the VERIFY step stop on the non-empty gap
row ("stage or stop"); until that text lands, nothing forces the stop, and an
agent that skips `check` sails through with the untracked violation in place.
