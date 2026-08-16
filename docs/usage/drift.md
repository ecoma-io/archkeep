# `lattice drift`

Compare the observed architecture to the workspace's declared intended one.

```shell
lattice drift
lattice drift --format json
lattice drift --format json --output drift.json
```

`drift` takes no positional arguments — the observed side is the whole project
graph, and the intended side is the tracked `architecture-intent.json` at the
workspace root. It prints the intent fingerprint, the observed projects and
edges, and every intent row the observed architecture violates.

## The intended side

`drift` requires a tracked `architecture-intent.json`. The schema, the sections,
and the judgment rules live in
[architecture-intent.md](../reference/architecture-intent.md). Every finding
names the intent row and the observed fact that violates it.

## The observed side

The same project graph the other commands read, from any provider (Nx, Moon, or
a native `lattice.json` workspace). Edges whose target is not a project in the
model are dropped — an external package is not a project an intent row can name —
and `implicit` edges (build-ordering declarations, not code dependencies) are
excluded and counted, so the report states exactly what was compared.

## Fail-closed

`drift` refuses loudly on every path that cannot reach a verdict, all exit-3
class:

- the intent file cannot be read or parsed;
- the observed side has incomplete coverage (whole files the analyzer could not
  read) — every "project missing" would then be ambiguous between "gone" and
  "never seen";
- an Nx workspace has polyglot manifests but the plugin is not registered;
- a boundary or row side matched no observed project — the intent for that row
  cannot be verified against the graph.

An empty finding list must mean exactly "the observed architecture matches the
intended one". When a comparison cannot be completed, `drift` exits 3 with a
loud message rather than print "✔ no drift".

## Exit codes

| code | meaning                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------- |
| 0    | The comparison completed (whether or not it found drift).                                            |
| 2    | Usage error: positional arguments given, unknown flag.                                               |
| 3    | Coverage incomplete, intent unreadable, or the intent cannot be verified against the observed graph. |

`drift` never exits 1 — describing drift is not a finding. `check` exits 1 on
intent findings, and it folds drift in by presence: when an intent file exists,
`check` counts the same findings. There is no `--drift` flag — an opt-in flag
would make a forgotten flag byte-identical to "no drift checked".

## Example

```text
intent    7768377ec47cb96206c55451864d5776ba01a330cc9d4536b559480f1f009e5d — 5 rows
observed  2 projects, 0 edges
✔ no drift — the observed architecture matches the intended one (2 projects and 0 edges)
```
