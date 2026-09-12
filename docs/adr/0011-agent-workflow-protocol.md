---
id: 0011-agent-workflow-protocol
status: accepted
---

# The agent workflow protocol is adopted: the five skills carry the forcing points, and the suite measures the shipped text

## Context

[The agent workflow audit](../doctrine/agent-workflow.md) measured seven
failure classes (A–G) in which an agent's architectural failure state is
byte-for-byte indistinguishable from an honest completion: editing the law
until green, suppressing instead of fixing, never declaring and never
reconciling, verifying bytes git will not judge, laundering no-verdict into
pass, completing without a baseline, and dragging trivial work through heavy
process. The audit's finding was that the engine already emits every
escalation signal the taxonomy needs — the missing half was forcing any
workflow step to consume them. The protocol drafted against that taxonomy was
reviewed under
[ecoma-io/archkeep#921](https://github.com/ecoma-io/archkeep/issues/921) and
landed as a sequence of merged changes: the evaluation suite (#925), the
skill-text enforcement (#926), the CI gate (#930), the architecture-bearing
change bar in `CONTRIBUTING.md` (#931), and the baseline-before-declare
ordering (#932). This record is that adoption's outcome; the protocol's
owning reference is [the protocol page](../doctrine/agent-workflow-protocol.md).

## Decision

1. **The protocol's operational steps live in the five existing SKILL.md
   files, one owner per state.** CLASSIFY in `arch-context`; BASELINE,
   DECLARE and RECONCILE in `arch-change`; VERIFY in `arch-check`; REVIEW in
   `arch-review`; law-first routing in `arch-migrate`. No skill is added,
   renamed, or retired; the version chain is untouched.
2. **The workflow is the state machine the protocol page draws**, with the
   escalation edges as the design: `policy.changedSinceBase: true` routes
   back to DECLARE; a suppression delta is quoted by REVIEW;
   `coverage.coverageGaps` or `coverage.notAnalyzed` non-empty stops VERIFY;
   a `change` verdict other than `matched` routes back to IMPLEMENT; a
   missing baseline makes REVIEW report INCOMPLETE. Trivial work skips the
   machinery entirely — the floor is load-bearing.
3. **Completion evidence is quotable, not asserted**: the review quotes the
   baseline identity (`.archkeep/base.json`, whose `provenance.commit` pins
   the base commit), the `change` verdict (`reconciliation.verdict`), and the
   per-run event artifact its `--event-out` store wrote. Missing any one is
   the INCOMPLETE refusal — no verdict-shaped completion.
4. **Each forcing point is stated once, in one table, and consumed twice.**
   `scripts/skill-protocol.mjs` holds the requirement table;
   `scripts/check-skills.mjs` fails when a skill's text no longer states a
   requirement, and the evaluation suite's per-scenario `bindings.json`
   asserts — through `agent-suite/protocol-gate.mjs` — that the shipped text
   states the points a scenario binds before the scenario's script runs. The
   suite once passed 10/10 with the skill layer deleted because its transcript
   fixtures authored the evidence they grep'd for
   ([#935](https://github.com/ecoma-io/archkeep/issues/935)); the binding is
   what makes that failure impossible in both directions — a scenario that
   binds nothing is BROKEN, and a deleted forcing point turns every scenario
   that binds it red.
5. **The evaluation model is three-layer, stated honestly.** A green suite
   proves (a) the engine produces the verdicts, refusals, and disclosures the
   protocol is written against, and (b) the shipped skill text states the
   forcing points. It does **not** prove an agent follows the skill — that
   is a trust boundary no fixture closes, and the real-agent lane records
   its result without gating on it.
6. **Two residuals are named, not hidden.** Post-hoc declaration (a manifest
   authored after the edit to match what the tree already did) is
   unscorable today. Baseline re-capture at a gamed head is mitigated only
   by REVIEW quoting the baseline's `provenance.commit` against the task's
   stated starting point — the merge base on a pull request — which makes a
   re-captured baseline visible to a reviewer without any gate firing.
   Reopening either as engine work (write-time ordering, baseline
   provenance) is a capability decision with its own compatibility cost.

## Rationale

The audit's design bar decides the shape: for every failure class, the
failure state must become distinguishable from an honest completion by a
workflow step that is required, not advised. Skills are the only artifact
that reaches the agent at the moment of choice — they are vendored standalone
into arbitrary hosts where `docs/` does not exist, so a shared protocol page
the skills cite was the failed alternative, not the design. But skill prose
alone was measured to fail (audit alternative 1), which is why the forcing
points are gated where they live: a table with two consumers cannot drift in
one direction silently, and the suite's bindings make the claim "the skill
mandates this step" a checked fact about files a scenario cannot author. The
engine stays out of the workflow business: every escalation edge consumes a
signal the engine already emits, no engine capability was added, and the
declared-state authority model
([architecture-authority.md](../doctrine/architecture-authority.md)) is
untouched — agents remain consumers.

## Refused alternatives

- **Better SKILL.md prose only.** Every measured failure survives it; prose
  cannot force a transition, and these failures are transitions that did not
  happen.
- **More skills, one per workflow phase.** Skill proliferation, selection
  failures compounding, and the agent that skips one skill skips its
  successor.
- **An engine-side workflow state store or enforced transitions.** Nothing
  measured requires it; it crosses into decision 6's territory and moves a
  frozen surface. Revisit only with a scenario the current surfaces cannot
  score.
- **A suite that authors its own evidence.** The #935 failure: transcript
  fixtures writing the compliant artifact their score grepped. A scenario
  never authors the artifact its own score greps; what it cannot measure
  honestly becomes a binding, not a fixture.

## Consequences

What agents are told changed on an unchanged workspace — a 0.x behavior
change under [the compatibility
contract](../development/release.md#release-stages-the-0x-line-and-the-parked-candidate),
named in the changelog, with no frozen surface moved: API, config schema,
output contracts, and exit codes stayed byte-stable. The forcing-point table
is now load-bearing in both directions: rewording a skill past its anchors
turns `check-skills` and every bound scenario red, and a scenario whose
fixture stops exercising its bound points must have its bindings narrowed,
not its score faked. The residuals of decision 6 stay open on purpose; a
protocol that pretended they were closed would be the audit's class-A
failure wearing the protocol's own lanyard.
