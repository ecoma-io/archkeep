# CLI reference

## `lattice check`

Check every tracked source file against the workspace's boundary law. The only
command that exits 1 on findings.

```shell
lattice check [<path>...]
```

| flag       | argument              | meaning                                                                                                                            |
| ---------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `--format` | `text`/`sarif`/`json` | Terminal report (default), SARIF 2.1.0 for GitHub code scanning, or the versioned JSON envelope ([json-output.md](json-output.md)) |
| `--output` | `<file>`              | Write the report to a file instead of stdout. Written atomically via a `.tmp` rename.                                              |
| `--config` | `<file>`              | Read the boundary law from here instead of the workspace's own `boundaryConfig`. Does not move the workspace root.                 |

Naming paths scopes the run to those files. A scoped run is a fast local
pre-check and **not the gate**: the cycle and lazy-load rules judge the file
graph as a whole, so a scoped run can miss what a whole-workspace run would
find.

When the workspace has a tracked `go.work` at its root, `check` also compares
its `use` list against the graph's go.mod projects — drift fails the run the
way a violation does. This comparison ignores path scoping.

When the workspace tsconfig declares a `paths` table, `check` also judges each
alias for life — an alias whose every target points into directories that do
not exist fails the run the way a violation does. This comparison ignores path
scoping too.

## `lattice graph`

Print the project graph as a deterministic snapshot: projects (with `targets`
and `tags`) and dependencies, each as a flat sorted array. Descriptive: never
exits 1.

```shell
lattice graph
```

| flag       | argument      | meaning                                                  |
| ---------- | ------------- | -------------------------------------------------------- |
| `--format` | `text`/`json` | Terminal report (default) or the versioned JSON envelope |
| `--output` | `<file>`      | Write the report to a file instead of stdout             |

## `lattice diff`

Compare two graph snapshots edge by edge. Takes a baseline file (the output of
`graph --format json`), not a git ref. Descriptive: never exits 1.

```shell
lattice diff <baseline.json>
```

| flag       | argument      | meaning                                                  |
| ---------- | ------------- | -------------------------------------------------------- |
| `--format` | `text`/`json` | Terminal report (default) or the versioned JSON envelope |
| `--output` | `<file>`      | Write the report to a file instead of stdout             |

Both sides must be complete. An incomplete baseline or current workspace exits 3
and produces no diff, because an apparent added or removed edge would then be
ambiguous between a real change and a coverage gap.

## `lattice impact`

List every project that transitively depends on the named project. Descriptive:
never exits 1.

```shell
lattice impact <project>
```

| flag       | argument      | meaning                                                  |
| ---------- | ------------- | -------------------------------------------------------- |
| `--format` | `text`/`json` | Terminal report (default) or the versioned JSON envelope |
| `--output` | `<file>`      | Write the report to a file instead of stdout             |

The project name must exist in the graph. An unknown project name is a usage
error (exit 2).

## `lattice explain`

Explain the judgment for one import site. Takes a `file:line:column` string
(1-based line and column). Descriptive: never exits 1.

```shell
lattice explain <file:line:column>
```

| flag       | argument      | meaning                                                                                                                                               |
| ---------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--format` | `text`/`json` | Terminal report (default) or the versioned JSON envelope                                                                                              |
| `--output` | `<file>`      | Write the report to a file instead of stdout                                                                                                          |
| `--config` | `<file>`      | Read the boundary law from here instead of the workspace's own `boundaryConfig`. Same as `check` — the judgment depends on which rules are in effect. |

## Shared flag behavior

Both `--flag value` and `--flag=value` work.

An unknown flag is a **usage error** (exit 2), never treated as a path. A typo
like `--fromat sarif` would otherwise be read as two paths, select no files,
and report a clean tree.

`--output` writes the report to a sibling `.tmp` file first, then renames it
onto the target — a rename within one directory is atomic, so a reader sees
either the previous complete file or the new complete one, never a truncated
report.

`--config` does not move the workspace root. The tree being judged is always
the one the root marker (`nx.json` or `lattice.json`) declares.

## Exit codes

| code | meaning                                                                    | which commands |
| ---- | -------------------------------------------------------------------------- | -------------- |
| `0`  | clean — and every selected file was analyzed                               | all            |
| `1`  | findings — boundary violations, go.work drift, or dead tsconfig aliases    | `check` only   |
| `2`  | usage error — unknown command, unknown flag, missing argument              | all            |
| `3`  | no verdict — the run could not start, or a selected file could not be read | all            |

See [exit-codes.md](exit-codes.md) for the full reference on what each code
means and why 3 must never be collapsed into 0.

## See also

- [exit-codes.md](exit-codes.md) — exit code reference
- [json-output.md](json-output.md) — the versioned JSON envelope
- [violations.md](violations.md) — the fifteen violation types
- [configuration.md](configuration.md) — `lattice.json` reference
- [policy-schema.md](policy-schema.md) — boundary policy file reference
