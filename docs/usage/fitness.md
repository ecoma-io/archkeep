# `lattice fitness`

Judge every declared fitness function against the observed workspace.

```shell
lattice fitness
lattice fitness --format json
lattice fitness --format json --output fitness.json
```

`fitness` takes no positional arguments — the observed side is the whole project
graph plus the workspace analysis, and the declared side is the `fitness` export
of the workspace's boundary policy. It prints a verdict table: one line per
function (`✔ pass`, `✖ fail`, `⚠ unknown`, `◌ not_applicable`) naming the function and
the evidence that decided it, then an overall posture line.

## What is judged

Each declared function is evaluated against the same observed facts `check`
reads — the project graph, the workspace analysis, the architecture intent, and
the boundary suppressions. The condition types, the verdict contract, and the
declaration shape live in [fitness-functions.md](../concepts/fitness-functions.md).

## Fail-closed

A declared function that cannot be determined yields `unknown` — never `pass` —
and `fitness` (like every read-only command) refuses loudly where coverage is
incomplete: whole files the analyzer could not read make every graph and
coverage claim ambiguous between "clean" and "never seen", so the command exits 3
instead of printing a table built on a hole.

## Exit codes

| code | meaning                                                                           |
| ---- | --------------------------------------------------------------------------------- |
| 0    | The judgment completed and every function passed.                                 |
| 1    | A declared function `fail`ed — a failing fitness function is a finding.           |
| 2    | Usage error: positional arguments given, unknown flag.                            |
| 3    | Coverage incomplete, any function `unknown`, or the policy declares no `fitness`. |

`fitness` exits 1 when a declared function `fail`s — a failing fitness function
is a finding, not a print job — and 3 when any function is `unknown`, or when
coverage is incomplete or the policy declares no `fitness`. `check` folds
fitness in by presence the same way: a workspace whose policy declares fitness
counts the same verdicts into the same exit codes. 1 is the findings exit code
and 3 is the no-verdict exit code.

## Example

```text
✔ no-domain-yet          1 edge carries "layer:service" → "layer:domain" as required
✔ full-coverage          221/221 files analyzed (100%), meets the 100% minimum
✔ fitness: 2 functions passed
```
