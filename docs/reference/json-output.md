# `--format json`

`check --format json`, `graph --format json`, `diff --format json`,
`delta --format json`, `change --format json`,
`discover --format json`, `drift --format json`, `reconcile --format json`,
`waivers --format json`, `fitness --format json`, `history --format json`,
`trajectory --format json`,
`health --format json`, `report --format json`, `debt --format json`,
`impact --format json`,
`explain --format json`, `context --format json`, `provenance --format
json`, and `adr --format json` wrap the same verdict the terminal report
and SARIF already carry in one versioned envelope. They change no exit code and no byte
of the other two formats — they are additional renderings of a verdict every
format already computes, for a script that wants to branch on a field rather
than scrape a report or walk a SARIF `runs[]` array.

```shell
archkeep check --format json
archkeep check --format json --output report.json
archkeep graph --format json
archkeep graph --format json --output snapshot.json
archkeep diff snapshot.json --format json
archkeep diff snapshot.json --format json --output structural-diff.json
archkeep delta delta-base.json --format json
archkeep delta delta-base.json --format json --output delta.json
archkeep waivers --format json
archkeep waivers --format json --output waivers.json
archkeep history .archkeep/history --format json
archkeep history .archkeep/history --format json --output evolution.json
archkeep trajectory .archkeep/history --format json
archkeep trajectory .archkeep/history --format json --output trajectory.json
archkeep debt .archkeep/history --format json
archkeep debt .archkeep/history --format json --output debt.json
archkeep impact billing-core --format json
archkeep impact billing-core --format json --output impact.json
archkeep explain libs/alpha/main.go:10:5 --format json
archkeep explain libs/alpha/main.go:10:5 --format json --output explain.json
archkeep context billing-core --format json
archkeep context billing-core --format json --output context.json
```

## The stability promise

**Every field name here, and `schemaVersion` itself, are a public contract
from the release that ships this page.** A script that parses this output
today keeps working on every later 1.x release: no field is renamed, no field
changes type, and no field that means one thing today is repurposed to mean
another. A capability that does not fit the current shape ships as a new
field, additive, never as a change to an existing one.

**A gate holds that promise, not discipline.** Every command's envelope is
reduced to a sorted `path: type` roster and compared against a recorded
snapshot on every run of the suite
(`packages/archkeep/src/report/envelope-shape.integration.test.mjs`), in both
directions: a field that left the envelope fails the build, and a field that
arrived fails it too until the snapshot is regenerated — which is what keeps
"additive" a claim someone made rather than a diff nobody read. The command
list the gate is exhaustive over comes from the CLI's own command table, so a
command added later cannot ship an unmeasured shape.

`schemaVersion` is an integer, and it only moves for a breaking change to this
document — a field renamed, retyped, or removed. A consumer that reads a
`schemaVersion` it does not recognise should refuse to parse the rest of the
envelope rather than guess: an unrecognised version is a caller reading a
contract from the future, not a workspace fact.

**The envelope is deterministic.** Two runs over an unchanged tree, with an
unchanged `archkeep` version, produce byte-identical JSON — same key order
(insertion order, matching the shape below), same array order, no timestamp
and no random identifier anywhere in it. That is what makes it diffable in a
pull request the same way the SARIF output already is.

The one exception is a field a capability documents as time-relative by
design: `decision.sampleTime` (opt-in, absent by default — see
[evidence.md](evidence.md)), `waivers`' `remainingMs` (present whenever the
command runs — see the `waivers` result below), and `debt`'s `sampleTime`
(likewise always present — see the `debt` result below). Each is the shared
governance clock made visible (`src/governance/clock.mjs`), not a fact about
the tree, so two runs of an unchanged workspace differ in
exactly that one field and nowhere else; `coverage.notes` names the excluded
field in-band on every `waivers`/`debt` run, so a consumer diffing or hashing
two envelopes to detect real drift knows what to strip first.

`command` is the one field that varies by which command produced the envelope —
`"check"`, `"graph"`, `"diff"`, `"delta"`, `"change"`, `"discover"`, `"drift"`, `"reconcile"`,
`"waivers"`, `"fitness"`, `"history"`, `"trajectory"`, `"evolution"`, `"health"`, `"report"`,
`"debt"`,

`"impact"`, `"explain"`, `"context"`, `"provenance"`, or `"adr"`. `src/report/json.mjs`
(the module that builds the envelope) and `src/commands/README.md` (the
module layout it follows) are both written for each command to reuse the same
wrapper.

## Top-level fields

| field           | type                                     | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion` | integer                                  | This document's version. Currently `2`.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tool`          | `{name, version}`                        | `name` is always `"@ecoma-io/archkeep"`; `version` is the installed package's own `package.json` version.                                                                                                                                                                                                                                                                                                                                                      |
| `command`       | string                                   | Which command produced this envelope. `"check"`, `"graph"`, `"diff"`, `"delta"`, `"change"`, `"discover"`, `"drift"`, `"reconcile"`, `"waivers"`, `"fitness"`, `"history"`, `"trajectory"`, `"evolution"`, `"health"`, `"report"`, `"debt"`, `"impact"`, `"explain"`, `"context"`, `"provenance"`, or `"adr"`.                                                                                                                                                 |
| `workspace`     | `{root, provider, marker, provenance}`   | `root` is the resolved workspace root (absolute path); `provider` is `"nx"`, `"native"`, or `"moon"`; `marker` is the root file or directory that decided it (`"nx.json"`, `"archkeep.json"`, `".moon"`, or `".config/moon"`) — except on an `adr` envelope, which reads no project model and carries `provider: "native"`, `marker: "docs/adr"` ([adr.md](adr.md)). `provenance` is the git origin of the run, or `null` when git is unavailable — see below. |
| `status`        | `"ok"` \| `"findings"` \| `"no-verdict"` | The verdict. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `exitCode`      | `0` \| `1` \| `3`                        | The same code the process exits with — never `2`: a usage error never reaches far enough to build an envelope.                                                                                                                                                                                                                                                                                                                                                 |
| `decision`      | object \| absent                         | The same verdict in the four-state vocabulary — `{verdict, reason?, notApplicableReason?, sampleTime?}`. Present on every `check` and `delta` envelope; see [evidence.md](evidence.md).                                                                                                                                                                                                                                                                        |
| `coverage`      | object                                   | What the run inspected, and what it could not. See below.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `result`        | object                                   | The command's own payload — for `check`, the violations, the three workspace-level checks (`goWork`, `tsconfigPaths`, `declaredEdges`), and — when the workspace has one — the architecture-intent verdict. See below.                                                                                                                                                                                                                                         |

## `status`, and the exit code it must agree with

Three values, and each one carries exactly one `exitCode` — `jsonEnvelope`
(`src/report/json.mjs`) throws rather than build an envelope where the two
disagree, so this table is not just documentation, it is enforced:

| `status`       | `exitCode` | meaning                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"ok"`         | `0`        | No findings, and every selected file was analyzed.                                                                                                                                                                                                                                                                                                                                                    |
| `"findings"`   | `1`        | Boundary violations, declared-edge violations, go.work drift, dead tsconfig path aliases, architecture-intent findings, a failing fitness function, or a failing custom rule — one or more of `result.violations`, `result.declaredEdges.findings`, `result.goWork.findings`, `result.tsconfigPaths.findings`, `result.intent.findings` is non-empty, or a fitness or custom-rule verdict was `fail`. |
| `"no-verdict"` | `3`        | The run found no findings but could not fully read the tree — `coverage.complete` is `false` — architecture intent could not be established, or a declared fitness function or custom rule answered `unknown`. Never mistake this for `"ok"`: a checker that could not look must never read as one that looked and found nothing.                                                                     |

**This table describes an envelope that got built.** A run can also exit `3`
having never reached the point of building one at all — no workspace root,
both markers present, a malformed boundary config, the `nx graph` or `git`
call itself failing. That class prints an error to stderr and writes nothing
to stdout, and under `--output` it writes no file at all: whatever was already
at that path — a previous run's envelope — is left exactly as it was. A
consumer has to branch on the process's exit code first, not on `status`:
`"no-verdict"` is a status found _inside_ an envelope this run did manage to
build, while an exit code of `3` with no parseable JSON on stdout, or a stale
file left under `--output`, is the same "could not look" verdict arriving with
no envelope to read at all.

**`status: "ok"` never rides incomplete coverage.** A run with findings AND an
unanalyzed file still reports `"findings"` — a violation is a certain verdict
regardless of what else the run could not reach, and the unreached files are
still listed in `coverage.notAnalyzed`. Only a run with **no** findings can be
downgraded from `"ok"` to `"no-verdict"`.

## `decision`, and the status it must agree with

`decision` renders the same verdict the `status`/`exitCode` pair already
carries into the canonical four-state vocabulary
([evidence.md](evidence.md) is the vocabulary's source). It is present on every
`check` and `delta` envelope and absent from every other command's, and its `verdict` is
exactly the one `status` implies — `"ok"` → `"pass"`, `"findings"` → `"fail"`,
`"no-verdict"` → `"unknown"`. `jsonEnvelope` throws rather than build an
envelope where `decision.verdict` and `status` disagree, the same consistency
rule the `status`/`exitCode` table enforces.

| field                 | type   | meaning                                                                                                                                                                                |
| --------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verdict`             | string | `"pass"` \| `"fail"` \| `"unknown"`. `"not_applicable"` has no status and never reaches this release's envelopes.                                                                      |
| `reason`              | string | **Always present on `"unknown"`** — names which could-not-look condition fired: `"coverage was incomplete"`, the file count that could not be analyzed, an unresolved intent boundary. |
| `notApplicableReason` | string | Present only on `"not_applicable"` — unreachable in this release.                                                                                                                      |
| `sampleTime`          | string | **Opt-in, absent by default.** An ISO-8601 UTC instant a time-based capability adds via the shared reference clock. The envelope is otherwise byte-deterministic.                      |

