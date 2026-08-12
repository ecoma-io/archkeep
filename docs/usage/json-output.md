# `--format json`

`check --format json` wraps the same verdict the terminal report and SARIF
already carry in one versioned envelope. It changes no exit code and no byte
of the other two formats — it is a third rendering of a verdict every format
already computes, for a script that wants to branch on a field rather than
scrape a report or walk a SARIF `runs[]` array.

```shell
lattice check --format json
lattice check --format json --output report.json
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

`command` is the one field that varies today only because `check` is the only
command that produces this envelope — `src/report/json.mjs` (the module that
builds it) and `src/commands/README.md` (the module layout it follows) are
both written for a second command to reuse it without a second wrapper.

## Top-level fields

| field           | type                                     | meaning                                                                                                                                                                 |
| --------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion` | integer                                  | This document's version. Currently `1`.                                                                                                                                 |
| `tool`          | `{name, version}`                        | `name` is always `"@ecoma-io/lattice"`; `version` is the installed package's own `package.json` version.                                                                |
| `command`       | string                                   | Which command produced this envelope. `"check"` today.                                                                                                                  |
| `workspace`     | `{root, provider, marker}`               | `root` is the resolved workspace root (absolute path); `provider` is `"nx"` or `"native"`; `marker` is the root file that decided it (`"nx.json"` or `"lattice.json"`). |
| `status`        | `"ok"` \| `"findings"` \| `"no-verdict"` | The verdict. See below.                                                                                                                                                 |
| `exitCode`      | `0` \| `1` \| `3`                        | The same code the process exits with — never `2`: a usage error never reaches far enough to build an envelope.                                                          |
| `coverage`      | object                                   | What the run inspected, and what it could not. See below.                                                                                                               |
| `result`        | object                                   | The command's own payload — for `check`, the violations and the two workspace-level checks. See below.                                                                  |

## `status`, and the exit code it must agree with

Three values, and each one carries exactly one `exitCode` — `jsonEnvelope`
(`src/report/json.mjs`) throws rather than build an envelope where the two
disagree, so this table is not just documentation, it is enforced:

| `status`       | `exitCode` | meaning                                                                                                                                                                                                          |
| -------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"ok"`         | `0`        | No findings, and every selected file was analyzed.                                                                                                                                                               |
| `"findings"`   | `1`        | Boundary violations, go.work drift, or dead tsconfig path aliases — one or more of `result.violations`, `result.goWork.findings`, `result.tsconfigPaths.findings` is non-empty.                                  |
| `"no-verdict"` | `3`        | The run found no findings but could not fully read the tree — `coverage.complete` is `false`. Never mistake this for `"ok"`: a checker that could not look must never read as one that looked and found nothing. |

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

## `coverage`

What the run inspected, so "no violations" reads as a claim about coverage,
not only about correctness — the same principle the terminal report's
`file:line:column` counts state out loud.

| field           | type                             | meaning                                                                                                                                                                                                                                          |
| --------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `complete`      | boolean                          | `true` only when `notAnalyzed` is empty — enforced, not just correlated.                                                                                                                                                                         |
| `projects`      | number                           | Project count in the graph this run judged against.                                                                                                                                                                                              |
| `analyzedFiles` | number                           | Files the analyzer produced a verdict for.                                                                                                                                                                                                       |
| `imports`       | number                           | Import sites judged against the boundary law.                                                                                                                                                                                                    |
| `notAnalyzed`   | `{file, reason}[]`               | Whole-file failures: a file the analyzer never reached a verdict about at all (unreadable, no analyzer, a config it depends on that would not load). Non-empty here is exactly what makes `complete` false and forces `status` away from `"ok"`. |
| `blindSpots`    | `{file, line, column, reason}[]` | Site-level failures: the file WAS analyzed, but one import site's target is not statically knowable (e.g. a dynamic `import()` with a non-literal argument). These do not affect `complete` — the file was judged.                               |
| `notes`         | string[]                         | Notes about how the boundary law itself was read — today, only the ESLint `boundaryConfig` dialect ever populates this, naming which `files`-scoped entry it bound.                                                                              |

The distinction between `notAnalyzed` and `blindSpots` is the same one the
terminal report draws under two separate headings, and it is load-bearing:
losing a whole file is a coverage hole (`status: "no-verdict"` when nothing
else fired); one unresolvable site inside an otherwise-analyzed file is a
declared limit the run states and moves past.

## `result` (for `command: "check"`)

| field           | type                                  | meaning                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `violations`    | `Violation[]`                         | Every boundary-rule violation, in the shape `src/rules/index.mjs`'s `Violation` typedef defines: `sourceFile`, `line`, `column` (both 1-based), `specifier`, `kind`, `messageId`, `message`, `sourceProject`, `targetProject`, `constraint`, `data`.                                                                                                          |
| `goWork`        | `null` \| `{checked: true, findings}` | `null` when the workspace has no tracked `go.work` — no check, no claim, same as the text report's silence. Otherwise `checked: true` and `findings` is the array `compareGoWork` (`src/go-work.mjs`) returns: `{messageId, file, line, column, directory, project, message}` each, `line`/`column` `null` for a workspace-level finding with no single site. |
| `tsconfigPaths` | `null` \| `{checked: true, findings}` | `null` when the workspace tsconfig declares no `paths` table — same silence. Otherwise `checked: true` and `findings` is the array `judgeTsconfigPaths` (`src/tsconfig-paths.mjs`) returns: `{messageId: "tsconfigDeadPathAlias", file, line: null, column: null, alias, targets, message}` each.                                                             |

`goWork` and `tsconfigPaths` are `null` rather than an empty array with
`checked: false` on purpose: a workspace with no `go.work` and one with a
`go.work` that agrees with the graph both produce zero findings, and only the
`null`/`{checked: true, findings: []}` split tells the two apart — the same
"no manifest, no check, no claim" rule the text report and `docs/usage/ci.md`
already state.

## A worked example

Run over this repository's own tree (`lattice`'s own CI step,
`AGENTS.md`'s "The repository's own module boundaries"), a clean run with
three declared blind spots and nothing else to say:

```json
{
  "schemaVersion": 1,
  "tool": {
    "name": "@ecoma-io/lattice",
    "version": "0.0.0"
  },
  "command": "check",
  "workspace": {
    "root": "/path/to/workspace",
    "provider": "nx",
    "marker": "nx.json"
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
    "notes": []
  },
  "result": {
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
touch `coverage.complete`.

## What this is not, yet

This page lives under `docs/usage/` alongside the rest of what a consumer
reads to run the tool day to day. A later documentation pass (tracked as part
of the repository's own roadmap work, not by this page) is expected to move it
under a `docs/reference/` section once one exists — a schema reference reads
differently from a how-to guide, and `docs/README.md`'s ownership map is where
that move, if it happens, gets recorded. Until then, this is the page.
