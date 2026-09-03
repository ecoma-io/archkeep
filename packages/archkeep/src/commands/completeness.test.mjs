import { describe, expect, it } from "vitest";

import {
  EVALUATION_STATUS,
  evaluationStatus,
  buildCompleteness,
  buildGovernanceCompleteness,
  buildScenarioCompleteness,
  buildEvidenceComplete,
  EVIDENCE_COMPLETE_GATES,
  REQUIRED_DOMAINS,
  createDomain,
  computeDomainCoverage,
} from "./completeness.mjs";

/**
 * Tests for the shared completeness model.
 *
 * The silent-direction invariant: a missing or omitted evaluation flag never
 * reports as evaluated — defaults and priority rules always fall through to
 * the safest status.
 */

// ---------------------------------------------------------------------------
// evaluationStatus
// ---------------------------------------------------------------------------

describe("evaluationStatus", () => {
  it("returns evaluated when only evaluated is true", () => {
    expect(evaluationStatus({ evaluated: true })).toBe(EVALUATION_STATUS.EVALUATED);
  });

  it("returns partial when evaluated and partial are true", () => {
    expect(evaluationStatus({ evaluated: true, partial: true })).toBe(EVALUATION_STATUS.PARTIAL);
  });

  it("returns not_evaluated when notEvaluated is true", () => {
    expect(evaluationStatus({ notEvaluated: true })).toBe(EVALUATION_STATUS.NOT_EVALUATED);
  });

  it("returns unsupported when unsupported is true", () => {
    expect(evaluationStatus({ unsupported: true })).toBe(EVALUATION_STATUS.UNSUPPORTED);
  });

  it("returns refused when refused is true", () => {
    expect(evaluationStatus({ refused: true })).toBe(EVALUATION_STATUS.REFUSED);
  });

  describe("priority order", () => {
    it("refused beats unsupported", () => {
      expect(evaluationStatus({ refused: true, unsupported: true })).toBe(
        EVALUATION_STATUS.REFUSED,
      );
    });

    it("unsupported beats notEvaluated", () => {
      expect(evaluationStatus({ unsupported: true, notEvaluated: true })).toBe(
        EVALUATION_STATUS.UNSUPPORTED,
      );
    });

    it("notEvaluated beats evaluated", () => {
      expect(evaluationStatus({ notEvaluated: true, evaluated: true })).toBe(
        EVALUATION_STATUS.NOT_EVALUATED,
      );
    });

    it("partial beats evaluated (both set)", () => {
      expect(evaluationStatus({ evaluated: true, partial: true })).toBe(EVALUATION_STATUS.PARTIAL);
    });
  });

  it("returns not_evaluated for empty object", () => {
    expect(evaluationStatus({})).toBe(EVALUATION_STATUS.NOT_EVALUATED);
  });

  it("returns not_evaluated when all flags are false", () => {
    expect(
      evaluationStatus({
        evaluated: false,
        partial: false,
        notEvaluated: false,
        unsupported: false,
        refused: false,
      }),
    ).toBe(EVALUATION_STATUS.NOT_EVALUATED);
  });

  it("returns not_evaluated when called without arguments", () => {
    expect(evaluationStatus()).toBe(EVALUATION_STATUS.NOT_EVALUATED);
  });
});

// ---------------------------------------------------------------------------
// EVIDENCE_COMPLETE_GATES
// ---------------------------------------------------------------------------

describe("EVIDENCE_COMPLETE_GATES", () => {
  it("has exactly 10 gates", () => {
    expect(EVIDENCE_COMPLETE_GATES).toHaveLength(10);
  });

  it("includes all required gate keys", () => {
    const keys = EVIDENCE_COMPLETE_GATES.map((g) => g.key).sort();
    expect(keys).toEqual([
      "baseIdentityValid",
      "causalCoverage",
      "claimEvidenceCoverage",
      "deterministic",
      "domainCoverage",
      "falseCompleteCount",
      "hiddenGapCount",
      "mutationCoverage",
      "provenanceCoverage",
      "surfaceParity",
    ]);
  });
});

// ---------------------------------------------------------------------------
// REQUIRED_DOMAINS
// ---------------------------------------------------------------------------