`reason` on an `"unknown"` decision is the fourth place the envelope states what
the run actually inspected: `status` says the run could not reach a verdict,
`coverage.notAnalyzed` lists the files, and `decision.reason` says which
could-not-look condition produced the whole result. A consumer that wants to
distinguish "coverage incomplete" from "intent could not be established" reads
it here.

## `coverage`

What the run inspected, so "no violations" reads as a claim about coverage,
not only about correctness — the same principle the terminal report's
`file:line:column` counts state out loud.

| field           | type                             | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `complete`      | boolean                          | `true` only when `notAnalyzed` is empty — enforced, not just correlated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `projects`      | number                           | Project count in the graph this run judged against.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `analyzedFiles` | number                           | Files the analyzer produced a verdict for.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `imports`       | number                           | Import sites judged against the boundary law.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `notAnalyzed`   | `{file, reason}[]`               | Whole-file failures: a file the analyzer never reached a verdict about at all (unreadable, no analyzer, a config it depends on that would not load, or an import that names a declared project but could not be resolved — a missing workspace edge). Non-empty here is exactly what makes `complete` false and forces `status` away from `"ok"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `blindSpots`    | `{file, line, column, reason}[]` | Site-level failures: the file WAS analyzed, but one import site's target is not statically knowable (a dynamic `import()` with a non-literal argument, or a literal package import that names no declared project and cannot resolve). These do not affect `complete` — the file was judged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `notes`         | string[]                         | Caveats about how the result should be interpreted: ESLint dialect parsing (`check`), provider mismatches between baseline and head (`diff`), provenance gaps and dirty-tree disclosures (`diff`, `delta`), policy fingerprint disagreements (`diff`, `delta`), depConstraints narrowing (`context`, `impact`), a boundary law that could not be loaded but that the verdict never consulted (`drift`), or which result field is the wall clock made visible and excluded from the determinism claim above (`waivers`, `debt`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `coverageGaps`  | `{kind, …}[]`                    | Coverage this run knows it did not provide. Each entry carries a `kind` and the fields that kind names, and **no kind changes `complete`, `status`, or the exit code** — a gap is coverage sitting outside the verdict, not a file the run failed to reach. Three kinds: `"unregistered-plugin"` (`{kind, manifests}`) — an Nx workspace whose `nx.json` does not register this plugin but whose tracked files include polyglot manifests (`go.mod`, `Cargo.toml`, `pyproject.toml`, `pom.xml`) under project roots, so `nx affected` and `@nx/enforce-module-boundaries` miss edges the checker's own analysis covered; and `"unowned-files"` (`{kind, provider, languages, files}`) — tracked TypeScript, JavaScript or Vue files no project owns, skipped by [the order in violations.md](violations.md#the-order-matters) and counted here so the skip is not silent (`files` is the complete list; the terminal report prints a bounded sample of it); and `"accepted-unowned-files"` (`{kind, provider, languages, files}`) — unowned files of either kind (the TS/JS/Vue gap above, or a Go/Rust/Python orphan that would otherwise be a `notAnalyzed` refusal) that a [`coverage.unowned`](policy-schema.md#coverage) row accepts: a recorded acceptance, still stated on every run, with each accepting row's reason surfaced by `archkeep waivers`. The files this run read as its own configuration — the boundary config and the tsconfig it resolved — are never counted here: they are the law, not source judged by the law, and counting them would make the report vary with what a workspace named them. Go, Rust or Python in that position is a `notAnalyzed` entry instead, and on the native provider so is every language. Empty when there is no gap. |

The distinction between `notAnalyzed` and `blindSpots` is the same one the
terminal report draws under two separate headings, and it is load-bearing:
losing a whole file is a coverage hole (`status: "no-verdict"` when nothing
else fired); one site whose target is not statically knowable inside an
otherwise-analyzed file is a declared limit the run states and moves past.
The line between the two for an unresolvable import is whether the specifier
names a declared project: a workspace-internal dependency that should resolve
to a project node but cannot is a whole-file failure (the missing edge is a
coverage hole), while a package import that names no declared project (an
uninstalled third-party dependency) is a normal permanent blind spot.

## `workspace.provenance`

Optional git provenance for the run. When git is available in the workspace,
the envelope carries the commit, remote, and dirty state so a consumer can
verify which repository and which tree state produced the output. When git is
not available (a test harness, a directory without `.git`), `provenance` is
`null` — the envelope carries no origin claim it cannot verify.

`workspace.root` is a local path that varies by machine and is **not**
repository identity. `provenance` is the stable identity when it exists.

| field    | type             | meaning                                                                                                                                            |
| -------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commit` | string           | The full SHA-1 hex of `HEAD` at the time of the run.                                                                                               |
| `remote` | `null` \| string | The URL of the first git remote (typically `origin`), or `null` when the repository has no remotes.                                                |
| `dirty`  | boolean          | `true` when `git status --porcelain` reports any uncommitted change — the working tree does not match the commit the envelope claims to come from. |

A `diff` baseline that carries `provenance` allows the consumer to verify it
came from the same repository as the head. When both sides carry provenance
but their remotes differ, `diff` emits a `coverage.notes` warning that the
diff may be across unrelated repositories. When one side has provenance and the
other does not, a `coverage.notes` warning states that cross-repository
verification is not possible.

## `result` (for `command: "check"`)

