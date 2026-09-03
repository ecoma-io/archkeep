import { describe, expect, it } from "vitest";

import { scenarioCommand } from "./scenario.mjs";

/**
 * What the `scenario` wrapper itself guarantees, beside `scenario-evaluation`
 * tests that own the evaluation: the JSON envelope is built through
 * `jsonEnvelope` with the command's own coverage facts — complete over the
 * analyzed graph, the two disclosures (virtual/not-authoritative and the
 * depConstraints-only narrowing) present in `coverage.notes` — and an
 * incomplete-coverage workspace is refused rather than silently evaluated.
 *
 * These are direct unit pins because the integration suites can only see the
 * spawned envelope: a regression that dropped `coverage.notes` or built the
 * envelope by hand would survive them (C10).
 */

/** A minimal two-project graph, the shape `resolveCommandContext` produces. */
function graph() {
  return {
    nodes: {
      alpha: { name: "alpha", type: "lib", data: { root: "libs/alpha", tags: [] } },
      beta: { name: "beta", type: "lib", data: { root: "libs/beta", tags: [] } },
    },
    dependencies: { alpha: [], beta: [] },
  };
}

function commandContext(overrides = {}) {
  return {
    root: "/fake/root",
    provider: "native",
    marker: "nx.json",
    graph: graph(),
    analysis: {
      analyzed: 4,
      imports: [{ sourceFile: "libs/alpha/a.ts", line: 1, column: 1 }],
      failures: [],
    },
    ...overrides,
  };
}

const scenarioJson = JSON.stringify({
  changes: [{ type: "dependency_added", source: "alpha", target: "beta", edgeType: "static" }],
});

describe("scenarioCommand — envelope construction", () => {
  it("builds the JSON envelope through jsonEnvelope with the run's coverage", () => {
    const result = scenarioCommand("alpha", scenarioJson, commandContext());

    expect(result.status).toBe("ok");
    const envelope = JSON.parse(result.report.json);
    expect(envelope.command).toBe("scenario");
    expect(envelope.status).toBe("ok");
    expect(envelope.exitCode).toBe(0);
    // The wrapper's own coverage accounting, threaded from the command
    // context — not a stub the evaluation computed.
    expect(envelope.coverage.complete).toBe(true);
    expect(envelope.coverage.projects).toBe(2);
    expect(envelope.coverage.analyzedFiles).toBe(4);
    expect(envelope.coverage.imports).toBe(1);
    expect(envelope.coverage.notAnalyzed).toEqual([]);
    // The workspace facts ride the same envelope every command builds.
    expect(envelope.workspace.root).toBe("/fake/root");
    expect(envelope.workspace.provider).toBe("native");
  });

  it("carries the virtual, not-authoritative result through the envelope", () => {
    const result = scenarioCommand("alpha", scenarioJson, commandContext());
    const envelope = JSON.parse(result.report.json);
    // A scenario is a hypothetical, machine-distinguishable on every field
    // the wrapper copies from the evaluation.
    expect(envelope.result.virtual).toBe(true);
    expect(envelope.result.notAuthoritative).toBe(true);
    expect(envelope.result.project).toBe("alpha");
    expect(result.scenario.virtual).toBe(true);
    expect(result.scenario.notAuthoritative).toBe(true);
  });

  it("discloses the virtual scope and the depConstraints narrowing in coverage.notes", () => {
    const result = scenarioCommand("alpha", scenarioJson, commandContext());
    // Both notes, each naming what it discloses — a note list that lost one
    // (or the narrowing's "run check" pointer) fails here, not only in a
    // spawned integration envelope.
    expect(result.coverage.notes).toHaveLength(2);
    expect(result.coverage.notes[0]).toContain("virtual");
    expect(result.coverage.notes[0]).toContain("not authoritative");
    expect(result.coverage.notes[0]).toContain("check");
    expect(result.coverage.notes[1]).toContain("depConstraints");
    // The envelope carries the same list the wrapper returns.
    const envelope = JSON.parse(result.report.json);
    expect(envelope.coverage.notes).toEqual(result.coverage.notes);
  });

  it("maps site-level analysis failures to coverage blind spots, not refusals", () => {
    const context = commandContext({
      analysis: {
        analyzed: 4,
        imports: [],
        failures: [
          {
            sourceFile: "libs/alpha/partial.ts",
            line: 3,
            column: 7,
            reason: "unresolvable specifier",
          },
        ],
      },
    });
    const result = scenarioCommand("alpha", scenarioJson, context);
    expect(result.coverage.blindSpots).toEqual([
      { file: "libs/alpha/partial.ts", line: 3, column: 7, reason: "unresolvable specifier" },
    ]);
    // A blind spot is disclosed, not fatal: the scenario still evaluates.
    expect(result.status).toBe("ok");
    expect(result.coverage.complete).toBe(true);
  });

  it("renders the text report for the scenario it evaluated", () => {
    const result = scenarioCommand("alpha", scenarioJson, commandContext());
    expect(result.report.text).toContain('Scenario evaluation for "alpha"');
    expect(result.report.text).toContain("Virtual: true");
    expect(result.report.text).toContain("Not authoritative: true");
  });

  it("reports refused changes in the result while the run stays ok", () => {
    const refused = JSON.stringify({
      changes: [{ type: "dependency_added", source: "alpha", target: "ghost", edgeType: "static" }],
    });
    const result = scenarioCommand("alpha", refused, commandContext());
    expect(result.status).toBe("ok");
    expect(result.scenario.refused).toHaveLength(1);
    expect(result.scenario.refused[0]).toContain('target project "ghost" not in graph');
    const envelope = JSON.parse(result.report.json);
    expect(envelope.result.refused).toEqual(result.scenario.refused);
  });
});

describe("scenarioCommand — incomplete coverage is refused, not evaluated", () => {
  it("throws when a whole file could not be analyzed", () => {
    const context = commandContext({
      analysis: {
        analyzed: 4,
        imports: [],
        failures: [{ sourceFile: "libs/beta/broken.go", line: null, reason: "unreadable" }],
      },
    });
    expect(() => scenarioCommand("alpha", scenarioJson, context)).toThrow(
      /incomplete coverage — 1 file could not be analyzed/,
    );
  });

  it("refuses for an Nx workspace with unregistered polyglot manifests", () => {
    const context = commandContext({
      provider: "nx",
      pluginGap: { registered: false, manifests: ["libs/beta/go.mod"] },
    });
    expect(() => scenarioCommand("alpha", scenarioJson, context)).toThrow(
      /refusing to evaluate a scenario for an Nx workspace/,
    );
  });
});
