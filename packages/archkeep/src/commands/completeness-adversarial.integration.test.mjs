/**
 * Adversarial invariants for the completeness model — no-op, round-trip,
 * conservation, evidence chain, refusal isolation, governance semantics,
 * and MCP doc parity.
 *
 * Every test exercises the silent direction: an empty/partial result must
 * differ observably from a complete one.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  buildCompleteness,
  buildEvidenceComplete,
  buildScenarioCompleteness,
  buildGovernanceCompleteness,
  createDomain,
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
  return createDomain(status);
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
  it("all eight domains EVALUATED but no evidenceComplete → overallComplete: false", () => {
    const result = buildCompleteness({
      structural: domain(EVALUATED),
      constraint: domain(EVALUATED),
      boundary: domain(EVALUATED),
      decision: domain(EVALUATED),
      findings: domain(EVALUATED),
      debt: domain(EVALUATED),
      governance: domain(EVALUATED),
      evidence: domain(EVALUATED),
    });
    // Without evidenceComplete, overallComplete MUST be false — the evaluation
    // has not proven its evidence gates.
    expect(result.overallComplete).toBe(false);
    expect(result.overallStatus).toBe(NOT_EVALUATED);
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
// 3. Evidence-Complete gates derived from decision facts (S4/E2)
// ---------------------------------------------------------------------------

/**
 * Frontmatter + body for one ADR record file.
 *
 * @param {string} frontmatter The strict `key: value` block, no `---` fences.
 * @returns {string}
 */
function adrFile(frontmatter) {
  return `---\n${frontmatter}\n---\n\n# Decision\n\nBody prose.\n`;
}

const adrRoots = [];

/**
 * A throwaway workspace root holding the given ADR records.
 *
 * @param {Record<string, string>} files ADR id → frontmatter text.
 * @returns {string} The workspace root (also registered for cleanup).
 */
function adrRoot(files) {
  const dir = mkdtempSync(join(tmpdir(), "archkeep-ec-"));
  mkdirSync(join(dir, "docs", "adr"), { recursive: true });
  for (const [id, frontmatter] of Object.entries(files)) {
    writeFileSync(join(dir, "docs", "adr", `${id}.md`), adrFile(frontmatter));
  }
  adrRoots.push(dir);
  return dir;
}

/**
 * The same tree, with the records committed to real git — so the decision's
 * provenance attestation (`git log` attribution) can answer.
 *
 * @param {Record<string, string>} files ADR id → frontmatter text.
 * @returns {string} The workspace root.
 */
function gitAdrRoot(files) {
  const dir = adrRoot(files);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "docs/adr"], { cwd: dir });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Archkeep Certification",
      "-c",
      "user.email=cert@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "record decisions",
    ],
    { cwd: dir },
  );
  return dir;
}

