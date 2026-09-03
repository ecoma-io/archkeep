# Gap Register — Architecture Intelligence Evidence-Complete

Generated: 2026-09-03

## Methodology

Inspected every file in:

- `packages/archkeep/src/commands/evaluation-primitives.mjs`
- `packages/archkeep/src/commands/completeness.mjs`
- `packages/archkeep/src/commands/scenario-evaluation.mjs`
- `packages/archkeep/src/commands/impact-statement.mjs`
- `packages/archkeep/src/commands/scenario.mjs`
- `packages/archkeep/src/commands/impact.mjs`
- `packages/archkeep/src/governance/provenance-graph.mjs`
- `packages/archkeep/src/governance/provenance-record.mjs`
- `packages/archkeep/src/report/evidence.mjs`
- `packages/archkeep-mcp/src/engine.mjs`
- `packages/archkeep-mcp/src/server.mjs`
- `packages/archkeep/src/adversarial-verification.integration.test.mjs`
- `packages/archkeep/src/commands/completeness-adversarial.integration.test.mjs`
- `packages/archkeep/src/commands/completeness.test.mjs`
- `packages/archkeep/src/commands/scenario-evaluation.test.mjs`
- `packages/archkeep/src/commands/impact-statement.test.mjs`
- `packages/archkeep/src/analysis/metamorphic.test.mjs`
- `packages/archkeep/src/canonical.mjs`

---

## GAP-1: Missing Evidence-Complete contract

- **File:** nowhere
- **Classification:** MISSING
- **Description:** No `EvidenceComplete` type, schema, or gate exists. `overallComplete` in `buildCompleteness` is a simple boolean (all statuses === EVALUATED). There is no `domainCoverage`, `claimEvidenceCoverage`, `causalCoverage`, `provenanceCoverage`, `mutationCoverage`, `surfaceParity`, `hiddenGapCount`, `falseCompleteCount`, `baseIdentityValid`, or `deterministic` field anywhere.
- **Impact:** The system has no way to prove it is Evidence-Complete.

## GAP-2: Domain coverage is implicit, not explicit

- **File:** `completeness.mjs:144-158`
- **Classification:** MISSING
- **Description:** `buildCompleteness` accepts five optional domain statuses with defaults of NOT_EVALUATED. There is no required/declared domain set, no evaluation contract, and no `domainCoverage` metric. `requiredDomains` is not defined anywhere.
- **Impact:** Cannot measure `evaluatedRequiredDomains / requiredDomains`.

## GAP-3: No explicit evidence domain in completeness

- **File:** `completeness.mjs:144-158`
- **Classification:** MISSING
- **Description:** The five domains are structural, constraint, boundary, decision, governance. There is no `evidence` domain. The doctrine requires evidence as a domain.
- **Impact:** Evidence completeness is not tracked.

## GAP-4: No claim evidence coverage

- **File:** nowhere
- **Classification:** MISSING
- **Description:** `claimEvidenceCoverage` does not exist. No concept of "material claim" with traceable evidence. The provenance graph has claims, but nothing verifies every claim has evidence.
- **Impact:** Cannot prove claims are evidenced.

## GAP-5: No causal coverage

- **File:** nowhere
- **Classification:** MISSING
- **Description:** `causalCoverage` does not exist. While `provenance-graph.mjs` defines `CausalChain` and `CausalChainLink`, these are not used by the completeness/evidence model. No invariant requires `consequencesWithCompleteCausalChain / materialConsequences`.
- **Impact:** Consequences may lack causal chains.

## GAP-6: No provenance coverage

- **File:** nowhere
- **Classification:** MISSING
- **Description:** `provenanceCoverage` does not exist. No verification that authoritative inputs have verified provenance.
- **Impact:** Cannot prove provenance is complete.

## GAP-7: Base identity verification is insufficient

