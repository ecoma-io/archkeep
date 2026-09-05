# Open questions

Questions the Phase 0 audits raised and did not close, with the phase that
owns each decision. A question here is not a blocker; it is a decision that
has not yet been made, and the phase that owns it must answer it — by
investigation, ADR, or maintainer ruling — before relying on either answer.

## Program-level

- **OQ-1 — Capability-grouping vocabulary owner.** The words
  analyze/check/inspect/compare/explain/govern/rules name surfaces with no
  tracked doctrine owner (doctrine gap DG-5). Options: a new doctrine page,
  `docs/concepts/architecture.md`, or this control plane once landed. Owner:
  Phase 5 entry. (Until then [CON-9](CONSTITUTION.md#con-9--surface--package)
  is the working statement.)
- **OQ-2 — Event-identity law's home.** The law (identity =
  sha256 of `{base, head, declarationDigest}`; storage paths never enter)
  lives in code headers and ADR 0008's orbit, not in a numbered record of its
  own (DG-3). ADR 0009 vs a SEMANTIC-MODEL section: ADRs are
  immutable-once-accepted, the model page is the living map. Owner: Phase 2,
  maintainer ruling if an ADR is drafted.
- **OQ-3 — Verb regrouping classification.** Does regrouping CLI verbs into
  capability surfaces require maintainer authorization as a semantic change,
  or is it an in-scope 0.x minor? The compatibility contract reads as the
  former; the plan's Phase 5 assumes spelling-stability anyway. Owner:
  maintainer, before Phase 5 starts.
- **OQ-4 — Review-enforced rows with no scan.** Static-reading-only (INV-20),
  edges-never-nodes (INV-21): gain automated owners or stay review rows with
  named adversarial checks? Owner: Phase 3's investigation.

## Surfaced by the audits, unresolved

- **OQ-5 — Reconciliation byte-identity pin.** The claim that `reconcile`
  leaves the intent file byte-identical is asserted by an integration test
  named in `docs/concepts/reconciliation.md:30-34`; the specific suite was
  not opened by the governance audit. Verify and name it in
  [VALIDATION-MATRIX.md](VALIDATION-MATRIX.md) during Phase 2.
- **OQ-6 — Contract-K exempt-site roster.** The determinism source guard
  names "exactly one" exempt production site (the clock); the roster beyond
  it was not independently enumerated. Verify during Phase 3 (the guard's own
  test is the authority).
- **OQ-7 — `decisions` vs `fitness` snapshot equality.** Both compose the
  same fitness registry; body-level equality between the two snapshots was
  not diffed. Owner: Phase 2's finding-concept work touches this area;
  verify then.
- **OQ-8 — Golden corpus home.** In-repo (matching the
  `envelope-shape.json` pattern and the human-gated-regen habit) vs CI
  artifact comparison. The audit recommends in-repo; the decision lands with
  GAP-A's implementation (Phase 4 entry).
- **OQ-9 — `nightly.yml` and `check-docs-claims-parity.mjs` content.**
  Discovered but unaudited; if nightly carries determinism/sweep legs it
  changes the gap list. Owner: GAP-A implementation reads them first.
- **OQ-10 — `trajectory` as first-class consumer.** It consumes
  `classifyTransition`/`edgeIdentityKey` but sat outside the governance
  audit's named scope. Decide its row in the SEMANTIC-MODEL consumer column
  during Phase 2.
- **OQ-11 — LSP golden responses scope.** What a minimal recorded-response
  set covers (initialize, diagnostics on edit/close, the failure synthetic)
  for a server refactor differential (GAP-E). Owner: Phase 7 entry.
- **OQ-12 — Doc-divergence D6 fix discipline.** `docs/development/repository.md`'s
  stale required-checks sentence is fixed by re-measuring the ruleset API at
  fix time. Owner: Phase 1 rider D6.
- **OQ-13 — `rules verify`'s place in the authority map.** Its catalog-integrity
  findings drive exit 1 through their own fold (`rules.mjs:444-448`) — verdict
  semantics by the carrier roster, but over artifact integrity rather than
  workspace law. Name it in
  [AUTHORITY-MAP.md](AUTHORITY-MAP.md) as a deliberate second judgment surface
  (integrity, not architecture), or fold its vocabulary into the lane's.
  Raised by adversarial review. Owner: Phase 1 (same PR as the fold
  hardening).
- **OQ-14 — INV-23's semantic-compatibility witness.** `verify-package.mjs`
  witnesses the packed-artifact/install surface; _semantic_ compatibility
  (same workspace, different meaning) is witnessed only by the per-PR review
  discipline [P-B](CONSTITUTION.md#process-articles) makes PR-local, not
  continuous. Decide whether that is enough or whether a semantic-baseline
  differential (related to GAP-D) is owed. Owner: Phase 9's GAP-D decision.

## Doctrine-gap register (DG-*)

From the doctrine audit; each names a sentence that binds but lives nowhere
tracked, or a claim with no gate. Owners are phases or the maintainer.

- **DG-1** single-owner-per-semantic-concept lived only in the (then
  untracked) constitution — closing with this control plane's landing
  ([SEMANTIC-MODEL.md](SEMANTIC-MODEL.md) is the owner).
- **DG-2** no stated/tested intra-`src/` dependency DAG — Phase 3.
- **DG-3** snapshot/event family semantics beyond ADR 0008 live in code
  headers — OQ-2.
- **DG-4** "descriptive commands project canonical evaluation; they never
  re-evaluate" is pinned by contracts I/J but stated nowhere as a general law
  — Phase 5's facade work states it once in
  [AUTHORITY-MAP.md](AUTHORITY-MAP.md) or doctrine, not both.
- **DG-5** capability-grouping vocabulary owner — OQ-1.
- **DG-6** the determinism sweep's file roster lives in test code; file moves
  must keep it pointed — Phase 4 budget line (INV-18's sibling concern).
- **DG-7** this registry itself must stay an index of IDs, never a
  restatement, or it becomes the next drifted copy — standing rule, checked
  by the docs gates and review.
- **DG-8** authority doctrine's six-role table did not restate the
  verdict-carrier roster — closed: [AUTHORITY-MAP.md](AUTHORITY-MAP.md)
  carries it.
- **DG-9** edges-only and static-reading have no automated owner — OQ-4.
- **DG-10** coverage semantics has three homes; the binding copy per consumer
  is named by `docs/README.md`'s ownership map — consumers cite the map, and
  this control plane does not add a fourth home.
