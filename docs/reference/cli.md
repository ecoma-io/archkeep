# CLI

All commands, all flags, all exit codes in one page. Source: `packages/lattice/cli.mjs`.

## Commands

| command   | positional args      | summary                                                   | finds violations |
| --------- | -------------------- | --------------------------------------------------------- | ---------------- |
| `check`   | `[<path>...]`        | Check imports against the boundary rules                  | yes -- exits 1   |
| `graph`   | (none)               | Print the project graph as a deterministic snapshot       | no               |
| `diff`    | `<baseline>`         | Compare two graph snapshots edge by edge                  | no               |
| `drift`   | (none)               | Compare the observed architecture to the declared intent  | no               |
| `history` | `<dir>`              | Describe how the architecture evolved across snapshots    | no               |
| `impact`  | `<project>`          | List projects that depend on the named project            | no               |
| `explain` | `<file:line:column>` | Explain the judgment for one import site                  | no               |
| `context` | `<project>`          | Show the architecture constraints that apply to a project | no               |

`lattice --help` prints the help text and exits 0. An omitted command name is a
usage error (exit 2). If the first positional argument names a path that exists
on disk, it is treated as `check` scoped to that path, the same as `lattice check <path>`.

## Flags

### `check`

| flag       | argument                | default                  | meaning                                                                                          |
| ---------- | ----------------------- | ------------------------ | ------------------------------------------------------------------------------------------------ |
| `--format` | `text`\|`sarif`\|`json` | `text`                   | Terminal report (default), SARIF 2.1.0 for GitHub code scanning, or the versioned JSON envelope. |
| `--output` | `<file>`                | stdout                   | Write the report to a file instead of stdout.                                                    |
| `--config` | `<file>`                | (from workspace options) | Read the boundary law from here instead of the workspace's configured file.                      |

Naming paths scopes the run to those files. A scoped run is a fast local
pre-check, not the gate: the cycle and lazy-load rules judge the file graph as
a whole, so a scoped run can miss what a whole-workspace run would find.

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

| flag       | argument       | default                  | meaning                                                                     |
| ---------- | -------------- | ------------------------ | --------------------------------------------------------------------------- |
| `--format` | `text`\|`json` | `text`                   | Terminal report or the versioned JSON envelope.                             |
| `--output` | `<file>`       | stdout                   | Write the report to a file instead of stdout.                               |
| `--config` | `<file>`       | (from workspace options) | Read the boundary law from here instead of the workspace's configured file. |

The project name is a single positional argument. `--config` is accepted because
the answer depends on which boundary law is in effect — a different constraint
table produces a different set of matching rows.

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

| code | meaning                                                                       | when                                                                                                                                                 |
| ---- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | clean -- and every selected file was analyzed                                 | No findings and no coverage gaps.                                                                                                                    |
| 1    | findings -- boundary violations, go.work drift, or dead tsconfig path aliases | `check` only. No other command exits 1.                                                                                                              |
| 2    | usage error                                                                   | Unknown command, unknown flag, missing argument, path outside the tree, wrong positional count.                                                      |
| 3    | no verdict -- the run could not start, or a selected file could not be read   | No workspace, malformed config, `moon project-graph`/`nx graph`/`git` failed, unreadable file, file with no analyzer, `tsconfig` that will not load. |

**Do not collapse 3 into 0.** A checker that could not look must never be
mistaken for one that looked and found nothing. Both 1 and 3 must fail a CI
build; they differ in what you go and look at, not in whether you go and look.

`check` also covers partial failures: an unreadable file, a file with no
analyzer, or a `tsconfig` that will not load each leaves a file the summary
counts but no rule ever judged, and that is enough to withhold the verdict.

A descriptive command (`graph`, `diff`, `history`, `impact`, `explain`,
`context`) exits 0 when it completes, 3 when coverage is incomplete, and 2 on
usage error. None exits 1, because a descriptive result is never a finding.

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

### `diff <baseline>`

Compares a `graph --format json` snapshot file with the current workspace,
reporting projects and edges added or removed. When a boundary config is
available, also reports which violations the added edges introduce and which
the removed edges resolve. The baseline is a file, not a git ref. Both sides
must be complete. Descriptive -- changes do not make it exit 1.

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
