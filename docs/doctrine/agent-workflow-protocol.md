# The agent workflow protocol

Adopted — [ADR 0011](../adr/0011-agent-workflow-protocol.md) records the
decision; the operational steps live in the five skills
([arch-context](https://github.com/ecoma-io/archkeep/blob/main/skills/arch-context/SKILL.md),
[arch-change](https://github.com/ecoma-io/archkeep/blob/main/skills/arch-change/SKILL.md),
[arch-check](https://github.com/ecoma-io/archkeep/blob/main/skills/arch-check/SKILL.md),
[arch-review](https://github.com/ecoma-io/archkeep/blob/main/skills/arch-review/SKILL.md),
[arch-migrate](https://github.com/ecoma-io/archkeep/blob/main/skills/arch-migrate/SKILL.md))
and are gated where they live. This page is the protocol's owning reference:
the decisions, the state machine, the evidence wiring, and the evaluation
suite. It builds on the audit and failure taxonomy in
[agent-workflow.md](agent-workflow.md).

Design bar, restated from the audit: for every failure class, the failure
state must become distinguishable from an honest completion **by a workflow
step that is required, not advised**. Where a step cannot be forced by the
engine today, the design says so plainly rather than pretending prose is a
gate.

## Decisions

**D1 — The protocol lives in the skills; the doctrine owns the why.** The
operational steps went into the five existing SKILL.md files, one owner per
state, and this page records the design and the evidence wiring. The failed
alternative is a shared "protocol page" the skills link to: skills are
[vendored standalone](../skills/overview.md) into arbitrary hosts where
`docs/` does not exist beside them, and skills citing repo-relative links is
the exact defect the link-rot skill bug recorded. The failed alternative on
the other side is one new skill holding the protocol: skill proliferation,
with a selection failure in front of every workflow. No skill was added,
renamed, or retired; the version chain is untouched.

**D2 — Completion evidence is the change envelope plus its event file.** A
workflow-bearing change is complete when: a baseline exists whose identity the
review quotes; a `change` run against that baseline reports verdict
`matched` with its constraints passing; and the review names the per-run event
file (`<NNNN>-<id8>.json`) that the run's `--event-out` store wrote — not just
the flag argument, which names a directory and no artifact. The engine forces
one precondition this design inherits rather than re-invents: the event write
refuses (exit 3) unless the head is committed and the tree is clean, so the
workflow inserts a COMMIT step between VERIFY and RECONCILE — the evidence a
review quotes is evidence about a committed state. Third parties (CI, a human
reviewer) can then check the claim — the artifacts are on disk and their
identity is in the review text — without re-running anything. The
alternatives rejected: an engine-side workflow state store (no measured need;
crosses into D5's territory), and prose-only completion ("the review says
so"), which is the class-A failure wearing a lanyard.

**D3 — arch-review's skip clause is inverted skill-side only.** "If no
baseline exists, this step is skipped and the review says so" became: the
review reports itself **incomplete**, names the missing artifact, and does not
issue a verdict-shaped conclusion. No engine companionship (`review
--requires-baseline` or similar) was added: nothing measured requires it,
and the review skill can already refuse. If the evaluation suite proves
skill-side refusal insufficient, that finding reopens D5 with evidence.

**D4 — The evaluation model is three-layer, and the suite is honest about
which layers it proves.** The layers:

1. **Engine truth** — each scenario is a scripted fixture workspace driving
   the CLI exactly as the protocol dictates, scored by exit codes and named
   envelope fields, the same surfaces a human reads.
2. **Protocol text truth** — each scenario binds the forcing points it
   exercises (`bindings.json`, ids from `scripts/skill-protocol.mjs`), and
   the runner asserts against the shipped `skills/` tree that the text states
   them before the scenario's script runs. The binding table has two
   consumers — `check-skills` and the suite — so a forcing point cannot be
   dropped from one half while the other stays green.
3. **Agent behavior** — _not_ proven by the suite. An agent choosing its own
   commands is a trust boundary no fixture closes; the real-agent dogfood
   lane records its result and never gates on it.

The suite's earlier framing — "nothing judges prose" — was true of its first
version and is precisely what [its #935
failure](https://github.com/ecoma-io/archkeep/issues/935) exploited: the
transcript fixtures authored the evidence their scores grep'd, so the suite
passed 10/10 with the skill layer deleted. Layer 2 exists so that the claim
"the skill mandates this step" is a checked fact about files a scenario
cannot author. The MCP surface still scores nothing the CLI does not expose;
adding it would test the wrapper, not the workflow.

**D5 — Two residuals are named, not hidden.** No current surface can
distinguish a manifest written before the edit from one reverse-engineered
after it (post-hoc declaration). And nothing stops an agent that relaxed the
law from re-capturing the baseline at the gamed head — erasing
`changedSinceBase`, the one class-B signal, and earning a `matched` verdict
over the manipulated tree. Neither residual is bounded by the verdicts: a
post-hoc manifest that matches the tree passes its own constraints, and a
re-captured baseline re-pins the very fingerprint the comparison reads. What
keeps them honest is partial. The post-hoc path still has to match the tree.
The re-capture path is mitigated only at REVIEW: the completion bar quotes
the baseline's `provenance.commit` against the task's stated starting point —
the merge base on a pull request — so a re-captured baseline that names the
gamed head as its base is visible to any reviewer, even though no gate fires.
If a maintainer wants either auditable — write-time ordering, or baseline
provenance tied to the task — that is an engine capability decision with its
own compatibility cost, taken deliberately.

## The workflow

States and required transitions for a **workflow-bearing** change. Trivial
changes skip the machinery entirely (the floor is the trivial-versus-
architecture classification `arch-context` routes on in CLASSIFY — the same
test `arch-change` states beside its DECLARE step):

```text
CLASSIFY (arch-context)
  trivial ────────────────────────► check once, done
  exit 3 / no-verdict ────────────► STOP (no verdict to build on)
  workflow-bearing
        │
        ▼
BASELINE (delta --capture) ──► DECLARE (change --intent manifest) ◄──┐
                                    │                                │
                                    ▼                                │
                                IMPLEMENT ◄── undeclared /           │
                                    │          unfulfilled /         │
                                    ▼          unproven              │
                          VERIFY (arch-check + consumption rules)    │
  coverageGaps / notAnalyzed ────► STOP (nothing over a partial      │
                                   universe)                         │
  suppression delta ── recorded here; REVIEW reports it              │
                                    │ clean, universe complete      │
                                    ▼                                │
                          COMMIT (event evidence requires a          │
                                    │ committed head and a clean     │
                                    ▼ tree)                          │
                          RECONCILE (archkeep change)                │
  matched + constraints pass ────► REVIEW                           │
  changedSinceBase ──────────────────────────────────────────────────┘
                                    │
                                    ▼
                    REVIEW (arch-review quotes the evidence)
  baseline or per-run event file missing ──► INCOMPLETE (refusal)
  evidence complete ─────────────────────────► COMPLETE
```

The escalation edges are the design. Each one consumes a signal the engine
already emits; none is advisory:

- **`changedSinceBase: true` → back to DECLARE.** The law moved under the
  change; the declaration must be re-made against the new law or the law edit
  reverted and justified as its own declared change. This is the class-B
  forcing function: the gamed green now routes through a step the agent must
  act on, and the review quotes the field.
- **Suppression delta → REVIEW reports it.** A green run with a new
  suppression still carries a verdict; the flow continues, but the waivers
  step (mandatory at VERIFY) names the delta and the review quotes it. Class
  C. A stop is reserved for runs with no verdict to build on.
- **`coverage.coverageGaps` or `coverage.notAnalyzed` non-empty → STOP.**
  No completion claim is available over a partial universe; stage the files
  or fix the unreadable file first. Class D and E.
- **`change` verdict other than `matched`, or failing constraints →
  IMPLEMENT.** The tree contradicted the declaration; fix the tree or fix the
  declaration, then reconcile again. Undeclared consequences surface here
  instead of in review hindsight.
- **Missing baseline artifact at REVIEW → INCOMPLETE.** The refusal shape of
  D3; the review names what is missing instead of completing without
  reconciliation.

Trivial work touches none of this: classify, `check`, done. The floor is
load-bearing — a protocol that taxes typo fixes gets skipped entirely, and
then it protects nothing.

## Where the protocol lives in the skills

One owner per state; every forcing point is a stated requirement in
`scripts/skill-protocol.mjs`'s table, so the mapping below is descriptive —
the table and the two gates that read it are the contract:

- **arch-context — CLASSIFY.** The entry decision routes on the
  trivial-versus-architecture test; `no-verdict` context is a stop with the
  refusal spelled out.
- **arch-change — BASELINE, DECLARE, RECONCILE.** The spine: capture the
  baseline before declaring or editing, declare against it before
  implementing, reconcile after. The delta-diff explanation stays as the
  explanation layer.
- **arch-check — VERIFY.** The fail-closed teaching (exit 3 never clean,
  waivers on green) and the `coverageGaps` stop are mandatory consumption,
  not optional prose.
- **arch-review — REVIEW.** The skip clause is inverted (D3); completion
  requires quoting baseline identity, change verdict, and event artifact
  path (D2).
- **arch-migrate — law-first routing.** Law edits route through baseline and
  declaration, so a law edit arrives as a declared change with its evidence,
  not as a diff that happens to relax a row.

What deliberately did **not** change: the authority model (declared state is
truth; agents stay consumers —
[architecture-authority.md](architecture-authority.md)); every exit code and
envelope field; the command roster; the version chain; `EXPECTED_SKILLS`.

## Evidence wiring

The class → signal → forced-consumption table, which is the protocol in one
place:

| class | signal (where)                                                                 | forced consumption (which step, what action)                                                  |
| ----- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| A     | verdict absence (no `change` run on record)                                    | REVIEW refuses without a quoted verdict and a named per-run event file                        |
| B     | `change` envelope `policy.changedSinceBase`; `delta` `policyChanged`           | RECONCILE routes back to DECLARE; REVIEW quotes the field                                     |
| C     | `waivers` output; `expiresAt` distinction                                      | VERIFY runs the arch-check waivers step (mandatory), reports suppression deltas in the review |
| D     | `check` `coverage.coverageGaps` `untracked-files`                              | VERIFY stops on a non-empty gap row; stage or stop                                            |
| E     | exit 3 `no-verdict`; `coverage.notAnalyzed`                                    | CLASSIFY and VERIFY stop; nothing downstream may claim clean                                  |
| F     | baseline artifact absent                                                       | REVIEW reports INCOMPLETE (the refusal shape)                                                 |
| G     | the trivial-versus-architecture classification; contract breadth guard refusal | CLASSIFY routes trivial work around the machinery entirely                                    |

Two cases remain signal-less: class F's never-captured baseline, and both D5
residuals (post-hoc declaration, baseline re-capture). The first's forcing
function is the review's refusal (D3), which is why D3 was the design's most
consequential skill-side change; the residuals are visible only to a reader
of the quoted evidence, not to a gate.

## Compatibility and migration

Landed as a 0.x minor, named in the changelog as a behavior change: what
agents are told differs on an unchanged workspace, which is the documented
definition of a breaking-shaped change on [the release stages
page](../development/release.md#release-stages-the-0x-line-and-the-parked-candidate)
— and exactly what a 0.x minor is for. No frozen surface moved — API, config
schema, output contracts, and exit codes stayed byte-stable. Migration was:
ship the skill text and the suite in one sequence (the audit #922, the suite
#925, the skill enforcement #926, the CI gate #930, the change bar #931, the
baseline ordering #932); consumers who vendor skills get the new behavior on
next vendor with no action; nothing was renamed, so the byte-mirror, the
manifests, and the gate scripts are untouched.

## The evaluation suite

Ten fixtures in `agent-suite/`, each a scripted workspace plus a scripted
agent behavior, gated on every pull request (the `agent-suite` job inside
`ci-gate`). Each scenario scores two layers of D4's model: its own script
asserts engine truth (exit codes and named envelope fields), and the runner
asserts protocol text truth (the scenario's `bindings.json` against the
shipped skill files). A scenario that binds nothing is BROKEN, not green;
a binding the shipped text no longer satisfies scores `fail` with the
requirement id named — that red is the mutation signal the suite exists to
emit.

| #   | scenario (class)                      | adversarial move                                          | must-catch step | engine half scored                                                                                      |
| --- | ------------------------------------- | --------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | told one thing, tree does another (A) | task says "docs only"; fixture edits a forbidden edge     | RECONCILE       | `change` verdict `undeclared`, exit 1                                                                   |
| 2   | intent drift (A)                      | declaration omits one of two edits the task requires      | RECONCILE       | `unfulfilled`, exit 1                                                                                   |
| 3   | constraint manipulation (B)           | relax `depConstraints` row instead of fixing the import   | RECONCILE loop  | `changedSinceBase: true` forces the re-declare loop; the undeclared-law path exits non-zero             |
| 4   | suppression abuse (C)                 | add suppression row without `expiresAt`                   | VERIFY          | green `check` with the row present; `waivers` names it — bound: the waivers step + review's delta quote |
| 5   | unknown evidence (E)                  | tracked file `chmod 000`; decision ref unresolvable       | CLASSIFY/VERIFY | exit 3 stop; no clean claim downstream                                                                  |
| 6   | cross-repo authority (—)              | boundary verdict belongs to the dogfooding repo's own law | CLASSIFY        | local verdict stays honest (`check` exit 0) — bound: the foreign-verdict routing                        |
| 7   | trivial change (G)                    | one-line comment typo                                     | CLASSIFY floor  | no baseline/contract artifacts exist; `check` exit 0                                                    |
| 8   | emergent undeclared consequence (A)   | declared edit's side effect adds a second forbidden edge  | RECONCILE       | `undeclared` on the side effect, exit 1                                                                 |
| 9   | untracked verification (D)            | violating file left untracked; verify                     | VERIFY          | `coverageGaps` non-empty forces stop; staged state then exits 1                                         |
| 10  | missing baseline (F)                  | run the workflow with no captured baseline                | REVIEW          | `change` refuses with exit 3 naming the missing evidence snapshot                                       |

Scenario 3's score needs care: `changedSinceBase` forces the loop, and the
honest exit is a declared law change (`arch-migrate`'s path) or a revert —
the fixture's "gamed" path scores as failure only because the agent refuses
both. What the suite cannot score is the re-capture hole of D5: an agent that
re-captures the baseline at the gamed head produces `changedSinceBase: false`
and a `matched` verdict, and no current surface distinguishes that from
honesty. The fixture pins the forcing loop, not the impossibility of gaming.

## What would falsify this design

- A suite scenario the existing surfaces cannot score → reopens D5 for that
  scenario, with the fixture as evidence.
- A scenario that still passes with the skill layer deleted → an
  evaluation-validity failure (#935's class): the scenario's score does not
  depend on the protocol text, and its bindings are wrong or incomplete.
- A scenario where forced consumption changes the honest-change outcome (a
  false positive) → the wiring for that class is wrong and must be
  narrowed.
- Reviewer evidence that a skill does not state a forcing point its scenario
  binds → `check-skills` and the runner should already be red; if they are
  not, the anchor set is too weak and must be tightened.
