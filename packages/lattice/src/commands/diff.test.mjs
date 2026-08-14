import { describe, expect, it } from "vitest";

import { computeDiff, diffCommand, parseBaseline } from "./diff.mjs";
import { computePolicyFingerprint } from "./graph.mjs";
import { SCHEMA_VERSION } from "../report/json.mjs";

/**
 * What `diff` guarantees: a complete, honest comparison between two graph
 * snapshots, refusing to run when either side is incomplete (because every
 * "removed" or "added" entry would then be ambiguous between a real change
 * and a coverage gap).
 *
 * The "empty result is a claim" invariant is tested here: a diff that
 * reports "no changes" must be comparing two complete graphs, and a diff
 * that cannot must refuse loudly rather than silently under-report.
 */

// ---------------------------------------------------------------------------
// parseBaseline
// ---------------------------------------------------------------------------

describe("parseBaseline", () => {
  function validEnvelope(overrides = {}) {
    return JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      command: "graph",
      coverage: { complete: true, projects: 2, analyzedFiles: 4, imports: 3, notAnalyzed: [] },
      result: {
        projects: [{ name: "a", root: "libs/a", tags: [] }],
        dependencies: [{ source: "a", target: "b", type: "static" }],
      },
      ...overrides,
    });
  }

  it("returns the projects, dependencies, and coverage from a valid envelope", () => {
    const { projects, dependencies, coverage } = parseBaseline(validEnvelope(), "/baseline.json");
    expect(projects).toEqual([{ name: "a", root: "libs/a", tags: [] }]);
    expect(dependencies).toEqual([{ source: "a", target: "b", type: "static" }]);
    expect(coverage.complete).toBe(true);
  });

  it("throws when the text is not valid JSON", () => {
    expect(() => parseBaseline("not json", "/bad.json")).toThrow(/not valid JSON/);
  });

  it("throws when the envelope has no schemaVersion", () => {
    const envelope = JSON.stringify({ command: "graph", coverage: { complete: true } });
    expect(() => parseBaseline(envelope, "/no-version.json")).toThrow(/no schemaVersion field/);
  });

  it("throws when the schemaVersion does not match the tool's current version", () => {
    const envelope = validEnvelope({ schemaVersion: 999 });
    expect(() => parseBaseline(envelope, "/wrong-version.json")).toThrow(
      new RegExp(
        `schemaVersion 999.*but this build only understands schemaVersion ${SCHEMA_VERSION}`,
      ),
    );
  });

  it("throws when the envelope is not a 'graph' command", () => {
    const envelope = validEnvelope({ command: "check" });
    expect(() => parseBaseline(envelope, "/not-graph.json")).toThrow(/not a 'graph' envelope/);
  });

  it("throws when the baseline has incomplete coverage", () => {
    const envelope = validEnvelope({
      coverage: {
        complete: false,
        projects: 2,
        analyzedFiles: 2,
        imports: 1,
        notAnalyzed: [{ file: "x.go", reason: "err" }],
      },
    });
    expect(() => parseBaseline(envelope, "/incomplete.json")).toThrow(/incomplete coverage/);
  });

  it("throws when the baseline has no result.projects array", () => {
    const envelope = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      command: "graph",
      coverage: { complete: true, projects: 0, analyzedFiles: 0, imports: 0, notAnalyzed: [] },
      result: { dependencies: [] },
    });
    expect(() => parseBaseline(envelope, "/no-projects.json")).toThrow(/no result\.projects array/);
  });

  it("throws when the top-level value is null", () => {
    expect(() => parseBaseline("null", "/null.json")).toThrow(/not a JSON object/);
  });

  it("throws when the top-level value is an array", () => {
    expect(() => parseBaseline("[]", "/array.json")).toThrow(/not a JSON object/);
  });

  it("throws when the top-level value is a primitive", () => {
    expect(() => parseBaseline("42", "/number.json")).toThrow(/not a JSON object/);
  });

  it("throws when the baseline has no result.dependencies array", () => {
    const envelope = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      command: "graph",
      coverage: { complete: true, projects: 1, analyzedFiles: 1, imports: 0, notAnalyzed: [] },
      result: { projects: [{ name: "a", root: "libs/a" }] },
    });
    expect(() => parseBaseline(envelope, "/no-deps.json")).toThrow(/no result\.dependencies array/);
  });

  it("throws when a project record is missing 'name'", () => {
    const envelope = validEnvelope({
      result: {
        projects: [{ root: "libs/a", tags: [] }],
        dependencies: [],
      },
    });
    expect(() => parseBaseline(envelope, "/bad-project.json")).toThrow(
      /result\.projects\[0\].*missing 'name' or 'root'/,
    );
  });

  it("throws when a project record is missing 'root'", () => {
    const envelope = validEnvelope({
      result: {
        projects: [{ name: "a", tags: [] }],
        dependencies: [],
      },
    });
    expect(() => parseBaseline(envelope, "/bad-project.json")).toThrow(
      /result\.projects\[0\].*missing 'name' or 'root'/,
    );
  });

  it("throws when a dependency record is missing 'source'", () => {
    const envelope = validEnvelope({
      result: {
        projects: [{ name: "a", root: "libs/a", tags: [] }],
        dependencies: [{ target: "b", type: "static" }],
      },
    });
    expect(() => parseBaseline(envelope, "/bad-dep.json")).toThrow(
      /result\.dependencies\[0\].*missing 'source', 'target', or 'type'/,
    );
  });

  it("throws when a dependency record is missing 'type'", () => {
    const envelope = validEnvelope({
      result: {
        projects: [{ name: "a", root: "libs/a", tags: [] }],
        dependencies: [{ source: "a", target: "b" }],
      },
    });
    expect(() => parseBaseline(envelope, "/bad-dep.json")).toThrow(
      /result\.dependencies\[0\].*missing 'source', 'target', or 'type'/,
    );
  });
});

