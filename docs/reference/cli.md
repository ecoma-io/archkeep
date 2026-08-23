# CLI

All commands, all flags, all exit codes in one page. Source: `packages/lattice/cli.mjs`.

## Commands

| command      | positional args      | summary                                                                                            | finds violations |
| ------------ | -------------------- | -------------------------------------------------------------------------------------------------- | ---------------- |
| `check`      | `[<path>...]`        | Check imports against the boundary rules                                                           | yes -- exits 1   |
| `graph`      | (none)               | Print the project graph as a deterministic snapshot                                                | no               |
| `diff`       | `<baseline>`         | Compare two graph snapshots edge by edge                                                           | no               |
| `drift`      | (none)               | Compare the observed architecture to the declared intent                                           | no               |
| `discover`   | (none)               | Report observed facts, and optionally propose candidates                                           | no               |
| `reconcile`  | (none)               | Score the declared intent against the observed architecture, with proposed edits under `--propose` | no               |
| `fitness`    | (none)               | Judge every declared fitness function against the workspace; exits 1 on a failing function         | no*              |
| `waivers`    | (none)               | List the boundary waivers and permanent suppressions on the table                                  | no               |
| `history`    | `<dir>`              | Describe how the architecture evolved across snapshots                                             | no               |
| `health`     | `[<snapshot-dir>]`   | Describe architecture health metrics and trends                                                    | no               |
| `report`     | `[<snapshot-dir>]`   | One governance document: how healthy the architecture is, and why                                  | no               |
| `debt`       | `<dir>`              | Print the architecture-debt ledger across snapshots                                                | no               |
| `impact`     | `<project>`          | List projects that depend on the named project                                                     | no               |
| `explain`    | `<file:line:column>` | Explain the judgment for one import site                                                           | no               |
| `context`    | `<project>`          | Show the architecture constraints that apply to a project                                          | no               |
| `provenance` | (none)               | Describe where this run's facts came from and which rows carry an origin                           | no               |
| `adr`        | `[<id>]`             | List recorded architecture decisions and what each binds                                           | no               |

\* `fitness` reports no boundary violation, but it is a verdict command, not a
descriptive one: a declared function that `fail`s makes it exit 1 (and an
undetermined one, 3) — see the prose below.

`lattice --help` prints the help text and exits 0. An omitted command name is a
usage error (exit 2). If the first positional argument names a path that exists
on disk, it is treated as `check` scoped to that path, the same as `lattice check <path>`.

## Flags

Every `--config`/`boundaryConfig` below reads the same way: a file path,
unless the workspace names a `profiles` registry, in which case it is a
profile NAME instead — `check`'s own row states the mechanism once;
[profiles.md](../concepts/profiles.md) is the full model. This applies to
every command below that takes a `--config` flag, not only `check`.

### `check`

| flag             | argument                | default                  | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ----------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--format`       | `text`\|`sarif`\|`json` | `text`                   | Terminal report (default), SARIF 2.1.0 for GitHub code scanning, or the versioned JSON envelope.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--output`       | `<file>`                | stdout                   | Write the report to a file instead of stdout.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--config`       | `<file>`                | (from workspace options) | Read the boundary law from here instead of the workspace's configured file — which, when the workspace names a `profiles` registry, is a profile NAME selected from that registry, not a path.                                                                                                                                                                                                                                                                                                              |
| `--evidence-out` | `<dir>`                 | (nothing written)        | Also write each declared custom rule's evidence bundle into this existing directory, as `<rule>.json` — the exact document that rule was judged over. It changes no verdict and no exit code, and it writes the bundle even for a rule that trapped or ran out of budget, which is when it is needed. Three ways it writes nothing — no `customRules` declared, a path-scoped run, and a declared law that could not be loaded — and the first two say so on stderr rather than leaving an empty directory. |

Naming paths scopes the run to those files. A scoped run is a fast local
pre-check, not the gate: the cycle and lazy-load rules judge the file graph as
a whole, so a scoped run can miss what a whole-workspace run would find — and
declared fitness functions that need the whole tree, like every declared
custom rule ([custom-rules.md](custom-rules.md)), answer `not_applicable`
there rather than judging partial evidence.

A policy that declares `fitness` or `customRules` gets both judged on every
unscoped `check`, by presence — there is no flag to forget, and their
verdicts ride the same exit lanes as the boundary rules
([exit-codes.md](exit-codes.md)).

### `graph`

| flag       | argument       | default | meaning                                         |
| ---------- | -------------- | ------- | ----------------------------------------------- |
| `--format` | `text`\|`json` | `text`  | Terminal report or the versioned JSON envelope. |
| `--output` | `<file>`       | stdout  | Write the report to a file instead of stdout.   |

No positional arguments. Takes no `--config` flag -- `graph` describes the
project graph, not the boundary law.

### `diff`

| flag       | argument       | default                  | meaning                                                                                                                                           |
| ---------- | -------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--format` | `text`\|`json` | `text`                   | Terminal report or the versioned JSON envelope.                                                                                                   |
| `--output` | `<file>`       | stdout                   | Write the report to a file instead of stdout.                                                                                                     |
| `--config` | `<file>`       | (from workspace options) | Read the boundary law from here instead of the workspace's configured file. Rule-impact analysis appears whenever a boundary config is available. |

