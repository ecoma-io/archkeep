# The agent workflow

Measured status of the layer that makes a coding agent prove an architectural
change, and the failure taxonomy the protocol closes. The measurements below
are what was measured, at 0.29.0, before any redesign; the protocol adopted
against this taxonomy is [the protocol
page](agent-workflow-protocol.md), and its adoption is recorded in
[ADR 0011](../adr/0011-agent-workflow-protocol.md). The measurement text is
kept as written — a measurement record reworded after the fact would read as
a fact about a tree that no longer exists.

Every measurement below was reproduced on a throwaway native-provider workspace
(`archkeep.json` `projects.declared` plus a `module-boundaries.config.mjs`
dependency row, git history with a captured baseline) running archkeep 0.29.0.

## Why this layer is judged differently

The engine's contract is [principle 2](principles.md#2-a-green-result-must-mean-something):
a clean verdict must mean clean. For a human that contract is enough — they ran
the command and read the answer. An agent is different in one way that decides
this page: **it chooses which commands to run, and nothing in the repository
forces the choice.** A disclosure the agent never reads is byte-for-byte
identical to one that does not exist. And [principle
7](principles.md#7-agents-are-consumers-of-architecture-not-its-authority)
already names the agent a consumer, not an authority — this page is about what
its consumption is required to look like. So the agent layer is judged on a
second question the engine is not: does the workflow make the agent reach, and
act on, the evidence the engine already emits?

The five skills ([overview](../skills/overview.md)) answer that question today
with prose. The prose is good; prose is also the problem. Everything below that
can fail, fails silently.

## The measured failures

Each failure was executed, not imagined. The shape of each: what the agent did,
what the engine reported, what escalated. In every row, nothing escalated.

### 1. Editing the law until green

Relaxing the `depConstraints` row that forbids `domain → adapter` turns
`archkeep check` from exit 1 to exit 0, and a later
`archkeep change <baseline> --intent <manifest>` reports verdict `matched` with
exit 0. The `change` envelope _does_ disclose it — `policy.changedSinceBase:
true` on every change run whose policy fingerprint moved from the pinned base,
with the baseline recording the old fingerprint, and `delta` disclosing the
same fact as `policyChanged` — while a bare `check` run, which has no pinned
base, emits no such disclosure at all. No skill text treats the disclosure as
an escalation; no command fails on it. From CI's point of view the gamed tree
and an honest clean tree are indistinguishable.

`delta` cannot catch it, and the skills' own text says why: both sides of a
delta are re-judged _under the current law_, so a policy edit between capture
and compare changes the judge, not the verdict.

### 2. Suppressing instead of fixing

A `boundarySuppressions` row without `expiresAt` covering a newly introduced
crossing returns `check` to exit 0. The violation still exists; the verdict
does not report it. The one skill step that names it — arch-check's "to tell
which 'empty' a green run is, run `archkeep waivers`" — is advisory prose, not
a forced gate: exit 0 is precisely the state in which an agent skipping
optional prose never runs it.

### 3. Never declaring, never reconciling

`archkeep change <baseline> --intent <manifest>` is the engine's expected-vs-
actual contract: verdicts `matched` / `undeclared` / `unfulfilled` /
`unproven`, proof that the baseline pins the true base commit, a breadth guard
that refuses an empty declaration, and an `--event-out` audit trail. Measured
across all five SKILL.md files: zero occurrences of `archkeep change`, `--intent`,
a change-intent manifest, `scenario`, or `trajectory`. The capture half
(`archkeep delta --capture --output delta-base.json`) _is_ taught, in
arch-change and arch-review — but as an optional diff aid, and arch-review
handles the missing-baseline case in prose: "If no baseline exists, this step
is skipped and the review says so; a lack of a baseline is a coverage gap, not
'no structural change'". The skill names the gap and completes the review
anyway — disclosure-without-enforcement inside the skill text itself. A review
without a baseline is a review that never compared expected to actual, and the
skill blesses completing it as long as the sentence gets said.

A lying manifest is caught: one declaring only `noNewViolations: true` (a
constraint row, so the breadth guard admits it) while the tree adds
`domain → adapter` gets verdict `undeclared` and exit 1. But only if the agent
writes one, and nothing requires the agent to write one.

### 4. Verifying bytes git will not judge

The engine's file universe is tracked files (`git ls-files`). An untracked
file carrying the forbidden import produces `check` exit 0 — with the file
named in `coverage.coverageGaps` under `kind: "untracked-files"`, per the
disclosure discipline recorded for that gap. Stage the file (`git add`) and
the same tree exits 1. The disclosure is real; the exit code stays 0; an agent
that verifies before staging reports green over violating bytes, and no skill
step requires reading the gap row — or staging — before claiming verified.

The loud edges of the same design hold: a tracked-but-unreadable file is exit 3
`no-verdict` with the file named in `coverage.notAnalyzed`, and a scoped path
that matches no tracked file is a usage refusal, not a clean run.

### 5. Completion by assertion

Nothing machine-checkable distinguishes "verified, evidence attached" from
"claims verified". Every skill's exit criteria reduce to exit codes and prose
summaries. The engine emits the materials for a checkable completion — the
change event (`--event-out`), the envelope fingerprints (policy, intent),
snapshot identity for history — and no skill step names any of them as the
definition of done.

### 6. Over-processing without a floor

The mirror failure: the same workflow text faces a one-line typo and a
boundary redesign. The trivial/heavy classification already exists — arch-change
step 3 ("if the change is not of that kind, you are done once the check is
green") and arch-review's When-to-use clause ("for a trivial edit …
`arch-check` alone may suffice") — but it governs only the skills' own steps: it
says nothing about the change contract, which no skill mentions, so nothing
decides _when the contract is warranted_. The agent either skips the machinery
everywhere or drags a typo through a nine-step protocol. Both directions are
failures; only one has teeth today.

## The failure taxonomy

The redesign is specified against these classes, each anchored to the measured
failures above and to the engine surface that already reports it:

| class | name                  | one-line definition                                                                                          | engine signal today                                                                                        |
| ----- | --------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| A     | Verdict substitution  | settling for weaker evidence than the question needs (clean `check` presented as "the architecture is good") | exit codes only; no reconciliation evidence required                                                       |
| B     | Law manipulation      | editing rules instead of code to pass                                                                        | `change` envelope `policy.changedSinceBase`; `delta` `policyChanged`; baseline policy fingerprint          |
| C     | Suppression abuse     | hiding an introduced crossing behind a suppression                                                           | `waivers` output; `expiresAt` distinction                                                                  |
| D     | Universe mismatch     | verifying bytes the tracked universe will not judge                                                          | `coverage.coverageGaps` `untracked-files`; staged-state exit 1; exit 3 `notAnalyzed`                       |
| E     | No-verdict laundering | treating `unknown` / exit 3 as pass                                                                          | exit 3 `no-verdict` envelope status; `notAnalyzed` rows                                                    |
| F     | Missing baseline      | classification and reconciliation impossible, review skipped instead of refused                              | `delta`/`change` exit 3 on an unresolvable baseline path; a never-captured baseline emits no signal at all |
| G     | Effort misallocation  | dragging trivial work through heavy process, or skipping process for heavy work                              | change-contract breadth guard (refusal); nothing else                                                      |

The silent direction generalizes: for every class, the failure state is
byte-for-byte indistinguishable from an honest completion **unless a workflow
step is required to consume the signal**. That is the redesign's thesis — the
engine has done its half; what is missing is the forcing function.

## What the engine already provides

The redesign hypothesis, and the reason it does not start with engine work:
every escalation signal the taxonomy needs is already emitted — with two
known holes, class F's never-captured baseline and post-hoc declaration
ordering, both named where the suite is defined.

- `change --intent` — the contract: verdicts, base-pin proof, breadth guard,
  `--event-out` ([usage](../usage/change.md)); its envelope carries
  `policy.changedSinceBase`.
- `delta --capture` — the baseline evidence snapshot, byte-canonical; the
  comparison discloses `policyChanged` and the baseline's policy fingerprint.
- `check` envelope — `result.policy.fingerprint`, `coverage.coverageGaps`,
  `coverage.notAnalyzed`.
- `waivers` — the suppression/waiver ledger with expiry.
- `drift`, `impact`, `scenario`, `provenance` — declared-state comparisons,
  touch analysis, hypothetical evaluation, and reproducibility metadata.
- Exit contract ([reference](../reference/exit-codes.md)) — 0/1/2/3 with
  `no-verdict` as a distinct envelope status.

No probe in this investigation required a new engine capability. That remains
falsifiable: the evaluation suite below is the test, and any scenario the
existing surfaces cannot score sends the work back to the engine — with the
evidence, not with a hunch.

## Per-skill verdicts (as landed)

The verdicts the adopted protocol implements; the classes each verdict exists
to close are in parentheses:

- **arch-context — keep, as the entry point.** Extends the trivial/heavy
  classification arch-change step 4 and arch-review's When-to-use clause already
  define (G)
  rather than inventing a second one: its first job becomes applying that
  existing test — trivial (no baseline, no contract, `check` alone) versus
  workflow-bearing (baseline + declaration) — and teaching that
  `unknown`/`no-verdict` context is a stop, not a footnote (E).
- **arch-change — keep, as the spine.** Re-centered on
  declare → implement → verify → reconcile with `change --intent` as the
  contract and `delta --capture` as its baseline step, not an optional aid
  (A, B, F). Delta diffing stays as the explanation layer.
- **arch-check — keep, as the verification verb.** Its fail-closed teaching
  (exit 3, waivers-on-green) already exists; what it gains is enforcement —
  consuming `coverageGaps` on an exit-0 run (D), the one rule no skill teaches
  today — and forced, not advisory, use of the steps it already teaches (C, E).
- **arch-review — keep, with its skip clause inverted.** The prose that names
  the missing baseline "a coverage gap" and completes the review anyway
  becomes a refusal shape: a review without reconciliation evidence reports
  itself incomplete — it does not complete (A, F).
- **arch-migrate — keep, for law-first changes.** Law edits route through the
  same baseline-and-contract path, so B-class moves are declared, not slipped
  (B).

Whether the protocol text lives in the skills, beside them, or as a shared
document they all cite is an open decision below — the failed experiment to
avoid is a ninth file restating the other five.

## Alternatives considered

1. **Better SKILL.md prose only.** Rejected: every measured failure survives
   it; prose cannot force a transition, and these failures are transitions
   that did not happen.
2. **More skills (one per workflow phase).** Rejected: skill proliferation,
   selection failures compound, and the agent that skips arch-change skips
   its successor too.
3. **Skills + protocol text.** Better; unenforceable alone — this is the
   floor, not the design.
4. **Skills + protocol + machine-checkable evidence wiring of existing
   commands.** The working hypothesis: escalation rules keyed to signals that
   already exist.
5. **A new engine capability (workflow state store, enforced transitions).**
   Rejected for now: nothing measured requires it. Revisit only if the
   evaluation suite proves a scenario the current surfaces cannot score.

## How the redesign will be judged

An adversarial evaluation suite, specified as runnable fixtures before any
skill text changes, scored before and after:

1. hidden architecture change (the agent is _told_ one thing; the tree does
   another — deception, not accident),
2. intent drift (declared scope quietly exceeds the task),
3. constraint manipulation (class B),
4. waiver/suppression abuse (class C),
5. unknown evidence (class E: unreadable file, unresolvable decision ref),
6. cross-repo authority (a boundary verdict belongs to the dogfooding repo's
   own law),
7. trivial change (class G: the floor — machinery must stay out),
8. unexpected delta (the agent's own edit carries an undeclared consequence
   that appears mid-task — emergence, not deception),
9. untracked verification (class D: verify-before-stage),
10. missing baseline (class F: the review refuses rather than completes
    without reconciliation evidence).

One vector the suite deliberately does not score: post-hoc declaration — a
manifest authored after implementation, to match what the tree already did, is
byte-identical in every current surface to one written first. That is a known
unscorable hole (open decision 5), not an oversight.

## Constraints that bind the design

- Declared architecture state stays the only authority;
  [architecture-authority.md](architecture-authority.md) still draws the line.
- Deterministic verdicts; `unknown`/`no-verdict` never becomes pass
  ([principle 3](principles.md#3-unknown-must-never-masquerade-as-valid)).
- Trivial work stays cheap — the protocol has a floor, not just a ceiling.
- No SKILL.md-length inflation; no new skill without retiring one.
- Backward compatibility and migration are part of the change, not
  follow-ups; on the 0.x line a behavioral shift in what agents are told is a
  minor bump named in the changelog, per the [compatibility
  contract](../development/release.md#release-stages-the-0x-line-and-the-parked-candidate).

## The decisions, resolved

The five decisions this page ended on were answered by the protocol's
[D1–D5](agent-workflow-protocol.md) and recorded in
[ADR 0011](../adr/0011-agent-workflow-protocol.md): the steps live in the
five skills (1); completion evidence is the change envelope plus the event
file (2); arch-review's refusal stays skill-side (3); the suite is shell
fixtures plus per-scenario protocol bindings, not the MCP surface (4); and
declaration ordering stayed unaudited — [post-hoc declaration and baseline
re-capture are named
residuals](agent-workflow-protocol.md#decisions) (5), reopenable only as an
engine capability decision with its own compatibility cost.
