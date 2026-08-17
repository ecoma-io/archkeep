# `--format json`

`check --format json`, `graph --format json`, `diff --format json`,
`discover --format json`, `drift --format json`, `reconcile --format json`,
`waivers --format json`, `fitness --format json`, `history --format json`,
`health --format json`, `debt --format json`, `impact --format json`,
`explain --format json`, `context --format json`, `provenance --format
json`, and `adr --format json` wrap the same verdict the terminal report
and SARIF already carry in one versioned envelope. They change no exit code and no byte
of the other two formats — they are additional renderings of a verdict every
format already computes, for a script that wants to branch on a field rather
than scrape a report or walk a SARIF `runs[]` array.

```shell
lattice check --format json
lattice check --format json --output report.json
lattice graph --format json
lattice graph --format json --output snapshot.json
lattice diff snapshot.json --format json
lattice diff snapshot.json --format json --output delta.json
lattice waivers --format json
lattice waivers --format json --output waivers.json
lattice history .lattice/history --format json
lattice history .lattice/history --format json --output evolution.json
lattice debt .lattice/history --format json
lattice debt .lattice/history --format json --output debt.json
lattice impact billing-core --format json
lattice impact billing-core --format json --output impact.json
lattice explain libs/alpha/main.go:10:5 --format json
lattice explain libs/alpha/main.go:10:5 --format json --output explain.json
lattice context billing-core --format json
lattice context billing-core --format json --output context.json
```

## The stability promise

**Every field name here, and `schemaVersion` itself, are a public contract
from the release that ships this page.** A script that parses this output
today keeps working on every later 1.x release: no field is renamed, no field
changes type, and no field that means one thing today is repurposed to mean
another. A capability that does not fit the current shape ships as a new
field, additive, never as a change to an existing one.

`schemaVersion` is an integer, and it only moves for a breaking change to this
document — a field renamed, retyped, or removed. A consumer that reads a
`schemaVersion` it does not recognise should refuse to parse the rest of the
envelope rather than guess: an unrecognised version is a caller reading a
contract from the future, not a workspace fact.

**The envelope is deterministic.** Two runs over an unchanged tree, with an
unchanged `lattice` version, produce byte-identical JSON — same key order
(insertion order, matching the shape below), same array order, no timestamp
and no random identifier anywhere in it. That is what makes it diffable in a
pull request the same way the SARIF output already is.

`command` is the one field that varies by which command produced the envelope —
`"check"`, `"graph"`, `"diff"`, `"discover"`, `"drift"`, `"reconcile"`,
`"waivers"`, `"fitness"`, `"history"`, `"health"`, `"debt"`, `"impact"`,
`"explain"`, `"context"`, `"provenance"`, or `"adr"`. `src/report/json.mjs`
(the module that builds the envelope) and `src/commands/README.md` (the
module layout it follows) are both written for each command to reuse the same
wrapper.

## Top-level fields

