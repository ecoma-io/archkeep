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

## Phase 1 — Authority hardening

Close the gaps around the one enforcement authority. No structure moves.

**Entry**: Phase 0 accepted (this control plane merged).

**Work**:

1. **Harden the verdict folds — the class, not one site** — `verdictFor`'s
   untyped 14-field counts tuple becomes a validated shape (a misspelled or
   missing key refuses loudly instead of defaulting to 0), and the four
   sibling fold sites (`delta.mjs:751-781`, `change.mjs:751-780`,
   `fitness.mjs:211-216`, `rules.mjs:444-448`) get the same audit: any
   silent-default input that could zero a count or flip an exit is refused
   loudly (INV-4's gap; the loudest latent defect class found). Regression:
   a silent-direction twin per site (a wrong key must turn the run red, not
   green).
2. **Adjudicate the Moon provider's policy surface** — item by item (edge
   filter, vocabulary inversion, scope collapse, tag synthesis, layout
   inference): lift into an explicit, tested normalization contract at the
   provider seam, or pin as documented provider policy via a new ADR. Either
   outcome is acceptable; silent retention is not (INV-9).
3. **Normalize the provider seam definition** — one documented seam shape (or
   an explicit per-provider contract table) so Phase 7 can collapse the LSP's
   private copy into it.
4. **Edge-identity spelling** (register R7) — make the diff-internal key
   structurally distinct from the stored/event spelling, or cross-reference
   pin both headers.
