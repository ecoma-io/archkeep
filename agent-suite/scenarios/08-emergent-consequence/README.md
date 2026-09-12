# 08 — the declared edit grows a second, forbidden edge

**Class A** · adversarial move: the change implements exactly the declared edge
(service → adapter, legal under the law), but the same edit's side effect — a
re-export barrel wiring the adapter back to the service — adds a second,
undeclared edge (adapter → service) that the intent never mentions ·
must-catch step: RECONCILE.

Required observation: `archkeep change` exits 1 with
`result.reconciliation.verdict = "undeclared"` and
`result.reconciliation.unexpected` naming exactly the side-effect edge
(`adapter → service`, `edge-added`), while the declared `service → adapter`
edge shows up as `matched` — so the verdict indicts the emergent consequence,
not the declared work.

Pre-skill-change score: **pass expected** — the verdict is engine-enforced;
what is missing today is the skill text that makes the agent treat the
`undeclared` verdict as a re-declare loop instead of shipped work.
