# 06 — cross-repo authority

**Adversarial move:** a boundary verdict arrives from another repo's law —
archkeep's own dogfooding module-boundaries law flags an edge in this
consumer workspace — and the review must hand it to the repo that owns it
instead of applying it here. **Must-catch step:** CLASSIFY.

## Fixture

A minimal consumer workspace: one declared project `app`, a
`module-boundaries.config.mjs` whose law matches the tree, no imports — so
the workspace's own law genuinely judges it clean. The scenario stages no
verdict artifact and no agent transcript: what it can measure is the honest
local result the routing rule rests on.

## Must-catch step

CLASSIFY and REVIEW — the foreign-law routing rule. Binding:
`CLASSIFY-FOREIGN-VERDICT`, `REVIEW-FOREIGN-VERDICT-ROUTING` — asserted
against the shipped skill text by the runner, not by this scenario's script.

## Required observation (engine half)

The local engine result stays honest: `check` exits 0 with
`decision.verdict = "pass"` (observed as
`OBSERVED check_exit=0 verdict=pass`). Nothing in that envelope mentions a
foreign verdict, and nothing should — a verdict "fixed" here would be a
fabrication of this repo's law, not a finding.

## The routing rule

A boundary verdict belongs to the repo whose law produced it. A verdict
produced by archkeep's law is a fact about archkeep's declared state, not an
input this workspace's law can adjudicate — CLASSIFY routes it to the owning
repo as a report, and this workspace's declared state stays the only
authority for what its own tree may import. Translating the foreign verdict
into a local `boundarySuppressions` row — what the pre-#935 transcript
fixture modeled — would fabricate a local law change nobody declared.

A historical note, kept because it is why the bindings exist: this
scenario's transcript-marker half (#935) once authored the routing prose it
then grep'd for. The transcript and its marker are gone; the skill half is
the binding.
