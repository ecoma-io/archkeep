---
name: arch-review
description: Review a change or PR for architecture governance — establish context, inspect the change, run the authoritative gate, and produce an evidence-backed review
compatibility: Requires @ecoma-io/archkeep CLI
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
archkeep context <project> --format json
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
archkeep context <project> --plan path/to/file.go
```

### 2. Inspect the change

Read the diff and decide whether it is an **architecture change** — a move the
next step must treat as such — or an ordinary source change. Architecture
changes include: project boundaries touched, dependency direction reversed, a
project created or removed, ownership boundaries moved, the policy changed, the
profile registry changed (a profile's `block`, its `base` chain, or the default
profile a `boundaryConfig` selects), the declared Intent changed, or the
provider migrated. When a reviewed rule carries a `decisionRef`, cite the
decision it leans on — `archkeep adr rule:<id>` names the record that binds it,
and its status and rationale are review evidence. A change that satisfies the
rule table but contradicts the recorded decision is a finding, not a pass.
If the change is none of those, the review is: context → check → verdict, and
you can skip the heavy steps.

### 3. Determine whether the architecture changed

If a baseline graph snapshot exists (from a prior
`archkeep graph --format json --output baseline.json` run), compare the current
graph against it:

```
archkeep diff baseline.json --format json
```

This shows added and removed edges, project changes, and — when a boundary
config is available — rule-impact analysis for each changed edge. A diff with
`--format json` provides the same data structured for programmatic use. If no
baseline exists, this step is skipped and the review says so; a lack of a
baseline is a coverage gap, not "no structural change".

When a delta evidence baseline exists (captured at the base commit with
`archkeep delta --capture --output delta-base.json`), it answers "what did
this change introduce" directly, as the review's evidence:

```
archkeep delta delta-base.json --format json
```

Every violation is classified introduced / resolved / unchanged / unknown,
both sides re-judged under the current law. Exit 1 — an introduced violation
no active waiver covers — blocks the same way `check`'s exit 1 does (step 5).
An **introduced-but-waived** entry does not gate, but it is a finding the
review surfaces by name: the change introduced a violation an existing waiver
happens to accept, and the reviewer decides whether that acceptance was meant
to cover new code. Exit 3 — a refusal or an unclassifiable item — is a
coverage gap the review states, never "no change". A renamed project reads as
one loud introduced + resolved pair by design; the review, not the tool,
decides whether that pair is a move.

### 4. Evaluate impact

For each changed project, see who depends on it:

```
archkeep impact <project> --format json
```

An empty `dependents` list is a claim ("nothing depends on this"), not a shrug.
A non-empty list shows the blast radius: which other projects would be affected
by a change to this one.

### 5. Run the authoritative check

Full workspace — the form a review's verdict may rest on:

```
archkeep check --format json
```

Scoped to just the files the change touched, when speed matters more than
completeness:

```
archkeep check --format json path/to/file.go path/to/other.rs
```

This is the gate — boundary violations **and** the declared Intent, in one run,
against the law in effect (the profile `boundaryConfig`/`--config` selects in a
profile-selected workspace). Exit 1 names findings the change introduced or
resolved; exit 3 means the gate could not reach a verdict on part of the
workspace — including a profile that could not be resolved — and the review
must say so instead of reporting "no findings". **Exit 1 or exit 3 blocks: the
review must not approve the change, or call it mergeable, while either
stands.** This is a hard rule, not a caveat satisfied by disclosure — naming a
finding or a coverage gap in the review is not the same as clearing it.

**A scoped run must be disclosed as scoped, and disclosure alone does not earn
approval.** Cycle and lazy-load rules judge the whole file graph, so a scoped
run's silence about them is not evidence they pass (`arch-check`, "Empty
output from a scoped check does NOT mean the workspace is safe."). Approve on
a scoped run only when the review states the specific, concrete reason the
scoping does not matter for this change; absent one, re-run unscoped before
writing the verdict.

When the change is itself a profile under review, judge it without touching
the live law:

```
archkeep check --config <candidate-profile>
```

That run resolves a different law than the one in effect — it is a review of
the candidate, never a verification of the change, and the review must label
it as such and name the `--config <NAME>` it ran with (see step 11).

### 6. Evaluate drift when Intent or architecture differs

When the change is architectural or Intent-adjacent, confirm the observed graph
still agrees with the declared architecture:

```
archkeep drift --format json
```

Exit 3 — the intent comparison cannot be verified — is NOT "clean". An
unverifiable intent must never be read as a satisfied one. Drift findings
(`intentAllowedMissing`, `intentForbiddenEdge`, …) are the evidence a review
cites when it says "the declared architecture no longer matches the code".

### 7. Select supporting evidence as the change warrants

- **The whole governance picture at once** — `archkeep report` composes the
  surfaces below into one document: provenance, the health metrics, the waiver
  and fitness tables, and the recorded decisions each governed row cites. Every
  number comes from the same function the owning command calls, and one law is
  resolved once for the whole page, so two sections can never cite two different
  laws. Reach for it when the review needs the governance picture; reach for the
  individual commands below when it needs one surface.

  Read its exit code the way you read `drift`'s. `report` never exits 1 — a live
  boundary violation and a failing fitness gate are both printed, by name, over
  exit 0 — so exit 0 means "the document was established", never "the
  architecture is clean". Exit 3 means at least one surface could not be
  established, and the closing `could not inspect` block names every one with
  its reason. An unresolved `decisionRef` is exit 3 here, stricter than the gate:
  `check` resolves the same citations but fails the build on the intent half
  only, while this document's whole subject is on whose authority each governed
  row stands.

- **Health / quality claim** — `archkeep health` reports per-metric verdicts
  (a metric whose evidence is unavailable is `unknown`/`not_applicable`, never
  zero); `archkeep fitness`(when the policy declares a `fitness` export) judges
  the workspace's named quality gates with `pass` / `fail` / `unknown` /
  `not_applicable` verdicts. `fitness` is descriptive too, but a declared
  function that `fail`s makes it exit 1 — a failing fitness function is a
  finding, not a print job. `check` stays the gate.
- **The workspace's own rules** — when the policy declares `customRules`, every
  declared rule is judged on each unscoped `check`, by presence. These are laws
  the workspace wrote and this engine did not, so review them as law rather
  than as output: a finding arrives namespaced `custom/<rule>/<finding>` and its
  meaning is the rule's message plus the `reason` its policy row is required to
  carry, never an id in the violation catalogue. Three review consequences.
  First, **a rule that answered `unknown` is a gate that did not run** — exit 3,
  the cause named — and reporting it as "no custom findings" is exactly the
  silent direction. Second, a change to a rule's `.wasm` or its pinned `sha256`
  is a change to the law itself, reviewed like a constraint row and not like a
  binary blob: the digest is what makes "the law CI ran is the law review saw"
  checkable at all, so a bumped hash needs the same argument any policy edit
  does. Third, an `unknown` is debuggable rather than merely reportable:
  `archkeep check --evidence-out <dir>` writes each declared rule's evidence
  bundle into an existing directory — the exact document that rule was judged
  over, written even for a rule that trapped — and it changes no verdict and no
  exit code, so asking for it costs the review nothing
  ([docs/usage/custom-rules.md](https://github.com/ecoma-io/archkeep/blob/main/docs/usage/custom-rules.md)). Ask for it
  before accepting "the rule could not run" as where the review stops.
- **Pre-existing violations ("debt")** — `archkeep debt <dir>` ages waivers, gaps
  and drift across a snapshots directory: how long a violation has been
  accepted or unknown. It is a ledger, not a live gate — it never changes a
  verdict. For "did THIS change introduce the violation", compare the current
  `check` output against the baseline diff; disclose, they are not caused by
  this change.
- **Waivers / exceptions** — a suppression (no `expiresAt`) is permanent, and
  a waiver (with `expiresAt`) accepts a violation for a fixed term. Both live
  in `boundarySuppressions`; `archkeep waivers` names every row — a waiver with
  its term, a permanent suppression with what it is hiding (the one surface
  `check`'s green cannot distinguish), and `check` keeps reporting a waived
  violation as a finding (exit 1) so CI still catches the day the term lapses.
  `coverage.exempt` in `archkeep.json` is the one coverage-count suppression
  surface, and it requires a mandatory reason.
  A waiver never promotes `unknown` → `pass`.
- **Provenance** — each `graph` snapshot carries its git origin;
  `history` classifies transitions (architecture / policy / provider / code
  drift) by the evidence snapshots carry; `archkeep provenance` reports where
  this run's own facts came from — the commit and remote behind them — and how
  many governance rows carry an `origin` against how many do not, naming the
  unattested ones and resolving the `decisionRef` citations among them. A row
  with no `origin` is unattested, not invalid: it is the review's evidence that
  nobody recorded where that rule came from. Provenance is a property of
  snapshots — a command reports it, it does not pluralize it.
- **ADR / decision references** — when a reviewed constraint, intent, or
  fitness row carries a `decisionRef` (`decisionRef` is a governance block key
  a fitness row accepts, alongside `name`/`match`/`condition`/`reason`), verify
  the decision it leans on
  (`archkeep adr rule:no-direct-dep` finds the binding ADR; `archkeep adr
