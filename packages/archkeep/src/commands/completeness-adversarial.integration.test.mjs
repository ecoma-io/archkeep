/**
 * Adversarial invariants for the completeness model — no-op, round-trip,
 * conservation, evidence chain, refusal isolation, governance semantics,
 * and MCP doc parity.
 *
 * Every test exercises the silent direction: an empty/partial result must
 * differ observably from a complete one.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildCompleteness,
  buildScenarioCompleteness,
  buildGovernanceCompleteness,
  EVALUATED,
  NOT_EVALUATED,
  PARTIAL,
} from "./completeness.mjs";
import { evaluateArchitectureState } from "./evaluation-primitives.mjs";
import { evaluateScenario } from "./scenario-evaluation.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal domain object — buildCompleteness only reads `.status`. */
function domain(status) {
  return { status };
}

/** Minimal graph with one project and no dependencies. */
function minimalGraph(projectName) {
  return {
    nodes: { [projectName]: {} },
    dependencies: {},
  };
}

/** Resolve a file path relative to this test file's directory. */
function fixturePath(...segments) {
  return new URL(segments.join("/"), import.meta.url).pathname;
}

// ---------------------------------------------------------------------------
// 1. No-op invariant (Gap A)
// ---------------------------------------------------------------------------

describe("no-op invariant — buildCompleteness", () => {
  it("all five domains EVALUATED → overallComplete: true", () => {
    const result = buildCompleteness({
      structural: domain(EVALUATED),
      constraint: domain(EVALUATED),
      boundary: domain(EVALUATED),
      decision: domain(EVALUATED),
      governance: domain(EVALUATED),
    });
    expect(result.overallComplete).toBe(true);
    expect(result.overallStatus).toBe(EVALUATED);
  });

  it("only structural EVALUATED → overallComplete: false (missing domains default NOT_EVALUATED)", () => {
    const result = buildCompleteness({ structural: domain(EVALUATED) });
    expect(result.overallComplete).toBe(false);
    expect(result.overallStatus).toBe(NOT_EVALUATED);
  });
});

// ---------------------------------------------------------------------------
// 2. Round-trip invariant (Gap B)
// ---------------------------------------------------------------------------

describe("round-trip invariant — evaluateArchitectureState", () => {
  it("with config → structural, constraint, boundary, decision all EVALUATED", () => {
    const result = evaluateArchitectureState({
      graph: minimalGraph("test"),
      config: { depConstraints: [] },
      projectName: "test",
    });
    const { domains } = result.completeness;
    expect(domains.structural.status).toBe(EVALUATED);
    expect(domains.constraint.status).toBe(EVALUATED);
    expect(domains.boundary.status).toBe(EVALUATED);
    expect(domains.decision.status).toBe(EVALUATED);
  });

  it("without config → constraint, boundary, decision NOT_EVALUATED", () => {
    const result = evaluateArchitectureState({
      graph: minimalGraph("test"),
      config: null,
      projectName: "test",
    });
    const { domains } = result.completeness;
    expect(domains.constraint.status).toBe(NOT_EVALUATED);
    expect(domains.boundary.status).toBe(NOT_EVALUATED);
    expect(domains.decision.status).toBe(NOT_EVALUATED);
  });
});

// ---------------------------------------------------------------------------
// 3. Completeness conservation (Gap A + C)
// ---------------------------------------------------------------------------

