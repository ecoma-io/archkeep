# Running it in CI

The whole job is one command and one rule about how to read its exit code.

```shell
pnpm exec nx-polyglot-graph check
```

## The command

```text
nx-polyglot-graph check [<path>...]   Check imports against the boundary rules
nx-polyglot-graph --help              Show this message

  --format text|sarif   Terminal report (default), or SARIF 2.1.0 for GitHub code scanning
  --output <file>       Write the report to a file instead of stdout
  --config <file>       Read the boundary law from here instead of
                        <workspace root>/module-boundaries.config.mjs
```

Both `--flag value` and `--flag=value` work. An unknown flag is a **usage error**
rather than a path — a typo like `--fromat sarif` would otherwise be read as two
paths, select no files, and report a clean tree.

**Naming paths scopes the run, and a scoped run is not the gate.** It is a fast
local pre-check. The cycle and lazy-load rules judge the file graph as a whole,
so a scoped run can miss what a whole-workspace run would find. CI runs the
unscoped form.

**`--config` does not move the workspace root.** Pointed at a consumer's tree,
the tool and the law it enforces can be in different trees, and the tree being
judged is still the consumer's.

## The exit codes, and the one that matters

| code | meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| `0`  | clean — **and** every selected file was analyzed                           |
| `1`  | findings — boundary violations, go.work drift, or dead tsconfig aliases    |
| `2`  | usage error                                                                |
| `3`  | no verdict — the run could not start, or a selected file could not be read |

**Do not collapse 3 into 0.** A checker that could not look must never be
mistaken for one that looked and found nothing — that is the single distinction
this tool's design turns on, and a CI step that treats "no verdict" as success
converts an outage into a green build.

Note what 3 covers: not only a total failure (no workspace, malformed config,
`nx graph` or `git` failing) but a **partial** one. An unreadable file, a file
with no analyzer, or a `tsconfig` that will not load each leaves a file the
summary counted but no rule ever judged, and that is enough to withhold the
verdict.

Shell scripts get this wrong in a specific way. `set -e` treats every non-zero
code alike, which is fine — the failure is visible. What is not fine is:

```shell
# Wrong: turns "could not look" into "looked and found nothing"
nx-polyglot-graph check || true
```

If you need to distinguish, distinguish explicitly:

```shell
nx-polyglot-graph check
case $? in
  0) echo "clean" ;;
  1) echo "boundary violations, go.work drift, or dead tsconfig aliases"; exit 1 ;;
  3) echo "the checker could not reach a verdict"; exit 1 ;;
  *) echo "usage error"; exit 1 ;;
esac
```

Both 1 and 3 must fail the build. They differ in what you go and look at, not in
whether you go and look.

## What a clean run prints

```text
✔ no boundary violations (264 imports in 78 files across 12 projects)
```

Those counts are the load-bearing part of a green run. "No violations" is a claim
about coverage as much as about correctness, and a run that analyzed four files
would otherwise be indistinguishable from one that analyzed four hundred.

**Watch those numbers in CI.** A sudden drop is the shape of a real defect: a
`.gitignore` change that hid a directory, a project that stopped being visible to
the graph, a rename that left files owned by nothing. Nothing in the tool alerts
on it, and a human reading the line will notice.

## GitHub Actions

The minimal version:

```yaml
- name: Check module boundaries
  env:
    NX_DAEMON: "false"
  run: pnpm exec nx-polyglot-graph check
```

`NX_DAEMON: "false"` is worth setting. The daemon is a long-lived process that
caches the graph between invocations; a single-shot runner has no second
invocation to reuse it for, and it outlives the step that started it.

**Order it late in the job.** This step spawns `nx graph`, so a plugin that broke
graph computation fails an earlier `nx run-many` with a clearer message than this
step could give. That is the order this repository's own CI uses on itself.

## SARIF and GitHub code scanning

**The exit code is the gate; SARIF is presentation.** The gate is the plain
`check` step above, which fails the job on findings and on "no verdict" alike.
The SARIF is a second rendering of the same verdict, uploaded so the findings
appear as inline annotations on the pull request diff and as alerts code
scanning tracks new-versus-base. Two steps, in that order:

