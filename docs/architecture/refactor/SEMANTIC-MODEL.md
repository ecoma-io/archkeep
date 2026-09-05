# Semantic model

One row per canonical semantic concept: who constructs it, what shape it has,
who consumes it, and where a second spelling of the same meaning exists or
threatens to. This page is the Phase 0 cartography's model map, produced by
read-only audit (issue #725); it states what **is**, and marks — without
changing — what a later phase may resolve.

The domain vocabulary is fixed by
[CON-3](CONSTITUTION.md#con-3--generalize-computation-not-domain-vocabulary):
Intent, Reality/Observation, Evidence, Rule, Policy, Evaluation, Decision,
Waiver, Verdict, Snapshot, Provenance. Rows below use those words.

## Canonical ownership table

"Owner" = the one module that constructs the canonical representation. Every
other named site is a consumer that composes the owner, verified by audit; a
site that re-derives the same semantics instead of composing would be a
[CON-4](CONSTITUTION.md#con-4--canonical-semantic-models) violation and a
[P-D](CONSTITUTION.md#process-articles) stop.

| Concept                                | Owner (constructor)                                                                                                                                             | Consumers (compose only)                                                                                             | Audit verdict                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Verdict vocabulary (4 states + I1–I5)  | `VERDICTS`, `isVerdict`, `buildDecision` — `src/governance/verdict.mjs`                                                                                         | `check` via `verdictFor` (`src/verdict.mjs`), fitness registry, custom-rule WASM host, delta/change/coverage-verdict | clean                                                                     |
| Envelope decision object               | `buildDecision` — `src/governance/verdict.mjs:204-310`                                                                                                          | `src/report/json.mjs` carriers: check, delta, change                                                                 | clean                                                                     |
| Violation (rule finding)               | `violationOf` — `src/rules/index.mjs:428-442`                                                                                                                   | `evaluateRun` → `evaluate` → `verdictFor`                                                                            | clean constructor; see [Finding — unowned](#finding--the-unowned-concept) |
| Edge verdict (constraint judgment)     | `judgeEdge` — `src/rules/edge-constraints.mjs:79`                                                                                                               | check pipeline, `context`, `explain`, `impact`                                                                       | clean                                                                     |
| Go-workspace verdict                   | `compareGoWork` — `src/go-work.mjs:313-394`                                                                                                                     | check pipeline                                                                                                       | clean; own message registry (see below)                                   |
| tsconfig-paths verdict                 | `judgeTsconfigPaths` — `src/tsconfig-paths.mjs:147-202`                                                                                                         | check pipeline                                                                                                       | clean; own message registry (see below)                                   |
| Graph snapshot + identity              | builders in `src/commands/graph.mjs:72-220`; `snapshotIdentity` `src/commands/history.mjs:124-143` (ADR [0008](../../adr/0008-snapshot-identity-per-family.md)) | history capture/read, diff, delta, change, evolution, trajectory, health                                             | clean — one identity per family, one spelling                             |
| Evidence snapshot (bytes-identity)     | `buildEvidenceSnapshot`/`serializeEvidenceSnapshot` — `src/commands/delta-snapshot.mjs:107-286`                                                                 | delta capture/compare, change baseline                                                                               | clean — no id field, by decision                                          |
| Structural comparison                  | `computeDiff` — `src/commands/diff.mjs:257-336`                                                                                                                 | `change` (deliberately, `change.mjs:14-18`), history classification                                                  | clean                                                                     |
| Metadata comparison                    | `compareSnapshotMetadata` — `src/commands/snapshot-meta.mjs:73-140`                                                                                             | diff, delta, change, history                                                                                         | clean                                                                     |
| Evolution event + identity             | `src/governance/evolution-event.mjs` (`eventDedupeKey`, `eventId`, `classifyEvolution`) + append-only store `src/governance/evolution-store.mjs`                | exactly three producers: `evolution`, `delta`, `change`                                                              | clean                                                                     |
| Provenance (repo origin)               | `resolveProvenance` — `src/commands/provenance.mjs:49-128`                                                                                                      | graph, diff, delta, change, discover, drift, reconcile, fitness, waivers, health, evolution                          | clean                                                                     |
| Origin / decision-lifecycle records    | `recordOrigin`, `recordDecisionLifecycle` — `src/governance/provenance-record.mjs`                                                                              | row-schema, delta, evolution (origin only)                                                                           | clean; lifecycle write surface unused by engine commands                  |
| Waiver semantics                       | `src/governance/waiver.mjs` (expiry, status, fate)                                                                                                              | check fold, waivers, delta-classify, debt ledger                                                                     | clean — no second expiry rule                                             |
| ADR registry                           | `src/governance/adr-registry.mjs`                                                                                                                               | adr, decisions, provenance, report, evaluation-primitives                                                            | clean                                                                     |
| Architecture intent (the law)          | `src/architecture-intent/model.mjs` + `judge.mjs` + `intent-fingerprint.mjs`                                                                                    | drift, check (via driftForCheck), reconcile, delta, change, fitness, discover                                        | clean                                                                     |
| Custom-rule evidence bundle            | `src/custom-rules/evidence.mjs` (contract 1)                                                                                                                    | WASM host, check, `--evidence-out`                                                                                   | clean                                                                     |
| Coverage refusal (graph family)        | `coverageVerdict`/`coverageRefusal` — `src/commands/coverage-verdict.mjs`                                                                                       | every no-verdict path in the graph family                                                                            | clean — see register R1                                                   |
| Completeness model (intelligence wave) | `src/commands/completeness.mjs` (`EVALUATION_STATUS`)                                                                                                           | evaluation-primitives, impact, scenario                                                                              | second vocabulary — register R1                                           |
| Analysis record (observation)          | `src/analysis/` analyzers, contract frozen in `src/analysis/contract.md`                                                                                        | rules, graph builders, LSP diagnostics                                                                               | clean — analysis never judges                                             |

## Finding — the unowned concept

Across the four judgment construction sites (`violationOf`, `judgeEdge`,
`compareGoWork`, `judgeTsconfigPaths`) no single module owns "what a finding
**is**" — the predicate that says a record has become a reportable violation.
Each site builds its own shape and its own message wording, then all four fold
into the one verdict lane. The lane is singular (good,
[CON-1](CONSTITUTION.md#con-1--one-enforcement-authority)); the finding concept
feeding it is plural in spelling. This is the largest
[CON-4](CONSTITUTION.md#con-4--canonical-semantic-models) gap Phase 2 owns —
and Phase 2 **starts with the audit, not an object**: work item 2-A
adjudicates what a Finding is before any canonicalization, and "no canonical
Finding object" is one of its three legitimate outcomes
([MIGRATION-PLAN.md](MIGRATION-PLAN.md#phase-2--canonical-model-hardening)).

## Message-template registries — one shape, three homes

Three registries with identical structure exist:

- `MESSAGE_IDS`/`MESSAGES` — `src/rules/messages.mjs` (canonical; pinned
  verbatim against installed `@nx/eslint-plugin` where upstream parity holds)
- `GO_WORK_MESSAGES` — `src/go-work.mjs:80-95`
- `TSCONFIG_PATHS_MESSAGES` — `src/tsconfig-paths.mjs:87-94`

Same semantics (message id → template), three spellings. Consolidation is a
Phase 2 candidate; it must not change any rendered message byte (messages are
pinned by tests — `src/rules/messages.test.mjs`, `src/rules/upstream.integration.test.mjs`).

## Vocabulary registers (R1–R7)

Sibling vocabularies that share words with the canonical 4-state set. Each is
single-owned today; the risk is conflation at consumer edges, not double
construction. Registers, not defects:

- **R1** — evaluation statuses `EVALUATION_STATUS` (`completeness.mjs:34-46`)
  vs the refusal contract `coverageVerdict`. Two models of "did we see
  everything", owned by different waves. Phase 2: one sentence each way
  stating the boundary (doc fix).
- **R2** — decision-fitness levels (`decision-fitness.mjs:63-70`) reuse
  `not_applicable` with their own meaning ("no authority").
- **R3** — reconciliation verdicts `matched/undeclared/unfulfilled/unproven`
  (`change.mjs:27-45`; membership guard refuses strangers).
- **R4** — evolution dispositions: stored vocabulary in
  `evolution-event.mjs:48`, but the mapping functions in `delta.mjs:399-404`,
  `change.mjs:403-431` and `evolution.mjs:802-830` do not validate their
  output against it — only the store does, at write time.
- **R5** — delta verdict-deltas `pass|fail` words from counts
  (`delta-classify.mjs:635-641`); a projection, not a verdict record.
- **R6** — history transition signals are per-record facts; classification
  comes from the canonical `classifyEvolution` — single classifier confirmed.
- **R7** — two edge-identity spellings: `edgeIdentityKey`
  (`diff.mjs:242-244`, in-memory set arithmetic) vs `edgeEvolutionIdentity`
  (`evolution-event.mjs:197-199`, escaped stored string). No cross-feeding
  today; the names invite a future writer to store the diff-internal key in an
  event. Phase 1 hardening candidate.

## Naming hazards

- **Two modules named `verdict.mjs`** — `src/verdict.mjs` (the check verdict
  lane) and `src/governance/verdict.mjs` (the vocabulary/decision owner).
  Deliberate layering (`verdictFor` composes `buildDecision`), but imports
  read ambiguously and a mis-route is silent. Phase 2 candidate: rename one or
  pin the relationship in both headers.
- **Three "intent" nouns** — `src/architecture-intent/` (the constraint-table
  law, `architecture-intent.json`), `src/intent/` (the manifest + Contract-K
  guard), `change-intent.mjs` (declared-change grammar). Different concepts,
  shared word. The ownership table above is the disambiguator; a rename is a
  Phase 2 candidate judged under
  [CON-3](CONSTITUTION.md#con-3--generalize-computation-not-domain-vocabulary)
  (keep domain words; rename only the homonyms).

## Change rules

Ownership is resolved **before** any module moves
([CON-4](CONSTITUTION.md#con-4--canonical-semantic-models)). A phase that
touches a row must: keep the owner the single constructor, keep consumer
composition (no re-derivation), and re-run the row's pinning tests plus the
differentials named in [VALIDATION-MATRIX.md](VALIDATION-MATRIX.md). A new
concept entering the model gets a row here in the same PR that introduces it.

Two spellings of one meaning are permitted only at adapter/projection
boundaries, with the conversion named at the boundary — anywhere else they
are a duplicate model and a stop ([P-D](CONSTITUTION.md#process-articles)
item 2). Creating per-surface verdict types (`DomainVerdict`/`CheckVerdict`/
`MCPVerdict`/`ReportVerdict` or equivalents) to keep packages separate is the
named anti-pattern: a surface composes the canonical verdict; it never
re-spells it.
