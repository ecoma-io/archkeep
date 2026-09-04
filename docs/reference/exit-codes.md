# Exit codes

Four exit codes, and the critical distinction is 3 against 0. This page covers
the process exit codes and the `--format json` envelope `status` values that
map to them.

## Process exit codes

| code | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                        | when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | clean -- and every selected file was analyzed                                                                                                                                                                                                                                                                                                                                                                                                  | No findings and no coverage gaps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 1    | findings -- boundary violations, declared-edge (`implicitDependencies`) violations, go.work drift, dead tsconfig path aliases, architecture-intent findings, a failing fitness function, a failing custom rule, a non-waived violation `delta` classifies as introduced, a change-intent reconciliation that found undeclared material changes, unfulfilled declarations, or a failed declared constraint, or a rule-catalog integrity finding | `check`, `fitness`, `delta`, `change`, and `rules verify`. A failing fitness function is a finding (D-09), so is a custom rule's `fail`, so is a violation the compared change introduced without an active waiver covering it, so is an architectural consequence the change did not declare, and so is a rule artifact that does not match the bytes its catalog recorded; every other command that finds something reports it but exits 0, so it never claims the findings exit code without a failed enforcement.                                                                                                                                                                                                                                                                                                                    |
| 2    | usage error                                                                                                                                                                                                                                                                                                                                                                                                                                    | Unknown command, unknown flag, missing argument, path outside the tree, or a scoped path matching no tracked file (a typo, the wrong working directory, or a file not yet `git add`ed). Never reaches the JSON envelope.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 3    | no verdict -- the run could not start, a selected file could not be read, or architecture intent (or the law itself) could not be established                                                                                                                                                                                                                                                                                                  | No workspace, both root markers present, malformed config, a boundary pattern refused by shape or a specifier past the length bound ([policy-schema.md](policy-schema.md#refused-pattern-shapes)), `nx graph`/`git` failed, unreadable file, no analyzer for a file, `tsconfig` that will not load, a tracked `architecture-intent.json` that will not parse or whose boundaries match no project, (native provider) a tracked file no project owns, a declared custom rule whose artifact will not load (missing, hash mismatch, or outside the contract — [custom-rules.md](custom-rules.md)), a declared fitness function or custom rule that answered `unknown`, or — in a profile-selected workspace — a profile that could not be resolved: an unknown profile name, an unknown `base`, a `base` cycle, or an unreadable registry. |

## Why 3 exists, and why it covers partial runs

A checker that could not look must never be mistaken for one that looked and
found nothing -- that is the single distinction this tool's design turns on.
Exit 0 was the bug: it meant an unreadable file, a missing analyzer, or a
`tsconfig` that would not load silently vanished from the verdict.

Exit 3 covers both total failures (no workspace root, malformed boundary
config, `nx graph` or `git` itself failing) and **partial** ones. A single
unreadable file, a file with no analyzer, a `tsconfig` that will not load, or
a literal import that names a declared project but cannot be resolved (a
missing workspace edge) each leaves a file the summary counted but no rule
ever judged, and that is enough to withhold the verdict.

An import site whose target is not statically knowable splits into two
classes, and the verdict treats them differently. A **literal specifier the
resolver could not answer** — a workspace-internal subpath with no edge, an
uninstalled dependency — is a site the run saw but never judged, so on a
findings-free run it withholds the verdict (exit 3): reading it as a pass
would be byte-for-byte identical to a clean workspace. A **non-literal
`import()`/`require()` argument** is a _declared_ limit: the language itself
says the target is computed at runtime, no static tool can answer it, and
every config loader that opens a consumer-named file contains one — so it is
printed under a separate heading as a named blind spot and the verdict stands
over the statically judgeable surface. The line is whether the specifier was
a concrete question the tool could not answer, or a question the language
declares unanswerable.

## What a clean run prints

```text
policy  module-boundaries.config.mjs — fingerprint 3f9c…

✔ no boundary violations (264 imports in 78 files across 12 projects)
```

The `policy` line is printed first on every run — a verdict is a claim about
which law produced it too ([../usage/checking.md](../usage/checking.md)).

The import, file, and project counts are the load-bearing part of a green run.
A sudden drop in those numbers is the shape of a real defect: a `.gitignore`
change that hid a directory, a project that stopped being visible to the graph,
a rename that left files owned by nothing.

## The 3-vs-0 distinction in CI

```shell
# Wrong: turns "could not look" into "looked and found nothing"
archkeep check || true
```

Both 1 and 3 must fail the build. They differ in what you go and look at, not
in whether you go and look. If you need to distinguish, distinguish explicitly
-- see [ci.md](../usage/ci.md) for a shell example.

## `--format json` envelope `status`

Three values, each carrying exactly one `exitCode`. The `jsonEnvelope` builder
throws rather than build an envelope where the two disagree, so this table is
enforced in code, not just documented:

| `status`       | `exitCode` | meaning                                                                                                                                                                                                                                                                                                                     |
| -------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"ok"`         | 0          | No findings, and every selected file was analyzed.                                                                                                                                                                                                                                                                          |
| `"findings"`   | 1          | Boundary violations, go.work drift, dead tsconfig path aliases, architecture-intent findings, a failing fitness function or custom rule, or an undeclared/unfulfilled/failed-constraint change-intent reconciliation.                                                                                                       |
| `"no-verdict"` | 3          | No findings, but the run could not fully read the tree (`coverage.complete` is `false`), architecture intent could not be established, a change intent could not be verified against its declared base, or -- in a profile-selected workspace -- the selected profile could not be resolved. Never mistake this for `"ok"`. |

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

| field           | type                                                  | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `complete`      | boolean                                               | `true` only when `notAnalyzed` is empty, `blindSpots` holds no unresolvable literal site (#595), and at least one file was analyzed (#599) -- enforced, not just correlated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `projects`      | number                                                | Project count in the graph this run judged against.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `analyzedFiles` | number                                                | Files the analyzer produced a verdict for.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `imports`       | number                                                | Import sites judged against the boundary law.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `notAnalyzed`   | `{file, reason}[]`                                    | Whole-file failures: a file the analyzer never reached a verdict about at all (unreadable, no analyzer, a config it depends on that would not load, or a literal import that names a declared project but could not be resolved). Non-empty here is what forces exit 3.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `blindSpots`    | `{file, line, column, reason, dynamic?, external?}[]` | Site-level failures: the file was analyzed, but one import site's target is not statically knowable. A row carrying `dynamic: true` is the declared non-literal-argument limit -- disclosed, exit-neutral. A row carrying `external: true` is an unresolvable bare-package specifier -- it names no project the workspace declares, and its resolvability depends on an installed dependency tree a workspace legitimately may not have -- disclosed, exit-neutral. A row with neither marker is an unresolvable literal that references the workspace's own surface -- a concrete question the run could not answer about the governed graph, which on a findings-free run forces exit 3 (#595). |
| `notes`         | string[]                                              | Caveats about how the result should be interpreted: ESLint dialect parsing, provider mismatches between baseline and head (`diff`), provenance gaps, policy fingerprint disagreements, depConstraints narrowing (`context`, `impact`), or an optional architecture-intent relationship not yet observed.                                                                                                                                                                                                                                                                                                                                                                                          |

The distinction between `notAnalyzed` and `blindSpots` is load-bearing: losing a
whole file is a coverage hole (exit 3 when nothing else fired); an unresolvable
site inside an otherwise-analyzed file is a site the run saw but never judged,
and it lands in the same no-verdict lane unless its row carries the `dynamic`
or `external` marker — the language-declared limit and the bare-package
external class, the two disclosed classes the verdict stands over.
For an unresolvable import the line is whether the specifier references the
workspace's own surface: a workspace-internal dependency that should resolve
to a project node but cannot is a whole-file failure (a missing edge, a
coverage hole), while a package import that names no declared project is an
external blind spot — disclosed without withholding (#595, narrowed), unlike
its workspace-referencing counterpart, which withholds the verdict.

## Descriptive commands

`graph`, `diff`, `drift`, `discover`, `reconcile`, `waivers`,
`history`, `trajectory`, `evolution`, `health`, `report`, `debt`, `impact`, `scenario`, `explain`, `context`, `decisions`,
`provenance`, `adr`, and `rules list` are descriptive -- they never exit 1.
They exit 0 when the run completes and 3 when coverage is incomplete. The
envelope's `status` follows the same mapping: `"ok"` for 0, `"no-verdict"` for 3. `"findings"` never appears for a descriptive command.

`fitness` is one exception: it is a verdict, not a print job (D-09). It exits 1
on a failing function and 3 on an undetermined one -- the same two lanes
`check` uses -- because a CI gating on `archkeep fitness` must not be green over
a function that failed or that the run could not determine.

`delta` is another. Its compare mode exits 1 when the change introduced a
boundary violation not covered by an active waiver, and 3 both on its refusals
(an unreadable, foreign-schema, or incomplete baseline; a provider mismatch;
an incomplete head) and on a comparison holding an item it could not classify
-- an unanswerable question is never a clean delta. Its `--capture` mode is
descriptive: 0 on a written snapshot, 3 on any failure, never 1.
[../usage/delta.md](../usage/delta.md) owns the model.

`change` is the third verdict verb. Its reconciliation exits 1 when the change
produced architectural consequences its declaration did not cover (undeclared),
skipped ones it did declare (unfulfilled), or failed a declared constraint --
and exits 3 when the manifest's base pin cannot be verified against the
baseline's provenance (unproven) or a declared constraint could not be
determined. The workspace-law axis its envelope reports is informational and
never moves this exit code. [../usage/change.md](../usage/change.md) owns the
model.

### Where the incomplete-coverage refusal appears

Every incomplete-coverage refusal in the commands above arrives as the
envelope itself: `status: "no-verdict"`, `exitCode: 3`, the whole-file
failures named in `coverage.notAnalyzed` and the unjudged sites in
`coverage.blindSpots`, and the text report carrying the same clauses `check`
prints. The refusal rides stdout like any report and reaches `--output` like
any report, so a parser and a terminal reader get the same withheld verdict.
This is one contract for two families that used to differ: `check`/`graph`/
`discover`/`explain`/`context` answered this way already, while `drift`,
`reconcile`, `waivers`, `debt`, `fitness`, `impact`, `scenario`, `diff`,
`delta` (compare) and `change` threw the same refusal as a stderr sentence
with no envelope and nothing under `--output`.

The one thing the two families still differ on is the `result` payload, and
the split is each command's own envelope shape, not the refusal's:

- `check`, `graph`, `discover`, `explain` and `context` build one envelope for
  every verdict, so a refusal carries their usual `result` beside it — the
  policy identity and an empty `violations` array for `check`, the partial
  project graph for `graph`, the observations that WERE made for `discover`.
  [json-output.md](json-output.md) documents each payload. Read
  `coverage.complete` before `result`: beside a `"no-verdict"` status the
  payload is the part of the answer the run did reach, never a verdict over
  the whole tree.
- the rest — `drift`, `reconcile`, `waivers`, `debt`, `fitness`, `impact`,
  `scenario`, `diff`, `delta` (compare) and `change` — refuse through the one
  shared builder (`packages/archkeep/src/commands/coverage-verdict.mjs`'s
  `coverageRefusal`), whose envelope carries no `result` at all: the verdict
  was withheld, so the `coverage` block is the whole payload. `delta` and
  `change` additionally carry their usual `decision`, with `decision.reason`
  naming the clauses.

The refusals that stay throws are the ones about a file or a declaration
rather than this tree, and they still exit 3 through the catch with nothing on
stdout and nothing written under `--output`: a baseline that cannot be read,
parsed, or holds a foreign schema version; an incomplete BASELINE snapshot; a
provider mismatch between baseline and head; a missing or malformed change
intent; the unregistered-plugin graph over polyglot manifests; and the capture
modes (`delta --capture`, `history --capture`), whose product is a snapshot
file with no envelope contract to refuse through.

The zero-analyzed workspace is refused the same way everywhere the verdict is
a claim: a scope that selected no file any analyzer claims has judged nothing,
and "judged nothing" is not "found nothing" (#599) -- the clause is `no file in
scope could be analyzed -- coverage incomplete`.

`rules verify` is the only `rules` subcommand whose verdict carries an exit:
it exits 1 when catalog integrity finds a violation -- a digest mismatch, an
artifact the host refuses, one that escaped its directory -- and 3 when the
catalog could not be read, so "this artifact does not match the bytes its
catalog recorded" never reads as "the catalog could not be looked at".
[custom-rules.md](custom-rules.md) owns the model.

`diff` also refuses an incomplete workspace (exit 3, no diff) -- now as the
envelope above -- because every "removed" entry would be ambiguous between a
real change and a coverage gap; an incomplete BASELINE snapshot stays a throw,
a caller error about a file rather than a coverage fact about this tree.

`fitness` also exits 3 when the policy declares no `fitness` at all -- judging
nothing is not the same as judging an empty table, and a `--config` pointing at
a policy that declares none names that loudly instead of printing an empty
verdict table. Its per-function verdicts fold into `check` the same way: a
declared fitness function that `fail`s exits 1 and one that is `unknown` exits
3, same machinery as boundary findings and no-verdicts, never a new code.

Declared custom rules ride the identical machinery
([custom-rules.md](custom-rules.md)): a rule's `fail` is a finding (exit 1),
its `unknown` — the rule's own, or the engine's answer for a rule that
trapped, ran over a budget, or asked for evidence this engine cannot supply —
keeps exit 3, `not_applicable` counts toward neither, and a rule whose
artifact will not load at all refuses the run the way a malformed config does.