afterAll(() => {
  for (const dir of adrRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Evidence-Complete gates derived from decision facts", () => {
  // beta (layer:app) depends on alpha (layer:domain); the constraint row that
  // governs the edge carries the decisionRef, so the binding is causally real —
  // the row is AFFECTED by the evaluation, not merely present in the config.
  function dependentGraph() {
    return {
      nodes: {
        alpha: { name: "alpha", type: "lib", data: { root: "libs/alpha", tags: ["layer:domain"] } },
        beta: { name: "beta", type: "lib", data: { root: "libs/beta", tags: ["layer:app"] } },
      },
      dependencies: { beta: [{ target: "alpha", type: "static" }] },
    };
  }

  const boundLaw = {
    depConstraints: [
      {
        sourceTag: "layer:app",
        onlyDependOnLibsWithTags: ["layer:domain", "layer:app"],
        decisionRef: "0001-layers",
      },
    ],
  };

  // Non-empty governance inputs, so the findings and debt domains evaluate.
  const governanceInputs = {
    findings: [{ project: "alpha", rule: "certification-probe" }],
    debt: [{ project: "alpha", id: "debt-probe" }],
  };

  it("e8 — an attested, authoritative decision binding reaches overallComplete", () => {
    const root = gitAdrRoot({ "0001-layers": "id: 0001-layers\nstatus: accepted" });
    const result = evaluateArchitectureState({
      graph: dependentGraph(),
      config: boundLaw,
      projectName: "alpha",
      root,
      ...governanceInputs,
    });
    // Every required gate passes — provenanceCoverage included.
    expect(result.evidenceComplete.overallComplete).toBe(true);
    expect(result.completeness.evidenceComplete.gates.provenanceCoverage.value).toBe(1);
    expect(result.completeness.evidenceComplete.gates.provenanceCoverage.pass).toBe(true);
    expect(result.completeness.overallComplete).toBe(true);
    // The row carries the attested provenance the gate answered from.
    expect(result.decisionImpact.decisions).toHaveLength(1);
    expect(result.decisionImpact.decisions[0].hasAuthority).toBe(true);
    expect(result.decisionImpact.decisions[0].provenance.attested).toBe(true);
  });

  it("a decision record without authority fails the canonical gate loudly", () => {
    const root = adrRoot({ "0001-layers": "id: 0001-layers\nstatus: proposed" });
    const result = evaluateArchitectureState({
      graph: dependentGraph(),
      config: boundLaw,
      projectName: "alpha",
      root,
    });
    const gate = result.completeness.evidenceComplete.gates.provenanceCoverage;
    expect(gate.value).toBe(0);
    expect(gate.pass).toBe(false);
    // The row stays visible with its missing authority, so a reader can see why.
    expect(result.decisionImpact.decisions[0].hasAuthority).toBe(false);
  });

  it("a decisionRef that resolves to nothing is reported, never covered", () => {
    const root = adrRoot({ "0001-layers": "id: 0001-layers\nstatus: accepted" });
    const result = evaluateArchitectureState({
      graph: dependentGraph(),
      config: {
        depConstraints: [
          {
            sourceTag: "layer:app",
            onlyDependOnLibsWithTags: ["layer:domain", "layer:app"],
            decisionRef: "0042-ghost",
          },
        ],
      },
      projectName: "alpha",
      root,
    });
    expect(result.decisionImpact.decisions).toEqual([]);
    expect(result.decisionImpact.unresolvedDecisionRefs).toContain("0042-ghost");
    const gate = result.completeness.evidenceComplete.gates.provenanceCoverage;
    expect(gate.value).toBe(0);
    expect(gate.pass).toBe(false);
  });

  it("a fitness ref the registry binds counts as covered provenance", () => {
    const root = adrRoot({
      "0001-layers": "id: 0001-layers\nstatus: accepted\nbindings:\n  - cycle-free",
    });
    const result = evaluateArchitectureState({
      graph: dependentGraph(),
      config: {
        depConstraints: [
          {
            sourceTag: "layer:app",
            onlyDependOnLibsWithTags: ["layer:domain", "layer:app"],
            decisionRef: "fitness:cycle-free",
          },
        ],
      },
      projectName: "alpha",
      root,
    });
    expect(result.decisionImpact.decisions[0].kind).toBe("fitness");
    expect(result.decisionImpact.decisions[0].resolution).toBe("known");
    const gate = result.completeness.evidenceComplete.gates.provenanceCoverage;
    expect(gate.value).toBe(1);
    expect(gate.pass).toBe(true);
  });

  it("scenario face — a record without authority fails provenance coverage, not a presence boolean", () => {
    const root = adrRoot({ "0001-layers": "id: 0001-layers\nstatus: proposed" });
    const result = evaluateScenario(
      "alpha",
      { root, graph: dependentGraph() },
      { base: "test-revision", changes: [] },
      boundLaw,
    );
    expect(result.completeness.evidenceComplete.gates.provenanceCoverage.value).toBe(0);
    expect(result.completeness.evidenceComplete.gates.provenanceCoverage.pass).toBe(false);
  });

  it("scenario face — an authoritative binding keeps coverage at 1 (authority, not git, decides)", () => {
    // Non-git root on purpose: attestation is unavailable here, and the gate
    // must still count the authoritative record. If this ever required git,
    // every non-git workspace's evaluation would silently lose the gate.
    const root = adrRoot({ "0001-layers": "id: 0001-layers\nstatus: accepted" });
    const result = evaluateScenario(
      "alpha",
      { root, graph: dependentGraph() },
      { base: "test-revision", changes: [] },
      boundLaw,
    );
    expect(result.completeness.evidenceComplete.gates.provenanceCoverage.value).toBe(1);
    expect(result.current.decisionImpact.decisions[0].hasAuthority).toBe(true);
    expect(result.current.decisionImpact.decisions[0].provenance.attested).toBe(false);
  });

  it("a scenario without a config discloses why constraint, boundary and decision are NOT_EVALUATED", () => {
    const root = mkdtempSync(join(tmpdir(), "archkeep-ec-noconfig-"));
    adrRoots.push(root);
    const result = evaluateScenario(
      "alpha",
      { root, graph: dependentGraph() },
      { base: "test-revision", changes: [] },
      null,
    );
    for (const name of ["constraint", "boundary", "decision"]) {
      expect(result.completeness.domains[name].status).toBe(NOT_EVALUATED);
      expect(result.completeness.domains[name].note.length).toBeGreaterThan(0);
    }
  });

  it("false-complete direction — domains claiming complete with failing gates are counted", () => {
    const failing = buildEvidenceComplete({
      domainCoverage: 1,
      claimEvidenceCoverage: 1,
      causalCoverage: 1,
      provenanceCoverage: 0,
      mutationCoverage: 1,
      surfaceParity: 1,
      hiddenGapCount: 0,
      falseCompleteCount: 0,
      baseIdentityValid: true,
      deterministic: true,
      contractType: "canonical",
    });
    const result = buildCompleteness({
      structural: domain(EVALUATED),
      constraint: domain(EVALUATED),
      boundary: domain(EVALUATED),
      decision: domain(EVALUATED),
      findings: domain(EVALUATED),
      debt: domain(EVALUATED),
      governance: domain(EVALUATED),
      evidence: domain(EVALUATED),
      evidenceComplete: failing,
    });
    expect(result.overallComplete).toBe(false);
    expect(result.falseCompleteCount).toBe(1);
    expect(result.evidenceComplete.falseCompleteCount).toBe(1);
  });

  it("the canonical evaluation is deterministic — two runs, byte-identical output", () => {
    const root = adrRoot({ "0001-layers": "id: 0001-layers\nstatus: accepted" });
    const run = () =>
      JSON.stringify(
        evaluateArchitectureState({
          graph: dependentGraph(),
          config: boundLaw,
          projectName: "alpha",
          root,
          ...governanceInputs,
        }),
      );
    expect(run()).toBe(run());
  });

  it("the scenario evaluation is deterministic — two runs, byte-identical output", () => {
    const root = adrRoot({ "0001-layers": "id: 0001-layers\nstatus: accepted" });
    const run = () =>
      JSON.stringify(
        evaluateScenario(
          "alpha",
          { root, graph: dependentGraph() },
          { base: "test-revision", changes: [] },
          boundLaw,
        ),
      );
    expect(run()).toBe(run());
  });
});

// ---------------------------------------------------------------------------
describe("completeness conservation — buildScenarioCompleteness", () => {
  it("all complete with evidenceComplete → overallComplete: true", () => {
    const governance = buildGovernanceCompleteness({
      findingsStatus: EVALUATED,
      debtStatus: EVALUATED,
    });
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
      contractType: "canonical",
    });
    const result = buildScenarioCompleteness({
      changesComplete: true,
      baseIdentityVerified: true,
      mutationCoverageComplete: true,
      governance,
      evidenceComplete: ec,
      domains: {
        structural: domain(EVALUATED),
        constraint: domain(EVALUATED),
        boundary: domain(EVALUATED),
        decision: domain(EVALUATED),
        findings: domain(EVALUATED),
        debt: domain(EVALUATED),
        governance: domain(EVALUATED),
        evidence: domain(EVALUATED),
      },
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
    /** @type {any} */
    const badChange = { type: "unsupported_change" };
    const result = evaluateScenario(projectName, commandContext, {
      base: "test-revision",
      changes: [badChange],
    });
    expect(result.complete).toBe(false);
    expect(result.completeness.scenarioDomains.changes.status).toBe(PARTIAL);
  });

  it("no refused changes → complete: false (no config/evidence gates) AND scenarioDomains.changes.status === evaluated", () => {
    const result = evaluateScenario(projectName, commandContext, {
      base: "test-revision",
      changes: [],
    });
    // Without config/evidence gates, overallComplete is false.
    // But mutation coverage (all changes applied) is complete.
    expect(result.complete).toBe(false);
    expect(result.completeness.scenarioDomains.changes.status).toBe(EVALUATED);
    expect(result.completeness.scenarioDomains.mutationCoverage.status).toBe(EVALUATED);
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
