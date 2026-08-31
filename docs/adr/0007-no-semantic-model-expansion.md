---
id: 0007-no-semantic-model-expansion
status: accepted
---

# The semantic model is not expanded after the Phase 4 audit

## Status

Accepted. Decided after an adversarial audit of the whole repository at
`main` (`aace10a`, wave-3 evolution model merged via #521), not as a feature
roadmap exercise. This record states why the ownership / data-flow / API /
event / runtime semantic candidates the audit considered were not built, so a
proposal to add one later is recognised as a change of direction rather than a
cleanup or an obvious win.

## Context

Phase 4 asked whether, after the structural-architecture core and the wave-3
evolution model, Archkeep is missing any capability it must add to honour the
architectural pain it commits to in its doctrine. The candidate semantic
domains were ownership, data-flow, API, event, and runtime architecture, plus
any newly-discovered domain.

The audit verified first that the canonical data-flow already holds — that no
command short-circuits it:

```
declared architecture / Decision → Intent → Constraint → observed Evidence
  → deterministic Judge → Verdict → EvolutionEvent
  → History / Debt / Trajectory / Decision lineage → Report
```

- `report` "computes nothing of its own": every number and verdict comes from
  the same function the owning command calls
  ([`docs/usage/report.md`](../usage/report.md)), so two sections can never
  answer from two laws and no report self-invents a fact.
- `debt` derives from the same files `check`/`drift`/`graph` read — there is
  no private ledger store to go stale (`debt-ledger.mjs`
  header).
- Evolution events carry references, never graphs: `base`/`head` name
  revisions and snapshot files, `findings`/`debt` carry identity strings —
  an event is a pointer into the evidence, never a second copy of it
  ([`docs/concepts/evolution.md`](../concepts/evolution.md)).
- `EVOLUTION_EVENT` identity is `sha256(canonicalizeJson({ base, head,
declarationDigest }))` — never the clock, never prose (`evolution-event.mjs`,
  DRIFT / VIOLATION / REPAIR / DECISION_CHANGE classifications require the
  evidence they name; a one-sided ADR pair never asserts DECISION_CHANGE).

No shortcut was found, so no follow-up issue is owed for a report/debt/
decision/evolution path that fabricates facts.

## The candidates, each with its verdict

Every candidate was held to the question: does a real user pain need it,
does an authoritative deterministic evidence source exist for it, and does it
stay inside the canonical model? AI/LLM output was never admissible as an
authoritative judge — at most a proposal a deterministic layer verifies — and
none of the candidates needed it.

- **Ownership — REJECT.** The doctrine already refuses it: "no assumption
  about any workspace's names" ([north-star](../doctrine/north-star.md)
  refusals), and ownership has no canonical authoritative source — an
  `owner` field would be a dependency rule in disguise, exactly the failure
  this audit was warned against. Who decided a governance row is already
  recorded by the `origin` block and `decisionRef`
  ([provenance](../concepts/provenance.md)); a separate owner semantic would
  duplicate it with no evidence authority.
- **Data-flow — REJECT.** An import/reference is not data flow: "a manifest
  says a dependency _may_ be used; it never says a boundary _was_ crossed"
  ([graph](../concepts/graph.md)). Actual data flow is not observable from
  static source, so a data-flow semantic would be speculative inference —
  precisely what is forbidden.
- **API — REJECT.** Package/module dependency is not an API boundary/call/
  contract, and HTTP/RPC semantics cannot be derived from an import. No
  static evidence source.
- **Event — REJECT as runtime-event semantics.** Archkeep's EvolutionEvent is
  a deterministic record of architecture change ([evolution](../concepts/evolution.md)),
  not runtime event publication/consumption/delivery. Claiming runtime
  delivery from static code is the exact overreach the audit was told not to
  make.
- **Runtime architecture — REJECT (deferred).** The engine reads statically
  and never invokes a toolchain ([north-star](../doctrine/north-star.md)
  refusal). There is no trustworthy, reproducibly-maintainable runtime
  evidence provider, so a runtime graph cannot meet the deterministic gate.
  This is the HIGH-RISK candidate; the refusal is not a repudiation of a
  future opt-in sidecar outside the exit-code contract, but it is not built
  now.
- **Newly-discovered domains — none.** No additional domain was found that
  has an authoritative evidence source not already covered by the structural
  dependency graph, the intent/constraint table, the EvolutionEvent, and
  `origin`/`decisionRef` provenance.

The outcome is therefore **no MUST BUILD**. The structural model plus the
wave-3 evolution model already provide the canonical evidence/"semantic"
layer the phase was asked to assess. Expanding it would either fabricate
evidence (forbidden) or duplicate an existing capability.

## Decision

1. **The semantic model is not expanded in this phase.** No ownership,
   data-flow, API, event, or runtime graph primitive is added to the core.
   Adding one later is a change of direction that must pass the five
   questions [architecture-authority](../doctrine/architecture-authority.md)
   puts to any capability on the intelligence layer.
2. **Structural dependency, semantic relation, evidence, and policy
   constraint keep their existing boundaries.** No generic `SemanticRelation`,
   `Metadata`, `Fact`, or catch-all object is introduced as a standalone
   primitive to defer a schema decision. A relation that cannot name
   authoritative evidence never becomes an authoritative architecture fact.
3. **The intelligence layer stays direction, not promise.** The roadmap's
   later-maturity capabilities — deeper intent, semantic understanding,
   predictive drift, evolution intelligence, change risk, migration planning,
   cross-repository intelligence, agent-assisted planning, potentially
   AI-assisted reasoning — remain gate-5+ headroom, optional and non-blocking
   for the foundation, exactly as [roadmap.md](../doctrine/roadmap.md)
   already states.
4. **The wave-3 hardening is the correctness work this phase owns.** The
   open wave-3 issues (#500–#508) and the hardening bug (#515) are resolved
   and closed by the merged wave-3 evolution model; this ADR records that the
   audit re-verified their fixes against the current source rather than
   trusting the merge claim.

## Consequences

- No new semantic capability, command, schema field, or EvolutionEvent
  classification ships from this phase. Backward compatibility is preserved
  by construction: nothing changed on an unchanged workspace.
- The roadmap's "Current / implemented" command claim is corrected to the
  real roster: **23** commands, including `decisions` and `rules`, which the
  earlier "22" wording and list omitted.
- A future maintainer proposing ownership/data-flow/API/event/runtime
  semantics now has this record to argue against, rather than a gap that
  looks like it was simply never tried. The refusals in
  [north-star](../doctrine/north-star.md) and the boundary in
  [architecture-authority](../doctrine/architecture-authority.md) already
  name the same line; this record is the specific, evidence-backed statement
  that an adversarial audit reached the same refusal.
- No feature was invented to "complete" the phase. The empty-result invariant
  — "an empty result is a claim, not a shrug" — was applied to the audit
  itself: the absence of a MUST BUILD is a decision recorded here, not
  unfinished work.