0001-bind-collaboration` confirms the record's status and its bindings — the
  decision's rationale and context live in the record file, `docs/adr/NNN-slug.md`,
  so open it and read the prose before judging the rule against it). A resolved
  decision is review evidence: the rule is enforced because a recorded decision
  made it so. An ADR id the registry does not know exits 3 — the record is
  missing, and the rule's governance grounding is `unknown`; the review must
  say so, never read it as bound. The reverse lookup inverts that: `archkeep
adr rule:orphan` names a rule no ADR binds and exits 0 with a sentence —
  verify the rule row's exact spelling against the registry before reading it
  as "not governed". The rationale matters: a rule that contradicts the
  decision it cites, or a superseded record, is a finding the review should
  name.

### 8. Inspect history when the change follows architectural evolution

If the repository keeps snapshots, `archkeep history <dir>` names which of the
recent transitions were architectural and which were policy or provider — useful
when the change is the latest move in an evolution the review should connect.
Snapshots do not appear on their own — they come from `--capture` runs the
repository decided to make (`arch-context`, step 7). A review reports that no
history exists rather than capturing one as a side effect of reviewing: the
capture writes a file, and it would record the law as the change left it.

### 9. Explain non-obvious findings

For any violation where the reason matters:

```
archkeep explain <file:line:column>
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
disagreement element by element, `archkeep reconcile --propose` scores every
observed project and edge against the declared model and derives the edits that
would make them agree; `archkeep discover --propose` derives candidate
architecture from what is observed. Both mark their output as proposals — and
the one command that writes one into the workspace is `archkeep discover
--propose --write-intent <file>`, which writes only the file the operator
names and refuses to overwrite. No command writes an ADR, and proposed is
never authoritative. When the model is not merely stale but
absent — the workspace declares no Intent at all — the review's finding is that
the repository is ungoverned, and the work of establishing a model is
`arch-migrate`'s, not a rewrite performed inside the review.

