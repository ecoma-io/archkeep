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

| Concept                                    | Owner (constructor)                                                                                                                                             | Consumers (compose only)                                                                                             | Audit verdict                                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Verdict vocabulary (4 states + I1–I5)      | `VERDICTS`, `isVerdict`, `buildDecision` — `src/governance/verdict.mjs`                                                                                         | `check` via `verdictFor` (`src/verdict.mjs`), fitness registry, custom-rule WASM host, delta/change/coverage-verdict | clean                                                                                              |
| Envelope decision object                   | `buildDecision` — `src/governance/verdict.mjs:212-318`                                                                                                          | `src/report/json.mjs` carriers: check, delta, change                                                                 | clean                                                                                              |
| Violation (rule finding)                   | `violationOf` — `src/rules/index.mjs:428-442`                                                                                                                   | `evaluateRun` → `evaluate` → `verdictFor`                                                                            | clean constructor; see [Finding — unowned](#finding--the-unowned-concept)                          |
| Edge verdict (constraint judgment)         | `judgeEdge` — `src/rules/edge-constraints.mjs:79`                                                                                                               | check pipeline, `context`, `explain`, `impact`                                                                       | clean                                                                                              |
| Go-workspace verdict                       | `compareGoWork` — `src/go-work.mjs:313-394`                                                                                                                     | check pipeline                                                                                                       | clean; own message registry (see below)                                                            |
| tsconfig-paths verdict                     | `judgeTsconfigPaths` — `src/tsconfig-paths.mjs:147-202`                                                                                                         | check pipeline                                                                                                       | clean; own message registry (see below)                                                            |
| Graph snapshot + identity                  | builders in `src/commands/graph.mjs:72-220`; `snapshotIdentity` `src/commands/history.mjs:124-143` (ADR [0008](../../adr/0008-snapshot-identity-per-family.md)) | history capture/read, diff, delta, change, evolution, trajectory, health                                             | clean — one identity per family, one spelling                                                      |
| Evidence snapshot (bytes-identity)         | `buildEvidenceSnapshot`/`serializeEvidenceSnapshot` — `src/commands/delta-snapshot.mjs:107-286`                                                                 | delta capture/compare, change baseline                                                                               | clean — no id field, by decision                                                                   |
| Structural comparison                      | `computeDiff` — `src/commands/diff.mjs:271-350`                                                                                                                 | `change` (deliberately, `change.mjs:14-18`), history classification                                                  | clean                                                                                              |
| Metadata comparison                        | `compareSnapshotMetadata` — `src/commands/snapshot-meta.mjs:73-140`                                                                                             | diff, delta, change, history                                                                                         | clean                                                                                              |
| Evolution event + identity                 | `src/governance/evolution-event.mjs` (`eventDedupeKey`, `eventId`, `classifyEvolution`) + append-only store `src/governance/evolution-store.mjs`                | exactly three producers: `evolution`, `delta`, `change`                                                              | clean                                                                                              |
| Provenance (repo origin)                   | `resolveProvenance` — `src/commands/provenance.mjs:49-128`                                                                                                      | graph, diff, delta, change, discover, drift, reconcile, fitness, waivers, health, evolution                          | clean                                                                                              |
| Origin / decision-lifecycle records        | `recordOrigin` — `src/governance/provenance-record.mjs`                                                                                                         | row-schema, delta, evolution (origin only)                                                                           | clean; the dormant lifecycle write surface deleted (#746, WI-6)                                    |
| Waiver semantics                           | `src/governance/waiver.mjs` (expiry, status, fate)                                                                                                              | check fold, waivers, delta-classify, debt ledger                                                                     | clean — no second expiry rule                                                                      |
| ADR registry                               | `src/governance/adr-registry.mjs`                                                                                                                               | adr, decisions, provenance, report, evaluation-primitives                                                            | clean                                                                                              |
| Architecture intent (the law)              | `src/architecture-intent/model.mjs` + `judge.mjs` + `intent-fingerprint.mjs`                                                                                    | drift, check (via driftForCheck), reconcile, delta, change, fitness, discover                                        | clean                                                                                              |
| Custom-rule evidence bundle                | `src/custom-rules/evidence.mjs` (contract 1)                                                                                                                    | WASM host, check, `--evidence-out`                                                                                   | clean                                                                                              |
| Coverage refusal (graph family)            | `coverageVerdict`/`coverageRefusal` — `src/commands/coverage-verdict.mjs`                                                                                       | every no-verdict path in the graph family                                                                            | clean — see register R1                                                                            |
| Catalog-integrity verdict (`rules verify`) | the verify fold — `src/commands/rules.mjs:445-448` (status), `cli.mjs:2040-2042` (exit)                                                                         | `jsonEnvelope` + `EXIT_FOR_STATUS` (the shared contract); no lane module consumes it                                 | bounded integrity surface — a different law from the lane ([PD-8](DECISIONS.md#program-decisions)) |
| Completeness model (intelligence wave)     | `src/commands/completeness.mjs` (`EVALUATION_STATUS`)                                                                                                           | evaluation-primitives, impact, scenario                                                                              | second vocabulary — register R1                                                                    |
| Analysis record (observation)              | `src/analysis/` analyzers, contract frozen in `src/analysis/contract.md`                                                                                        | rules, graph builders, LSP diagnostics                                                                               | clean — analysis never judges                                                                      |

## Finding — the unowned concept

Across the four judgment construction sites (`violationOf`, `judgeEdge`,
`compareGoWork`, `judgeTsconfigPaths`) no single module owns "what a finding
**is**" — the predicate that says a record has become a reportable violation.
Each site builds its own shape and its own message wording, then all four fold
into the one verdict lane. The lane is singular (good,
[CON-1](CONSTITUTION.md#con-1--one-enforcement-authority)); the finding concept
feeding it is plural in spelling. The 2-A adjudication
([PD-13](DECISIONS.md#program-decisions)) ruled **outcome (c)**: no canonical
Finding object. What binds instead is the relationship pin: every finding
feeds the one verdict lane — four families converging as count keys into
`verdictFor` — and `check.mjs:519-523` is the documented seam where
`judgeEdge`'s markdown-pairing verdicts are reshaped into the exact
`Violation` record `violationOf` builds. The "violation" word-collision map is
pinned in
[MIGRATION-PLAN.md](MIGRATION-PLAN.md#phase-2--canonical-model-hardening)'s
2-A inputs, and a Finding that grows judgment fields, lifecycle state, or
surface-specific rendering stays rejected at review
([CON-3](CONSTITUTION.md#con-3--generalize-computation-not-domain-vocabulary),
[CON-4](CONSTITUTION.md#con-4--canonical-semantic-models)).

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
  `evolution-event.mjs:48`; the mapping functions in `delta.mjs:399-404`,
  `change.mjs:403-431` and `evolution.mjs:802-830` do not validate their
  output against it. Measured by the 2-A audit: the store validates
  identity at **write** time and vocabulary at **read** time
  (`validateEventRecord`, reachable only from `readEvents`) — so the write
  path accepts records the read path refuses
  ([#738](https://github.com/ecoma-io/archkeep/issues/738)), and
  `deltaDisposition` answers `accepted` for any status outside its
  documented three ([#739](https://github.com/ecoma-io/archkeep/issues/739)).
  Phase 2 correctness hardening owns both fixes; this register states the
  gap, not the fix.
- **R5** — delta verdict-deltas `pass|fail` words from counts
  (`delta-classify.mjs:635-641`); a projection, not a verdict record.
- **R6** — history transition signals are per-record facts; classification
  comes from the canonical `classifyEvolution` — single classifier confirmed.
- **R7** — two edge-identity spellings: `edgeIdentityKey`
  (`diff.mjs:256`, in-memory set arithmetic) vs `edgeEvolutionIdentity`
  (`evolution-event.mjs:212`, escaped stored string). No cross-feeding
  today; **closed as a hazard by Phase 1-E** (PR #732): each function's
  header now names the other and states its carrier boundary (in-memory `\0`
  arithmetic never persisted; escaped `source>target:type` never built from a
  pre-escaped string), cross-referenced from both sites against ADR 0008 and
  INV-6.

## Naming hazards

- **Two modules named `verdict.mjs`** — `src/verdict.mjs` (the check verdict
  lane) and `src/governance/verdict.mjs` (the vocabulary/decision owner).
  Deliberate layering (`verdictFor` composes `buildDecision`), but imports
  read ambiguously and a mis-route is silent. Phase 2 candidate: rename one or
  pin the relationship in both headers. The 2-A audit added a third collision:
  `judgeIntent` (`architecture-intent/judge.mjs`) names its result field
  `.verdict` — the word for a different carrier (WI-4, rename at its own
  gate).
- **Four "intent" surfaces** — `src/architecture-intent/` (the
  constraint-table law, `architecture-intent.json`), `src/intent/` (the
  manifest + Contract-K guard), the declared-change grammar at
  `src/commands/change-intent.mjs`, and the run envelope's intent shape
  (the §1 mapping input `delta`/`change` build). Different concepts, one
  word; [PD-13](DECISIONS.md#program-decisions) ruled (c) — four surfaces,
  never one type. The ownership table above is the disambiguator; a rename
  is a Phase 2 candidate judged under
  [CON-3](CONSTITUTION.md#con-3--generalize-computation-not-domain-vocabulary)
  (keep domain words; rename only the homonyms).
- **`observed` hides the ladder** — the drift/fitness family calls the
  provider graph "observed" (`architecture-intent/model.mjs:11`,
  `report/drift-text.mjs`, `governance/fitness-registry.mjs`), but the
  graph it names is the ladder's composed output — observed **plus**
  normalized and derived — never the raw read. [PD-13](DECISIONS.md#program-decisions)
  keeps the word per family; what binds is
  [BOUNDARIES.md](BOUNDARIES.md)'s ladder boundary sentence, not a rename.
- **`evidence` five spellings, one a misnomer** — the custom-rule evidence
  bundle (`custom-rules/evidence.mjs`), the delta evidence snapshot
  (`delta-snapshot.mjs`, bytes-identity by decision), the
  `Violation.evidence` string, the fitness/decision evidence objects, and
  `report/evidence.mjs` — which is the `buildDecision` re-export and is
  not evidence at all (WI-3 rename). [PD-13](DECISIONS.md#program-decisions)
  ruled (c): five families, two identity conventions, never unified.

## 2-A adjudication — per-concept outcomes

[PD-13](DECISIONS.md#program-decisions) is the full record; this table is
the living map's summary. Outcome classes: **(a)** a canonical domain
object, **(b)** a shared construction contract, **(c)** no canonical
object, relationships pinned.

| Concept     | Outcome               | The pin                                                                                                    |
| ----------- | --------------------- | ---------------------------------------------------------------------------------------------------------- |
| Finding     | (c)                   | families → count keys → `verdictFor`; `check.mjs:519-523` the edge-verdict reshape seam                    |
| Evidence    | (c)                   | five families, two identity conventions; `report/evidence.mjs` rename = WI-3                               |
| Observation | (a)                   | the `src/analysis/` record family (living-ownership table above)                                           |
| Evaluation  | (c)                   | `evaluation-primitives.mjs` hosts helpers, never a canonical object                                        |
| Violation   | (a)                   | `violationOf` (`rules/index.mjs:428`) — the rules lane's canonical record                                  |
| Decision    | (a), split by meaning | envelope: `buildDecision` (`governance/verdict.mjs`); ADR record: `adr-registry`                           |
| Verdict     | (a), per module       | `fitnessVerdict` co-located by family; `judgeIntent`'s `.verdict` field = WI-4                             |
| Policy      | (a)                   | `policy.mjs` owns the disposition ladder; the `provenance-command.mjs:267` bypass = WI-2                   |
| Intent      | (c)                   | four surfaces (naming hazards above)                                                                       |
| Snapshot    | (a), per family       | declaration snapshots (`snapshotIdentity`, ADR 0008) vs observation captures (`captureDelta`); never mixed |
| Provenance  | (a), per family       | `resolveProvenance` (repo origin); `recordDecisionLifecycle` dormant = WI-6 (wire-or-delete)               |

Two family facts the table compresses, stated once here:

- **Snapshot is two concepts, not one.** The declaration-snapshot family
  (graph captures, ADR 0008 identity) and the delta evidence snapshot
  (bytes-identity, no id field) share a word and nothing else. A consumer
  of one never imports the other's identity or classifier — the
  trajectory paragraph below is the checked instance.
- **Trajectory's consumption edges (OQ-10).** Trajectory is a first-class
  consumer of the Graph snapshot family: it imports
  `readSnapshots`/`classifyTransition`/`edgeIdentityKey` plus the envelope
  internals, and imports none of
  `snapshotIdentity`/`classifyEvolution`/`fitnessSnapshot` — the
  declaration-snapshot family is not its lane.

The seven bounded-derivation verdicts (`judgeCoverage`, `moon:declared`
synthesis, `nodeTypeFromLayer`, `isRoot` suppression, `nodeTypeOf`'s lib
default, `isDotnetGeneratedOutput`, and the seventh candidate that earned
no verdict) live where the behaviors live:
[BOUNDARIES.md](BOUNDARIES.md)'s provider-seam section.

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
