# `archkeep delta`

Classify how boundary violations moved between a captured baseline and the
current tree: `introduced` | `resolved` | `unchanged` | `unknown`, both sides
judged under the current law.

```shell
archkeep delta --capture --output delta-base.json   # at the base commit
archkeep delta delta-base.json                      # at head
archkeep delta delta-base.json --format json
archkeep delta delta-base.json --format sarif    # for GitHub code scanning
```

`delta` answers the question a review actually asks about one change: **which
violations did this change introduce, and which did it resolve** — not "what
does the tree look like now" (`check`) and not "which edges moved"
([diff.md](diff.md)).

## Two modes, one verb

- **Capture** — `archkeep delta --capture` writes an **evidence snapshot** of
  the current tree: the raw import-site records, the project graph they were
  collected against, the coverage facts, the run's git provenance, and the
  policy fingerprint. Evidence, never verdicts — the snapshot stores what a
  future run needs to _re-judge_ the base, not what the base was judged to be.
  With `--output <file>` the snapshot goes to a file; without it, to stdout.
  The bytes are canonical — every object's keys sorted — so two captures over
  one unchanged tree diff clean and a `diff` of two baselines shows evidence,
  never key-order noise; snapshots captured before the keys were sorted stay
  readable, because the compare side reads fields by name. Capture is
  descriptive: exit 0 on success, 3 on any failure, never 1.
- **Compare** — `archkeep delta <baseline>` loads a captured snapshot,
  re-judges **both** sides through the same rule engine under the **current**
  boundary config and one shared reference instant, and classifies every
  violation. This is the gate half: a non-waived introduced violation is a
  finding (exit 1).

Storing evidence rather than verdicts is the design's point: a baseline that
stored "which violations existed at base" would be judged under the law and
the clock of the moment it was captured, so a policy edit or an expiring
waiver between base and head would fabricate an introduced/resolved pair. With
both sides re-judged under one law and one instant, only the code can move a
classification.

## The workflow: a snapshot file, not a git ref

