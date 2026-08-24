import { describe, expect, it } from "vitest";

import { formatExplainReport } from "./explain-text.mjs";

/**
 * What the explain report guarantees: the first line is always the clickable
 * `file:line:column` position, unindented, and every detail after it is
 * indented so the position line stands alone. The verdict line is always
 * present — "allowed", "VIOLATION", or "UNRESOLVABLE" — so a reader never
 * has to guess whether the judgment was reached.
 *
 * Coverage is stated the same way every other command states it, so "no
 * violations" reads as a claim about what was inspected, not only about
 * correctness (AGENTS.md: "an empty result is a claim, not a shrug").
 */

describe("formatExplainReport", () => {
  it("starts with the file:line:column position, unindented", () => {
    const report = formatExplainReport({
      explanation: {
        site: { file: "libs/alpha/main.go", line: 10, column: 5 },
        import: { specifier: "beta", kind: "static" },
        sourceProject: "alpha",
        targetProject: "beta",
        sourceTags: [],
        targetTags: [],
        matchedConstraints: [],
        violations: null,
        unresolvable: false,
        reason: null,
      },
      coverage: {
        complete: true,
        imports: 1,
        analyzedFiles: 1,
        projects: 2,
        notAnalyzed: [],
      },
    });
    const firstLine = report.split("\n")[0];
    expect(firstLine).toBe("libs/alpha/main.go:10:5");
  });

  it("shows the import specifier and kind", () => {
    const report = formatExplainReport({
      explanation: {
        site: { file: "libs/alpha/main.go", line: 10, column: 5 },
        import: { specifier: "beta", kind: "static" },
        sourceProject: "alpha",
        targetProject: "beta",
        sourceTags: [],
        targetTags: [],
        matchedConstraints: [],
        violations: null,
        unresolvable: false,
        reason: null,
      },
      coverage: {
        complete: true,
        imports: 1,
        analyzedFiles: 1,
        projects: 2,
        notAnalyzed: [],
      },
    });
    expect(report).toContain('import       "beta" (static)');
  });

  it("shows the source project with its tags", () => {
    const report = formatExplainReport({
      explanation: {
        site: { file: "libs/alpha/main.go", line: 10, column: 5 },
        import: { specifier: "beta", kind: "static" },
        sourceProject: "alpha",
        targetProject: "beta",
        sourceTags: ["layer:domain"],
        targetTags: ["layer:util"],
        matchedConstraints: [],
        violations: null,
        unresolvable: false,
        reason: null,
      },
      coverage: {
        complete: true,
        imports: 1,
        analyzedFiles: 1,
        projects: 2,
        notAnalyzed: [],
      },
    });
    expect(report).toContain("source       alpha [layer:domain]");
    expect(report).toContain("target       beta [layer:util]");
  });

  it("renders an empty tag list as []", () => {
    const report = formatExplainReport({
      explanation: {
        site: { file: "libs/alpha/main.go", line: 10, column: 5 },
        import: { specifier: "beta", kind: "static" },
        sourceProject: "alpha",
        targetProject: "beta",
        sourceTags: [],
        targetTags: [],
        matchedConstraints: [],
        violations: null,
        unresolvable: false,
        reason: null,
      },
      coverage: {
        complete: true,
        imports: 1,
        analyzedFiles: 1,
        projects: 2,
        notAnalyzed: [],
      },
    });
    expect(report).toContain("source       alpha []");
    expect(report).toContain("target       beta []");
  });

  it("renders (unresolved) for a null project name", () => {
    const report = formatExplainReport({
      explanation: {
        site: { file: "libs/alpha/main.go", line: 10, column: 5 },
        import: { specifier: "beta", kind: "static" },
        sourceProject: "alpha",
        targetProject: null,
        sourceTags: [],
        targetTags: [],
        matchedConstraints: [],
        violations: null,
        unresolvable: false,
        reason: null,
      },
      coverage: {
        complete: true,
        imports: 1,
        analyzedFiles: 1,
        projects: 2,
        notAnalyzed: [],
      },
    });
    expect(report).toContain("target       (unresolved)");
  });

  it("shows matched constraint rows", () => {
    const report = formatExplainReport({
      explanation: {
        site: { file: "libs/alpha/main.go", line: 10, column: 5 },
        import: { specifier: "beta", kind: "static" },
        sourceProject: "alpha",
        targetProject: "beta",
        sourceTags: ["layer:domain"],
        targetTags: ["layer:util"],
        matchedConstraints: [
          {
            sourceTag: "layer:domain",
            onlyDependOnLibsWithTags: ["layer:domain", "layer:util"],
          },
        ],
        violations: null,
        unresolvable: false,
        reason: null,
      },
      coverage: {
        complete: true,
        imports: 1,
        analyzedFiles: 1,
        projects: 2,
        notAnalyzed: [],
      },
    });
    expect(report).toContain("constraint   sourceTag layer:domain");
    expect(report).toContain("onlyDependOnLibsWithTags [layer:domain, layer:util]");
  });

  it("shows (none) when no constraint rows matched", () => {
    const report = formatExplainReport({
      explanation: {
        site: { file: "libs/alpha/main.go", line: 10, column: 5 },
        import: { specifier: "beta", kind: "static" },
        sourceProject: "alpha",
        targetProject: "beta",
        sourceTags: [],
        targetTags: [],
        matchedConstraints: [],
        violations: null,
        unresolvable: false,
        reason: null,
      },
      coverage: {
        complete: true,
        imports: 1,
        analyzedFiles: 1,
        projects: 2,
        notAnalyzed: [],
      },
    });
    expect(report).toContain(
      "constraint   (none — the source project matches no depConstraints row)",
    );
  });

  it("shows allowed verdict when there is no violation", () => {
    const report = formatExplainReport({
      explanation: {
        site: { file: "libs/alpha/main.go", line: 10, column: 5 },
        import: { specifier: "beta", kind: "static" },
        sourceProject: "alpha",
        targetProject: "beta",
        sourceTags: [],
        targetTags: [],
        matchedConstraints: [],
        violations: null,
        unresolvable: false,
        reason: null,
      },
      coverage: {
        complete: true,
        imports: 1,
        analyzedFiles: 1,
        projects: 2,
        notAnalyzed: [],
      },
    });
    expect(report).toContain("verdict      allowed — no constraint was violated");
  });

  it("shows VIOLATION verdict with the messageId", () => {
    const report = formatExplainReport({
      explanation: {
        site: { file: "libs/alpha/main.go", line: 10, column: 5 },
        import: { specifier: "beta", kind: "static" },
        sourceProject: "alpha",
        targetProject: "beta",
        sourceTags: ["layer:domain"],
        targetTags: ["layer:app"],
        matchedConstraints: [],
        violations: [
          {
            messageId: "depConstraints",
            message:
              "Projects tagged 'layer:domain' may only depend on projects tagged 'layer:domain' or 'layer:util'",
          },
        ],
        unresolvable: false,
        reason: null,
      },
      coverage: {
        complete: true,
        imports: 1,
        analyzedFiles: 1,
        projects: 2,
        notAnalyzed: [],
      },
    });
    expect(report).toContain("verdict      VIOLATION — depConstraints");
    expect(report).toContain("Projects tagged 'layer:domain'");
  });

  it("shows multiple violations when a site violates more than one rule", () => {
    const report = formatExplainReport({
      explanation: {
        site: { file: "libs/alpha/main.go", line: 10, column: 5 },
        import: { specifier: "beta", kind: "static" },
        sourceProject: "alpha",
        targetProject: "beta",
        sourceTags: ["layer:domain"],
        targetTags: ["layer:app"],
        matchedConstraints: [],
        violations: [
          {
            messageId: "depConstraints",
            message: "Domain layer must not depend on app layer",
          },
          {
            messageId: "noTransitiveDependencies",
            message: "Transitive dependency detected",
          },
        ],
        unresolvable: false,
        reason: null,
      },
      coverage: {
        complete: true,
        imports: 1,
        analyzedFiles: 1,
        projects: 2,
        notAnalyzed: [],
      },
    });
    expect(report).toContain("verdict      VIOLATION — depConstraints");
    expect(report).toContain("verdict      VIOLATION — noTransitiveDependencies");
    expect(report).toContain("Domain layer must not depend on app layer");
    expect(report).toContain("Transitive dependency detected");
  });

  it("indents the violation message under the verdict", () => {
    const report = formatExplainReport({
      explanation: {
        site: { file: "libs/alpha/main.go", line: 10, column: 5 },
        import: { specifier: "beta", kind: "static" },
        sourceProject: "alpha",
        targetProject: "beta",
        sourceTags: [],
        targetTags: [],
        matchedConstraints: [],
        violations: [
          {
            messageId: "depConstraints",
            message: "line one\nline two",
          },
        ],
        unresolvable: false,
        reason: null,
      },
      coverage: {
        complete: true,
        imports: 1,
        analyzedFiles: 1,
        projects: 2,
        notAnalyzed: [],
      },
    });
    expect(report).toContain("      line one");
    expect(report).toContain("      line two");
  });

  it("shows the UNRESOLVABLE verdict for an unresolvable site", () => {
    const report = formatExplainReport({
      explanation: {
        site: { file: "libs/alpha/main.go", line: 10, column: 5 },
        import: null,
        sourceProject: null,
        targetProject: null,
        sourceTags: [],
        targetTags: [],
        matchedConstraints: [],
        violations: null,
        unresolvable: true,
        reason: "non-literal argument",
      },
      coverage: {
        complete: true,
        imports: 1,
        analyzedFiles: 1,
        projects: 2,
        notAnalyzed: [],
      },
    });
    expect(report).toContain("unresolvable  non-literal argument");
    expect(report).toContain("verdict      UNRESOLVABLE");
  });

  it("shows complete coverage", () => {
    const report = formatExplainReport({
      explanation: {
        site: { file: "libs/alpha/main.go", line: 10, column: 5 },
        import: { specifier: "beta", kind: "static" },
        sourceProject: "alpha",
        targetProject: "beta",
        sourceTags: [],
        targetTags: [],
        matchedConstraints: [],
        violations: null,
        unresolvable: false,
        reason: null,
      },
      coverage: {
        complete: true,
        imports: 1,
        analyzedFiles: 1,
        projects: 2,
        notAnalyzed: [],
      },
    });
    expect(report).toContain("coverage complete (1 import in 1 file across 2 projects)");
  });

  it("shows incomplete coverage with the count of unanalyzed files", () => {
    const report = formatExplainReport({
      explanation: {
        site: { file: "libs/alpha/main.go", line: 10, column: 5 },
        import: { specifier: "beta", kind: "static" },
        sourceProject: "alpha",
        targetProject: "beta",
        sourceTags: [],
        targetTags: [],
        matchedConstraints: [],
        violations: null,
        unresolvable: false,
        reason: null,
      },
      coverage: {
        complete: false,
        imports: 1,
        analyzedFiles: 1,
        projects: 2,
        notAnalyzed: [{ file: "libs/beta/broken.go", reason: "parse error" }],
      },
    });
    expect(report).toContain(
      "coverage incomplete — 1 file could not be analyzed (1 import in 1 file across 2 projects)",
    );
  });

  it("uses plural forms for counts other than 1", () => {
    const report = formatExplainReport({
      explanation: {
        site: { file: "libs/alpha/main.go", line: 10, column: 5 },
        import: { specifier: "beta", kind: "static" },
        sourceProject: "alpha",
        targetProject: "beta",
        sourceTags: [],
        targetTags: [],
        matchedConstraints: [],
        violations: null,
        unresolvable: false,
        reason: null,
      },
      coverage: {
        complete: true,
        imports: 2,
        analyzedFiles: 3,
        projects: 4,
        notAnalyzed: [],
      },
    });
    expect(report).toContain("2 imports in 3 files across 4 projects");
  });

  it("shows rule description and remediation when the violation's constraint carries them", () => {
    const report = formatExplainReport({
      explanation: {
        site: { file: "libs/alpha/main.go", line: 10, column: 5 },
        import: { specifier: "beta", kind: "static" },
        sourceProject: "alpha",
        targetProject: "beta",
        sourceTags: ["layer:domain"],
        targetTags: ["layer:app"],
        matchedConstraints: [],
        violations: [
          {
            messageId: "depConstraints",
            message: "Domain layer must not depend on app layer",
            constraint: {
              sourceTag: "layer:domain",
              onlyDependOnLibsWithTags: ["layer:domain"],
              description: "Domain isolation",
              remediation: "Depend on an application-owned interface",
            },
          },
        ],
        unresolvable: false,
        reason: null,
      },
      coverage: {
        complete: true,
        imports: 1,
        analyzedFiles: 1,
        projects: 2,
        notAnalyzed: [],
      },
    });
    expect(report).toContain("rule         Domain isolation");
    expect(report).toContain("remediation  Depend on an application-owned interface");
  });

  it("omits the rule line and prints an explicit remediation pointer when the constraint declares neither", () => {
    const report = formatExplainReport({
      explanation: {
        site: { file: "libs/alpha/main.go", line: 10, column: 5 },
        import: { specifier: "beta", kind: "static" },
        sourceProject: "alpha",
        targetProject: "beta",
        sourceTags: ["layer:domain"],
        targetTags: ["layer:app"],
        matchedConstraints: [],
        violations: [
          {
            messageId: "depConstraints",
            message: "Domain layer must not depend on app layer",
            constraint: {
              sourceTag: "layer:domain",
              onlyDependOnLibsWithTags: ["layer:domain"],
            },
          },
        ],
        unresolvable: false,
        reason: null,
      },
      coverage: {
        complete: true,
        imports: 1,
        analyzedFiles: 1,
        projects: 2,
        notAnalyzed: [],
      },
    });
    expect(report).not.toContain("rule         ");
    // No declared remediation never prints nothing: the explicit pointer at
    // the constraint row is the honest line, and inventing a fix would be a
    // rule wearing a formatter's name.
    expect(report).toContain("remediation  none declared — consult the constraint row");
  });

  it("names the constraint row's decisionRef in the no-remediation pointer when it carries one", () => {
    const report = formatExplainReport({
      explanation: {
        site: { file: "libs/alpha/main.go", line: 10, column: 5 },
        import: { specifier: "beta", kind: "static" },
        sourceProject: "alpha",
        targetProject: "beta",
        sourceTags: ["layer:domain"],
        targetTags: ["layer:app"],
        matchedConstraints: [],
        violations: [
          {
            messageId: "depConstraints",
            message: "Domain layer must not depend on app layer",
            constraint: {
              sourceTag: "layer:domain",
              onlyDependOnLibsWithTags: ["layer:domain"],
              decisionRef: "0007-domain-isolation",
            },
          },
        ],
        unresolvable: false,
        reason: null,
      },
      coverage: { complete: true, imports: 1, analyzedFiles: 1, projects: 2, notAnalyzed: [] },
    });
    expect(report).toContain(
      "remediation  none declared — consult the constraint row and its decisionRef 0007-domain-isolation",
    );
  });

  it("points at the messageId's check when no depConstraints row drives the violation", () => {
    const report = formatExplainReport({
      explanation: {
        site: { file: "libs/alpha/main.go", line: 10, column: 5 },
        import: { specifier: "beta", kind: "static" },
        sourceProject: "alpha",
        targetProject: "beta",
        sourceTags: [],
        targetTags: [],
        matchedConstraints: [],
        violations: [
          {
            messageId: "noCircularDependencies",
            message: "Circular dependency detected",
            constraint: null,
          },
        ],
        unresolvable: false,
        reason: null,
      },
      coverage: { complete: true, imports: 1, analyzedFiles: 1, projects: 2, notAnalyzed: [] },
    });
    expect(report).toContain(
      "remediation  none declared — no depConstraints row drives this check",
    );
  });

  it("prints the governing row's allowed tags verbatim on a violation", () => {
    const report = formatExplainReport({
      explanation: {
        site: { file: "libs/alpha/main.go", line: 10, column: 5 },
        import: { specifier: "beta", kind: "static" },
        sourceProject: "alpha",
        targetProject: "beta",
        sourceTags: ["layer:domain"],
        targetTags: ["layer:app"],
        matchedConstraints: [],
        violations: [
          {
            messageId: "depConstraints",
            message: "Domain layer must not depend on app layer",
            constraint: {
              sourceTag: "layer:domain",
              onlyDependOnLibsWithTags: ["layer:domain", "layer:util"],
            },
          },
        ],
        unresolvable: false,
        reason: null,
      },
      coverage: { complete: true, imports: 1, analyzedFiles: 1, projects: 2, notAnalyzed: [] },
    });
    expect(report).toContain("allowed      [layer:domain, layer:util]");
  });

  it("prints no allowed line for a notDependOnLibsWithTags row — never a computed complement", () => {
    const report = formatExplainReport({
      explanation: {
        site: { file: "libs/alpha/main.go", line: 10, column: 5 },
        import: { specifier: "beta", kind: "static" },
        sourceProject: "alpha",
        targetProject: "beta",
        sourceTags: ["zone:x"],
        targetTags: ["grade:closed"],
        matchedConstraints: [],
        violations: [
          {
            messageId: "notTagsConstraintViolation",
            message: "zone:x may not depend on grade:closed",
            constraint: {
              sourceTag: "zone:x",
              notDependOnLibsWithTags: ["grade:closed"],
            },
          },
        ],
        unresolvable: false,
        reason: null,
      },
      coverage: { complete: true, imports: 1, analyzedFiles: 1, projects: 2, notAnalyzed: [] },
    });
    expect(report).not.toContain("allowed      ");
    // The ban list itself is never rewritten into an allowed direction.
    expect(report).not.toContain("grade:open");
  });

  it("renders an allSourceTags constraint row", () => {
    const report = formatExplainReport({
      explanation: {
        site: { file: "libs/alpha/main.go", line: 10, column: 5 },
        import: { specifier: "beta", kind: "static" },
        sourceProject: "alpha",
        targetProject: "beta",
        sourceTags: ["layer:domain"],
        targetTags: ["layer:util"],
        matchedConstraints: [
          {
            allSourceTags: ["layer:domain", "scope:billing"],
            onlyDependOnLibsWithTags: ["layer:domain"],
          },
        ],
        violations: null,
        unresolvable: false,
        reason: null,
      },
      coverage: {
        complete: true,
        imports: 1,
        analyzedFiles: 1,
        projects: 2,
        notAnalyzed: [],
      },
    });
    expect(report).toContain("allSourceTags [layer:domain, scope:billing]");
  });

  it("explains a violation that is not driven by any depConstraints row", () => {
    // `projectWithoutTagsCannotHaveDependencies` fires before the constraint
    // table is read; a matched-constraint list carrying the null row must
    // render the sentence rather than crash or print an undefined row.
    const report = formatExplainReport({
      explanation: {
        site: { file: "libs/alpha/main.go", line: 10, column: 5 },
        import: { specifier: "beta", kind: "static" },
        sourceProject: "alpha",
        targetProject: "beta",
        sourceTags: [],
        targetTags: ["layer:util"],
        matchedConstraints: [null],
        violations: [
          {
            messageId: "projectWithoutTagsCannotHaveDependencies",
            message: "project 'alpha' without tags may not have dependencies",
            constraint: null,
          },
        ],
        unresolvable: false,
        reason: null,
      },
      coverage: { complete: true, imports: 1, analyzedFiles: 1, projects: 2, notAnalyzed: [] },
    });
    expect(report).toContain("not driven by a depConstraints row");
  });

  it("keeps a blank line inside a multi-line violation message", () => {
    // A message with an empty paragraph must not collapse to nothing — the
    // line stays, indented like the rest of the message.
    const report = formatExplainReport({
      explanation: {
        site: { file: "libs/alpha/main.go", line: 10, column: 5 },
        import: { specifier: "beta", kind: "static" },
        sourceProject: "alpha",
        targetProject: "beta",
        sourceTags: [],
        targetTags: [],
        matchedConstraints: [],
        violations: [
          {
            messageId: "noCircularDependencies",
            message: "line one\n\nline three",
            constraint: null,
          },
        ],
        unresolvable: false,
        reason: null,
      },
      coverage: { complete: true, imports: 1, analyzedFiles: 1, projects: 2, notAnalyzed: [] },
    });
    expect(report).toContain("      line one\n\n      line three");
  });

  it("uses the singular project form when one project was inspected", () => {
    const report = formatExplainReport({
      explanation: {
        site: { file: "libs/alpha/main.go", line: 10, column: 5 },
        import: { specifier: "beta", kind: "static" },
        sourceProject: "alpha",
        targetProject: "beta",
        sourceTags: [],
        targetTags: [],
        matchedConstraints: [],
        violations: null,
        unresolvable: false,
        reason: null,
      },
      coverage: { complete: true, imports: 1, analyzedFiles: 1, projects: 1, notAnalyzed: [] },
    });
    expect(report).toContain("1 project");
  });

  it("says '1 file' when exactly one file could not be analyzed", () => {
    const report = formatExplainReport({
      explanation: {
        site: { file: "libs/alpha/main.go", line: 10, column: 5 },
        import: { specifier: "beta", kind: "static" },
        sourceProject: "alpha",
        targetProject: "beta",
        sourceTags: [],
        targetTags: [],
        matchedConstraints: [],
        violations: null,
        unresolvable: false,
        reason: null,
      },
      coverage: { complete: false, imports: 1, analyzedFiles: 1, projects: 2, notAnalyzed: [{}] },
    });
    expect(report).toContain("1 file could not be analyzed");
  });
});