// ---------------------------------------------------------------------------
// computeDiff
// ---------------------------------------------------------------------------

describe("computeDiff", () => {
  it("reports no changes when baseline and head are identical", () => {
    const snapshot = {
      projects: [{ name: "a", root: "libs/a", tags: [] }],
      dependencies: [{ source: "a", target: "b", type: "static" }],
    };
    const diff = computeDiff(snapshot, snapshot);
    expect(diff.addedProjects).toEqual([]);
    expect(diff.removedProjects).toEqual([]);
    expect(diff.addedEdges).toEqual([]);
    expect(diff.removedEdges).toEqual([]);
  });

  it("detects added and removed projects", () => {
    const baseline = {
      projects: [{ name: "a", root: "libs/a", tags: [] }],
      dependencies: [],
    };
    const head = {
      projects: [
        { name: "a", root: "libs/a", tags: [] },
        { name: "b", root: "libs/b", tags: ["layer:domain"] },
      ],
      dependencies: [],
    };
    const diff = computeDiff(baseline, head);
    expect(diff.addedProjects).toEqual([{ name: "b", root: "libs/b", tags: ["layer:domain"] }]);
    expect(diff.removedProjects).toEqual([]);
  });

  it("detects removed projects", () => {
    const baseline = {
      projects: [
        { name: "a", root: "libs/a", tags: [] },
        { name: "b", root: "libs/b", tags: [] },
      ],
      dependencies: [],
    };
    const head = {
      projects: [{ name: "a", root: "libs/a", tags: [] }],
      dependencies: [],
    };
    const diff = computeDiff(baseline, head);
    expect(diff.addedProjects).toEqual([]);
    expect(diff.removedProjects).toEqual([{ name: "b", root: "libs/b", tags: [] }]);
  });

  it("detects added and removed edges", () => {
    const baseline = {
      projects: [{ name: "a", root: "libs/a", tags: [] }],
      dependencies: [{ source: "a", target: "b", type: "static" }],
    };
    const head = {
      projects: [{ name: "a", root: "libs/a", tags: [] }],
      dependencies: [{ source: "a", target: "c", type: "static" }],
    };
    const diff = computeDiff(baseline, head);
    expect(diff.addedEdges).toEqual([{ source: "a", target: "c", type: "static" }]);
    expect(diff.removedEdges).toEqual([{ source: "a", target: "b", type: "static" }]);
  });

  it("treats a type change as an added edge under the new type and a removed edge under the old", () => {
    const baseline = {
      projects: [{ name: "a", root: "libs/a", tags: [] }],
      dependencies: [{ source: "a", target: "b", type: "static" }],
    };
    const head = {
      projects: [{ name: "a", root: "libs/a", tags: [] }],
      dependencies: [{ source: "a", target: "b", type: "dynamic" }],
    };
    const diff = computeDiff(baseline, head);
    expect(diff.addedEdges).toEqual([{ source: "a", target: "b", type: "dynamic" }]);
    expect(diff.removedEdges).toEqual([{ source: "a", target: "b", type: "static" }]);
  });

  it("sorts all result arrays deterministically by plain string comparison", () => {
    const baseline = {
      projects: [],
      dependencies: [],
    };
    const head = {
      projects: [
        { name: "z", root: "libs/z", tags: [] },
        { name: "a", root: "libs/a", tags: [] },
      ],
      dependencies: [
        { source: "z", target: "a", type: "static" },
        { source: "a", target: "z", type: "dynamic" },
      ],
    };
    const diff = computeDiff(baseline, head);
    expect(diff.addedProjects.map((p) => p.name)).toEqual(["a", "z"]);
    expect(diff.addedEdges[0].source).toBe("a");
    expect(diff.addedEdges[1].source).toBe("z");
  });

  it("detects tag changes on a project that exists in both baseline and head", () => {
    const baseline = {
      projects: [{ name: "a", root: "libs/a", tags: ["layer:domain"] }],
      dependencies: [],
    };
    const head = {
      projects: [{ name: "a", root: "libs/a", tags: ["layer:adapter"] }],
      dependencies: [],
    };
    const diff = computeDiff(baseline, head);
    expect(diff.changedProjects).toEqual([
      {
        name: "a",
        changes: [{ field: "tags", baseline: ["layer:domain"], head: ["layer:adapter"] }],
      },
    ]);
    expect(diff.addedProjects).toEqual([]);
    expect(diff.removedProjects).toEqual([]);
  });

  it("detects type changes on a project", () => {
    const baseline = {
      projects: [{ name: "a", root: "libs/a", type: "lib", tags: [] }],
      dependencies: [],
    };
    const head = {
      projects: [{ name: "a", root: "libs/a", type: "app", tags: [] }],
      dependencies: [],
    };
    const diff = computeDiff(baseline, head);
    expect(diff.changedProjects).toEqual([
      { name: "a", changes: [{ field: "type", baseline: "lib", head: "app" }] },
    ]);
  });

  it("detects root changes on a project", () => {
    const baseline = {
      projects: [{ name: "a", root: "libs/a", tags: [] }],
      dependencies: [],
    };
    const head = {
      projects: [{ name: "a", root: "packages/a", tags: [] }],
      dependencies: [],
    };
    const diff = computeDiff(baseline, head);
    expect(diff.changedProjects).toEqual([
      { name: "a", changes: [{ field: "root", baseline: "libs/a", head: "packages/a" }] },
    ]);
  });

  it("detects multiple metadata changes on the same project", () => {
    const baseline = {
      projects: [{ name: "a", root: "libs/a", type: "lib", tags: ["layer:domain"] }],
      dependencies: [],
    };
    const head = {
      projects: [{ name: "a", root: "packages/a", type: "app", tags: ["layer:adapter"] }],
      dependencies: [],
    };
    const diff = computeDiff(baseline, head);
    expect(diff.changedProjects).toHaveLength(1);
    expect(diff.changedProjects[0].name).toBe("a");
    const fields = diff.changedProjects[0].changes.map((c) => c.field);
    expect(fields).toEqual(["tags", "type", "root"]);
  });

  it("does not report a changed project when tags and type are identical", () => {
    const baseline = {
      projects: [{ name: "a", root: "libs/a", type: "lib", tags: ["layer:domain"] }],
      dependencies: [],
    };
    const head = {
      projects: [{ name: "a", root: "libs/a", type: "lib", tags: ["layer:domain"] }],
      dependencies: [],
    };
    const diff = computeDiff(baseline, head);
    expect(diff.changedProjects).toEqual([]);
  });

  it("treats missing tags as an empty array", () => {
    const baseline = {
      projects: [{ name: "a", root: "libs/a" }],
      dependencies: [],
    };
    const head = {
      projects: [{ name: "a", root: "libs/a", tags: ["layer:domain"] }],
      dependencies: [],
    };
    const diff = computeDiff(baseline, head);
    expect(diff.changedProjects).toEqual([
      { name: "a", changes: [{ field: "tags", baseline: [], head: ["layer:domain"] }] },
    ]);
  });

  it("sorts changed projects by name", () => {
    const baseline = {
      projects: [
        { name: "z", root: "libs/z", tags: ["layer:domain"] },
        { name: "a", root: "libs/a", tags: ["layer:domain"] },
      ],
      dependencies: [],
    };
    const head = {
      projects: [
        { name: "z", root: "libs/z", tags: ["layer:adapter"] },
        { name: "a", root: "libs/a", tags: ["layer:adapter"] },
      ],
      dependencies: [],
    };
    const diff = computeDiff(baseline, head);
    expect(diff.changedProjects.map((p) => p.name)).toEqual(["a", "z"]);
  });
});

