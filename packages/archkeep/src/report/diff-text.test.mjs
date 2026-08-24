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

  it("shows boundary violations introduced by the diff", () => {
    const report = formatDiffReport({
      diff: {
        baseline: { path: "/snap.json", projects: 2, edges: 0 },
        head: { projects: 2, edges: 1 },
        addedProjects: [],
        removedProjects: [],
        addedEdges: [{ source: "domain", target: "app", type: "static" }],
        removedEdges: [],
        ruleImpact: {
          introduced: [
            {
              messageId: "onlyTagsConstraintViolation",
              source: "domain",
              target: "app",
              constraint: { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
            },
          ],
          resolved: [],
        },
      },
      coverage: { imports: 1, analyzedFiles: 1, projects: 2 },
    });
    expect(report).toContain("1 boundary violation introduced");
    expect(report).toContain("domain → app  onlyTagsConstraintViolation  [layer:domain]");
  });

  it("shows boundary violations resolved by the diff", () => {
    const report = formatDiffReport({
      diff: {
        baseline: { path: "/snap.json", projects: 2, edges: 1 },
        head: { projects: 2, edges: 0 },
        addedProjects: [],
        removedProjects: [],
        addedEdges: [],
        removedEdges: [{ source: "domain", target: "app", type: "static" }],
        ruleImpact: {
          introduced: [],
          resolved: [
            {
              messageId: "onlyTagsConstraintViolation",
              source: "domain",
              target: "app",
              constraint: { sourceTag: "layer:domain" },
            },
          ],
        },
      },
      coverage: { imports: 0, analyzedFiles: 0, projects: 2 },
    });
    expect(report).toContain("1 boundary violation resolved");
    expect(report).toContain("domain → app  onlyTagsConstraintViolation  [layer:domain]");
  });

  it("shows 'no boundary-rule impact' when rule impact exists but found no violations", () => {
    const report = formatDiffReport({
      diff: {
        baseline: { path: "/snap.json", projects: 2, edges: 0 },
        head: { projects: 2, edges: 1 },
        addedProjects: [],
        removedProjects: [],
        addedEdges: [{ source: "domain", target: "util", type: "static" }],
        removedEdges: [],
        ruleImpact: { introduced: [], resolved: [] },
      },
      coverage: { imports: 1, analyzedFiles: 1, projects: 2 },
    });
    expect(report).toContain("no boundary-rule impact");
  });

  it("omits boundary-rule section when ruleImpact is absent", () => {
    const report = formatDiffReport({
      diff: {
        baseline: { path: "/snap.json", projects: 2, edges: 0 },
        head: { projects: 2, edges: 1 },
        addedProjects: [],
        removedProjects: [],
        addedEdges: [{ source: "a", target: "b", type: "static" }],
        removedEdges: [],
      },
      coverage: { imports: 1, analyzedFiles: 1, projects: 2 },
    });
    expect(report).not.toContain("boundary");
    expect(report).not.toContain("rule impact");
  });

  it("shows (no matching constraint) for a violation without constraint context", () => {
    const report = formatDiffReport({
      diff: {
        baseline: { path: "/snap.json", projects: 2, edges: 0 },
        head: { projects: 2, edges: 1 },
        addedProjects: [],
        removedProjects: [],
        addedEdges: [{ source: "untagged", target: "domain", type: "static" }],
        removedEdges: [],
        ruleImpact: {
          introduced: [
            {
              messageId: "projectWithoutTagsCannotHaveDependencies",
              source: "untagged",
              target: "domain",
              constraint: null,
            },
          ],
          resolved: [],
        },
      },
      coverage: { imports: 1, analyzedFiles: 1, projects: 2 },
    });
    expect(report).toContain("(no matching constraint)");
  });

  it("shows 'no boundary-rule impact' when ruleImpact exists with no structural changes", () => {
    // Bug 1 regression: the rule-impact section was hidden inside hasChanges,
    // so a config-provided diff with no structural changes silently omitted
    // the "no boundary-rule impact" line — indistinguishable from "no config".
    const report = formatDiffReport({
      diff: {
        baseline: { path: "/snap.json", projects: 2, edges: 1 },
        head: { projects: 2, edges: 1 },
        addedProjects: [],
        removedProjects: [],
        addedEdges: [],
        removedEdges: [],
        ruleImpact: { introduced: [], resolved: [] },
      },
      coverage: { imports: 1, analyzedFiles: 1, projects: 2 },
    });
    expect(report).toContain("no boundary-rule impact");
    expect(report).toContain("no changes between baseline and head");
    // The rule-impact section and the "no changes" line both appear —
    // the reader can tell "config provided, no impact" from "no config".
  });

  it("omits boundary-rule section when ruleImpact is absent even with structural changes", () => {
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
    expect(report).not.toContain("boundary");
    expect(report).not.toContain("rule impact");
    expect(report).toContain("2 changes between baseline and head");
  });

  it("shows changed projects with field-level before → after values", () => {
    const report = formatDiffReport({
      diff: {
        baseline: { path: "/snap.json", projects: 1, edges: 0 },
        head: { projects: 1, edges: 0 },
        addedProjects: [],
        removedProjects: [],
        changedProjects: [
          {
            name: "alpha",
            changes: [{ field: "tags", baseline: ["layer:domain"], head: ["layer:adapter"] }],
          },
        ],
        addedEdges: [],
        removedEdges: [],
      },
      coverage: { imports: 0, analyzedFiles: 0, projects: 1 },
    });
    expect(report).toContain("~ 1 changed project");
    expect(report).toContain("alpha");
    expect(report).toContain("tags  layer:domain → layer:adapter");
  });

  it("shows multiple metadata changes on one project", () => {
    const report = formatDiffReport({
      diff: {
        baseline: { path: "/snap.json", projects: 1, edges: 0 },
        head: { projects: 1, edges: 0 },
        addedProjects: [],
        removedProjects: [],
        changedProjects: [
          {
            name: "alpha",
            changes: [
              { field: "tags", baseline: ["layer:domain"], head: ["layer:adapter"] },
              { field: "type", baseline: "lib", head: "app" },
            ],
          },
        ],
        addedEdges: [],
        removedEdges: [],
      },
      coverage: { imports: 0, analyzedFiles: 0, projects: 1 },
    });
    expect(report).toContain("~ 1 changed project");
    expect(report).toContain("tags  layer:domain → layer:adapter");
    expect(report).toContain("type  lib → app");
  });

  it("uses plural 'projects' for multiple changed projects", () => {
    const report = formatDiffReport({
      diff: {
        baseline: { path: "/snap.json", projects: 2, edges: 0 },
        head: { projects: 2, edges: 0 },
        addedProjects: [],
        removedProjects: [],
        changedProjects: [
          { name: "a", changes: [{ field: "tags", baseline: [], head: ["layer:domain"] }] },
          { name: "b", changes: [{ field: "tags", baseline: [], head: ["layer:adapter"] }] },
        ],
        addedEdges: [],
        removedEdges: [],
      },
      coverage: { imports: 0, analyzedFiles: 0, projects: 2 },
    });
    expect(report).toContain("~ 2 changed projects");
  });

  it("omits changed-projects section when there are none", () => {
    const report = formatDiffReport({
      diff: {
        baseline: { path: "/snap.json", projects: 1, edges: 0 },
        head: { projects: 1, edges: 0 },
        addedProjects: [],
        removedProjects: [],
        addedEdges: [],
        removedEdges: [],
      },
      coverage: { imports: 0, analyzedFiles: 0, projects: 1 },
    });
    expect(report).not.toContain("changed project");
  });

  it("counts changed projects in the total changes summary", () => {
    const report = formatDiffReport({
      diff: {
        baseline: { path: "/snap.json", projects: 1, edges: 0 },
        head: { projects: 1, edges: 1 },
        addedProjects: [],
        removedProjects: [],
        changedProjects: [
          { name: "a", changes: [{ field: "tags", baseline: [], head: ["layer:domain"] }] },
        ],
        addedEdges: [{ source: "a", target: "b", type: "static" }],
        removedEdges: [],
      },
      coverage: { imports: 1, analyzedFiles: 1, projects: 1 },
    });
    expect(report).toContain("2 changes between baseline and head");
  });

  it("shows (none) for empty tag arrays in changed project output", () => {
    const report = formatDiffReport({
      diff: {
        baseline: { path: "/snap.json", projects: 1, edges: 0 },
        head: { projects: 1, edges: 0 },
        addedProjects: [],
        removedProjects: [],
        changedProjects: [
          {
            name: "alpha",
            changes: [{ field: "tags", baseline: [], head: ["layer:domain"] }],
          },
        ],
        addedEdges: [],
        removedEdges: [],
      },
      coverage: { imports: 0, analyzedFiles: 0, projects: 1 },
    });
    expect(report).toContain("tags  (none) → layer:domain");
  });

  it("shows (none) for null type values in changed project output", () => {
    const report = formatDiffReport({
      diff: {
        baseline: { path: "/snap.json", projects: 1, edges: 0 },
        head: { projects: 1, edges: 0 },
        addedProjects: [],
        removedProjects: [],
        changedProjects: [
          {
            name: "alpha",
            changes: [{ field: "type", baseline: null, head: "lib" }],
          },
        ],
        addedEdges: [],
        removedEdges: [],
      },
      coverage: { imports: 0, analyzedFiles: 0, projects: 1 },
    });
    expect(report).toContain("type  (none) → lib");
  });

  // Bug B: `../commands/diff.mjs` pushes provider-mismatch, cross-repo,
  // one-sided-policy, and rule-impact-scope warnings onto `coverage.notes` —
  // the same object this formatter already receives whole — but this
  // formatter never read that field, so a diff run carrying a real warning
  // (in the JSON envelope) showed a clean "no changes" text report with no
  // trace of it. The silent direction: a warning that exists in the coverage
  // object and never reaches the reader.
  it("folds coverage.notes into the summary line, the way check's text face folds its own notes", () => {
    const report = formatDiffReport({
      diff: {
        baseline: { path: "/snap.json", projects: 2, edges: 1 },
        head: { projects: 2, edges: 1 },
        addedProjects: [],
        removedProjects: [],
        addedEdges: [],
        removedEdges: [],
      },
      coverage: {
        imports: 3,
        analyzedFiles: 4,
        projects: 2,
        notes: ["baseline provider (nx) differs from head provider (moon)"],
      },
    });
    expect(report).toContain(
      "no changes between baseline and head (3 imports in 4 files across 2 projects; " +
        "baseline provider (nx) differs from head provider (moon))",
    );
  });

  it("folds multiple coverage.notes onto the same line, semicolon-joined", () => {
    const report = formatDiffReport({
      diff: {
        baseline: { path: "/snap.json", projects: 1, edges: 0 },
        head: { projects: 2, edges: 0 },
        addedProjects: [{ name: "beta", root: "libs/beta", tags: [] }],
        removedProjects: [],
        addedEdges: [],
        removedEdges: [],
      },
      coverage: {
        imports: 0,
        analyzedFiles: 0,
        projects: 2,
        notes: ["note one", "note two"],
      },
    });
    expect(report).toContain("(0 imports in 0 files across 2 projects; note one; note two)");
  });
});
