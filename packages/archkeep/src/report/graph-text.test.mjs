import { describe, expect, it } from "vitest";

import { formatGraphReport } from "./graph-text.mjs";

/**
 * What the graph report guarantees: every section carries a count so an empty
 * result is distinguishable from a missing one, the coverage claim sits above
 * the listing so the reader knows completeness before reading entries, and a
 * project with no dependencies renders `(no dependencies)` rather than
 * vanishing silently.
 */

const DEFAULT_LAYOUT = { appsDir: "apps", libsDir: "libs" };

describe("formatGraphReport", () => {
  it("shows the project count and per-project listing with edges beneath each project", () => {
    const report = formatGraphReport({
      projects: [
        { name: "alpha", root: "libs/alpha", type: "lib", tags: [] },
        { name: "beta", root: "libs/beta", type: "lib", tags: ["layer:domain"] },
      ],
      dependencies: [{ source: "alpha", target: "beta", type: "static" }],
      workspaceLayout: DEFAULT_LAYOUT,
      workspaceLayoutSource: "default",
      coverage: { complete: true, imports: 3, analyzedFiles: 5, projects: 2 },
    });
    expect(report).toContain("2 projects");
    expect(report).toContain("alpha  libs/alpha  lib");
    expect(report).toContain("beta  libs/beta  lib [layer:domain]");
    expect(report).toContain("→ beta (static)");
    // beta has no outgoing edges
    expect(report).toContain("(no dependencies)");
  });

  it("states 'graph snapshot complete' when coverage is complete", () => {
    const report = formatGraphReport({
      projects: [],
      dependencies: [],
      workspaceLayout: DEFAULT_LAYOUT,
      workspaceLayoutSource: "default",
      coverage: { complete: true, imports: 0, analyzedFiles: 0, projects: 0 },
    });
    expect(report).toContain("graph snapshot complete");
    expect(report).toContain("0 imports in 0 files across 0 projects");
  });

  it("states 'graph snapshot incomplete' when coverage is not complete, naming the clause", () => {
    const report = formatGraphReport({
      projects: [],
      dependencies: [],
      workspaceLayout: DEFAULT_LAYOUT,
      workspaceLayoutSource: "default",
      coverage: {
        complete: false,
        notAnalyzed: [{ file: "x.go", reason: "err" }],
        imports: 0,
        analyzedFiles: 0,
        projects: 0,
      },
      coverageIncomplete: ["1 file could not be analyzed — coverage incomplete"],
    });
    expect(report).toContain("graph snapshot incomplete");
    // The clause carries the count; the headline no longer restates it — one
    // wording, and the same `⚠` rendering `check`'s text report prints.
    expect(report).toContain("⚠ 1 file could not be analyzed — coverage incomplete");
  });

  it("names the zero-analysis clause over an empty notAnalyzed list (#612)", () => {
    // The silent direction, at the renderer: an incomplete snapshot whose only
    // failed axis is "nothing was analyzed" has an empty `notAnalyzed` list,
    // so a count-bearing headline would blame zero failures. The clause line
    // is what tells the reader the run judged nothing.
    const report = formatGraphReport({
      projects: [{ name: "a", root: "libs/a", tags: [] }],
      dependencies: [],
      workspaceLayout: DEFAULT_LAYOUT,
      workspaceLayoutSource: "default",
      coverage: {
        complete: false,
        notAnalyzed: [],
        blindSpots: [],
        imports: 0,
        analyzedFiles: 0,
        projects: 1,
      },
      coverageIncomplete: ["no file in scope could be analyzed — coverage incomplete"],
    });
    expect(report).toContain("graph snapshot incomplete");
    expect(report).toContain("⚠ no file in scope could be analyzed — coverage incomplete");
    expect(report).not.toContain("0 files could not be analyzed");
  });

  it("puts the incomplete-coverage warning ABOVE the listing", () => {
    const report = formatGraphReport({
      projects: [{ name: "a", root: "libs/a", tags: [] }],
      dependencies: [],
      workspaceLayout: DEFAULT_LAYOUT,
      workspaceLayoutSource: "default",
      coverage: {
        complete: false,
        notAnalyzed: [{ file: "x.go", reason: "err" }],
        imports: 0,
        analyzedFiles: 0,
        projects: 1,
      },
    });
    const incompleteIndex = report.indexOf("graph snapshot incomplete");
    const projectIndex = report.indexOf("libs/a");
    expect(incompleteIndex).toBeLessThan(projectIndex);
  });

  it("shows the workspace layout with its source", () => {
    const declared = formatGraphReport({
      projects: [],
      dependencies: [],
      workspaceLayout: { appsDir: "apps", libsDir: "packages" },
      workspaceLayoutSource: "declared",
      coverage: { complete: true, imports: 0, analyzedFiles: 0, projects: 0 },
    });
    expect(declared).toContain("layout apps/packages (declared in workspace)");

    const defaultReport = formatGraphReport({
      projects: [],
      dependencies: [],
      workspaceLayout: DEFAULT_LAYOUT,
      workspaceLayoutSource: "default",
      coverage: { complete: true, imports: 0, analyzedFiles: 0, projects: 0 },
    });
    expect(defaultReport).toContain("layout apps/libs (default)");
  });

  it("shows tags only when the project has them", () => {
    const withTags = formatGraphReport({
      projects: [{ name: "a", root: "libs/a", tags: ["scope:core", "layer:domain"] }],
      dependencies: [],
      workspaceLayout: DEFAULT_LAYOUT,
      workspaceLayoutSource: "default",
      coverage: { complete: true, imports: 0, analyzedFiles: 0, projects: 1 },
    });
    expect(withTags).toContain("a  libs/a [scope:core, layer:domain]");

    const withoutTags = formatGraphReport({
      projects: [{ name: "a", root: "libs/a", tags: [] }],
      dependencies: [],
      workspaceLayout: DEFAULT_LAYOUT,
      workspaceLayoutSource: "default",
      coverage: { complete: true, imports: 0, analyzedFiles: 0, projects: 1 },
    });
    expect(withoutTags).toContain("a  libs/a");
    expect(withoutTags).not.toContain("[]");
  });

  it("shows the flat edge count at the end", () => {
    const report = formatGraphReport({
      projects: [{ name: "a", root: "libs/a", tags: [] }],
      dependencies: [
        { source: "a", target: "b", type: "static" },
        { source: "a", target: "c", type: "dynamic" },
      ],
      workspaceLayout: DEFAULT_LAYOUT,
      workspaceLayoutSource: "default",
      coverage: { complete: true, imports: 2, analyzedFiles: 3, projects: 1 },
    });
    expect(report).toContain("2 edges");
  });
});
