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
the slug is its subject. Every entry in that directory is judged by that one
rule: a file the pattern does not match — `0002-cased.MD`, `0003-thing.markdown`,
`README.md` — is a loud load error, never an entry quietly skipped, because a
record dropped before it is read is an id `decisionRef` then answers `unknown`
for while the file sits in the tree. The file may carry a `---` frontmatter block with up to
six keys:

- `id` — the record's own identity. Optional, but when present it MUST equal
  the filename's id. The filesystem is the source of truth; a frontmatter id
  that disagrees with its filename is a loud load error, never a drift the
  registry guesses at.
- `status` — the lifecycle state: `proposed` (default), `accepted`, `active`,
  `superseded`, or `retired`. Only `accepted` and `active` carry authority.
- `supersedes` — the ids of ADRs this record replaces, giving the supersession
  chain from a record back to the one it overturned. The reverse link —
  `supersededBy`, the records that replaced this one — is derived on every
  record when the registry loads.
- `created`, `updated` — optional STRING values recording the decision's own
  timeline from the committed bytes. Never generated from the wall clock.
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

## Lifecycle and authority

A decision moves through five statuses, carried in the record's `status` field:

- `proposed` — the default: a draft, recorded but not yet a decision.
- `accepted` — a decision was made. With `active`, one of the two statuses with
  authority (`hasAuthority`): a `decisionRef` may cite it, and a successor may
  lean on it.
- `active` — the accepted decision currently in force: the governing state.
- `superseded` — replaced by a later decision. Authority transferred: it no
  longer carries authority, and it must name who replaced it — at least one
  successor.
- `retired` — withdrawn without a replacement: authority lapsed, and no
  successor is required.

`supersedes` gives the chain from a record back to the one it replaced, and the
registry derives the reverse — `supersededBy` — on every record at load, so
both directions are always true. A chain that cannot be true is refused at
load, exit 3, never rendered as fact: a `supersedes` target that is not a
record, a record superseding itself, a cycle, a `superseded` record with no
successor, a successor without authority (`proposed` or `superseded` records
may not replace another), and the contradiction rule — an `active`/`accepted`
record superseded by another. The contradiction rule is the loud guard on the
silent direction: a decision that reads as both in force and replaced.

The record's body may carry the decision's prose as optional fields parsed from
`## ` headings: `## Context`, `## Decision`, `## Rationale`, `## Alternatives`
(or this repository's own spelling, `## Refused alternatives`), `## Consequences`,
`## Assumptions`. An absent heading is an absent field, and body prose is free
markdown — it never throws; frontmatter is the one strict dialect.

## The dialect is strict on purpose

Frontmatter is a minimal `key: value` dialect — list fields as `- item`
continuation lines, `#` for comments, no full YAML and no JSON. The registry is
read by an enforcer, so a line it cannot trust must be a loud parse error, never
a line silently dropped. The same decision the intent model makes for
`architecture-intent.json`: this tool's own files get no parser leniency.
`packages/archkeep/src/governance/adr-registry.mjs` is the dialect's home — it
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
  a status outside the five, an unknown frontmatter key, a frontmatter key
  repeated within one record (the second occurrence would otherwise silently
  overwrite the first), a `supersedes` / `bindings` entry that is not what
  the field requires, or a supersession chain that cannot be true (see
  [Lifecycle and authority](#lifecycle-and-authority)) — any of those throws,
  so a caller can never mistake "could not read the registry" for "no ADRs".
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
  exit 3, never clean. A `supersedes` naming a record the registry does not
  hold was that class of silence once — the chain would read as replaced by a
  decision nobody wrote — and the registry now refuses it at load instead,
  before any command can render it. A rule that reads as bound while nothing
  binds it is the other silent direction. A record's own
  `bindings` are the one half `adr` reports without adjudicating, and says so:
  it holds no boundary config, so the only ids it could compare against are the
  ones the records themselves declare. The config and intent loaders still validate a
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
  `archkeep adr <id>` remains how a reader inspects the record itself — its
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
pointer from one to the other. `archkeep adr` reports what is recorded; it does
not verify that a bound rule/fitness exists anywhere else in the workspace, and
it never exits 1 — a description of what is recorded is not a finding.

The vocabulary keeps the layers honest: an ADR records a decision — the _why_.
The intent and `depConstraints` rows, and the fitness rules, are the
enforceable layer — the _what must remain true_. `decisionRef` is the pointer
from the enforceable layer to the decision it leans on; an ADR never creates a
rule and never produces a boundary verdict itself, and needs no verdict to
exist — a missing verdict is a reason to check the boundary law, not the ADR.

## The boundary: a decision records, a constraint enforces

The four questions a governance workspace has to answer keep the layers apart:

- **WHY** — the decision, recorded in `docs/adr/`. Context, rationale,
  alternatives, consequences.
- **WHAT MUST REMAIN TRUE** — the enforceable layer: `depConstraints` rows,
  `architecture-intent.json` rows, fitness rules. This is where a rule exists
  and where a rule is enforced.
- **HOW DO WE KNOW** — the evidence the engine computes from the tree: import
  sites, findings, coverage. A verdict derives from constraint-row findings,
  never from a record's `status`.
- **IS IT STILL TRUE** — decision fitness: whether the constraints a decision
  binds actually hold today. This is the descriptive half, never a rule
  author.

An ADR must never become a rule DSL. The decision says _why_; the constraint
row says _what must remain true_; `decisionRef` is the pointer from the
enforceable row back to the decision it leans on, and `bindings` is the
decision's own list of what it makes enforceable. The two-way correspondence
is a fact about the workspace, not a rule the token invents, and one side never
substitutes for the other: a decision with no executable constraint is not a
failing boundary — it is an `unverifiable` decision.

Decision fitness is the vocabulary for the fourth question, computed from the
bound constraints' verdicts (see
[fitness-functions.md](fitness-functions.md) and
[usage/fitness.md](../usage/fitness.md)):

- `enforced` — at least one bound constraint resolved and passed.
- `partially-enforced` — some resolved and passed, some not.
- `violated` — a bound constraint resolved and failed: **red**.
- `unverifiable` — no bound constraint could be resolved or evaluated: **red,
  never healthy**.
- `not_applicable` — no authority (`proposed`/`superseded`/`retired`), so not
  measured.

"No violation" is **not** the same as "healthy". A decision whose binding
matches no enforceable row reads `unverifiable`, never `enforced` — a clean
boundary and an unverifiable decision can hold in the same workspace, and the
fitness level is where the second shows up rather than being mistaken for a
verdict on the first. A `violated` decision fails only through the constraint
rows it binds: fitness is descriptive, and in this wave it changes no exit
code — the exit code still comes from the constraint rows' verdicts, never
from a decision's `status`. `packages/archkeep/src/governance/decision-fitness.mjs`
owns the computation.

See [reference/adr.md](../reference/adr.md) for the `adr` command's report
shapes, the JSON envelope, and the exit codes, and
[usage/adr.md](../usage/adr.md) for running it.