describe("completeness conservation — buildScenarioCompleteness", () => {
  it("all complete → overallComplete: true", () => {
    const result = buildScenarioCompleteness({
      changesComplete: true,
      baseAttributed: true,
      governance: { domain: domain(EVALUATED) },
    });
    expect(result.overallComplete).toBe(true);
  });

  it("changesComplete: false → overallComplete: false (refused changes never complete)", () => {
    const result = buildScenarioCompleteness({ changesComplete: false });
    expect(result.overallComplete).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Evidence conservation (Gap D)
// ---------------------------------------------------------------------------

describe("evidence conservation — evaluateScenario", () => {
  const projectName = "evidence-test";
  const graph = minimalGraph(projectName);
  const commandContext = { root: "/tmp/dummy-archkeep-scenario", graph };

  it("evidenceChain always contains baseRevision and appliedChanges", () => {
    const result = evaluateScenario(projectName, commandContext, {
      base: "test-revision",
      changes: [],
    });
    expect(result.evidenceChain).toBeDefined();
    expect(result.evidenceChain).toHaveProperty("baseRevision");
    expect(result.evidenceChain).toHaveProperty("appliedChanges");
  });
  it("delta contains both old and new fields", () => {
    const result = evaluateScenario(projectName, commandContext, {
      base: "test-revision",
      changes: [],
    });
    const d = result.delta;
    // Old fields (pre-refactor)
    expect(d).toHaveProperty("dependentsAdded");
    expect(d).toHaveProperty("dependentsRemoved");
    expect(d).toHaveProperty("constraintsChanged");
    expect(d).toHaveProperty("decisionsChanged");
    // New fields (post-refactor)
    expect(d).toHaveProperty("structuralDelta");
    expect(d.structuralDelta).toHaveProperty("dependentsAdded");
    expect(d.structuralDelta).toHaveProperty("dependentsRemoved");
    expect(d).toHaveProperty("governanceDelta");
    expect(d.governanceDelta).toHaveProperty("findingsChanged");
    expect(d.governanceDelta).toHaveProperty("debtChanged");
    expect(d).toHaveProperty("evidenceDelta");
    expect(d.evidenceDelta).toHaveProperty("baseRevision");
    expect(d.evidenceDelta).toHaveProperty("changesApplied");
    expect(d.evidenceDelta).toHaveProperty("changesRefused");
  });
});

// ---------------------------------------------------------------------------
// 5. Refusal isolation (Gap C)
// ---------------------------------------------------------------------------

describe("refusal isolation — evaluateScenario", () => {
  const projectName = "refusal-test";
  const graph = minimalGraph(projectName);
  const commandContext = { root: "/tmp/dummy-archkeep-scenario", graph };

  it("refused changes → complete: false AND scenarioDomains.changes.status === partial", () => {
    const result = evaluateScenario(projectName, commandContext, {
      base: "test-revision",
      changes: [{ type: "unsupported_change" }],
    });
    expect(result.complete).toBe(false);
    expect(result.completeness.scenarioDomains.changes.status).toBe(PARTIAL);
  });

  it("no refused changes → complete: true AND scenarioDomains.changes.status === evaluated", () => {
    const result = evaluateScenario(projectName, commandContext, {
      base: "test-revision",
      changes: [],
    });
    expect(result.complete).toBe(true);
    expect(result.completeness.scenarioDomains.changes.status).toBe(EVALUATED);
  });
});

// ---------------------------------------------------------------------------
// 6. Governance not-evaluated semantics (Gap C)
// ---------------------------------------------------------------------------

describe("governance not-evaluated semantics — buildGovernanceCompleteness", () => {
  it("both NOT_EVALUATED → domain.status === not_evaluated", () => {
    const result = buildGovernanceCompleteness({
      findingsStatus: NOT_EVALUATED,
      debtStatus: NOT_EVALUATED,
    });
    expect(result.domain.status).toBe(NOT_EVALUATED);
  });

  it("findings EVALUATED, debt NOT_EVALUATED → domain.status === not_evaluated (debt is worst)", () => {
    const result = buildGovernanceCompleteness({
      findingsStatus: EVALUATED,
      debtStatus: NOT_EVALUATED,
    });
    expect(result.domain.status).toBe(NOT_EVALUATED);
  });

  it("both EVALUATED → domain.status === evaluated", () => {
    const result = buildGovernanceCompleteness({
      findingsStatus: EVALUATED,
      debtStatus: EVALUATED,
    });
    expect(result.domain.status).toBe(EVALUATED);
  });
});

// ---------------------------------------------------------------------------
// 7. MCP doc parity
// ---------------------------------------------------------------------------

describe("MCP doc parity", () => {
  it("docs/integrations/mcp.md contains archkeep_scenario", () => {
    const text = readFileSync(
      fixturePath("..", "..", "..", "..", "docs", "integrations", "mcp.md"),
      "utf8",
    );
    expect(text).toContain("archkeep_scenario");
  });

  it("packages/archkeep-mcp/README.md contains archkeep_scenario", () => {
    const text = readFileSync(
      fixturePath("..", "..", "..", "..", "packages", "archkeep-mcp", "README.md"),
      "utf8",
    );
    expect(text).toContain("archkeep_scenario");
  });
});
