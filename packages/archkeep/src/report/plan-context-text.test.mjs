import { describe, expect, it } from "vitest";

import { formatPlanContextReport } from "./plan-context-text.mjs";

/**
 * What the planning-context report guarantees: the coverage claim sits ABOVE
 * everything (the reader must know whether the result is complete before
 * reading a single entry), the target project's tags and policy fingerprint are
 * always stated, and sections that are empty state so rather than printing
 * nothing — a plan with no violations and a plan the renderer forgot are not
 * the same document (`AGENTS.md`: "an empty result is a claim, not a shrug").
 */

describe("formatPlanContextReport", () => {
  const coverage = (overrides = {}) => ({
    complete: true,
    imports: 2,
    analyzedFiles: 3,
    projects: 4,
    notAnalyzed: [],
    blindSpots: [],
    notes: [],
    ...overrides,
  });

  /** A minimal `result` object in the landed shape (`result.plan` nesting). */
  const result = (overrides = {}) => ({
    project: "alpha",
    tags: ["layer:domain"],
    constraints: [],
    dependencies: [],
    plan: {
      variant: "plan",
      policyFingerprint: "abc123",
      architecture: { projects: 4, dependencies: 3, targets: [] },
      impact: [],
      violations: [],
      drift: { goWork: null, tsconfigPaths: null },
      waivers: {
        declared: false,
        waivers: [],
        covered: 0,
        expired: 0,
        stale: 0,
        permanentSuppressions: [],
      },
      verify: ["archkeep check --format json"],
    },
    ...overrides,
  });

  it("shows the coverage claim above the target project line", () => {
    const text = formatPlanContextReport({ project: result(), coverage: coverage() });
    const coverageLine = text.split("\n").findIndex((l) => l.includes("planning context complete"));
    const projectLine = text.split("\n").findIndex((l) => l.includes("Project  alpha"));
    expect(coverageLine).toBeGreaterThanOrEqual(0);
    expect(projectLine).toBeGreaterThan(coverageLine);
  });

  it("shows the target project, tags and policy fingerprint", () => {
    const text = formatPlanContextReport({ project: result(), coverage: coverage() });
    expect(text).toContain("Project  alpha");
    expect(text).toContain("Tags     layer:domain");
    expect(text).toContain("Policy   fingerprint abc123");
  });

  it("shows 'none' for a project with no tags", () => {
    const text = formatPlanContextReport({ project: result({ tags: [] }), coverage: coverage() });
    expect(text).toContain("Tags     none");
  });

  it("shows matching constraint rows with description and remediation", () => {
    const text = formatPlanContextReport({
      project: result({
        constraints: [
          {
            sourceTag: "layer:domain",
            onlyDependOnLibsWithTags: ["layer:domain", "layer:util"],
            description: "Domain isolation",
            remediation: "Depend on a domain-owned interface",
          },
        ],
      }),
      coverage: coverage(),
    });
    expect(text).toContain("1 row govern this project");
    expect(text).toContain("sourceTag layer:domain");
    expect(text).toContain("description  Domain isolation");
    expect(text).toContain("remediation   Depend on a domain-owned interface");
  });

  it("explicitly states when no constraint rows match", () => {
    const text = formatPlanContextReport({ project: result(), coverage: coverage() });
    expect(text).toContain("no matching constraint rows");
  });

  // P1-02: a matched constraint row's decisionRef used to render verbatim,
  // unverified — the same bug the plain `context` command had, since both
  // share `formatConstraint`.
  it("flags a matched constraint row's decisionRef when it is unresolved", () => {
    const text = formatPlanContextReport({
      project: result({
        constraints: [
          {
            sourceTag: "layer:domain",
            onlyDependOnLibsWithTags: ["layer:domain"],
            decisionRef: "9999-does-not-exist",
          },
        ],
      }),
      coverage: coverage(),
      unresolvedDecisionRefs: new Set(["9999-does-not-exist"]),
    });
    expect(text).toContain("decisionRef [9999-does-not-exist]");
    expect(text).toContain("UNRESOLVED");
  });

  it("renders a decisionRef verbatim when no unresolved set is passed — unchanged from before this existed", () => {
    const text = formatPlanContextReport({
      project: result({
        constraints: [
          {
            sourceTag: "layer:domain",
            onlyDependOnLibsWithTags: ["layer:domain"],
            decisionRef: "9999-does-not-exist",
          },
        ],
      }),
      coverage: coverage(),
    });
    expect(text).toContain("decisionRef [9999-does-not-exist]");
    expect(text).not.toContain("UNRESOLVED");
  });

  it("shows the affected projects when paths were given", () => {
    const text = formatPlanContextReport({
      project: result({
        plan: {
          ...result().plan,
          architecture: { ...result().plan.architecture, targets: ["alpha", "beta"] },
        },
      }),
      coverage: coverage(),
    });
    expect(text).toContain("alpha, beta");
  });

  it("shows '(none given)' when no scope was requested", () => {
    const text = formatPlanContextReport({ project: result(), coverage: coverage() });
    expect(text).toContain("(none given — the whole workspace is in scope)");
  });

  it("shows the impact list with direct/transitive counts", () => {
    const text = formatPlanContextReport({
      project: result({
        plan: {
          ...result().plan,
          impact: [
            {
              project: "alpha",
              direct: ["checkout-api"],
              transitive: ["payment-worker"],
              dependentsTotal: 2,
              hasMore: false,
            },
          ],
        },
      }),
      coverage: coverage(),
    });
    expect(text).toContain("2 projects depend on it");
    expect(text).toContain("direct 1, transitive 1");
  });

  it("shows capped dependents with an overflow note", () => {
    const text = formatPlanContextReport({
      project: result({
        plan: {
          ...result().plan,
          impact: [
            {
              project: "alpha",
              direct: [],
              transitive: [],
              dependentsTotal: 25,
              dependents: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
              hasMore: true,
            },
          ],
        },
      }),
      coverage: coverage(),
    });
    expect(text).toContain("25 projects depend on it");
    expect(text).toContain("and 15 more");
  });

  it("shows zero violations explicitly", () => {
    const text = formatPlanContextReport({ project: result(), coverage: coverage() });
    expect(text).toContain("Violations (0 in scope of this change)");
    expect(text).toContain(
      "none — the full-workspace rule-engine verdict found no violations in scope",
    );
  });

  it("lists violations with the edge and messageId", () => {
    const text = formatPlanContextReport({
      project: result({
        plan: {
          ...result().plan,
          violations: [
            {
              sourceFile: "libs/alpha/main.go",
              line: 4,
              column: 2,
              messageId: "onlyTagsConstraintViolation",
              sourceProject: "alpha",
              targetProject: "gamma",
            },
          ],
        },
      }),
      coverage: coverage(),
    });
    expect(text).toContain("Violations (1 in scope of this change)");
    expect(text).toContain("alpha → gamma");
    expect(text).toContain("onlyTagsConstraintViolation");
    expect(text).toContain("libs/alpha/main.go");
  });

  it("shows 'not judged' for drift when no manifest exists", () => {
    const text = formatPlanContextReport({ project: result(), coverage: coverage() });
    expect(text).toContain("go.work        not judged (no manifest to read)");
    expect(text).toContain("tsconfig paths not judged (no manifest to read)");
  });

  it("shows 'checked, no drift' for a manifest that was judged clean", () => {
    const text = formatPlanContextReport({
      project: result({
        plan: {
          ...result().plan,
          drift: {
            goWork: { checked: true, findings: [] },
            tsconfigPaths: { checked: true, findings: [] },
          },
        },
      }),
      coverage: coverage(),
    });
    expect(text).toContain("go.work        checked, no drift");
    expect(text).toContain("tsconfig paths checked, no drift");
  });

  it("shows a drift finding count (plural)", () => {
    const text = formatPlanContextReport({
      project: result({
        plan: {
          ...result().plan,
          drift: {
            goWork: { checked: true, findings: [{}, {}] },
            tsconfigPaths: null,
          },
        },
      }),
      coverage: coverage(),
    });
    expect(text).toContain("go.work        2 findings");
  });

  it("lists the verification commands", () => {
    const text = formatPlanContextReport({ project: result(), coverage: coverage() });
    expect(text).toContain("Verify after the change");
    expect(text).toContain("archkeep check --format json");
  });

  it("warns on incomplete coverage, above the listing", () => {
    const text = formatPlanContextReport({
      project: result(),
      coverage: coverage({
        complete: false,
        notAnalyzed: [{ file: "libs/beta/broken.go", reason: "could not be read" }],
      }),
    });
    expect(text).toContain("planning context incomplete");
    expect(text).toContain("1 file could not be analyzed");
    const incompleteIndex = text
      .split("\n")
      .findIndex((l) => l.includes("planning context incomplete"));
    const projectIndex = text.split("\n").findIndex((l) => l.includes("Project  alpha"));
    expect(incompleteIndex).toBeLessThan(projectIndex);
  });
});
