import { describe, expect, it } from "vitest";

import { explainCommand, findSite, parseSite } from "./explain.mjs";

/**
 * What `explain` guarantees: an honest explanation of one import site's judgment,
 * never a finding itself. It never exits 1. It refuses to
 * explain when the graph is known to be incomplete (unregistered Nx plugin with
 * polyglot manifests), and it refuses when the site does not exist or the file
 * could not be analyzed at all — because explaining a position that was never
 * reached would be a claim about a judgment that never happened.
 */

// ---------------------------------------------------------------------------
// parseSite
// ---------------------------------------------------------------------------

describe("parseSite", () => {
  it("parses a well-formed site string", () => {
    expect(parseSite("libs/alpha/main.go:10:5")).toEqual({
      sourceFile: "libs/alpha/main.go",
      line: 10,
      column: 5,
    });
  });

  it("handles a file path with colons in the directory part", () => {
    expect(parseSite("libs/a:b/c.go:1:2")).toEqual({
      sourceFile: "libs/a:b/c.go",
      line: 1,
      column: 2,
    });
  });

  it("throws when there are fewer than two colons", () => {
    expect(() => parseSite("file.go")).toThrow(/not a valid site/);
    expect(() => parseSite("file.go:10")).toThrow(/not a valid site/);
  });

  it("throws when the file part is empty", () => {
    expect(() => parseSite(":10:5")).toThrow(/file part is empty/);
  });

  it("throws when line is not a positive integer", () => {
    expect(() => parseSite("file.go:0:5")).toThrow(/line must be a positive integer/);
    expect(() => parseSite("file.go:-1:5")).toThrow(/line must be a positive integer/);
    expect(() => parseSite("file.go:abc:5")).toThrow(/line must be a positive integer/);
  });

  it("throws when column is not a positive integer", () => {
    expect(() => parseSite("file.go:1:0")).toThrow(/column must be a positive integer/);
    expect(() => parseSite("file.go:1:-1")).toThrow(/column must be a positive integer/);
    expect(() => parseSite("file.go:1:abc")).toThrow(/column must be a positive integer/);
  });
});

// ---------------------------------------------------------------------------
// findSite
// ---------------------------------------------------------------------------