- **File:** `scenario-evaluation.mjs:261-314` (`resolveBaseRevision`)
- **Classification:** PARTIAL (broken)
- **Description:** `resolveBaseRevision` always sets `attributed: true` even when:
  - User provides a base revision that does not match HEAD
  - HEAD is dirty
  - git is unavailable
  - No provenance could be resolved
  - The `attributed` field is boolean with no concept of `verified`, `unverified`, or `mismatch`
  - `baseIdentityValid` does not exist
- **Impact:** A scenario can claim base attribution when the actual relationship is unknown.

## GAP-8: No hidden gap detection

- **File:** nowhere
- **Classification:** MISSING
- **Description:** `hiddenGapCount` does not exist. No mechanism detects when a required domain/input/claim/consequence/mutation was not actually evaluated or evidenced, but the output does not report that limitation.
- **Impact:** Silent gaps are invisible.

## GAP-9: No false-complete detection

- **File:** nowhere
- **Classification:** MISSING
- **Description:** `falseCompleteCount` does not exist. No invariant prevents `overallComplete = true` when required evidence gates fail.
- **Impact:** System can claim completeness while gates fail.

## GAP-10: Scenario claims standard domains always EVALUATED

- **File:** `completeness.mjs:259-263`
- **Classification:** HARDENING_ONLY
- **Description:** `buildScenarioCompleteness` unconditionally creates EVALUATED domains for structural, constraint, boundary, decision: `const structuralDomain = createDomain(EVALUATION_STATUS.EVALUATED)`. This is a hard-coded assumption that may not be valid for all scenarios.
- **Impact:** Scenario completeness may over-claim.

## GAP-11: Governance is filtered, not re-evaluated

- **File:** `scenario-evaluation.mjs:436-469`
- **Classification:** PARTIAL
- **Description:** `evaluateScenario` takes precomputed `availableFindings` and `availableDebt`, then filters them for the hypothetical graph. It does NOT re-evaluate governance from the hypothetical ArchitectureState. The comment on line 448 says "Re-filter findings" — confirming it's filtering, not evaluating. The `governanceComplete` flag is set to `availableFindings !== null && availableDebt !== null` — which is true even when filtering is incomplete.
- **Impact:** Scenario claims governance completeness without actual re-evaluation.

## GAP-12: evidenceDelta is metadata, not causal evidence

- **File:** `scenario-evaluation.mjs:253-257`
- **Classification:** PARTIAL
- **Description:** `evidenceDelta` contains only `baseRevision`, `changesApplied`, `changesRefused`. These are counts and strings, not actual causal evidence chains. Cannot answer: What mutation → what state change → which evaluation domain → which claim → why?
- **Impact:** Evidence delta is not actionable.

## GAP-13: dependency_removed uses findIndex with target-only matching

- **File:** `scenario-evaluation.mjs:184-197`
- **Classification:** MISSING
- **Description:** `applyChanges` for `dependency_removed` uses `existing.findIndex((e) => e.target === change.target)` — matches only by target, not by type. For edges with same source+target but different types (e.g., static vs dynamic), this removes the FIRST match arbitrarily.
- **Impact:** Ambiguous edge removal can silently remove wrong edge.

## GAP-14: dependency_added hard-codes type: "static"

- **File:** `scenario-evaluation.mjs:170-180`
- **Classification:** MISSING
- **Description:** New dependency edges always get `type: "static"`. This silently invents architecture semantics.
- **Impact:** Scenario mutations invent type information.

## GAP-15: No mutation coverage

- **File:** nowhere
- **Classification:** MISSING
- **Description:** `mutationCoverage` does not exist. No tracking of `mutationsWithExplicitOutcomeAndEvidence / requestedMutations`. While `applied`/`refused` arrays exist, they are not tracked as a coverage metric.
- **Impact:** Cannot prove every mutation has an outcome.

## GAP-16: No surface parity verification

- **File:** nowhere
- **Classification:** MISSING
- **Description:** `surfaceParity` does not exist. No verification that CLI, library, and MCP produce semantically equivalent evaluation results. The `adversarial-verification.integration.test.mjs` has a surface parity section but only checks CLI surface, not cross-surface semantic parity.
- **Impact:** CLI/library/MCP may diverge.