// ---------------------------------------------------------------------------
// diffCommand
// ---------------------------------------------------------------------------

describe("diffCommand", () => {
  /** Build a valid baseline envelope for the injectable reader. */
  function baselineEnvelope(overrides = {}) {
    return {
      projects: [{ name: "alpha", root: "libs/alpha", tags: ["layer:domain"] }],
      dependencies: [{ source: "alpha", target: "beta", type: "static" }],
      coverage: { complete: true, projects: 1, analyzedFiles: 2, imports: 1, notAnalyzed: [] },
      ...overrides,
    };
  }

  /** Minimal command context for the head. */
  function commandContext(overrides = {}) {
    return {
      root: "/workspace",
      provider: "native",
      marker: "lattice.json",
      graph: {
        nodes: {
          alpha: {
            name: "alpha",
            type: "lib",
            data: { root: "libs/alpha", tags: ["layer:domain"] },
          },
          beta: {
            name: "beta",
            type: "lib",
            data: { root: "libs/beta" },
          },
        },
        dependencies: {
          alpha: [{ target: "beta", type: "static" }],
        },
      },
      analysis: {
        analyzed: 4,
        imports: [{ sourceFile: "libs/alpha/a.go", specifier: "beta", line: 1, column: 1 }],
        failures: [],
      },
      pluginGap: { registered: true, manifests: [] },
      ...overrides,
    };
  }

  it("returns 'ok' status and a diff between two complete snapshots", () => {
    const result = diffCommand("/baseline.json", commandContext(), {
      readBaseline: () => baselineEnvelope(),
    });
    expect(result.status).toBe("ok");
    expect(result.diff.baseline.projects).toBe(1);
    expect(result.diff.head.projects).toBe(2);
    expect(result.diff.addedProjects).toEqual([
      { name: "beta", root: "libs/beta", type: "lib", tags: [] },
    ]);
    expect(result.diff.removedProjects).toEqual([]);
    expect(result.diff.addedEdges).toEqual([]);
    expect(result.diff.removedEdges).toEqual([]);
  });

  it("reports added and removed edges", () => {
    const baseline = baselineEnvelope({
      dependencies: [
        { source: "alpha", target: "beta", type: "static" },
        { source: "alpha", target: "gamma", type: "dynamic" },
      ],
    });
    // Head drops the alpha→gamma dynamic edge, adds alpha→beta dynamic.
    const ctx = commandContext({
      graph: {
        nodes: {
          alpha: {
            name: "alpha",
            type: "lib",
            data: { root: "libs/alpha" },
            tags: ["layer:domain"],
          },
          beta: { name: "beta", type: "lib", data: { root: "libs/beta" } },
        },
        dependencies: {
          alpha: [
            { target: "beta", type: "static" },
            { target: "beta", type: "dynamic" },
          ],
        },
      },
    });
    const result = diffCommand("/baseline.json", ctx, { readBaseline: () => baseline });
    expect(result.diff.addedEdges).toEqual([{ source: "alpha", target: "beta", type: "dynamic" }]);
    expect(result.diff.removedEdges).toEqual([
      { source: "alpha", target: "gamma", type: "dynamic" },
    ]);
  });

  it("throws when the plugin is unregistered on a polyglot Nx workspace", () => {
    expect(() =>
      diffCommand(
        "/baseline.json",
        commandContext({
          provider: "nx",
          pluginGap: { registered: false, manifests: ["libs/alpha/go.mod"] },
        }),
        { readBaseline: () => baselineEnvelope() },
      ),
    ).toThrow(/refusing to compute a diff/);
  });

  it("throws when the head has incomplete coverage (whole-file failures)", () => {
    expect(() =>
      diffCommand(
        "/baseline.json",
        commandContext({
          analysis: {
            analyzed: 3,
            imports: [],
            failures: [
              {
                sourceFile: "libs/beta/broken.go",
                line: null,
                column: null,
                reason: "parse error",
              },
            ],
          },
        }),
        { readBaseline: () => baselineEnvelope() },
      ),
    ).toThrow(/head graph has incomplete coverage/);
  });

  it("produces both text and JSON report renderings", () => {
    const result = diffCommand("/baseline.json", commandContext(), {
      readBaseline: () => baselineEnvelope(),
    });
    expect(result.report.text).toContain("baseline");
    expect(result.report.text).toContain("head");
    expect(result.report.json).toContain('"schemaVersion"');
    expect(result.report.json).toContain('"command": "diff"');
  });

  it("never exits 1 — diff is descriptive, not a finding", () => {
    const result = diffCommand("/baseline.json", commandContext(), {
      readBaseline: () => baselineEnvelope(),
    });
    expect(result.status).toBe("ok");
  });

  it("throws when readBaseline fails (baseline cannot be read)", () => {
    expect(() =>
      diffCommand("/missing.json", commandContext(), {
        readBaseline: () => {
          throw new Error(
            "lattice: cannot read the baseline snapshot from '/missing.json': ENOENT",
          );
        },
      }),
    ).toThrow(/cannot read the baseline snapshot/);
  });

  it("includes blind spots in coverage from non-whole-file failures", () => {
    const result = diffCommand(
      "/baseline.json",
      commandContext({
        analysis: {
          analyzed: 4,
          imports: [],
          failures: [
            { sourceFile: "libs/alpha/a.go", line: 7, column: 2, reason: "unresolvable specifier" },
          ],
        },
      }),
      { readBaseline: () => baselineEnvelope() },
    );
    expect(result.coverage.blindSpots).toEqual([
      { file: "libs/alpha/a.go", line: 7, column: 2, reason: "unresolvable specifier" },
    ]);
    // Not a whole-file failure, so coverage is still "complete" and the diff can run.
    expect(result.coverage.complete).toBe(true);
  });

  it("reports boundary violations introduced by added edges", () => {
    const baseline = baselineEnvelope({
      projects: [
        { name: "alpha", root: "libs/alpha", tags: ["layer:domain"] },
        { name: "beta", root: "libs/beta", tags: ["layer:util"] },
        { name: "gamma", root: "libs/gamma", tags: ["layer:app"] },
      ],
      dependencies: [{ source: "alpha", target: "beta", type: "static" }],
    });
    const ctx = commandContext({
      graph: {
        nodes: {
          alpha: {
            name: "alpha",
            type: "lib",
            data: { root: "libs/alpha", tags: ["layer:domain"] },
          },
          beta: {
            name: "beta",
            type: "lib",
            data: { root: "libs/beta", tags: ["layer:util"] },
          },
          gamma: {
            name: "gamma",
            type: "lib",
            data: { root: "libs/gamma", tags: ["layer:app"] },
          },
        },
        dependencies: {
          alpha: [
            { target: "beta", type: "static" },
            { target: "gamma", type: "static" },
          ],
        },
      },
    });
    const config = {
      depConstraints: [
        {
          sourceTag: "layer:domain",
          onlyDependOnLibsWithTags: ["layer:domain", "layer:util"],
          description: "Domain isolation",
          remediation: "Depend on a domain or utility project",
        },
      ],
    };
    const result = diffCommand("/baseline.json", ctx, {
      readBaseline: () => baseline,
      config,
    });

    expect(result.diff.ruleImpact.introduced).toHaveLength(1);
    expect(result.diff.ruleImpact.introduced[0].messageId).toBe("onlyTagsConstraintViolation");
    expect(result.diff.ruleImpact.introduced[0].source).toBe("alpha");
    expect(result.diff.ruleImpact.introduced[0].target).toBe("gamma");
    expect(result.diff.ruleImpact.introduced[0].constraint.description).toBe("Domain isolation");
    expect(result.report.text).toContain("boundary violation introduced");
    expect(result.report.text).toContain("alpha → gamma");

    const envelope = JSON.parse(result.report.json);
    expect(envelope.result.ruleImpact.introduced).toHaveLength(1);
  });

  it("reports boundary violations resolved by removed edges", () => {
    const baseline = baselineEnvelope({
      projects: [
        { name: "alpha", root: "libs/alpha", tags: ["layer:domain"] },
        { name: "gamma", root: "libs/gamma", tags: ["layer:app"] },
      ],
      dependencies: [{ source: "alpha", target: "gamma", type: "static" }],
    });
    const ctx = commandContext({
      graph: {
        nodes: {
          alpha: {
            name: "alpha",
            type: "lib",
            data: { root: "libs/alpha", tags: ["layer:domain"] },
          },
          gamma: {
            name: "gamma",
            type: "lib",
            data: { root: "libs/gamma", tags: ["layer:app"] },
          },
        },
        dependencies: { alpha: [] },
      },
    });
    const config = {
      depConstraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] }],
    };
    const result = diffCommand("/baseline.json", ctx, {
      readBaseline: () => baseline,
      config,
    });

    expect(result.diff.ruleImpact.resolved).toHaveLength(1);
    expect(result.diff.ruleImpact.resolved[0].messageId).toBe("onlyTagsConstraintViolation");
    expect(result.report.text).toContain("boundary violation resolved");
  });

  it("reports no boundary-rule impact when changed edges are allowed", () => {
    const baseline = baselineEnvelope({
      projects: [
        { name: "alpha", root: "libs/alpha", tags: ["layer:domain"] },
        { name: "beta", root: "libs/beta", tags: ["layer:util"] },
      ],
      dependencies: [],
    });
    const ctx = commandContext({
      graph: {
        nodes: {
          alpha: {
            name: "alpha",
            type: "lib",
            data: { root: "libs/alpha", tags: ["layer:domain"] },
          },
          beta: {
            name: "beta",
            type: "lib",
            data: { root: "libs/beta", tags: ["layer:util"] },
          },
        },
        dependencies: { alpha: [{ target: "beta", type: "static" }] },
      },
    });
    const config = {
      depConstraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:util"] }],
    };
    const result = diffCommand("/baseline.json", ctx, {
      readBaseline: () => baseline,
      config,
    });

    expect(result.diff.ruleImpact.introduced).toEqual([]);
    expect(result.diff.ruleImpact.resolved).toEqual([]);
    expect(result.report.text).toContain("no boundary-rule impact");
  });

  it("omits ruleImpact when no boundary config is provided", () => {
    const result = diffCommand("/baseline.json", commandContext(), {
      readBaseline: () => baselineEnvelope(),
    });
    expect(result.diff).not.toHaveProperty("ruleImpact");
  });

  it("includes ruleImpact with empty introduced/resolved when config is provided but no structural changes", () => {
    // Bug 1 regression: the renderer hid this section, but the command
    // must always produce ruleImpact when a boundary config is available,
    // so the renderer can show "no boundary-rule impact".
    const baseline = baselineEnvelope({
      projects: [
        { name: "alpha", root: "libs/alpha", tags: ["layer:domain"] },
        { name: "beta", root: "libs/beta", tags: ["layer:util"] },
      ],
      dependencies: [{ source: "alpha", target: "beta", type: "static" }],
    });
    const ctx = commandContext({
      graph: {
        nodes: {
          alpha: {
            name: "alpha",
            type: "lib",
            data: { root: "libs/alpha", tags: ["layer:domain"] },
          },
          beta: { name: "beta", type: "lib", data: { root: "libs/beta", tags: ["layer:util"] } },
        },
        dependencies: { alpha: [{ target: "beta", type: "static" }] },
      },
    });
    const config = {
      depConstraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:util"] }],
    };
    const result = diffCommand("/baseline.json", ctx, {
      readBaseline: () => baseline,
      config,
    });
    expect(result.diff.ruleImpact).toBeDefined();
    expect(result.diff.ruleImpact.introduced).toEqual([]);
    expect(result.diff.ruleImpact.resolved).toEqual([]);
    expect(result.report.text).toContain("no boundary-rule impact");
  });

  it("treats a baseline project missing the tags key as having empty tags", () => {
    // edge-constraints.mjs uses `project.tags ?? []` when building baseline
    // nodes from the snapshot — a project with no `tags` key (not `{tags:[]}`)
    // must be treated as untagged, not as undefined.
    const baseline = baselineEnvelope({
      projects: [
        { name: "alpha", root: "libs/alpha" },
        { name: "beta", root: "libs/beta" },
      ],
      dependencies: [],
    });
    const ctx = commandContext({
      graph: {
        nodes: {
          alpha: { name: "alpha", type: "lib", data: { root: "libs/alpha" } },
          beta: { name: "beta", type: "lib", data: { root: "libs/beta" } },
        },
        dependencies: { alpha: [{ target: "beta", type: "static" }] },
      },
    });
    const config = {
      depConstraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] }],
    };
    const result = diffCommand("/baseline.json", ctx, {
      readBaseline: () => baseline,
      config,
    });
    expect(result.diff.ruleImpact).toBeDefined();
    // alpha has no tags in the head graph (data.tags absent), so the new
    // alpha→beta edge should flag projectWithoutTagsCannotHaveDependencies
    const introduced = result.diff.ruleImpact.introduced;
    expect(introduced.length).toBeGreaterThanOrEqual(1);
    expect(introduced.some((v) => v.messageId === "projectWithoutTagsCannotHaveDependencies")).toBe(
      true,
    );
  });

  // -------------------------------------------------------------------------
  // Policy mismatch
  // -------------------------------------------------------------------------

  it("detects a policy mismatch between baseline and head", () => {
    const baseline = baselineEnvelope({
      projects: [{ name: "alpha", root: "libs/alpha", tags: ["layer:domain"] }],
      dependencies: [],
      policy: {
        fingerprint: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });
    const ctx = commandContext();
    const config = {
      depConstraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] }],
    };
    const result = diffCommand("/baseline.json", ctx, {
      readBaseline: () => baseline,
      config,
    });
    expect(result.diff.policyMismatch).toBeDefined();
    expect(result.diff.policyMismatch.baseline.fingerprint).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(result.diff.policyMismatch.head.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.report.text).toContain("policy changed between baseline and head");
  });

  it("does not report a policy mismatch when fingerprints agree", () => {
    // Use a config that produces a known fingerprint, and put that same
    // fingerprint in the baseline.
    const config = {
      depConstraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] }],
    };
    const fingerprint = computePolicyFingerprint(config);
    const baseline = baselineEnvelope({
      projects: [{ name: "alpha", root: "libs/alpha", tags: ["layer:domain"] }],
      dependencies: [],
      policy: { fingerprint },
    });
    const ctx = commandContext();
    const result = diffCommand("/baseline.json", ctx, {
      readBaseline: () => baseline,
      config,
    });
    expect(result.diff.policyMismatch).toBeUndefined();
    expect(result.report.text).not.toContain("policy changed");
  });

  it("does not report a policy mismatch when baseline has no policy", () => {
    const baseline = baselineEnvelope({
      projects: [{ name: "alpha", root: "libs/alpha", tags: ["layer:domain"] }],
      dependencies: [],
    });
    const ctx = commandContext();
    const config = {
      depConstraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] }],
    };
    const result = diffCommand("/baseline.json", ctx, {
      readBaseline: () => baseline,
      config,
    });
    expect(result.diff.policyMismatch).toBeUndefined();
  });

  it("does not report a policy mismatch when no config is provided for the head", () => {
    const baseline = baselineEnvelope({
      projects: [{ name: "alpha", root: "libs/alpha", tags: ["layer:domain"] }],
      dependencies: [],
      policy: {
        fingerprint: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });
    const ctx = commandContext();
    const result = diffCommand("/baseline.json", ctx, {
      readBaseline: () => baseline,
    });
    expect(result.diff.policyMismatch).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // changedProjects
  // -------------------------------------------------------------------------

  it("detects tag changes between baseline and head", () => {
    const baseline = baselineEnvelope({
      projects: [{ name: "alpha", root: "libs/alpha", type: "lib", tags: ["layer:domain"] }],
      dependencies: [],
    });
    const ctx = commandContext({
      graph: {
        nodes: {
          alpha: {
            name: "alpha",
            type: "lib",
            data: { root: "libs/alpha", tags: ["layer:adapter"] },
          },
        },
        dependencies: {},
      },
    });
    const result = diffCommand("/baseline.json", ctx, {
      readBaseline: () => baseline,
    });
    expect(result.diff.changedProjects).toEqual([
      {
        name: "alpha",
        changes: [{ field: "tags", baseline: ["layer:domain"], head: ["layer:adapter"] }],
      },
    ]);
    expect(result.report.text).toContain("~ 1 changed project");
    expect(result.report.text).toContain("tags  layer:domain → layer:adapter");
  });

  it("detects type changes between baseline and head", () => {
    const baseline = baselineEnvelope({
      projects: [{ name: "alpha", root: "libs/alpha", type: "lib", tags: ["layer:domain"] }],
      dependencies: [],
    });
    const ctx = commandContext({
      graph: {
        nodes: {
          alpha: {
            name: "alpha",
            type: "app",
            data: { root: "libs/alpha", tags: ["layer:domain"] },
          },
        },
        dependencies: {},
      },
    });
    const result = diffCommand("/baseline.json", ctx, {
      readBaseline: () => baseline,
    });
    expect(result.diff.changedProjects).toEqual([
      { name: "alpha", changes: [{ field: "type", baseline: "lib", head: "app" }] },
    ]);
  });

  it("does not report changed projects when metadata is identical", () => {
    // The baseline must match what buildHeadSnapshot produces from the command
    // context — including the `type` field, because buildProjects includes it.
    const baseline = baselineEnvelope({
      projects: [{ name: "alpha", root: "libs/alpha", type: "lib", tags: ["layer:domain"] }],
    });
    const ctx = commandContext();
    const result = diffCommand("/baseline.json", ctx, {
      readBaseline: () => baseline,
    });
    expect(result.diff.changedProjects).toEqual([]);
    expect(result.report.text).not.toContain("changed project");
  });

  it("includes changed projects in the JSON envelope", () => {
    const baseline = baselineEnvelope({
      projects: [{ name: "alpha", root: "libs/alpha", type: "lib", tags: ["layer:domain"] }],
      dependencies: [],
    });
    const ctx = commandContext({
      graph: {
        nodes: {
          alpha: {
            name: "alpha",
            type: "lib",
            data: { root: "libs/alpha", tags: ["layer:adapter"] },
          },
        },
        dependencies: {},
      },
    });
    const result = diffCommand("/baseline.json", ctx, {
      readBaseline: () => baseline,
    });
    const envelope = JSON.parse(result.report.json);
    expect(envelope.result.changedProjects).toEqual([
      {
        name: "alpha",
        changes: [{ field: "tags", baseline: ["layer:domain"], head: ["layer:adapter"] }],
      },
    ]);
  });
});
