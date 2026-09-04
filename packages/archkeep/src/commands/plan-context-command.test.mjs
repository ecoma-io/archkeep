import { describe, expect, it } from "vitest";

import {
  DEPENDENT_CAP,
  collectAffectedProjects,
  collectDrift,
  collectImpact,
  planContextCommand,
} from "./plan-context-command.mjs";

/**
 * The agent architecture planning context. Its guarantees, in the same frame
 * as `context-command.test.mjs`: the plan reports facts — current architecture,
 * applicable policy, impact, violations, drift, coverage, verification commands
 * — never an LLM plan. Fail-closed: incomplete coverage is `no-verdict`, an
 * absent manifest is `null` (never "no drift"), and path-scoping is scoped
 * reporting over a whole-tree verdict so whole-graph rules (circular, lazy-load)
 * stay correct. Deterministic: every array is sorted, no timestamps.
 */

// ---------------------------------------------------------------------------
// collectAffectedProjects
// ---------------------------------------------------------------------------

describe("collectAffectedProjects", () => {
  function baseContext(owned) {
    return { owned };
  }

  it("returns the target project when a path points at its root", () => {
    const ctx = baseContext([
      { file: "libs/alpha/main.go", project: "alpha" },
      { file: "libs/beta/main.go", project: "beta" },
    ]);
    const result = collectAffectedProjects(ctx, ["libs/alpha"]);
    expect(result).toEqual(["alpha"]);
  });

  it("a path into a shared directory resolves to every project owning a file there", () => {
    const ctx = baseContext([
      { file: "libs/shared/common.go", project: "alpha" },
      { file: "libs/shared/util.go", project: "beta" },
    ]);
    const result = collectAffectedProjects(ctx, ["libs/shared"]);
    expect(result).toEqual(["alpha", "beta"]);
  });

  it("returns [] (no affected projects) when no path matches", () => {
    const ctx = baseContext([{ file: "libs/alpha/main.go", project: "alpha" }]);
    const result = collectAffectedProjects(ctx, ["libs/unrelated"]);
    expect(result).toEqual([]);
  });

  it("returns [] when no paths are given", () => {
    const ctx = baseContext([{ file: "libs/alpha/main.go", project: "alpha" }]);
    const result = collectAffectedProjects(ctx, []);
    expect(result).toEqual([]);
  });

  it("deduplicates and sorts affected projects deterministically", () => {
    const ctx = baseContext([
      { file: "apps/z/main.go", project: "zapp" },
      { file: "libs/a/main.go", project: "a" },
      { file: "libs/a/extra.go", project: "a" },
    ]);
    const result = collectAffectedProjects(ctx, ["libs/a", "apps/z"]);
    expect(result).toEqual(["a", "zapp"]);
  });

  it("handles an empty owned map gracefully", () => {
    const ctx = baseContext([]);
    expect(collectAffectedProjects(ctx, ["libs/alpha"])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// collectImpact
// ---------------------------------------------------------------------------

describe("collectImpact", () => {
  it("computes impact for the target project and every affected project", () => {
    const graph = {
      nodes: {
        alpha: { name: "alpha", data: { root: "libs/alpha" } },
        beta: { name: "beta", data: { root: "libs/beta" } },
        gamma: { name: "gamma", data: { root: "libs/gamma" } },
      },
      dependencies: {
        beta: [{ target: "alpha", type: "static" }],
        gamma: [{ target: "beta", type: "static" }],
      },
    };
    const result = collectImpact("alpha", ["alpha"], graph);
    // One target: alpha. beta depends on it directly, gamma transitively.
    expect(result).toHaveLength(1);
    expect(result[0].project).toBe("alpha");
    expect(result[0].direct).toEqual(["beta"]);
    expect(result[0].transitive).toEqual(["gamma"]);
    expect(result[0].dependents).toEqual(["beta", "gamma"]);
    expect(result[0].dependentsTotal).toBe(2);
    expect(result[0].hasMore).toBe(false);
  });

  it("caps dependents at DEPENDENT_CAP with dependentsTotal and hasMore", () => {
    const nodes = {};
    const dependencies = {};
    const dependents = [];
    for (let i = 0; i < DEPENDENT_CAP + 5; i++) {
      const name = `dep${String(i).padStart(2, "0")}`;
      nodes[name] = { name, data: { root: `libs/${name}` } };
      dependencies[name] = [{ target: "alpha", type: "static" }];
      dependents.push(name);
    }
    nodes.alpha = { name: "alpha", data: { root: "libs/alpha" } };
    const result = collectImpact("alpha", ["alpha"], { nodes, dependencies });
    expect(result[0].dependents.length).toBe(DEPENDENT_CAP);
    expect(result[0].dependentsTotal).toBe(DEPENDENT_CAP + 5);
    expect(result[0].hasMore).toBe(true);
    // The listed dependents are the capped prefix, sorted.
    expect(result[0].dependents[0]).toBe("dep00");
  });

  it("computes impact for the union of target and affected projects", () => {
    const graph = {
      nodes: {
        alpha: { name: "alpha", data: { root: "libs/alpha" } },
        beta: { name: "beta", data: { root: "libs/beta" } },
        gamma: { name: "gamma", data: { root: "libs/gamma" } },
      },
      dependencies: {
        beta: [{ target: "alpha", type: "static" }],
        gamma: [{ target: "beta", type: "static" }],
      },
    };
    // Affected = [beta]; target = alpha. Both are computed.
    const result = collectImpact("alpha", ["beta"], graph);
    const names = result.map((e) => e.project).sort();
    expect(names).toEqual(["alpha", "beta"]);
  });
});

// ---------------------------------------------------------------------------
// collectDrift
// ---------------------------------------------------------------------------

describe("collectDrift", () => {
  it("returns null for go.work and tsconfigPaths when neither manifest exists", () => {
    const commandContext = {
      root: "/workspace",
      tracked: [],
      workspace: {
        root: "/workspace",
        readFile: () => null,
        tsConfig: "tsconfig.base.json",
        projects: [],
      },
    };
    const result = collectDrift(commandContext);
    expect(result.goWork).toBeNull();
    expect(result.tsconfigPaths).toBeNull();
    expect(result.failures).toEqual([]);
  });

  it("reads go.work and reports findings when present", () => {
    const commandContext = {
      root: "/workspace",
      tracked: ["go.work"],
      workspace: {
        root: "/workspace",
        readFile: () => "go 1.22\n\nuse (\n\t./apps\n\t./libs/missing\n)\n",
        tsConfig: "tsconfig.base.json",
        projects: [
          { name: "apps", root: "apps", type: "app" },
          { name: "libs/other", root: "libs/other", type: "lib" },
        ],
      },
    };
    const result = collectDrift(commandContext);
    // `libs/missing` is not a declared project → a drift finding.
    expect(result.goWork).not.toBeNull();
    expect(result.goWork.findings.length).toBeGreaterThan(0);
  });

  it("treats an unreadable go.work as a whole-file failure, not an empty list", () => {
    const commandContext = {
      root: "/workspace",
      tracked: ["go.work"],
      workspace: {
        root: "/workspace",
        readFile: () => null,
        tsConfig: "tsconfig.base.json",
        projects: [{}],
      },
    };
    const result = collectDrift(commandContext);
    expect(result.goWork).toBeNull();
    expect(result.failures.length).toBe(1);
    expect(result.failures[0].sourceFile).toBe("go.work");
    expect(result.failures[0].line).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// planContextCommand
// ---------------------------------------------------------------------------

describe("planContextCommand", () => {
  /** Minimal command context that passes the unregistered-plugin refusal. */
  function commandContext(overrides = {}) {
    const own = [
      { file: "libs/alpha/main.go", project: "alpha" },
      { file: "libs/beta/main.go", project: "beta" },
    ];
    const base = {
      root: "/workspace",
      provider: "native",
      marker: "archkeep.json",
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
        dependencies: {
          beta: [{ target: "alpha", type: "static" }],
        },
      },
      // Ownership map: which project owns which tracked file. The plan uses it
      // for path→project scoping; `analyzeWorkspace` needs the file list.
      owned: own,
      workspace: {
        root: "/workspace",
        // Provide readable content for the analyzable files, so the default
        // fixture is a complete, happy-path run; the no-verdict cases override
        // this with a null-returning reader.
        readFile: (path) => (path.endsWith(".go") ? "package main\n" : null),
        // The Go analyzer resolves each project's manifests/sources through
        // filesOf (go.mjs:228); give it the ownership map.
        filesOf: (name) => own.filter((o) => o.project === name).map((o) => o.file),
        tsConfig: "tsconfig.base.json",
        projects: [
          { name: "alpha", root: "libs/alpha" },
          { name: "beta", root: "libs/beta" },
        ],
      },
      tracked: own.map((o) => o.file),
      pluginGap: { registered: true, manifests: [] },
      analysis: {
        analyzed: 2,
        imports: [],
        failures: [],
      },
      ...overrides,
    };
    return base;
  }

  /**
   * Minimal boundary config with a depConstraints table. Unlike the plain
   * `contextCommand`, `planContextCommand` runs `evaluate` over the whole tree,
   * which re-validates the config through `findBoundaryConfigViolations` — and
   * that validator rejects a missing option rather than defaulting it. So every
   * one of the eight `moduleBoundaryOptions` is stated explicitly.
   */
  function config(overrides = {}) {
    return {
      depConstraints: [
        { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain", "layer:util"] },
        { sourceTag: "layer:util", onlyDependOnLibsWithTags: ["layer:util"] },
      ],
      options: {
        allow: [],
        buildTargets: [],
        enforceBuildableLibDependency: false,
        allowCircularSelfDependency: false,
        checkDynamicDependenciesExceptions: [],
        ignoredCircularDependencies: [],
        banTransitiveDependencies: false,
        checkNestedExternalImports: false,
      },
      suppressions: [],
      notes: [],
      ...overrides,
    };
  }

  it("returns a planning context with the target project and policy", async () => {
    const result = await planContextCommand("alpha", [], commandContext(), config());
    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(result.result.plan.variant).toBe("plan");
    expect(result.result.project).toBe("alpha");
    expect(result.result.tags).toEqual(["layer:domain"]);
    // Plain context fields stay present at top level (additive envelope).
    expect(result.result.constraints).toHaveLength(1);
    expect(result.result.dependencies).toHaveLength(0);
  });

  it("adds the planning sections under result.plan: architecture, impact, violations, drift, verify", async () => {
    const result = await planContextCommand("alpha", [], commandContext(), config());
    const plan = result.result.plan;
    expect(plan.architecture).toBeDefined();
    expect(plan.architecture.projects.length).toBe(2);
    expect(plan.architecture.targets).toEqual([]);
    expect(plan.impact).toHaveLength(1);
    expect(plan.impact[0].project).toBe("alpha");
    expect(plan.impact[0].dependents).toEqual(["beta"]);
    expect(plan.violations).toBeDefined();
    expect(plan.drift).toBeDefined();
    expect(plan.drift.goWork).toBeNull();
    expect(plan.drift.tsconfigPaths).toBeNull();
    expect(plan.verify.length).toBeGreaterThanOrEqual(1);
    expect(plan.policyFingerprint).toBeDefined();
  });

  it("marks a scope that matched no project in coverage.notes", async () => {
    const result = await planContextCommand(
      "alpha",
      ["libs/nonexistent"],
      commandContext(),
      config(),
    );
    expect(result.status).toBe("ok");
    expect(
      result.coverage.notes.some((n) => n.includes("no path matched a project-owned file")),
    ).toBe(true);
  });

  it("returns 'no-verdict' when coverage is incomplete (whole-file failure)", async () => {
    // A whole-file failure (line === null) anywhere in the tree — even outside
    // the scoped change — withholds the verdict. Fail-closed: the plan must
    // never present facts against a tree it could not fully read as if they
    // were complete.
    //
    // planContextCommand runs analyzeWorkspace internally over the owned files,
    // and a file the workspace cannot read becomes a whole-file failure (line
    // === null). A workspace whose readFile returns null for a project-owned
    // .go file therefore puts the run in the no-verdict class.
    const ctx = commandContext({
      owned: [
        { file: "libs/alpha/main.go", project: "alpha" },
        { file: "libs/broken/broken.go", project: "broken" },
      ],
      workspace: {
        root: "/workspace",
        // alpha's main.go is readable; broken.go is not → whole-file failure.
        readFile: (path) => (path === "libs/alpha/main.go" ? "package main\n" : null),
        tsConfig: "tsconfig.base.json",
        projects: [
          { name: "alpha", root: "libs/alpha" },
          { name: "broken", root: "libs/broken" },
        ],
      },
    });
    const result = await planContextCommand("alpha", [], ctx, config());
    expect(result.status).toBe("no-verdict");
    expect(result.exitCode).toBe(3);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.notAnalyzed.some((f) => f.file === "libs/broken/broken.go")).toBe(true);
  });

  it("goes no-verdict when a drift manifest cannot be read", async () => {
    const ctx = commandContext({
      tracked: ["go.work"],
      workspace: {
        root: "/workspace",
        readFile: () => null, // go.work unreadable
        tsConfig: "tsconfig.base.json",
        projects: [{}],
      },
    });
    const result = await planContextCommand("alpha", [], ctx, config());
    // The unreadable go.work becomes a whole-file failure → no-verdict.
    expect(result.status).toBe("no-verdict");
    expect(result.exitCode).toBe(3);
    expect(result.coverage.complete).toBe(false);
  });

  it("goes no-verdict when zero files were analyzed — a run that judged nothing is incomplete (#694)", async () => {
    // A workspace whose only owned file has no recognized language (.txt) still
    // passes through analyzeWorkspace with analyzed=0, no failures, no
    // unresolvable literals. Before #694 this produced complete:true — a
    // zero-analysis hole. Now analyzed > 0 is required.
    const ctx = commandContext({
      owned: [{ file: "libs/alpha/readme.txt", project: "alpha" }],
      workspace: {
        root: "/workspace",
        readFile: () => "content",
        filesOf: () => ["libs/alpha/readme.txt"],
        tsConfig: "tsconfig.base.json",
        projects: [{ name: "alpha", root: "libs/alpha" }],
      },
      tracked: ["libs/alpha/readme.txt"],
      analysis: { analyzed: 0, imports: [], failures: [] },
    });
    const result = await planContextCommand("alpha", [], ctx, config());
    expect(result.status).toBe("no-verdict");
    expect(result.exitCode).toBe(3);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.analyzedFiles).toBe(0);
  });

  it("never exits 1 — the planning context is facts, not a finding", async () => {
    const result = await planContextCommand("alpha", [], commandContext(), config());
    expect(result.status).not.toBe("findings");
    expect(result.exitCode).not.toBe(1);
  });

  it("throws when the plugin is unregistered on a polyglot Nx workspace", async () => {
    await expect(
      planContextCommand(
        "alpha",
        [],
        commandContext({
          provider: "nx",
          pluginGap: { registered: false, manifests: ["libs/alpha/go.mod"] },
        }),
        config(),
      ),
    ).rejects.toThrow(/refusing to build a planning context/);
  });

  it("keeps the plain context fields identical to the plain context command", async () => {
    // Without --plan, context stays byte-identical; the plan command's result
    // must carry the same project/tags/constraints/dependencies the plain
    // contextCommand builds, so a consumer reading those keys reads the same.
    const result = await planContextCommand("alpha", [], commandContext(), config());
    expect(result.result.project).toBe("alpha");
    expect(result.result.tags).toEqual(["layer:domain"]);
    expect(Array.isArray(result.result.constraints)).toBe(true);
    expect(Array.isArray(result.result.dependencies)).toBe(true);
  });

  it("produces both text and JSON report renderings", async () => {
    const result = await planContextCommand("alpha", [], commandContext(), config());
    expect(result.report.text).toContain("planning context complete");
    expect(result.report.text).toContain("Project  alpha");
    expect(result.report.json).toContain('"command": "context"');
    // JSON nests the plan under result.plan and marks the variant.
    expect(result.report.json).toContain('"plan"');
    expect(result.report.json).toContain('"variant": "plan"');
  });

  // P1-02: `context --plan` shares `collectProjectContext` and
  // `formatConstraint` with the plain `context` command, so it carries the
  // identical bug — a matched constraint row's decisionRef rendered verbatim,
  // unverified. `commandContext()`'s root ("/workspace") has no real
  // `docs/adr/` behind it, so this drives the REAL `readAdrContext` through
  // its natural "no registry → unknown" path, the same answer a genuinely
  // nonexistent ADR id gets on a real tree.
  describe("decisionRef resolution (P1-02)", () => {
    it("flags a matched constraint row's decisionRef when it cannot resolve, same as plain context", async () => {
      const result = await planContextCommand(
        "alpha",
        [],
        commandContext(),
        config({
          depConstraints: [
            {
              sourceTag: "layer:domain",
              onlyDependOnLibsWithTags: ["layer:domain"],
              decisionRef: "9999-does-not-exist",
            },
          ],
        }),
      );
      expect(result.report.text).toContain("decisionRef [9999-does-not-exist]");
      expect(result.report.text).toContain("UNRESOLVED");
      expect(result.result.unresolvedDecisionRefs).toEqual(["9999-does-not-exist"]);
      // Report-only: the plan is descriptive and never exits 1 on its own.
      expect(result.status).toBe("ok");
    });

    it("carries no unresolvedDecisionRefs field when no matched row cites one", async () => {
      const result = await planContextCommand("alpha", [], commandContext(), config());
      expect(result.report.text).not.toContain("decisionRef");
      expect(result.result.unresolvedDecisionRefs).toBeUndefined();
    });
  });
});