5. **Doc-truth riders** — the stale sentences Phase 0 measured, fixed in the
   same phase because documentation precedes code: `governance/verdict.mjs`
   header's `not_applicable` claim (D1), `docs/reference/evidence.md:25` cell
   (D2), `src/canonical.mjs` stale path (D3), `json.mjs:3` "six commands"
   (D4), Moon-on-LSP sentence in `docs/concepts/integrations.md` (D5),
   `docs/development/repository.md` stale required-checks claim (D6 — fixed
   by re-measuring the ruleset API, not by copying AGENTS.md's date).

**Exit**: verdict lane input validated with a red-in-silent-direction test;
Moon policy adjudicated with the decision recorded (ADR or contract);
seam shape stated in [BOUNDARIES.md](BOUNDARIES.md); D1–D6 closed; full
[Vitest suite](../../development/testing.md) green; envelope/exit matrices
green; `node packages/archkeep/cli.mjs check` green; no behavior change
unclassified (each rider is a fix or additive, per the compatibility
contract).

## Phase 2 — Canonical model hardening

One owner per concept, in fact and in name.

**Entry**: Phase 1 exit recorded.

**Work**:

1. **The finding concept** — one module owns "what a finding is" across the
   four judgment sites ([SEMANTIC-MODEL.md](SEMANTIC-MODEL.md#finding--the-unowned-concept)).
   The four sites construct through it; message wording stays in the
   registries.
2. **Message registries** — three registries with identical shape collapse to
   one home with per-domain tables. Rendered bytes must not change (pinned
   verbatim by `messages.test.mjs` + `upstream.integration.test.mjs`).
3. **Naming hazards** — the two `verdict.mjs` modules and the three "intent"
   nouns get either renames or pinned relationship headers, decided under
   [CON-3](CONSTITUTION.md#con-3--generalize-computation-not-domain-vocabulary)
   (rename homonyms, never domain words). Public exports are API — renames
   follow the compatibility contract.
4. **Vocabulary registers R1–R6** — the boundary sentences (R1), disposition
   construction validation (R4), and cross-references land; registers that
   need no code close as documentation.

**Exit**: [SEMANTIC-MODEL.md](SEMANTIC-MODEL.md) ownership table true with
zero "unowned/hazard" rows remaining or each remaining row carrying a recorded
keep-reason; message bytes identical (differential row 1 + 12 of
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

**Exit**: for every moved module — corpus diff empty or row-by-row re-blessed
with the reason; ESLint differential + native differential green; envelope
roster unchanged; intent-manifest digests updated same-PR (INV-18); the
extraction's stated gain re-verified against the actual post-state. An
extraction that cannot demonstrate its gain is reverted
([P-D](CONSTITUTION.md#process-articles)).

## Phase 5 — Capability facades

Organize the command layer by capability — composition, not re-implementation.

**Entry**: Phase 4 exit recorded (or Phase 4 closed with "no proven
extractions", recorded).

**Work**:

1. The capability grouping (check / analyze / inspect / compare / explain /
   govern / rules — [AUTHORITY-MAP.md](AUTHORITY-MAP.md) and WS3's verb map
   is the input) becomes explicit in `src/commands/` layout or facade
   modules, each delegating to the canonical core
   ([CON-9](CONSTITUTION.md#con-9--surface--package)).
2. No verb, flag, exit code, or envelope field changes — CLI spellings are
   API. If the maintainer authorizes a spelling change, it lands as its own
   classified change, never smuggled inside a facade move.
3. The intent-load gate triplication (three drivers repeating the same
   `tracked.includes(INTENT_FILE)` + `loadIntent` gate) unifies behind one
   helper.

**Exit**: every verb byte-identical over the corpus; exit matrix green;
facade modules hold zero judgment (G-scans from Phase 3 extended to them if
needed); capability map in [AUTHORITY-MAP.md](AUTHORITY-MAP.md) updated in
the same PR.

## Phase 6 — CLI recomposition

`cli.mjs` drivers shrink to wiring.

**Entry**: Phase 5 exit recorded.

**Work**: drivers delegate fully to facades; usage-error lane untouched;
`--help` output stable (it is contract). Any driver logic that is semantic
moves down a layer, not sideways.

**Exit**: exit-matrix green per verb side (ok/refused plus the suite's named
extras), findings-mode pinned for the five verdict carriers, over the corpus;
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

| #   | Dimension                     | Evidence required                                                                                                                                              |
| --- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | One enforcement authority     | AUTHORITY-MAP table true; verdict-layering scan green; no surface holds judgment                                                                               |
| 2   | Semantic flow one-way         | DAG stated and scanned (Phase 3 output); no cycles; no re-derivation sites                                                                                     |
| 3   | Canonical models single-owned | SEMANTIC-MODEL table with zero unresolved hazard rows                                                                                                          |
| 4   | Providers observe only        | G-1 scan green; Moon policy adjudicated (Phase 1) and its contract tested                                                                                      |
| 5   | Determinism                   | determinism suites + corpus byte-identity across all read-only verbs                                                                                           |
| 6   | Differential safety           | every structural PR's differential recorded; corpus diff closed                                                                                                |
| 7   | Empty-result invariant        | refusal-contract + coverage-loudness + LSP two-site green, with red twins                                                                                      |
| 8   | Contract stability            | exit matrix, envelope roster, SARIF, LSP protocol, MCP surface, exports — green and unchanged (or re-classified via the compatibility contract with changelog) |
| 9   | Docs precede and follow code  | every PR's doc updates landed same-PR; docs gates green                                                                                                        |
| 10  | Review independence           | adversarial review recorded per architectural PR ([P-B](CONSTITUTION.md#process-articles))                                                                     |

## Cross-cutting rules

- **Serialization** — one phase at a time; within a phase, PRs may overlap
  only across disjoint ownership locks. No two PRs edit one semantic boundary
  concurrently.
- **Subagents never merge** — workers return patches/findings/evidence; the
  coordinator synthesizes and the maintainer merges.
- **INV-18 tripwire** — any PR moving an evidence-named file updates
  `src/intent/intent-manifest.json` digests in the same PR.
- **Stop conditions** — [P-D](CONSTITUTION.md#process-articles); a stop is
  reported as REWORK with the failing dimension, never silently absorbed.
- **Budget honesty** — a phase that investigates and finds nothing worth
  doing closes with that finding recorded; an empty phase is a legitimate
  outcome ([CON-0](CONSTITUTION.md#con-0--do-not-trade-semantic-maturity-for-structural-purity)).
