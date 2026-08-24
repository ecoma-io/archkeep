# `archkeep adr`

Describe what is recorded in the workspace's ADR registry: every architecture
decision, what each makes enforceable, and — given an id — the reverse lookup
of which decision something leans on.

```shell
archkeep adr
archkeep adr 0001-bind-collaboration
archkeep adr rule:no-direct-dep
archkeep adr --format json
archkeep adr --format json --output adrs.json
```

`adr` takes at most one positional argument. With none it dumps the whole
registry; with one it answers that id. The registry is always read from the
tracked `docs/adr/` at the workspace root — there is no `--config` flag,
because a description of what is recorded needs no boundary law — and the
command never touches the project graph, Nx, or a boundary config, so it runs
on a tree with no Nx at all.

## The id name space

The one positional argument answers one of two questions, told apart by the
id's shape:

- **`rule:…` / `fitness:…`** — a rule or fitness id. Registers as a _reverse
  lookup_: which ADRs bind it, in registry order. An id no ADR binds is a fact
  about the registry — that rule is not enforced by any recorded decision —
  and is reported as a sentence naming the unenforced id, never as a silent
  empty list.
- **Anything else is read as an ADR reference.** Bare `NNN-slug`, or
  `adr:`-prefixed (`adr:NNN-slug`) — the alternate spelling `decisionRef`'s own
  docs recommend beside the bare form
  (`packages/archkeep/src/governance/row-schema.mjs`) — resolve identically:
  the prefix is stripped before the registry is consulted. A known id, either
  spelling, shows that record; everything that does not resolve — an unknown
  id, a case mismatch, a truncation, a path-traversal shape, or any other
  spelling that is not a `rule:…`/`fitness:…` reference above — is
  **unresolved** (below), never folded into the reverse-lookup's empty-but-ok
  case.

## The report

The dump is one block per record, in byte-sorted filename order, each naming
its status, its supersession chain, and the rule/fitness ids it binds:

```text
0001-bind-collaboration  (accepted)
----------------------------
bindings:   rule:no-direct-dep, fitness:hotspot
status set: proposed, accepted, superseded

0002-bind-logs  (superseded)
----------------------------
supersedes: 0001-bind-collaboration
bindings:   rule:sticky-logs
status set: proposed, accepted, superseded
```

A binding naming a rule/fitness id the registry's own records never mention is
listed `(unknown)` — named, never hidden — and the single-record report below
marks it identically, so narrowing to one record never hides what the dump
showed. Read that marker for exactly what it says: `adr` loads no boundary
config, so the id set it compares against is derived from the records' own
`bindings`, and no binding a record declares can fall outside it. `adr` never
adjudicates a binding — it reports one. Whether a rule/fitness the workspace
actually declares backs it is `check`'s and `drift`'s question, answered
against the policy's own declared ids. An ADR with no bindings is listed
`(none — not yet enforceable)`; a registry with no records is the single
sentence `no ADRs in docs/adr/ — nothing is recorded, and nothing is
enforceable through it`, never an empty-looking table. Everything here is
deterministic: two runs over an unchanged tree produce byte-identical output.

A single-record report shows that record alone, with the same status,
supersession and binding lines the dump gives it. The reverse lookup prints the
binding ADRs or the unenforced sentence; an id read as an ADR reference that
the registry does not know prints:

```text
no ADR 0999-ghost in docs/adr/ — nothing is recorded under that id, and a
decisionRef naming it cannot resolve
```

## The JSON envelope

`--format json` wraps the same answer in the versioned envelope
([json-output.md](json-output.md)): `result.adrs` lists every record's id,
`result.registry` names the directory and its count, and `result.statuses`,
`result.bindings`, and `result.supersedes` carry the per-record facts. The
envelope's `workspace` block carries `provider: "native"` and
`marker: "docs/adr"`, and `result.unresolved` carries the rows that could not
be resolved and why.

## Exit codes

| code | meaning                                                                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | completed — the dump, a record, or a lookup answered. A reverse lookup naming a rule/fitness id no ADR binds is still 0: a sentence stating the fact, not a resolved reference |
| 2    | usage error — more than one positional argument                                                                                                                                |
| 3    | no verdict — an unknown ADR id, a `supersedes` target naming no record, or a registry that could not be read                                                                   |

`adr` never exits 1: a description of what is recorded is never a finding; only
`check` exits 1. The three exit-3 paths are the command's obligations to the
invariant. An id read as an ADR reference — everything except a
`rule:…`/`fitness:…` id — that the registry does not know is unresolved — an
empty reverse lookup would read exactly like a clean workspace, which is the
silent direction. A `supersedes` entry is resolved against the registry for the
same reason: the field is shape-checked at load and nothing more, so a record
superseding an id no file carries used to print its supersession chain as fact
at exit 0 — a reader told the older decision was replaced by a decision this
workspace never recorded. An unreadable registry throws the same loud
refusal `provenance` makes for a malformed intent file: a list built from a
registry it could not read would be a claim about records that do not exist.

## The concept

What an ADR is, the minimum a record needs, why the dialect is strict, and the
two refusals — all in [concepts/adr.md](../concepts/adr.md). The registry's
format and index live in
`packages/archkeep/src/governance/adr-registry.mjs`, and a governance row leans
on a record through the shared `decisionRef` key that
[concepts/provenance.md](../concepts/provenance.md)'s governance block defines.
