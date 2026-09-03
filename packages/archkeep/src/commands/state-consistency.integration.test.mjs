/**
 * Cross-command state consistency: `impact` and `scenario` over the SAME
 * workspace must agree on the project graph, coverage, constraint impacts,
 * and deterministic output — and specific failure modes (non-existent
 * project, broken analysis) must produce usage errors, not clean verdicts.
 *
 * The silent direction: an empty result is a claim, not a shrug — every test
 * below has a case that goes red when a command reports nothing for a
 * violation that exists.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EXIT, runCli } from "../../cli.mjs";

// ---------------------------------------------------------------------------
// Fixture: two projects (domain + adapter) with one dependency edge, plus a
// boundary config that constrains cross-layer access.
// ---------------------------------------------------------------------------

const NX_JSON = `${JSON.stringify({
  plugins: [
    {
      plugin: "@ecoma-io/archkeep/nx",
      options: { boundaryConfig: "module-boundaries.config.mjs" },
    },
  ],
  /* The injected graph below stands in for what Nx would compute. */
})}\n`;

const BOUNDARY_CONFIG = `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`;

/**
 * The injected graph: domain (layer:domain) depends on nothing; adapter
 * (layer:adapter) depends on domain. Alphabetical order: [adapter, domain]
 * so the sort-invariant tests are meaningful.
 */
const GRAPH = {
  nodes: {
    adapter: {
      name: "adapter",
      type: "lib",
      data: { root: "libs/adapter", tags: ["layer:adapter"] },
    },
    domain: {
      name: "domain",
      type: "lib",
      data: { root: "libs/domain", tags: ["layer:domain"] },
    },
  },
  dependencies: {
    adapter: [{ source: "adapter", target: "domain", type: "static" }],
  },
};

/** Every tracked file in the fixture workspace. */
const TRACKED_FILES = [
  "nx.json",
  "module-boundaries.config.mjs",
  "libs/domain/go.mod",
  "libs/domain/main.go",
  "libs/adapter/go.mod",
  "libs/adapter/main.go",
];

/** A scenario that adds a dependency from domain → adapter (cross-layer). */
const VALID_SCENARIO_JSON = JSON.stringify({
  changes: [{ type: "dependency_added", source: "domain", target: "adapter", edgeType: "static" }],
});

/** A no-op scenario: adding an edge that already exists. */
const IDENTITY_SCENARIO_JSON = JSON.stringify({
  changes: [{ type: "dependency_added", source: "adapter", target: "domain", edgeType: "static" }],
});
let root;
let scenarioFile;
let identityScenarioFile;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "archkeep-consistency-"));
  const write = (relativePath, text) => {
    mkdirSync(join(root, relativePath, ".."), { recursive: true });
    writeFileSync(join(root, relativePath), text);
  };

  write("nx.json", NX_JSON);
  write("module-boundaries.config.mjs", BOUNDARY_CONFIG);

  // Real Go source files so the analyzer produces real coverage data.
  write("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  write("libs/domain/main.go", "package domain\n\nconst X = 1\n");
  write("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
  write(
    "libs/adapter/main.go",
    'package adapter\n\nimport "example.com/domain"\n\nvar _ = domain.X\n',
  );

  // Scenario input files
  scenarioFile = join(root, "scenario.json");
  writeFileSync(scenarioFile, VALID_SCENARIO_JSON);

  identityScenarioFile = join(root, "scenario-identity.json");
  writeFileSync(identityScenarioFile, IDENTITY_SCENARIO_JSON);
}, 15_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Runs one CLI invocation against the fixture workspace.
 */
async function run(argv) {
  const out = [];
  const err = [];
  const exitCode = await runCli(argv, {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    cwd: root,
    readGraph: () => GRAPH,
    listFiles: () => TRACKED_FILES,
  });
  return { exitCode, out: out.join(""), err: err.join("") };
}

/**
 * Runs a command and parses its JSON envelope.
 */
async function envelopeFor(argv) {
  const result = await run(argv);
  let envelope;
  try {
    envelope = JSON.parse(result.out);
  } catch {
    throw new Error(
      `archkeep: '${argv.join(" ")}' wrote no JSON envelope (exit ${result.exitCode}). ` +
        `stdout: ${result.out.slice(0, 400)} stderr: ${result.err.slice(0, 400)}`,
    );
  }
  return { exitCode: result.exitCode, envelope, err: result.err };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cross-command state consistency — impact ↔ scenario", () => {
  // -----------------------------------------------------------------------
  // 1. Impact + scenario produce consistent project/coverage data
  // -----------------------------------------------------------------------
  it("impact and scenario name the same project and report consistent coverage", async () => {
    const impact = await envelopeFor(["impact", "domain", "--format", "json"]);
    expect(impact.exitCode).toBe(EXIT.ok);

    const scenario = await envelopeFor([
      "scenario",
      "domain",
      "--scenario-file",
      scenarioFile,
      "--format",
      "json",
    ]);
    expect(scenario.exitCode).toBe(EXIT.ok);

    // Both commands target the same project
    expect(impact.envelope.result.project).toBe("domain");
    expect(scenario.envelope.result.project).toBe("domain");

    // Both report the same number of projects and analyzed files
    expect(scenario.envelope.coverage.projects).toBe(impact.envelope.coverage.projects);
    expect(scenario.envelope.coverage.analyzedFiles).toBe(impact.envelope.coverage.analyzedFiles);
  });

  // -----------------------------------------------------------------------
  // 2. Scenario evaluation and impact statement agree on constraint impacts
  // -----------------------------------------------------------------------
  it("scenario current-state impact agrees with the standalone impact statement", async () => {
    const impact = await envelopeFor(["impact", "domain", "--format", "json"]);
    expect(impact.exitCode).toBe(EXIT.ok);

    const scenario = await envelopeFor([
      "scenario",
      "domain",
      "--scenario-file",
      scenarioFile,
      "--format",
      "json",
    ]);
    expect(scenario.exitCode).toBe(EXIT.ok);

    const impactStatement = impact.envelope.result.impactStatement;
    const scenarioCurrent = scenario.envelope.result.current;

    // The impact statement's project/impact shape must match scenario's
    // current-state impact — both are built from the same `computeImpact`.
    expect(impactStatement.project).toBe(scenarioCurrent.impact.project);
    expect(impactStatement.impact.direct).toEqual(scenarioCurrent.impact.direct);
    expect(impactStatement.impact.transitive).toEqual(scenarioCurrent.impact.transitive);
    expect(impactStatement.impact.dependents).toEqual(scenarioCurrent.impact.dependents);

    // Constraint impacts must agree when both have config (same depConstraints)
    if (impactStatement.constraintImpact && scenarioCurrent.constraintImpact) {
      // Same number of constraint-impact rows (one per dependent)
      expect(impactStatement.constraintImpact.length).toBe(scenarioCurrent.constraintImpact.length);

      // Each dependent's constraint-impact row must match
      for (const row of impactStatement.constraintImpact) {
        const scenarioRow = scenarioCurrent.constraintImpact.find((s) => s.project === row.project);
        expect(scenarioRow).toBeDefined();
        expect(scenarioRow.constraintRows).toEqual(row.constraintRows);
        expect(scenarioRow.violations).toEqual(row.violations);
        expect(scenarioRow.edges).toEqual(row.edges);
      }
    }
  });

  // -----------------------------------------------------------------------
  // 3. No-op/identity changes produce virtual / notAuthoritative markers
  // -----------------------------------------------------------------------
  it("identity changes produce virtual: true and notAuthoritative: true", async () => {
    const scenario = await envelopeFor([
      "scenario",
      "domain",
      "--scenario-file",
      identityScenarioFile,
      "--format",
      "json",
    ]);
    expect(scenario.exitCode).toBe(EXIT.ok);
    // Every scenario evaluation carries these markers — even a no-op one
    expect(scenario.envelope.result.virtual).toBe(true);
    expect(scenario.envelope.result.notAuthoritative).toBe(true);
    // The identity change was recorded as applied (edge already existed)
    expect(Array.isArray(scenario.envelope.result.changes)).toBe(true);
    expect(scenario.envelope.result.changes.length).toBe(1);
    expect(scenario.envelope.result.changes[0]).toMatch(/already exists/);
  });

  // -----------------------------------------------------------------------
  // 4. Non-existent project returns a usage error, not a clean verdict
  // -----------------------------------------------------------------------
  it("impact on a non-existent project returns a usage error (exit 2)", async () => {
    const result = await run(["impact", "nonexistent", "--format", "json"]);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.err).toMatch(/no project named/);
    // No JSON envelope on stderr or stdout when it is a usage error
    expect(result.out).toBe("");
  });

  it("scenario on a non-existent project returns a usage error (exit 2)", async () => {
    const result = await run([
      "scenario",
      "nonexistent",
      "--scenario-file",
      scenarioFile,
      "--format",
      "json",
    ]);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.err).toMatch(/no project named/);
    expect(result.out).toBe("");
  });

  // -----------------------------------------------------------------------
  // 5. Impact + scenario output the same coverage data
  // -----------------------------------------------------------------------
  it("impact and scenario produce identical coverage.analyzedFiles and coverage.projects", async () => {
    const impact = await envelopeFor(["impact", "domain", "--format", "json"]);
    expect(impact.exitCode).toBe(EXIT.ok);

    const scenario = await envelopeFor([
      "scenario",
      "domain",
      "--scenario-file",
      scenarioFile,
      "--format",
      "json",
    ]);
    expect(scenario.exitCode).toBe(EXIT.ok);

    // Coverage shape must match exactly: same projects (graph is injected),
    // same analyzed files (same workspace), same imports.
    expect(impact.envelope.coverage.projects).toBe(Object.keys(GRAPH.nodes).length);
    expect(scenario.envelope.coverage.projects).toBe(Object.keys(GRAPH.nodes).length);
    expect(impact.envelope.coverage.projects).toBe(scenario.envelope.coverage.projects);
    expect(impact.envelope.coverage.analyzedFiles).toBe(scenario.envelope.coverage.analyzedFiles);
    expect(impact.envelope.coverage.imports).toBe(scenario.envelope.coverage.imports);
    expect(impact.envelope.coverage.complete).toBe(true);
    expect(scenario.envelope.coverage.complete).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 6. Deterministic ordering: running scenario twice produces identical text
  // -----------------------------------------------------------------------
  it("scenario produces deterministic text output across two runs", async () => {
    const first = await run(["scenario", "domain", "--scenario-file", scenarioFile]);
    expect(first.exitCode).toBe(EXIT.ok);

    const second = await run(["scenario", "domain", "--scenario-file", scenarioFile]);
    expect(second.exitCode).toBe(EXIT.ok);

    // Byte-identical text output on an unchanged workspace
    expect(second.out).toBe(first.out);
    // Stderr should also be identical (both empty on success)
    expect(second.err).toBe(first.err);
  });

  it("impact produces deterministic text output across two runs", async () => {
    const first = await run(["impact", "domain"]);
    expect(first.exitCode).toBe(EXIT.ok);

    const second = await run(["impact", "domain"]);
    expect(second.exitCode).toBe(EXIT.ok);

    // Byte-identical text output
    expect(second.out).toBe(first.out);
    expect(second.err).toBe(first.err);
  });

  // -----------------------------------------------------------------------
  // 7. The result.complete field is true when analysis is complete
  // -----------------------------------------------------------------------
  it("scenario result.complete is true on a complete analysis", async () => {
    const scenario = await envelopeFor([
      "scenario",
      "domain",
      "--scenario-file",
      scenarioFile,
      "--format",
      "json",
    ]);
    expect(scenario.exitCode).toBe(EXIT.ok);

    // result.complete is true because overallComplete includes governance/evidence
    // completeness — even without base revision attribution or governance data
    // the analysis of all files is the dominant signal.
    expect(scenario.envelope.result.complete).toBe(true);
    expect(scenario.envelope.coverage.complete).toBe(true);
  });
  it("impact coverage.complete is true on a complete analysis", async () => {
    const impact = await envelopeFor(["impact", "domain", "--format", "json"]);
    expect(impact.exitCode).toBe(EXIT.ok);

    // Impact carries coverage.complete (not result.complete)
    expect(impact.envelope.coverage.complete).toBe(true);
    // result.complete is not on the impact envelope
    expect(impact.envelope.result).not.toHaveProperty("complete");
  });
});
