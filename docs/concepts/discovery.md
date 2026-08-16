# Discovery

Architecture is often already there before anyone writes it down. The directories
the projects were placed in, the edges that connect them, the tags the projects
already carry — a workspace's constraints are visible in the tree before a single
row of the boundary law is written.

**Discovery** is the read-only face of that fact: `lattice discover` reports what
is observed (projects, edges, tags, and the coverage a verdict over this tree
could trust), and `lattice discover --propose` derives the candidate architecture
those observations imply — candidate components, boundary assertions, tag
vocabularies and rules — each marked as a proposal that is **not authoritative**
and **never written**.

Discovery is the last capability of the architecture-governance wave, and it is
deliberately the least assertive one: everything else in that wave enforces or
recommends against a declared intent, while discovery suggests what the intent
_should be_ from what is already there. It never writes `architecture-intent.json`,
never mutates the workspace, and never hands a candidate the authority of a
decision.

## The proposal-only line

The one invariant everything else in this document holds:

- **A proposal is a suggestion, never a decision.** Every candidate carries
  `proposed: true` and `notAuthoritative: true`. The text report prints a banner
  — `proposed architecture — NOT authoritative, never written` — above the
  candidates, and repeats `[proposed — not authoritative]` on every line, so a
  reader who scans the report cannot mistake a candidate for a decision.
- **A workspace that does not ask does not get one.** The default `discover` run
  is purely descriptive. `--propose` is opt-in.
- **No write-back, by construction.** The proposal evaluator
  (`packages/lattice/src/governance/discovery-proposal.mjs`) is pure: it takes an
  observed model and returns a proposal object. It never reads a file, never
  writes a file, and never imports the module that loads a declaration. Whether a
  candidate later becomes intent is a governance decision owned elsewhere.

## What is observed

`discover` shares the same observed source every command judges — the project
model `graph`/`drift`/`check` read, from the same providers. It reports:

- **projects** — name, root, type, tags;
- **edges** — the observed project-to-project dependencies, with implicit edges
  and edges to external packages dropped (the same filter `drift` applies);
- **tags** — the union of project tags, sorted and deduplicated;
- **coverage** — how many imports, files and projects analysis actually judged,
  and which files could not be analyzed.

The coverage line is the first thing the report prints, for the same reason it
leads every other command's report: the reader knows whether the observations are
complete before reading any entry. A workspace the run could not fully read
returns no-verdict (exit 3) — a missing edge is ambiguous between "gone" and
"never seen", and a candidate derived from an incomplete graph would be a
fabrication wearing a proposal's name.

## What a proposal contains

`--propose` derives candidate architecture from the observed side, in four
candidate classes. Every candidate carries the exact evidence that produced it
and an uncertainty marker.

### Components

A **component** is a top-level directory grouping — a project's root's first
path segment (`libs`, `apps`, or the tree root itself). Two or more projects
sharing a directory is the strongest structural signal that they share a role.
Lattice proposes the grouping; whether it is real governance is the reader's
call. The naming is a deliberate simplification: deeper directory prefixes are
not split out, and when a workspace's nested structure diverges from its
top-level one, the divergence surfaces as cross-component edges, which the next
two classes carry.

### Boundary assertions

Two shapes, both with medium confidence (they are derived claims, not direct
observations):

- **component** — "these projects share a role", proposed because they share a
  directory;
- **edge** — "source and target belong to different components", proposed
  because an observed edge crosses the component boundary. An intra-component
  edge emits no assertion on purpose: it observes no boundary crossing, so
  proposing a relationship over it would be a fabrication.

### Tag vocabulary

Two shapes:

- **observed** (high confidence) — a tag a strict majority of a component's
  projects already shares. This is the strongest evidence a tag axis exists: the
  projects themselves agree on it at discovery time;
- **suggested** (low confidence) — an axis implied by the tags' own shape
  (`scope:core` and `scope:util` spell a `scope:` axis). The evaluator never
  proposes a tag no project carries.

### Rules

The rules that would make the observed separation real:

- **noDependency** — one per observed cross-component edge ("source must not
  depend on target";
- **boundary** — one per component assertion ("declare a boundary around the
  component").

### The uncertainty marker

Every candidate carries `confidence: "high"|"medium"|"low"` — the three values
are the entire vocabulary, bounded by construction and assigned
deterministically from what was measured, never from the tree's own text.

- **high** — a direct observation of a structure the intent grammar can state (a
  tag the projects themselves carry, in the majority);
- **medium** — a claim derived from observations (a directory grouping is a
  component, an edge crosses a component boundary); the assertion and rule
  classes are here;
- **low** — the evaluator's own vocabulary suggestion, which nothing observed
  states (the `scope:` axis implied by tag shapes).

The report prints a confidence legend with the count of candidates at each level,
so a reader can compare at a glance how much of a proposal is measured versus
suggested.

## Determinism

Discovery is deterministic: all leaves sort by plain string comparison (never
`localeCompare`), so two runs over an unchanged tree produce byte-identical text
and JSON. That is the same promise `graph`'s snapshots make, and it is what lets
a consumer `diff` two proposals meaningfully — the candidate set changed only
when the observations changed.

## Read-only, and the refusals that follow

`discover` is a descriptive command. It never exits 1. Like every descriptive
command it exits 0 when it completes, 3 when coverage is incomplete, and 2 on
usage error — and it refuses, loudly, in exactly two additional situations:

- **incomplete coverage under `--propose`** — a proposal over an unread tree
  would be a fabrication wearing a proposal's name, so the run refuses rather
  than print a proposal with a warning that it may be lying;
- **an Nx workspace with polyglot manifests and no plugin registration** — the
  graph would silently under-represent the real architecture, and a candidate
  derived from it would be a guess dressed as a fact.

A workspace with zero projects is **not** a refusal: zero observed projects is a
complete observation, and the honest proposal is the empty one with
`unknown: true` — nothing observed means nothing to propose, never a fabricated
candidate set.

## Where this sits

Discovery is a 1.x capability like the rest of the governance wave:
deterministic, computed from the observed graph with no predictive component and
no LLM anywhere in the core path. What 2.x could add on top — natural-language
summarisation of a proposal, or learned vocabulary from many workspaces — is
direction, not a promise. The deterministic candidates are what ships today.

The command reference is [../reference/discovery.md](../reference/discovery.md).
