---
id: 0009-moon-derived-tags-provider-policy
status: accepted
---

# The Moon provider derives `layer:`/`stack:` tags from Moon's own classification — recorded provider policy

## Context

A Moonrepo workspace states a project's classification twice over: once in the
`tags` list of its `moon.yml`, which Archkeep carries verbatim, and once in
the structured `layer` and `stack` fields Moon itself computes and validates.
Tags are the one channel a project's classification reaches the boundary law
through — constraint rows match them — and Moon's own tag validation rejects
colons, so a Moon workspace cannot itself declare the `layer:application`
spelling the constraint-table convention uses. The two vocabularies could not
meet without a bridge.

`deriveTags` in `packages/archkeep/src/providers/moon.mjs` is that bridge: it
merges the declared tags with a `layer:<value>` tag synthesized from the
`layer` field and a `stack:<value>` tag synthesized from the `stack` field,
deduplicated and sorted. Because a project's tags are inputs to judgment, the
architecture refactor's provider audit recorded the synthesis among the five
policies embedded in `transformMoonGraph` awaiting adjudication (the
providers-observe law is the one in question; the finding and the five items
are the refactor control plane's). This record is the adjudication's outcome
for this item, 2026-09-05. The number is simply the next free one: the
refactor's PD-10
([`docs/architecture/refactor/DECISIONS.md`](../architecture/refactor/DECISIONS.md#program-decisions))
had earlier rejected a would-be ADR-0009 **for event identity** — a rejection
of that subject, not a reservation of the number.

## Decision

The synthesis stays, as **recorded provider policy**: the Moon provider
translates Moon's structured classification into the tag vocabulary,
colon-form. Three boundaries are part of the decision, not commentary on it:

1. A tag is derived only from a classification **Moon itself states** — the
   `layer` and `stack` values, verbatim. The provider invents no tag value,
   derives nothing from project names, paths, or targets, and synthesizes no
   other field.
2. Declared tags are carried **verbatim**: a `layer-core` in `moon.yml` stays
   `layer-core` and never becomes `layer:core`. Rewriting a tag changes which
   constraint rows match it, which is meaning, not representation — and the
   one thing an adapter may not do is reshape meaning.
3. The provider decides nothing with the result. Whether `layer:application`
   may reach anything is the constraint table's question, and that table is
   the workspace's own law; a derived tag makes Moon's classification
   _visible_ to that law, never binding on it.

## Rationale

Under the providers-observe law the test is whether a transformation decides
semantics or reshapes representation. This one reshapes representation: the
tag `layer:application` and Moon's `layer: application` field are one fact in
two spellings, and no verdict, filtering, or suppression rides on the
translation. What kept it from being recorded as a plain normalization is
that nothing forces it — the engine's contracts would be satisfied by
carrying `layer`/`stack` as inert node metadata, invisible to the constraint
table. The bridge is a discretionary contribution of law-_inputs_, and
discretion at the provider seam is exactly what deserves a numbered record
rather than a code comment: the alternative chosen says no, silently, every
time a reader meets the function.

## Refused alternatives

- **Carrying `layer`/`stack` as inert node metadata.** Moon's classification
  would be invisible to the constraint table: a workspace could not write a
  law over a classification its own project files state.
- **Normalizing declared tags into colon form.** `layer-core` rewritten to
  `layer:core` changes which rows match — a meaning change wearing a
  spelling fix's clothes. No synthesized tag can collide with a declared one
  (Moon rejects colons in `tags:`), so nothing needs the rewrite.
- **Removing the synthesis as provider judgment — the rejected-candidate
  class.** It passes the providers-observe test, and its removal would be a
  consumer-visible semantic change: every constraint row matching a derived
  tag would stop matching, and the violations it caught would silently
  vanish — the forbidden direction, at a minimum a named minor under the
  compatibility contract, with no defect motivating it.

## Consequences

The derived tags are public observable behavior: constraint matching on a
Moon workspace sees them, and the consumer-facing statement of the mechanism
([`docs/integrations/moon.md`](../integrations/moon.md#tag-format)) already
carries it, including the asymmetry a workspace must know — colon-form rows
match through the derived path only, dash-form rows through the declared one,
and never the twain. A change to what is derived, or removal of the
synthesis, is a semantic change under the compatibility contract. The
provider may not grow a further derivation (a tag from any field beyond
`layer`/`stack`) without a new record superseding this one. The behavior is
pinned where it is implemented — `packages/archkeep/src/providers/moon.test.mjs`'s
tag-derivation describe (merge, dedupe, omission when a field is null,
absent `config.tags`) — and both faces share the one implementation, the
language server indexing through the same `readProjectGraph` the CLI runs.