```yaml
# The gate. Fails the job — exit 1 on findings, exit 3 on "no verdict".
- name: Check module boundaries
  env:
    NX_DAEMON: "false"
  run: pnpm exec nx-polyglot-graph check

# The presentation. Runs even when the gate just failed — the annotations
# matter most on a red run — and its own exit code decides nothing, because
# the gate already did.
- name: Render the verdict as SARIF
  if: ${{ !cancelled() }}
  env:
    NX_DAEMON: "false"
  run: pnpm exec nx-polyglot-graph check --format sarif --output boundaries.sarif
  continue-on-error: true

- uses: github/codeql-action/upload-sarif@v3
  if: ${{ !cancelled() }}
  with:
    sarif_file: boundaries.sarif
```

The SARIF step exits non-zero on the same findings the gate already failed on,
so its `continue-on-error` hides nothing — but a lone SARIF step wearing
`continue-on-error` with no gate step is a pipeline that turns every exit code
green. The upload needs the `security-events: write` permission on the job, and
code scanning displays the results only on a public repository or one with
GitHub Advanced Security — the gate step works everywhere either way.

What the SARIF carries, and why each choice was made:

- **`ruleId` is the upstream `messageId`, spelled exactly.** Two tools that both
  say "error" agree on nothing until they name the same rule. The rule catalogue
  is derived from the message table rather than listed separately, so a rule
  added upstream cannot go missing.
- **`artifactLocation.uri` is workspace-relative and percent-encoded per
  segment.** GitHub resolves annotations against the repository root, and a path
  containing a space or a `#` is not a valid URI reference — which would get the
  _whole run_ rejected over one file.
- **`region` is 1-based in both axes**, and `columnKind` is stated explicitly:
  columns count UTF-16 code units. A consumer assuming code points would land in
  the wrong column on any line containing an emoji.
- **`level` is `error` on every result.** This report exists to block a merge; a
  warning renders as an annotation nobody has to act on.
- **Analysis failures are not results.** A file the tool could not parse is a
  place it has _no verdict about_, and filing that as a finding would put a
  boundary alert on code that may well be clean. They travel as
  `invocations[].toolExecutionNotifications` at `warning` — SARIF's own slot for
  "the tool had trouble here" — and `executionSuccessful` stays true, because the
  run did complete.
- **go.work drift findings and dead tsconfig path aliases _are_ results**,
  under their own rule ids (`goWork*`, `tsconfigDeadPathAlias`): they are
  verdicts the run fails on, exactly like violations, and a finding that only
  reached the exit code would leave code scanning showing a red job with an
  empty upload. Both are workspace-level and positionless where nothing wrote
  the missing thing, so their locations may carry the artifact alone.

That last point has a consequence worth stating plainly: **the SARIF upload does
not carry the exit-3 signal.** Code scanning will show you violations, not
coverage loss — which is why the gate in the recipe above is the plain `check`
step and never the upload.

## Running both enforcers

If your workspace already runs `@nx/enforce-module-boundaries`, keep it. It stays
authoritative for JavaScript, TypeScript and Vue; this tool covers the languages
ESLint cannot parse. Point both at the same config file so there is one table
rather than two that drift — see
[getting-started.md](getting-started.md) § _If you already run
`@nx/enforce-module-boundaries`_.

The conditions under which you could eventually drop the ESLint rule are
enumerated in
[`src/conformance/`](../../packages/nx-polyglot-graph/src/conformance/README.md).
One of the three is not met — agreement measured on real trees — and it is not
about correctness on the fixtures.

## Pre-commit

A scoped run over the changed files is a reasonable hook, as long as everyone
understands it is a pre-check and not the gate:

```shell
nx-polyglot-graph check $(git diff --cached --name-only --diff-filter=ACM)
```

The cycle and lazy-load rules will not see what a whole-workspace run sees, so a
hook that passes is not a promise CI will.
