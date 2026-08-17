import { describe, expect, it } from "vitest";

import { collectProjectContext, contextCommand } from "./context-command.mjs";

/**
 * What `context` guarantees: the result is an honest account of which
 * architecture constraints apply to the named project, and the silent direction
 * is guarded — a project with no tags says "none", a project whose tags match
 * no constraint row says so explicitly, and incomplete coverage produces a
 * no-verdict status rather than a silently incomplete answer.
 */

// ---------------------------------------------------------------------------
// collectProjectContext
// ---------------------------------------------------------------------------

describe("collectProjectContext", () => {
  it("returns the project's tags and matching constraint rows", () => {
    const graph = {
      nodes: {
        alpha: { name: "alpha", type: "lib", data: { root: "libs/alpha", tags: ["layer:domain"] } },
        beta: { name: "beta", type: "lib", data: { root: "libs/beta", tags: ["layer:util"] } },
      },
      dependencies: {},
    };
    const config = {
      depConstraints: [
        { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain", "layer:util"] },
        { sourceTag: "layer:util", onlyDependOnLibsWithTags: ["layer:util"] },
      ],
    };
    const result = collectProjectContext("alpha", graph, config);
    expect(result.project).toBe("alpha");
    expect(result.tags).toEqual(["layer:domain"]);
    expect(result.constraints).toHaveLength(1);
    expect(result.constraints[0].sourceTag).toBe("layer:domain");
  });

  it("returns empty tags for a project with none", () => {
    const graph = {
      nodes: { alpha: { name: "alpha", type: "lib", data: { root: "libs/alpha", tags: [] } } },
      dependencies: {},
    };
    const config = { depConstraints: [] };
    const result = collectProjectContext("alpha", graph, config);
    expect(result.tags).toEqual([]);
  });

  it("returns empty constraints when no constraint row matches the project's tags", () => {
    const graph = {
      nodes: {
        alpha: { name: "alpha", type: "lib", data: { root: "libs/alpha", tags: ["layer:app"] } },
      },
      dependencies: {},
    };
    const config = {
      depConstraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] }],
    };
    const result = collectProjectContext("alpha", graph, config);
    expect(result.constraints).toEqual([]);
  });

  it("matches allSourceTags constraint rows", () => {
    const graph = {
      nodes: {
        alpha: {
          name: "alpha",
          type: "lib",
          data: { root: "libs/alpha", tags: ["layer:domain", "scope:billing"] },
        },
      },
      dependencies: {},
    };
    const config = {
      depConstraints: [
        {
          allSourceTags: ["layer:domain", "scope:billing"],
          onlyDependOnLibsWithTags: ["layer:domain"],
        },
      ],
    };
    const result = collectProjectContext("alpha", graph, config);
    expect(result.constraints).toHaveLength(1);
    expect(result.constraints[0].allSourceTags).toEqual(["layer:domain", "scope:billing"]);
  });

  it("throws when the project is not in the graph", () => {
    const graph = { nodes: { a: { name: "a" } }, dependencies: {} };
    const config = { depConstraints: [] };
    expect(() => collectProjectContext("nonexistent", graph, config)).toThrow(
      /no project named 'nonexistent'/,
    );
  });

  it("lists available projects in the error message when the project is not found", () => {
    const graph = {
      nodes: { alpha: { name: "alpha" }, beta: { name: "beta" } },
      dependencies: {},
    };
    const config = { depConstraints: [] };
    expect(() => collectProjectContext("missing", graph, config)).toThrow(
      /available projects: alpha, beta/,
    );
  });

  it("lists available projects ascending even when declared in descending order", () => {
    const graph = {
      nodes: { beta: { name: "beta" }, alpha: { name: "alpha" } },
      dependencies: {},
    };
    const config = { depConstraints: [] };
    expect(() => collectProjectContext("missing", graph, config)).toThrow(
      /available projects: alpha, beta/,
    );
  });

  it("reads tags from data.tags when present (Nx graph shape)", () => {
    const graph = {
      nodes: {
        alpha: { name: "alpha", type: "lib", data: { root: "libs/alpha", tags: ["layer:domain"] } },
      },
      dependencies: {},
    };
    const config = { depConstraints: [] };
    const result = collectProjectContext("alpha", graph, config);
    expect(result.tags).toEqual(["layer:domain"]);
  });

  it("reads tags from data.tags only — node.tags is never written by any provider", () => {
    // No provider sets node.tags; they all write to data.tags. A node with tags
    // only on node.tags (not data.tags) has no tags as far as the engine is
    // concerned — the display and the matcher must agree.
    const graph = {
      nodes: {
        alpha: { name: "alpha", type: "lib", data: { root: "libs/alpha" }, tags: ["layer:domain"] },
      },
      dependencies: {},
    };
    const config = { depConstraints: [] };
    const result = collectProjectContext("alpha", graph, config);
    expect(result.tags).toEqual([]);
  });

  it("matches zero constraint rows when tags exist on node.tags but not data.tags", () => {
    // Bug 3 pin: display and matching must agree. Before the fix, a node
    // with tags only on node.tags showed tags in the output but matched
    // zero constraint rows — a false negative.
    const graph = {
      nodes: {
        alpha: { name: "alpha", type: "lib", data: { root: "libs/alpha" }, tags: ["layer:domain"] },
      },
      dependencies: {},
    };
    const config = {
      depConstraints: [
        { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain", "layer:util"] },
      ],
    };
    const result = collectProjectContext("alpha", graph, config);
    // Tags are empty (read from data.tags which is absent), so no constraints match
    expect(result.tags).toEqual([]);
    expect(result.constraints).toEqual([]);
  });

  it("preserves description and remediation on constraint rows", () => {
    const graph = {
      nodes: {
        alpha: { name: "alpha", type: "lib", data: { root: "libs/alpha", tags: ["layer:domain"] } },
      },
      dependencies: {},
    };
    const config = {
      depConstraints: [
        {
          sourceTag: "layer:domain",
          onlyDependOnLibsWithTags: ["layer:domain"],
          description: "Domain isolation",
          remediation: "Depend on an application-owned interface",
        },
      ],
    };
    const result = collectProjectContext("alpha", graph, config);
    expect(result.constraints[0].description).toBe("Domain isolation");
    expect(result.constraints[0].remediation).toBe("Depend on an application-owned interface");
  });

  it("includes dependencies with per-edge constraint verdicts", () => {
    const graph = {
      nodes: {
        alpha: { name: "alpha", type: "lib", data: { root: "libs/alpha", tags: ["layer:domain"] } },
        beta: { name: "beta", type: "lib", data: { root: "libs/beta", tags: ["layer:util"] } },
        gamma: { name: "gamma", type: "lib", data: { root: "libs/gamma", tags: ["layer:app"] } },
      },
      dependencies: {
        alpha: [
          { target: "beta", type: "static" },
          { target: "gamma", type: "static" },
        ],
      },
    };
    const config = {
      depConstraints: [
        { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain", "layer:util"] },
      ],
    };
    const result = collectProjectContext("alpha", graph, config);
    expect(result.dependencies).toHaveLength(2);
    // alpha → beta is allowed (beta has layer:util which is in onlyDependOnLibsWithTags).
    const betaDep = result.dependencies.find((d) => d.target === "beta");
    expect(betaDep.type).toBe("static");
    expect(betaDep.violations).toEqual([]);
    // alpha → gamma is a violation (gamma has layer:app which is not allowed).
    const gammaDep = result.dependencies.find((d) => d.target === "gamma");
    expect(gammaDep.type).toBe("static");
    expect(gammaDep.violations.length).toBeGreaterThan(0);
    expect(gammaDep.violations[0].messageId).toBe("onlyTagsConstraintViolation");
  });

  it("lists no dependencies for a project with no outgoing edges", () => {
    const graph = {
      nodes: {
        alpha: { name: "alpha", type: "lib", data: { root: "libs/alpha", tags: ["layer:domain"] } },
      },
      dependencies: {},
    };
    const config = {
      depConstraints: [
        { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain", "layer:util"] },
      ],
    };
    const result = collectProjectContext("alpha", graph, config);
    expect(result.dependencies).toEqual([]);
  });

  it("flags a projectWithoutTagsCannotHaveDependencies violation on an edge from an untagged source", () => {
    const graph = {
      nodes: {
        alpha: {
          name: "alpha",
          type: "lib",
          data: { root: "libs/alpha", tags: ["scope:billing"] },
        },
        beta: { name: "beta", type: "lib", data: { root: "libs/beta", tags: ["layer:util"] } },
      },
      dependencies: {
        alpha: [{ target: "beta", type: "static" }],
      },
    };
    const config = {
      depConstraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] }],
    };
    const result = collectProjectContext("alpha", graph, config);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0].violations.length).toBeGreaterThan(0);
    expect(result.dependencies[0].violations[0].messageId).toBe(
      "projectWithoutTagsCannotHaveDependencies",
    );
  });
});

