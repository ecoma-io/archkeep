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

  it("shows constraint context for each dependent", () => {
    const report = formatImpactReport({
      impact: {
        project: "core",
        direct: ["app-a"],
        transitive: [],
        dependents: ["app-a"],
        constraintImpact: [
          {
            project: "app-a",
            edges: [{ source: "app-a", target: "core", type: "static" }],
            constraintRows: [
              {
                sourceTag: "layer:app",
                onlyDependOnLibsWithTags: ["layer:domain", "layer:app"],
              },
            ],
            violations: [],
          },
        ],
      },
      coverage: { complete: true, imports: 2, analyzedFiles: 3, projects: 2 },
    });
    expect(report).toContain("Constraint context");
    expect(report).toContain("✔ app-a");
    expect(report).toContain("[layer:app]");
    expect(report).toContain("only [layer:domain, layer:app]");
  });

  it("shows violations with ✖ marker for dependents that break boundary rules", () => {
    const report = formatImpactReport({
      impact: {
        project: "core",
        direct: ["app-a"],
        transitive: [],
        dependents: ["app-a"],
        constraintImpact: [
          {
            project: "app-a",
            edges: [{ source: "app-a", target: "core", type: "static" }],
            constraintRows: [
              {
                sourceTag: "layer:app",
                onlyDependOnLibsWithTags: ["layer:app"],
              },
            ],
            violations: [
              {
                messageId: "onlyTagsConstraintViolation",
                source: "app-a",
                target: "core",
              },
            ],
          },
        ],
      },
      coverage: { complete: true, imports: 2, analyzedFiles: 3, projects: 2 },
    });
    expect(report).toContain("✖ app-a");
    expect(report).toContain("app-a → core  onlyTagsConstraintViolation");
  });

  it("shows description and remediation on constraint rows", () => {
    const report = formatImpactReport({
      impact: {
        project: "core",
        direct: ["app-a"],
        transitive: [],
        dependents: ["app-a"],
        constraintImpact: [
          {
            project: "app-a",
            edges: [{ source: "app-a", target: "core", type: "static" }],
            constraintRows: [
              {
                sourceTag: "layer:app",
                onlyDependOnLibsWithTags: ["layer:domain"],
                description: "Apps may only depend on domain",
                remediation: "Move shared logic to a domain project",
              },
            ],
            violations: [],
          },
        ],
      },
      coverage: { complete: true, imports: 2, analyzedFiles: 3, projects: 2 },
    });
    expect(report).toContain("description  Apps may only depend on domain");
    expect(report).toContain("remediation   Move shared logic to a domain project");
  });

  it("shows 'no matching constraint rows' for a dependent with no matching constraint", () => {
    const report = formatImpactReport({
      impact: {
        project: "core",
        direct: ["untagged"],
        transitive: [],
        dependents: ["untagged"],
        constraintImpact: [
          {
            project: "untagged",
            edges: [{ source: "untagged", target: "core", type: "static" }],
            constraintRows: [],
            violations: [
              {
                messageId: "projectWithoutTagsCannotHaveDependencies",
                source: "untagged",
                target: "core",
              },
            ],
          },
        ],
      },
      coverage: { complete: true, imports: 1, analyzedFiles: 1, projects: 2 },
    });
    expect(report).toContain("no matching constraint rows");
    expect(report).toContain("✖ untagged");
  });

  it("omits constraint context section when constraintImpact is absent", () => {
    const report = formatImpactReport({
      impact: {
        project: "core",
        direct: ["app-a"],
        transitive: [],
        dependents: ["app-a"],
      },
      coverage: { complete: true, imports: 2, analyzedFiles: 3, projects: 2 },
    });
    expect(report).not.toContain("Constraint context");
  });

  it("shows constraint context with explicit message when constraintImpact is an empty array", () => {
    // Bug 2 regression: an empty constraintImpact array (config provided,
    // no dependents to judge) must render the section with an explicit
    // "no dependents to judge" line — indistinguishable from "no config"
    // otherwise.
    const report = formatImpactReport({
      impact: {
        project: "core",
        direct: [],
        transitive: [],
        dependents: [],
        constraintImpact: [],
      },
      coverage: { complete: true, imports: 0, analyzedFiles: 0, projects: 1 },
    });
    expect(report).toContain("Constraint context");
    expect(report).toContain("no dependents to judge against constraint table");
  });

  it("renders description and remediation indented below the constraint row", () => {
    // Pin intent: description and remediation are structured fields, not
    // ad-hoc text — they must appear indented so a reader (or parser)
    // can attribute them to the constraint row above.
    const report = formatImpactReport({
      impact: {
        project: "core",
        direct: ["app-a"],
        transitive: [],
        dependents: ["app-a"],
        constraintImpact: [
          {
            project: "app-a",
            edges: [{ source: "app-a", target: "core", type: "static" }],
            constraintRows: [
              {
                sourceTag: "layer:app",
                onlyDependOnLibsWithTags: ["layer:domain"],
                description: "App-layer boundary",
                remediation: "Introduce a facade in layer:domain",
              },
            ],
            violations: [],
          },
        ],
      },
      coverage: { complete: true, imports: 1, analyzedFiles: 1, projects: 2 },
    });
    // Description and remediation appear on their own indented lines
    expect(report).toMatch(/description\s+App-layer boundary/);
    expect(report).toMatch(/remediation\s+Introduce a facade in layer:domain/);
  });

  it("shows ✖ marker and violation line for projectWithoutTagsCannotHaveDependencies", () => {
    // Pin the null-constraint path: a dependent with no matching constraint
    // row must show ✖ and the violation, not silently pass.
    const report = formatImpactReport({
      impact: {
        project: "core",
        direct: ["untagged"],
        transitive: [],
        dependents: ["untagged"],
        constraintImpact: [
          {
            project: "untagged",
            edges: [{ source: "untagged", target: "core", type: "static" }],
            constraintRows: [],
            violations: [
              {
                messageId: "projectWithoutTagsCannotHaveDependencies",
                source: "untagged",
                target: "core",
              },
            ],
          },
        ],
      },
      coverage: { complete: true, imports: 1, analyzedFiles: 1, projects: 2 },
    });
    expect(report).toContain("✖ untagged");
    expect(report).toContain("untagged → core  projectWithoutTagsCannotHaveDependencies");
    expect(report).toContain("no matching constraint rows");
  });
});
