# `archkeep decisions`

Walk the full governance chain behind one recorded architecture decision:
the resolved decision record, the governed rows that stand on it (intent,
constraint, fitness), the projects those rows govern, the current evidence and
findings on those projects, and the decision's verification level.

```shell
archkeep decisions 0001-bind-collaboration
archkeep decisions adr:0001-bind-collaboration
archkeep decisions 0001-bind-collaboration --format json
archkeep decisions 0001-bind-collaboration --format json --output chain.json
```

`decisions` takes exactly one positional argument: the ADR id whose chain to
walk. It reads the boundary law because the chain's fitness leg reads the
workspace's declared gates. It is descriptive and read-only, and it never exits 1.

## Flags

| flag       | argument       | default                  | meaning                                                                     |
| ---------- | -------------- | ------------------------ | --------------------------------------------------------------------------- |
| `--format` | `text`\|`json` | `text`                   | Terminal report or the versioned JSON envelope.                             |
| `--output` | `<file>`       | stdout                   | Write the report to a file instead of stdout.                               |
| `--config` | `<file>`       | (from workspace options) | Read the boundary law from here instead of the workspace's configured file. |

Both `--flag value` and `--flag=value` work. An unknown flag is a usage error
(exit 2) rather than treated as a path. `--format` changes no exit code and no
byte of the other formats — it is an additional rendering of the same chain.
`--output` writes atomically (write to `.tmp`, then rename) so a reader never
sees a truncated file.

## The positional argument

The single positional argument is the ADR id whose chain to walk. It accepts two
spellings:

- **Bare `NNN-slug`** — `0001-bind-collaboration`
- **`adr:`-prefixed** — `adr:0001-bind-collaboration`

The `adr:` prefix is stripped before the registry is consulted; both resolve to
the same record. An id the registry does not know — an unknown id, a case
mismatch, a truncation — is **unresolved** (exit 3), never a clean result.

## The text report

The text report renders the chain top to bottom, one section per hop:

### Header

```
0001-bind-collaboration  (active)
----------------------------
```

The first line is the record id and its status (`proposed`, `accepted`, `active`,
`superseded`, `retired`). An id the registry does not know renders as
`<id>  (unknown)`.

### Record fields

If the record carries prose fields — `description`, `remediation`, `context`,
`rationale` — each is rendered as a labelled line:

```
description: enforces the layer boundary between domain and infrastructure
```

### Supersession

If the record supersedes other decisions, the ids of those records appear on a
`supersedes:` line:

```
supersedes: 0000-initial
```

### Fitness

The per-decision verification level, in the same byte convention the `adr`
command uses:

```
fitness:  hotspot   (verified) — no project exceeds the hotspot threshold
```

A binding that names no declared gate derives `unverifiable` — the registry
alone asserts nothing, never a clean pass. A record with no fitness derivation
(no bindings at all) renders `fitness:  (none)`, present so the header line is
never alone.

### Governed rows

The intent, constraint, and fitness rows that cite this decision through
`decisionRef`, each with its kind and the projects it governs:

```
governs:
  rule:no-direct-dep  (constraint) → billing-core, billing-api, billing-db
  intent:domain-collaboration  (intent) → billing-core, billing-api
  fitness:hotspot  (fitness) → billing-core, billing-api, billing-db
```

When no row cites the decision, the report states:

```
governs: (none — recorded but not enforceable)
```

### Evidence

The current findings on each governed project, one finding per line with its
rule id:

```
evidence:
  billing-core: src/billing-core/orders.ts:142 (no-direct-dep)
  billing-api: no current findings
```

A project with no findings states that explicitly — an empty project list is a
claim about the current evidence, never a missing lookup.

### Unresolved block

Present only when the walk could not resolve every hop (`walk.ok === false`).
Each unresolved reference names the ref, its kind, and why it could not resolve:

```
unresolved:
  0999-ghost: reference does not match any ADR in the registry
  rule:orphan: no governed row found for binding 'rule:orphan'
```

A chain with no unresolved block is itself the claim "every reference resolved
completely".

## The JSON envelope

`--format json` wraps the same answer in the versioned envelope
([json-output.md](json-output.md)). The envelope carries:

| field       | type   | meaning                                          |
| ----------- | ------ | ------------------------------------------------ |
| `command`   | string | `"decisions"`                                    |
| `status`    | string | `"ok"` or `"no-verdict"` — never `"findings"`    |
| `exitCode`  | number | `0` or `3` — never `1`                           |
| `coverage`  | object | Coverage facts; `complete` agrees with `walk.ok` |
| `result`    | object | The chain payload (detailed below)               |
| `workspace` | object | Root, provider, marker (`docs/adr`), provenance  |

