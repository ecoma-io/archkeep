# ADRs

The `adr` command: list the recorded architecture decisions and what each
makes enforceable. The _meaning_ of an ADR — the filename identity, the strict
frontmatter dialect, and the two loud refusals — is owned by
[concepts/adr.md](../concepts/adr.md); this page is the command surface.

## What it runs

```bash
lattice adr                         # dump the whole registry
lattice adr 0001-bind-collaboration # one record
lattice adr rule:no-direct-dep      # reverse lookup: which ADRs bind it
lattice adr --format json           # the versioned envelope
lattice adr --format json --output adrs.json
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
  silent empty list.
- **An ADR-pattern id the registry does not know** — `no ADR 0999-ghost in
docs/adr/ …`: the record is missing, and the run reports **no-verdict**,
  never clean.

## Exit codes

`adr` is descriptive: it never exits 1 — a description of what is recorded is
never a finding. Only `check` exits 1.

| code | meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| 0    | completed and every reference resolved                               |
| 2    | usage error — more than one positional argument                      |
| 3    | no verdict — an unknown ADR id, or a registry that could not be read |

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
places `ci.md` tells `check`'s to. The JSON envelope carries the same status
and exit code, with the records under `result.*`.

## The concept

What an ADR is, why the filename is the identity, why the frontmatter dialect
is strict, and how `decisionRef` binds a rule to its decision — see
[concepts/adr.md](../concepts/adr.md). The report shapes and the envelope's
fields are in [reference/adr.md](../reference/adr.md).
