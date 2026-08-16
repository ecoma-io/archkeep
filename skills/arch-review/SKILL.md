---
name: arch-review
description: Review a change or PR for architecture governance — establish context, inspect the change, run the authoritative gate, and produce an evidence-backed review
metadata:
  version: "0.4.0"
compatibility: Requires @ecoma-io/lattice CLI
---

## When to use

When reviewing a change, pull request, or diff for architecture impact —
especially changes that touch cross-project imports, add dependencies, move
code between projects, or modify anything that declares architecture
(`module-boundaries.config.*`, `architecture-intent.json`, project manifests).
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
green light. For a change whose architecture consequences matter, request the
planning context too — it bundles the current architecture, policy with Intent,
impact, current violations, drift, and verification commands in one document:

```
lattice context <project> --plan path/to/file.go
```

### 2. Inspect the change

Read the diff and decide whether it is an **architecture change** — a move the
next step must treat as such — or an ordinary source change. Architecture
changes include: project boundaries touched, dependency direction reversed, a
project created or removed, ownership boundaries moved, the policy changed, the
declared Intent changed, or the provider migrated. If the change is none of
those, the review is: context → check → verdict, and you can skip the heavy
steps.

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

This is the gate — boundary violations **and** the declared Intent, in one run.
Exit 1 names findings the change introduced or resolved; exit 3 means the gate
could not reach a verdict on part of the workspace, and the review must say so
instead of reporting "no findings".

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
- **Pre-existing violations ("debt")** — `lattice debt` ages waivers, gaps
  and drift across a snapshots directory: how long a violation has been
  accepted or unknown. It is a ledger, not a live gate — it never changes a
  verdict. For "did THIS change introduce the violation", compare the current
  `check` output against the baseline diff; disclose, they are not caused by
  this change.
- **Waivers / exceptions** — a suppression (no `expiresAt`) is permanent, and
  a waiver (with `expiresAt`) accepts a violation for a fixed term. Both live
  in `boundarySuppressions`; `lattice waivers` lists them, and `check` keeps
  reporting a waived violation as a finding (exit 1) so CI still catches the
  day the term lapses. `coverage.exempt` in `lattice.json` is the one
  coverage-count suppression surface, and it requires a mandatory reason.
  A waiver never promotes `unknown` → `pass`.
- **Provenance** — each `graph` snapshot carries its git origin;
  `history` classifies transitions (architecture / policy / provider / code
  drift) by the evidence snapshots carry; `lattice provenance` reports the
  governance row schema. Provenance is a property of snapshots — a command
  reports it, it does not pluralize it.

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
are never written — no command writes to the Intent, and proposed is never
authoritative.

### 11. Produce the review

Report, each half with evidence:

- **Architecture state**: whether the change is architectural; the projects and
  edges it added or removed (`diff`); the Intent comparison (`drift`);
  dependents affected (`impact`).
- **Gate verdict**: the `check` exit code, every finding with its
  `file:line:column`, the coverage gaps that withheld a verdict, and whether
  the change introduced, resolved, or is silent about each.
- **Coverage honesty**: any run that exited 3, any missing baseline, any
  no-verdict intent. A review that cannot see part of the architecture says so.

## Decision tree

- **Did the architecture change?** (boundaries, dependencies, projects, provider)
  - **NO — and no Intent / policy touch** → `context` → `check` → verdict.
    Done.
  - **NO — but the Intent or policy changed** → `context` → `diff`
    (rule-impact) → re-`check` → `drift` → verdict.
  - **YES** → `context` → `diff` → `impact` → `check` → `drift` → verdict.
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
  verdict on the unchecked files. State this in the review summary.
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
