# `archkeep diff`

Compare two graph snapshots edge by edge.

```shell
archkeep diff baseline.json
archkeep diff baseline.json --format json
archkeep diff baseline.json --format json --output delta.json
```

`diff` takes a baseline snapshot **file** (not a Git ref) and compares it with
the current workspace. It reports projects and edges added or removed between the
two.

## What diff checks

- **Added projects** — present in the current workspace but absent from the
  baseline.
- **Removed projects** — present in the baseline but absent from the current
  workspace.
- **Added edges** — present in the current workspace but absent from the
  baseline.
- **Removed edges** — present in the baseline but absent from the current
  workspace.

Edge identity is the full `(source, target, type)` triple. A `static` edge
becoming `dynamic` is reported as one removed edge (the old type) and one added
edge (the new type) — a real architectural event, not an implementation detail.

## The baseline must be a complete snapshot

`diff` refuses an incomplete baseline or an incomplete current workspace. If
either side could not fully read its tree, every "added" or "removed" entry
would be ambiguous between a real change and a coverage gap — reporting the diff
anyway would manufacture architectural changes out of a broken run.

Exit 3, with that sentence in the error message.

The baseline file must be a `archkeep graph --format json` envelope whose
`schemaVersion` matches the tool's current version and whose `coverage.complete`
is `true`. An envelope from a later major version may have a different shape
this diff would silently misread.

## Exit codes

| code | meaning                                                                                     |
| ---- | ------------------------------------------------------------------------------------------- |
| 0    | The comparison completed.                                                                   |
| 2    | Usage error: wrong argument count, unknown flag.                                            |
| 3    | The baseline is incomplete or unreadable, or the current workspace has incomplete coverage. |

`diff` never exits 1. Changes are not findings.

## The unregistered-plugin refusal

Same as `graph`: on an Nx workspace whose `nx.json` does not register the Nx
integration but whose tracked files include polyglot manifests under project roots,
`diff` refuses loudly rather than computing a diff against a head whose edges
silently under-represent the real architecture.

## Rule-impact analysis

When a boundary config is available (via `--config` or the workspace's own
declaration), `diff` also computes which boundary violations the added edges
introduce and which the removed edges resolve — the **rule impact** of the
structural diff.

This is narrower than `check`: it judges only `depConstraints` (tag-based rules
such as `onlyDependOnLibsWithTags` and `notDependOnLibsWithTags`), not npm bans,
circular dependencies, or lazy-load rules that need import-site details. A
consumer who needs the complete verdict should run `check`.

The rule-impact section appears whenever a boundary config is available — the
workspace's own or one named by `--config`. Only a workspace with no
boundaryConfig at all omits it, reporting structural changes only.

### Flags for rule-impact

| flag       | argument | default                  | meaning                                                              |
| ---------- | -------- | ------------------------ | -------------------------------------------------------------------- |
| `--config` | `<file>` | (from workspace options) | Read the boundary law from here instead of the workspace's own file. |

When a boundary config is available, the rule-impact section appears after the
structural changes. Without one, `diff` reports only added and removed projects
and edges.

### What the rule-impact section contains

- **Introduced violations** — edges the diff added that violate a
  `depConstraints` row. Each shows the source → target, the `messageId`, and
  the constraint tag that the edge violates.
- **Resolved violations** — edges the diff removed that were previously
  violating. Same shape.
- **No boundary-rule impact** — when the config was provided but no violations
  changed, the report says so explicitly rather than being silent.

## Why there is no `--since`

`diff` takes a snapshot file, not a Git ref. A `--since` flag would mean
building a second graph at another commit; on the Nx provider that requires
running the consumer's own `nx` inside a detached worktree with their
`node_modules` state at that commit — a second source of truth for what the tool
is allowed to spawn, and a capability the native provider would have to grow
separately. A captured snapshot avoids both: the baseline is a fact one `graph`
run already computed, not a graph this command has to guess how to build.

The workflow is the one CI already uses with artifacts:

```shell
git checkout main && archkeep graph --format json --output baseline.json
git checkout my-branch && archkeep diff baseline.json
```