The baseline file is a positional argument (a file, not a git ref). Both sides
must be complete; an incomplete baseline or current workspace exits 3 and
produces no diff. When a boundary config is available, the report includes a
rule-impact section showing boundary violations introduced or resolved by the
diff.

### `drift`

| flag       | argument       | default | meaning                                         |
| ---------- | -------------- | ------- | ----------------------------------------------- |
| `--format` | `text`\|`json` | `text`  | Terminal report or the versioned JSON envelope. |
| `--output` | `<file>`       | stdout  | Write the report to a file instead of stdout.   |

No positional arguments. Drift is descriptive — it never exits 1, only 0 on a
completed comparison and 3 when coverage is incomplete or the intent cannot be
verified. The intended side is the tracked `architecture-intent.json` at the
workspace root; load it, describe the findings, print the intent fingerprint,
and let `check` do the failing. A boundary or row side that matched no observed
project so the comparison cannot be completed exits 3 with a loud message —
"cannot verify" must never read as "no drift".

### `health`

| flag       | argument       | default                  | meaning                                                                     |
| ---------- | -------------- | ------------------------ | --------------------------------------------------------------------------- |
| `--format` | `text`\|`json` | `text`                   | Terminal report or the versioned JSON envelope.                             |
| `--output` | `<file>`       | stdout                   | Write the report to a file instead of stdout.                               |
| `--config` | `<file>`       | (from workspace options) | Read the boundary law from here instead of the workspace's configured file. |

The optional positional argument names the snapshot directory for trends (the
same `.lattice/history/` directory `history` reads); with no argument, health
reports the current run's metrics without a trend. Health is descriptive — it
never exits 1 — and it exits 3 whenever any metric reads `unknown`: a run that
could not fully inspect its own evidence is not a healthy run, and "cannot
look" must never read as "clean".

### `report`

| flag       | argument       | default                  | meaning                                                                     |
| ---------- | -------------- | ------------------------ | --------------------------------------------------------------------------- |
| `--format` | `text`\|`json` | `text`                   | Terminal report or the versioned JSON envelope.                             |
| `--output` | `<file>`       | stdout                   | Write the report to a file instead of stdout.                               |
| `--config` | `<file>`       | (from workspace options) | Read the boundary law from here instead of the workspace's configured file. |

The optional positional argument is `health`'s — the snapshot directory for
trends. The `--config` this command resolves governs every section of the
document, which is what keeps the page citing one law rather than several.

### `fitness`

| flag       | argument       | default                  | meaning                                                                     |
| ---------- | -------------- | ------------------------ | --------------------------------------------------------------------------- |
| `--format` | `text`\|`json` | `text`                   | Terminal report or the versioned JSON envelope.                             |
| `--output` | `<file>`       | stdout                   | Write the report to a file instead of stdout.                               |
| `--config` | `<file>`       | (from workspace options) | Read the boundary law from here instead of the workspace's configured file. |

No positional arguments. Fitness is a verdict, not a print job (D-09): it
exits 1 on a failing function and 3 on an undetermined one — the same two
lanes `check` uses — and 0 only on a completed judgment with nothing failed or
undetermined. It exits 3 when coverage is incomplete or the policy declares no
`fitness` at all. Each declared function is judged against the observed
workspace and printed as a verdict row; `check` folds the same verdicts in by
presence.

