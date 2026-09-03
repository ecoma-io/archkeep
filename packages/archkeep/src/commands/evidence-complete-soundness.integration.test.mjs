/**
 * Evidence-Complete soundness invariants: false-complete detection,
 * anti-vacuity, monotonicity, conservation, and E2E scenario proof.
 *
 * Every test exercises the silent direction: an empty/partial result must
 * differ observably from a complete one, and removing evidence must never
 * improve completeness.
 */
import { describe, expect, it } from "vitest";

import {
  buildCompleteness,
  buildEvidenceComplete,
  buildScenarioCompleteness,
  buildGovernanceCompleteness,
  createDomain,
  EVALUATED,
} from "./completeness.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal domain object — buildCompleteness only reads `.status`. */
function domain(status) {
  return createDomain(status);
}

/** All-eight-domains EVALUATED shortcut. */
function allEvaluated() {
  return {
    structural: domain(EVALUATED),
    constraint: domain(EVALUATED),
    boundary: domain(EVALUATED),
    decision: domain(EVALUATED),
    findings: domain(EVALUATED),
    debt: domain(EVALUATED),
    governance: domain(EVALUATED),
    evidence: domain(EVALUATED),
  };
}

/** All-ten-gates passing for Evidence-Complete contract. */
function passingEC(overrides = {}) {
  return buildEvidenceComplete({
    domainCoverage: 1,
    claimEvidenceCoverage: 1,
    causalCoverage: 1,
    provenanceCoverage: 1,
    mutationCoverage: 1,
    surfaceParity: 1,
    hiddenGapCount: 0,
    falseCompleteCount: 0,
    baseIdentityValid: true,
    deterministic: true,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1. False-complete invariant
// ---------------------------------------------------------------------------

describe("false-complete invariant — buildCompleteness", () => {
  it("all domains EVALUATED but no evidenceComplete → overallComplete: false", () => {
    const result = buildCompleteness(allEvaluated());
    // Without an evidenceComplete contract, ecComplete defaults to false
    // and overallComplete MUST be false.
    expect(result.evidenceComplete).toBeUndefined();
    expect(result.overallComplete).toBe(false);
  });

  it("all domains EVALUATED but EC gates fail → overallComplete: false", () => {
    const ec = passingEC({ domainCoverage: 0 });
    const result = buildCompleteness({ ...allEvaluated(), evidenceComplete: ec });
    // Even with all domains EVALUATED, failed EC gate blocks overallComplete.
    // evidenceComplete is present but its own overallComplete is false.
    expect(result.evidenceComplete).toBeDefined();
    expect(result.evidenceComplete.overallComplete).toBe(false);
    expect(result.overallComplete).toBe(false);
    // Domain-Complete + !EC triggers false-complete detection
    expect(result.falseCompleteCount).toBe(1);
  });

  it("all domains EVALUATED and all EC gates pass → overallComplete: true", () => {
    const ec = passingEC();
    const result = buildCompleteness({ ...allEvaluated(), evidenceComplete: ec });
    expect(result.evidenceComplete).toBeDefined();
    expect(result.evidenceComplete.overallComplete).toBe(true);
    expect(result.overallComplete).toBe(true);
    // No false-complete detection when EC passes
    expect(result.falseCompleteCount).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Anti-vacuity invariant
// ---------------------------------------------------------------------------

describe("anti-vacuity — buildEvidenceComplete", () => {
  it("empty evaluation (all zeros) → overallComplete: false", () => {
    const ec = buildEvidenceComplete({
      domainCoverage: 0,
      claimEvidenceCoverage: 0,
      causalCoverage: 0,
      provenanceCoverage: 0,
      mutationCoverage: 0,
      surfaceParity: 0,
      hiddenGapCount: 5,
      falseCompleteCount: 3,
      baseIdentityValid: false,
      deterministic: false,
    });
    expect(ec.overallComplete).toBe(false);
    expect(ec.overallStatus).toBe("incomplete");
    // Every gate should report pass: false
    for (const [key, gate] of Object.entries(ec.gates)) {
      expect(gate.pass, `gate ${key} must not pass on empty evaluation`).toBe(false);
    }
  });

  it("no gates provided → defaults to NOT_EVALUATED (overallComplete: false)", () => {
    const ec = buildEvidenceComplete();
    // Without any arguments, all gates are at their default (0/false),
    // so overallComplete MUST be false.
    expect(ec.overallComplete).toBe(false);
    expect(ec.overallStatus).toBe("incomplete");
  });
});

// ---------------------------------------------------------------------------
// 3. Monotonicity invariant
// ---------------------------------------------------------------------------

describe("monotonicity — buildEvidenceComplete", () => {
  it("improving all gates never worsens completeness", () => {
    const base = buildEvidenceComplete({
      domainCoverage: 0.5,
      claimEvidenceCoverage: 0.5,
      causalCoverage: 0.5,
      provenanceCoverage: 0.5,
      mutationCoverage: 0.5,
      surfaceParity: 0.5,
      hiddenGapCount: 3,
      falseCompleteCount: 2,
      baseIdentityValid: false,
      deterministic: false,
    });

    const improved = buildEvidenceComplete({
      domainCoverage: 0.8,
      claimEvidenceCoverage: 0.8,
      causalCoverage: 0.8,
      provenanceCoverage: 0.8,
      mutationCoverage: 0.8,
      surfaceParity: 0.8,
      hiddenGapCount: 1,
      falseCompleteCount: 0,
      baseIdentityValid: true,
      deterministic: true,
    });

    // Monotonicity: improved gates must not regress any gate.
    for (const key of Object.keys(base.gates)) {
      const baseVal = base.gates[key].value;
      const improvedVal = improved.gates[key].value;
      if (key === "hiddenGapCount" || key === "falseCompleteCount") {
        // Counts: lower is better
        expect(improvedVal).toBeLessThanOrEqual(baseVal);
      } else if (typeof baseVal === "boolean") {
        // Booleans: must not go from true to false
        if (baseVal === true) {
          expect(improvedVal).toBe(true);
        }
      } else {
        // Ratios: higher is better
        expect(improvedVal).toBeGreaterThanOrEqual(baseVal);
      }
    }

    // Partial improvement (not all gates pass yet) still yields false
    expect(base.overallComplete).toBe(false);
    expect(improved.overallComplete).toBe(false);
  });

  it("improving to all gates passing yields overallComplete: true", () => {
    const ec = passingEC();
    expect(ec.overallComplete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Conservation invariant
// ---------------------------------------------------------------------------

describe("conservation — buildEvidenceComplete", () => {
  it("worsening a gate never improves completeness", () => {
    const good = passingEC();
    expect(good.overallComplete).toBe(true);

    const worse = passingEC({ domainCoverage: 0.5 });
    expect(worse.overallComplete).toBe(false);
    expect(worse.gates.domainCoverage.pass).toBe(false);
  });

  it("worsening each individual gate independently cannot improve completeness", () => {
    const gateDefs = [
      { key: "domainCoverage", bad: 0 },
      { key: "claimEvidenceCoverage", bad: 0 },
      { key: "causalCoverage", bad: 0 },
      { key: "provenanceCoverage", bad: 0 },
      { key: "mutationCoverage", bad: 0 },
      { key: "surfaceParity", bad: 0 },
      { key: "hiddenGapCount", bad: 5 },
      { key: "falseCompleteCount", bad: 3 },
      { key: "baseIdentityValid", bad: false },
      { key: "deterministic", bad: false },
    ];

    for (const { key, bad: badVal } of gateDefs) {
      const ec = passingEC({ [key]: badVal });
      expect(ec.overallComplete, `worsening ${key} must flip overallComplete to false`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Contract-type gate semantics
// ---------------------------------------------------------------------------

describe("contract-type gate semantics — buildEvidenceComplete", () => {
  it("CANONICAL contract: surfaceParity, mutationCoverage, baseIdentityValid are NOT required", () => {
    const ec = passingEC({
      mutationCoverage: 0,
      surfaceParity: 0,
      baseIdentityValid: false,
      contractType: "canonical",
    });
    expect(ec.overallComplete).toBe(true);
    expect(ec.gates.surfaceParity.required).toBe(false);
    expect(ec.gates.mutationCoverage.required).toBe(false);
    expect(ec.gates.baseIdentityValid.required).toBe(false);
  });

  it("SCENARIO contract: ALL gates are required", () => {
    const ec = passingEC({ contractType: "scenario" });
    expect(ec.overallComplete).toBe(true);
    for (const [key, gate] of Object.entries(ec.gates)) {
      expect(gate.required, `gate ${key} must be required for SCENARIO`).toBe(true);
    }
  });

  it("SCENARIO contract fails when baseIdentityValid is false", () => {
    const ec = passingEC({ baseIdentityValid: false, contractType: "scenario" });
    expect(ec.overallComplete).toBe(false);
    expect(ec.gates.baseIdentityValid.pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Scenario completeness — evidence gate integration
// ---------------------------------------------------------------------------

describe("scenario completeness — evidence gate integration", () => {
  it("scenario without evidence gates reports overallComplete false", () => {
    const governance = buildGovernanceCompleteness({
      findingsStatus: EVALUATED,
      debtStatus: EVALUATED,
    });
    const result = buildScenarioCompleteness({
      changesComplete: true,
      baseIdentityVerified: true,
      mutationCoverageComplete: true,
      governance,
    });
    expect(result.overallComplete).toBe(false);
  });

  it("scenario with passing SCENARIO evidence gates reports overallComplete true", () => {
    const governance = buildGovernanceCompleteness({
      findingsStatus: EVALUATED,
      debtStatus: EVALUATED,
    });
    const ec = passingEC({ contractType: "scenario" });
    const result = buildScenarioCompleteness({
      changesComplete: true,
      baseIdentityVerified: true,
      mutationCoverageComplete: true,
      governance,
      evidenceComplete: ec,
      domains: allEvaluated(),
    });
    expect(result.overallComplete).toBe(true);
  });
});