describe("REQUIRED_DOMAINS", () => {
  it("has exactly 8 domains", () => {
    expect(REQUIRED_DOMAINS).toHaveLength(8);
  });

  it("includes evidence domain", () => {
    expect(REQUIRED_DOMAINS).toContain("evidence");
  });

  it("includes findings and debt domains", () => {
    expect(REQUIRED_DOMAINS).toContain("findings");
    expect(REQUIRED_DOMAINS).toContain("debt");
  });
});

// ---------------------------------------------------------------------------
// computeDomainCoverage
// ---------------------------------------------------------------------------

describe("computeDomainCoverage", () => {
  it("returns 1.0 when all required domains are EVALUATED", () => {
    /** @type {Record<string, string>} */
    const statuses = {};
    for (const d of REQUIRED_DOMAINS) {
      statuses[d] = EVALUATION_STATUS.EVALUATED;
    }
    const result = computeDomainCoverage(statuses);
    expect(result.coverage).toBe(1);
    expect(result.evaluatedCount).toBe(8);
    expect(result.failedDomains).toEqual([]);
  });
  it("returns 0.5 when half are EVALUATED", () => {
    /** @type {Record<string, string>} */
    const statuses = {};
    REQUIRED_DOMAINS.forEach((d, i) => {
      statuses[d] = i < 4 ? EVALUATION_STATUS.EVALUATED : EVALUATION_STATUS.NOT_EVALUATED;
    });
    const result = computeDomainCoverage(statuses);
    expect(result.coverage).toBe(0.5);
    expect(result.evaluatedCount).toBe(4);
  });
  it("counts only EVALUATED — not PARTIAL — as evaluated", () => {
    /** @type {Record<string, string>} */
    const statuses = {};
    REQUIRED_DOMAINS.forEach((d, i) => {
      statuses[d] = i === 0 ? EVALUATION_STATUS.PARTIAL : EVALUATION_STATUS.EVALUATED;
    });
    const result = computeDomainCoverage(statuses);
    expect(result.coverage).toBe(7 / 8);
    expect(result.failedDomains).toContain(REQUIRED_DOMAINS[0]);
  });

  it("returns 1.0 for empty required domains list", () => {
    const result = computeDomainCoverage({}, []);
    expect(result.coverage).toBe(1);
    expect(result.evaluatedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildCompleteness (8-domain model)
// ---------------------------------------------------------------------------

describe("buildCompleteness", () => {
  function domain(status, note = "") {
    return createDomain(status, note);
  }

  it("reports overallComplete true when all 8 domains are EVALUATED", () => {
    const result = buildCompleteness({
      structural: domain(EVALUATION_STATUS.EVALUATED),
      constraint: domain(EVALUATION_STATUS.EVALUATED),
      boundary: domain(EVALUATION_STATUS.EVALUATED),
      decision: domain(EVALUATION_STATUS.EVALUATED),
      findings: domain(EVALUATION_STATUS.EVALUATED),
      debt: domain(EVALUATION_STATUS.EVALUATED),
      governance: domain(EVALUATION_STATUS.EVALUATED),
      evidence: domain(EVALUATION_STATUS.EVALUATED),
    });
    expect(result.overallComplete).toBe(true);
    expect(result.overallStatus).toBe(EVALUATION_STATUS.EVALUATED);
  });

  it("reports overallComplete false when one domain is NOT_EVALUATED", () => {
    const result = buildCompleteness({
      structural: domain(EVALUATION_STATUS.EVALUATED),
      constraint: domain(EVALUATION_STATUS.EVALUATED),
      boundary: domain(EVALUATION_STATUS.EVALUATED),
      decision: domain(EVALUATION_STATUS.EVALUATED),
      findings: domain(EVALUATION_STATUS.EVALUATED),
      debt: domain(EVALUATION_STATUS.EVALUATED),
      governance: domain(EVALUATION_STATUS.NOT_EVALUATED),
      evidence: domain(EVALUATION_STATUS.EVALUATED),
    });
    expect(result.overallComplete).toBe(false);
    expect(result.overallStatus).toBe(EVALUATION_STATUS.NOT_EVALUATED);
  });

  it("reports overallComplete false when one domain is PARTIAL", () => {
    const result = buildCompleteness({
      structural: domain(EVALUATION_STATUS.EVALUATED),
      constraint: domain(EVALUATION_STATUS.EVALUATED),
      boundary: domain(EVALUATION_STATUS.EVALUATED),
      decision: domain(EVALUATION_STATUS.EVALUATED),
      findings: domain(EVALUATION_STATUS.EVALUATED),
      debt: domain(EVALUATION_STATUS.EVALUATED),
      governance: domain(EVALUATION_STATUS.PARTIAL),
      evidence: domain(EVALUATION_STATUS.EVALUATED),
    });
    expect(result.overallComplete).toBe(false);
    expect(result.overallStatus).toBe(EVALUATION_STATUS.PARTIAL);
  });

  it("reports overallComplete false when one domain is REFUSED", () => {
    const result = buildCompleteness({
      structural: domain(EVALUATION_STATUS.EVALUATED),
      constraint: domain(EVALUATION_STATUS.EVALUATED),
      boundary: domain(EVALUATION_STATUS.EVALUATED),
      decision: domain(EVALUATION_STATUS.EVALUATED),
      findings: domain(EVALUATION_STATUS.EVALUATED),
      debt: domain(EVALUATION_STATUS.EVALUATED),
      governance: domain(EVALUATION_STATUS.REFUSED),
      evidence: domain(EVALUATION_STATUS.EVALUATED),
    });
    expect(result.overallComplete).toBe(false);
    expect(result.overallStatus).toBe(EVALUATION_STATUS.REFUSED);
  });

  it("defaults all 8 domains to NOT_EVALUATED when no input given", () => {
    const result = buildCompleteness();
    expect(result.overallComplete).toBe(false);
    expect(result.overallStatus).toBe(EVALUATION_STATUS.NOT_EVALUATED);
    expect(Object.keys(result.domains)).toHaveLength(8);
    for (const [name, d] of Object.entries(result.domains)) {
      expect(d.status, `${name} should default to NOT_EVALUATED`).toBe(
        EVALUATION_STATUS.NOT_EVALUATED,
      );
    }
  });

  it("defaults a missing domain to NOT_EVALUATED", () => {
    const result = buildCompleteness({
      structural: domain(EVALUATION_STATUS.EVALUATED),
      constraint: domain(EVALUATION_STATUS.EVALUATED),
      boundary: domain(EVALUATION_STATUS.EVALUATED),
      decision: domain(EVALUATION_STATUS.EVALUATED),
      governance: domain(EVALUATION_STATUS.EVALUATED),
    });
    // findings, debt, evidence should default to NOT_EVALUATED
    expect(result.domains.findings.status).toBe(EVALUATION_STATUS.NOT_EVALUATED);
    expect(result.domains.debt.status).toBe(EVALUATION_STATUS.NOT_EVALUATED);
    expect(result.domains.evidence.status).toBe(EVALUATION_STATUS.NOT_EVALUATED);
    expect(result.overallComplete).toBe(false);
  });

  it("detects hidden gaps: NOT_EVALUATED domain without a note", () => {
    const result = buildCompleteness({
      structural: domain(EVALUATION_STATUS.EVALUATED),
      constraint: domain(EVALUATION_STATUS.EVALUATED),
      boundary: domain(EVALUATION_STATUS.EVALUATED),
      decision: domain(EVALUATION_STATUS.EVALUATED),
      findings: domain(EVALUATION_STATUS.NOT_EVALUATED, "Findings not available"),
      debt: domain(EVALUATION_STATUS.NOT_EVALUATED), // no note — hidden gap
      governance: domain(EVALUATION_STATUS.NOT_EVALUATED, "Governance not evaluated"),
      evidence: domain(EVALUATION_STATUS.EVALUATED),
    });
    expect(result.hiddenGapCount).toBe(1);
  });

  it("detects false complete when domains pass but evidence gates fail", () => {
    const result = buildCompleteness({
      structural: domain(EVALUATION_STATUS.EVALUATED),
      constraint: domain(EVALUATION_STATUS.EVALUATED),
      boundary: domain(EVALUATION_STATUS.EVALUATED),
      decision: domain(EVALUATION_STATUS.EVALUATED),
      findings: domain(EVALUATION_STATUS.EVALUATED),
      debt: domain(EVALUATION_STATUS.EVALUATED),
      governance: domain(EVALUATION_STATUS.EVALUATED),
      evidence: domain(EVALUATION_STATUS.EVALUATED),
      evidenceComplete: buildEvidenceComplete({
        domainCoverage: 1,
        claimEvidenceCoverage: 0.5, // fails — not 1.0
        causalCoverage: 1,
        provenanceCoverage: 1,
        mutationCoverage: 1,
        surfaceParity: 1,
        hiddenGapCount: 0,
        falseCompleteCount: 0,
        baseIdentityValid: true,
        deterministic: true,
      }),
    });
    // Domain-level completeness is true but EC gates fail
    expect(result.overallComplete).toBe(false);
    expect(result.falseCompleteCount).toBe(1);
  });

  it("includes evidenceComplete in result when provided", () => {
    const ec = buildEvidenceComplete({
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
    });
    const result = buildCompleteness({
      structural: domain(EVALUATION_STATUS.EVALUATED),
      constraint: domain(EVALUATION_STATUS.EVALUATED),
      boundary: domain(EVALUATION_STATUS.EVALUATED),
      decision: domain(EVALUATION_STATUS.EVALUATED),
      findings: domain(EVALUATION_STATUS.EVALUATED),
      debt: domain(EVALUATION_STATUS.EVALUATED),
      governance: domain(EVALUATION_STATUS.EVALUATED),
      evidence: domain(EVALUATION_STATUS.EVALUATED),
      evidenceComplete: ec,
    });
    expect(result.evidenceComplete).toBeDefined();
    expect(result.evidenceComplete.overallComplete).toBe(true);
    expect(result.overallComplete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildEvidenceComplete
// ---------------------------------------------------------------------------

describe("buildEvidenceComplete", () => {
  it("returns complete when all gates pass", () => {
    const ec = buildEvidenceComplete({
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
    });
    expect(ec.overallComplete).toBe(true);
    expect(ec.overallStatus).toBe("complete");
  });

  it("returns incomplete when domainCoverage is not 1", () => {
    const ec = buildEvidenceComplete({
      domainCoverage: 0.875,
      claimEvidenceCoverage: 1,
      causalCoverage: 1,
      provenanceCoverage: 1,
      mutationCoverage: 1,
      surfaceParity: 1,
      hiddenGapCount: 0,
      falseCompleteCount: 0,
      baseIdentityValid: true,
      deterministic: true,
    });
    expect(ec.overallComplete).toBe(false);
    expect(ec.gates.domainCoverage.pass).toBe(false);
  });

  it("returns incomplete when hiddenGapCount is not 0", () => {
    const ec = buildEvidenceComplete({
      domainCoverage: 1,
      claimEvidenceCoverage: 1,
      causalCoverage: 1,
      provenanceCoverage: 1,
      mutationCoverage: 1,
      surfaceParity: 1,
      hiddenGapCount: 2,
      falseCompleteCount: 0,
      baseIdentityValid: true,
      deterministic: true,
    });
    expect(ec.overallComplete).toBe(false);
    expect(ec.gates.hiddenGapCount.pass).toBe(false);
  });

  it("returns incomplete when deterministic is false", () => {
    const ec = buildEvidenceComplete({
      domainCoverage: 1,
      claimEvidenceCoverage: 1,
      causalCoverage: 1,
      provenanceCoverage: 1,
      mutationCoverage: 1,
      surfaceParity: 1,
      hiddenGapCount: 0,
      falseCompleteCount: 0,
      baseIdentityValid: true,
      deterministic: false,
    });
    expect(ec.overallComplete).toBe(false);
    expect(ec.gates.deterministic.pass).toBe(false);
  });

  it("exposes per-gate status", () => {
    const ec = buildEvidenceComplete({
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
    });
    expect(Object.keys(ec.gates)).toHaveLength(10);
    for (const [key, gate] of Object.entries(ec.gates)) {
      expect(gate.pass, `${key} should pass`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// buildGovernanceCompleteness
// ---------------------------------------------------------------------------

describe("buildGovernanceCompleteness", () => {
  it("returns evaluated when both findings and debt are EVALUATED", () => {
    const result = buildGovernanceCompleteness({
      findingsStatus: EVALUATION_STATUS.EVALUATED,
      debtStatus: EVALUATION_STATUS.EVALUATED,
    });
    expect(result.domain.status).toBe(EVALUATION_STATUS.EVALUATED);
    expect(result.findings.status).toBe(EVALUATION_STATUS.EVALUATED);
    expect(result.debt.status).toBe(EVALUATION_STATUS.EVALUATED);
  });

  it("returns not_evaluated when findings is NOT_EVALUATED and note mentions findings", () => {
    const result = buildGovernanceCompleteness({
      findingsStatus: EVALUATION_STATUS.NOT_EVALUATED,
      debtStatus: EVALUATION_STATUS.EVALUATED,
    });
    expect(result.domain.status).toBe(EVALUATION_STATUS.NOT_EVALUATED);
    expect(result.domain.note).toContain("findings");
    expect(result.domain.note).not.toContain("debt");
    expect(result.findings.status).toBe(EVALUATION_STATUS.NOT_EVALUATED);
    expect(result.debt.status).toBe(EVALUATION_STATUS.EVALUATED);
  });

  it("returns not_evaluated when debt is NOT_EVALUATED and note mentions debt", () => {
    const result = buildGovernanceCompleteness({
      findingsStatus: EVALUATION_STATUS.EVALUATED,
      debtStatus: EVALUATION_STATUS.NOT_EVALUATED,
    });
    expect(result.domain.status).toBe(EVALUATION_STATUS.NOT_EVALUATED);
    expect(result.domain.note).toContain("debt");
    expect(result.domain.note).not.toContain("findings");
  });

  it("returns not_evaluated when both are NOT_EVALUATED", () => {
    const result = buildGovernanceCompleteness({
      findingsStatus: EVALUATION_STATUS.NOT_EVALUATED,
      debtStatus: EVALUATION_STATUS.NOT_EVALUATED,
    });
    expect(result.domain.status).toBe(EVALUATION_STATUS.NOT_EVALUATED);
    expect(result.domain.note).toContain("findings");
    expect(result.domain.note).toContain("debt");
  });

  it("defaults both findings and debt to NOT_EVALUATED", () => {
    const result = buildGovernanceCompleteness();
    expect(result.findingsStatus).toBe(EVALUATION_STATUS.NOT_EVALUATED);
    expect(result.debtStatus).toBe(EVALUATION_STATUS.NOT_EVALUATED);
    expect(result.findings.status).toBe(EVALUATION_STATUS.NOT_EVALUATED);
    expect(result.debt.status).toBe(EVALUATION_STATUS.NOT_EVALUATED);
    expect(result.domain.status).toBe(EVALUATION_STATUS.NOT_EVALUATED);
  });
});

// ---------------------------------------------------------------------------
// buildScenarioCompleteness
// ---------------------------------------------------------------------------

describe("buildScenarioCompleteness", () => {
  it("reports overallComplete true when changes, base, mutation and governance complete", () => {
    const governance = buildGovernanceCompleteness({
      findingsStatus: EVALUATION_STATUS.EVALUATED,
      debtStatus: EVALUATION_STATUS.EVALUATED,
    });
    const result = buildScenarioCompleteness({
      changesComplete: true,
      baseIdentityVerified: true,
      mutationCoverageComplete: true,
      governance,
      domains: {
        structural: createDomain(EVALUATION_STATUS.EVALUATED),
        constraint: createDomain(EVALUATION_STATUS.EVALUATED),
        boundary: createDomain(EVALUATION_STATUS.EVALUATED),
        decision: createDomain(EVALUATION_STATUS.EVALUATED),
        findings: createDomain(EVALUATION_STATUS.EVALUATED),
        debt: createDomain(EVALUATION_STATUS.EVALUATED),
        governance: createDomain(EVALUATION_STATUS.EVALUATED),
        evidence: createDomain(EVALUATION_STATUS.EVALUATED),
      },
    });
    expect(result.overallComplete).toBe(true);
    expect(result.scenarioDomains.changes.status).toBe(EVALUATION_STATUS.EVALUATED);
    expect(result.scenarioDomains.base.status).toBe(EVALUATION_STATUS.EVALUATED);
    expect(result.scenarioDomains.mutationCoverage.status).toBe(EVALUATION_STATUS.EVALUATED);
  });

  it("reports changes PARTIAL when changesComplete is false", () => {
    const result = buildScenarioCompleteness({
      changesComplete: false,
      baseIdentityVerified: true,
    });
    expect(result.scenarioDomains.changes.status).toBe(EVALUATION_STATUS.PARTIAL);
    expect(result.scenarioDomains.changes.note).toContain("changes could not be applied");
  });

  it("reports base NOT_EVALUATED when baseIdentityVerified is false", () => {
    const result = buildScenarioCompleteness({
      changesComplete: true,
      baseIdentityVerified: false,
    });
    expect(result.scenarioDomains.base.status).toBe(EVALUATION_STATUS.NOT_EVALUATED);
    expect(result.scenarioDomains.base.note).toContain(
      "Base revision identity could not be verified",
    );
  });

  it("reports mutationCoverage PARTIAL when mutationCoverageComplete is false", () => {
    const result = buildScenarioCompleteness({
      changesComplete: true,
      baseIdentityVerified: true,
      mutationCoverageComplete: false,
    });
    expect(result.scenarioDomains.mutationCoverage.status).toBe(EVALUATION_STATUS.PARTIAL);
    expect(result.scenarioDomains.mutationCoverage.note).toContain(
      "mutations have explicit outcomes",
    );
  });

  it("includes governance domain when governance is provided from buildGovernanceCompleteness", () => {
    const governance = buildGovernanceCompleteness({
      findingsStatus: EVALUATION_STATUS.EVALUATED,
      debtStatus: EVALUATION_STATUS.NOT_EVALUATED,
    });
    const result = buildScenarioCompleteness({
      changesComplete: true,
      baseIdentityVerified: true,
      governance,
    });
    expect(result.domains.governance).toBe(governance.domain);
    expect(result.domains.governance.status).toBe(EVALUATION_STATUS.NOT_EVALUATED);
  });

  it("scenarioDomains contains changes, base, and mutationCoverage keys", () => {
    const result = buildScenarioCompleteness({
      changesComplete: true,
      baseIdentityVerified: true,
    });
    expect(result.scenarioDomains).toHaveProperty("changes");
    expect(result.scenarioDomains).toHaveProperty("base");
    expect(result.scenarioDomains).toHaveProperty("mutationCoverage");
  });

  it("passes through evidenceComplete when provided", () => {
    const ec = buildEvidenceComplete({
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
    });
    const result = buildScenarioCompleteness({
      changesComplete: true,
      baseIdentityVerified: true,
      mutationCoverageComplete: true,
      evidenceComplete: ec,
    });
    expect(result.evidenceComplete).toBeDefined();
    expect(result.evidenceComplete.overallComplete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Silent direction tests
// ---------------------------------------------------------------------------

describe("silent direction — missing evaluation never reports as evaluated", () => {
  it("buildCompleteness with all EVALUATED but one domain missing defaults to NOT_EVALUATED", () => {
    const ev = (s) => createDomain(s);
    // Supply 7 domains as EVALUATED; the 8th (evidence) is absent.
    const result = buildCompleteness({
      structural: ev(EVALUATION_STATUS.EVALUATED),
      constraint: ev(EVALUATION_STATUS.EVALUATED),
      boundary: ev(EVALUATION_STATUS.EVALUATED),
      decision: ev(EVALUATION_STATUS.EVALUATED),
      findings: ev(EVALUATION_STATUS.EVALUATED),
      debt: ev(EVALUATION_STATUS.EVALUATED),
      governance: ev(EVALUATION_STATUS.EVALUATED),
    });
    // evidence should default to NOT_EVALUATED
    expect(result.domains.evidence.status).toBe(EVALUATION_STATUS.NOT_EVALUATED);
    expect(result.overallComplete).toBe(false);
  });

  it("buildGovernanceCompleteness with no args reports NOT_EVALUATED", () => {
    const result = buildGovernanceCompleteness();
    expect(result.domain.status).toBe(EVALUATION_STATUS.NOT_EVALUATED);
    expect(result.domain.evaluated).toBe(false);
    expect(result.domain.notEvaluated).toBe(true);
  });

  it("buildScenarioCompleteness with no args does not assume standard domains evaluated", () => {
    const result = buildScenarioCompleteness();
    // Without domains pass-through, structural/constraint/boundary/decision
    // should NOT be EVALUATED
    expect(result.domains.structural.status).toBe(EVALUATION_STATUS.NOT_EVALUATED);
    expect(result.domains.constraint.status).toBe(EVALUATION_STATUS.NOT_EVALUATED);
  });
});
