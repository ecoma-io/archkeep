# Invariant registry (INV-*)

The properties the refactor must not regress. Each row states the invariant,
its **witness today** (what already fails when it breaks), and — honestly —
the **gap** where the witness is partial or absent; a phase that owns a gap
closes it or the row says so forever.

Relationship to existing registries: the machine registry of engine contracts
is `packages/archkeep/src/intent/intent-manifest.json` (contracts A–M). Where
an INV restates a contract, the contract is the statement and this row adds
the refactor's witness-and-gap view. This page does not replace that manifest,
the root `AGENTS.md` invariant, or any ADR.

## INV-1 — An empty result is a claim, not a shrug

The root invariant. An empty diagnostic list means "no violation", never
"could not check".

- Witness: `refusal-contract.integration.test.mjs` (uniform no-verdict/exit-3 +
  an ok control so "everything refuses" cannot pass);
  `coverage-loudness.integration.test.mjs`; LSP's exactly-two empty-publish
  sites with synthetic failure diagnostics (`server.mjs:592-600`); the WASM
  host validates rule verdict documents against the 4-state vocabulary.
- Gap: none structural; each new surface must restate its two-site discipline.

## INV-2 — One exit/status table

- Witness: single `EXIT` table; `verdict-layering.test.mjs:131-186` scans for
  a second numeric _table_; the latch that actually holds the carrier sites is
  `jsonEnvelope`'s status↔exitCode refusal (`src/report/json.mjs:88-96` —
  every carrier eagerly builds its envelope); `exit-matrix.integration.test.mjs`
  pins per-verb sides.
- Gap: exit 1/3 also appear as branch/ternary literals at
  `delta.mjs:757-779`, `change.mjs:762-778`, `fitness.mjs:211-216` — shapes
  the object-literal scan cannot see; the envelope latch and exit-matrix pin
  them behaviorally. "One table" is true of the spelling, not of every
  literal.

## INV-3 — One envelope shape

- Witness: `jsonEnvelope`, `schemaVersion: 2`;
  `envelope-shape.integration.test.mjs` vs the committed snapshot; internal
  self-contradiction refusals in `json.test.mjs`.
- Gap: snapshot regeneration requires the paired doc edit by convention, not
  by gate.

## INV-4 — One verdict vocabulary, EXIT table, and Decision constructor

