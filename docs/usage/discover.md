# `archkeep discover`

Report the observed architecture, and optionally propose the candidate architecture those observations imply.

```shell
archkeep discover
archkeep discover --propose
archkeep discover --format json
archkeep discover --propose --format json --output proposal.json
```

`discover` reports the observed side of the workspace — projects, edges, tags,
and the coverage a verdict over this tree could trust. With `--propose`, it
derives the candidate architecture those observations imply: candidate
components, boundary assertions, tag vocabularies and rules. Every candidate
carries `proposed: true` and `notAuthoritative: true`, and computing one
writes nothing — the only route from a proposal to `architecture-intent.json`
is the operator's explicit `--write-intent` hand-off
([../reference/discovery.md](../reference/discovery.md) owns the flag).

This is a descriptive command: it never exits 1, and it never hands a
candidate the authority of a decision. The observation and the proposal
write nothing on their own; the only file the command can put bytes into,
beyond the `--output` report, is the one `--write-intent` names.

## What the observed side contains

The same project model every other command reads — from any provider (Nx, Moon,
or a native `archkeep.json` workspace):

- **Projects** — name, root directory, type (`"app"` or `"lib"`), and tags
- **Edges** — the observed project-to-project dependencies, with implicit edges
  and edges to external packages dropped (the same filter `drift` applies)
- **Tags** — the union of all project tags, sorted and deduplicated
- **Coverage** — how many imports, files and projects were analyzed, and which
  files could not be read

The coverage line leads the report, so the reader knows whether the
observations are complete before reading any entry.

## `--propose`

`--propose` computes the candidate architecture over the observed observations
and prints it beneath a banner:

```text
proposed architecture — NOT authoritative, never written
```

Four candidate classes, each with its evidence and an uncertainty marker:

- **Components** — top-level directory groupings (`libs`, `apps`, or the tree
  root itself), proposed because two or more projects share a directory
- **Boundary assertions** — two shapes:
  - `component`: "these projects share a role", proposed because they share a
    directory
  - `edge`: "source and target belong to different components", proposed because
    an observed edge crosses the component boundary
- **Tag vocabulary** — two shapes:
  - `observed` (high confidence): a tag a strict majority of a component's
    projects already share
  - `suggested` (low confidence): an axis implied by the tags' own shape
    (e.g., `scope:core` and `scope:util` spell a `scope:` axis)
- **Rules** — the rules that would make the observed separation real:
  - `noDependency`: one per observed cross-component edge
  - `boundary`: one per component assertion

Every candidate carries `confidence: "high"|"medium"|"low"` — the entire
vocabulary, bounded by construction and assigned deterministically from what was
measured. The report prints a confidence legend with the count of candidates at
each level.

Computing the proposal writes nothing: the evaluator is pure — it cannot even
express the write — and the command layer holds no intent path. The one door
to `architecture-intent.json` is the CLI's `--write-intent <file>` flag:
explicit, named by the operator, refused when a file already stands at the
target, and what it writes is a proposal to review like a diff, not an
adopted law. Whether a candidate becomes intent is a governance decision
owned by the reader
([../reference/discovery.md](../reference/discovery.md) owns the flag).

## Exit codes

| code | meaning                                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 0    | The observed side was reported, and coverage is complete.                                                                           |
| 2    | Usage error: unknown flag, wrong argument count.                                                                                    |
| 3    | Coverage is incomplete — a file could not be analyzed, an import site could not be resolved, or no file was analyzed at all (#619). |

`discover` never exits 1. It is descriptive: it answers questions about the
architecture without claiming a violation.

## Fail-closed

`discover` refuses loudly on every path that cannot reach a verdict, all
exit-3 class:

- The workspace model cannot be loaded (malformed `archkeep.json`, `nx graph`
  or `git` failure)
- The observed side has incomplete coverage — a whole file the analyzer could
  not read, an import site it could not resolve, or no file analyzed at all
  (#619). The completeness law is the shared constructor's
  (`src/commands/coverage-verdict.mjs`), the same three-axis law `check` and
  `graph` judge coverage over — a run that judged nothing is never mistaken
  for one that judged everything
- Under `--propose`, incomplete coverage is a **refusal**, not a warning — a
  proposal over an unread tree would be a fabrication wearing a proposal's
  name
- An Nx workspace has polyglot manifests but the plugin is not registered —
  the graph would silently under-represent the real architecture, and a
  candidate derived from it would be a guess dressed as a fact

A workspace with zero projects is **not** a refusal: zero observed projects is
a complete observation, and the honest proposal is the empty one with
`unknown: true` — nothing observed means nothing to propose, never a fabricated
candidate set.

## Determinism

`discover` is deterministic: all leaves sort by plain string comparison (never
`localeCompare`), so two runs over an unchanged tree produce byte-identical
text and JSON. That is the same promise `graph`'s snapshots make, and it is what
lets a consumer `diff` two proposals meaningfully — the candidate set changed
only when the observations changed.

The reference page for the command is
[`../reference/discovery.md`](../reference/discovery.md). The concept that
defines the derivation rules and the proposal-only line is
[`../concepts/discovery.md`](../concepts/discovery.md).