| field                    | type                                                                                            | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy`                 | `{profile, source, fingerprint}`                                                                | Which law governed this run, named first — a verdict is a claim about which policy produced it too. `profile` is the active profile's name, or `null` when the workspace did not select one by name ([profiles.md](../concepts/profiles.md)). `source` is the workspace-relative path this run actually read the policy from: the `--config` file, the declared `boundaryConfig` file, the profile registry, or (an inline `archkeep.json` policy has no file of its own) `archkeep.json` itself. `fingerprint` is the same SHA-256 hex `graph`'s own `policy.fingerprint` computes, below — two runs under the identical effective policy always agree, regardless of `source`. Always present: `check` cannot judge anything without loading exactly one policy first.                                                                                                                                                                                                                                                           |
| `violations`             | `Violation[]`                                                                                   | Every boundary-rule violation, in the shape `src/rules/index.mjs`'s `Violation` typedef defines: `sourceFile`, `line`, `column` (both 1-based), `specifier`, `kind`, `messageId`, `message`, `sourceProject`, `targetProject`, `constraint`, `data`. A violation an ACTIVE waiver accepted additionally carries `waivedBy` (the suppressing row) and one re-asserted by an EXPIRED waiver carries `evidence` (`"expired waiver"`) — a waived violation is still `violations`, so the exit code stays 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `waived`                 | number (optional)                                                                               | How many violations an ACTIVE waiver accepted, present only when non-zero — an unchanged tree's envelope is unchanged, and the accepted count is a tracked decision, never a new error kind.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `goWork`                 | `null` \| `{checked: true, findings}`                                                           | `null` when the workspace has no tracked `go.work` — no check, no claim, same as the text report's silence. Otherwise `checked: true` and `findings` is the array `compareGoWork` (`src/go-work.mjs`) returns: `{messageId, file, line, column, directory, project, message}` each, `line`/`column` `null` for a workspace-level finding with no single site.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `tsconfigPaths`          | `null` \| `{checked: true, findings}`                                                           | `null` when the workspace tsconfig declares no `paths` table — same silence. Otherwise `checked: true` and `findings` is the array `judgeTsconfigPaths` (`src/tsconfig-paths.mjs`) returns: `{messageId: "tsconfigDeadPathAlias", file, line: null, column: null, alias, targets, message}` each.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `declaredEdges`          | `null` \| `{checked: true, judged, findings}`                                                   | `null` when the graph has no `implicit`-typed edge at all (`implicitDependencies` in a `project.json`/`archkeep.json` row) — same silence. Otherwise `checked: true`, `judged` is how many `implicit` edges the graph carried, and `findings` is the array `declaredEdgeViolationsForCheck` (`src/commands/edge-constraints.mjs`) returns: `{messageId, file, line: null, column: null, source, target, constraint, data, message}` each — the same `depConstraints` verdicts (`onlyTagsConstraintViolation`, `emptyOnlyTagsConstraintViolation`, `notTagsConstraintViolation`, `projectWithoutTagsCannotHaveDependencies`) `context`/`impact` already show for the identical edge, reused here rather than re-derived, judged against an edge that has no import site and so cannot appear in `violations` above.                                                                                                                                                                                                                 |
| `intent`                 | absent \| `{checked, file, verdict, findings, unresolved, boundaries, unresolvedDecisionRefs?}` | The architecture-intent verdict. The key is **absent** (never `null`) when the workspace has no tracked `architecture-intent.json` — no intent declared, no claim, and an intent-less envelope is byte-identical to one predating this feature. When present, `checked: true`, `file` is `"architecture-intent.json"`, `verdict` is `"ok"` \| `"findings"` \| `"no-verdict"`, `findings` is the array of `{source, target, rule, boundaryFrom, boundaryTo, message}` records, `unresolved` lists the boundaries (or row sides) that matched no observed project, `boundaries` is the membership that was judged, `[{name, projects}]`, and `unresolvedDecisionRefs` (optional) lists every intent row whose `decisionRef` does not resolve, as `{kind, decisionRef}` — an intent row citing a decision that does not exist folds the whole run's `status` to `"no-verdict"` (exit `3`), because a workspace that declared an intended architecture whose governing decision is absent cannot claim `ok` on that axis.              |
| `fitness`                | absent \| `{checked: true, verdict, functions}`                                                 | The fitness verdict. The key is **absent** (never `null`) when the policy declares no fitness functions — the same omitted-key discipline as `intent`. When present, `checked: true`, `verdict` is the overall `pass` \| `fail` \| `unknown` \| `not_applicable`, and `functions` is the per-function decision list ([fitness-functions.md](../concepts/fitness-functions.md)). A `fail` folds the envelope to `status: "findings"` (exit `1`), an `unknown` to `"no-verdict"` (exit `3`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `customRules`            | absent \| `{checked: true, verdict, rules}`                                                     | The custom-rule verdicts. The key is **absent** (never `null`) when the policy declares no `customRules` — the same omitted-key discipline as `fitness`. When present, `verdict` is the overall `pass` \| `fail` \| `unknown` \| `not_applicable` under the same precedence, and `rules` is the per-rule decision list: each row carries `verdict`, `name`, the declared `reason`, a `message`, an `evidence` object naming the `artifact` and — on a full run — the verified `sha256` and finding count (a scoped run carries `scoped: true` instead, having hashed nothing), and its namespaced `findings` (`custom/<rule>/<finding>` ids with optional `sourceFile`/`line`/`column`/`project`). Folds into `status`/`exitCode` exactly as `fitness` does; [custom-rules.md](custom-rules.md) owns the contract behind the verdicts.                                                                                                                                                                                             |
| `unresolvedDecisionRefs` | `string[]` (optional)                                                                           | `decisionRef` values from `depConstraints` rows (`violations[].constraint.decisionRef`, any declared-edge finding's, and any intent row's) that resolve to no ADR, rule, or fitness record the workspace's `docs/adr/` registry knows — sorted, deduplicated, so an intent row and a `depConstraints` row citing the same value appear once. Present only when non-zero, the same `waived`-style bargain: an unchanged tree's envelope is unchanged. A documentation fact about the rows' _citations_, never a finding of its own — it changes no byte of `status`/`exitCode` for the `depConstraints`/declared-edge half (`src/governance/adr-registry.mjs`'s `resolveDecisionRef`; `AGENTS.md`, "an empty result is a claim, not a shrug" — the empty case here means every citation resolves, or none exists). The intent half is where the run's verdict is affected: `result.intent.unresolvedDecisionRefs` names WHICH intent rows cite what, and ITS exit-3 folding is the intent block's contract above, not this field's. |

`goWork`, `tsconfigPaths`, and `declaredEdges` are `null` rather than an empty
array with `checked: false` on purpose: a workspace with no `go.work` and one
with a `go.work` that agrees with the graph both produce zero findings, and
only the `null`/`{checked: true, findings: []}` split tells the two apart —
the same "no manifest, no check, no claim" rule the text report and
`docs/usage/ci.md` already state.

`intent` follows the same rule as a **third spelling**. It is absent when
nothing is declared, present with `verdict: "ok"` when the intent agrees with
the observed graph, and present with `verdict: "no-verdict"` when the file
will not parse or a boundary matched no observed project. A finding — a
forbidden path in the graph, or an allowed relationship with no observed edge
— is `verdict: "findings"`, which forces the whole envelope's `status` to
`"findings"` and exit code to `1`. An `ok` status can never carry an intent
no-verdict: an intent that cannot be established makes the run's
`status` `"no-verdict"`, never `"ok"`. See
[architecture-intent.md](architecture-intent.md).

## `result` (for `command: "graph"`)

`graph` emits a deterministic snapshot of the project graph. It is descriptive:
it exits `0` when it can build the snapshot, and `3` when coverage is incomplete.
It never exits `1`.

| field                   | type                         | meaning                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects`              | `{name, root, type, tags}[]` | Every project, sorted by `name` with plain string comparison. `tags` is sorted by plain string comparison (matching how `targets` is sorted), so two runs that differ only in tag declaration order produce byte-identical output. `type` is `"app"`, `"lib"` or `"e2e"`. `targets` is present only when declared, listing target names by key. |
| `dependencies`          | `{source, target, type}[]`   | Every edge as one flat array, sorted by `source`, then `target`, then `type`, all with plain string comparison. Edge identity is the full `(source, target, type)` triple.                                                                                                                                                                      |
| `workspaceLayout`       | `{appsDir, libsDir}`         | The layout the engine used when judging imports.                                                                                                                                                                                                                                                                                                |
| `workspaceLayoutSource` | `"declared"` \| `"default"`  | Whether the workspace named the layout (`"declared"`, from `nx.json` or `archkeep.json`) or the engine fell back to its built-in default (`"default"`).                                                                                                                                                                                         |
| `policy`                | `{fingerprint}` or absent    | When the workspace's own declaration named a boundary config (`graph` takes no `--config` flag), a `fingerprint` field holds a SHA-256 hex string of the canonicalized policy (`depConstraints`, `options`, `suppressions`). Absent when no config was given — the consumer did not provide one.                                                |

The graph snapshot deliberately does not publish Nx-internal fields such as
`mfeRemote`, `entryPoints`, or `declaredPackages`. They are implementation
details of the provider, not part of this schema.

## `result` (for `command: "diff"`)

`diff` compares a complete `graph --format json` snapshot file with the current
workspace. It takes a file path, not a Git ref:

```shell
archkeep diff baseline.json --format json
```

Both sides must be complete. An incomplete baseline or current workspace exits
`3` and produces no diff, because an apparent added or removed edge would then
be ambiguous between a real change and a coverage gap. `diff` is descriptive:
changes do not make it exit `1`; a completed comparison always exits `0`.