### `result`

| field          | type                      | meaning                                                                                                                                                     |
| -------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decisionId`   | string                    | The id as requested, echoed back unmodified — a consumer sees exactly what was asked, including a spelling that did not resolve.                            |
| `record`       | object \| null            | The resolved decision record, or `null` when the id is not a record. `{id, status, bindings, supersedes, supersededBy}` — the committed front-matter facts. |
| `walk`         | object                    | The governance graph walk `{ok, nodes, edges, unresolved}`, detailed below.                                                                                 |
| `fitness`      | object (absent \| object) | The decision's fitness derivation `{id, status, level, verified, reason}`, present when the id resolves, absent when `record` is `null`.                    |
| `knownFitness` | string[]                  | The rule/fitness ids this workspace's boundary config declares, sorted, deduplicated — the id space `fitness:`/`rule:` bindings resolve against.            |

### `walk`

| field        | type     | meaning                                                                                                                                                                                 |
| ------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`         | boolean  | `true` when every reference resolved; `false` when any could not. `status`/`exitCode`/`coverage.complete` always agree with it.                                                         |
| `nodes`      | object[] | The chain's nodes in first-discovery order, each `{id, kind, label, data?}`. `kind` is `decision`, `intent`, `constraint`, `fitness`, `project`, or `finding`.                          |
| `edges`      | object[] | The chain's directed edges, each `{from, to, kind}`. `kind` one of `decisionRef`, `binding`, `governs`, `finding`, `supersedes`.                                                        |
| `unresolved` | object[] | Every reference that could not resolve, each `{ref, kind, reason}`. **Unconditional**: an empty array is itself the claim "the chain resolved completely". Non-empty is `"no-verdict"`. |

A decision node's `data` carries `{status}`, plus `created`/`updated`/
`supersedes`/`supersededBy` when the record holds them. A finding node's `data`
is `{id, project, ruleId}`.

### `coverage`

`coverage.complete` is `walk.ok`. `projects`, `analyzedFiles`, and `imports`
are the observed graph and analysis counts. `notAnalyzed` names each unresolved
reference as `{file, reason}` — a `kind: "decision"` reference renders as
`docs/adr/<ref>.md`, anything else by its raw `ref`. `blindSpots` and `notes`
are `[]`.

## Integration with waivers

`decisions` evaluates findings against the same rule engine `check` uses. The
findings it reports are the raw rule verdicts — a finding that a waiver covers
in `check`'s output is still present in the chain's evidence leg. `decisions`
does not apply the waiver table: it describes the chain from the decision down
to the evidence, and the evidence is what the rules found. Whether a waiver
accepts that evidence is `check`'s and `waivers`' question, answered against
the same findings.

The chain's fitness leg reads the workspace's declared gates from the boundary
law — the same gates the `fitness` command evaluates and the `report` command
composes — so a decision's verification level reflects the same verdicts a
fitness run would produce.

## Exit codes

| code | meaning                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | completed — the chain was walked and every hop resolved. `walk.ok` is `true`.                                                                                                                                 |
| 2    | usage error — wrong argument count, unknown flag.                                                                                                                                                             |
| 3    | no verdict — an unknown ADR id, a binding that names no governed row, an unreadable registry (a malformed record, a bad filename, a file that will not parse), or any hop of the walk that could not resolve. |

`decisions` never exits 1: a description of the governance chain is never a
finding. The three exit-3 paths are the command's obligations to the invariant:
a chain that could not be established must never read as clean.

## Components

The `decisions` command composes these modules without owning any of them:

- **`adr-registry.mjs`** — reads `docs/adr/` and builds the record index;
  shared with the `adr` command.
- **`decision-graph.mjs`** — `forwardDecision`, the walk that attaches governed
  rows, projects, and evidence, and reports every hop it cannot resolve in
  `walk.unresolved`.
- **`decision-fitness.mjs`** — `computeDecisionFitness`, the per-decision
  verification level.
- **`provenance-command.mjs`** — `intentRows`/`configRows`, the same row walk
  `provenance` uses, so this command never holds a second copy of which rows
  exist.

The walk is a pure function of the registry, the boundary config, the graph,
and the analysis — no IO, no wall-clock time, no randomness. Two runs over an
unchanged tree produce byte-identical output.

## The concept

What an ADR is, the minimum a record needs, and the strict frontmatter dialect
are owned by [concepts/adr.md](../concepts/adr.md). The governance chain
model — decisions through governed rows to projects to evidence — is the same
model the `report` command composes under `result.decisions`, described in
[concepts/architecture.md](../concepts/architecture.md). The walk itself lives
in `packages/archkeep/src/governance/decision-graph.mjs`.
