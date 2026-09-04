import { describe, expect, it } from "vitest";

import {
  computeImpactConstraints,
  computeRuleImpact,
  declaredEdgeViolationsForCheck,
  judgeEdge,
} from "./edge-constraints.mjs";

/**
 * What edge-constraint analysis guarantees:
 *
 * - `judgeEdge` checks the depConstraints table for a single edge, returning
 *   violations with their constraint rows. It does not check npm/circular/
 *   lazy-load rules (those need import-site details).
 * - `computeRuleImpact` maps a diff's added/removed edges to violations
 *   introduced and resolved.
 * - `computeImpactConstraints` identifies constraint rows and violations for
 *   each dependent in an impact set.
 *
 * The fail-closed direction: an edge that should be flagged must never return
 * an empty violations array. An empty array means "allowed by the constraint
 * table", not "the tool could not check".
 */

// ---------------------------------------------------------------------------
// judgeEdge
// ---------------------------------------------------------------------------

describe("judgeEdge", () => {
  const config = {
    depConstraints: [
      { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain", "layer:util"] },
      { sourceTag: "layer:util", onlyDependOnLibsWithTags: ["layer:util"] },
    ],
  };

  function nodes(overrides = {}) {
    return {
      alpha: { name: "alpha", data: { root: "libs/alpha", tags: ["layer:domain"] } },
      beta: { name: "beta", data: { root: "libs/beta", tags: ["layer:util"] } },
      gamma: { name: "gamma", data: { root: "libs/gamma", tags: ["layer:app"] } },
      ...overrides,
    };
  }

  it("returns empty for an allowed edge", () => {
    const violations = judgeEdge(
      { source: "alpha", target: "beta" },
      nodes(),
      {},
      config.depConstraints,
    );
    expect(violations).toEqual([]);
  });

  it("returns a violation for an edge that crosses layer boundaries", () => {
    const violations = judgeEdge(
      { source: "alpha", target: "gamma" },
      nodes(),
      {},
      config.depConstraints,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].messageId).toBe("onlyTagsConstraintViolation");
    expect(violations[0].constraint.sourceTag).toBe("layer:domain");
    expect(violations[0].source).toBe("alpha");
    expect(violations[0].target).toBe("gamma");
  });

  it("returns projectWithoutTagsCannotHaveDependencies when source tags match no row", () => {
    const customNodes = nodes({
      untagged: { name: "untagged", data: { root: "libs/untagged", tags: ["layer:app"] } },
      any: { name: "any", data: { root: "libs/any", tags: [] } },
    });
    const violations = judgeEdge(
      { source: "any", target: "untagged" },
      customNodes,
      {},
      config.depConstraints,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].messageId).toBe("projectWithoutTagsCannotHaveDependencies");
    expect(violations[0].constraint).toBeNull();
  });

  it("returns empty when either project is not in the graph", () => {
    const violations = judgeEdge(
      { source: "alpha", target: "nonexistent" },
      nodes(),
      {},
      config.depConstraints,
    );
    expect(violations).toEqual([]);
  });

  it("returns empty when source is not in the graph", () => {
    const violations = judgeEdge(
      { source: "nonexistent", target: "beta" },
      nodes(),
      {},
      config.depConstraints,
    );
    expect(violations).toEqual([]);
  });

  it("carries description and remediation on the constraint row", () => {
    const configWithMeta = {
      depConstraints: [
        {
          sourceTag: "layer:domain",
          onlyDependOnLibsWithTags: ["layer:domain"],
          description: "Domain isolation",
          remediation: "Depend on an application-owned interface",
        },
      ],
    };
    const violations = judgeEdge(
      { source: "alpha", target: "gamma" },
      nodes(),
      {},
      configWithMeta.depConstraints,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].constraint.description).toBe("Domain isolation");
    expect(violations[0].constraint.remediation).toBe("Depend on an application-owned interface");
  });

  it("checks notDependOnLibsWithTags transitively", () => {
    const customConfig = {
      depConstraints: [{ sourceTag: "layer:domain", notDependOnLibsWithTags: ["layer:adapter"] }],
    };
    const customNodes = nodes({
      adapter: { name: "adapter", data: { root: "libs/adapter", tags: ["layer:adapter"] } },
    });
    // alpha → beta (util), and beta has no adapter tag, but this test verifies
    // that notDependOnLibsWithTags is evaluated (it won't fire here because
    // beta doesn't reach adapter).
    const violations = judgeEdge(
      { source: "alpha", target: "beta" },
      customNodes,
      {},
      customConfig.depConstraints,
    );
    expect(violations).toEqual([]);
  });

  it("reports notDependOnLibsWithTags when the target transitively reaches a banned tag", () => {
    // beta reaches adapter, so alpha depending on beta violates the ban — the
    // transitive arm of the check, not the direct one.
    const customConfig = {
      depConstraints: [{ sourceTag: "layer:domain", notDependOnLibsWithTags: ["layer:adapter"] }],
    };
    const customNodes = nodes({
      adapter: { name: "adapter", data: { root: "libs/adapter", tags: ["layer:adapter"] } },
    });
    const violations = judgeEdge(
      { source: "alpha", target: "beta" },
      customNodes,
      { beta: [{ target: "adapter", type: "static" }] },
      customConfig.depConstraints,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      messageId: "notTagsConstraintViolation",
      constraint: customConfig.depConstraints[0],
      source: "alpha",
      target: "beta",
    });
    // `data`/`message` are the same rendering `evaluate()`'s import-site path
    // produces (`renderMessage`) — asserted by content rather than duplicating
    // `stringifyTags`/`findDependenciesWithTags`'s own formatting here, which
    // those functions' own tests already pin.
    expect(violations[0].data).toMatchObject({ sourceTag: "layer:domain" });
    expect(violations[0].message).toContain("layer:domain");
    expect(violations[0].message).toContain("layer:adapter");
    expect(violations[0].message).not.toContain("{{");
  });

  it("reports emptyOnlyTagsConstraintViolation when onlyDependOnLibsWithTags is an empty list", () => {
    // An empty allow-list is a real config an author can write — it bans
    // every dependency. It must fire its own violation rather than reading
    // as "no constraint" and passing the edge.
    const emptyConfig = {
      depConstraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: [] }],
    };
    const violations = judgeEdge(
      { source: "alpha", target: "beta" },
      nodes(),
      {},
      emptyConfig.depConstraints,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].messageId).toBe("emptyOnlyTagsConstraintViolation");
  });
});

