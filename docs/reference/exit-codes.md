# Exit codes

Every `lattice` command exits one of four codes. The distinction between 0 and 3
is the one the tool's design turns on.

## The codes

| code | meaning                                                                                                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | **Clean.** No findings, and every selected file was analyzed.                                                                                                                    |
| `1`  | **Findings.** Boundary violations, go.work drift, or dead tsconfig path aliases. `check` is the only command that can produce this exit code — every other verb only ever reads. |
| `2`  | **Usage error.** Unknown command, unknown flag, missing argument, path outside the tree. Nothing ran; fix the arguments and try again.                                           |
| `3`  | **No verdict.** The run could not start, or a selected file could not be analyzed at all.                                                                                        |

## Per-command detail

### `check`

| code | when                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Zero violations, zero go.work drift, zero dead tsconfig aliases, and zero whole-file failures.                                                          |
| `1`  | At least one violation, go.work drift finding, or dead tsconfig path alias.                                                                             |
| `2`  | Unknown flag, missing flag value, path outside the workspace, or `--format` value not in the valid set.                                                 |
| `3`  | No workspace root found, both markers present, malformed config, `nx graph` or `git` failed, or any file the run selected could not be analyzed at all. |

A file with no analyzer, an unreadable file, a `tsconfig` that will not load —
each leaves a file the summary counted but no rule ever judged, and that is
enough to withhold the verdict. An import site whose specifier is not statically
knowable (a dynamic `import()` with a non-literal argument) is NOT exit 3: the
file was judged, one position in it has no answer, and the report lists it under
a separate heading.

### `graph`, `diff`, `impact`, `explain`

These commands are descriptive: they never exit 1, because a description is
never a finding.

| code | when                                                                  |
| ---- | --------------------------------------------------------------------- |
| `0`  | The answer was produced with complete coverage.                       |
| `2`  | Unknown flag, missing argument, wrong number of positional arguments. |
| `3`  | The workspace could not be read, or coverage was incomplete.          |

## Why 3 must not collapse into 0

A checker that could not look must never be mistaken for one that looked and
found nothing. That single sentence is the reason this tool's exit codes exist
at all:

- Exit 0 reads as "checked, and clean." A CI step, a shell script, or a
  developer scanning a log sees `0` and moves on.
- Exit 3 reads as "could not check." The same observer sees `3` and stops.

Collapsing 3 into 0 converts every coverage loss — a malformed config, a
failed `git` call, an unreadable file — into a green build. The boundary
everyone believes is enforced has not run, and nobody can tell.

This applies to partial failures too. A run that analyzed 97 of 100 files exits
3, not 0 — those three unanalyzed files are a coverage hole, and a "clean"
verdict over a partial run is precisely the false green the tool exists to
prevent.

## Shell scripting pitfalls

`set -e` treats every non-zero code alike, which is fine — the failure is
visible. What is not fine is suppressing the exit code:

```shell
# Wrong: turns "could not look" into "looked and found nothing"
lattice check || true
```

If you need to distinguish, distinguish explicitly:

```shell
lattice check
case $? in
  0) echo "clean" ;;
  1) echo "boundary violations, go.work drift, or dead tsconfig aliases"; exit 1 ;;
  3) echo "the checker could not reach a verdict"; exit 1 ;;
  *) echo "usage error"; exit 1 ;;
esac
```

Both 1 and 3 must fail the build. They differ in what you go and look at, not
in whether you go and look.

## The JSON envelope and exit 3

A run can exit 3 having never reached the point of building a JSON envelope at
all — no workspace root, both markers present, a malformed boundary config, the
`nx graph` or `git` call itself failing. That class prints an error to stderr
and writes nothing to stdout; under `--output`, it writes no file, and whatever
was already at that path (a previous run's envelope) is left exactly as it was.

A consumer must branch on the process exit code first, not on `status` alone:
`status: "no-verdict"` is found inside an envelope this run did manage to build,
while exit 3 with no parseable JSON, or a stale `--output` file, is the same
"could not look" verdict arriving with no envelope to read at all. See
[json-output.md](json-output.md) for the full envelope reference.

## See also

- [cli.md](cli.md) — command syntax and flags
- [json-output.md](json-output.md) — the versioned JSON envelope, including `status` and `exitCode` fields
- [configuration.md](configuration.md) — `lattice.json` reference