// ---------------------------------------------------------------------------
// contextCommand
// ---------------------------------------------------------------------------

describe("contextCommand", () => {
  /** Minimal command context that passes the unregistered-plugin refusal. */
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
            data: { root: "libs/beta", tags: ["layer:util"] },
          },
        },
        dependencies: {
          alpha: [{ target: "beta", type: "static" }],
        },
      },
      analysis: {
        analyzed: 4,
        imports: [{ sourceFile: "libs/alpha/main.go", specifier: "beta", line: 1, column: 1 }],
        failures: [],
      },
      pluginGap: { registered: true, manifests: [] },
      ...overrides,
    };
  }

  /** Minimal boundary config with a depConstraints table. */
  function config(overrides = {}) {
    return {
      depConstraints: [
        { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain", "layer:util"] },
        { sourceTag: "layer:util", onlyDependOnLibsWithTags: ["layer:util"] },
      ],
      ...overrides,
    };
  }

  it("returns 'ok' status with the project's tags and matching constraints", () => {
    const result = contextCommand("alpha", commandContext(), config());
    expect(result.status).toBe("ok");
    expect(result.projectContext.project).toBe("alpha");
    expect(result.projectContext.tags).toEqual(["layer:domain"]);
    expect(result.projectContext.constraints).toHaveLength(1);
    expect(result.projectContext.constraints[0].sourceTag).toBe("layer:domain");
  });

  it("warns in coverage.notes that per-edge verdicts cover only depConstraints", () => {
    const result = contextCommand("alpha", commandContext(), config());
    expect(result.coverage.notes).toHaveLength(1);
    expect(result.coverage.notes[0]).toContain("depConstraints");
    expect(result.coverage.notes[0]).toContain("check");
  });

  it("returns 'no-verdict' status when coverage is incomplete", () => {
    const result = contextCommand(
      "alpha",
      commandContext({
        analysis: {
          analyzed: 2,
          imports: [],
          failures: [
            { sourceFile: "libs/beta/broken.go", line: null, column: null, reason: "parse error" },
          ],
        },
      }),
      config(),
    );
    expect(result.status).toBe("no-verdict");
  });

  it("throws when the project is not in the graph", () => {
    expect(() => contextCommand("nonexistent", commandContext(), config())).toThrow(
      /no project named 'nonexistent'/,
    );
  });

  it("throws when the plugin is unregistered on a polyglot Nx workspace", () => {
    expect(() =>
      contextCommand(
        "alpha",
        commandContext({
          provider: "nx",
          pluginGap: { registered: false, manifests: ["libs/alpha/go.mod"] },
        }),
        config(),
      ),
    ).toThrow(/refusing to show context/);
  });

  it("does not throw when the plugin is unregistered on a pure-TypeScript Nx workspace", () => {
    const result = contextCommand(
      "alpha",
      commandContext({ provider: "nx", pluginGap: { registered: false, manifests: [] } }),
      config(),
    );
    expect(result.status).toBe("ok");
  });

  it("does not throw when the plugin is registered even with polyglot manifests", () => {
    const result = contextCommand(
      "alpha",
      commandContext({
        provider: "nx",
        pluginGap: { registered: true, manifests: ["libs/alpha/go.mod"] },
      }),
      config(),
    );
    expect(result.status).toBe("ok");
  });

  it("produces both text and JSON report renderings", () => {
    const result = contextCommand("alpha", commandContext(), config());
    expect(result.report.text).toContain("Project  alpha");
    expect(result.report.text).toContain("layer:domain");
    expect(result.report.json).toContain('"schemaVersion"');
    expect(result.report.json).toContain('"command": "context"');
  });

  it("includes blind spots from non-whole-file failures", () => {
    const result = contextCommand(
      "alpha",
      commandContext({
        analysis: {
          analyzed: 4,
          imports: [],
          failures: [
            { sourceFile: "libs/alpha/a.go", line: 7, column: 2, reason: "unresolvable specifier" },
          ],
        },
      }),
      config(),
    );
    expect(result.status).toBe("ok");
    expect(result.coverage.complete).toBe(true);
    expect(result.coverage.blindSpots).toEqual([
      { file: "libs/alpha/a.go", line: 7, column: 2, reason: "unresolvable specifier" },
    ]);
  });

  it("never exits 1 — context is descriptive", () => {
    const result = contextCommand("alpha", commandContext(), config());
    expect(result.status).not.toBe("findings");
  });

  it("carries constraint description and remediation in the result", () => {
    const result = contextCommand(
      "alpha",
      commandContext(),
      config({
        depConstraints: [
          {
            sourceTag: "layer:domain",
            onlyDependOnLibsWithTags: ["layer:domain"],
            description: "Domain isolation",
            remediation: "Depend on an application-owned interface",
          },
        ],
      }),
    );
    expect(result.projectContext.constraints[0].description).toBe("Domain isolation");
    expect(result.projectContext.constraints[0].remediation).toBe(
      "Depend on an application-owned interface",
    );
  });

  it("includes dependencies with per-edge verdicts in the result", () => {
    const result = contextCommand("alpha", commandContext(), config());
    expect(result.projectContext.dependencies).toHaveLength(1);
    expect(result.projectContext.dependencies[0].target).toBe("beta");
    expect(result.projectContext.dependencies[0].type).toBe("static");
    // alpha→beta is allowed: alpha has layer:domain, beta has layer:util,
    // and the constraint allows layer:domain to reach layer:util.
    expect(result.projectContext.dependencies[0].violations).toEqual([]);
  });

  it("includes a violating edge in the dependencies result", () => {
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
            data: { root: "libs/beta", tags: ["layer:app"] },
          },
        },
        dependencies: {
          alpha: [{ target: "beta", type: "static" }],
        },
      },
    });
    const result = contextCommand("alpha", ctx, config());
    expect(result.projectContext.dependencies).toHaveLength(1);
    expect(result.projectContext.dependencies[0].violations.length).toBeGreaterThan(0);
  });

  it("renders dependencies in the text report", () => {
    const result = contextCommand("alpha", commandContext(), config());
    expect(result.report.text).toContain("Dependencies");
    expect(result.report.text).toContain("beta (static) allowed");
  });

  it("renders a violating dependency in the text report", () => {
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
            data: { root: "libs/beta", tags: ["layer:app"] },
          },
        },
        dependencies: {
          alpha: [{ target: "beta", type: "static" }],
        },
      },
    });
    const result = contextCommand("alpha", ctx, config());
    expect(result.report.text).toContain("beta (static) VIOLATION");
  });

  // P1-02: a matched constraint row's decisionRef used to render verbatim,
  // unverified — the finding's own reproduction, for the `context` command
  // specifically. `commandContext()`'s root ("/workspace") has no real
  // `docs/adr/` behind it, so this drives the REAL `readAdrContext` (not a
  // mock) through its natural "no registry → every citation unknown" path —
  // the same answer a genuinely nonexistent ADR id gets on a real tree.
  describe("decisionRef resolution (P1-02)", () => {
    it("flags a matched constraint row's decisionRef when it cannot resolve", () => {
      const result = contextCommand(
        "alpha",
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
      expect(result.projectContext.unresolvedDecisionRefs).toEqual(["9999-does-not-exist"]);
      // Report-only: context is descriptive and never exits 1; an unresolved
      // citation is a documentation fact, not a coverage or graph problem.
      expect(result.status).toBe("ok");
    });

    it("never reads the ADR registry, and carries no unresolvedDecisionRefs field, when no matched row cites one", () => {
      const result = contextCommand("alpha", commandContext(), config());
      expect(result.report.text).not.toContain("decisionRef");
      expect(result.projectContext.unresolvedDecisionRefs).toBeUndefined();
    });
  });

  it("renders (none) when the project has no dependencies", () => {
    const ctx = commandContext({
      graph: {
        nodes: {
          alpha: {
            name: "alpha",
            type: "lib",
            data: { root: "libs/alpha", tags: ["layer:domain"] },
          },
        },
        dependencies: {},
      },
    });
    const result = contextCommand("alpha", ctx, config());
    expect(result.report.text).toContain("Dependencies  (none)");
  });
});
