---
name: arch-review
description: Review a change or PR for architecture governance — establish context, inspect the change, run the authoritative gate, and produce an evidence-backed review
compatibility: Requires @ecoma-io/lattice CLI
---

## When to use

When reviewing a change, pull request, or diff for architecture impact —
especially changes that touch cross-project imports, add dependencies, move
code between projects, or modify anything that declares architecture
(`module-boundaries.config.*`, a profiles registry, `architecture-intent.json`,
project manifests, `docs/adr/` records).
For a trivial edit (whitespace, comments, string constants in an isolated
module), `arch-check` alone may suffice — this skill is for changes where the
architecture consequences matter.

## Why

A review that does not assess architecture impact misses the most consequential
changes. An import that crosses a forbidden boundary, or a change that makes the
observed graph disagree with the declared Intent, is a real violation even if the
code compiles and tests pass. `arch-review` walks the architecture dimensions of
a change with deterministic evidence — the same commands a pipeline runs — so the
review verdict is backed by a re-runnable gate, not by the reviewer's memory of
what the architecture was.

## How

### 1. Establish context

For each project touched by the change:

```
lattice context <project> --format json
```

Understand what constraints apply — which dependency directions are allowed and
which are forbidden. If a project has no constraints, that is an unknown, not a
green light. **Name the law the verdict depends on before reading it**: check
whether the workspace enforces by file or by named profile (see `arch-context`,
"Know which law is in effect"), and state which one the change was made
against. A review that does not say which law it judged the change against
cannot be reproduced. For a change whose architecture consequences matter,
request the planning context too — it bundles the current architecture, policy
with Intent, impact, current violations, drift, and verification commands in
one document:

```
lattice context <project> --plan path/to/file.go
```

### 2. Inspect the change

Read the diff and decide whether it is an **architecture change** — a move the
next step must treat as such — or an ordinary source change. Architecture
changes include: project boundaries touched, dependency direction reversed, a
project created or removed, ownership boundaries moved, the policy changed, the
profile registry changed (a profile's `block`, its `base` chain, or the default
profile a `boundaryConfig` selects), the declared Intent changed, or the
provider migrated. When a reviewed rule carries a `decisionRef`, cite the
decision it leans on — `lattice adr rule:<id>` names the record that binds it,
and its status and rationale are review evidence. A change that satisfies the
rule table but contradicts the recorded decision is a finding, not a pass.
If the change is none of those, the review is: context → check → verdict, and
you can skip the heavy steps.

### 3. Determine whether the architecture changed

If a baseline graph snapshot exists (from a prior
`lattice graph --format json --output baseline.json` run), compare the current
graph against it:

```
lattice diff baseline.json --format json
```

This shows added and removed edges, project changes, and — when a boundary
config is available — rule-impact analysis for each changed edge. A diff with
`--format json` provides the same data structured for programmatic use. If no
baseline exists, this step is skipped and the review says so; a lack of a
baseline is a coverage gap, not "no structural change".

### 4. Evaluate impact

For each changed project, see who depends on it:

```
lattice impact <project> --format json
```

An empty `dependents` list is a claim ("nothing depends on this"), not a shrug.
A non-empty list shows the blast radius: which other projects would be affected
by a change to this one.

### 5. Run the authoritative check

```
lattice check --format json
```

This is the gate — boundary violations **and** the declared Intent, in one run,
against the law in effect (the profile `boundaryConfig`/`--config` selects in a
profile-selected workspace). Exit 1 names findings the change introduced or
resolved; exit 3 means the gate could not reach a verdict on part of the
workspace — including a profile that could not be resolved — and the review
must say so instead of reporting "no findings". When the change is itself a
profile under review, judge it without touching the live law:

```
lattice check --config <candidate-profile>
```

That run resolves a different law than the one in effect — it is a review of
the candidate, never a verification of the change, and the review must label
it as such and name the `--config <NAME>` it ran with (see step 11).

