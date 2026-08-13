import { describe, expect, it } from "vitest";

import { formatDiffReport } from "./diff-text.mjs";

/**
 * What the diff report guarantees: "no changes" is a claim about a complete
 * comparison, not silence, and sections with zero entries are absent from the
 * report so that "no changes" and "0 added, 0 removed" can never look
 * identical (AGENTS.md: "an empty result is a claim, not a shrug").
 */

describe("formatDiffReport", () => {
  it("shows baseline and head project/edge counts", () => {
    const report = formatDiffReport({
      diff: {
        baseline: { path: "/snap.json", projects: 3, edges: 5 },
        head: { projects: 4, edges: 7 },
        addedProjects: [],
        removedProjects: [],
        addedEdges: [],
        removedEdges: [],
      },
      coverage: { imports: 10, analyzedFiles: 8, projects: 4 },
    });
    expect(report).toContain("baseline  /snap.json — 3 projects, 5 edges");
    expect(report).toContain("head      4 projects, 7 edges");
  });

  it("states 'no changes between baseline and head' when the diff is empty", () => {
    const report = formatDiffReport({
      diff: {
        baseline: { path: "/snap.json", projects: 2, edges: 1 },
        head: { projects: 2, edges: 1 },
        addedProjects: [],
        removedProjects: [],
        addedEdges: [],
        removedEdges: [],
      },
      coverage: { imports: 3, analyzedFiles: 4, projects: 2 },
    });
    expect(report).toContain("no changes between baseline and head");
    expect(report).toContain("3 imports in 4 files across 2 projects");
  });

  it("shows added projects with a count and list", () => {
    const report = formatDiffReport({
      diff: {
        baseline: { path: "/snap.json", projects: 1, edges: 0 },
        head: { projects: 2, edges: 0 },
        addedProjects: [{ name: "beta", root: "libs/beta", tags: ["layer:domain"] }],
        removedProjects: [],
        addedEdges: [],
        removedEdges: [],
      },
      coverage: { imports: 0, analyzedFiles: 0, projects: 2 },
    });
    expect(report).toContain("+ 1 added project");
    expect(report).toContain("beta  libs/beta [layer:domain]");
  });

  it("shows removed projects with a count and list", () => {
    const report = formatDiffReport({
      diff: {
        baseline: { path: "/snap.json", projects: 2, edges: 0 },
        head: { projects: 1, edges: 0 },
        addedProjects: [],
        removedProjects: [{ name: "beta", root: "libs/beta", tags: [] }],
        addedEdges: [],
        removedEdges: [],
      },
      coverage: { imports: 0, analyzedFiles: 0, projects: 1 },
    });
    expect(report).toContain("- 1 removed project");
    expect(report).toContain("beta  libs/beta");
  });

  it("shows added edges with a count and list", () => {
    const report = formatDiffReport({
      diff: {
        baseline: { path: "/snap.json", projects: 1, edges: 0 },
        head: { projects: 1, edges: 1 },
        addedProjects: [],
        removedProjects: [],
        addedEdges: [{ source: "a", target: "b", type: "static" }],
        removedEdges: [],
      },
      coverage: { imports: 1, analyzedFiles: 1, projects: 1 },
    });
    expect(report).toContain("+ 1 added edge");
    expect(report).toContain("a → b (static)");
  });

  it("shows removed edges with a count and list", () => {
    const report = formatDiffReport({
      diff: {
        baseline: { path: "/snap.json", projects: 1, edges: 1 },
        head: { projects: 1, edges: 0 },
        addedProjects: [],
        removedProjects: [],
        addedEdges: [],
        removedEdges: [{ source: "a", target: "b", type: "dynamic" }],
      },
      coverage: { imports: 0, analyzedFiles: 0, projects: 1 },
    });
    expect(report).toContain("- 1 removed edge");
    expect(report).toContain("a → b (dynamic)");
  });

  it("states the total change count in the summary when there are changes", () => {
    const report = formatDiffReport({
      diff: {
        baseline: { path: "/snap.json", projects: 1, edges: 0 },
        head: { projects: 2, edges: 1 },
        addedProjects: [{ name: "b", root: "libs/b", tags: [] }],
        removedProjects: [],
        addedEdges: [{ source: "a", target: "b", type: "static" }],
        removedEdges: [],
      },
      coverage: { imports: 1, analyzedFiles: 1, projects: 2 },
    });
    expect(report).toContain("2 changes between baseline and head");
  });

  it("omits empty sections entirely (they would look identical to 'no changes')", () => {
    const report = formatDiffReport({
      diff: {
        baseline: { path: "/snap.json", projects: 2, edges: 1 },
        head: { projects: 2, edges: 1 },
        addedProjects: [],
        removedProjects: [],
        addedEdges: [],
        removedEdges: [],
      },
      coverage: { imports: 0, analyzedFiles: 0, projects: 2 },
    });
    expect(report).not.toContain("+ 0 added");
    expect(report).not.toContain("- 0 removed");
  });

  it("uses plural forms for counts other than 1", () => {
    const report = formatDiffReport({
      diff: {
        baseline: { path: "/snap.json", projects: 1, edges: 0 },
        head: { projects: 3, edges: 2 },
        addedProjects: [
          { name: "b", root: "libs/b", tags: [] },
          { name: "c", root: "libs/c", tags: [] },
        ],
        removedProjects: [],
        addedEdges: [
          { source: "a", target: "b", type: "static" },
          { source: "a", target: "c", type: "dynamic" },
        ],
        removedEdges: [],
      },
      coverage: { imports: 2, analyzedFiles: 3, projects: 3 },
    });
    expect(report).toContain("+ 2 added projects");
    expect(report).toContain("+ 2 added edges");
  });
});
