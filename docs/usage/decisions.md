# `archkeep decisions`

Walk the full governance chain behind one recorded architecture decision: the
decision record itself, the governed rows that stand on it (intent, constraint,
fitness), the projects those rows govern, the current evidence and findings on
those projects, and the decision's verification level.

```shell
archkeep decisions 0001-bind-collaboration
archkeep decisions adr:0001-bind-collaboration
archkeep decisions 0001-bind-collaboration --format json
archkeep decisions 0001-bind-collaboration --format json --output chain.json
```

`decisions` takes exactly one positional argument: the ADR id whose chain to
walk. It reads the boundary law because the chain's fitness leg reads the
workspace's declared gates.

The walk is deterministic: the same tree, the same law, the same decision id
produce byte-identical output every time.

## When to use this command

`decisions` answers "what does this decision actually enforce, and is it
currently satisfied?" It is the command to reach for when:

- An agent or reviewer needs to understand the full impact of one recorded
  decision — which rules it binds, which projects those rules govern, and what
  findings currently exist on those projects.
- A `decisionRef` citation in a violation, a constraint row, or a drift finding
  needs to be traced from the name to the record to the governed rows to the
  projects to the evidence.
- A governance reviewer wants to verify that a recorded decision's bindings
  resolve to real rows in the policy, and that those rows govern real projects.

It is descriptive: it reports the chain as it currently stands, never a
finding. Use `check` to enforce, `adr` to list records or look up what a
rule binds, and `decisions` when the question is "what is this decision's full
chain, end to end?"

## What the report contains

The text report follows the decision's governance chain top to bottom:

- **Header** — the decision id and its status (`proposed`, `accepted`, `active`,
  `superseded`, `retired`). An id the registry does not know reads as
  `(unknown)` and the run reports **no-verdict**.
- **Record fields** — any `description`, `remediation`, `context`, or
  `rationale` the record carries.
- **Supersession** — if the record supersedes other decisions, the ids of those
  records.
- **Fitness** — the per-decision verification level: the level name, whether it
  is verified, and the reason. A binding that names no declared gate derives
  `unverifiable` — the registry alone asserts nothing, never a clean pass.
- **Governed rows** — the intent, constraint, and fitness rows that cite this
  decision through `decisionRef`, and the projects each row governs. When no
  row cites the decision, the report states `(none — recorded but not
enforceable)`.
- **Evidence** — the current findings on each governed project, one line per
  finding with its rule id. A project with no current findings states that
  explicitly.
- **Unresolved** — present only when the walk could not resolve every hop. Each
  unresolved reference names the ref, its kind, and why it could not resolve.

### Text output example (abridged)

```text
0001-bind-collaboration  (active)
----------------------------
description: enforces the layer boundary between domain and infrastructure
supersedes: 0000-initial
fitness:  hotspot   (verified) — no project exceeds the hotspot threshold
governs:
  rule:no-direct-dep  (constraint) → billing-core, billing-api, billing-db
  rule:sticky-logs  (constraint) → billing-core
  intent:domain-collaboration  (intent) → billing-core, billing-api
  fitness:hotspot  (fitness) → billing-core, billing-api, billing-db
evidence:
  billing-core: src/billing-core/orders.ts:142 (no-direct-dep)
  billing-api: no current findings
  billing-db: no current findings
```

### JSON envelope

`--format json` wraps the same answer in the versioned envelope
([json-output.md](../reference/json-output.md)). The `result` block carries:

| field          | type                      | meaning                                                         |
| -------------- | ------------------------- | --------------------------------------------------------------- |
| `decisionId`   | string                    | The id as requested, echoed back unmodified.                    |
| `record`       | object \| null            | The resolved decision record, or `null` when not found.         |
| `walk`         | object                    | The governance graph walk `{ok, nodes, edges, unresolved}`.     |
| `fitness`      | object (absent \| object) | The decision's fitness derivation (absent when record is null). |
| `knownFitness` | string[]                  | Declared rule/fitness ids the registry knows.                   |

The walk's `nodes` are the chain in first-discovery order, each with `id`,
`kind`, `label`, and optional `data`. `kind` is `decision`, `intent`,
`constraint`, `fitness`, `project`, or `finding`. `edges` are directed
`{from, to, kind}` with `kind` one of `decisionRef`, `binding`, `governs`,
`finding`, `supersedes`.

`coverage.complete` agrees with `walk.ok` — every reference resolved means
complete; any unresolved reference means incomplete.

## Flags

| flag       | argument       | default                  | meaning                                                                     |
| ---------- | -------------- | ------------------------ | --------------------------------------------------------------------------- |
| `--format` | `text`\|`json` | `text`                   | Terminal report or the versioned JSON envelope.                             |
| `--output` | `<file>`       | stdout                   | Write the report to a file instead of stdout.                               |
| `--config` | `<file>`       | (from workspace options) | Read the boundary law from here instead of the workspace's configured file. |

The ADR id is a single positional argument. Both `NNN-slug` and
`adr:NNN-slug` are accepted; the prefix is stripped before the registry is
consulted. `--config` is accepted because the chain's fitness leg depends on
which boundary law — and which declared gates — is in effect.

## Exit codes

`decisions` is descriptive: it never exits 1 — a description of the governance
chain is never a finding.

| code | meaning                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------- |
| 0    | The chain was walked and every hop resolved — complete.                                                       |
| 2    | Usage error: wrong argument count, unknown flag.                                                              |
| 3    | No verdict — the ADR id does not resolve, the registry could not be read, or a binding names no governed row. |

The exit-3 paths are the command's obligations to the invariant. A `decisionRef`
(or the positional argument) naming an ADR id that does not exist must read as
_cannot look_, because reading it as "clean" would be byte-for-byte identical to
a workspace with no governance chain at all — the silent direction. An
unreadable registry throws the same way.

## In a pipeline

`decisions` is descriptive, so a red build on a violating workspace is not its
job — but a `3` in CI is a real signal worth failing on: an unresolved
decision id or an unreadable registry means the chain could not be established.
Wire `2` and `3` as failures in the same places [ci.md](ci.md) tells `check`'s
to.

The reference page for the command is
[`../reference/decisions.md`](../reference/decisions.md).
