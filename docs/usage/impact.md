# `lattice impact`

List every project that depends on the named project.

```shell
lattice impact billing-core
lattice impact billing-core --format json
lattice impact billing-core --format json --output impact.json
```

`impact` takes a project name and lists every project that transitively depends
on it — the set a developer needs to consider before changing that project. It
is descriptive: it never exits 1, because a description of what depends on a
project is never a finding.

## What the report contains

- **Direct dependents** — projects whose edges point straight at the target.
- **Transitive dependents** — projects that reach the target only through
  another project.
- **All dependents** — the union of both, which is what the listing shows.

An empty `dependents` list is a claim — "nothing depends on this project" — not
a shrug. The summary line carries direct and transitive counts so an empty
result is distinguishable from a missing one.

Results are sorted by plain string comparison (never `localeCompare`), so two
runs over an unchanged tree produce byte-identical output.

## Coverage and completeness

The coverage claim sits above the listing, not below it, so the reader knows
whether the result is complete before reading any entry. An incomplete impact
set printed in full would have the "this may under-represent" warning buried at
the bottom.

`impact` refuses incomplete coverage. If the graph has whole-file analysis
failures, every dependent it reports would be ambiguous between a real absence
and a gap the failure created — reporting the impact set anyway would silently
under-represent the real architecture.

Exit 3, with that sentence in the error message.

## Constraint context

When a boundary config is available (via `--config` or the workspace's own
declaration), `impact` also shows the **constraint context** for each dependent:
which `depConstraints` rows govern that dependent's edge to the target project,
and whether the edge currently violates them.

This is narrower than `check`: it judges only `depConstraints` (tag-based rules
such as `onlyDependOnLibsWithTags` and `notDependOnLibsWithTags`), not npm bans,
circular dependencies, or lazy-load rules that need import-site details. A
consumer who needs the complete verdict should run `check`.

The constraint-context section appears whenever a boundary config is available —
the workspace's own or one named by `--config`. Only a workspace with no
boundaryConfig at all omits it, reporting dependents only.

### Flags for constraint context

| flag       | argument | default                  | meaning                                                              |
| ---------- | -------- | ------------------------ | -------------------------------------------------------------------- |
| `--config` | `<file>` | (from workspace options) | Read the boundary law from here instead of the workspace's own file. |

When a boundary config is available, a "Constraint context" section follows the
dependent listing. Without one, `impact` reports only the dependent list.

### What the constraint-context section contains

Each dependent is shown with a ✔ or ✖ marker:

- **✔** — the edge to the target does not violate any matching constraint row.
- **✖** — the edge violates at least one constraint row. The violation's
  source → target and `messageId` are listed.

Below each dependent, the matching constraint rows are listed: the tag that
governs the edge, and what it allows or bans (`only [...]` / `not [...]`). When
a constraint row carries `description` or `remediation`, those appear indented
below it. A dependent with no matching constraint rows is noted explicitly —
the project is unconstrained, not the command having failed to look.

## Exit codes

| code | meaning                                                                             |
| ---- | ----------------------------------------------------------------------------------- |
| 0    | The impact set was computed, and coverage is complete.                              |
| 2    | Usage error: wrong argument count, unknown flag, or project not found in the graph. |
| 3    | The graph has incomplete coverage, or the unregistered-plugin refusal fired.        |

`impact` never exits 1. That exit code belongs to `check` alone.

## The unregistered-plugin refusal

Same as `graph` and `diff`: on an Nx workspace whose `nx.json` does not
register the Nx integration but whose tracked files include polyglot manifests under
project roots, `impact` refuses loudly rather than returning an impact set whose
dependents silently under-represent the real architecture.
