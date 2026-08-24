# `archkeep delta`

Classify how boundary violations moved between a captured baseline and the
current tree: `introduced` | `resolved` | `unchanged` | `unknown`, both sides
judged under the current law.

```shell
archkeep delta --capture --output delta-base.json   # at the base commit
archkeep delta delta-base.json                      # at head
archkeep delta delta-base.json --format json
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
  Capture is descriptive: exit 0 on success, 3 on any failure, never 1.
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

| code | meaning                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------- |
| 0    | Capture succeeded, or the comparison found no non-waived introduced violation and nothing unclassifiable.                 |
| 1    | Compare mode only: at least one introduced violation not covered by an active waiver. Capture mode never exits 1.         |
| 2    | Usage error: wrong positional count, `--capture` with a positional, unknown flag.                                         |
| 3    | A refusal from the list above, or a comparison with an `unknown` entry — an unanswerable question is never a clean delta. |

The `--format json` envelope for compare mode is documented in
[json-output.md](../reference/json-output.md).

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
