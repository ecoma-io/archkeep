import { describe, expect, it } from "vitest";

import { formatContextReport } from "./context-text.mjs";

/**
 * What the context report guarantees: the project name and tags are always
 * stated (even when tags are empty), matching constraint rows are rendered the
 * same way `check` renders them, and the coverage claim appears above the
 * listing so the reader knows whether the result is complete before reading
 * any entry.
 */

describe("formatContextReport", () => {
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

  it("shows the project name and tags", () => {
    const text = formatContextReport({
      projectContext: { project: "alpha", tags: ["layer:domain"], constraints: [] },
      coverage: coverage(),
    });
    expect(text).toContain("Project  alpha");
    expect(text).toContain("Tags     layer:domain");
  });

  it("shows 'none' for a project with no tags, rather than printing nothing", () => {
    const text = formatContextReport({
      projectContext: { project: "alpha", tags: [], constraints: [] },
      coverage: coverage(),
    });
    expect(text).toContain("Tags     none");
  });

  it("shows matching constraint rows using the same format as check output", () => {
    const text = formatContextReport({
      projectContext: {
        project: "alpha",
        tags: ["layer:domain"],
        constraints: [
          { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain", "layer:util"] },
        ],
      },
      coverage: coverage(),
    });
    expect(text).toContain("Constraints (1 row matches):");
    expect(text).toContain("sourceTag layer:domain");
    expect(text).toContain("onlyDependOnLibsWithTags [layer:domain, layer:util]");
  });

  it("shows description and remediation when the constraint row carries them", () => {
    const text = formatContextReport({
      projectContext: {
        project: "alpha",
        tags: ["layer:domain"],
        constraints: [
          {
            sourceTag: "layer:domain",
            onlyDependOnLibsWithTags: ["layer:domain"],
            description: "Domain isolation",
            remediation: "Depend on an application-owned interface",
          },
        ],
      },
      coverage: coverage(),
    });
    expect(text).toContain("description  Domain isolation");
    expect(text).toContain("remediation   Depend on an application-owned interface");
  });

  it("omits description and remediation when the constraint row has none", () => {
    const text = formatContextReport({
      projectContext: {
        project: "alpha",
        tags: ["layer:domain"],
        constraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] }],
      },
      coverage: coverage(),
    });
    expect(text).not.toContain("description  ");
    expect(text).not.toContain("remediation   ");
  });

  it("explicitly states when no constraint rows match", () => {
    const text = formatContextReport({
      projectContext: { project: "alpha", tags: ["layer:domain"], constraints: [] },
      coverage: coverage(),
    });
    expect(text).toContain("no matching constraint rows");
  });

  it("uses singular 'row' when exactly one constraint matches", () => {
    const text = formatContextReport({
      projectContext: {
        project: "alpha",
        tags: ["layer:domain"],
        constraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] }],
      },
      coverage: coverage(),
    });
    expect(text).toContain("1 row matches");
    expect(text).not.toContain("1 rows matches");
  });

  it("uses plural 'rows' when multiple constraints match", () => {
    const text = formatContextReport({
      projectContext: {
        project: "alpha",
        tags: ["layer:domain"],
        constraints: [
          { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
          { sourceTag: "layer:domain", notDependOnLibsWithTags: ["layer:app"] },
        ],
      },
      coverage: coverage(),
    });
    expect(text).toContain("Constraints (2 rows match):");
  });

  it("shows complete coverage above the listing", () => {
    const text = formatContextReport({
      projectContext: { project: "alpha", tags: ["layer:domain"], constraints: [] },
      coverage: coverage(),
    });
    const lines = text.split("\n");
    // Coverage line comes before the project line
    const coverageLine = lines.findIndex((l) => l.includes("context complete"));
    const projectLine = lines.findIndex((l) => l.includes("Project  alpha"));
    expect(coverageLine).toBeLessThan(projectLine);
  });

  it("shows incomplete coverage with a warning", () => {
    const text = formatContextReport({
      projectContext: { project: "alpha", tags: ["layer:domain"], constraints: [] },
      coverage: coverage({
        complete: false,
        notAnalyzed: [{ file: "libs/beta/broken.go", reason: "parse error" }],
      }),
    });
    expect(text).toContain("context incomplete");
    expect(text).toContain("1 file could not be analyzed");
  });

  it("renders an allSourceTags constraint row", () => {
    const text = formatContextReport({
      projectContext: {
        project: "alpha",
        tags: ["layer:domain", "scope:billing"],
        constraints: [
          {
            allSourceTags: ["layer:domain", "scope:billing"],
            onlyDependOnLibsWithTags: ["layer:domain"],
          },
        ],
      },
      coverage: coverage(),
    });
    expect(text).toContain("allSourceTags [layer:domain, scope:billing]");
  });
});
