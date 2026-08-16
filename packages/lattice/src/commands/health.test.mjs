import { describe, expect, it, vi } from "vitest";

import { healthCommand } from "./health.mjs";

// `healthCommand` is a pure function of the command context plus an injectable
// IO bank — the same pattern `diff`'s `readBaseline` and `history`'s `io`
// follow. Since the resolved command context already carries the graph and the
// analysis envelope, these tests never touch a provider boundary; the only
// module-side effect is `resolveProvenance`, which spawns git and returns
// `null` in a tree without a `.git` (a pure fallback, not a branch under test
// here).

/**
 * A minimal command context in the shape `resolveCommandContext` produces —
 * two projects, one edge, clean analysis.
 *
 * @param {object} [overrides]
 */
function context(overrides = {}) {
  return {
    root: "/workspace",
    provider: "native",
    marker: "lattice.json",
    graph: {
      nodes: {
        alpha: { name: "alpha", type: "lib", data: { root: "libs/alpha", tags: ["type-package"] } },
        beta: { name: "beta", type: "lib", data: { root: "libs/beta", tags: ["type-package"] } },
      },
      dependencies: {
        alpha: [{ target: "beta", type: "static" }],
      },
    },
    analysis: {
      analyzed: 4,
      imports: [],
      failures: [],
    },
    pluginGap: { registered: true, manifests: [] },
    ...overrides,
  };
}

/** A config in the `loadBoundaryConfig` shape — every option stated. */
const config = (suppressions = [], notes = []) => ({
  depConstraints: [{ sourceTag: "*", onlyDependOnLibsWithTags: ["*"] }],
  options: {
    allow: [],
    buildTargets: ["build"],
    enforceBuildableLibDependency: false,
    allowCircularSelfDependency: false,
    checkDynamicDependenciesExceptions: [],
    ignoredCircularDependencies: [],
    banTransitiveDependencies: false,
    checkNestedExternalImports: false,
  },
  suppressions,
  notes,
});

/** A bare-intent model: one boundary, one allowed row already observed. */
const intent = (overrides = {}) => ({
  version: "1",
  boundaries: [{ name: "packages", match: ["tag:type-package"] }],
  allowed: [{ from: "packages", to: "packages" }],
  forbidden: [],
  ...overrides,
});

