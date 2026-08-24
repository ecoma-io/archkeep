# Health

The `health` command: deterministic architecture-health metrics and trends for
the current workspace. The _meaning_ of each metric is owned by
[concepts/health.md](../concepts/health.md); this page is the command surface.

## What it runs

```bash
archkeep health                       # current run's metrics
archkeep health .archkeep/history      # metrics + trends across snapshots
archkeep health --format json         # the versioned envelope
```

The optional positional argument names the snapshot directory for trends — the
same directory `history` reads (`.archkeep/history/` by convention). With no
argument, health reports the current run's metrics without a trend.

## Flags

| flag       | argument       | default                  | meaning                                                         |
| ---------- | -------------- | ------------------------ | --------------------------------------------------------------- |
| `--format` | `text`\|`json` | `text`                   | Terminal report or the versioned JSON envelope.                 |
| `--output` | `<file>`       | stdout                   | Write the report to a file instead of stdout.                   |
| `--config` | `<file>`       | (from workspace options) | Read the boundary law from here instead of the configured file. |

## The report

Each metric renders as a verdict word (`ok`, `findings`, `not_applicable`,
`unknown`) and, exactly when the metric _measured_ something, the number behind
it. A `not_applicable` or `unknown` metric carries no number — a number over no
evidence would read as a measured zero. Both state what they could not measure,
so nothing reads as a silent gap.

The metric order is fixed, so the text report is stable across runs:

```text
✔ health over complete coverage (3 imports in 4 files across 2 projects)
  ok            projects  2
  ok            edges  1
  ok            coverage  0
  ok            violations  0
  ok            waiver surface  0
  ok            cycles  0
  ok            edge density  0.5
  ok            debt rows  0
  ok            intent fitness  0
```

A partial run reports loudly:

```text
✖ health over incomplete coverage — 1 file could not be analyzed, so the
  metrics that needed them read unknown (3 imports in 4 files across 2 projects)
  unknown       violations  (the boundary could not be fully inspected)
```

## The status contract

Health is descriptive — it never exits 1. It returns:

- **exit 0** when every metric reached a verdict (`ok`, `findings`, or
  `not_applicable`),
- **exit 3** when any metric is `unknown` — a run that could not fully inspect
  its own evidence is not a healthy run, and `no-verdict` is the exit code
  every descriptive command uses for that,
- **exit 2** on a usage error (more than one positional argument).

The JSON envelope carries the same status and exit code mapping, with the
metrics under `result.metrics` and the trends under `result.trends`.

## Trends

Given a snapshot directory, health reports the structural metrics (projects,
edges, coverage) across the same snapshots `history` reads, with the disclosure
that rule-impact cannot be re-derived from stored bytes — a snapshot carries
the graph and the policy fingerprint, not the constraint table or the import
sites. Run `check` at any commit for those.

## Determinism

Two runs over an unchanged tree produce byte-identical output, in text and in
JSON. The metrics are re-derived from the run's own records every time;
nothing here reads the clock, the locale, or the environment.