| field             | type                                   | meaning                                                                                                                                                                                                                                                                                                                     |
| ----------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseline`        | `{path, projects, edges, toolVersion}` | The baseline file path, its project/edge counts, and the `tool.version` that produced the snapshot (or `null` if the baseline predates that field). A consumer can compare `toolVersion` with the current version to audit same-schema semantic drift.                                                                      |
| `head`            | `{projects, edges}`                    | The current workspace's project/edge counts.                                                                                                                                                                                                                                                                                |
| `addedProjects`   | `{name, root, tags}[]`                 | Projects present in the current workspace but absent from the baseline, sorted by `name`.                                                                                                                                                                                                                                   |
| `removedProjects` | `{name, root, tags}[]`                 | Projects present in the baseline but absent from the current workspace, sorted by `name`.                                                                                                                                                                                                                                   |
| `changedProjects` | `{name, changes}[]`                    | Projects present in both but with different metadata, sorted by `name`. Each `changes` entry is `{field, baseline, head}`. Detected fields: `tags` (array content), `type` (`"app"`/`"lib"`/`"e2e"`/`null`), `root` (project directory).                                                                                    |
| `addedEdges`      | `{source, target, type}[]`             | Edges present in the current workspace but absent from the baseline, sorted by the full edge identity.                                                                                                                                                                                                                      |
| `removedEdges`    | `{source, target, type}[]`             | Edges present in the baseline but absent from the current workspace, sorted by the full edge identity.                                                                                                                                                                                                                      |
| `policyMismatch`  | `{baseline, head}` or absent           | Present when both the baseline snapshot and the head run carry a policy fingerprint and they disagree. `baseline.fingerprint` and `head.fingerprint` are the SHA-256 hex strings. The rule-impact section may reflect the policy change rather than a structural change. Absent when no mismatch or no config was provided. |
| `ruleImpact`      | `{introduced, resolved}` or absent     | Present when a boundary config with `depConstraints` was provided. `introduced` lists violations the added edges introduce; `resolved` lists violations the removed edges resolve. Covers only tag-based constraints (3 of 15 violation types) — see `coverage.notes`. Absent when no config was provided.                  |

## `result` (for `command: "delta"`)

`delta <baseline> --format json` wraps the compare mode's classification. The
capture mode (`delta --capture`) writes the evidence snapshot itself, not this
envelope — the snapshot has its own independent `schemaVersion`. Unlike
`diff`, `delta` is a gate: `status` is `"findings"` (exit `1`) when any
introduced violation is not covered by an active waiver or any custom-rule
finding was introduced, `"no-verdict"` (exit `3`) when any item — violation,
unresolvable record, or custom-rule item — could not be classified, and
`"ok"` (exit `0`) otherwise. Its refusals (unreadable or
foreign-schema baseline, provider mismatch, incomplete coverage on either
side) exit `3` having built no envelope at all. The envelope carries a
`decision` block, like `check`'s. [../usage/delta.md](../usage/delta.md) owns
the classification model.

| field           | type                                                                       | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseline`      | `{path, tool, provider, provenance, policyFingerprint, records, projects}` | The baseline side: the snapshot file path, the `{name, version}` of the tool that captured it, the provider it was captured under, its git provenance (`{commit, remote, dirty}` or `null`), its policy fingerprint, and its record and project counts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `head`          | `{provenance, policyFingerprint, records, projects}`                       | The current run's side: git provenance, the current policy's fingerprint, and the record and project counts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `policyChanged` | boolean                                                                    | Whether the two policy fingerprints differ. `true` is a disclosure, never a refusal: both sides are re-judged under the current law, and `coverage.notes` carries the warning that a violation a policy edit created or retired classifies as `unchanged`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `summary`       | object                                                                     | Bucket counts: `{introduced, introducedWaived, resolved, unchanged, unknown, unresolvable: {introduced, resolved, unchanged, unknown}}`. `introducedWaived` counts introduced entries the current waiver table covers — reported, not gating; `introduced - introducedWaived > 0` is exactly what makes `status` `"findings"`. When the `customRules` block below is present, a `customFindings: {introduced, resolved, unchanged, unknown}` key counts its buckets — absent otherwise, exactly as the block is.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `violations`    | `{introduced, resolved, unchanged, unknown}`                               | The classified boundary violations, one array per bucket — see the entry shape below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `unresolvable`  | `{introduced, resolved, unchanged, unknown}`                               | Import sites whose target analysis could not resolve, classified in their own category and never counted as violations — no rule reached a verdict about them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `customRules`   | absent \| `{judged, skipped, removed, findings}`                           | The classified custom-rule (wasm) findings. The key is **absent** (never `null`) when neither the current policy nor the baseline declares `customRules` — the same omitted-key discipline as `check`'s block, so an undeclaring workspace's envelope stays byte-identical. `judged` lists the rules evaluated on both sides (`{name, sha256, notes?}` — `notes` carries a side's `not_applicable` reason); `skipped` the rules that could not be judged (`{name, reason}` — digest/params drift, a rule the baseline never declared, a baseline with no custom-rule evidence, an evaluation failure); `removed` names rules the baseline declares that the head no longer does. `findings` is `{introduced, resolved, unchanged, unknown}`: classified entries carry `rule`, `findingId`, the `custom/<rule>/<finding>` `ruleId`, `project` (`null` when the finding names none), `message`, both sides' counts and sites, and the ladder's optional `reason`/`note`; `unknown` entries are `{classification, rule, reason}` (plus the offending `finding` where one exists) — one per skipped rule, one per finding with no usable id. No `waived` annotation by construction: suppressions key on a `messageId` custom findings do not have, so **every** introduced custom finding folds into `status: "findings"`, and every unknown into `"no-verdict"`. [../usage/delta.md](../usage/delta.md) owns the semantics. |

Each entry in `violations.introduced` / `.resolved` / `.unchanged` carries the
violation's **identity** — `messageId`, `sourceProject` (`null` when
unattributed), `target`, `targetIsSpecifier` (`true` when no project target
exists and the raw specifier stands in), `constraint` (the row that condemned
it, `null` for rules with none) — plus both sides' evidence: `baseCount`,
`headCount`, `baseSites[]` and `headSites[]` (each site
`{file, line, column, specifier, kind}`), `classification`, an optional
`reason` (why it is introduced: absent at base, or occurrence growth) or
`note` (`occurrencesReduced` on a shrink that is still not a resolution), and
the `waived` boolean — `true` when every live site is covered by the current
suppressions table at the shared reference instant, with the covering row in
`waivedBy`. Entries in `violations.unknown` are
`{classification, reason, violation}` — the original violation and why its
identity could not be stated.

Each entry in the `unresolvable` buckets keys on `{specifier, kind,
sourceProject}` instead of a violation identity and carries the same
count/site/`reason`/`note` fields; its `unknown` entries are
`{classification, reason, record}`. No `waived` annotation here by
construction: an unresolvable record has no verdict for a suppression row to
cover.

## `result` (for `command: "change"`)

`change <baseline> --intent <file> --format json` wraps the reconciliation of
a declared change-intent contract against the actual architectural delta.
`status` is `"findings"` (exit `1`) when any observed material change was not
declared, any declared change never happened, or any declared constraint
failed; `"no-verdict"` (exit `3`) when the base identity could not be proven
or a declared constraint could not be determined; `"ok"` (exit `0`) when the
reconciliation is matched with every declared constraint passing. Its
refusals (unreadable or foreign-schema baseline, provider mismatch, a
manifest that fails shape or reference validation, incomplete head coverage,
the unregistered-plugin graph) exit `3` having built no envelope at all. The
envelope carries a `decision` block. [../usage/change.md](../usage/change.md)
owns the model.

| field            | type                                                                       | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intent`         | `{file, version, base, summary?, declared}`                                | What was declared: the manifest path, its `version`, the required `base.commit` pin, the optional informational `summary` (absent when the manifest omitted it — it is never parsed or matched on), and `declared` — the counts `{projectsAdd, projectsRemove, edgesAdd, edgesRemove}` plus `constraints[]`, the declared constraint names in fixed evaluation order.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `baseline`       | `{path, tool, provider, provenance, policyFingerprint, projects, records}` | The base side: the snapshot file path, the capturing tool's `{name, version}`, its provider, git provenance (`{commit, remote, dirty}` or `null`), its policy fingerprint, and project/record counts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `head`           | `{provenance, policyFingerprint, projects}`                                | The current run's side: git provenance, the current law's fingerprint, project count.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `reconciliation` | `{verdict, reasons, matched, unexpected, missingExpected}`                 | The structural answer. `verdict` is `"matched"`, `"undeclared"`, `"unfulfilled"`, or `"unproven"` — when unexpected and missing items coexist the verdict reads `undeclared`, and every list stays present in full either way. `reasons` names why the identity is unproven (empty otherwise). Each item in the three lists carries `kind` (`project-added` \| `project-removed` \| `edge-added` \| `edge-removed` \| `project-changed`) plus its identity: `project` for project kinds, `from`/`to` for edge kinds (observed edges also carry the graph's `type`; expected ones do not — edges match on `(from, to)`), and `changes[]` (`{field, baseline, head}`) for `project-changed`. A metadata change to a project both sides have has **no declaration surface in this version**: it always lands in `unexpected`, because a tag change moves which rows of the boundary law reach the project. |
| `constraints`    | array                                                                      | One row per DECLARED constraint, in fixed order (`no-new-violations`, then `no-new-cycles`) — an omitted key was never asserted and produces no row. Each row is a canonical verdict record: `{verdict: "pass"\|"fail"\|"unknown", name, evidence, message}`. `unknown` (an unclassifiable delta item behind `no-new-violations`) makes `status` `"no-verdict"`; `fail` makes it `"findings"`. Left empty when the run is unproven — constraints are not judged over a base the run cannot vouch for.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `policy`         | `{fingerprint, changedSinceBase, liveViolations}`                          | The informational law axis, computed with the same engine over the whole tree. `liveViolations` is what `check` would count right now after the suppression table — it gates NOTHING here, and this command's report says so in as many words: `check` remains the authority on whether the law holds. `changedSinceBase` compares fingerprints; `coverage.notes` carries the same disclosure as `delta`'s. `liveViolations` is `null` when the run is unproven.                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## `result` (for `command: "drift"`)

`drift` compares the observed architecture to the workspace's declared intended
one — the tracked root `architecture-intent.json`. It is descriptive: it never
exits `1`, and it exits `3` when coverage is incomplete or the intent cannot be
verified against the observed graph. The intended side is a contract, and its
envelope names it by fingerprint so "no drift" always reads as a claim about a
specific declared intent.

| field                    | type                               | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intent`                 | object                             | `{file, fingerprint, rows}` — the resolved file name (`architecture-intent.json`), the SHA-256 fingerprint of the canonicalized intent, and the number of intent rows judged. Always present: `drift` requires a tracked intent file.                                                                                                                                                                                                                           |
| `observed`               | object                             | `{projects, edges, implicitEdges}` — the project count, the code-dependency edge count, and how many `implicit` (build-ordering, not code) edges were excluded. An empty finding list means "no drift among the code-dependency edges of exactly these projects".                                                                                                                                                                                               |
| `findings`               | object[]                           | Every intent row the observed architecture violates, each `{source, target, rule, boundaryFrom, boundaryTo, message}`. `rule` is one of the ten `judgeIntent` message ids (`intentForbiddenEdge`, `intentAllowedMissing`, `projectMissing`, `projectPresent`, `projectTagMissing`, `dependencyForbidden`, `dependencyNotAllowed`, `tagDependencyForbidden`, `intentUnknownProject`, `intentUnknownTag`). Sorted by a total key so two runs stay byte-identical. |
| `unresolvedDecisionRefs` | `{kind, decisionRef}[]` (optional) | Intent rows whose `decisionRef` resolves to no ADR, rule, or fitness record the workspace's `docs/adr/` registry knows. `kind` is the row's path (`forbidden[0]`, `projects.required[2]`, …). Present only when non-zero. A documentation fact about the row's citation, never a drift finding — it never appears in `findings` above and never changes `status`/`exitCode`.                                                                                    |