## GAP-17: No determinism invariant

- **File:** nowhere
- **Classification:** MISSING
- **Description:** `deterministic` does not exist. No invariant enforces that repeated evaluations produce semantically equivalent results. Round-trip tests exist in adversarial test but only for CLI output.
- **Impact:** Cannot prove evaluation is deterministic.

## GAP-18: composeImpactStatement duplicates evaluateArchitectureState

- **File:** `impact-statement.mjs:105-234`, `evaluation-primitives.mjs:305-431`
- **Classification:** PARTIAL
- **Description:** `composeImpactStatement` and `evaluateArchitectureState` share the same 7-step structure but are independent implementations. `composeImpactStatement` does NOT call `evaluateArchitectureState`. This violates the "one semantic evaluator, many views" principle.
- **Impact:** Two implementations of architecture evaluation can diverge.

## GAP-19: Scenario does not use evaluateArchitectureState

- **File:** `scenario-evaluation.mjs:330-568`
- **Classification:** PARTIAL
- **Description:** `evaluateScenario` independently computes current impact, scenario impact, decision impact, evolution alignment — duplicating `evaluateArchitectureState`. It does NOT call `evaluateArchitectureState` for either the current or hypothetical state.
- **Impact:** Three independent implementations of architecture evaluation.

## GAP-20: MCP impact tool calls CLI command, not canonical evaluation

- **File:** `archkeep-mcp/src/engine.mjs:243-248`
- **Classification:** PARTIAL
- **Description:** `impactTool` calls `impactCommand()` which internally calls `composeImpactStatement()`. It does NOT call `evaluateArchitectureState()`. This is another path bypassing the canonical evaluator.
- **Impact:** MCP may produce semantically different results.

## GAP-21: Boolean information loss in governance delta

- **File:** `scenario-evaluation.mjs:249-252`
- **Classification:** MISSING
- **Description:** `governanceDelta` uses `findingsChanged: boolean` and `debtChanged: boolean`. A value of `false` could mean "not evaluated" or "evaluated but unchanged". These are semantically different but represented identically.
- **Impact:** Cannot distinguish "unchanged" from "not evaluated."

## GAP-22: Boolean information loss in constraintsChanged/decisionsChanged

- **File:** `scenario-evaluation.mjs:233-238`
- **Classification:** MISSING
- **Description:** `constraintsChanged` and `decisionsChanged` are boolean. `false` could mean "evaluated and unchanged" or "not evaluated." These use stringify comparison, which works when data exists but cannot represent the "not evaluated" state.
- **Impact:** Cannot distinguish unchanged from not evaluated.

## GAP-23: No evidence domain in evaluateArchitectureState

- **File:** `evaluation-primitives.mjs:305-431`
- **Classification:** MISSING
- **Description:** `evaluateArchitectureState` does not produce an `evidence` domain or any evidence-related output. The completeness model has 5 domains but no evidence domain.
- **Impact:** Evidence is not part of canonical evaluation.

## GAP-24: Scenario does not integrate with provenance graph

- **File:** `scenario-evaluation.mjs:330-568`
- **Classification:** MISSING
- **Description:** `evaluateScenario` maintains its own `evidenceChain` object (lines 419-433) that is independent of the `buildProvenanceGraph` provenance graph system. There is no integration between scenario evidence and canonical provenance.
- **Impact:** Two independent evidence systems.

## GAP-25: Scenario base provenance provenance string is not machine-checkable

- **File:** `scenario-evaluation.mjs:261-314`
- **Classification:** PARTIAL
- **Description:** The `provenance` field in the base result is a human-readable string like `"auto-resolved: git commit abc123 (dirty)"` or `"user-provided (matches HEAD)"`. These are not machine-checkable status values.
- **Impact:** Cannot programmatically verify base identity.

## GAP-26: evaluateArchitectureState is not the semantic center