// ---------------------------------------------------------------------------
// declaredEdgeViolationsForCheck
// ---------------------------------------------------------------------------

describe("declaredEdgeViolationsForCheck", () => {
  const depConstraints = [
    { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain", "layer:util"] },
  ];
  const nodes = {
    alpha: { name: "alpha", data: { root: "libs/alpha", tags: ["layer:domain"] } },
    gamma: { name: "gamma", data: { root: "libs/gamma", tags: ["layer:app"] } },
  };

  it("judges an implicit-typed edge — the silent-direction case check's own evaluate() cannot reach", () => {
    // alpha -> gamma with no import site anywhere, only a declared edge — the
    // exact shape `implicitDependencies` produces and `evaluate()` never sees,
    // because it iterates import sites, not graph.dependencies.
    const graph = {
      nodes,
      dependencies: { alpha: [{ source: "alpha", target: "gamma", type: "implicit" }] },
    };
    const violations = declaredEdgeViolationsForCheck(graph, depConstraints);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      messageId: "onlyTagsConstraintViolation",
      source: "alpha",
      target: "gamma",
    });
  });

  it("ignores a static (import-derived) edge — evaluate() already judges those", () => {
    const graph = {
      nodes,
      dependencies: { alpha: [{ source: "alpha", target: "gamma", type: "static" }] },
    };
    expect(declaredEdgeViolationsForCheck(graph, depConstraints)).toEqual([]);
  });

  it("returns empty rather than throwing on a graph with no dependencies", () => {
    expect(declaredEdgeViolationsForCheck({ nodes, dependencies: {} }, depConstraints)).toEqual([]);
  });

  it("judges every implicit edge, not just the first", () => {
    const threeNodes = {
      ...nodes,
      delta: { name: "delta", data: { root: "libs/delta", tags: ["layer:domain"] } },
    };
    const graph = {
      nodes: threeNodes,
      dependencies: {
        alpha: [{ source: "alpha", target: "gamma", type: "implicit" }],
        delta: [{ source: "delta", target: "gamma", type: "implicit" }],
      },
    };
    const violations = declaredEdgeViolationsForCheck(graph, depConstraints);
    expect(violations.map((v) => v.source).sort()).toEqual(["alpha", "delta"]);
  });

  it("stays silent on an empty depConstraints table — the same opt-out evaluate() honors", () => {
    // Without this guard, `judgeEdge`'s "no matching constraint row" branch
    // would fire `projectWithoutTagsCannotHaveDependencies` on every implicit
    // edge here, disagreeing with `evaluate()`'s own early exit for the same
    // opted-out workspace.
    const graph = {
      nodes,
      dependencies: { alpha: [{ source: "alpha", target: "gamma", type: "implicit" }] },
    };
    expect(declaredEdgeViolationsForCheck(graph, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeRuleImpact
// ---------------------------------------------------------------------------

describe("computeRuleImpact", () => {
  const depConstraints = [
    { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain", "layer:util"] },
    { sourceTag: "layer:util", onlyDependOnLibsWithTags: ["layer:util"] },
  ];

  function headNodes(overrides = {}) {
    return {
      alpha: { name: "alpha", data: { root: "libs/alpha", tags: ["layer:domain"] } },
      beta: { name: "beta", data: { root: "libs/beta", tags: ["layer:util"] } },
      gamma: { name: "gamma", data: { root: "libs/gamma", tags: ["layer:app"] } },
      ...overrides,
    };
  }

  it("returns no introduced or resolved violations when the diff has no edge changes", () => {
    const result = computeRuleImpact(
      { addedEdges: [], removedEdges: [] },
      headNodes(),
      {},
      [],
      [],
      depConstraints,
    );
    expect(result.introduced).toEqual([]);
    expect(result.resolved).toEqual([]);
  });

  it("reports an introduced violation when an added edge crosses boundaries", () => {
    const result = computeRuleImpact(
      { addedEdges: [{ source: "alpha", target: "gamma", type: "static" }], removedEdges: [] },
      headNodes(),
      {},
      [],
      [],
      depConstraints,
    );
    expect(result.introduced).toHaveLength(1);
    expect(result.introduced[0].messageId).toBe("onlyTagsConstraintViolation");
    expect(result.introduced[0].source).toBe("alpha");
    expect(result.introduced[0].target).toBe("gamma");
  });

  it("reports no introduced violation when an added edge is allowed", () => {
    const result = computeRuleImpact(
      { addedEdges: [{ source: "alpha", target: "beta", type: "static" }], removedEdges: [] },
      headNodes(),
      {},
      [],
      [],
      depConstraints,
    );
    expect(result.introduced).toEqual([]);
  });

  it("reports a resolved violation when a removed edge was previously violating", () => {
    const baselineProjects = [
      { name: "alpha", root: "libs/alpha", tags: ["layer:domain"] },
      { name: "gamma", root: "libs/gamma", tags: ["layer:app"] },
    ];
    const baselineDeps = [{ source: "alpha", target: "gamma", type: "static" }];
    const result = computeRuleImpact(
      { addedEdges: [], removedEdges: [{ source: "alpha", target: "gamma", type: "static" }] },
      headNodes(),
      {},
      baselineProjects,
      baselineDeps,
      depConstraints,
    );
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].messageId).toBe("onlyTagsConstraintViolation");
    expect(result.resolved[0].source).toBe("alpha");
    expect(result.resolved[0].target).toBe("gamma");
  });

  it("keeps every baseline edge when a source appears more than once", () => {
    // The baseline map is built by appending: two edges from the same source
    // must both survive into the reachability view, or a resolved violation
    // through the second would vanish.
    const baselineProjects = [
      { name: "alpha", root: "libs/alpha", tags: ["layer:domain"] },
      { name: "beta", root: "libs/beta", tags: ["layer:util"] },
      { name: "gamma", root: "libs/gamma", tags: ["layer:app"] },
    ];
    const baselineDeps = [
      { source: "alpha", target: "beta", type: "static" },
      { source: "alpha", target: "gamma", type: "static" },
    ];
    const result = computeRuleImpact(
      { addedEdges: [], removedEdges: [{ source: "alpha", target: "gamma", type: "static" }] },
      headNodes(),
      {},
      baselineProjects,
      baselineDeps,
      depConstraints,
    );
    expect(result.resolved.map((v) => v.target)).toEqual(["gamma"]);
  });

  it("reports no resolved violation when a removed edge was previously allowed", () => {
    const baselineProjects = [
      { name: "alpha", root: "libs/alpha", tags: ["layer:domain"] },
      { name: "beta", root: "libs/beta", tags: ["layer:util"] },
    ];
    const baselineDeps = [{ source: "alpha", target: "beta", type: "static" }];
    const result = computeRuleImpact(
      { addedEdges: [], removedEdges: [{ source: "alpha", target: "beta", type: "static" }] },
      headNodes(),
      {},
      baselineProjects,
      baselineDeps,
      depConstraints,
    );
    expect(result.resolved).toEqual([]);
  });

  it("uses baseline tags for resolved violations, not head tags", () => {
    // Baseline had alpha as layer:domain, head has alpha as layer:util.
    // The removed edge was judged against the baseline tags.
    const baselineProjects = [
      { name: "alpha", root: "libs/alpha", tags: ["layer:domain"] },
      { name: "gamma", root: "libs/gamma", tags: ["layer:app"] },
    ];
    const baselineDeps = [{ source: "alpha", target: "gamma", type: "static" }];
    const customHeadNodes = headNodes({
      alpha: { name: "alpha", data: { root: "libs/alpha", tags: ["layer:util"] } },
    });
    const result = computeRuleImpact(
      { addedEdges: [], removedEdges: [{ source: "alpha", target: "gamma", type: "static" }] },
      customHeadNodes,
      {},
      baselineProjects,
      baselineDeps,
      depConstraints,
    );
    // Baseline alpha (layer:domain) → gamma (layer:app) was a violation
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].messageId).toBe("onlyTagsConstraintViolation");
  });

  it("handles missing tags gracefully in baseline projects", () => {
    const baselineProjects = [
      { name: "alpha", root: "libs/alpha" }, // no tags field
      { name: "gamma", root: "libs/gamma" },
    ];
    const baselineDeps = [{ source: "alpha", target: "gamma", type: "static" }];
    const result = computeRuleImpact(
      { addedEdges: [], removedEdges: [{ source: "alpha", target: "gamma", type: "static" }] },
      headNodes(),
      {},
      baselineProjects,
      baselineDeps,
      depConstraints,
    );
    // Alpha with no tags in baseline → projectWithoutTagsCannotHaveDependencies
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].messageId).toBe("projectWithoutTagsCannotHaveDependencies");
  });

  it("re-judges a standing edge whose legality a tags-only change flipped (#600)", () => {
    // beta moves layer:util → layer:app; the standing alpha→beta edge was
    // legal under the baseline tags and violates alpha's constraint under the
    // head tags. The edge is in neither addedEdges nor removedEdges.
    const head = headNodes({
      beta: { name: "beta", data: { root: "libs/beta", tags: ["layer:app"] } },
    });
    const baselineProjects = [
      { name: "alpha", root: "libs/alpha", tags: ["layer:domain"] },
      { name: "beta", root: "libs/beta", tags: ["layer:util"] },
    ];
    const result = computeRuleImpact(
      {
        addedEdges: [],
        removedEdges: [],
        changedProjects: [
          {
            name: "beta",
            changes: [{ field: "tags", baseline: ["layer:util"], head: ["layer:app"] }],
          },
        ],
      },
      head,
      { alpha: [{ target: "beta", type: "static" }] },
      baselineProjects,
      [{ source: "alpha", target: "beta", type: "static" }],
      depConstraints,
    );
    expect(result.introduced).toHaveLength(1);
    expect(result.introduced[0].messageId).toBe("onlyTagsConstraintViolation");
    expect(result.introduced[0].source).toBe("alpha");
    expect(result.introduced[0].target).toBe("beta");
    expect(result.resolved).toEqual([]);
  });

  it("classifies a tags-only flip back to legal as resolved (#600)", () => {
    // beta moves layer:app → layer:util; the standing edge violated under the
    // baseline tags and is legal under the head tags.
    const baselineProjects = [
      { name: "alpha", root: "libs/alpha", tags: ["layer:domain"] },
      { name: "beta", root: "libs/beta", tags: ["layer:app"] },
    ];
    const result = computeRuleImpact(
      {
        addedEdges: [],
        removedEdges: [],
        changedProjects: [
          {
            name: "beta",
            changes: [{ field: "tags", baseline: ["layer:app"], head: ["layer:util"] }],
          },
        ],
      },
      headNodes(),
      { alpha: [{ target: "beta", type: "static" }] },
      baselineProjects,
      [{ source: "alpha", target: "beta", type: "static" }],
      depConstraints,
    );
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].messageId).toBe("onlyTagsConstraintViolation");
    expect(result.resolved[0].source).toBe("alpha");
    expect(result.resolved[0].target).toBe("beta");
    expect(result.introduced).toEqual([]);
  });

  it("judges an added edge once even when its project also carries a tags change (#600)", () => {
    // The edge is new AND adjacent to a tags-changed project — one judgment,
    // not two. Guards the deduplication the standing-edge re-judge needs.
    const head = headNodes({
      beta: { name: "beta", data: { root: "libs/beta", tags: ["layer:app"] } },
    });
    const baselineProjects = [
      { name: "alpha", root: "libs/alpha", tags: ["layer:domain"] },
      { name: "beta", root: "libs/beta", tags: ["layer:util"] },
    ];
    const result = computeRuleImpact(
      {
        addedEdges: [{ source: "alpha", target: "beta", type: "static" }],
        removedEdges: [],
        changedProjects: [
          {
            name: "beta",
            changes: [{ field: "tags", baseline: ["layer:util"], head: ["layer:app"] }],
          },
        ],
      },
      head,
      { alpha: [{ target: "beta", type: "static" }] },
      baselineProjects,
      [],
      depConstraints,
    );
    expect(result.introduced).toHaveLength(1);
    expect(result.introduced[0].messageId).toBe("onlyTagsConstraintViolation");
  });

  it("does not re-judge standing edges for a change that moves no tag (#600)", () => {
    // A root move changes no legality input — the standing edge stays
    // unjudged, exactly as before this contract existed.
    const result = computeRuleImpact(
      {
        addedEdges: [],
        removedEdges: [],
        changedProjects: [
          {
            name: "beta",
            changes: [{ field: "root", baseline: "libs/beta", head: "libs/beta-moved" }],
          },
        ],
      },
      headNodes(),
      { alpha: [{ target: "beta", type: "static" }] },
      [
        { name: "alpha", root: "libs/alpha", tags: ["layer:domain"] },
        { name: "beta", root: "libs/beta", tags: ["layer:util"] },
      ],
      [{ source: "alpha", target: "beta", type: "static" }],
      depConstraints,
    );
    expect(result.introduced).toEqual([]);
    expect(result.resolved).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeImpactConstraints
// ---------------------------------------------------------------------------

describe("computeImpactConstraints", () => {
  const depConstraints = [
    { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain", "layer:util"] },
    { sourceTag: "layer:util", onlyDependOnLibsWithTags: ["layer:util"] },
  ];

  function graph(overrides = {}) {
    return {
      nodes: {
        alpha: { name: "alpha", data: { root: "libs/alpha", tags: ["layer:domain"] } },
        beta: { name: "beta", data: { root: "libs/beta", tags: ["layer:util"] } },
        gamma: { name: "gamma", data: { root: "libs/gamma", tags: ["layer:app"] } },
      },
      dependencies: {
        alpha: [{ target: "beta", type: "static" }],
        gamma: [{ target: "beta", type: "static" }],
      },
      ...overrides,
    };
  }

  it("returns constraint rows for each dependent", () => {
    const g = graph();
    const result = computeImpactConstraints(
      "beta",
      ["alpha"],
      g.nodes,
      g.dependencies,
      depConstraints,
    );
    expect(result).toHaveLength(1);
    expect(result[0].project).toBe("alpha");
    expect(result[0].constraintRows).toHaveLength(1);
    expect(result[0].constraintRows[0].sourceTag).toBe("layer:domain");
  });

  it("identifies violations in edges to the target", () => {
    const g = graph();
    const result = computeImpactConstraints(
      "beta",
      ["gamma"],
      g.nodes,
      g.dependencies,
      depConstraints,
    );
    // gamma (layer:app) → beta (layer:util): gamma's tags match no row
    // → projectWithoutTagsCannotHaveDependencies
    expect(result).toHaveLength(1);
    expect(result[0].violations).toHaveLength(1);
    expect(result[0].violations[0].messageId).toBe("projectWithoutTagsCannotHaveDependencies");
  });

  it("returns no violations for allowed edges", () => {
    const g = graph();
    const result = computeImpactConstraints(
      "beta",
      ["alpha"],
      g.nodes,
      g.dependencies,
      depConstraints,
    );
    expect(result[0].violations).toEqual([]);
  });

  it("lists edges from the dependent to the target", () => {
    const g = graph();
    const result = computeImpactConstraints(
      "beta",
      ["alpha"],
      g.nodes,
      g.dependencies,
      depConstraints,
    );
    expect(result[0].edges).toHaveLength(1);
    expect(result[0].edges[0].target).toBe("beta");
    expect(result[0].edges[0].type).toBe("static");
  });

  it("handles a dependent not in the graph gracefully", () => {
    const g = graph();
    const result = computeImpactConstraints(
      "beta",
      ["nonexistent"],
      g.nodes,
      g.dependencies,
      depConstraints,
    );
    expect(result).toHaveLength(1);
    expect(result[0].project).toBe("nonexistent");
    expect(result[0].constraintRows).toEqual([]);
    expect(result[0].violations).toEqual([]);
  });

  it("carries description and remediation on constraint rows", () => {
    const configWithMeta = [
      {
        sourceTag: "layer:domain",
        onlyDependOnLibsWithTags: ["layer:domain"],
        description: "Domain isolation",
        remediation: "Depend on an application-owned interface",
      },
    ];
    const g = graph();
    const result = computeImpactConstraints(
      "beta",
      ["alpha"],
      g.nodes,
      g.dependencies,
      configWithMeta,
    );
    expect(result[0].constraintRows[0].description).toBe("Domain isolation");
    expect(result[0].constraintRows[0].remediation).toBe(
      "Depend on an application-owned interface",
    );
  });
});