### 6. Evaluate drift when Intent or architecture differs

When the change is architectural or Intent-adjacent, confirm the observed graph
still agrees with the declared architecture:

```
lattice drift --format json
```

Exit 3 — the intent comparison cannot be verified — is NOT "clean". An
unverifiable intent must never be read as a satisfied one. Drift findings
(`intentAllowedMissing`, `intentForbiddenEdge`, …) are the evidence a review
cites when it says "the declared architecture no longer matches the code".

### 7. Select supporting evidence as the change warrants

- **Health / quality claim** — `lattice health` reports per-metric verdicts
  (a metric whose evidence is unavailable is `unknown`/`not_applicable`, never
  zero); `lattice fitness`(when the policy declares a `fitness` export) judges
  the workspace's named quality gates with `pass` / `fail` / `unknown` /
  `not_applicable` verdicts. Both are descriptive — they never exit 1. `check`
  stays the gate.
- **Pre-existing violations ("debt")** — `lattice debt <dir>` ages waivers, gaps
  and drift across a snapshots directory: how long a violation has been
  accepted or unknown. It is a ledger, not a live gate — it never changes a
  verdict. For "did THIS change introduce the violation", compare the current
  `check` output against the baseline diff; disclose, they are not caused by
  this change.
- **Waivers / exceptions** — a suppression (no `expiresAt`) is permanent, and
  a waiver (with `expiresAt`) accepts a violation for a fixed term. Both live
  in `boundarySuppressions`; `lattice waivers` lists only the term-bound rows
  (a permanent suppression is absent from the listing), and `check` keeps
  reporting a waived violation as a finding (exit 1) so CI still catches the
  day the term lapses. `coverage.exempt` in `lattice.json` is the one
  coverage-count suppression surface, and it requires a mandatory reason.
  A waiver never promotes `unknown` → `pass`.
- **Provenance** — each `graph` snapshot carries its git origin;
  `history` classifies transitions (architecture / policy / provider / code
  drift) by the evidence snapshots carry; `lattice provenance` reports the
  governance row schema. Provenance is a property of snapshots — a command
  reports it, it does not pluralize it.
- **ADR / decision references** — when a reviewed constraint or intent row
  carries a `decisionRef` (a fitness gate cannot: a fitness row accepts exactly
  `name`/`match`/`condition`/`reason`), verify the decision it leans on
  (`lattice adr rule:no-direct-dep` finds the binding ADR; `lattice adr
0001-bind-collaboration` confirms the record's status and its bindings — the
  decision's rationale and context live in the record file, `docs/adr/NNN-slug.md`,
  so open it and read the prose before judging the rule against it). A resolved
  decision is review evidence: the rule is enforced because a recorded decision
  made it so. An ADR id the registry does not know exits 3 — the record is
  missing, and the rule's governance grounding is `unknown`; the review must
  say so, never read it as bound. The reverse lookup inverts that: `lattice
adr rule:orphan` names a rule no ADR binds and exits 0 with a sentence —
  verify the rule row's exact spelling against the registry before reading it
  as "not governed". The rationale matters: a rule that contradicts the
  decision it cites, or a superseded record, is a finding the review should
  name.

### 8. Inspect history when the change follows architectural evolution

If the repository keeps snapshots, `lattice history <dir>` names which of the
recent transitions were architectural and which were policy or provider — useful
when the change is the latest move in an evolution the review should connect.

### 9. Explain non-obvious findings

For any violation where the reason matters:

```
lattice explain <file:line:column>
```

Cite the matching constraint row, the tags on both sides, and whether the
judgment is a violation — so the review's verdict is traceable to a rule.

### 10. Handle a stale-looking architecture model