| field           | type                                     | meaning                                                                                                                                                                                                                                                                                                                 |
| --------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion` | integer                                  | This document's version. Currently `2`.                                                                                                                                                                                                                                                                                 |
| `tool`          | `{name, version}`                        | `name` is always `"@ecoma-io/lattice"`; `version` is the installed package's own `package.json` version.                                                                                                                                                                                                                |
| `command`       | string                                   | Which command produced this envelope. `"check"`, `"graph"`, `"diff"`, `"discover"`, `"drift"`, `"reconcile"`, `"waivers"`, `"fitness"`, `"history"`, `"health"`, `"debt"`, `"impact"`, `"explain"`, `"context"`, `"provenance"`, or `"adr"`.                                                                            |
| `workspace`     | `{root, provider, marker, provenance}`   | `root` is the resolved workspace root (absolute path); `provider` is `"nx"`, `"native"`, or `"moon"`; `marker` is the root file or directory that decided it (`"nx.json"`, `"lattice.json"`, `".moon"`, or `".config/moon"`). `provenance` is the git origin of the run, or `null` when git is unavailable — see below. |
| `status`        | `"ok"` \| `"findings"` \| `"no-verdict"` | The verdict. See below.                                                                                                                                                                                                                                                                                                 |
| `exitCode`      | `0` \| `1` \| `3`                        | The same code the process exits with — never `2`: a usage error never reaches far enough to build an envelope.                                                                                                                                                                                                          |
| `decision`      | object \| absent                         | The same verdict in the four-state vocabulary — `{verdict, reason?, notApplicableReason?, sampleTime?}`. Present on every `check` envelope; see [evidence.md](evidence.md).                                                                                                                                             |
| `coverage`      | object                                   | What the run inspected, and what it could not. See below.                                                                                                                                                                                                                                                               |
| `result`        | object                                   | The command's own payload — for `check`, the violations, the two workspace-level checks, and — when the workspace has one — the architecture-intent verdict. See below.                                                                                                                                                 |

## `status`, and the exit code it must agree with

Three values, and each one carries exactly one `exitCode` — `jsonEnvelope`
(`src/report/json.mjs`) throws rather than build an envelope where the two
disagree, so this table is not just documentation, it is enforced:

| `status`       | `exitCode` | meaning                                                                                                                                                                                                                                                                                            |
| -------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"ok"`         | `0`        | No findings, and every selected file was analyzed.                                                                                                                                                                                                                                                 |
| `"findings"`   | `1`        | Boundary violations, declared-edge violations, go.work drift, dead tsconfig path aliases, or architecture-intent findings — one or more of `result.violations`, `result.declaredEdges.findings`, `result.goWork.findings`, `result.tsconfigPaths.findings`, `result.intent.findings` is non-empty. |
| `"no-verdict"` | `3`        | The run found no findings but could not fully read the tree — `coverage.complete` is `false` — or architecture intent could not be established. Never mistake this for `"ok"`: a checker that could not look must never read as one that looked and found nothing.                                 |

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
`check` envelope and absent from every other command's, and its `verdict` is
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

| field           | type                             | meaning                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `complete`      | boolean                          | `true` only when `notAnalyzed` is empty — enforced, not just correlated.                                                                                                                                                                                                                                                                                                                       |
| `projects`      | number                           | Project count in the graph this run judged against.                                                                                                                                                                                                                                                                                                                                            |
| `analyzedFiles` | number                           | Files the analyzer produced a verdict for.                                                                                                                                                                                                                                                                                                                                                     |
| `imports`       | number                           | Import sites judged against the boundary law.                                                                                                                                                                                                                                                                                                                                                  |
| `notAnalyzed`   | `{file, reason}[]`               | Whole-file failures: a file the analyzer never reached a verdict about at all (unreadable, no analyzer, a config it depends on that would not load). Non-empty here is exactly what makes `complete` false and forces `status` away from `"ok"`.                                                                                                                                               |
| `blindSpots`    | `{file, line, column, reason}[]` | Site-level failures: the file WAS analyzed, but one import site's target is not statically knowable (e.g. a dynamic `import()` with a non-literal argument). These do not affect `complete` — the file was judged.                                                                                                                                                                             |
| `notes`         | string[]                         | Caveats about how the result should be interpreted: ESLint dialect parsing (`check`), provider mismatches between baseline and head (`diff`), provenance gaps (`diff`), policy fingerprint disagreements (`diff`), or depConstraints narrowing (`context`, `impact`).                                                                                                                          |
| `coverageGaps`  | `{kind, manifests}[]`            | Gaps in Nx-graph coverage that the checker's own analysis covers but `nx affected` and `@nx/enforce-module-boundaries` do not. Currently only one kind: `"unregistered-plugin"` — an Nx workspace whose `nx.json` does not register this plugin but whose tracked files include polyglot manifests (`go.mod`, `Cargo.toml`, `pyproject.toml`) under project roots. Empty when there is no gap. |