### `discover`

| flag        | argument       | default | meaning                                                                                                                        |
| ----------- | -------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `--format`  | `text`\|`json` | `text`  | Terminal report or the versioned JSON envelope.                                                                                |
| `--output`  | `<file>`       | stdout  | Write the report to a file instead of stdout.                                                                                  |
| `--propose` | (none)         | off     | Compute and print the candidate architecture — components, boundary assertions, tag vocabulary, rules — over the observations. |

No positional arguments. `discover` is descriptive: it never exits 1, only 0 on
a completed observation and 3 when coverage is incomplete, the model cannot be
loaded, or the plugin gap refuses the graph. Under `--propose`, incomplete
coverage is a refusal — a proposal over an unread tree would be a fabrication
wearing a proposal's name. Every candidate carries the markers `proposed: true`
and `notAuthoritative: true` and is never written to `architecture-intent.json`.

### `reconcile`

| flag        | argument       | default | meaning                                                                                                            |
| ----------- | -------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `--format`  | `text`\|`json` | `text`  | Terminal report or the versioned JSON envelope.                                                                    |
| `--output`  | `<file>`       | stdout  | Write the report to a file instead of stdout.                                                                      |
| `--propose` | (none)         | off     | Emit a ranked candidate list of model edits, each marked proposed — never written into `architecture-intent.json`. |

No positional arguments. Reconcile is descriptive — it never exits 1, only 0 on
a completed comparison and 3 when coverage is incomplete or the intent cannot be
verified. It never writes into `architecture-intent.json`; `--propose` adds the
ranked candidate list (add, removal, tag-change, boundary-change) marked
`proposed: true` / `notAuthoritative: true`. The intended side is the tracked
`architecture-intent.json` at the workspace root. A boundary or row side that
matched no observed project so the comparison cannot be completed exits 3 with a
loud message — "cannot verify" must never read as "no divergence". See
[reconciliation.md](reconciliation.md) and
[usage/reconcile.md](../usage/reconcile.md).

### `impact`

| flag       | argument       | default                  | meaning                                                                                                                                         |
| ---------- | -------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `--format` | `text`\|`json` | `text`                   | Terminal report or the versioned JSON envelope.                                                                                                 |
| `--output` | `<file>`       | stdout                   | Write the report to a file instead of stdout.                                                                                                   |
| `--config` | `<file>`       | (from workspace options) | Read the boundary law from here instead of the workspace's configured file. Constraint context appears whenever a boundary config is available. |

The project name is a single positional argument. An empty `dependents` list is
a claim ("nothing depends on this"), not a shrug. When a boundary config is
available, the report includes a constraint-context section showing which
constraint rows govern each dependent's edge and whether it violates them.

### `explain`

| flag       | argument       | default                  | meaning                                                                     |
| ---------- | -------------- | ------------------------ | --------------------------------------------------------------------------- |
| `--format` | `text`\|`json` | `text`                   | Terminal report or the versioned JSON envelope.                             |
| `--output` | `<file>`       | stdout                   | Write the report to a file instead of stdout.                               |
| `--config` | `<file>`       | (from workspace options) | Read the boundary law from here instead of the workspace's configured file. |

The site argument is a single `file:line:column` string, 1-based. `--config`
is accepted because the judgment depends on which boundary law is in effect. A
site whose target is not statically knowable (dynamic `import()` with a
non-literal argument) gets an `UNRESOLVABLE` verdict with the reason.

### `context`

| flag       | argument       | default                  | meaning                                                                                                                             |
| ---------- | -------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `--format` | `text`\|`json` | `text`                   | Terminal report or the versioned JSON envelope.                                                                                     |
| `--output` | `<file>`       | stdout                   | Write the report to a file instead of stdout.                                                                                       |
| `--config` | `<file>`       | (from workspace options) | Read the boundary law from here instead of the workspace's configured file.                                                         |
| `--plan`   | `[<path>...]`  | off                      | Planning mode: the positionals after the project name are intended file paths, judged before any edit exists — see the prose below. |

The project name is a single positional argument. `--config` is accepted because
the answer depends on which boundary law is in effect — a different constraint
table produces a different set of matching rows.

### `waivers`