Like `diff` and `history --capture`, `delta` takes a **file** its consumer
captured, and the consumer orchestrates the checkout —
[diff.md's "Why there is no `--since`"](diff.md#why-there-is-no---since) owns
that argument:

```shell
git checkout main && archkeep delta --capture --output delta-base.json
git checkout my-branch && archkeep delta delta-base.json
```

In CI, capture at the merge base (or on every `main` build, as an artifact)
and compare on the branch.

## What a comparison reports

A run over a tree that introduced one violation:

```text
baseline  delta-base.json — 1a2b3c4d, 6 records, 2 projects
head      5e6f7a8b, 7 records, 2 projects
⚠ 1 introduced violation
  kernel → outer  onlyTagsConstraintViolation  (0 at base, 1 at head)
    at libs/kernel/reach.go:4:2
1 introduced violation not waived — compared baseline 1a2b3c4d (6 records) against head 5e6f7a8b (7 records, 7 analyzed files, 2 projects)
```

Sections render only when they have content — introduced, resolved, unchanged,
unknown, and the unresolvable-import block — and the closing line always
states what was compared, so an empty delta is a verifiable claim, never
silence.

## How violations are classified

A violation's identity is **architectural, never textual**: which rule fired
(`messageId`), from which project, against which target, under which
constraint row. Where no project target exists (an external or unresolvable
specifier), the raw specifier stands in as the target, because for
specifier-decided rules the specifier _is_ the architectural fact.
`file:line:column` sites are attached evidence on every entry and are never
part of identity: renaming a file or moving code within one changes sites and
counts, not what the violation is.

Occurrences are counted per side. Per identity:

- absent at base, present at head → **introduced**;
- present at base, absent at head → **resolved**;
- equal counts on both sides → **unchanged**;
- head count **greater** than base → **introduced**, with a reason naming the
  growth — more of a violation that already existed is still new violation,
  and the loud direction wins;
- head count smaller but still above zero → **unchanged**, with an
  `occurrencesReduced` note. The violation still exists; calling a partial fix
  "resolved" would let it read as a clean boundary;
- an item whose identity cannot be stated at all → **unknown**, with the
  reason. An unidentifiable item is never guessed into a bucket — and any
  `unknown` entry withholds the verdict (exit 3).

### Renames are not guessed

There is deliberately no rename matching — not of files, not of projects.
Renaming a project makes its every violation read as one loud
introduced-at-new-name + resolved-at-old-name pair, and a human decides
whether that pair is a move. A guessed match would silently merge two
identities the evidence cannot prove are one, and a wrong guess would be
invisible in the output by construction.

### Waived-introduced: reported, not gating

Classification compares **raw** (pre-suppression) violations, so a
suppressed-then-regressed violation stays visible. Each entry is then
annotated with whether the current `boundarySuppressions` table covers it, at
the one shared instant — an expired waiver covers nothing. An introduced
violation every one of whose sites is covered reads `waived: true`: it is
**reported** in the introduced section (waiving is a tracked acceptance, not a
fix) but it does not fail the gate, which is what a waiver is for.

### Unresolvable imports are their own category

Import sites whose target analysis could not resolve are classified in a
separate block — introduced/resolved/unchanged/unknown by specifier, import
kind, and owning project — and are **never counted as violations**: no rule
reached a verdict about them, so folding them into either side would fabricate
findings. They are carried so a change that adds or removes such sites is
visible.

### Custom-rule findings are classified too

When the current policy declares [`customRules`](../reference/custom-rules.md),
`delta` judges every declared rule over **both** evidence sets — the head
tree's facts and the baseline's stored ones — and classifies its findings in
their own block, keyed per finding by the rule name, the finding id, and the
project it names (`custom/<rule>/<finding>`). The same occurrence ladder
applies: absent-at-base is introduced, growth is introduced with the counts
named, a shrink that leaves occurrences is unchanged, and an **introduced
custom finding gates (exit 1) exactly as an introduced violation does** — with
no waiver lane, by construction: `boundarySuppressions` rows key on a
violation `messageId`, and a custom finding has none.

For this to work the capture side stores two extra blocks when its policy
declares rules — the declared rows (name, artifact, `sha256`, `params`) and
the file→project ownership map. A workspace that declares no custom rules
produces a byte-identical snapshot, envelope, and report.

A rule is judged only when the baseline row pins the **identical law** —
same `sha256`, same `params`. Everything else is fail-closed: the rule lands
in the skipped list, one `unknown` entry per rule (exit 3), each with its
reason:

- **the baseline carries no custom-rule evidence** — an old capture, or one
  whose policy declared no rules; re-capture the baseline;
- **no base-side evidence exists for this rule** — the rule was added since
  capture; re-capture;
- **artifact digest drift**, both digests named — the law itself moved, so a
  finding difference cannot be attributed to the code;
- **params drift** — params ride inside the evidence bundle, so this is law
  drift exactly as a digest change is;
- **either side's evidence could not be assembled** — for example a stored
  record the baseline's ownership map does not claim;
- **either side's evaluation failed, or the rule answered `unknown`** — the
  host's own reason is carried through;
- **the rule answered `not_applicable` on exactly one side** — the reason
  names the side that did not apply: base findings cannot be called resolved
  (nor head findings introduced) by a side the rule did not judge.

A rule that answers `not_applicable` on **both** sides contributes an empty
finding list per side plus a note naming each side's reason — a judged answer,
not a failure; a rule the baseline declares that the head no longer does is
reported as **removed** in a coverage note, never judged. A head artifact that
cannot be **loaded** at all (unreadable, hash mismatch against the head
declaration) is a refusal (exit 3, no report) — the same posture `check` takes
on the same tree.

## Refusals and notes

Every condition under which `delta` cannot honestly classify is a **refusal**
(exit 3, no report) — a delta that could not classify must never read as "no
change":

- a baseline that cannot be read, is not valid JSON, is missing required
  structure, or carries a `schemaVersion` this tool does not write — a future
  version refuses too, because a half-understood format would be classified
  over misread evidence;
- a baseline whose own coverage was incomplete — a violation living in a file
  the base never looked at would be misread as newly introduced at head;
- a **provider mismatch** between the baseline and this run — a refusal where
  `diff` settles for a note, because violation identity computed across two
  different project models is not trustworthy: the same tree attributed to
  different projects would classify a rename as an introduced/resolved pair
  the code does not contain;
- incomplete coverage on the current tree — a delta over a half-analyzed head
  is not a verdict;
- an Nx workspace with polyglot manifests but no registered plugin — the same
  under-representing-graph refusal `graph` and `diff` make.

And what is deliberately **not** a refusal — each becomes a loud note in the
report and in `coverage.notes` instead:

- a **policy fingerprint change** between capture and now — both sides are
  re-judged under the current law, so the mismatch cannot fabricate a
  classification; the note says the classifications reflect the current law
  applied to both sides;
- **dirty** base provenance, and a dirty head tree — weaker evidence, not
  unreadable evidence;
- **one-sided or cross-repository provenance** — the delta cannot verify it
  compares two revisions of the same repository, and says so.

## Exit codes

| code | meaning                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | Capture succeeded, or the comparison found no non-waived introduced violation, no introduced custom finding, and nothing unclassifiable.                     |
| 1    | Compare mode only: at least one introduced violation not covered by an active waiver, or at least one introduced custom finding. Capture mode never exits 1. |
| 2    | Usage error: wrong positional count, `--capture` with a positional, unknown flag.                                                                            |
| 3    | A refusal from the list above, or a comparison with an `unknown` entry — an unanswerable question is never a clean delta.                                    |

The `--format json` envelope for compare mode is documented in
[json-output.md](../reference/json-output.md).

## SARIF for code scanning

`delta <baseline> --format sarif` renders the same verdict as SARIF 2.1.0 for
GitHub's `upload-sarif`, so the violations a pull request **introduces** appear
as inline annotations on its diff. The log's shape follows the same choices
[ci.md's SARIF section](ci.md#sarif-and-github-code-scanning) argues for `check` — same rule
catalogue, workspace-relative percent-encoded URIs, 1-based positions, `error`
level — with the delta-specific decisions on top:

- **Results are the introduced buckets only**, one result per head site.
  Resolved and unchanged entries are not results: the log is uploaded against
  the head checkout, and an annotation for a violation the change resolved
  would mark code that no longer contains it. Each result's `properties` carry
  `delta: "introduced"` and both sides' occurrence counts; an introduced
  **custom-rule finding** is a result too, resolving to its own descriptor at
  the end of the catalogue.
- **A waived-introduced entry is still a result**, tagged
  `properties.accepted: true` (with the waiver's expiry and reason) — reported,
  not gating, the same vocabulary `check`'s SARIF uses for a waived violation.
- **Everything unclassifiable rides `toolExecutionNotifications`**: every
  `unknown` entry (violations, unresolvable sites, custom-rule items), every
  coverage note (policy drift, dirty trees, skipped or removed custom rules),
  and every introduced unresolvable import site. A delta that exits 3 therefore
  never uploads a log a clean run could have produced.

Two steps in CI, in this order — the gate first, the presentation second, for
the reasons [ci.md](ci.md#sarif-and-github-code-scanning) gives:

```yaml
# The gate. Fails the job — exit 1 on introduced findings, exit 3 on "no verdict".
- name: Delta against the merge-base baseline
  run: pnpm exec archkeep delta delta-base.json

# The presentation. Runs even when the gate just failed — the annotations
# matter most on a red run — and its own exit code decides nothing.
- name: Render the delta as SARIF
  if: ${{ !cancelled() }}
  run: pnpm exec archkeep delta delta-base.json --format sarif --output delta.sarif
  continue-on-error: true

- uses: github/codeql-action/upload-sarif@v3
  if: ${{ !cancelled() }}
  with:
    sarif_file: delta.sarif
```

## Known limitations

- **Target executor strings are not preserved.** The snapshot stores each
  project's target _names_, not their executors, so on re-judgment a declared
  target stays a declared target but the executor string itself is the one
  fact the baseline never held.
- **A baseline is trusted input.** It is validated for shape, schema version,
  and coverage completeness, but not authenticated — a hand-edited snapshot
  will be re-judged as if its evidence were real. Keep baselines where CI
  artifacts live, not where review-time edits do.
- **A rename is a loud pair**, by design — see "Renames are not guessed"
  above.
