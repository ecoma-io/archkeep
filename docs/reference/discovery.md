# `lattice discover`

Report the observed architecture, and optionally propose the candidate
architecture those observations imply.

```shell
lattice discover
lattice discover --propose
lattice discover --format json
lattice discover --propose --format json --output proposal.json
```

`discover` takes no positional arguments — the observed side is the whole
project graph. It is descriptive: it never exits 1, never writes to the
workspace, and never exits with a finding.

## The observed side

The same project graph the other commands read, from any provider (Nx, Moon, or
a native `lattice.json` workspace). `discover` reports the projects (name, root,
type, tags), the observed edges (with implicit edges and edges to external
packages dropped, the same filter `drift` applies), the union of observed tags,
and the analysis coverage — how many imports, files and projects were judged,
and which files could not be analyzed. The coverage line leads the report, so
the reader knows whether the observations are complete before reading any entry.

## `--propose`

`--propose` computes the candidate architecture over those same observations and
prints it beneath a banner:

```text
proposed architecture — NOT authoritative, never written
```

Every candidate carries the markers `proposed: true` and
`notAuthoritative: true`, both in the text report (a `[proposed — not
authoritative]` prefix on every line) and in the JSON envelope. Four candidate
classes — components, boundary assertions, tag vocabulary and rules — each with
its evidence and an uncertainty marker (`high`/`medium`/`low`), and a confidence
legend counting candidates at each level. The derivation rules and the
simplifications they make are the subject of
[discovery.md](../concepts/discovery.md).

The proposal is **never written** to `architecture-intent.json`. The evaluator
is pure — it cannot even express the write. Whether a candidate later becomes
intent is a governance decision owned elsewhere.

## Fail-closed

`discover` refuses loudly on every path that cannot reach a verdict, all
exit-3 class:

- the workspace model cannot be loaded (malformed `lattice.json`, `nx graph` or
  `git` failure);
- the observed side has incomplete coverage (whole files the analyzer could not
  read);
- under `--propose`, incomplete coverage is a **refusal**, not a warning — a
  proposal over an unread tree would be a fabrication wearing a proposal's name;
- an Nx workspace has polyglot manifests but the plugin is not registered.

A workspace with zero projects is **not** a refusal: zero observed projects is a
complete observation, and the proposal is the empty one with `unknown: true`.
Nothing observed means nothing to propose — never a fabricated candidate set.

## Exit codes

| code | meaning                                                                                  |
| ---- | ---------------------------------------------------------------------------------------- |
| 0    | The observation completed (whether or not anything was proposed).                        |
| 2    | Usage error: positional arguments given, unknown flag.                                   |
| 3    | Coverage incomplete, the model could not be loaded, or the plugin gap refuses the graph. |

`discover` never exits 1 — describing (or proposing) architecture is not a
finding.

## Flags

| flag        | argument       | default | meaning                                                             |
| ----------- | -------------- | ------- | ------------------------------------------------------------------- |
| `--format`  | `text`\|`json` | `text`  | Terminal report or the versioned JSON envelope.                     |
| `--output`  | `<file>`       | stdout  | Write the report to a file instead of stdout.                       |
| `--propose` | (none)         | off     | Compute and print the candidate architecture over the observations. |

`--output` writes atomically (write to `.tmp`, then rename) so a reader never
sees a truncated file. A write failure is exit 3.

## The JSON envelope

`--format json` wraps the same observations in the versioned envelope
`json-output.md` documents, with `discover`'s payload under `result`:

```json
{
  "command": "discover",
  "status": "ok",
  "exitCode": 0,
  "coverage": { "complete": true, "projects": 3, "analyzedFiles": 7, "imports": 12 },
  "result": {
    "discovery": { "projects": [], "edges": [], "tags": [] },
    "proposal": {
      "proposed": true,
      "notAuthoritative": true,
      "unknown": false,
      "components": { "total": 1, "items": [] },
      "boundaryAssertions": { "total": 2, "items": [] },
      "tagVocabulary": { "total": 3, "items": [] },
      "rules": { "total": 1, "items": [] },
      "uncertainty": { "high": 1, "medium": 3, "low": 2 }
    }
  }
}
```

The envelope is **additive**: the proposal rides in `result.proposal` beside
`result.discovery`, and a descriptive run carries no `proposal` key at all. The
`unknown` flag on the proposal marks the empty-workspace case, so an absent
candidate class is never ambiguous with a failed build.
