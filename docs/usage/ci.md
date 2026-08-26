# Running it in CI

The whole job is one command and one rule about how to read its exit code.

```shell
pnpm exec archkeep check
```

Everything on this page holds unchanged for a workspace with no Nx at all — a
`archkeep.json` root instead of an `nx.json` one. The command, the flags, the
exit codes and what a clean run prints are all provider-agnostic; `check`
resolves the root from whichever marker is present and the rest of this page
does not need to know which one it found. The two places that name Nx
specifically — `NX_DAEMON` and ordering the step after `nx run-many` — are
called out where they apply and nowhere else on this page.

## The command

```text
archkeep check [<path>...]   Check imports against the boundary rules
archkeep --help              Show this message

  --format text|sarif|json   Terminal report (default), SARIF 2.1.0 for GitHub
                        code scanning, or the versioned JSON envelope
                        (see "Consuming --format json" below)
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

| code | meaning                                                                                                                                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | clean — **and** every selected file was analyzed                                                                                                                                         |
| `1`  | findings — boundary violations, go.work drift, dead tsconfig aliases, architecture-intent findings, a failing fitness function, or a failing custom rule                                 |
| `2`  | usage error                                                                                                                                                                              |
| `3`  | no verdict — the run could not start, a selected file could not be read, architecture intent could not be established, or a declared fitness function or custom rule could not be judged |

**Do not collapse 3 into 0.** A checker that could not look must never be
mistaken for one that looked and found nothing — that is the single distinction
this tool's design turns on, and a CI step that treats "no verdict" as success
converts an outage into a green build.

Note what 3 covers: not only a total failure (no workspace, malformed config,
`nx graph` or `git` failing — or, on a `archkeep.json` workspace, a model
defect: a declared root with no tracked file, two projects colliding on one
name, a stale `coverage.exempt` waiver) but a **partial** one. An unreadable
file, a file with no analyzer, or a `tsconfig` that will not load each leaves
a file the summary counted but no rule ever judged, and that is enough to
withhold the verdict. A tracked `architecture-intent.json` that will not parse
or validate, or whose boundaries match no observed project, is exit 3 for the
same reason: an intent the tool cannot establish must never read as a
satisfied one. A `archkeep.json` workspace has one partial-failure case
the Nx path does not: a tracked, analyzable file no discovered project owns
is also exit 3, for the same reason — `../../packages/archkeep/src/providers/native/README.md`'s
"Two failure classes, both loud" owns that distinction.

The workspace's own declared gates ride those same two lanes rather than a new
code. A declared fitness function or custom rule that `fail`s is a finding
(exit 1); one that answers `unknown` — a rule that could not tell, or that
trapped, ran over its budget, or asked for evidence this engine cannot supply
— withholds the verdict (exit 3); and a declared custom rule whose artifact
will not load at all refuses the run the way a malformed config does. A gate
nobody could run must never read as a gate nothing tripped
([custom-rules.md](custom-rules.md), [fitness.md](fitness.md)); the full table
is [exit-codes.md](../reference/exit-codes.md)'s.

Shell scripts get this wrong in a specific way. `set -e` treats every non-zero
code alike, which is fine — the failure is visible. What is not fine is:

```shell
# Wrong: turns "could not look" into "looked and found nothing"
archkeep check || true
```

If you need to distinguish, distinguish explicitly:

```shell
archkeep check
case $? in
  0) echo "clean" ;;
  1) echo "findings — a boundary, a workspace declaration, or a declared gate"; exit 1 ;;
  3) echo "the checker could not reach a verdict"; exit 1 ;;
  *) echo "usage error"; exit 1 ;;
esac
```

Both 1 and 3 must fail the build. They differ in what you go and look at, not in
whether you go and look.

## What a clean run prints

```text
policy  module-boundaries.config.mjs — fingerprint 3f9c…

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
  run: pnpm exec archkeep check
