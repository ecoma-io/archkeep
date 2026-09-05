# Decision register

Every question the Phase 0 audits raised holds exactly one of three states —
**CLOSED — DECIDED** ([DECISIONS.md](DECISIONS.md#program-decisions)),
**VERIFICATION REQUIRED** (a named work item owes named evidence), or
**MAINTAINER GATED** (only the maintainer decides). "Open" is not a state
([P-G](CONSTITUTION.md#process-articles)): no question floats without an
owner, and "open question" never licenses a worker to choose. Each
verification row names its owner, the exact evidence required, the phase that
owes it, what evidence closes it, and the no-issue outcome — what is recorded
when the answer comes back "no issue, no change needed".

## CLOSED — DECIDED

Each closure's full record — question, evidence, decision, rejected
alternatives, consequences, compatibility impact, owner, acceptance evidence —
lives in [DECISIONS.md](DECISIONS.md#program-decisions); this section states
each closure in one line and links it.

- **OQ-13 — `rules verify`'s place in the authority map.** CLOSED by
  [PD-8](DECISIONS.md#program-decisions): a bounded **artifact-integrity
  verification authority** — outside the architecture enforcement lane; it
  shares the status vocabulary, `EXIT` table, and envelope latch (the
  contract), never `verdictFor`/`buildDecision`; not a "second architecture
  authority" ([CON-1](CONSTITUTION.md#con-1--one-enforcement-authority),
  [INV-25](INVARIANTS.md#inv-25--semantic-authority-count-is-one) cap
  architecture semantic enforcement, and both state the scope). Evidence:
  the fold at `rules.mjs:445-448` + `cli.mjs:2040-2042`, the envelope latch,
  the catalog-only context (no workspace graph). Carried into
  AUTHORITY-MAP/INV-4/INV-25/CON-1/SEMANTIC-MODEL/DATA-FLOW by the same PR
  that closed it (Phase 0.5); Phase 1-B verifies and pins the contract from
  source as its own unit.
- **OQ-1 — capability vocabulary owner.** CLOSED by
  [PD-9](DECISIONS.md#program-decisions): product capability vocabulary,
  normatively owned by
  [`docs/concepts/architecture.md`](../../concepts/architecture.md#the-24-commands);
  the control plane holds no second owner and creates no new vocabulary page;
  [CON-9](CONSTITUTION.md#con-9--surface--package) keeps the surface ≠ package
  constraint and cites the concept owner. Closes DG-5.
- **OQ-2 — event-identity law's home.** CLOSED by
  [PD-10](DECISIONS.md#program-decisions): ADR-0008 stays the normative
  source for the identity-family semantics it accepted; the event composition
  (`{base, head, declarationDigest}`) stays implementation annotation in
  `src/governance/evolution-event.mjs`, witnessed by its tests
  ([INV-6](INVARIANTS.md#inv-6--event-identity-and-append-only-store));
  [SEMANTIC-MODEL.md](SEMANTIC-MODEL.md) stays the living ownership map. No
  ADR-0009. Closes DG-3.
- **OQ-3 — verb regrouping classification.** CLOSED by
  [PD-11](DECISIONS.md#program-decisions): regrouping CLI verbs across the
  capability words is a **product-surface semantic change** — spelling
  stability does not make it behavior-free — so Phase 5's regrouping carries
  its own maintainer decision record before implementation, and is never
  bundled with mechanical extraction.
- **OQ-12 — what the branch ruleset actually requires.** CLOSED by rider D6
  (PR #733): re-measured against the GitHub ruleset API on 2026-09-05 —
  `ci-gate` and `analysis-gate`, both walls — with the measurement date
  written into `docs/development/repository.md:124-126`. The stale part was
  the undated claim; the rider closes by the dated measurement itself.

- **OQ-5 — where `reconcile`'s byte-identity is pinned.** CLOSED by
  [PD-13](DECISIONS.md#program-decisions): the property is pinned by
  `reconcile.integration.test.mjs` — both `--propose` shapes (`:139`,
  `:153`) — and the pin is named in
  [VALIDATION-MATRIX.md](VALIDATION-MATRIX.md)'s contract→pin map;
  [`docs/concepts/reconciliation.md`](../../concepts/reconciliation.md)'s
  claim now cites the test instead of an unscoped "every run".
- **OQ-7 — fitness vs decisions emission equality.** CLOSED as an
  **inequality** by [PD-13](DECISIONS.md#program-decisions): executed
  probes show `fitness` emits a drift-free `pass` while `decisions` emits
  `fail` on the same clean workspace (`decisions.mjs:126-136` feeds the
  raw model; `fitness.mjs:221-240` feeds verdict-shape intent). The defect
  is [#737](https://github.com/ecoma-io/archkeep/issues/737); its fix is
  work item WI-1 (Phase 2 correctness hardening, a 0.x minor with a
  silent-direction regression test). Outcome (b):
  `fitnessSnapshot` stays the single shared constructor, each caller's
  intent shape its own documented contract.
- **OQ-10 — trajectory's standing in the semantic model.** CLOSED by
  [PD-13](DECISIONS.md#program-decisions): trajectory is a first-class
  consumer of the Graph snapshot family, and its consumption edges are now
  stated in [SEMANTIC-MODEL.md](SEMANTIC-MODEL.md) — it imports
  `readSnapshots`/`classifyTransition`/`edgeIdentityKey` plus the envelope
  internals, and imports none of
  `snapshotIdentity`/`classifyEvolution`/`fitnessSnapshot` (the
  declaration-snapshot family is not its lane).
- **OQ-15 — `workspaceLayoutSource`'s two-value vocabulary.** CLOSED by
  [PD-14](DECISIONS.md#program-decisions): two values kept; the corrected
  meaning — the graph carries the layout **key** (config-named or
  Moon-derived), and the `"declared"` slot records the key's presence, not
  who named it — is the documented contract, stated once in
  [BOUNDARIES.md](BOUNDARIES.md)'s provider seam section. The widening
  remains its own compatibility-classified change.

## VERIFICATION REQUIRED

A row here is a work item, not uncertainty to be resolved by taste. Each
names: owner (the phase that owes it), decision class, exact evidence
required, the phase it blocks, what evidence closes it, and the no-issue
outcome.

| ID   | Question                                                                 | Owner                      | Evidence required                                                                                                                                             | Blocks                                 | What closes it                                                                                                                                                                   | No-issue outcome                                           |
| ---- | ------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| OQ-4 | Do INV-20/INV-21 (static-reading-only, edges-never-nodes) gain scans?    | Phase 3                    | The investigation's record: per candidate scan — mechanical-witness cost, false-positive rate, false-negative rate, maintenance burden, architectural gain    | Phase 3's G-scan work                  | A scan adopted with a red-twin demonstration, **or** the recorded decision that none earns it — "no scan" is a legitimate outcome; a scan is not added because it can be written | The recorded "no scan" decision, with its reasons          |
| OQ-6 | What is the Contract-K exempt-site roster beyond the clock?              | Phase 3                    | The determinism source guard's own test enumerates the roster; record it beside [INV-16](INVARIANTS.md#inv-16--clock-discipline)                              | Phase 3                                | The enumerated roster recorded with its witness                                                                                                                                  | "Clock only" recorded with the guard's test as the witness |
| OQ-9 | What do `nightly.yml` and `check-docs-claims-parity.mjs` actually carry? | GAP-A work (Phase 4 entry) | Both files read; the [gap list](VALIDATION-MATRIX.md#differential-gaps-what-the-harness-cannot-prove-today) updated if nightly carries determinism/sweep legs | GAP-A's implementation (Phase 4 entry) | A recorded reading of both files, gap list updated or confirmed                                                                                                                  | Gap list confirmed unchanged — GAP-A's gates unaffected    |

## MAINTAINER GATED

A row here names the gate at which the maintainer decides; nothing is
decided here, and nothing is decided before its gate.

| ID    | Question                                    | Gate                                 | What the maintainer decides                                                                                               | What closes it                                                                                                                             |
| ----- | ------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| OQ-8  | Golden corpus home — in-repo vs CI artifact | GAP-A implementation (Phase 4 entry) | The home for the golden-output corpus; the audit recommends in-repo (the `envelope-shape.json` habit, human-gated regen)  | The maintainer's choice recorded at GAP-A's implementation PR                                                                              |
| OQ-11 | LSP golden-response scope (GAP-E)           | Phase 7 entry                        | The minimal recorded-response set for a server-refactor differential                                                      | The approved scope recorded at Phase 7's entry                                                                                             |
| OQ-14 | INV-23's semantic-compatibility witness     | Phase 9's GAP-D decision             | Whether a cross-version semantic-baseline differential is owed, or the corpus + differentials + review discipline suffice | Adoption, or the reasoned no-fix per budget honesty ([CON-0](CONSTITUTION.md#con-0--do-not-trade-semantic-maturity-for-structural-purity)) |

## Doctrine-gap register (DG-\*)

From the doctrine audit; each names a sentence that binds but lives nowhere
tracked, or a claim with no gate. Owners are phases or the maintainer.

- **DG-1** single-owner-per-semantic-concept lived only in the (then
  untracked) constitution — closed: [SEMANTIC-MODEL.md](SEMANTIC-MODEL.md)
  is the owner.
- **DG-2** no stated/tested intra-`src/` dependency DAG — Phase 3.
- **DG-3** snapshot/event family semantics beyond ADR-0008 live in code
  headers — [closed by PD-10](#closed--decided).
- **DG-4** "descriptive commands project canonical evaluation; they never
  re-evaluate" is pinned by contracts I/J but stated nowhere as a general law
  — Phase 5's facade work states it once in
  [AUTHORITY-MAP.md](AUTHORITY-MAP.md) or doctrine, not both.
- **DG-5** capability-grouping vocabulary owner —
  [closed by PD-9](#closed--decided).
- **DG-6** the determinism sweep's file roster lives in test code; file moves
  must keep it pointed — Phase 4 budget line (INV-18's sibling concern).
- **DG-7** this registry itself must stay an index of IDs, never a
  restatement, or it becomes the next drifted copy — standing rule, checked
  by the docs gates and review.
- **DG-8** authority doctrine's six-role table did not restate the
  verdict-carrier roster — closed: [AUTHORITY-MAP.md](AUTHORITY-MAP.md)
  carries it (now split into the four enforcement carriers and the
  artifact-integrity verification surface, per
  [PD-8](DECISIONS.md#program-decisions)).
- **DG-9** edges-only and static-reading have no automated owner — OQ-4.
- **DG-10** coverage semantics has three homes; the binding copy per consumer
  is named by `docs/README.md`'s ownership map — consumers cite the map, and
  this control plane does not add a fourth home.
