# Architecture decision records

An architecture decision record (ADR) is a decision someone wrote down: a
short, dated-later-persisted Markdown file that records _what_ was decided and
_which_ rule/fitness ids that decision makes enforceable. ADRs are how the
governance capabilities make the "why" of a rule auditable — the decision
behind a `depConstraints` row, a fitness rule, or a required project — as
committed bytes in the same tree as the rule.

## The minimum that records anything

An ADR is a file under `docs/adr/` named `NNN-slug.md` — `NNN` a zero-padded
number of at least three digits, `slug` a dash-separated lowercase name. The
filename is the record's identity: the number is its order in the registry, and
the slug is its subject. The file may carry a `---` frontmatter block with up to
four keys:

- `id` — the record's own identity. Optional, but when present it MUST equal
  the filename's id. The filesystem is the source of truth; a frontmatter id
  that disagrees with its filename is a loud load error, never a drift the
  registry guesses at.
- `status` — `proposed` (default), `accepted`, or `superseded`.
- `supersedes` — the ids of ADRs this record replaces, giving the supersession
  chain from a record back to the one it overturned.
- `bindings` — the rule/fitness ids this decision makes enforceable: the
  objects whose existence the decision is _why_.

An ADR with no `bindings` is recorded but **not yet enforceable** — the report
names it exactly that. The moment a rule row (a `depConstraints` row or an
intent row) carries a `decisionRef` naming the ADR, the two sides of the
binding exist: the row declares it leans on the decision, and the ADR declares
the decision covers the row. A fitness row may carry a `decisionRef` the same
way a rule row does — `decisionRef` is one of the governance block keys a
fitness row accepts — and an ADR's `bindings` may name a fitness id too,
binding the gate to the decision from either side.

## The dialect is strict on purpose

Frontmatter is a minimal `key: value` dialect — list fields as `- item`
continuation lines, `#` for comments, no full YAML and no JSON. The registry is
read by an enforcer, so a line it cannot trust must be a loud parse error, never
a line silently dropped. The same decision the intent model makes for
`architecture-intent.json`: this tool's own files get no parser leniency.
`packages/lattice/src/governance/adr-registry.mjs` is the dialect's home — it
parses, validates, and indexes every record.

## Determinism, and the two refusals

The registry is deterministic: files are read in byte-sorted filename order,
and a record's own `bindings`/`supersedes` keep the source order the file
stated — the registry never reorders what a record declares — so two runs over
an unchanged `docs/adr/` produce byte-identical output.

The invariant everything is judged against (an empty result must mean "no
violation", and nothing else) binds the registry two ways:

- **An unreadable registry is a loud failure, never an empty one.** A
  `docs/adr/` that exists but holds a file that will not parse, a duplicate id,
  a status outside the three, an unknown frontmatter key, a frontmatter key
  repeated within one record (the second occurrence would otherwise silently
  overwrite the first), or a `supersedes` / `bindings` entry that is not what
  the field requires — any of those throws, so a caller can never mistake
  "could not read the registry" for "no ADRs".
  An absent `docs/adr/` is the one quiet path, on purpose: a workspace that has
  not adopted ADRs yet has nothing to resolve, and the report says so in a
  sentence rather than a table. That exit-0 sentence is not a verdict that any
  rule is or is not governed — it means nothing is _recorded_, so every
  `decisionRef` in the tree is dangling, and rule governance is entirely
  unanchored until someone writes the record.
- **A `decisionRef` that does not resolve is `unknown`, never `pass`.** The
  registry answers the two-name space — an ADR id (matching a file) or a
  rule/fitness id the workspace's ADRs bind. Anything else is unknown, and the
  `adr` command reports it the loud way: a requested ADR id it does not know is
  exit 3, never clean — a rule that reads as bound while nothing binds it is the
  silent direction. The config and intent loaders still validate a
  `decisionRef`'s shape only and resolve nothing at load time — that half stays
  a load-time shape check, not a resolution. Reporting is the other half:
  `check`, `context`, `drift`, and `provenance` each resolve every row's
  `decisionRef` against the registry wherever they render or walk that row, and
  name an unresolved one loudly — `UNRESOLVED` inline in `check`'s and
  `context`'s constraint line, a named section in `drift`'s and `provenance`'s
  reports. None of them turns the citation into a _verdict_: an unresolved
  `decisionRef` is a fact about the row's documentation, not about whether the
  boundary holds, so it changes no exit code and no finding count — the same
  posture `provenance`'s `unattested` (a row with no `origin`) already takes.
  `lattice adr <id>` remains how a reader inspects the record itself — its
  status, supersession chain, and what else it binds — once a citation is known
  to resolve.

## Remote lookup does not change local resolution

A workspace may consult a remote catalog of decisions that knows ADRs the local
`docs/adr/` does not. Local knowledge always wins: a `decisionRef` the local
registry already resolves stays resolved, and only an id the local tree does not
know may be asked of the remote. A remote failure resolves nothing and throws
nothing — an opt-in convenience must never make an enforceable rule
unenforceable, and a remote answer carries the moment it was taken.

## What this is not

An ADR does not _create_ a rule. The rule lives in the boundary law or the
intent; the ADR records the decision the rule leans on, and `decisionRef` is the
pointer from one to the other. `lattice adr` reports what is recorded; it does
not verify that a bound rule/fitness exists anywhere else in the workspace, and
it never exits 1 — a description of what is recorded is not a finding.

See [reference/adr.md](../reference/adr.md) for the `adr` command's report
shapes, the JSON envelope, and the exit codes, and
[usage/adr.md](../usage/adr.md) for running it.