| flag       | argument       | default                  | meaning                                                                                                                     |
| ---------- | -------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `--format` | `text`\|`json` | `text`                   | Terminal report or the versioned JSON envelope.                                                                             |
| `--output` | `<file>`       | stdout                   | Write the report to a file instead of stdout.                                                                               |
| `--config` | `<file>`       | (from workspace options) | Read the boundary law from here instead of the workspace's configured file. The surface listed is the one this law carries. |

No positional arguments. Lists every `boundarySuppressions` row carrying an
`expiresAt` — a waiver — with its term and the current violations it covers, and
every row with no `expiresAt` — a permanent suppression — with the violations it
is currently hiding. Coverage is judged against the full finding set with the
suppression table removed, so a row that covers nothing reads as stale. A tree
whose only violations are permanently suppressed does not read as "no
waivers — every boundary is enforced": this command names the suppression and
what it hides instead. Descriptive: it exits 0 whenever the surface could be
read, never 1.

### `history`

| flag        | argument       | default                  | meaning                                                                                                                                                                                         |
| ----------- | -------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--format`  | `text`\|`json` | `text`                   | Terminal report or the versioned JSON envelope.                                                                                                                                                 |
| `--output`  | `<file>`       | stdout                   | Write the report to a file instead of stdout.                                                                                                                                                   |
| `--capture` | (none)         | off                      | Append a snapshot of the current workspace to the directory first, then describe the history that includes it.                                                                                  |
| `--config`  | `<file>`       | (from workspace options) | Read the boundary law from here instead of the workspace's configured file. Under `--capture`, the captured snapshot records the fingerprint of this law as the architectural intent in effect. |

The directory is a single positional argument. It is a directory of `graph
--format json` snapshots, not a git ref or an index file — the directory itself
is the sole source of truth (see `docs/usage/history.md`). `--capture` writes
`<sequence>-<sha8>.json` (zero-padded monotonic sequence plus the architecture
identity's first eight hex chars, so filename byte-sort IS history order) and
deduplicates when the current architecture identity already is the last
snapshot and the provider has not changed — a pure provider migration surfaces
as a transition rather than being swallowed by the identity match. An empty
directory, an unreadable snapshot, or a malformed snapshot is a no-verdict run
(exit 3), never a record of nothing.

### `debt`

| flag       | argument       | default                  | meaning                                                                     |
| ---------- | -------------- | ------------------------ | --------------------------------------------------------------------------- |
| `--format` | `text`\|`json` | `text`                   | Terminal report or the versioned JSON envelope.                             |
| `--output` | `<file>`       | stdout                   | Write the report to a file instead of stdout.                               |
| `--config` | `<file>`       | (from workspace options) | Read the boundary law from here instead of the workspace's configured file. |

The directory is a single positional argument — the same consumer-managed
history directory `history` reads, so the ledger ages across the same snapshots
the evolution record is built from. The ledger is a report, never a gate: it
lists the workspace's waivers (accepted violations), aspirational gaps
(`optional` intent rows not yet built), and drift findings, each ranked by
severity, aged across the snapshots (see `docs/reference/debt.md` for the four
entry kinds, the age model, and what `agings: false` means). An unresolved
intent, incomplete coverage, or an unreadable/malformed history directory is a
no-verdict run (exit 3), never an empty ledger — an entry that cannot be read
or verified must never read as "no debt".

- Both `--flag value` and `--flag=value` work.
- An unknown flag is a usage error (exit 2) rather than treated as a path.
  A typo like `--fromat sarif` would otherwise select no files and report a
  clean tree.
- `--format` changes no exit code and no byte of the other formats. It is an
  additional rendering of the same verdict.
- `--output` writes atomically (write to `.tmp`, then rename) so a reader
  never sees a truncated file. A write failure is exit 3. For `history`,
  pointing `--output` at a file inside the history directory is a usage error
  (exit 2) — the report would be read back as a snapshot on the next run.
- `--config` does not move the workspace root. The tree being judged is still
  the consumer's.

## Exit codes

| code | meaning                                                                                                                                                         | when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | clean -- and every selected file was analyzed                                                                                                                   | No findings and no coverage gaps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 1    | findings -- boundary violations, declared-edge violations, go.work drift, dead tsconfig path aliases, intent findings, or a failing fitness gate or custom rule | `check` and `fitness`. A failing fitness function is a finding (D-09), and so is a custom rule's `fail`; every other command that finds something reports it but exits 0.                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2    | usage error                                                                                                                                                     | Unknown command, unknown flag, missing argument, path outside the tree, wrong positional count.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 3    | no verdict -- the run could not start, a selected file could not be read, or the law itself could not be established                                            | No workspace, malformed config, `moon project-graph`/`nx graph`/`git` failed, unreadable file, file with no analyzer, `tsconfig` that will not load, a tracked `architecture-intent.json` that will not parse or whose boundaries match no project, a declared custom rule whose artifact will not load or that answered `unknown` ([custom-rules.md](custom-rules.md)), or -- in a profile-selected workspace, on any command that reads a boundary law -- a profile that could not be resolved: an unknown profile name, an unknown `base`, a `base` cycle, or an unreadable registry. |

**Do not collapse 3 into 0.** A checker that could not look must never be
mistaken for one that looked and found nothing. Both 1 and 3 must fail a CI
build; they differ in what you go and look at, not in whether you go and look.

`check` also covers partial failures: an unreadable file, a file with no
analyzer, or a `tsconfig` that will not load each leaves a file the summary
counts but no rule ever judged, and that is enough to withhold the verdict.

A descriptive command (`graph`, `diff`, `drift`, `discover`, `reconcile`,
`waivers`, `history`, `health`, `report`, `debt`, `impact`, `explain`,
`context`, `provenance`, `adr`) exits 0 when it completes, 3 when coverage is
incomplete or a metric is `unknown`, and 2 on usage error. None exits 1,
because a descriptive result is never a finding. `fitness` is the exception —
it is a verdict, so a failing function exits 1 (the `check` lane) and an
undetermined one exits 3.

## What each command does

### `check [<path>...]`

Reads the project graph, analyzes every tracked source file a project owns,
judges the import sites against the workspace's boundary law, and exits 1 if
anything violates it. When the workspace has a tracked `go.work`, also compares
its `use` list against every project's `go.mod`. When the workspace tsconfig
declares a `paths` table, also judges each alias for life. Both are workspace-
level checks that ignore path scoping.

### `graph`

Prints the project graph as a deterministic snapshot: two sorted arrays, one of
projects and one of edges, with `workspaceLayout` included. Descriptive -- a
snapshot of what is is never a finding.

**It answers in a workspace that has no boundary law yet**, which is where the
question it exists for is usually asked: the first thing to establish about a
new workspace is what Lattice sees, and that is what the first policy gets
written against. The snapshot then carries no `policy` field -- no law, no
policy identity for [`diff`](#diff-baseline) to compare against. A boundary
config that IS there and will not load still fails the run with exit 3, because
an absent law and a broken one must not report alike.

### `discover`

Reports the observed architecture: projects, edges, tags, and the coverage a
verdict over this tree could trust. With `--propose`, it also derives the
candidate architecture those observations imply — components, boundary
assertions, tag vocabulary and rules — each marked `proposed: true` and
`notAuthoritative: true`, and never written to `architecture-intent.json`.
Descriptive -- an observation, or a candidate, is never a finding.

### `diff <baseline>`

Compares a `graph --format json` snapshot file with the current workspace,
reporting projects and edges added or removed. When a boundary config is
available, also reports which violations the added edges introduce and which
the removed edges resolve. The baseline is a file, not a git ref. Both sides
must be complete. Descriptive -- changes do not make it exit 1.

### `waivers`

Lists every `boundarySuppressions` row carrying an `expiresAt` — a waiver —
with its term and the current violations it covers. Coverage is judged against
the full finding set (the table removed), so a row that covers nothing is
flagged as stale rather than silently doing nothing. A waiver that has lapsed
is listed as expired with its remaining time; it covers nothing and the
violation it accepted re-asserts.

It also lists every row with no `expiresAt` — a permanent suppression — and how
many violations each is currently hiding: that removal never appears in
`check`'s findings at all, so this is the only command that names it.
`result.suppressions` carries the rows, `result.suppressed` the count of
distinct violations they hide, and the text report never collapses "no
waivers" into "every boundary is enforced" while a permanent suppression is
covering something this run measured. A `waivers` run is descriptive and never
modifies the table — waivers and suppressions are both removed only by an
explicit edit, never by the tool. Descriptive.

### `history <dir>`

Reads every `graph --format json` snapshot in a directory and describes how the
architecture evolved across them: each snapshot in history order (filename
byte-sort) and each transition between consecutive snapshots, classified by the
signals the snapshots actually carry. A changed graph is an architecture
change; a changed `policy.fingerprint` is a policy/intent change; a changed
`workspace.provider` is a provider change; provenance (git commit) advancing
while neither architecture nor policy changed is disclosed as code drift. What
a snapshot does not carry is disclosed, never asserted. `--capture` appends a
snapshot of the current workspace before describing the record.
Descriptive -- evolution never makes it exit 1.

### `health [<snapshot-dir>]`

Reports deterministic architecture-health metrics for the current workspace:
project and edge counts, the coverage ratio, boundary violations and the waiver
surface, cycle count, edge density, debt rows from the config's own notes, and
the intent (fitness) verdict. Each metric carries a verdict in the canonical
vocabulary — `ok`, `findings`, `not_applicable` (nothing to measure) or
`unknown` (evidence could not be fully inspected), and a metric that did not
measure carries no number. Given a snapshot directory, the same structural
metrics are reported across the snapshots `history` reads, with the disclosure
that rule-impact cannot be re-derived from stored bytes. Descriptive — a
description of health is never itself a finding.

### `report [<snapshot-dir>]`

One governance document: the health metrics, the waiver and permanent-suppression
table, the declared fitness gates, the recorded decisions each governed row
cites, and the run's provenance — composed from the same functions `health`,
`waivers`, `fitness`, `adr` and `provenance` call, so no section can disagree
with the command that owns it. One boundary law, resolved once, governs the
whole page. Each governed row carrying a `decisionRef` is linked to the record
it cites and that record's status; a citation resolving to nothing reads
`unknown`, never a pass. Descriptive: it never exits 1 — a live violation or a
failing gate is printed over exit 0 — and it exits 3 when any surface could not
be established, with the closing `could not inspect` block naming every one.
See [../usage/report.md](../usage/report.md) for the full report shapes.

### `debt <dir>`

Reads the same history directory `history` reads and builds the
architecture-debt ledger: every waiver the boundary config accepts, every
`optional` intent row not yet built, and every drift finding the intent judge
reports — each aged across the snapshots by the owning project and ranked by
severity. A drift finding in a project that also carries an accepted waiver is
ranked HIGH and the waiver is still listed; the ledger must never hide a
waiver that is failing today. Descriptive -- debt never makes it exit 1.

### `reconcile`

Scores the declared intended model against the observed architecture element by
element — projects, edges, tags, boundaries, and every intent row in file order
— and reports the divergence plane by plane. `--propose` adds the ranked
candidate list of model edits (add, removal, tag-change, boundary-change), each
carrying its evidence and an explicit `proposed` / `notAuthoritative` marker;
the list is a suggestion, never an applied change, and the intent file stays
byte-identical after every run. Descriptive.

### `impact <project>`

Lists every project that transitively depends on the named project. Separates
direct from transitive dependents. When a boundary config is available, also
shows which constraint rows govern each dependent's edge and whether it
violates them. Descriptive.

### `explain <file:line:column>`

Explains the judgment for one import site: which constraint row matched, which
tags applied, whether it is a violation and why. Constraint rows that carry
`description` or `remediation` show those fields. A site whose target is not
statically knowable gets an `UNRESOLVABLE` verdict with the reason.
Descriptive.

### `context <project>`

Shows the architecture constraints that apply to a project: its tags, which
`depConstraints` rows match those tags, and what each row allows or bans.
Constraint rows that carry `description` or `remediation` show those fields.
Useful before editing a project — the same constraint table `check` judges
from, rendered as a readable summary rather than as a list of violations.
Descriptive.

### `fitness`

Judges every declared fitness function against the observed workspace: one line
per function `✔ / ✖ / ⚠ / ◌`, then an overall posture, all deterministic and
clock-free. A verdict, not a print job — it exits 1 for any `fail`, 3 for any
`unknown` (D-09). `check` folds the same per-function verdicts into its exit
code — 1 for any `fail`, 3 for any `unknown`, never a new code.

### `context <project> --plan [<path>...]`

Requests the **agent architecture planning context**: the deterministic facts
a coding agent needs before planning a change to `project`. Trailing paths
scope the change (which project roots or files it touches); with no paths, the
whole workspace is in scope.

The planning context is facts, not a plan. Lattice reports the current
architecture snapshot, the applicable policy with the author's Intent
(`description`/`remediation`), the canonical `architecture-intent.json`
verdict (the same model `check` and `drift` judge — findings, no-verdict, or
ok; absent when the workspace declares no intent), the impact of a change to
the target project (dependents capped at 10 with an explicit overflow note),
the current violations (the full-workspace rule-engine verdict, scoped for
reporting), drift (go.work and tsconfig-path aliases, `null` when no manifest
exists to read), coverage with the exact files that could not be analyzed, and
the deterministic commands that verify the change afterwards. It never
generates an LLM plan, decides an implementation strategy, or modifies source
code — an agent reasons over these facts.

`--plan` is strictly additive: it changes no exit code and no byte of the
plain `context` text output. In JSON the plan's fields sit under `result.plan`
alongside the unchanged `result.project/tags/constraints/dependencies`
(the four plain `context` fields keep their existing shape — see
`json-output.md`), and `result.plan.variant` is `"plan"` so a consumer can tell
the two apart. The rule verdict is computed over the whole analyzeable tree (so
whole-graph rules such as circular-dependency and lazy-load are correct on
every provider); on Nx and Moon workspaces this is a second analysis pass,
which costs more than a plain `context` run. The JSON output is deterministic:
two runs over an unchanged tree produce byte-identical bytes.
Descriptive.

### `provenance`

| flag       | argument       | default | meaning                                         |
| ---------- | -------------- | ------- | ----------------------------------------------- |
| `--format` | `text`\|`json` | `text`  | Terminal report or the versioned JSON envelope. |
| `--output` | `<file>`       | stdout  | Write the report to a file instead of stdout.   |

No positional arguments. `provenance` takes no `--config` flag — it reads the
workspace's own declared files.

`provenance` answers two questions:

- **Repository provenance** — the git commit, remote, and dirty state of the
  tree this run judged, the same `workspace.provenance` block the JSON envelope
  already carries for `graph`/`diff`/`drift`/`history`, made a first-class
  report.
- **Decision provenance** — for every governance row in the workspace's
  declared intent (`architecture-intent.json`) and boundary config (the
  `depConstraints` table), whether the row carries an `origin` block. A row
  without one is flagged `no origin recorded — cannot attest`, because a row
  whose decision nobody recorded is indistinguishable from a rule that
  appeared by editing the file directly.

Descriptive. `provenance` never changes a verdict and never exits 1 — its
finding is about documentation, not about the architecture. It exits 0 when it
completes, 3 when a declared file is malformed (a row list built from a file it
could not read would be a claim about rows that do not exist), and 2 on usage
error.

### `adr [<id>]`

| flag       | argument       | default | meaning                                         |
| ---------- | -------------- | ------- | ----------------------------------------------- |
| `--format` | `text`\|`json` | `text`  | Terminal report or the versioned JSON envelope. |
| `--output` | `<file>`       | stdout  | Write the report to a file instead of stdout.   |

With no argument, dumps the whole ADR registry — every recorded architecture
decision, its status, its supersession chain, and which rule/fitness ids it
binds. With one argument, answers that id: a `rule:…`/`fitness:…` id is the
reverse lookup naming which ADRs bind it, and everything else is read as an
ADR reference — bare `NNN-slug`, or `adr:`-prefixed, the alternate spelling
`decisionRef` docs recommend — showing the record when it resolves. `adr`
takes no `--config` — a description of what is recorded needs no boundary law.

Descriptive, never a gate: `adr` never exits 1. Exit 0 (a) when every requested
ADR reference resolves to a record, or (b) when the request was a reverse
lookup — `rule:`/`fitness:` ids answer with a sentence naming which ADRs bind
that id, or `no ADR binds it`; that sentence is exit 0, never a gate verdict.
Exit 3 when an ADR reference resolves to nothing — an unknown id, a wrong
case, a truncation, a path-traversal shape, or any other spelling that is not
a `rule:…`/`fitness:…` reference — or the registry could not be read (a
`decisionRef` that does not resolve is `unknown`, never clean), and 2 on usage
error. See [adr.md](adr.md) for the report shapes and the concept in
[concepts/adr.md](../concepts/adr.md).
