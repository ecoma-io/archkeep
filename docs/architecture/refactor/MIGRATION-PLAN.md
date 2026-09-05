# Migration plan

The multi-PR sequence from the current architecture to **Semantic Core +
Capability Facades + Provider Boundary + Thin Surfaces**, with per-phase entry
and exit criteria. The plan is committed to small, serialized, provable steps:
every phase is one or more PRs, every PR carries its differential evidence,
and no phase starts before the previous phase's exit criteria are recorded in
[CONTEXT.md](CONTEXT.md).

Grounding: the findings this plan sequences are the Phase 0 cartography's
([AUTHORITY-MAP.md](AUTHORITY-MAP.md),
[SEMANTIC-MODEL.md](SEMANTIC-MODEL.md), [BOUNDARIES.md](BOUNDARIES.md),
[INVARIANTS.md](INVARIANTS.md), [VALIDATION-MATRIX.md](VALIDATION-MATRIX.md)).
Nothing here authorizes code yet — each phase's PR re-derives its scope from
those pages at its own start ([P-A](CONSTITUTION.md#process-articles)).

## Reading the phases

- **Entry criteria** — what must be true before the phase's first PR.
- **Work** — candidate units, each PR-sized. A unit marked _(only if proven)_
  ships nothing when its investigation proves no gain
  ([CON-0](CONSTITUTION.md#con-0--do-not-trade-semantic-maturity-for-structural-purity)).
- **Exit criteria** — falsifiable: name the suites, the differentials, and the
  doc updates that constitute "done".
- Every phase PR classifies itself against the compatibility contract (root
  `AGENTS.md`) before implementation.

## Work-item contract (binding on every unit, from Phase 1 on)

A phase is not a cleanup bucket, and neither is a PR. A work item enters this
plan only by carrying all eight fields below — in the plan's phase section
and, at execution time, in its PR description:

1. **Finding id** — the audit finding or register row that names the problem
   (`INV-*` gap, `R-n`, `G-n`, `D-n`, or an AUTHORITY-MAP divergence number).
2. **Invariants affected** — which `INV-*` rows the item protects or touches.
3. **Phase justification** — why this phase: which later phase it blocks or
   protects, or why deferring it would raise risk.
4. **Classification** — one of:
   - **SAFE HARDENING** — no observable behavior change on valid inputs;
   - **CORRECTNESS HARDENING** — intentionally changes behavior on invalid,
     impossible, or silent-error inputs, and must record: the compatibility
     class per the contract, the old behavior, the new behavior, the reason,
     the affected exit/error semantics, and the required tests;
   - **DOCUMENTATION-CONTRACT CLARIFICATION** — changes documents only.

   A phase containing a correctness-hardening item may **not** be described
   blanket as "no behavior change" — classification is per item, and the
   changelog names each. This adds classification discipline; it changes no
   compatibility policy (the contract in root `AGENTS.md` decides classes,
   as before).

5. **Smallest safe intervention** — the minimal change that closes the
   finding, stated before implementation.
6. **Non-goals** — what the item explicitly refuses to touch; the line where
   it stops being this item and becomes another phase's work.
7. **Acceptance evidence** — the named suites, red twins, differentials, or
   doc-gate runs that constitute done. "Tests pass" is not evidence.
8. **Rollback strategy** — what a revert restores, and any state to clean.

An item that cannot fill all eight moves to a later phase with its
justification recorded — absence from a phase is then a decision, not an
omission. The coordinator names each PR's ownership lock beside its item
([P-F](CONSTITUTION.md#process-articles)).

## Phase 1 — Authority hardening

Close the gaps around the one enforcement authority and the authority map's
accuracy. No structure moves. The phase is six PR-sized units, each with its
own ownership lock ([P-F](CONSTITUTION.md#process-articles)); units may run
in parallel only where the locks are disjoint.

**Entry**: CHK-1-PREP satisfied — Phase 0 accepted (control plane merged) and
the Phase 0.5 decision closure landed ([PD-8](DECISIONS.md#program-decisions)
through [PD-12](DECISIONS.md#program-decisions), checkpointed in
[CONTEXT.md](CONTEXT.md#chk-1-prep--phase-05--decision-closure--phase-1-execution-baseline-2026-09-05)).

**Work — six PR-sized units:**

### Phase 1-A — Verdict-fold hardening

**Lock**: `authority-boundary/verdict-folds`.

- **Finding**: INV-4 gap; AUTHORITY-MAP divergence 4.
- **Invariants**: INV-4, INV-2, silent-direction coverage (INV-1).
- **Phase justification**: every later phase reads these folds' exit codes as
  ground truth for its differentials; a fold that can silently zero a count
  can flip exit 1 → 0, and a corpus (GAP-A) recorded over such a fold freezes
  wrong answers. Blocks Phase 4's gate; protects every phase's evidence.
- **Classification: CORRECTNESS HARDENING.**
  - **Old behavior**: at `verdictFor` a misspelled or missing count key
    defaults to 0 — a failing run can report pass (exit 1 → 0) with no error
    anywhere; the sibling folds hand-roll their status/exit literals over
    inputs no shape-check rejects.
  - **New behavior**: loud refusal — no-verdict status, exit 3, naming the
    malformed input — on the malformed-internal-input path only.
  - **Valid-input compatibility**: every valid workspace's output is
    unchanged, byte-for-byte where a contract freezes the bytes.
  - **Malformed-input compatibility**: **bug fix** — the silent direction the
    root invariant forbids; no valid input changes meaning.
  - **Exit/no-verdict behavior**: exit 3 + no-verdict envelope on malformed
    internal counts, at all five fold sites (check/delta/change/fitness via
    their carriers; `rules verify` under its artifact-integrity contract, not
    as a lane member).
- **Smallest intervention**: validate the counts/fold-input shape at each
  fold's input boundary; refuse unknown/missing keys.
- **Non-goals**: no routing of sibling carriers through `verdictFor`
  ([PD-6](DECISIONS.md#program-decisions)); no routing `rules verify`
  through the lane ([PD-8](DECISIONS.md#program-decisions)); no fold
  unification; no shared fold framework; no new abstraction framework; no
  output change on valid inputs.
- **Acceptance evidence**: five silent-direction twins red-by-construction
  (each demonstrated by planting the defect and watching its twin fail);
  full [Vitest suite](../../development/testing.md) green; envelope/exit
  matrices green; `node packages/archkeep/cli.mjs check` green;
  valid-fixture outputs unchanged.
- **Rollback**: revert the PR; folds return to today's silent defaults — the
  pre-Phase-1 state; no state migration.

### Phase 1-B — `rules verify` authority classification + contract

**Lock**: `authority-boundary/rules-integrity`. **This is NOT a migration
into the architecture evaluation lane.**

- **Finding**: OQ-13, closed by
  [PD-8](DECISIONS.md#program-decisions); the authority map's carrier
  wording had counted `rules verify` an architecture carrier evaluating
  "the same law" — false, and every later phase cites that map.
- **Invariants**: INV-4, INV-25 (wording), INV-2 (the shared latch).
- **Phase justification**: a verdict-bearing command's law, contract, and
  lane membership must be stated where every phase reads it, or the
  misreading returns.
- **Classification**: DOCUMENTATION-CONTRACT CLARIFICATION.
- **Scope**: codify the bounded artifact-integrity domain in
  [AUTHORITY-MAP.md](AUTHORITY-MAP.md) (its decision-rights row and the
  carrier-vocabulary entry); verify from source that its status vocabulary is
  the shared one and record that verification (it is: `jsonEnvelope` +
  `EXIT_FOR_STATUS`); pin the current fold contract only where a test is
  missing. No `buildDecision`/`verdictFor` reroute; no `RulesVerifyEngine`/
  `IntegrityEngine`; no rewrite of the implementation merely because the
  documentation changed.
- **Isolation**: this unit is documentation; it must not edit
  `src/commands/rules.mjs` or `cli.mjs` (territory of 1-A's lock). A missing
  behavioral pin rides 1-A.
- **Smallest intervention**: the map rows, plus any missing pin.
- **Acceptance evidence**: AUTHORITY-MAP true against source; docs gates
  green; no behavioral diff (no code changed).
- **Rollback**: doc revert.

### Phase 1-C — Provider policy adjudication (Moon)

**Lock**: `provider-seam`.

- **Finding**: AUTHORITY-MAP divergence 1; INV-9 gap.
- **Invariants**: INV-9.
- **Phase justification**: Phase 3's G-1 scan cannot be written until each
  transformation is adjudicated contract-or-violation; Phase 7's seam
  collapse consumes the same decision.
- **Classification**: **DOCUMENTATION-CONTRACT CLARIFICATION** for each
  decision (a tested normalization contract at the provider seam, or
  documented provider policy via a new ADR — either outcome acceptable,
  silent retention not); any test that pins an adjudicated behavior is
  SAFE HARDENING (pins what already happens, changes nothing).
- **Scope** — each of the five transformations becomes one of: a
  contract-backed normalization, an explicit documented provider policy, or
  a rejected/removed candidate (a removal is a later phase's code work,
  differentially gated):
  1. edge filtering (root-scoped edges),
  2. vocabulary inversion (Moon `implicit` → Archkeep's inverse vocabulary,
     the #262 fix),
  3. scope collapse (to `static`),
  4. tag synthesis (`layer:`/`stack:`),
  5. workspace-layout inference.
- **Smallest intervention**: the per-item decision record.
- **Non-goals**: **no provider rewrite, no restructuring of `moon.mjs`, no
  new provider abstraction** — this is policy-contract adjudication;
  provider architecture work is Phase 7's, differentially gated.
- **Acceptance evidence**: every named transformation carries a recorded
  verdict citing its contract or ADR; the provider-seam table (1-D)
  updated consistently; suites green.
- **Rollback**: revert the records and any pinning tests.

### Phase 1-D — Provider seam contract definition

**Lock**: `provider-seam` — **serialized after 1-C** (same lock, [P-F](CONSTITUTION.md#process-articles)).

- **Finding**: provider audit (three seam shapes; the LSP holds a fourth).
- **Invariants**: INV-9; protects Phase 7's entry.
- **Phase justification**: Phase 7 collapses the LSP's private Nx discovery
  into this seam; a seam must be defined before it can be collapsed into,
  and defining it now prevents Phase 7 from inventing one under pressure.
- **Classification**: DOCUMENTATION-CONTRACT PER-SEAM CLARIFICATION.
- **Scope**: document, per provider (Nx, native, Moon) and against the LSP's
  private path: the acquisition shape, the normalization boundary, the
  failure/loudness behavior, and the consumer contract. The known LSP
  divergence is recorded against it as "collapses in Phase 7".
- **Smallest intervention**: the per-provider contract table in
  [BOUNDARIES.md](BOUNDARIES.md#provider-seam).
- **Non-goals**: no code; no unification of implementations (Phase 7 work,
  differentially gated).
- **Acceptance evidence**: the table exists; the LSP divergence is recorded
  against it as "collapses in Phase 7".
- **Rollback**: doc revert.

### Phase 1-E — R7 edge identity

**Lock**: `state-identity`.

- **Finding**: R7 (`edgeIdentityKey` in-memory vs `edgeEvolutionIdentity`
  stored).
- **Invariants**: INV-6.
- **Phase justification**: a structural phase (2–4) that moves or rewires
  diff/event code with the two spellings looking interchangeable can break
  event dedupe silently; the ambiguity is closed before code moves.
- **Classification**: DOCUMENTATION-CONTRACT CLARIFICATION for the pin;
  SAFE HARDENING only if review shows a comment pin cannot hold (then a
  structurally distinct type, outputs byte-identical).
- **Scope** — prefer the smallest change: cross-reference pin both headers
  first; a distinct type only if comments/headers are demonstrably
  insufficient. No identity algorithm change; no unification of the two
  spellings — they serve different media (in-memory set arithmetic vs
  escaped stored string); no change to any stored event identity.
- **Smallest intervention**: the cross-reference headers.
- **Acceptance evidence**: both headers carry the cross-reference (or the
  distinct-type change with event-identity suites green and outputs
  unchanged); docs gates green.
- **Rollback**: revert.

### Phase 1-F — D1–D6 documentation truth

**Lock**: `documentation-truth`.

- **Finding**: D1–D6 (each measured stale by audit, re-verified by
  adversarial review).
- **Invariants**: none directly; [P-A](CONSTITUTION.md#process-articles)
  (docs precede code).
- **Phase justification**: later phases cite these sentences as facts while
  hardening the code beside them; a stale sentence beside a hardening
  change is a lie the refactor itself introduced.
- **Classification**: DOCUMENTATION-CONTRACT CLARIFICATION — each rider is
  its measured sentence and nothing around it.
- **Scope** — the stale sentences Phase 0 measured: `governance/verdict.mjs`
  header's `not_applicable` claim (D1), `docs/reference/evidence.md:25` cell
  (D2), `src/canonical.mjs` stale path (D3), `json.mjs:3` "six commands"
  (D4), Moon-on-LSP sentence in `docs/concepts/integrations.md` (D5),
  `docs/development/repository.md`'s stale required-checks claim (D6 — fixed
  by re-measuring the ruleset API at fix time, never by copying AGENTS.md's
  date).
- **Isolation**: each rider remains isolated — stale claim, measured truth,
  exact corrected sentence, validation gate. A rider that would grow into a
  page rewrite is out of scope and moves out with justification.
- **Smallest intervention**: fix the named sentence.
- **Non-goals**: no page rewrites; no broad documentation cleanup; no
  unrelated rewriting; no reformatting beyond the sentence.
- **Acceptance evidence**: each D-n closed with its corrected sentence;
  docs gates (`check-docs-links`, `check-docs-claims-parity`) green; D6
  cites its measurement date.
- **Rollback: revert.**

**Phase 1 exit gate** — a table, not prose. A unit is **PASS** only when
its implementation PR's acceptance evidence has been reviewed; a unit with
no implementation PR yet is **DEFER**, never PASS — unwritten code proves
nothing; **FAIL** is an implementation that landed without its evidence:

| Unit | Item                          | Status | What its PR must prove                                                           | Landed evidence                                                                                                                                                                                                      |
| ---- | ----------------------------- | ------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1-A  | Verdict-fold hardening        | PASS   | five red-by-construction twins; valid-input outputs unchanged; exit-matrix green | PR #730 — latches at all five fold sites; twins planted, demonstrated red, restored; valid-input fixtures byte-identical; exit-matrix green                                                                          |
| 1-B  | `rules verify` classification | PASS   | AUTHORITY-MAP true against source; docs gates green; no code touched             | PR #731 — dated PD-8 verification extension, every line ref re-measured after 1-A; no `packages/` change                                                                                                             |
| 1-C  | Moon policy adjudication      | PASS   | per-item recorded verdicts; seam table consistent                                | PR #734 — MOON-POLICY.md + ADR 0009/0010 + registry pin; three contract-backed normalizations, two ADR policies, no silent retention; cited by 1-D's table                                                           |
| 1-D  | Provider seam definition      | PASS   | BOUNDARIES table with per-provider contract                                      | this PR — six-column contract table, source-verified, LSP divergence registered against it as Phase 7; the row's PASS holds at the moment this PR merges (the gate's DEFER rule reads it DEFER at any earlier point) |
| 1-E  | R7 edge-identity pin          | PASS   | both headers pinned (or distinct type + identity suites green)                   | PR #732 — both headers pinned cross-referencing ADR-0008/INV-6; identity suites green; manifest digests updated                                                                                                      |
| 1-F  | Riders D1–D6                  | PASS   | each D-n closed; docs gates green                                                | PR #733 — D1–D6 closed; D6 re-measured against the ruleset API at fix time; coordinator review corrected a false emission-site claim and added the missing fourth emission site before merge                         |

Phase exit = every row PASS, or a row's DEFER explicitly accepted by the
maintainer with the risk recorded in [CONTEXT.md](CONTEXT.md). The blanket
phrase "no behavior change" is **withdrawn** for this phase: unit 1-A is
correctness hardening by design and its changelog entry says so; units
1-B–1-F are documentation/contract work whose code, if any, is pin-only.

**PHASE 1 = COMPLETE on merge of this PR** — every row PASS with its
evidence reviewed (coordinator adversarial review on each PR, an independent
state-reconciliation audit, and a 10-vector hostile review at close,
2026-09-06, whose findings are dispositioned in this same PR; 1-D's own row
is this PR, so its PASS is the merge itself);
[CONTEXT.md](CONTEXT.md#chk-1-close--phase-1-authority-hardening-2026-09-06)
records the checkpoint. Deferred findings and their owning phases live
there; none blocks Phase 2.

**Parallelism**: the locks — `authority-boundary/verdict-folds` (1-A),
`authority-boundary/rules-integrity` (1-B), `provider-seam` (1-C → 1-D,
serialized pair), `state-identity` (1-E), `documentation-truth` (1-F) — are
disjoint across the five groups, so PRs may overlap across them
([P-F](CONSTITUTION.md#process-articles)). Two file-level notes the
coordinator enforces: 1-B must not edit `src/commands/rules.mjs` or
`cli.mjs` (1-A's territory); 1-C's records feed 1-D's table, hence the
serialization.

## Phase 2 — Canonical model hardening

One owner per concept, in fact and in name.

**Entry**: Phase 1 exit recorded.

**Work**:

1. **2-A — Canonical semantic audit (gates the rest of this phase).** Before
   any canonicalization code, adjudicate the semantic concepts the engine
   already speaks — Finding first among them:

   - **The concept roster** — audit each of: Finding, Evidence, Observation,
     Evaluation, Violation, Decision, Verdict, Policy, Intent, Snapshot,
     Provenance. Per concept: current owner, meaning, inputs, outputs, what
     it may own, what it must not own, construction sites, projection
     sites, adapter representations — measured against source, not against
     what the docs currently say.
   - **Finding first**: enumerate every Finding-construction site with its
     precise semantics — what it carries, what it references, when it
     fires; map the relations Finding ↔ Evidence ↔ Evaluation ↔ Violation ↔
     Decision ↔ Verdict: for each pair, who owns, who references, who
     must-not-own;
   - **The provider ladder as a question, not an answer**: Phase 1-D's
     responsibility ladder
     ([BOUNDARIES.md](BOUNDARIES.md#provider-seam)) is documented as an
     implementation boundary. 2-A investigates whether
     observed/normalized/derived/evaluated/decided should become an
     architectural model (named types, enforced seams) or stays an
     implementation boundary — deciding requires evidence that the
     distinction is load-bearing in code, not merely legible in prose. A
     legitimate outcome is **"no new canonical type is justified."**
   - **Inputs the Phase 1 closing audit already measured** (recorded here so
     2-A starts from evidence, not re-derivation). The strongest
     silent-direction candidate is the **"violation" word collision**: the
     typed rule finding (`rules/index.mjs:428-442`, exit 1) shares its name
     with validation-message string arrays (`findNativeModelViolations`,
     the config-law validators, `originViolations` — all exit 3); code
     moving between the classes silently changes what "clean" means.
     **Decision** carries two unrelated meanings (run envelope vs ADR
     record, both live inside `commands/evaluation-primitives.mjs`);
     **Evidence** has four spellings (custom-rule bundle, delta evidence
     snapshot, `Violation.evidence` string, fitness/decision evidence
     objects) beside the naming hazard `report/evidence.mjs` (which is the
     `buildDecision` re-export, not evidence); the drift/fitness family
     calls the provider graph "observed"
     (`architecture-intent/model.mjs:11`, `report/drift-text.mjs`,
     `governance/fitness-registry.mjs`), hiding its
     normalization+derivation. Six bounded-derivation behaviors are
     named in the seam contract but carry no per-item verdict of their
     own — `buildDependencies`' root-target edge suppression,
     `nodeTypeOf`'s `lib` fallback, `judgeCoverage`'s provider-local
     coverage gate, `isDotnetGeneratedOutput`'s generated-output
     exclusion, `moon:declared` targets synthesis (`moon.mjs:725-737`,
     the twin the native row records as bounded derivation but
     MOON-POLICY's five missed — surfaced by the close-time hostile
     review), and `nodeTypeFromLayer`'s unknown-layer `lib` fallback
     (`moon.mjs:352-361`, analogy-recorded in MOON-POLICY, explicitly
     "not a sixth verdict") — each needs
     its per-item verdict, with 1-C's two ADRs as the precedent shape. For
     the ladder question specifically, the same audit found no
     demonstrated defect class that tests cannot pin, stages interleaved
     inside single functions, and no second consumer of a stage's output —
     evidence for "implementation boundary" — and named the graduation
     triggers that would justify revisiting: a second consumer needing a
     stage's output independently of evaluation, the LSP fourth path
     regrowing after Phase 7's collapse, a seam defect tests demonstrably
     cannot pin, or a stage word with drifting constructor sites.
   - recommend one of exactly three outcomes **per audited concept** —
     **(a)** a canonical domain object, **(b)** a shared construction
     contract with no new object, or **(c) no canonical object at all** (the
     sites stay separate, their relationships pinned). All three are
     legitimate; the deliverable is the adjudicated decision, not an object.

   No Finding "god object": a Finding that grows judgment fields, lifecycle
   state, or surface-specific rendering is rejected at review
   ([CON-3](CONSTITUTION.md#con-3--generalize-computation-not-domain-vocabulary),
   [CON-4](CONSTITUTION.md#con-4--canonical-semantic-models)). No concept is
   canonicalized because two implementations "look alike" — symmetry is not
   evidence of a shared invariant. The chosen
   outcome is recorded ([DECISIONS.md](DECISIONS.md), or an ADR if it is an
   architecture decision) and maintainer-approved **before** item 2-B starts.
   Classification: DOCUMENTATION-CONTRACT CLARIFICATION; acceptance: the
   recorded, approved decision; rollback: revert the record.

2. **2-B — The finding concept** — implement 2-A's approved outcome across
   the four judgment sites
   ([SEMANTIC-MODEL.md](SEMANTIC-MODEL.md#finding--the-unowned-concept)). If
   2-A ruled outcome (c), this item is the relationship pins and closes as
   documentation. Message wording stays in the registries.
3. **2-C — Message registries** — three registries with identical shape
   collapse to one home with per-domain tables. Rendered bytes must not
   change (pinned verbatim by `messages.test.mjs` +
   `upstream.integration.test.mjs`).
4. **2-D — Naming hazards** — the two `verdict.mjs` modules and the three
   "intent" nouns get either renames or pinned relationship headers, decided
   under
   [CON-3](CONSTITUTION.md#con-3--generalize-computation-not-domain-vocabulary)
   (rename homonyms, never domain words). Public exports are API — renames
   follow the compatibility contract.
5. **2-E — Vocabulary registers R1–R6** — the boundary sentences (R1),
   disposition construction validation (R4), and cross-references land;
   registers that need no code close as documentation.

**Exit**: 2-A's decision recorded and maintainer-approved, and 2-B
implementing exactly it; [SEMANTIC-MODEL.md](SEMANTIC-MODEL.md) ownership
table true with zero "unowned/hazard" rows remaining or each remaining row
carrying a recorded keep-reason; message bytes identical (differential rows 1
and 12 of
[VALIDATION-MATRIX.md](VALIDATION-MATRIX.md#output-differentials-every-structural-phase-must-run));
intent-manifest digests updated in the same PR for any evidence-named file
moved (INV-18).

## Phase 3 — Boundary enforcement

Turn declared layer laws into scans.

**Entry**: Phase 2 exit recorded.

**Work**:

1. **G-1** core → `providers/` import scan (the direction intent A claims).
2. **G-5** `report/` imports no rule/config law.
3. **G-2** `commands` → `lsp` scan.
4. **G-7** orphan-module rule (every `src/**.mjs` reachable from an entry).
5. **The DAG, stated** — [BOUNDARIES.md](BOUNDARIES.md) grows the
   intra-`src/` dependency DAG (closing doctrine gap DG-2), and the measured
   pressure edges each get a recorded decision: keep-with-reason or break.
6. G-3/G-4/G-6/G-8 stay conventions **unless** this phase's investigation
   proves a scan's worth; the decision is recorded either way.

**Exit**: each new scan demonstrated red on a planted violation (a
silent-direction twin per scan — the scan that cannot fail is not a gate);
DAG stated and consistent with `module-graph.test.mjs`'s acyclicity; boundary
self-check green.

## Phase 4 — Internal extraction (proven gains only)

The first structural phase. Moves code **inside** `packages/archkeep/src/`
only.

**Entry** — the hard gate: **GAP-A closed**. The golden-output corpus is
recorded (per-verb text+json+sarif over pinned trees, regen procedure
modeled on `ARCHKEEP_UPDATE_ENVELOPE_SHAPE`, human-gated), and the
byte-identity comparator covers every read-only verb (GAP-B). Without these,
"semantic equivalence" during a move is unverifiable — the phase does not
start.

**Work** _(only if proven)_: candidate extractions that make a previously
possible dependency impossible or unnecessary — each accompanied by the
concrete gain it buys ([CON-0](CONSTITUTION.md#con-0--do-not-trade-semantic-maturity-for-structural-purity)).
The Phase 0 cartography names no extraction as proven; candidates must argue
from the pressure edges recorded in [BOUNDARIES.md](BOUNDARIES.md#measured-pressure-points-edges-that-exist-today),
not from aesthetics.

**"No proven extraction" is a successful Phase 4 outcome.** The phase's
deliverable is the investigation with its evidence, not a moved module: if no
candidate demonstrates a gain, the phase closes with a checkpoint recording
"no proven extraction" and the investigations that established it — that is a
green exit, recorded in [CONTEXT.md](CONTEXT.md), and Phase 5 enters on it.
Package count, file count, directory aesthetics, and moved-module counts are
**not progress metrics** anywhere in this program; a PR that argues from them
trips stop item 8 under [P-D](CONSTITUTION.md#process-articles).

**Exit**: for every moved module — corpus diff empty or row-by-row re-blessed
with the reason; ESLint differential + native differential green; envelope
roster unchanged; intent-manifest digests updated same-PR (INV-18); the
extraction's stated gain re-verified against the actual post-state. An
extraction that cannot demonstrate its gain is reverted
([P-D](CONSTITUTION.md#process-articles)). If nothing moved: the no-proven-
extraction checkpoint with its investigations recorded.

## Phase 5 — Capability facades

Organize the command layer by capability — composition, not re-implementation.

**Entry**: Phase 4 exit recorded (or Phase 4 closed with "no proven
extractions", recorded); the capability words' owner is
[`docs/concepts/architecture.md`](../../concepts/architecture.md#the-24-commands)
([PD-9](DECISIONS.md#program-decisions), closing OQ-1), and the regrouping
carries its own maintainer decision record before implementation
([PD-11](DECISIONS.md#program-decisions), closing OQ-3).

**Work**:

1. The capability grouping (check / analyze / inspect / compare / explain /
   govern / rules — the vocabulary
   [`docs/concepts/architecture.md`](../../concepts/architecture.md#the-24-commands)
   owns, per [PD-9](DECISIONS.md#program-decisions)) becomes explicit in
   `src/commands/` layout or facade modules, each delegating to the canonical
   core ([CON-9](CONSTITUTION.md#con-9--surface--package)).
2. No verb, flag, exit code, or envelope field changes — CLI spellings are
   API. If the maintainer authorizes a spelling change, it lands as its own
   classified change, never smuggled inside a facade move.
3. The intent-load gate triplication (three drivers repeating the same
   `tracked.includes(INTENT_FILE)` + `loadIntent` gate) unifies behind one
   helper.

**Exit**: every verb identical over the corpus at validation levels 1–2
(semantic + contract goldens; incidental-byte drift triaged, not gated); exit
matrix green; facade modules hold zero judgment (G-scans from Phase 3
extended to them if needed); the capability vocabulary in
[`docs/concepts/architecture.md`](../../concepts/architecture.md#the-24-commands)
and the surface rows in [AUTHORITY-MAP.md](AUTHORITY-MAP.md) updated in the
same PR.

## Phase 6 — CLI recomposition

`cli.mjs` drivers shrink to wiring.

**Entry**: Phase 5 exit recorded.

**Work**: drivers delegate fully to facades; usage-error lane untouched;
`--help` output stable (it is contract). Any driver logic that is semantic
moves down a layer, not sideways.

**Exit**: exit-matrix green per verb side (ok/refused plus the suite's named
extras), findings-mode pinned for the five exit-1 verbs
(`check`, `fitness`, `delta --compare`, `change`, `rules verify`), over the corpus;
`cli.integration` spawned-binary suite green; `--help` byte-stable; no
driver imports an analyzer or provider directly (scan if Phase 3 built one).

## Phase 7 — Additional surfaces (LSP, MCP, VS Code)

Each surface stays a client of the one engine.

**Entry**: Phase 6 exit recorded.

**Work**:

1. **LSP** — collapse the private Nx discovery
   (`workspace-index.mjs:398-533`) into the provider seam from Phase 1;
   package-based Nx workspaces then yield the same graph the CLI sees.
   Golden LSP responses recorded first (GAP-E) — the server refactor's
   differential.
2. **MCP** — close the seam widening: `engine.mjs:71`'s root-imports fold
   back behind `./commands`, or the seam definition is honestly widened by
   decision with the compatibility contract re-classified.
3. **VS Code** — untouched unless a Phase 1–6 change moved something it
   consumes; it ships no analysis and must stay that way.

**Exit**: LSP differential (golden responses before/after) empty or
re-blessed; MCP suite green; `verify-package.mjs`'s LSP-through-symlink and
optional-peer checks green; empty-diagnostic two-site discipline intact
(INV-1).

## Phase 8 — Federation readiness (runway, not machinery)

**Entry**: Phases 1–7 recorded; maintainer confirmation that federation work
is wanted now ([CON-8](CONSTITUTION.md#con-8--snapshot-and-federation-runway-not-machinery)
forbids speculative building).

**Work** _(only if authorized)_: make project/repository identity, snapshot
semantics, provenance, and evidence externalization explicit as contracts
(the replay substrate [DATA-FLOW.md](DATA-FLOW.md) already names). No
`FederationService` until a concrete requirement proves it.

**Exit**: whatever contracts were made explicit are documented, tested, and
differentially stable; nothing speculative exists.

## Phase 9 — Final hardening

**Entry**: Phase 8 exit recorded (or Phase 8 waived by maintainer).

**Work**: the full matrix — every T1 suite, every differential row, the
ESLint + real-trees lanes, `verify-package` from outside the workspace, the
determinism family triple-run; a final pass over this control plane retiring
stale rows; the changelog states, per release, what (if anything) observably
moved. Two recorded decisions close here (either the fix or the reasoned
no-fix, per the budget-honesty rule):

- **GAP-C (differential breadth)** — adopt value differentials for
  governance/provenance/report surfaces, or record why the relationship pins
  plus unit suites suffice.
- **GAP-D (cross-version baseline)** — adopt a committed engine-output
  baseline at version N diffed at N+1 in the release lane, or record why the
  corpus plus the differentials suffice.

**Exit**: the [REFRACTOR MATURITY GATE](#refractor-maturity-gate) below,
scored and recorded in [CONTEXT.md](CONTEXT.md) with evidence links.

## REFRACTOR MATURITY GATE

Each phase's final PR scores itself; the program closes only when every row
holds. Any NO is a [P-D](CONSTITUTION.md#process-articles) stop.

| #   | Dimension                     | Evidence required                                                                                                                                                                                 |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | One enforcement authority     | **Semantic authority count is one, unchanged** ([INV-25](INVARIANTS.md)): AUTHORITY-MAP true, verdict-layering scan green, per-PR adversarial review named the count; no surface holds judgment   |
| 2   | Semantic flow one-way         | DAG stated and scanned (Phase 3 output); no cycles; no re-derivation sites                                                                                                                        |
| 3   | Canonical models single-owned | SEMANTIC-MODEL table with zero unresolved hazard rows; no concept with two constructors; every equivalent representation sits at an adapter/projection boundary with its conversion named         |
| 4   | Providers observe only        | G-1 scan green; Moon policy adjudicated (Phase 1) and its contract tested                                                                                                                         |
| 5   | Determinism                   | determinism suites + corpus comparison across all read-only verbs at the [validation levels](VALIDATION-MATRIX.md) — semantic and contract goldens gated; incidental bytes triaged, not gated     |
| 6   | Differential safety           | every structural PR's differential recorded; corpus diff closed                                                                                                                                   |
| 7   | Empty-result invariant        | refusal-contract + coverage-loudness + LSP two-site green, with red twins                                                                                                                         |
| 8   | Contract stability            | exit matrix, envelope roster, SARIF, LSP protocol, MCP surface, exports — green and unchanged (or re-classified via the compatibility contract with changelog)                                    |
| 9   | Docs precede and follow code  | every PR's doc updates landed same-PR; docs gates green; no doc claims protection a witness does not enforce (stop item 10)                                                                       |
| 10  | Review independence           | adversarial review recorded per architectural PR ([P-B](CONSTITUTION.md#process-articles)); implementer never the final reviewer ([P-E](CONSTITUTION.md#process-articles))                        |
| 11  | Extraction honesty            | every landed extraction demonstrates its gain against its post-state; "no proven extraction" recorded as an outcome where that is the result; package/file counts never used as progress evidence |

## Cross-cutting rules

- **Decisions before implementation** — every architecture-affecting
  question is classified before the code that would depend on it
  ([P-G](CONSTITUTION.md#process-articles)); "open question" is not a state,
  and [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) is the decision register, not a
  waiting room.
- **Serialization** — one phase at a time; within a phase, PRs may overlap
  only across disjoint ownership locks
  ([P-F](CONSTITUTION.md#process-articles)): no two PRs change the same
  canonical model, authority boundary, or provider seam, and disjointness is
  proven by the dependency graph. The coordinator names each PR's lock in
  its work-item contract.
- **Subagents never merge** — workers return patches/findings/evidence; the
  coordinator synthesizes and the maintainer merges. Subagents may not amend
  the constitution, invariant registry, or authority map
  ([P-E](CONSTITUTION.md#process-articles)).
- **INV-18 tripwire** — any PR moving an evidence-named file updates
  `src/intent/intent-manifest.json` digests in the same PR.
- **Stop conditions** — [P-D](CONSTITUTION.md#process-articles), enumerated
  1–12; a stop is reported as REWORK with the failing item, never silently
  absorbed.
- **Evidence-first exits** — a phase-exit claim cites its evidence, not its
  author: "boundary enforced" needs the scan demonstrated red on a planted
  violation; "deterministic" needs the determinism suites; "no semantic
  drift" needs the named differential rows; "one authority" needs the
  AUTHORITY-MAP plus review evidence naming the count
  ([INV-25](INVARIANTS.md)). A claim whose evidence is "it should hold" is
  not a claim.
- **Architectural debt budget** — every checkpoint reports: known gaps before
  (ids), gaps closed, new gaps introduced (ids), and the net delta in one
  sentence. Closing G-1 while opening G-9 is not net-zero unless the record
  says why the new gap is smaller; a phase whose complexity moved but did
  not shrink must name the architectural gain that justifies it (a dependency
  made impossible, an isolation bought). A ledger, not a numerical KPI — no
  scores, only the honest delta.
- **Budget honesty** — a phase that investigates and finds nothing worth
  doing closes with that finding recorded; an empty phase is a legitimate
  outcome ([CON-0](CONSTITUTION.md#con-0--do-not-trade-semantic-maturity-for-structural-purity)).