### 11. Produce the review

Report, each half with evidence:

- **Architecture state**: whether the change is architectural; the projects and
  edges it added or removed (`diff`); the Intent comparison (`drift`);
  dependents affected (`impact`).
- **Gate verdict**: the `check` exit code, the `--config <NAME>` (or
  `boundaryConfig` value) the gate resolved, every finding with its
  `file:line:column`, the coverage gaps that withheld a verdict, and whether
  the change introduced, resolved, or is silent about each. Exit 1 or exit 3
  blocks (step 5) — do not report the change as mergeable while either stands.
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
  reference (`archkeep adr <ref>`, whichever shape the row's `decisionRef`
  holds — an ADR id `NNN-slug` reads the record, a `rule:`/`fitness:` id is the
  reverse lookup) → `check` → verdict. An unresolved reference is `unknown`,
  never valid evidence; say so.
- **Is the architecture model itself stale** (declared differs from observed)?
  → report the finding, `drift` for the full direction, `reconcile --propose`
  for the element-by-element shape of the disagreement, and escalate the
  reconcile decision to the team. Never rewrite the Intent silently.

## What to do if it fails

- **`archkeep diff` exit 3** — the baseline or the head is incomplete. The diff
  is unreliable; do not treat it as "no changes". Re-generate the baseline with
  `archkeep graph --format json` and try again.
- **`archkeep impact` returns empty dependents** — that is a claim, not a shrug.
  Nothing in the workspace depends on this project. Verify this is expected.
- **`archkeep check` exit 3** — coverage is incomplete. The review cannot reach a
  verdict on the unchecked files, and this blocks: state it in the review
  summary and do not approve while it stands (step 5) — and in a
  profile-selected workspace check whether the selected profile could be
  resolved before blaming the files: an unknown profile name, an unknown
  `base`, a `base` cycle, or an unreadable registry are all exit 3 with no
  fallback to another law.
- **`archkeep adr` exit 3** — an ADR-pattern id the registry does not know, or a
  registry that could not be read. A `decisionRef` naming a missing record is
  `unknown`, never a pass; the review says the rule's grounding is unverifiable
  rather than citing it as evidence. A reverse lookup that exits 0 with `no ADR
binds rule:X` is a different answer — it names a rule id the registry binds
  nothing — so verify the exact spelling against the rule row before treating
  the rule as ungoverned.
- **`archkeep drift` exit 3** — the Intent cannot be verified. The governance
  status is unknown; the review must say so, not pass on it.
- **`archkeep reconcile --propose` refuses** — `reconcile` exits 3 loudly on
  every path that cannot reach a verdict; it never exits 1 (describing the
  disagreement is not a finding). An unknown classification means the model
  cannot be scored — say so rather than treating it as "no disagreement".
- **Multiple violations, unclear which are new** — when a delta evidence
  baseline exists, `archkeep delta <baseline> --format json` answers this
  directly: each violation is classified introduced, resolved, or unchanged
  (step 3). Otherwise compare the check output
  against the baseline diff. If no baseline of either kind exists, the check
  output shows the
  current state but cannot distinguish new from pre-existing violations; the
  review says which half that is.
