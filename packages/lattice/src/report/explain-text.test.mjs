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
        violation: null,
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
        violation: null,
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
        violation: null,
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
        violation: null,
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
        violation: null,
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
        violation: null,
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
        violation: null,
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
        violation: null,
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
        violation: {
          messageId: "depConstraints",
          message:
            "Projects tagged 'layer:domain' may only depend on projects tagged 'layer:domain' or 'layer:util'",
        },
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
        violation: {
          messageId: "depConstraints",
          message: "line one\nline two",
        },
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
        violation: null,
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
        violation: null,
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
        violation: null,
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
        violation: null,
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
        violation: null,
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
});