```

`NX_DAEMON: "false"` is worth setting — **on an Nx-registered workspace only.**
The daemon is a long-lived process that caches the graph between invocations; a
single-shot runner has no second invocation to reuse it for, and it outlives
the step that started it. A `archkeep.json` workspace has no Nx daemon to
disable — `check` reads the tree fresh from `git ls-files` on every run, so
the variable does nothing there and naming it is harmless rather than wrong.

**Order it late in the job, if the workspace also runs `nx run-many`.** This
step spawns `nx graph` on an Nx-registered workspace, so a plugin that broke
graph computation fails an earlier `nx run-many` with a clearer message than
this step could give. That is the order this repository's own CI uses on
itself. A `archkeep.json` workspace has no `nx run-many` step to order after —
there is nothing Nx-shaped in its pipeline for this step to spawn.

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
  run: pnpm exec archkeep check

# The presentation. Runs even when the gate just failed — the annotations
# matter most on a red run — and its own exit code decides nothing, because
# the gate already did.
- name: Render the verdict as SARIF
  if: ${{ !cancelled() }}
  env:
    NX_DAEMON: "false"
  run: pnpm exec archkeep check --format sarif --output boundaries.sarif
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

## Consuming `--format json`

The plain `check` step above is still the gate — the exit code is what fails
the build, exactly as everywhere else on this page. `--format json` is a third
rendering of the same verdict `text` and SARIF already carry, for a step that
wants to script against the result instead of scraping a report:

```yaml
- name: Check module boundaries
  env:
    NX_DAEMON: "false"
  run: pnpm exec archkeep check --format json --output boundaries.json

- name: Post a summary from the JSON envelope
  if: ${{ !cancelled() }}
  run: |
    jq -r '"\(.status): \(.result.violations | length) violation(s) over \(.coverage.analyzedFiles) files"' \
      boundaries.json
```

Every field name and `schemaVersion` are a public contract from this release
on — [json-output.md](../reference/json-output.md) is the full reference: every field, the
three `status` values, and the stability promise a consumer's own parser can
rely on. Two things worth stating here rather than only there:

- **It changes no exit code.** The step above still fails the job exactly when
  the plain-text `check` would — `--format json` never softens or hardens the
  gate, it only adds a machine-readable rendering beside it.
- **`status: "ok"` never rides incomplete coverage — but the envelope has to
  exist for that promise to reach you.** A run that could not fully read the
  tree, yet still got far enough to build one, writes `status: "no-verdict"`,
  never `"ok"` with a caveat buried in `coverage`. A run that exits 3 before it
  ever reaches that point — no workspace root, both markers present, a
  malformed boundary config, `nx graph` or `git` itself failing — writes no
  envelope at all: nothing on stdout, and under `--output` no file either,
  which means the recipe above's `boundaries.json` is left exactly as the
  previous run wrote it. **Branch on the exit code first, not on `status`
  alone**, and treat "exit 3 with no parseable envelope on stdout, or a
  `--output` file whose contents you cannot trust as fresh" as the same
  no-verdict result `status: "no-verdict"` names when an envelope does exist.

## Running both enforcers

If your workspace already runs `@nx/enforce-module-boundaries`, keep it. It stays
authoritative for JavaScript, TypeScript and Vue; this tool covers the languages
ESLint cannot parse. Point both at the same config file so there is one table
rather than two that drift — see
[getting-started.md](../getting-started/first-policy.md) § _If you already run
`@nx/enforce-module-boundaries`_.

The conditions under which you could eventually drop the ESLint rule are
enumerated in `src/conformance/README.md` § _What this licenses_, and that
document is the one that binds. All three now have a mechanism holding them;
what still blocks removal is the breadth of the real-tree evidence, which that
section states beside each condition.

## Pre-commit

A scoped run over the changed files is a reasonable hook, as long as everyone
understands it is a pre-check and not the gate:

```shell
archkeep check $(git diff --cached --name-only --diff-filter=ACM)
```

The cycle and lazy-load rules will not see what a whole-workspace run sees, so a
hook that passes is not a promise CI will — and neither does a fitness function
that needs the whole tree (`coverage-minimum` today): the hook reports it
`not_applicable`, not evaluated, so a workspace that declares one still needs
an unscoped `check` in CI to actually enforce it.

## Proving your gate counts toward Archkeep's own readiness

A repository whose build genuinely blocks on `archkeep check` — both
directions demonstrated: a controlled violation failing with exit 1, removing
it restoring green — can publish that fact as a
[gate attestation](../reference/gate-attestation.md), the evidence shape
Archkeep's readiness report accepts for its external-adopting condition.
