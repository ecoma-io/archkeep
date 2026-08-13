import { describe, expect, it } from "vitest";

import { formatImpactReport } from "./impact-text.mjs";

/**
 * What the impact report guarantees: the target project is named, every
 * dependent is listed, and the summary line carries direct/transitive counts
 * so an empty result is distinguishable from a missing one.
 */

describe("formatImpactReport", () => {
  it("lists the target project and its dependents with a summary line", () => {
    const report = formatImpactReport({
      impact: {
        project: "billing-core",
        direct: ["checkout-api"],
        transitive: ["payment-worker"],
        dependents: ["checkout-api", "payment-worker"],
      },
      coverage: { complete: true, imports: 3, analyzedFiles: 5, projects: 4 },
    });
    expect(report).toContain("Impact of billing-core");
    expect(report).toContain("checkout-api");
    expect(report).toContain("payment-worker");
    expect(report).toContain("2 projects depend on billing-core (direct: 1, transitive: 1)");
  });

  it("states 'impact complete' when coverage is complete", () => {
    const report = formatImpactReport({
      impact: {
        project: "alpha",
        direct: [],
        transitive: [],
        dependents: [],
      },
      coverage: { complete: true, imports: 0, analyzedFiles: 0, projects: 1 },
    });
    expect(report).toContain("impact complete");
    expect(report).toContain("0 imports in 0 files across 1 project");
  });

  it("states 'impact incomplete' when coverage is not complete", () => {
    const report = formatImpactReport({
      impact: {
        project: "alpha",
        direct: [],
        transitive: [],
        dependents: [],
      },
      coverage: {
        complete: false,
        notAnalyzed: [{ file: "x.go", reason: "err" }],
        imports: 0,
        analyzedFiles: 0,
        projects: 1,
      },
    });
    expect(report).toContain("impact incomplete");
    expect(report).toContain("1 file could not be analyzed");
  });

  it("puts the incomplete-coverage warning ABOVE the listing", () => {
    const report = formatImpactReport({
      impact: {
        project: "alpha",
        direct: ["beta"],
        transitive: [],
        dependents: ["beta"],
      },
      coverage: {
        complete: false,
        notAnalyzed: [{ file: "x.go", reason: "err" }],
        imports: 0,
        analyzedFiles: 0,
        projects: 2,
      },
    });
    const incompleteIndex = report.indexOf("impact incomplete");
    const projectIndex = report.indexOf("beta");
    expect(incompleteIndex).toBeLessThan(projectIndex);
  });

  it("shows 0 dependents with direct: 0, transitive: 0 for a project with no dependents", () => {
    const report = formatImpactReport({
      impact: {
        project: "gamma",
        direct: [],
        transitive: [],
        dependents: [],
      },
      coverage: { complete: true, imports: 0, analyzedFiles: 0, projects: 1 },
    });
    expect(report).toContain("0 projects depend on gamma (direct: 0, transitive: 0)");
  });

  it("uses singular 'project' for exactly one dependent", () => {
    const report = formatImpactReport({
      impact: {
        project: "core",
        direct: ["app"],
        transitive: [],
        dependents: ["app"],
      },
      coverage: { complete: true, imports: 1, analyzedFiles: 1, projects: 2 },
    });
    expect(report).toContain("1 project depends on core (direct: 1, transitive: 0)");
  });

  it("separates direct and transitive counts in the summary", () => {
    const report = formatImpactReport({
      impact: {
        project: "base",
        direct: ["layer1"],
        transitive: ["layer2", "layer3"],
        dependents: ["layer1", "layer2", "layer3"],
      },
      coverage: { complete: true, imports: 5, analyzedFiles: 10, projects: 4 },
    });
    expect(report).toContain("3 projects depend on base (direct: 1, transitive: 2)");
  });
});