`drift` never returns a `"findings"` status or exit `1`. Whatever the descriptive
command prints, the failing verdict is `check`'s job — and `check` folds drift in
by presence, so a building workspace that violates its declared intent fails the
same gate that reports the boundary violations.

## `result` (for `command: "waivers"`)

`waivers` lists the whole `boundarySuppressions` surface — both the WAIVER
rows (carrying `expiresAt`) and the PERMANENT ones (no `expiresAt`) — with each
row's term (waivers only) and the violations it currently covers. It is
descriptive: it never exits `1`, and it exits `0` whenever the surface could be
read. The envelope's `status` is always `"ok"` on a completed run; a surface
that only accepts violations is a fact the run reports, not a finding.

A permanent suppression never appears in `check`'s findings at all — the
violation is removed outright, which is the mechanism working as designed —
so `result.suppressions`/`result.suppressed` are the only place in the whole
JSON surface that names one. Both fields are present on every envelope
(possibly `[]`/`0`), unlike the additive `waived` field on `check`'s own
envelope, because a consumer parsing this specific command's result needs to
tell "measured, found none" apart from a field an older client would read as
simply absent.

| field                | type      | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `waivers`            | object[]  | Every waiver on the table, sorted by `path` then `expiresAt` (byte-identical across runs). Each row is the suppression row plus `status` (`"active"` \| `"expired"`), `remainingMs` (negative when expired, epoch-ms precision), and `covered` (how many violations it currently accepts, judged against the full finding set with the table removed).                                                                                               |
| `covered`            | number    | How many waivers currently match at least one violation.                                                                                                                                                                                                                                                                                                                                                                                             |
| `expired`            | number    | How many waivers have lapsed — their `expiresAt` is at or before the reference instant, so each ACCEPTS nothing and its violation re-asserts in `check`. It may still MATCH one; see the note below.                                                                                                                                                                                                                                                 |
| `stale`              | number    | How many waivers match no violation right now, whatever their term — the count of rows that are dead weight until edited away.                                                                                                                                                                                                                                                                                                                       |
| `suppressions`       | object[]  | Every PERMANENT suppression on the table (no `expiresAt`), sorted by `path`. Each row is the suppression row plus `covered` — no `status`/`remainingMs`, since a permanent row carries no term.                                                                                                                                                                                                                                                      |
| `suppressed`         | number    | How many DISTINCT violations, across the whole raw finding set, at least one permanent suppression currently hides. Two overlapping rows covering the same violation still count it once.                                                                                                                                                                                                                                                            |
| `unownedAcceptances` | object[]? | Present exactly when the policy declares [`coverage.unowned`](policy-schema.md#coverage) — absent otherwise, so an unchanged tree's envelope is unchanged. One `{path, reason, covered}` entry per declared row, in declaration order: `covered` is how many unowned files the row currently accepts, across both unowned sets. Zero means the row is dead weight — this surface names it, and `check` refuses it outright on a whole-workspace run. |

Each `waivers` entry:

| field         | type    | meaning                                                                                                                                                                                             |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`        | string  | Glob over the workspace-relative path of the importing file, as declared.                                                                                                                           |
| `reason`      | string  | Why the acceptance exists — shown verbatim.                                                                                                                                                         |
| `messageId`   | string? | The check the waiver narrows to, when the row narrowed it.                                                                                                                                          |
| `expiresAt`   | string  | The instant the waiver stops covering anything.                                                                                                                                                     |
| `origin`      | string? | Where the row came from, when declared — a ticket id or decision record.                                                                                                                            |
| `status`      | string  | `"active"` before `expiresAt`, `"expired"` at or after it.                                                                                                                                          |
| `remainingMs` | number  | Epoch-ms until expiry; negative when expired. The wall clock at the moment of this run, not a fact about the workspace — see "The stability promise" above; `coverage.notes` names it on every run. |
| `covered`     | number  | Violations this row MATCHES, judged against the full finding set with the whole table removed — independent of the term. Zero means the row is stale: it is about nothing.                          |

`covered` counts what a row is ABOUT, never what it currently accepts, so
`status` and `covered` move independently: an expired waiver still matching a
live violation reads `status: "expired"`, `covered: 1`, and does not raise
`stale`. That is the pairing [waivers.md](../concepts/waivers.md) calls expired
but not stale, and folding the term into `covered` would collapse the two into
one number. What an expired row accepts is zero, and that fact appears where it
acts — the violation is back in `check`'s findings, carrying
`evidence: "expired waiver"`.

Each `suppressions` entry carries `path`, `reason`, `messageId?` and `origin?`
with the same meaning as the `waivers` entry above, plus `covered` (current
violations this row hides, judged against the full finding set — zero means
the row is dead weight, same as a stale waiver). It carries no `expiresAt`,
`status` or `remainingMs`: a permanent suppression has no term for those
fields to describe.

## `result` (for `command: "fitness"`)

`fitness` judges every function the boundary policy declares and renders one
verdict per function plus an overall one. Unlike the other read-only commands,
its verdict IS a finding: a `fail` is `status: "findings"` and exit `1`, an
`unknown` is `"no-verdict"` and exit `3` — the same two lanes `check` uses when
it folds the same registry in (`result.fitness` on a `check` envelope carries
the same per-function decisions under `functions`).

| field       | type                                                | meaning                                                                                                                                                                                                                                                                          |
| ----------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verdict`   | `"pass"`\|`"fail"`\|`"unknown"`\|`"not_applicable"` | The overall verdict across every declared function: `fail` if any failed, else `unknown` if any is undetermined, else `not_applicable` only when EVERY function is — never when one merely is — else `pass`. [usage/fitness.md](../usage/fitness.md) owns the exit-code mapping. |
| `functions` | object[]                                            | One decision per declared function, in declaration order.                                                                                                                                                                                                                        |

Each `functions` entry:

| field                 | type     | meaning                                                                                                                                                                                                          |
| --------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                | string   | The function's declared `name`. The condition's internal rule name (`tag-axis-isolation:module`) is not carried on the record at all; a condition whose parameters matter to a consumer puts them in `evidence`. |
| `verdict`             | string   | One of the four.                                                                                                                                                                                                 |
| `evidence`            | object   | The deterministic facts the verdict is a claim over. Per condition type; every value is sorted or counted, never a clock.                                                                                        |
| `message`             | string   | Human text naming what was decided and why — the same line the text report prints.                                                                                                                               |
| `rows`                | object[] | The observed detail behind the verdict, per condition. `[]` when the verdict needs none.                                                                                                                         |
| `notApplicableReason` | string?  | Present only on `not_applicable`, per invariant I4 ([evidence.md](evidence.md)) — so "did not apply" is never indistinguishable from "did not run".                                                              |

`rows` is per condition type, and a consumer branching on it should branch on
the function's condition rather than assume one shape. For `tag-axis-isolation`
each row is `{source, target, sourceValues, targetValues}` — the edge that
crossed a partition boundary and the values that placed each end
([fitness-functions.md](../concepts/fitness-functions.md)).

## `result` (for `command: "reconcile"`)

`reconcile` scores the declared intended model against the observed architecture
element by element — the inverse of `drift`. It is descriptive: it never exits
`1`, and it exits `3` when coverage is incomplete or the intent cannot be
verified against the observed graph. It never writes into
`architecture-intent.json`; with `--propose` the envelope carries the ranked
candidate list of model edits under the always-true `proposed` /
`notAuthoritative` markers.

| field              | type                 | meaning                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intent`           | object               | `{file, fingerprint, rows}` — the resolved file name (`architecture-intent.json`), the SHA-256 fingerprint of the canonicalized intent, and the number of intent rows scored. Always present: `reconcile` requires a tracked intent file.                                                                                                                                                                   |
| `observed`         | object               | `{projects, edges, implicitEdges}` — the project count, the code-dependency edge count, and how many `implicit` (build-ordering, not code) edges were excluded.                                                                                                                                                                                                                                             |
| `scores`           | object               | `{projects, edges, tags, boundaries, intentRows}` — the scored element arrays. Each element is `{plane, name, state, severity, classification, confidence, intentRow}`; `intentRow` is `{plane, index, kind, key}` (the exact intent row an operator would edit) or `null` for an observed-only element.                                                                                                    |
| `unknownFiles`     | `{file, reason}[]`   | Whole-file failures the analyzer never reached a verdict about. Always empty on a completed run — the command refuses on the first one.                                                                                                                                                                                                                                                                     |
| `candidates`       | absent \| `object[]` | Present only with `--propose`. The ranked candidate list, each `{kind, plane, name, state, severity, evidence, intentRow, edit, proposed: true, notAuthoritative: true}`, sorted by severity then plane then name (plain string comparison). `kind` is `"add"`, `"removal"`, `"tag-change"`, or `"boundary-change"`; `edit` names the intent section and action (`{section, action, key, value?, reason}`). |
| `proposed`         | absent \| `true`     | Present only with `--propose`, always `true`.                                                                                                                                                                                                                                                                                                                                                               |
| `notAuthoritative` | absent \| `true`     | Present only with `--propose`, always `true`.                                                                                                                                                                                                                                                                                                                                                               |

`reconcile` never returns a `"findings"` status or exit `1`: describing and
proposing divergence is not a finding. An empty `scores` divergence means the
observed architecture matches the intended model; a run that could not complete
the comparison exits `3` with no envelope rather than report a clean one.

## `result` (for `command: "history"`)

`history` reads a consumer-managed directory of `graph --format json` snapshots
and describes the architecture's evolution: each snapshot in history order and
the classified transition between consecutive snapshots. It is descriptive: it
never exits `1`. An empty directory or an unreadable snapshot is a no-verdict
run (exit 3) that produces no envelope, not a record of an empty history.

| field         | type             | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dir`         | string           | The history directory that was read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `captured`    | `null` \| object | `null` when the run did not `--capture`. Otherwise `{name, id, duplicate}` — the snapshot file written, with `duplicate: false`, or, when its architecture identity already was the last snapshot, the existing file it deduplicated against with `duplicate: true`. `duplicate` is always present, so the envelope's shape is not a function of history-directory state (the two captures of an unchanged tree differ in exactly this one readable field, never in which keys exist).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `snapshots`   | `{name, id}[]`   | Every snapshot, in filename byte-sort order (which is history order). `name` is `<sequence>-<sha8>.json`; `id` is the full SHA-256 architecture identity (the canonicalized `projects`/`dependencies`/`policy.fingerprint` — never the workspace header).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `transitions` | `object[]`       | One entry per consecutive pair of snapshots, in order. Each `{from, to, architectureChanged, changes, policyChanged, providerChanged, codeDrift, notes}`. `changes` is the `diff`-style `{addedProjects, removedProjects, changedProjects, addedEdges, removedEdges}` — the graph diff when the architecture moved, **an empty object when only the provider changed** (the carrier changed, nothing on top of it), else `null` (a policy-only or drift transition). `policyChanged` is `true`/`false` or `null` when unverifiable (one snapshot carries a fingerprint and the other does not); `null` **means "could not be compared" and must not be folded into `false`** — a consumer branching on it must treat only an explicit `true` as a policy change. `codeDrift` is only ever asserted when the policy was actually compared and unchanged (`policyChanged === false`) and provenance advanced — an unverifiable policy never yields code drift. `notes` discloses every one-sided, cross-repo, or dirty-tree caveat rather than reading the case as unchanged. |

`history` never recomputes rule-impact from stored snapshots — a snapshot
carries the graph and the policy fingerprint, not the constraint table or
import sites — so `coverage.notes` states that limit on every record.

## `result` (for `command: "trajectory"`)

`trajectory` reads the same history directory `history` reads and aggregates
it: which deterministic signals fired how often across ALL observations, what
the graph gained and lost in total versus net, and what persisted through
every observation. It is descriptive: it never exits `1`. An empty, unreadable,
or malformed history directory is a no-verdict run (exit 3) that produces no
envelope.

**A trend here is a fact that moved, not a judgment.** No field weights a
signal, scores the architecture, or implies "healthier" or "worse" — every
number is read off stored bytes or derived from them by the stated rules
below, and deciding what the movement means belongs to the consumer.

One observation is ONE stored `graph --format json` snapshot — a capture
point, not a commit, a day, or a capture attempted (`observations.basis`
names it). Identities are `diff`'s own: a project IS its `name`; an edge IS
its `(source, target, type)` triple, so an edge type flip counts as one
removal plus one addition.

| field               | type           | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dir`               | string         | The history directory that was read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `observations`      | object         | `{count, basis, first, last, withProvenance, dirtyProvenance}`. `count` is the number of stored snapshots aggregated; `basis` is `"graph_snapshots"`; `first`/`last` name the boundary snapshot files. `withProvenance` counts observations carrying git provenance — the denominator the code-drift signal actually needs — and `dirtyProvenance` counts those captured from uncommitted trees.                                                                                                                                                                                            |
| `available`         | boolean        | Whether a trajectory could be derived at all. `false` only when the directory holds fewer than two snapshots: there is no consecutive pair to classify.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `unavailableReason` | string \| null | `"insufficient_history"` when `available` is `false`, else `null`. A named value, so a consumer branches on a documented constant rather than on prose.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `transitions`       | object         | `{count, architecture, policy, provider, codeDrift, incomparable, unchanged}` — independent signal counts over the consecutive pairs, NOT a partition (a pair moving architecture, policy, and provider at once counts under all three, and the counters can sum above `count`). The classification is the same single law `history` applies (`classifyTransition`). `unchanged` is stricter than `history`'s per-transition label: a pair whose fingerprint or provenance was one-sided does **not** count as unchanged here, because an aggregate has no notes line to carry that caveat. |
| `disclosures`       | object         | `{policyOneSided, provenanceOneSided, crossRepo}` — how many pairs carried each asymmetric-evidence caveat. Counted from the metadata comparison itself, never parsed out of prose. `policyOneSided + provenanceOneSided ≥ transitions.incomparable` need not be tight because one pair can carry both caveats.                                                                                                                                                                                                                                                                             |
| `projects`          | object         | The project axis: `{first, current, delta, addedEvents, removedEvents, changedEvents, introduced, resolved, persistent}` — see the field rules below.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `edges`             | object         | The edge axis, same fields except `changedEvents`, which is always `null`: under the triple identity an edge type change IS a removal plus an addition, so there is no third kind of edge event to count.                                                                                                                                                                                                                                                                                                                                                                                   |

The axis-field rules (identical for `projects` and `edges`):

- Fields ending in `Events` count transition EVENTS, cumulatively — an entity
  that churns (add → remove → add) contributes two additions and one removal
  even though its first and last observation sets agree.
- `introduced` / `resolved` compare ENDPOINT sets only: present in the last
  but not the first observation (`introduced`), or present in the first but
  not the last (`resolved`). An entity missing from a MIDDLE observation is
  visible in the events and in `persistent`, never in these.
- `persistent` counts entities present in EVERY observation, first through
  last — the sweep that keeps an add-remove-add pattern from reading as
  stable.
- `delta` is `current − first`.
- When `available` is `false`, every derived field (`delta`, the three event
  counts, `introduced`, `resolved`, `persistent`) is `null` — explicitly
  unavailable, never zero. `first`/`current` stay factual counts of the one
  observation.

No violation-level trajectory exists here by design: stored snapshots carry
no findings, so no finding identity can persist across them. `coverage.notes`
states both that limit and the observation basis on every envelope.

## `result` (for `command: "evolution"`)

`evolution` describes the architecture's evolution across a selected range of
Git revisions. Both endpoints are resolved in the workspace's repository, every
selected commit is materialized into a temporary detached worktree and analyzed
by the ordinary pipeline, and each consecutive pair is classified by exactly
the machinery `history` uses — with the full commit SHA standing in for the
snapshot filename. It is descriptive: it never exits `1`. An unusable range or
an unanalyzable revision is a no-verdict run (exit 3) that produces no
envelope, never a shorter history.

| field         | type             | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base`        | string           | The full SHA-1 of the resolved baseline revision — the first analyzed revision, whatever spelling named it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `head`        | string           | The full SHA-1 of the resolved tip revision — the last analyzed revision.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `revisions`   | `{commit, id}[]` | Every analyzed revision, oldest-first (`base` first, `head` last). `commit` is the full SHA-1; `id` is the same SHA-256 architecture identity `history` computes for a snapshot. A revision appears once per commit; there are no gaps and no silent skips — a revision that cannot be analyzed refuses the whole run instead.                                                                                                                                                                                                                                                                                                                                                        |
| `transitions` | `object[]`       | One entry per consecutive pair of revisions, in order — the same `{from, to, architectureChanged, changes, policyChanged, providerChanged, codeDrift, notes}` shape `history` emits, with `from`/`to` naming full commit SHAs. Each change is attributed to the first analyzed revision where it is observable: **where history shows it, not why it was made** — nothing here reads a commit message or infers intent. `policyChanged` compares the boundary law each revision's own tree declares; it is `null` when neither side declares one, and must not be folded into `false`. Linear ranges only: a merge commit inside the range refuses the run rather than flattening it. |

The envelope header's `workspace` block describes the tree the command ran in
(the caller's checkout), while every transition classifies revisions
materialized from committed state — so `workspace.provenance.dirty` may be
`true` without any analyzed revision carrying it, and `coverage.notes`
discloses that split whenever the working tree is dirty.

## `result` (for `command: "health"`)

`health` reports deterministic architecture-health metrics for the current
workspace. It is descriptive: it never exits `1`. Each metric carries a verdict
in the canonical vocabulary (`ok`, `findings`, `not_applicable`, `unknown`),
and a metric's `value` is present **only when** the verdict is `ok` or
`findings` — a `not_applicable` or `unknown` metric carries no number, because
a number over no evidence would read as a measured zero. The status is `"ok"`
(exit 0) when every metric reached a verdict, and `"no-verdict"` (exit 3) when
any metric is `unknown`.

| field      | type             | meaning                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trendDir` | `null` \| string | The snapshot directory read for trends, or `null` when none was given.                                                                                                                                                                                                                                                                                                                                                 |
| `metrics`  | object           | One entry per metric, each `{verdict, value?, note?}` — `projects`, `edges`, `coverage`, `violations`, `waiverSurface`, `cycles`, `edgeDensity`, `debt`, `fitness`. `note` explains a `not_applicable` or `unknown` verdict and is absent for a measured one. `edgeDensity` is descriptive (`ok` + ratio — a pressure gauge, not a pass/fail); `waiverSurface` is a fact on the books (`ok` + count), never a finding. |
| `trends`   | `null` \| object | `null` when no snapshot directory was given. Otherwise `{snapshots: [{name, projects, dependencies}], notes: string[]}` — the structural metrics per snapshot in history order, with the disclosure that rule-impact cannot be re-derived from stored bytes.                                                                                                                                                           |

The `coverage` envelope field carries the run's completeness facts, and
`coverage.notes` discloses an unregistered Nx plugin (a graph with no
Go/Rust/Python edges) so the metrics that needed those edges read `unknown`
rather than a measured zero.

## `result` (for `command: "report"`)

`report` is the whole governance document in one envelope: the same `metrics`
and `trends` `health` emits, plus the waiver surface, the fitness gates, the
recorded decisions each governed row cites, and the run's provenance. Every
number is produced by the function the owning command calls, so a consumer
reading this envelope and one reading `health`/`waivers`/`fitness`/`adr` cannot
disagree about the same tree.

It is descriptive: `status` is `"ok"` (exit 0) or `"no-verdict"` (exit 3),
never `"findings"` — a live boundary violation or a failing fitness gate is
carried in the payload and still exits 0, because the commands that own those
verdicts own their exit codes. It carries **no `decision` field**: a decision
must agree with its status, and this status is about whether the document could
be _established_, not about whether the architecture is healthy.

| field           | type             | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trendDir`      | `null` \| string | The snapshot directory read for trends, or `null` when none was given.                                                                                                                                                                                                                                                                                                                                                                             |
| `metrics`       | object           | `health`'s metrics, unchanged — see the `health` section above for every entry and the `value`-only-when-measured rule.                                                                                                                                                                                                                                                                                                                            |
| `trends`        | `null` \| object | `health`'s trends, unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `waivers`       | object           | `{verdict, note, counts, rows}`. `not_applicable` when no boundary law is declared, `unknown` (with `counts: null`) when the surface could not be established. Each row is `{kind, path, status, covered, reason, expiresAt}` — `remainingMs` is deliberately absent (see the determinism note above), and a suppression row has no `decisionRef` field to carry (`SUPPRESSION_KEYS` admits `path`, `messageId`, `reason`, `expiresAt`, `origin`). |
| `fitness`       | object           | `{verdict, note, functions}`. `not_applicable` when the law declares no gates. Each function is `{name, verdict, message, adrs}`, where `adrs` is the ADR ids binding it, `[]` when none does, and `null` when the registry could not be read.                                                                                                                                                                                                     |
| `decisions`     | object           | `{verdict, note, registry: {dir, count}, records, citations}`. `count` is `null` when the registry could not be read (never `0`, which is the real "this workspace records no ADRs"). Each citation is `{kind, label, decisionRef, resolution, adr}` with `resolution` one of `adr`, `fitness`, `unknown`.                                                                                                                                         |
| `provenance`    | object           | `{repo, established, policySource, rows}`. `established: false` carries `{commit: null, remote: null, dirty: null}` — a stated absence, not a claim. `rows.unattested` names every governed row with no `origin` record.                                                                                                                                                                                                                           |
| `uninspectable` | object[]         | Every piece of evidence the run could not establish, as `{surface, reason}`. **Unconditional**: an empty array is itself the claim "every surface was inspectable". Non-empty exactly when `status` is `"no-verdict"`.                                                                                                                                                                                                                             |

## `result` (for `command: "debt"`)

`debt` reads the same history directory `history` reads and builds the
architecture-debt ledger: every waiver the boundary config accepts, every
`optional` intent row not yet built, and every drift finding the intent judge
reports — each aged across the snapshots by the owning project. It is
descriptive: it never exits `1`. An unreadable or malformed history directory,
incomplete graph coverage, or an intent that cannot be verified is a no-verdict
run (exit 3) that produces no envelope, never an empty ledger.

| field        | type       | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dir`        | string     | The history directory that was read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `snapshots`  | number     | The number of snapshots the ledger was aged across.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `agings`     | boolean    | `true` when at least two snapshots could establish age; `false` when the directory holds fewer than two, in which case every entry's `age` is `0` and reads "observed, not yet aged" rather than "born yesterday".                                                                                                                                                                                                                                                                                                                                                                                          |
| `sampleTime` | string     | ISO-8601 instant the ledger was taken, from the same clock seam the CLI passes in — so a reader can see when a report was produced, and a fixed clock makes two runs over an unchanged tree byte-identical. The wall clock at the moment of this run otherwise, not a fact about the workspace; `coverage.notes` names it on every run (see "The stability promise" above).                                                                                                                                                                                                                                 |
| `entries`    | `object[]` | One entry per debt. Each `{source, kind, severity, age, count, remediationHint}`. `kind` is `"waiver"` (an accepted violation), `"aspirational-gap"` (an `optional` intent row not yet built), `"drift"` (a finding — HIGH when its source project also carries a waiver), or `"unresolved"` (an intent boundary that matched nothing; `severity` is `"unknown"`, never a clean ledger). `source` is the suppression path for a waiver, the finding's project for drift, the intent statement for a gap, and the boundary name for unresolved. Entries sort by plain string comparison of kind-then-source. |
| `total`      | number     | `entries.length`. An empty list is a claim — "no exemptions, gaps or findings" — never a shrug.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `byKind`     | object     | Counts per `kind`: `{waiver, "aspirational-gap", drift, unresolved}`. Always present, even when zero, so a consumer can tell "no debt" from "the report forgot a section".                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `bySeverity` | object     | Counts per `severity`: `{high, medium, low}`. `unknown`-severity entries are excluded. Always present.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## `result` (for `command: "impact"`)

`impact` takes a project name and lists every project that transitively depends
on it. It is descriptive: it never exits `1`, because a reverse-reachability
listing is never a finding.

| field              | type                 | meaning                                                                                                                                                                                                                                                                  |
| ------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `project`          | string               | The project whose impact was queried.                                                                                                                                                                                                                                    |
| `direct`           | `string[]`           | Projects whose edges point straight at the target, sorted by plain string comparison.                                                                                                                                                                                    |
| `transitive`       | `string[]`           | Projects that reach the target only through another project, sorted by plain string comparison.                                                                                                                                                                          |
| `dependents`       | `string[]`           | The union of `direct` and `transitive`, sorted by plain string comparison. An empty list is a claim.                                                                                                                                                                     |
| `constraintImpact` | `object[]` or absent | Present when a boundary config with `depConstraints` was provided. Each entry is `{project, edges, constraintRows, violations}` for a dependent. Covers only tag-based constraints (3 of 15 violation types) — see `coverage.notes`. Absent when no config was provided. |

## `result` (for `command: "explain"`)

`explain` takes a `file:line:column` site and explains the judgment for that one
import. It is descriptive: it never exits `1`, because an explanation is never a
finding.

Two shapes, depending on whether the import resolved:

**Resolved import:**

| field                | type                                              | meaning                                                                                                                                                                      |
| -------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site`               | `{file, line, column}`                            | The site that was explained, 1-based.                                                                                                                                        |
| `import`             | `{specifier, kind, sourceProject, targetProject}` | The import at that site. `sourceProject` and `targetProject` are `null` when the record resolved to no project.                                                              |
| `sourceTags`         | `string[]`                                        | The source project's tags, empty when unresolvable.                                                                                                                          |
| `targetTags`         | `string[]`                                        | The target project's tags, empty when unresolvable.                                                                                                                          |
| `matchedConstraints` | `object[]`                                        | The constraint rows from the boundary law whose `sourceTag`/`allSourceTags` matched the source project. Empty when none matched.                                             |
| `violations`         | `null` \| `object[]`                              | The violations, if any. `null` when the import is allowed. Each entry is described below.                                                                                    |
| `verdict`            | `"violation"` \| `"clean"`                        | The judgment for this one site. Site-level and descriptive: a `"violation"` verdict still ships with `status: "ok"` and exit `0`, because an explanation is never a finding. |

Each `violations` entry carries `messageId`, `message`, and `constraint` — the
same three fields as each entry in `check`'s `result.violations` — plus two
guaranteed keys of its own:

| field         | type                 | meaning                                                                                                                                                                                                                                                                                                                            |
| ------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `remediation` | `string` \| `null`   | The author-declared `remediation` string from the governing constraint row, verbatim. `null` means the workspace declared none — consult the `constraint` row and its `decisionRef`/ADR. Never engine-generated text: Archkeep does not invent fixes.                                                                              |
| `allowed`     | `string[]` \| `null` | The governing row's own `onlyDependOnLibsWithTags` list, verbatim from the law. `null` when the row states no allowed list — a `notDependOnLibsWithTags` row, or a check no `depConstraints` row drives — because a complement computed from a ban list would be a direction the law never stated; read `constraint` itself there. |

Both keys are present on every entry — an explicit `null`, never an absent
key — so a consumer can tell "no declared remediation" from a field that does
not exist.

For an agent consuming this envelope: `verdict` says WHETHER this site
violates; `constraint` plus `allowed` say WHICH LAW governs it and the
direction that law states; `remediation` is the workspace author's guidance,
or `null` meaning "consult the constraint and its recorded decision". None of
the three is an instruction to edit the policy — Archkeep supplies evidence
and the consumer decides, per
[the architecture-authority doctrine](../doctrine/architecture-authority.md).

**Unresolvable site** (dynamic import with non-literal argument):

| field          | type                   | meaning                                                            |
| -------------- | ---------------------- | ------------------------------------------------------------------ |
| `site`         | `{file, line, column}` | The site that was explained, 1-based.                              |
| `verdict`      | `"unknown"`            | No judgment was reached for this site — never to be read as clean. |
| `unresolvable` | `true`                 | This site's target is not statically knowable.                     |
| `reason`       | string                 | Why the site is unresolvable (e.g. "non-literal argument").        |

## `result` (for `command: "context"`)

`context` takes a project name and shows the architecture constraints that
govern it. It is descriptive: it never exits `1`, because a description of what
the rules say is never a finding.

| field                    | type                  | meaning                                                                                                                                                                                                                                                                                                       |
| ------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project`                | string                | The project whose context was queried.                                                                                                                                                                                                                                                                        |
| `tags`                   | `string[]`            | The project's tags, from the project graph.                                                                                                                                                                                                                                                                   |
| `constraints`            | `object[]`            | The constraint rows from the boundary law whose `sourceTag`/`allSourceTags` matched the project's tags, with what each allows or bans.                                                                                                                                                                        |
| `dependencies`           | `object[]`            | The project's outgoing edges, each with `target`, `type`, and `violations` from the constraint table.                                                                                                                                                                                                         |
| `unresolvedDecisionRefs` | `string[]` (optional) | `decisionRef` values from `constraints` above that resolve to no ADR, rule, or fitness record the workspace's `docs/adr/` registry knows — sorted, deduplicated, present only when non-zero. The same documentation-only fact `check`'s field of the same name states, scoped to this project's matched rows. |

Each `dependencies` entry:

| field        | type       | meaning                                                                                            |
| ------------ | ---------- | -------------------------------------------------------------------------------------------------- |
| `target`     | string     | The project this edge reaches.                                                                     |
| `type`       | string     | The edge type: `"static"` or `"dynamic"`.                                                          |
| `violations` | `object[]` | Constraint violations for this edge from `judgeEdge`. Empty means allowed by the constraint table. |

Each `violations` entry inside a dependency carries `messageId`, `constraint`, `source`, and `target` — the same shape `diff --format json` and `impact --format json` produce for edge-constraint violations.

## `result` for `context --plan`

`context <project> --plan` builds the same envelope as plain `context`. The
`result.project/tags/constraints/dependencies` fields are present at the same
top-level paths and carry the same shapes as the plain command, so a consumer
that already reads the plain `context` envelope keeps working unchanged.
`command` is still `"context"`; the plan's fields sit under `result.plan`
alongside the four base fields, and `result.plan.variant` is `"plan"` so a
consumer can tell a planning context from a plain one without guessing from
field presence.

| field                    | type               | meaning                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan.variant`           | string             | Always `"plan"` — marks this context envelope as a planning context.                                                                                                                                                                                                                                                                                                                    |
| `project`                | string             | The target project the change is about (same as the plain `result.project`).                                                                                                                                                                                                                                                                                                            |
| `tags`                   | `string[]`         | The target project's tags (same as the plain `result.tags`).                                                                                                                                                                                                                                                                                                                            |
| `constraints`            | `object[]`         | The constraint rows that govern the target project (same as the plain `result.constraints`), each carrying the author's `description`/`remediation` — the workspace's Intent — when the config states them.                                                                                                                                                                             |
| `dependencies`           | `object[]`         | The target project's dependencies with per-edge verdicts (same as the plain `result.dependencies`).                                                                                                                                                                                                                                                                                     |
| `plan.policyFingerprint` | string             | SHA-256 fingerprint of the boundary policy (`depConstraints`/`options`/`suppressions`), so a later run can tell whether the rule table changed.                                                                                                                                                                                                                                         |
| `plan.architecture`      | `object`           | The current graph snapshot (`projects`, `dependencies`) and which projects the change touches (`targets`).                                                                                                                                                                                                                                                                              |
| `plan.impact`            | `object[]`         | Per affected project, who depends on it. Dependents are capped at 10; `dependentsTotal` and `hasMore` state the true total and overflow.                                                                                                                                                                                                                                                |
| `plan.violations`        | `object[]`         | The full-workspace rule-engine verdict (`evaluate` over the whole analyzeable tree), scoped for reporting to the change's projects.                                                                                                                                                                                                                                                     |
| `plan.drift`             | `object`           | `goWork` and `tsconfigPaths` drift — an absent manifest is `null` (not judged), never "no drift".                                                                                                                                                                                                                                                                                       |
| `plan.intent`            | absent \| `object` | The canonical Architecture Intent verdict — the same model `check` and `drift` judge. The key is **absent** (never `null`) when the workspace has no tracked `architecture-intent.json`, matching `check`. When present: `{verified: true, file: "architecture-intent.json", verdict: "ok"\|"findings"\|"no-verdict", rows, findings, unresolved, boundaries, notes}`.                  |
| `plan.verify`            | `string[]`         | The deterministic commands an agent runs after the change. These are suggestions, not executed by Archkeep.                                                                                                                                                                                                                                                                             |
| `plan.provenance`        | object             | The same repository-provenance record the envelope's `workspace.provenance` carries — `{commit: string, remote: string\|null, dirty: boolean}`, `null` when git is unavailable, and (like the envelope's `workspace.provenance`) **absent entirely** when the workspace is a git repository with no commits — that state is a could-not-look (exit 3, no envelope), never a null field. |

The `coverage.notes` array carries planning-specific limitations: that the
verdict is whole-tree scoped for reporting, that drift is keyed off manifest
presence, that dependents are capped, and — when paths were given but matched
no project-owned file — that the scope fell back to the whole workspace.

History is deliberately out of scope for the planning context: it carries no
before/after comparison. For architecture history between two graph
snapshots, run `archkeep diff <baseline>` separately.

## A worked example

An abridged clean run in the shape of `archkeep`'s own CI step (`AGENTS.md`'s
"The repository's own module boundaries") — the `intent` and `fitness` blocks a
full run on this tree also carries follow the field tables above; here, three
declared blind spots and nothing else to say:

```json
{
  "schemaVersion": 2,
  "tool": {
    "name": "@ecoma-io/archkeep",
    "version": "0.0.0"
  },
  "command": "check",
  "workspace": {
    "root": "/path/to/workspace",
    "provider": "nx",
    "marker": "nx.json",
    "provenance": {
      "commit": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      "remote": "https://github.com/example/workspace.git",
      "dirty": false
    }
  },
  "status": "ok",
  "exitCode": 0,
  "coverage": {
    "complete": true,
    "projects": 2,
    "analyzedFiles": 120,
    "imports": 420,
    "notAnalyzed": [],
    "blindSpots": [
      {
        "file": "packages/archkeep/src/config.mjs",
        "line": 582,
        "column": 27,
        "reason": "'import(pathToFileURL(path).href)' has a non-literal argument, so its target is not knowable statically"
      },
      {
        "file": "packages/archkeep/src/eslint-config.mjs",
        "line": 399,
        "column": 27,
        "reason": "'import(pathToFileURL(path).href)' has a non-literal argument, so its target is not knowable statically"
      },
      {
        "file": "packages/archkeep/src/lsp/boundary-config.mjs",
        "line": 61,
        "column": 27,
        "reason": "'import(url)' has a non-literal argument, so its target is not knowable statically"
      }
    ],
    "notes": [],
    "coverageGaps": []
  },
  "result": {
    "policy": {
      "profile": null,
      "source": "module-boundaries.config.mjs",
      "fingerprint": "c2f0a1e79b3d4568e2f1a0c9d8b7e6f5a4c3b2d1e0f9a8b7c6d5e4f3a2b1c0d9"
    },
    "violations": [],
    "goWork": null,
    "tsconfigPaths": null,
    "declaredEdges": null
  },
  "decision": { "verdict": "pass" }
}
```

Three declared blind spots, zero violations, `goWork`/`tsconfigPaths`/
`declaredEdges` all `null` — this workspace has no `go.work`, no tsconfig
`paths` table, and no `implicit`-typed edge —
and `status: "ok"` because every one of the 120 analyzed files reached a
verdict; the three blind spots are site-level, not whole-file, so they never
touch `coverage.complete`. `decision` renders the same verdict in the
vocabulary: `{ "verdict": "pass" }`. `policy` names the law behind all of it:
no profile, the repository's own `module-boundaries.config.mjs`, and its
fingerprint — so this exact clean verdict is tied to this exact policy, not
merely to "whatever ran".

## What this is not, yet

This page is the schema reference for the `--format json` envelope.
