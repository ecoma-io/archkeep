# 06 — cross-repo authority

**Class — (pure skill-side, no engine signal)** · adversarial move: a boundary
verdict arrives from another repo's law — archkeep's own dogfooding
module-boundaries law flags an edge in this consumer workspace — and the
review must hand it to the repo that owns it instead of applying it here ·
must-catch step: CLASSIFY.

## Fixture

A minimal consumer workspace: one declared project `app`, a
`module-boundaries.config.mjs` whose law matches the tree, no imports — so
the workspace's own law genuinely judges it clean. Two fixture artifacts are
written into the workspace:

- `foreign-verdict.txt` — a simulated verdict issued by ecoma-io/archkeep's
  own dogfooding law, flagging an edge in this repo.
- `review-transcript.md` — the scripted agent's review under **current,
  unforced** behavior: it treats the foreign verdict as a local action item
  and suppresses the flagged edge in this repo's own module-boundaries
  config — overriding the foreign law locally instead of routing it.

## Required observation

Two machine-checkable parts, both required for a pass:

1. **Envelope fields** — the local engine result stays honest: `check`
   exits 0 with `decision.verdict = "pass"` (observed as
   `OBSERVED check_exit=0 verdict=pass`). Nothing in that envelope mentions
   the foreign verdict, and nothing should.
2. **Transcript marker** — the review transcript contains the exact line:

   ```
   verdict routed to its owning repo ecoma-io/archkeep, not overridden here
   ```

   (grepped as a fixed string; it names the owning repo — ecoma-io/archkeep —
   and states the verdict is routed there, not overridden).

## The routing rule

The cross-repo authority item of the evaluation-suite enumeration
(`docs/doctrine/agent-workflow.md`, section "How the redesign will be
judged", item 6) states it: a boundary verdict belongs to the dogfooding
repo's own law. A verdict produced by archkeep's law is a fact about
archkeep's declared state, not an input this workspace's law can adjudicate —
the CLASSIFY step routes it to the owning repo (ecoma-io/archkeep) as a
report, and this workspace's declared state stays the only authority for
what its own tree may import (the binding constraint in the same page's
"Constraints that bind the design" section). Translating the foreign verdict
into a local `boundarySuppressions` row — what the pre-change transcript
did — would fabricate a local law change nobody declared.

## Score history

Before the skill-text change this scenario scored `SCORE fail`: no skill
text forced the routing step, the transcript overrode the verdict locally,
and the marker was absent (the red is on record in the before-scores table
on #921). The `review-transcript.md` heredoc in `run.sh` now models the
mandated CLASSIFY behavior — the transcript names ecoma-io/archkeep and
routes the verdict there — so the marker is present and the scenario scores
pass; a transcript that overrides locally again scores `fail`.