- **File:** `evaluation-primitives.mjs:305-431`
- **Classification:** HARDENING_ONLY
- **Description:** `evaluateArchitectureState` exists but is not called by `composeImpactStatement` or `evaluateScenario`. It has no callers outside its own tests.
- **Impact:** The canonical evaluator is unused.

## GAP-27: No Evidence-Complete gate in completeness model

- **File:** `completeness.mjs:144-158`
- **Classification:** MISSING
- **Description:** `buildCompleteness` has no concept of evidence gates, no invariant checks, no `assertComplete` function.
- **Impact:** Cannot enforce Evidence-Complete contract.

## GAP-28: evaluateArchitectureState lacks evidence domain

- **File:** `evaluation-primitives.mjs:351-416`
- **Classification:** MISSING
- **Description:** The completeness construction in `evaluateArchitectureState` only covers structural, constraint, boundary, decision, governance. No evidence domain is created or tracked.
- **Impact:** Evidence completeness is not part of architecture evaluation.

## GAP-29: composeImpactStatement does not build evidence

- **File:** `impact-statement.mjs:105-234`
- **Classification:** MISSING
- **Description:** `composeImpactStatement` builds completeness (step 7b) but produces no evidence/provenance output. The statement has no evidence field.
- **Impact:** Impact statements have no evidence to support claims.

## GAP-30: No adversarial test for base identity

- **File:** `completeness-adversarial.integration.test.mjs`
- **Classification:** MISSING
- **Description:** No tests verify that a mismatched base, dirty tree, nonexistent revision, or non-git workspace produces correct completeness outcomes.
- **Impact:** Base identity is untested.

## GAP-31: No adversarial test for hidden gaps

- **File:** `completeness-adversarial.integration.test.mjs`
- **Classification:** MISSING
- **Description:** No tests verify that missing domains, unevaluated findings, ignored mutations, or missing provenance cause Evidence-Complete to fail.
- **Impact:** Hidden gap detection is untested.

## GAP-32: No adversarial test for false completeness

- **File:** `completeness-adversarial.integration.test.mjs`
- **Classification:** MISSING
- **Description:** No tests verify that `overallComplete = true` requires all gates to pass.
- **Impact:** False completeness is untested.

## GAP-33: No adversarial test for ambiguous edge mutation

- **File:** `completeness-adversarial.integration.test.mjs`
- **Classification:** MISSING
- **Description:** No test verifies that removing an edge with ambiguous identity (multiple edges same source+target, different type) produces a refusal rather than an arbitrary choice.
- **Impact:** Ambiguous mutation is untested.

## GAP-34: No adversarial test for governance not-evaluated in scenario completeness

- **File:** `completeness-adversarial.integration.test.mjs`
- **Classification:** PARTIAL
- **Description:** Test for "Governance not-evaluated semantics" exists (lines 202-226) but only tests `buildGovernanceCompleteness`, not whether scenario completeness correctly propagates governance NOT_EVALUATED into overall completeness.
- **Impact:** Governance completeness propagation is untested.

## GAP-35: No adversarial test for mutation coverage

- **File:** `completeness-adversarial.integration.test.mjs`
- **Classification:** MISSING
- **Description:** No test verifies every mutation has explicit outcome (applied or refused) and that mutationCoverage is tracked.
- **Impact:** Mutation coverage is untested.

## GAP-36: MCP scenario tool uses scenarioCommand, not evaluateScenario directly

- **File:** `archkeep-mcp/src/engine.mjs:468-473`
- **Classification:** HARDENING_ONLY
- **Description:** `scenarioTool` calls `scenarioCommand` (which wraps `evaluateScenario` with CLI formatting). This adds an extra layer between MCP and the evaluation logic but does not change semantics. Minor surface parity concern.
- **Impact:** MCP scenario adds CLI envelope wrapping.

## GAP-37: No dogfood testing against real repositories

- **File:** nowhere
- **Classification:** MISSING
- **Description:** No integration tests run Architecture Intelligence against real repositories (e.g., loom, action-agents).
- **Impact:** Real-world correctness is unverified.
