# `lattice context`

Show the architecture constraints that apply to a project.

```shell
lattice context billing-core
lattice context billing-core --format json
lattice context billing-core --format json --output context.json
```

`context` takes a project name and shows the architecture constraints that
govern it: the project's tags, which `depConstraints` rows match those tags,
and what each row allows or bans. It is descriptive: it never exits 1, because
a description of what the rules say is never a finding (only `check` ever
exits 1).

## Why this command exists

A developer opening a project for the first time — or an AI agent given a task
that touches one — needs to know what the boundary rules allow before writing
an import that violates them. Running `check` after the fact is a lint cycle;
`context` is the architecture answer before the first line is written. It is
the same constraint table `check` judges from, rendered as a readable summary
rather than as a list of violations.

## What the report contains

- **Coverage** — whether the result is complete, same shape as every other
  command's header. The claim sits above the listing so the reader knows whether
  the context is complete before reading any entry.
- **Project name** — the project whose context is shown.
- **Tags** — the project's own tags, or "none" when the project has no tags.
  A project with no tags and a renderer that printed nothing would be
  indistinguishable, so the word "none" is an explicit claim.
- **Constraint rows** — each `depConstraints` row whose `sourceTag` or
  `allSourceTags` matches the project's tags, rendered the same way a
  violation's constraint line is rendered in `check` output. When a constraint
  row carries `description` or `remediation`, those appear indented below it.
- **No matching constraints** — when the project's tags match no `depConstraints`
  row, the report states so explicitly: the `check` command would flag the
  project as `projectWithoutTagsCannotHaveDependencies`, so a reader seeing
  "(no matching constraint rows)" knows the project is unconstrained rather
  than the command having failed to look.

## Flags

| flag       | argument       | default                  | meaning                                                                     |
| ---------- | -------------- | ------------------------ | --------------------------------------------------------------------------- |
| `--format` | `text`\|`json` | `text`                   | Terminal report (default) or the versioned JSON envelope.                   |
| `--output` | `<file>`       | stdout                   | Write the report to a file instead of stdout.                               |
| `--config` | `<file>`       | (from workspace options) | Read the boundary law from here instead of the workspace's configured file. |

The project name is a single positional argument. `--config` is accepted
because the answer depends on which boundary law is in effect — a different
constraint table produces a different set of matching rows.

## Exit codes

| code | meaning                                                                             |
| ---- | ----------------------------------------------------------------------------------- |
| 0    | The context was produced, and coverage is complete.                                 |
| 2    | Usage error: wrong argument count, unknown flag, or project not found in the graph. |
| 3    | Coverage is incomplete, or the unregistered-plugin refusal fired.                   |

`context` never exits 1. That exit code belongs to `check` alone.

## The unregistered-plugin refusal

Same as `graph`, `diff`, `impact`, and `explain`: on an Nx workspace whose
`nx.json` does not register the Nx integration but whose tracked files include
polyglot manifests under project roots, `context` refuses loudly rather than
explaining constraints from a graph whose edges silently under-represent the
real architecture.

## What `context` does not do

`context` shows the constraint table as it applies to one project's tags. It
does not check import sites — that is `check`'s job. A project whose context
shows "only `[layer:domain]`" may still have violations from imports written
before that constraint was added, and a project with no matching constraints is
not necessarily clean — `check` would flag it as
`projectWithoutTagsCannotHaveDependencies` if it has any imports at all.