If `drift` or `check` reports intent findings such that the _declared_ Intent
disagrees with the observed graph, the model may be stale. Do **not** silently
accept the disagreement, and do **not** silently rewrite the Intent to match.
The review states the discrepancy as a finding: the declared architecture and
the code have drifted, and the decision to reconcile them (new architecture, or
changed code) belongs to the team. When the team wants the shape of the
disagreement element by element, `lattice reconcile --propose` scores every
observed project and edge against the declared model and derives the edits that
would make them agree; `lattice discover --propose` derives candidate
architecture from what is observed. Both mark their output as proposals that
are never written — no command writes to the Intent, no command writes an ADR,
and proposed is never authoritative.

### 11. Produce the review

Report, each half with evidence:

- **Architecture state**: whether the change is architectural; the projects and
  edges it added or removed (`diff`); the Intent comparison (`drift`);
  dependents affected (`impact`).
- **Gate verdict**: the `check` exit code, the `--config <NAME>` (or
  `boundaryConfig` value) the gate resolved, every finding with its
  `file:line:column`, the coverage gaps that withheld a verdict, and whether
  the change introduced, resolved, or is silent about each.
- **Coverage honesty**: any run that exited 3, any missing baseline, any
  no-verdict intent. A review that cannot see part of the architecture says so.

## Decision tree

- **Did the architecture change?** (boundaries, dependencies, projects, provider)
  - **NO — and no Intent / policy / profile touch** → `context` → `check` →
    verdict. Done.
  - **NO — but the Intent or policy (file or profile) changed** → `context` →
    `diff` (rule-impact) → re-`check` → `drift` → verdict. A profile change
    also means naming the profile that was in effect before and after, and
    judging the change against the one that binds.
  - **YES** → `context` → `diff` → `impact` → `check` → `drift` → verdict.
- **Does a reviewed rule carry a `decisionRef`?** → `context` → inspect the
  reference (`lattice adr <ref>`, whichever shape the row's `decisionRef`
  holds — an ADR id `NNN-slug` reads the record, a `rule:`/`fitness:` id is the
  reverse lookup) → `check` → verdict. An unresolved reference is `unknown`,
  never valid evidence; say so.
- **Is the architecture model itself stale** (declared differs from observed)?
  → report the finding, `drift` for the full direction, `reconcile --propose`
  for the element-by-element shape of the disagreement, and escalate the
  reconcile decision to the team. Never rewrite the Intent silently.

## What to do if it fails

- **`lattice diff` exit 3** — the baseline or the head is incomplete. The diff
  is unreliable; do not treat it as "no changes". Re-generate the baseline with
  `lattice graph --format json` and try again.
- **`lattice impact` returns empty dependents** — that is a claim, not a shrug.
  Nothing in the workspace depends on this project. Verify this is expected.
- **`lattice check` exit 3** — coverage is incomplete. The review cannot reach a
  verdict on the unchecked files. State this in the review summary — and in a
  profile-selected workspace check whether the selected profile could be
  resolved before blaming the files: an unknown profile name, an unknown
  `base`, a `base` cycle, or an unreadable registry are all exit 3 with no
  fallback to another law.
- **`lattice adr` exit 3** — an ADR-pattern id the registry does not know, or a
  registry that could not be read. A `decisionRef` naming a missing record is
  `unknown`, never a pass; the review says the rule's grounding is unverifiable
  rather than citing it as evidence. A reverse lookup that exits 0 with `no ADR
binds rule:X` is a different answer — it names a rule id the registry binds
  nothing — so verify the exact spelling against the rule row before treating
  the rule as ungoverned.
- **`lattice drift` exit 3** — the Intent cannot be verified. The governance
  status is unknown; the review must say so, not pass on it.
- **`lattice reconcile --propose` refuses** — `reconcile` exits 3 loudly on
  every path that cannot reach a verdict; it never exits 1 (describing the
  disagreement is not a finding). An unknown classification means the model
  cannot be scored — say so rather than treating it as "no disagreement".
- **Multiple violations, unclear which are new** — compare the check output
  against the baseline diff. If no baseline exists, the check output shows the
  current state but cannot distinguish new from pre-existing violations; the
  review says which half that is.