describe("findSite", () => {
  const imports = [
    { sourceFile: "libs/alpha/a.go", line: 1, column: 2, specifier: "beta" },
    { sourceFile: "libs/alpha/b.go", line: 3, column: 4, specifier: "gamma" },
  ];

  it("returns the matching record when one exists", () => {
    expect(findSite({ sourceFile: "libs/alpha/a.go", line: 1, column: 2 }, imports)).toBe(
      imports[0],
    );
  });

  it("returns null when no record matches", () => {
    expect(findSite({ sourceFile: "libs/alpha/a.go", line: 99, column: 1 }, imports)).toBe(null);
  });

  it("returns null when the file does not exist in the records", () => {
    expect(findSite({ sourceFile: "libs/delta/x.go", line: 1, column: 1 }, imports)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// explainCommand
// ---------------------------------------------------------------------------

describe("explainCommand", () => {
  /** A minimal boundary config with one constraint row. */
  function config(overrides = {}) {
    return {
      depConstraints: [
        { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain", "layer:util"] },
      ],
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
      suppressions: [],
      ...overrides,
    };
  }

  /** Minimal command context for the explain tests. */
  function commandContext(overrides = {}) {
    return {
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
          alpha: [{ target: "beta", type: "static" }],
        },
      },
      analysis: {
        analyzed: 2,
        imports: [
          {
            sourceFile: "libs/alpha/main.go",
            line: 10,
            column: 5,
            specifier: "beta",
            kind: "static",
            spelling: { path: false, relative: false },
            resolved: { target: "beta", file: "libs/beta/mod.go", external: false },
          },
        ],
        failures: [],
      },
      pluginGap: { registered: true, manifests: [] },
      ...overrides,
    };
  }

  it("returns 'ok' status and an allowed explanation for a non-violating import", () => {
    const result = explainCommand("libs/alpha/main.go:10:5", commandContext(), config());
    expect(result.status).toBe("ok");
    expect(result.explanation.unresolvable).toBe(false);
    expect(result.explanation.sourceProject).toBe("alpha");
    expect(result.explanation.targetProject).toBe("beta");
    expect(result.explanation.sourceTags).toEqual(["layer:domain"]);
    expect(result.explanation.targetTags).toEqual(["layer:util"]);
    expect(result.explanation.violations).toBe(null);
    // The source project has a matching constraint row.
    expect(result.explanation.matchedConstraints.length).toBeGreaterThan(0);
  });

  it("returns a violation explanation when the import violates a constraint", () => {
    // beta has layer:app, but the constraint says layer:domain may only reach
    // layer:domain or layer:util — so alpha→beta violates.
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
    const result = explainCommand("libs/alpha/main.go:10:5", ctx, config());
    expect(result.explanation.violations).not.toBe(null);
  });

  it("throws when the plugin is unregistered on a polyglot Nx workspace", () => {
    expect(() =>
      explainCommand(
        "libs/alpha/main.go:10:5",
        commandContext({
          provider: "nx",
          pluginGap: { registered: false, manifests: ["libs/alpha/go.mod"] },
        }),
        config(),
      ),
    ).toThrow(/refusing to explain a judgment/);
  });

  it("does not throw when the plugin is unregistered on a pure-TypeScript Nx workspace", () => {
    const result = explainCommand(
      "libs/alpha/main.go:10:5",
      commandContext({
        provider: "nx",
        pluginGap: { registered: false, manifests: [] },
      }),
      config(),
    );
    expect(result.status).toBe("ok");
  });

  it("throws when the site does not exist and the file has no whole-file failure", () => {
    expect(() => explainCommand("libs/alpha/main.go:99:1", commandContext(), config())).toThrow(
      /no import site at/,
    );
  });

  it("throws when the site's file had a whole-file failure", () => {
    const ctx = commandContext({
      analysis: {
        analyzed: 0,
        imports: [],
        failures: [
          { sourceFile: "libs/alpha/main.go", line: null, column: null, reason: "parse error" },
        ],
      },
    });
    expect(() => explainCommand("libs/alpha/main.go:10:5", ctx, config())).toThrow(
      /could not be analyzed at all/,
    );
  });

  it("returns an unresolvable explanation for a site-level failure", () => {
    const ctx = commandContext({
      analysis: {
        analyzed: 1,
        imports: [],
        failures: [
          {
            sourceFile: "libs/alpha/main.go",
            line: 10,
            column: 5,
            reason: "non-literal argument",
          },
        ],
      },
    });
    const result = explainCommand("libs/alpha/main.go:10:5", ctx, config());
    expect(result.explanation.unresolvable).toBe(true);
    expect(result.explanation.reason).toBe("non-literal argument");
    // The unresolvable case still has a valid envelope.
    expect(result.report.json).toContain('"schemaVersion"');
    expect(result.report.json).toContain('"command": "explain"');
  });

  it("returns 'no-verdict' status when coverage is incomplete", () => {
    const ctx = commandContext({
      analysis: {
        analyzed: 1,
        imports: [
          {
            sourceFile: "libs/alpha/main.go",
            line: 10,
            column: 5,
            specifier: "beta",
            kind: "static",
            spelling: { path: false, relative: false },
            resolved: { target: "beta", file: "libs/beta/mod.go", external: false },
          },
        ],
        failures: [
          { sourceFile: "libs/beta/other.go", line: null, column: null, reason: "unreadable" },
        ],
      },
    });
    const result = explainCommand("libs/alpha/main.go:10:5", ctx, config());
    expect(result.status).toBe("no-verdict");
    expect(result.coverage.complete).toBe(false);
  });

  it("reports an unresolvable site at exit code 3 when another file could not be analyzed", () => {
    // The site itself is a legitimate unresolvable failure; a whole-file
    // failure on ANOTHER file makes the run incomplete. readBaseline
    // semantics: the envelope must carry exit 3, so a consumer never reads
    // an incomplete explanation as a clean one.
    const ctx = commandContext({
      analysis: {
        analyzed: 1,
        imports: [],
        failures: [
          { sourceFile: "libs/alpha/main.go", line: 10, column: 5, reason: "non-literal argument" },
          { sourceFile: "libs/beta/other.go", line: null, column: null, reason: "unreadable" },
        ],
      },
    });
    const result = explainCommand("libs/alpha/main.go:10:5", ctx, config());
    expect(result.status).toBe("no-verdict");
    expect(result.explanation.unresolvable).toBe(true);
    const envelope = JSON.parse(result.report.json);
    expect(envelope.exitCode).toBe(3);
  });

  it("explains an external import from a file no project owns with no project context", () => {
    // The import resolves to no project (external crate) and the file sits
    // outside every project root: sourceProject, targetProject and both tag
    // lists must read as their empty forms — null or [] — never as guessed
    // values, and never as a crash.
    const ctx = commandContext({
      analysis: {
        analyzed: 1,
        imports: [
          {
            sourceFile: "loose/tool.go",
            line: 3,
            column: 5,
            specifier: "github.com/acme/widget",
            kind: "static",
            spelling: { path: false, relative: false },
            resolved: { target: null, file: null, external: true },
          },
        ],
        failures: [],
      },
    });
    const result = explainCommand("loose/tool.go:3:5", ctx, config());
    expect(result.explanation.sourceProject).toBeNull();
    expect(result.explanation.targetProject).toBeNull();
    expect(result.explanation.sourceTags).toEqual([]);
    expect(result.explanation.targetTags).toEqual([]);
    expect(result.explanation.matchedConstraints).toEqual([]);
    expect(result.explanation.import.specifier).toBe("github.com/acme/widget");
    expect(result.explanation.import.targetProject).toBeNull();
  });

  it("derives sourceProject from the file path, not from the import record", () => {
    // The import record has no sourceProject field — the analysis contract
    // keeps no project name on the record. explainCommand must derive it from
    // findProjectForPath.
    const result = explainCommand("libs/alpha/main.go:10:5", commandContext(), config());
    expect(result.explanation.sourceProject).toBe("alpha");
  });

  it("produces both text and JSON report renderings", () => {
    const result = explainCommand("libs/alpha/main.go:10:5", commandContext(), config());
    expect(result.report.text).toContain("libs/alpha/main.go:10:5");
    expect(result.report.text).toContain("allowed");
    expect(result.report.json).toContain('"schemaVersion"');
    expect(result.report.json).toContain('"command": "explain"');
  });

  it("never exits 1 — explain is descriptive, not a finding", () => {
    // Even a violating import is explained, not found.
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
    const result = explainCommand("libs/alpha/main.go:10:5", ctx, config());
    expect(result.status).not.toBe("findings");
  });

  it("includes blind spots in coverage from non-whole-file failures", () => {
    const ctx = commandContext({
      analysis: {
        analyzed: 2,
        imports: [
          {
            sourceFile: "libs/alpha/main.go",
            line: 10,
            column: 5,
            specifier: "beta",
            kind: "static",
            spelling: { path: false, relative: false },
            resolved: { target: "beta", file: "libs/beta/mod.go", external: false },
          },
        ],
        failures: [
          {
            sourceFile: "libs/alpha/other.go",
            line: 7,
            column: 2,
            reason: "unresolvable specifier",
          },
        ],
      },
    });
    const result = explainCommand("libs/alpha/main.go:10:5", ctx, config());
    expect(result.coverage.blindSpots).toEqual([
      { file: "libs/alpha/other.go", line: 7, column: 2, reason: "unresolvable specifier" },
    ]);
    // Not a whole-file failure, so coverage is still "complete".
    expect(result.coverage.complete).toBe(true);
  });

  it("renders the constraint row that matched in the explanation", () => {
    const result = explainCommand("libs/alpha/main.go:10:5", commandContext(), config());
    expect(result.explanation.matchedConstraints.length).toBe(1);
    expect(result.explanation.matchedConstraints[0].sourceTag).toBe("layer:domain");
  });

  it("returns all violations at a site when multiple rules fire", () => {
    // A site can violate multiple rules — e.g. bannedExternalImports AND
    // noTransitiveDependencies. An agent seeing only the first might fix it and
    // be confused when check still fails. Return all of them.
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
      analysis: {
        analyzed: 2,
        imports: [
          {
            sourceFile: "libs/alpha/main.go",
            line: 10,
            column: 5,
            specifier: "beta",
            kind: "static",
            spelling: { path: false, relative: false },
            resolved: { target: "beta", file: "libs/beta/mod.go", external: false },
          },
        ],
        failures: [],
      },
    });
    // Use a config where the same import violates both a depConstraint and
    // banTransitiveDependencies — two different rules.
    const cfg = config({
      depConstraints: [
        { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain", "layer:util"] },
      ],
      options: {
        ...config().options,
        banTransitiveDependencies: true,
      },
    });
    const result = explainCommand("libs/alpha/main.go:10:5", ctx, cfg);
    expect(result.explanation.violations).not.toBe(null);
    expect(Array.isArray(result.explanation.violations)).toBe(true);
    // Each violation has the shape { messageId, message, constraint }.
    for (const v of result.explanation.violations) {
      expect(v).toHaveProperty("messageId");
      expect(v).toHaveProperty("message");
    }
    // The JSON result also carries the violations array.
    const parsed = JSON.parse(result.report.json);
    expect(Array.isArray(parsed.result.violations)).toBe(true);
  });

  it("returns violations as null when the import is allowed", () => {
    const result = explainCommand("libs/alpha/main.go:10:5", commandContext(), config());
    expect(result.explanation.violations).toBe(null);
  });

  it("shows (none) when the source project matches no constraint row", () => {
    const ctx = commandContext({
      graph: {
        nodes: {
          alpha: {
            name: "alpha",
            type: "lib",
            data: { root: "libs/alpha", tags: ["scope:billing"] },
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
    });
    const result = explainCommand("libs/alpha/main.go:10:5", ctx, config());
    expect(result.explanation.matchedConstraints).toEqual([]);
    expect(result.report.text).toContain("(none");
  });
});
