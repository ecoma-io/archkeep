# Exit codes

Four exit codes, and the critical distinction is 3 against 0. This page covers
the process exit codes and the `--format json` envelope `status` values that
map to them.

## Process exit codes

| code | meaning                                                                                                                   | when                                                                                                                                                                                                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | clean -- and every selected file was analyzed                                                                             | No findings and no coverage gaps.                                                                                                                                                                                                                                                                               |
| 1    | findings -- boundary violations, go.work drift, dead tsconfig path aliases, or architecture-intent findings               | `check` only. No other command can exit 1.                                                                                                                                                                                                                                                                      |
| 2    | usage error                                                                                                               | Unknown command, unknown flag, missing argument, path outside the tree. Never reaches the JSON envelope.                                                                                                                                                                                                        |
| 3    | no verdict -- the run could not start, a selected file could not be read, or architecture intent could not be established | No workspace, both root markers present, malformed config, `nx graph`/`git` failed, unreadable file, no analyzer for a file, `tsconfig` that will not load, a tracked `architecture-intent.json` that will not parse or whose boundaries match no project, or (native provider) a tracked file no project owns. |

## Why 3 exists, and why it covers partial runs

A checker that could not look must never be mistaken for one that looked and
found nothing -- that is the single distinction this tool's design turns on.
Exit 0 was the bug: it meant an unreadable file, a missing analyzer, or a
`tsconfig` that would not load silently vanished from the verdict.

Exit 3 covers both total failures (no workspace root, malformed boundary
config, `nx graph` or `git` itself failing) and **partial** ones. A single
unreadable file, a file with no analyzer, or a `tsconfig` that will not load
each leaves a file the summary counted but no rule ever judged, and that is
enough to withhold the verdict.

An import site whose specifier is not statically knowable (dynamic `import()`
with a non-literal argument) is **not** this case: the file was judged, one
position in it has no answer, and those are printed under a separate heading
as declared blind spots. They do not affect the exit code.

## What a clean run prints

```text
no boundary violations (264 imports in 78 files across 12 projects)
```

The import, file, and project counts are the load-bearing part of a green run.
A sudden drop in those numbers is the shape of a real defect: a `.gitignore`
change that hid a directory, a project that stopped being visible to the graph,
a rename that left files owned by nothing.

## The 3-vs-0 distinction in CI

```shell
# Wrong: turns "could not look" into "looked and found nothing"
lattice check || true
```

Both 1 and 3 must fail the build. They differ in what you go and look at, not
in whether you go and look. If you need to distinguish, distinguish explicitly
-- see [ci.md](../usage/ci.md) for a shell example.

## `--format json` envelope `status`

Three values, each carrying exactly one `exitCode`. The `jsonEnvelope` builder
throws rather than build an envelope where the two disagree, so this table is
enforced in code, not just documented:

| `status`       | `exitCode` | meaning                                                                                                                                                                 |
| -------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"ok"`         | 0          | No findings, and every selected file was analyzed.                                                                                                                      |
| `"findings"`   | 1          | Boundary violations, go.work drift, dead tsconfig path aliases, or architecture-intent findings.                                                                        |
| `"no-verdict"` | 3          | No findings, but the run could not fully read the tree (`coverage.complete` is `false`) or architecture intent could not be established. Never mistake this for `"ok"`. |

`exitCode` in the envelope is never 2: a usage error exits before the envelope
is built.

### The envelope may not exist at all

A run can exit 3 having never built an envelope -- no workspace root, both
markers present, a malformed boundary config, `nx graph` or `git` itself
failing. In that class, nothing is written to stdout, and under `--output` no
file is created: whatever was already at that path is left exactly as it was.

**Branch on the process exit code first, not on `status` alone.** `"no-verdict"`
is a status found inside an envelope this run did manage to build. An exit code
of 3 with no parseable JSON on stdout, or a stale file left under `--output`,
is the same "could not look" verdict arriving with no envelope to read.

### Findings with incomplete coverage

A run with findings **and** an unanalyzed file still reports `"findings"` -- a
violation is a certain verdict regardless of what else the run could not reach.
The unreached files are listed in `coverage.notAnalyzed`. Only a run with no
findings can be downgraded from `"ok"` to `"no-verdict"`.

Architecture intent adds nothing to the ok/findings pair and one new door into
no-verdict: an intent file that will not parse, or an intent boundary matching
no observed project, withholds the verdict (exit 3) even when every import was
clean -- because an unverifiable intent must never read as a satisfied one.

## `coverage` and the exit code

The `--format json` envelope carries a `coverage` object that names what the run
inspected. Its `complete` field is the switch that decides between `status:
"ok"` (exit 0) and `status: "no-verdict"` (exit 3) on a findings-free run.

| field           | type                             | meaning                                                                                                                                                                                                                                                                                                  |
| --------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `complete`      | boolean                          | `true` only when `notAnalyzed` is empty -- enforced, not just correlated.                                                                                                                                                                                                                                |
| `projects`      | number                           | Project count in the graph this run judged against.                                                                                                                                                                                                                                                      |
| `analyzedFiles` | number                           | Files the analyzer produced a verdict for.                                                                                                                                                                                                                                                               |
| `imports`       | number                           | Import sites judged against the boundary law.                                                                                                                                                                                                                                                            |
| `notAnalyzed`   | `{file, reason}[]`               | Whole-file failures: a file the analyzer never reached a verdict about at all (unreadable, no analyzer, a config it depends on that would not load). Non-empty here is what forces exit 3.                                                                                                               |
| `blindSpots`    | `{file, line, column, reason}[]` | Site-level failures: the file was analyzed, but one import site's target is not statically knowable. These do not affect `complete` or the exit code.                                                                                                                                                    |
| `notes`         | string[]                         | Caveats about how the result should be interpreted: ESLint dialect parsing, provider mismatches between baseline and head (`diff`), provenance gaps, policy fingerprint disagreements, depConstraints narrowing (`context`, `impact`), or an optional architecture-intent relationship not yet observed. |

The distinction between `notAnalyzed` and `blindSpots` is load-bearing: losing a
whole file is a coverage hole (exit 3 when nothing else fired); one
unresolvable site inside an otherwise-analyzed file is a declared limit the run
states and moves past.

## Descriptive commands

`graph`, `diff`, `drift`, `fitness`, `history`, `impact`, `explain`, and `context` are descriptive -- they never exit 1.
They exit 0 when the run completes and 3 when coverage is incomplete. The
envelope's `status` follows the same mapping: `"ok"` for 0, `"no-verdict"` for 3. `"findings"` never appears for a descriptive command.

`diff` also refuses an incomplete baseline or current workspace (exit 3, no
diff), because every "removed" entry would be ambiguous between a real change
and a coverage gap.

`fitness` also exits 3 when the policy declares no `fitness` at all -- judging
nothing is not the same as judging an empty table, and a `--config` pointing at
a policy that declares none names that loudly instead of printing an empty
verdict table. Its per-function verdicts, when present, fold into `check`
instead: `check` exits 1 when a declared fitness function `fail`s and 3 when any
function is `unknown`, same machinery as boundary findings and no-verdicts,
never a new code.
