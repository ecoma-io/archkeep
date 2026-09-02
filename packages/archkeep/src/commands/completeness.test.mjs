import { describe, expect, it } from "vitest";

import {
  EVALUATION_STATUS,
  evaluationStatus,
  buildCompleteness,
  buildGovernanceCompleteness,
  buildScenarioCompleteness,
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
// buildCompleteness
// ---------------------------------------------------------------------------

describe("buildCompleteness", () => {
  const evaluated = () => EVALUATION_STATUS.EVALUATED;
  const notEvaluated = () => EVALUATION_STATUS.NOT_EVALUATED;
  const partial = () => EVALUATION_STATUS.PARTIAL;
  const refused = () => EVALUATION_STATUS.REFUSED;

  function domain(status, note = "") {
    return {
      status,
      evaluated: status === EVALUATION_STATUS.EVALUATED || status === EVALUATION_STATUS.PARTIAL,
      partial: status === EVALUATION_STATUS.PARTIAL,
      notEvaluated: status === EVALUATION_STATUS.NOT_EVALUATED,
      unsupported: status === EVALUATION_STATUS.UNSUPPORTED,
      refused: status === EVALUATION_STATUS.REFUSED,
      note,
    };
  }

  it("reports overallComplete true when all domains are EVALUATED", () => {
    const result = buildCompleteness({
      structural: domain(evaluated()),
      constraint: domain(evaluated()),
      boundary: domain(evaluated()),
      decision: domain(evaluated()),
      governance: domain(evaluated()),
    });
    expect(result.overallComplete).toBe(true);
    expect(result.overallStatus).toBe(EVALUATION_STATUS.EVALUATED);
  });

  it("reports overallComplete false when one domain is NOT_EVALUATED", () => {
    const result = buildCompleteness({
      structural: domain(evaluated()),
      constraint: domain(evaluated()),
      boundary: domain(evaluated()),
      decision: domain(evaluated()),
      governance: domain(notEvaluated()),
    });
    expect(result.overallComplete).toBe(false);
    expect(result.overallStatus).toBe(EVALUATION_STATUS.NOT_EVALUATED);
  });

  it("reports overallComplete false when one domain is PARTIAL", () => {
    const result = buildCompleteness({
      structural: domain(evaluated()),
      constraint: domain(evaluated()),
      boundary: domain(evaluated()),
      decision: domain(evaluated()),
      governance: domain(partial()),
    });
    expect(result.overallComplete).toBe(false);
    expect(result.overallStatus).toBe(EVALUATION_STATUS.PARTIAL);
  });

  it("reports overallComplete false when one domain is REFUSED", () => {
    const result = buildCompleteness({
      structural: domain(evaluated()),
      constraint: domain(evaluated()),
      boundary: domain(evaluated()),
      decision: domain(evaluated()),
      governance: domain(refused()),
    });
    expect(result.overallComplete).toBe(false);
    expect(result.overallStatus).toBe(EVALUATION_STATUS.REFUSED);
  });

  it("defaults all domains to NOT_EVALUATED when no input given", () => {
    const result = buildCompleteness();
    expect(result.overallComplete).toBe(false);
    expect(result.overallStatus).toBe(EVALUATION_STATUS.NOT_EVALUATED);
    for (const [name, d] of Object.entries(result.domains)) {
      expect(d.status, `${name} should default to NOT_EVALUATED`).toBe(
        EVALUATION_STATUS.NOT_EVALUATED,
      );
    }
  });

  it("defaults a missing domain to NOT_EVALUATED", () => {
    // Only supply 4 of the 5 domains; governance should default to NOT_EVALUATED
    const result = buildCompleteness({
      structural: domain(evaluated()),
      constraint: domain(evaluated()),
      boundary: domain(evaluated()),
      decision: domain(evaluated()),
    });
    expect(result.domains.governance.status).toBe(EVALUATION_STATUS.NOT_EVALUATED);
    expect(result.overallComplete).toBe(false);
    expect(result.overallStatus).toBe(EVALUATION_STATUS.NOT_EVALUATED);
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
  });

  it("returns not_evaluated when findings is NOT_EVALUATED and note mentions findings", () => {
    const result = buildGovernanceCompleteness({
      findingsStatus: EVALUATION_STATUS.NOT_EVALUATED,
      debtStatus: EVALUATION_STATUS.EVALUATED,
    });
    expect(result.domain.status).toBe(EVALUATION_STATUS.NOT_EVALUATED);
    expect(result.domain.note).toContain("findings");
    expect(result.domain.note).not.toContain("debt");
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
    expect(result.domain.status).toBe(EVALUATION_STATUS.NOT_EVALUATED);
  });
});

// ---------------------------------------------------------------------------
// buildScenarioCompleteness
// ---------------------------------------------------------------------------

describe("buildScenarioCompleteness", () => {
  it("reports overallComplete true when changes and base are complete", () => {
    const governance = buildGovernanceCompleteness({
      findingsStatus: EVALUATION_STATUS.EVALUATED,
      debtStatus: EVALUATION_STATUS.EVALUATED,
    });
    const result = buildScenarioCompleteness({
      changesComplete: true,
      baseAttributed: true,
      governance,
    });
    expect(result.overallComplete).toBe(true);
    expect(result.scenarioDomains.changes.status).toBe(EVALUATION_STATUS.EVALUATED);
    expect(result.scenarioDomains.base.status).toBe(EVALUATION_STATUS.EVALUATED);
  });

  it("reports changes PARTIAL when changesComplete is false", () => {
    const result = buildScenarioCompleteness({ changesComplete: false, baseAttributed: true });
    expect(result.scenarioDomains.changes.status).toBe(EVALUATION_STATUS.PARTIAL);
    expect(result.scenarioDomains.changes.note).toContain("changes could not be applied");
  });

  it("reports base NOT_EVALUATED when baseAttributed is false", () => {
    const result = buildScenarioCompleteness({ changesComplete: true, baseAttributed: false });
    expect(result.scenarioDomains.base.status).toBe(EVALUATION_STATUS.NOT_EVALUATED);
    expect(result.scenarioDomains.base.note).toContain("Base revision could not be attributed");
  });

  it("includes governance domain when governance is provided from buildGovernanceCompleteness", () => {
    const governance = buildGovernanceCompleteness({
      findingsStatus: EVALUATION_STATUS.EVALUATED,
      debtStatus: EVALUATION_STATUS.NOT_EVALUATED,
    });
    const result = buildScenarioCompleteness({
      changesComplete: true,
      baseAttributed: true,
      governance,
    });
    expect(result.domains.governance).toBe(governance.domain);
    expect(result.domains.governance.status).toBe(EVALUATION_STATUS.NOT_EVALUATED);
  });

  it("scenarioDomains contains changes and base keys", () => {
    const result = buildScenarioCompleteness({ changesComplete: true, baseAttributed: true });
    expect(result.scenarioDomains).toHaveProperty("changes");
    expect(result.scenarioDomains).toHaveProperty("base");
  });
});

// ---------------------------------------------------------------------------
// Silent direction tests
// ---------------------------------------------------------------------------

describe("silent direction — missing evaluation never reports as evaluated", () => {
  it("buildCompleteness with all EVALUATED but one domain missing defaults to NOT_EVALUATED", () => {
    // Supply 4 domains as EVALUATED; the 5th (governance) is absent.
    const evaluatedDomain = {
      status: EVALUATION_STATUS.EVALUATED,
      evaluated: true,
      partial: false,
      notEvaluated: false,
      unsupported: false,
      refused: false,
      note: "",
    };
    const result = buildCompleteness({
      structural: evaluatedDomain,
      constraint: evaluatedDomain,
      boundary: evaluatedDomain,
      decision: evaluatedDomain,
      // governance is missing — should default to NOT_EVALUATED
    });
    expect(result.overallComplete).toBe(false);
    expect(result.overallStatus).toBe(EVALUATION_STATUS.NOT_EVALUATED);
    expect(result.domains.governance.status).toBe(EVALUATION_STATUS.NOT_EVALUATED);
  });

  it("buildGovernanceCompleteness without arguments reports NOT_EVALUATED, not EVALUATED", () => {
    const result = buildGovernanceCompleteness();
    expect(result.domain.status).toBe(EVALUATION_STATUS.NOT_EVALUATED);
    expect(result.domain.evaluated).toBe(false);
  });

  it("buildScenarioCompleteness with changesComplete false reports PARTIAL, not EVALUATED", () => {
    const result = buildScenarioCompleteness({ changesComplete: false });
    expect(result.scenarioDomains.changes.status).toBe(EVALUATION_STATUS.PARTIAL);
    expect(result.overallComplete).toBe(false);
  });
});