describe("healthCommand — status contract", () => {
  it("returns ok when every metric reached a verdict", () => {
    const result = healthCommand(context(), {
      config: config(),
      intent: intent(),
      trendDir: null,
    });
    expect(result.status).toBe("ok");
    expect(result.metrics.projects).toEqual({ verdict: "ok", value: 2 });
    expect(result.metrics.edges).toEqual({ verdict: "ok", value: 1 });
    // Both sides of the intent boundary are the same tagged set; the allowed
    // row is vacuously held, so fitness is clean.
    expect(result.metrics.fitness.verdict).toBe("ok");
  });

  it("returns no-verdict (exit 3) when any metric is unknown", () => {
    // A whole-file failure makes the boundary unmeasurable.
    const ctx = context();
    ctx.analysis.failures = [
      { sourceFile: "libs/beta/b.go", line: null, column: null, reason: "parse error" },
    ];
    const result = healthCommand(ctx, { config: config(), trendDir: null });
    expect(result.status).toBe("no-verdict");
    expect(result.metrics.violations).toEqual({
      verdict: "unknown",
      note: "the boundary could not be fully inspected",
    });
    expect(result.metrics.violations.value).toBeUndefined();
  });

  it("returns no-verdict when the graph cannot see every edge (unregistered plugin)", () => {
    const result = healthCommand(
      context({ provider: "nx", pluginGap: { registered: false, manifests: ["libs/x/gomod"] } }),
      { config: config(), trendDir: null },
    );
    expect(result.status).toBe("no-verdict");
    expect(result.metrics.edges.verdict).toBe("unknown");
    expect(result.metrics.cycles.verdict).toBe("unknown");
  });

  it("reports not_applicable for intent when the workspace declares no intent", () => {
    const result = healthCommand(context(), { config: config(), intent: null, trendDir: null });
    expect(result.metrics.fitness.verdict).toBe("not_applicable");
  });

  it("reports not_applicable for violations without a boundary config", () => {
    const result = healthCommand(context(), { config: null, trendDir: null });
    expect(result.metrics.violations.verdict).toBe("not_applicable");
  });

  it("reports debt rows from the config's own notes", () => {
    const result = healthCommand(context(), {
      config: config([], ["temporary: replace the glob with a real list"]),
      trendDir: null,
    });
    expect(result.metrics.debt).toEqual({ verdict: "findings", value: 1 });
  });

  it("never fabricates a number under partial analysis — the violation count is unknown", () => {
    const ctx = context();
    ctx.analysis.failures = [
      { sourceFile: "libs/alpha/a.go", line: null, column: null, reason: "parse error" },
    ];
    const result = healthCommand(ctx, { config: config(), trendDir: null });
    expect(result.metrics.violations.verdict).toBe("unknown");
    expect(result.metrics.violations.value).toBeUndefined();
    // `coverage.complete` in the envelope agrees with the failure list.
    expect(result.coverage.complete).toBe(false);
  });

  it("builds a JSON envelope carrying the metrics under `result`", () => {
    const result = healthCommand(context(), { config: config(), trendDir: null });
    const envelope = JSON.parse(result.report.json);
    expect(envelope.command).toBe("health");
    expect(envelope.status).toBe("ok");
    expect(envelope.exitCode).toBe(0);
    expect(envelope.result.metrics.projects).toEqual({ verdict: "ok", value: 2 });
    expect(envelope.coverage.complete).toBe(true);
  });

  it("emits a no-verdict envelope with exitCode 3 under partial coverage", () => {
    const ctx = context();
    ctx.analysis.failures = [
      { sourceFile: "libs/beta/b.go", line: null, column: null, reason: "parse error" },
    ];
    const result = healthCommand(ctx, { config: config(), trendDir: null });
    const envelope = JSON.parse(result.report.json);
    expect(envelope.status).toBe("no-verdict");
    expect(envelope.exitCode).toBe(3);
    expect(result.status).toBe("no-verdict");
  });
});

describe("healthCommand — trends", () => {
  it("reads the snapshot list through the injectable readSnapshots seam", () => {
    const readSnapshots = vi.fn(() => ({
      files: [
        {
          name: "0001-a.json",
          envelope: { result: { projects: [{}, {}], dependencies: [{}, {}] } },
        },
        {
          name: "0002-b.json",
          envelope: { result: { projects: [{}], dependencies: [] } },
        },
      ],
    }));
    const result = healthCommand(context(), {
      config: config(),
      trendDir: "/hist",
      readSnapshots,
    });
    expect(readSnapshots).toHaveBeenCalledWith("/hist");
    expect(result.trends.snapshots).toEqual([
      { name: "0001-a.json", projects: 2, dependencies: 2 },
      { name: "0002-b.json", projects: 1, dependencies: 0 },
    ]);
    // The disclosure note is present: rule-impact cannot be re-derived.
    expect(result.trends.notes[0]).toMatch(/cannot be re-derived/);
  });

  it("reports no trends when no snapshot directory is given", () => {
    const result = healthCommand(context(), { config: config(), trendDir: null });
    expect(result.trends).toBeNull();
  });
});

describe("healthCommand — determinism", () => {
  it("produces byte-identical JSON for two identical runs", () => {
    const contextA = context();
    const contextB = context();
    const a = healthCommand(contextA, { config: config(), trendDir: null });
    const b = healthCommand(contextB, { config: config(), trendDir: null });
    expect(a.report.json).toBe(b.report.json);
  });
});
