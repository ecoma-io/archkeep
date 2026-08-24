# ADRs

The `adr` command: list the recorded architecture decisions and what each
makes enforceable. The _meaning_ of an ADR — the filename identity, the strict
frontmatter dialect, and the two loud refusals — is owned by
[concepts/adr.md](../concepts/adr.md); this page is the command surface.

## What it runs

```bash
archkeep adr                         # dump the whole registry
archkeep adr 0001-bind-collaboration # one record
archkeep adr rule:no-direct-dep      # reverse lookup: which ADRs bind it
archkeep adr --format json           # the versioned envelope
archkeep adr --format json --output adrs.json
```

The optional positional argument names an id — an ADR id (`NNN-slug`) or a
rule/fitness id (`rule:…`, `fitness:…`). With no argument the command dumps
the full registry. `adr` needs no Nx, no project graph, and no boundary
config: it reads only the tracked `docs/adr/` at the workspace root, so it
runs on a tree with no Nx at all.

## Flags

| flag       | argument       | default | meaning                                         |
| ---------- | -------------- | ------- | ----------------------------------------------- |
| `--format` | `text`\|`json` | `text`  | Terminal report or the versioned JSON envelope. |
| `--output` | `<file>`       | stdout  | Write the report to a file instead of stdout.   |

There is deliberately no `--config` flag: a description of what is recorded is
read from the tree being described, and needs no boundary law to frame it.

## Reading the answer

- **The dump** — one block per record in byte-sorted filename order, each
  naming its status (`proposed`, `accepted`, `superseded`), its `supersedes`
  chain, and the rule/fitness ids it binds.
- **One record** — the same block, for that id alone.
- **A rule/fitness id** — the reverse lookup: `rule:no-direct-dep is bound
by: 0001-bind-collaboration`. An id no ADR binds reads
  `no ADR in docs/adr/ binds rule:orphan — it is not enforced by any recorded
decision`: a fact about the registry, reported in a sentence, never as a
  silent empty list. Note what it answers: _does the registry bind that exact
  id?_ — not _is that rule enforceable?_ A rule id the registry binds nothing is
  the loud unenforced-fact spelling, and in an agent workflow it is a reason to
  verify the rule row's exact spelling against the config, not a clean result.
  `check`, `context` (and `context --plan`), `drift`, and `provenance` each
  resolve a row's `decisionRef` against the registry automatically wherever they
  render or walk that row, and name an unresolved one loudly — no manual lookup
  is needed just to learn whether a citation resolves. `impact` is the one
  reader that does not: it displays a constraint row's `decisionRef` as
  written, unresolved, so the string to verify there must be read from the row
  itself (the boundary config or `architecture-intent.json`, or copied from
  `context`'s output) and asked of `archkeep adr` byte for byte — the same way a
  reader inspects the RECORD an already-resolved citation names: its status,
  supersession chain, and what else it binds.
- **Anything else is read as an ADR reference** — bare `NNN-slug`, or the
  `adr:`-prefixed spelling `decisionRef` docs recommend as an alternate ADR-id
  form (`packages/archkeep/src/governance/row-schema.mjs`); both resolve to the
  same record. One the registry does not know — an unknown id, a wrong case,
  a truncation, a path-traversal shape, or any other spelling that is not a
  `rule:…`/`fitness:…` reference above — reads `no ADR 0999-ghost in
docs/adr/ …`: the record is missing, and the run reports **no-verdict**,
  never clean.

## Exit codes

`adr` is descriptive: it never exits 1 — a description of what is recorded is
never a finding.

| code | meaning                                                                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | completed — the dump, a record, or a lookup answered. A reverse lookup naming a rule/fitness id no ADR binds is still 0: a sentence stating the fact, not a resolved reference |
| 2    | usage error — more than one positional argument                                                                                                                                |
| 3    | no verdict — an unknown ADR id, or a registry that could not be read                                                                                                           |

The exit-3 paths are the command's obligations to the invariant. A `decisionRef`
(or an `adr` argument) naming an ADR id that does not exist must read as _cannot
look_, because reading it as "clean" is byte-for-byte identical to a workspace
with no violation anywhere — the silent direction. An unreadable registry (a
malformed record, a bad filename, a file that will not parse) throws the same
way: "could not read the registry" must never read as "no ADRs".

## In a pipeline

`adr` is a description, so a red build on a violating workspace is not its
job — but a `3` in CI _is_ a real signal worth failing on the same way
`check`'s could-not-look exit is. Wire `2` and `3` as failures in the same
places [ci.md](ci.md) tells `check`'s to. Treat an unresolved ADR id (exit 3)
in an agent workflow the same way `check`'s exit 3 is treated: investigate,
never read as "nothing to see". The asymmetry cuts the other way too: a reverse
lookup that answers `no ADR binds rule:X` with exit 0 is not a CI failure, but
it is not a governance-clean result either — a rule the registry binds nothing
is unanchored, and the sentence exists so a human or agent inspects it, not so
a pipeline can call it done. The JSON envelope carries the same status and exit
code, with the records under `result.*`.

## The concept

What an ADR is, why the filename is the identity, why the frontmatter dialect
is strict, and how `decisionRef` binds a rule to its decision — see
[concepts/adr.md](../concepts/adr.md). The report shapes and the envelope's
fields are in [reference/adr.md](../reference/adr.md).