Enforcement semantics are singular — one `EXIT` table, one status vocabulary,
one `buildDecision` — and the verdict-bearing verbs fold status→exit over
that shared vocabulary at **five fold sites**: `verdictFor` for `check`
(`src/verdict.mjs:121-238`, callers `cli.mjs:802` + `check.mjs:1066`);
`cli.mjs:1060-1061` (delta, over `delta.mjs:751-781`), `:1377-1378` (change,
over `change.mjs:751-780`), `:1539-1542` (fitness, over
`fitness.mjs:211-216`) — the three siblings evaluate the same architecture
law (intent J) — and `:2017-2019` (rules verify, over `rules.mjs:445-448`),
whose fold is the **artifact-integrity** contract's — the same vocabulary and
table, a different law, outside the lane ([PD-8](DECISIONS.md#program-decisions)).
The enforcement carriers agree because they evaluate the same law, not
because they share one function.

- Witness: fails-closed folds (`?? EXIT.error`); the envelope latch
  (`json.mjs:88-96`); exit-matrix both directions; cross-command-gates
  composition pins.
- Gap: `verdictFor`'s counts input is an untyped 14-field tuple — a
  misspelled key silently zeroes a count — and the sibling folds hand-roll
  status/exitCode literals in branch shapes no scan sees. Phase 1
  hardens the **class** across all five sites, not just `check`'s.

## INV-5 — Snapshot identity per family (ADR 0008)

- Witness: `snapshotIdentity` (`history.mjs:124-143`) with byte-parity,
  root-sensitivity, and unknown-field pins; evidence family's bytes-identity
  round-trip; cross-command identity equality
  (`cross-command-state.integration.test.mjs:517-536`).
- Gap: none.

## INV-6 — Event identity and append-only store

- Witness: `eventDedupeKey`/`eventId` pins (base/head/declaration sensitivity;
  clock/narration excluded); store idempotency/atomicity/containment pins;
  dirty/commitless-head refusal shared by all three producers.
- Gap: disposition words constructed in delta/change/evolution are validated
  only at store write (register R4).

## INV-7 — Determinism

- Witness: Contract-K source guard (no `Date.now`/`Math.random`/`localeCompare`
  in shipped `src/`, one exempt clock site); all-command sortedness;
  `check` 4-run byte-identity; e2e determinism legs.
- Gap: byte-identity covers `check` only (GAP-B); no cross-version output
  baseline (GAP-D).

## INV-8 — Proposals never decide

- Witness: write-door census (AUTHORITY-MAP); `scenario` virtual contract;
  `rules add` never writes config; reconcile's byte-identity is claimed by
  `docs/concepts/reconciliation.md` and named to an integration test the
  audit did not open (OQ-5 verifies it in Phase 2).
- Gap: proposal marker _values_ in output documented but not source-verified
  (audit note); the write-path enforcement is the real gate.

## INV-9 — Providers observe, never decide

- Witness: intent A claims it; the ESLint differential + provider parity
  (intent L) hold the _behavior_.
- Gap: **no scan enforces the import direction** (G-1), and the Moon provider
  carries documented normalization policy (AUTHORITY-MAP divergence 1). Phase 1
  (policy adjudication) and Phase 3 (scan).

## INV-10 — Analysis never judges

- Witness: intent C tests (schema conformance, judging-vocabulary walk);
  metamorphic analyzer relations.
- Gap: layer-level import direction unscanned (shared with G-1's family).

## INV-11 — Report renders, decides nothing

- Witness: `verdict-layering` forbids verdict-core → `report/` imports;
  text renderers' suites pin output only.
- Gap: the reverse direction (`report/` importing rules/config law) is
  unscanned (G-5). Phase 3.

## INV-12 — Differential safety

- Witness: ESLint differential with exact ledger and vacuity guards;
  native-vs-Nx same-tree differential; provider parity twins in CI;
  4-dialect config equivalence with red twins.
- Gap: **no golden-output corpus per command** (GAP-A) — the load-bearing gap
  for any structural move; value changes can hide behind shape pins. Phase 4
  entry gate.

## INV-13 — Acyclic, reachable module graph

- Witness: `module-graph.test.mjs` acyclicity from entries.
- Gap: reachability of every `src/**.mjs` from an entry is not asserted
  (G-7) — an orphan module escapes every entry-rooted scan. Phase 3.

## INV-14 — Layer directions

- Witness: `lsp → commands` scanned (#649).
- Gap: `commands → lsp` (G-2), core → providers (G-1), report-decides-nothing
  (G-5) unscanned. Phase 3.

## INV-15 — Derived rosters, never copies

- Witness: `COMMAND_NAMES`-derived rosters (`exit-matrix`, `envelope-shape`,
  `check-cli-docs-roster`); `check-packages` parses `ci.yml`; skills version
  chain.
- Gap: none — this one is the repository's best-defended habit.

## INV-16 — Clock discipline

- Witness: injected `referenceTime()`; Contract-K guard naming "exactly one"
  exempt production site (the clock itself); waiver expiry threads one shared
  `now` through delta/change.
- Gap: the exempt-site roster beyond the clock was not independently
  enumerated by the audit (OQ-6 verifies against the guard's own test in
  Phase 3).

## INV-17 — Report conservation

Violations in = findings out, on every face (JSON/SARIF/text).

- Witness: `src/report/conservation.integration.test.mjs` holds all three
  faces to one count.
- Gap: none.

## INV-18 — Evidence-Complete manifest digests

Every evidence entry in `src/intent/intent-manifest.json` is content-addressed;
the gate recomputes each sha256.

- Witness: `src/intent/intent.test.mjs` recomputes every digest.
- Gap: none — but this is a **workflow tripwire** for the refactor: any PR that
  moves an evidence-named file must update the manifest digests in the same PR,
  or CI fails loudly (correctly). Budgeted in
  [MIGRATION-PLAN.md](MIGRATION-PLAN.md#cross-cutting-rules), never bypassed.

## INV-19 — Custom rules, one contract

One rule seam (wasm, core-only, digest-pinned, declared-never-discovered);
four SDKs, one conformance suite; the evidence bundle is public API.

- Witness: `src/conformance/rule-sdks.integration.test.mjs` (the ADR
  [0002](../../adr/0002-custom-rules-one-contract.md) gate) +
  `src/custom-rules/evidence-golden.integration.test.mjs` (bundle bytes).
- Gap: none.

## INV-20 — Static reading only

The engine never spawns go/cargo/uv/mvn/gradle/dotnet to compute the graph
(ADRs [0005](../../adr/0005-jvm-language-integration.md),
[0006](../../adr/0006-dotnet-language-integration.md); permanent).

- Witness: **review-enforced** — no automated owner; absence of spawn sites is
  the mechanism. Adversarial reviews name it explicitly.
- Gap: stays a review row by decision (a scan over spawn call-sites is
  possible; Phase 3 may add it if a refactor touches the spawn layer).

## INV-21 — Edges only, never nodes or targets

- Witness: **review-enforced** — stated in the north-star refusals; no scan.
- Gap: as INV-20.

## INV-22 — Semantic non-expansion

No ownership/data-flow/API/event/runtime boundary semantics; no
`SemanticRelation`/`Metadata`/`Fact` primitives (ADR
[0007](../../adr/0007-no-semantic-model-expansion.md)).

- Witness: review-enforced (contract-shape review); the conformance suite
  exercises only what exists.
- Gap: none mechanizable — this is the
  [CON-3](CONSTITUTION.md#con-3--generalize-computation-not-domain-vocabulary)
  gate applied at review.

## INV-23 — The compatibility contract, including semantic compatibility

A change whose shape did not move but whose meaning did is breaking; on the
0.x line such changes land as named minors.

- Witness: envelope roster gate + changelog discipline +
  `scripts/verify-package.mjs` (the packed artifact, outside the workspace).
- Gap: none — but every refactor PR classifies itself against the contract
  before implementation (root `AGENTS.md`, "The compatibility contract").

## INV-24 — Scope-expansion guard

No AI architect, runtime simulator, autonomous migration planner, cost
estimator, or second authority.

- Witness: review-enforced by construction — the capabilities are not
  implemented, and the doctrine pages
  ([`docs/doctrine/architecture-authority.md`](../../doctrine/architecture-authority.md)
  non-goals) forbid building them.
- Gap: none.

## INV-25 — Semantic authority count is one

The **architecture semantic enforcement** authority count is one
([CON-1](CONSTITUTION.md#con-1--one-enforcement-authority)), and the count
never increases across this program. A module becomes an authority only by
gaining the right to make a semantic judgment — holding, passing, rendering,
or storing a Verdict does not confer it (the five-role vocabulary is
[AUTHORITY-MAP.md](AUTHORITY-MAP.md#vocabulary-authority-carrier-projection-adapter-surface)'s).
`rules verify` is a bounded **artifact-integrity verification** authority
([PD-8](DECISIONS.md#program-decisions)) — it makes no architecture judgment,
so it neither raises nor dilutes the count; a second architecture authority
would. Creating a new bounded verification domain is a maintainer-classified
semantic change, never a refactor side effect. The mirror holds with equal
force: the fold sites — four enforcement folds and the integrity fold — are
legitimate and must not be mechanically unified
([PD-6](DECISIONS.md#program-decisions)) — this invariant caps the count in
**both** directions.

- Witness: this map's carrier roster; the `verdict-layering` scan (second
  numeric table); the envelope latch; [P-B](CONSTITUTION.md#process-articles)
  adversarial review per architectural PR, which must name the authority
  count explicitly; maturity gate row 1 demands the map-and-review evidence.
- Gap: authority count is review-asserted, not mechanically scanned — a scan
  would need a mechanical definition of "judgment" that does not exist. The
  honest witness is the review discipline plus this map staying true.

## Rows verified but not restated

The Phase 0 doctrine audit inventoried 33 invariant rows with owners and
mechanisms (audit report; absorbed here). Rows not carried above keep their
owners and run in CI on their own scripts, cited by name by any phase that
touches their territory: skills honesty and the version chain
(`scripts/check-skills.mjs`), the docs gate chain (`check-docs-links`,
`check-docs-claims-parity`, `check-cli-docs-roster`, `check-packages`,
`check-installation-prereqs`, `check-contributing-parity`), gate-script
hygiene (`scripts/*.test.mjs` + semgrep `scripts.yaml`), unknown-never-valid
(the I1–I5 machinery), and provider relocation invariance
(`src/providers/native/model.mjs:317-324` validation messages).

## Rules of use

A PR that touches a row's territory cites the INV id in its description and
re-runs the witness by name. An INV with an open gap may not be cited as
"protected" — the gap column is the honest answer until a phase closes it.
New invariants get an id here in the PR that establishes them.

Numbering note: `INV-*` lives here; contracts A–M live in
`src/intent/intent-manifest.json`; architectural test gaps are `G-n`
([VALIDATION-MATRIX.md](VALIDATION-MATRIX.md#architectural-test-gaps));
doctrine gaps are `DG-n` ([OPEN-QUESTIONS.md](OPEN-QUESTIONS.md)). One
namespace per kind, no overlap.