The distinction between `notAnalyzed` and `blindSpots` is the same one the
terminal report draws under two separate headings, and it is load-bearing:
losing a whole file is a coverage hole (`status: "no-verdict"` when nothing
else fired); one unresolvable site inside an otherwise-analyzed file is a
declared limit the run states and moves past.

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

| field           | type                                                                   | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy`        | `{profile, source, fingerprint}`                                       | Which law governed this run, named first — a verdict is a claim about which policy produced it too. `profile` is the active profile's name, or `null` when the workspace did not select one by name ([profiles.md](../concepts/profiles.md)). `source` is the workspace-relative path this run actually read the policy from: the `--config` file, the declared `boundaryConfig` file, the profile registry, or (an inline `lattice.json` policy has no file of its own) `lattice.json` itself. `fingerprint` is the same SHA-256 hex `graph`'s own `policy.fingerprint` computes, below — two runs under the identical effective policy always agree, regardless of `source`. Always present: `check` cannot judge anything without loading exactly one policy first.  |
| `violations`    | `Violation[]`                                                          | Every boundary-rule violation, in the shape `src/rules/index.mjs`'s `Violation` typedef defines: `sourceFile`, `line`, `column` (both 1-based), `specifier`, `kind`, `messageId`, `message`, `sourceProject`, `targetProject`, `constraint`, `data`. A violation an ACTIVE waiver accepted additionally carries `waivedBy` (the suppressing row) and one re-asserted by an EXPIRED waiver carries `evidence` (`"expired waiver"`) — a waived violation is still `violations`, so the exit code stays 1.                                                                                                                                                                                                                                                                 |
| `waived`        | number (optional)                                                      | How many violations an ACTIVE waiver accepted, present only when non-zero — an unchanged tree's envelope is unchanged, and the accepted count is a tracked decision, never a new error kind.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `goWork`        | `null` \| `{checked: true, findings}`                                  | `null` when the workspace has no tracked `go.work` — no check, no claim, same as the text report's silence. Otherwise `checked: true` and `findings` is the array `compareGoWork` (`src/go-work.mjs`) returns: `{messageId, file, line, column, directory, project, message}` each, `line`/`column` `null` for a workspace-level finding with no single site.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `tsconfigPaths` | `null` \| `{checked: true, findings}`                                  | `null` when the workspace tsconfig declares no `paths` table — same silence. Otherwise `checked: true` and `findings` is the array `judgeTsconfigPaths` (`src/tsconfig-paths.mjs`) returns: `{messageId: "tsconfigDeadPathAlias", file, line: null, column: null, alias, targets, message}` each.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `declaredEdges` | `null` \| `{checked: true, judged, findings}`                          | `null` when the graph has no `implicit`-typed edge at all (`implicitDependencies` in a `project.json`/`lattice.json` row) — same silence. Otherwise `checked: true`, `judged` is how many `implicit` edges the graph carried, and `findings` is the array `declaredEdgeViolationsForCheck` (`src/commands/edge-constraints.mjs`) returns: `{messageId, file, line: null, column: null, source, target, constraint, data, message}` each — the same `depConstraints` verdicts (`onlyDependOnLibsWithTags`, `notDependOnLibsWithTags`, `projectWithoutTagsCannotHaveDependencies`) `context`/`impact` already show for the identical edge, reused here rather than re-derived, judged against an edge that has no import site and so cannot appear in `violations` above. |
| `intent`        | absent \| `{checked, file, verdict, findings, unresolved, boundaries}` | The architecture-intent verdict. The key is **absent** (never `null`) when the workspace has no tracked `architecture-intent.json` — no intent declared, no claim, and an intent-less envelope is byte-identical to one predating this feature. When present, `checked: true`, `file` is `"architecture-intent.json"`, `verdict` is `"ok"` \| `"findings"` \| `"no-verdict"`, `findings` is the array of `{source, target, rule, boundaryFrom, boundaryTo, message}` records, `unresolved` lists the boundaries (or row sides) that matched no observed project, and `boundaries` is the membership that was judged, `[{name, projects}]`.                                                                                                                              |

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

| field                   | type                         | meaning                                                                                                                                                                                                                                                                                                                                |
| ----------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects`              | `{name, root, type, tags}[]` | Every project, sorted by `name` with plain string comparison. `tags` is sorted by plain string comparison (matching how `targets` is sorted), so two runs that differ only in tag declaration order produce byte-identical output. `type` is `"app"` or `"lib"`. `targets` is present only when declared, listing target names by key. |
| `dependencies`          | `{source, target, type}[]`   | Every edge as one flat array, sorted by `source`, then `target`, then `type`, all with plain string comparison. Edge identity is the full `(source, target, type)` triple.                                                                                                                                                             |
| `workspaceLayout`       | `{appsDir, libsDir}`         | The layout the engine used when judging imports.                                                                                                                                                                                                                                                                                       |
| `workspaceLayoutSource` | `"declared"` \| `"default"`  | Whether the workspace named the layout (`"declared"`, from `nx.json` or `lattice.json`) or the engine fell back to its built-in default (`"default"`).                                                                                                                                                                                 |
| `policy`                | `{fingerprint}` or absent    | When the boundary config was provided (via `--config` or the workspace's own declaration), a `fingerprint` field holds a SHA-256 hex string of the canonicalized policy (`depConstraints`, `options`, `suppressions`). Absent when no config was given — the consumer did not provide one.                                             |

The graph snapshot deliberately does not publish Nx-internal fields such as
`mfeRemote`, `entryPoints`, or `declaredPackages`. They are implementation
details of the provider, not part of this schema.

## `result` (for `command: "diff"`)

`diff` compares a complete `graph --format json` snapshot file with the current
workspace. It takes a file path, not a Git ref:

```shell
lattice diff baseline.json --format json
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
| `changedProjects` | `{name, changes}[]`                    | Projects present in both but with different metadata, sorted by `name`. Each `changes` entry is `{field, baseline, head}`. Detected fields: `tags` (array content), `type` (`"app"`/`"lib"`/`null`), `root` (project directory).                                                                                            |
| `addedEdges`      | `{source, target, type}[]`             | Edges present in the current workspace but absent from the baseline, sorted by the full edge identity.                                                                                                                                                                                                                      |
| `removedEdges`    | `{source, target, type}[]`             | Edges present in the baseline but absent from the current workspace, sorted by the full edge identity.                                                                                                                                                                                                                      |
| `policyMismatch`  | `{baseline, head}` or absent           | Present when both the baseline snapshot and the head run carry a policy fingerprint and they disagree. `baseline.fingerprint` and `head.fingerprint` are the SHA-256 hex strings. The rule-impact section may reflect the policy change rather than a structural change. Absent when no mismatch or no config was provided. |
| `ruleImpact`      | `{introduced, resolved}` or absent     | Present when a boundary config with `depConstraints` was provided. `introduced` lists violations the added edges introduce; `resolved` lists violations the removed edges resolve. Covers only tag-based constraints (3 of 15 violation types) — see `coverage.notes`. Absent when no config was provided.                  |

## `result` (for `command: "drift"`)

`drift` compares the observed architecture to the workspace's declared intended
one — the tracked root `architecture-intent.json`. It is descriptive: it never
exits `1`, and it exits `3` when coverage is incomplete or the intent cannot be
verified against the observed graph. The intended side is a contract, and its
envelope names it by fingerprint so "no drift" always reads as a claim about a
specific declared intent.

| field      | type     | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intent`   | object   | `{file, fingerprint, rows}` — the resolved file name (`architecture-intent.json`), the SHA-256 fingerprint of the canonicalized intent, and the number of intent rows judged. Always present: `drift` requires a tracked intent file.                                                                                                                                                                                                                           |
| `observed` | object   | `{projects, edges, implicitEdges}` — the project count, the code-dependency edge count, and how many `implicit` (build-ordering, not code) edges were excluded. An empty finding list means "no drift among the code-dependency edges of exactly these projects".                                                                                                                                                                                               |
| `findings` | object[] | Every intent row the observed architecture violates, each `{source, target, rule, boundaryFrom, boundaryTo, message}`. `rule` is one of the ten `judgeIntent` message ids (`intentForbiddenEdge`, `intentAllowedMissing`, `projectMissing`, `projectPresent`, `projectTagMissing`, `dependencyForbidden`, `dependencyNotAllowed`, `tagDependencyForbidden`, `intentUnknownProject`, `intentUnknownTag`). Sorted by a total key so two runs stay byte-identical. |

`drift` never returns a `"findings"` status or exit `1`. Whatever the descriptive
command prints, the failing verdict is `check`'s job — and `check` folds drift in
by presence, so a building workspace that violates its declared intent fails the
same gate that reports the boundary violations.

## `result` (for `command: "waivers"`)

`waivers` lists the waiver surface — every `boundarySuppressions` row carrying
an `expiresAt` — with each row's term and the violations it currently covers.
It is descriptive: it never exits `1`, and it exits `0` whenever the surface
could be read. The envelope's `status` is always `"ok"` on a completed run; a
surface that only accepts violations is a fact the run reports, not a finding.

| field     | type     | meaning                                                                                                                                                                                                                                                                                                                                                |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `waivers` | object[] | Every waiver on the table, sorted by `path` then `expiresAt` (byte-identical across runs). Each row is the suppression row plus `status` (`"active"` \| `"expired"`), `remainingMs` (negative when expired, epoch-ms precision), and `covered` (how many violations it currently accepts, judged against the full finding set with the table removed). |
| `covered` | number   | How many waivers currently cover at least one violation.                                                                                                                                                                                                                                                                                               |
| `expired` | number   | How many waivers have lapsed — their `expiresAt` is at or before the reference instant, so each covers nothing and its violation re-asserts.                                                                                                                                                                                                           |
| `stale`   | number   | How many waivers cover no violation right now, active or expired — the count of rows whose reason has lapsed and that are dead weight until edited away.                                                                                                                                                                                               |

Each `waivers` entry:

| field         | type    | meaning                                                                                                                     |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `path`        | string  | Glob over the workspace-relative path of the importing file, as declared.                                                   |
| `reason`      | string  | Why the acceptance exists — shown verbatim.                                                                                 |
| `messageId`   | string? | The check the waiver narrows to, when the row narrowed it.                                                                  |
| `expiresAt`   | string  | The instant the waiver stops covering anything.                                                                             |
| `origin`      | string? | Where the row came from, when declared — a ticket id or decision record.                                                    |
| `status`      | string  | `"active"` before `expiresAt`, `"expired"` at or after it.                                                                  |
| `remainingMs` | number  | Epoch-ms until expiry; negative when expired.                                                                               |
| `covered`     | number  | Current violations accepted by this row, judged against the full finding set. Zero means the row is stale — covers nothing. |

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
| `captured`    | `null` \| object | `null` when the run did not `--capture`. Otherwise `{name, deduplicated?}` — the snapshot file written (or, when its architecture identity already was the last snapshot, the existing file it deduplicated against with `deduplicated: true`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `snapshots`   | `{name, id}[]`   | Every snapshot, in filename byte-sort order (which is history order). `name` is `<sequence>-<sha8>.json`; `id` is the full SHA-256 architecture identity (the canonicalized `projects`/`dependencies`/`policy.fingerprint` — never the workspace header).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `transitions` | `object[]`       | One entry per consecutive pair of snapshots, in order. Each `{from, to, architectureChanged, changes, policyChanged, providerChanged, codeDrift, notes}`. `changes` is the `diff`-style `{addedProjects, removedProjects, changedProjects, addedEdges, removedEdges}` — the graph diff when the architecture moved, **an empty object when only the provider changed** (the carrier changed, nothing on top of it), else `null` (a policy-only or drift transition). `policyChanged` is `true`/`false` or `null` when unverifiable (one snapshot carries a fingerprint and the other does not); `null` **means "could not be compared" and must not be folded into `false`** — a consumer branching on it must treat only an explicit `true` as a policy change. `codeDrift` is only ever asserted when the policy was actually compared and unchanged (`policyChanged === false`) and provenance advanced — an unverifiable policy never yields code drift. `notes` discloses every one-sided, cross-repo, or dirty-tree caveat rather than reading the case as unchanged. |

`history` never recomputes rule-impact from stored snapshots — a snapshot
carries the graph and the policy fingerprint, not the constraint table or
import sites — so `coverage.notes` states that limit on every record.

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
| `sampleTime` | string     | ISO-8601 instant the ledger was taken, from the same clock seam the CLI passes in — so a reader can see when a report was produced, and a fixed clock makes two runs over an unchanged tree byte-identical.                                                                                                                                                                                                                                                                                                                                                                                                 |
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

| field                | type                                              | meaning                                                                                                                          |
| -------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `site`               | `{file, line, column}`                            | The site that was explained, 1-based.                                                                                            |
| `import`             | `{specifier, kind, sourceProject, targetProject}` | The import at that site. `sourceProject` and `targetProject` are `null` when the record resolved to no project.                  |
| `sourceTags`         | `string[]`                                        | The source project's tags, empty when unresolvable.                                                                              |
| `targetTags`         | `string[]`                                        | The target project's tags, empty when unresolvable.                                                                              |
| `matchedConstraints` | `object[]`                                        | The constraint rows from the boundary law whose `sourceTag`/`allSourceTags` matched the source project. Empty when none matched. |
| `violations`         | `null` \| `{messageId, message, constraint}[]`    | The violations, if any. Same shape as each entry in `check`'s `result.violations`. `null` when the import is allowed.            |

**Unresolvable site** (dynamic import with non-literal argument):

| field          | type                   | meaning                                                     |
| -------------- | ---------------------- | ----------------------------------------------------------- |
| `site`         | `{file, line, column}` | The site that was explained, 1-based.                       |
| `unresolvable` | `true`                 | This site's target is not statically knowable.              |
| `reason`       | string                 | Why the site is unresolvable (e.g. "non-literal argument"). |

## `result` (for `command: "context"`)

`context` takes a project name and shows the architecture constraints that
govern it. It is descriptive: it never exits `1`, because a description of what
the rules say is never a finding.

| field          | type       | meaning                                                                                                                                |
| -------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `project`      | string     | The project whose context was queried.                                                                                                 |
| `tags`         | `string[]` | The project's tags, from the project graph.                                                                                            |
| `constraints`  | `object[]` | The constraint rows from the boundary law whose `sourceTag`/`allSourceTags` matched the project's tags, with what each allows or bans. |
| `dependencies` | `object[]` | The project's outgoing edges, each with `target`, `type`, and `violations` from the constraint table.                                  |

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

| field                    | type               | meaning                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan.variant`           | string             | Always `"plan"` — marks this context envelope as a planning context.                                                                                                                                                                                                                                                                                                   |
| `project`                | string             | The target project the change is about (same as the plain `result.project`).                                                                                                                                                                                                                                                                                           |
| `tags`                   | `string[]`         | The target project's tags (same as the plain `result.tags`).                                                                                                                                                                                                                                                                                                           |
| `constraints`            | `object[]`         | The constraint rows that govern the target project (same as the plain `result.constraints`), each carrying the author's `description`/`remediation` — the workspace's Intent — when the config states them.                                                                                                                                                            |
| `dependencies`           | `object[]`         | The target project's dependencies with per-edge verdicts (same as the plain `result.dependencies`).                                                                                                                                                                                                                                                                    |
| `plan.policyFingerprint` | string             | SHA-256 fingerprint of the boundary policy (`depConstraints`/`options`/`suppressions`), so a later run can tell whether the rule table changed.                                                                                                                                                                                                                        |
| `plan.architecture`      | `object`           | The current graph snapshot (`projects`, `dependencies`) and which projects the change touches (`targets`).                                                                                                                                                                                                                                                             |
| `plan.impact`            | `object[]`         | Per affected project, who depends on it. Dependents are capped at 10; `dependentsTotal` and `hasMore` state the true total and overflow.                                                                                                                                                                                                                               |
| `plan.violations`        | `object[]`         | The full-workspace rule-engine verdict (`evaluate` over the whole analyzeable tree), scoped for reporting to the change's projects.                                                                                                                                                                                                                                    |
| `plan.drift`             | `object`           | `goWork` and `tsconfigPaths` drift — an absent manifest is `null` (not judged), never "no drift".                                                                                                                                                                                                                                                                      |
| `plan.intent`            | absent \| `object` | The canonical Architecture Intent verdict — the same model `check` and `drift` judge. The key is **absent** (never `null`) when the workspace has no tracked `architecture-intent.json`, matching `check`. When present: `{verified: true, file: "architecture-intent.json", verdict: "ok"\|"findings"\|"no-verdict", rows, findings, unresolved, boundaries, notes}`. |
| `plan.verify`            | `string[]`         | The deterministic commands an agent runs after the change. These are suggestions, not executed by Lattice.                                                                                                                                                                                                                                                             |
| `plan.provenance`        | object             | null                                                                                                                                                                                                                                                                                                                                                                   | The same repository-provenance record the envelope's `workspace.provenance` carries. |

The `coverage.notes` array carries planning-specific limitations: that the
verdict is whole-tree scoped for reporting, that drift is keyed off manifest
presence, that dependents are capped, and — when paths were given but matched
no project-owned file — that the scope fell back to the whole workspace.

History is deliberately out of scope for the planning context: it carries no
before/after comparison. For architecture history between two graph
snapshots, run `lattice diff <baseline>` separately.

## A worked example

Run over this repository's own tree (`lattice`'s own CI step,
`AGENTS.md`'s "The repository's own module boundaries"), a clean run with
three declared blind spots and nothing else to say:

```json
{
  "schemaVersion": 2,
  "tool": {
    "name": "@ecoma-io/lattice",
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
  "decision": { "verdict": "pass" },
  "coverage": {
    "complete": true,
    "projects": 2,
    "analyzedFiles": 120,
    "imports": 420,
    "notAnalyzed": [],
    "blindSpots": [
      {
        "file": "packages/lattice/src/config.mjs",
        "line": 582,
        "column": 27,
        "reason": "'import(pathToFileURL(path).href)' has a non-literal argument, so its target is not knowable statically"
      },
      {
        "file": "packages/lattice/src/eslint-config.mjs",
        "line": 399,
        "column": 27,
        "reason": "'import(pathToFileURL(path).href)' has a non-literal argument, so its target is not knowable statically"
      },
      {
        "file": "packages/lattice/src/lsp/boundary-config.mjs",
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
    "tsconfigPaths": null
  }
}
```

Three declared blind spots, zero violations, `goWork`/`tsconfigPaths` both
`null` — this workspace has neither a `go.work` nor a tsconfig `paths` table —
and `status: "ok"` because every one of the 120 analyzed files reached a
verdict; the three blind spots are site-level, not whole-file, so they never
touch `coverage.complete`. `decision` renders the same verdict in the
vocabulary: `{ "verdict": "pass" }`. `policy` names the law behind all of it:
no profile, the repository's own `module-boundaries.config.mjs`, and its
fingerprint — so this exact clean verdict is tied to this exact policy, not
merely to "whatever ran".

## What this is not, yet

This page is the schema reference for the `--format json` envelope.
