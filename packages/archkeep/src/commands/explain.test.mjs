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
            spelling: { path: false, relative: false, namesOnly: false },
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
            spelling: { path: false, relative: false, namesOnly: false },
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
            spelling: { path: false, relative: false, namesOnly: false },
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
            spelling: { path: false, relative: false, namesOnly: false },
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
            spelling: { path: false, relative: false, namesOnly: false },
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

  // -------------------------------------------------------------------------
  // result.verdict — the site-level verdict, on all three result shapes
  // -------------------------------------------------------------------------

  /** A graph where alpha (layer:domain) reaches beta (layer:app) — violating. */
  function violatingGraph() {
    return {
      nodes: {
        alpha: { name: "alpha", type: "lib", data: { root: "libs/alpha", tags: ["layer:domain"] } },
        beta: { name: "beta", type: "lib", data: { root: "libs/beta", tags: ["layer:app"] } },
      },
      dependencies: {
        alpha: [{ target: "beta", type: "static" }],
      },
    };
  }

  it("carries verdict 'clean' on a resolved non-violating site, with the old fields intact", () => {
    const result = explainCommand("libs/alpha/main.go:10:5", commandContext(), config());
    expect(result.explanation.verdict).toBe("clean");
    const envelope = JSON.parse(result.report.json);
    expect(Object.hasOwn(envelope.result, "verdict")).toBe(true);
    expect(envelope.result.verdict).toBe("clean");
    // Additive proof: every field the shape carried before is still present.
    expect(envelope.result.violations).toBe(null);
    expect(envelope.result.site).toEqual({ file: "libs/alpha/main.go", line: 10, column: 5 });
    expect(envelope.result.import.specifier).toBe("beta");
    expect(envelope.result.sourceTags).toEqual(["layer:domain"]);
    expect(envelope.result.matchedConstraints.length).toBe(1);
  });

  it("carries verdict 'violation' on a resolved violating site", () => {
    const ctx = commandContext({ graph: violatingGraph() });
    const result = explainCommand("libs/alpha/main.go:10:5", ctx, config());
    expect(result.explanation.verdict).toBe("violation");
    const envelope = JSON.parse(result.report.json);
    expect(envelope.result.verdict).toBe("violation");
    expect(envelope.result.violations).not.toBe(null);
  });

  it("carries verdict 'unknown' on an unresolvable site, keeping unresolvable and reason", () => {
    const ctx = commandContext({
      analysis: {
        analyzed: 1,
        imports: [],
        failures: [
          { sourceFile: "libs/alpha/main.go", line: 10, column: 5, reason: "non-literal argument" },
        ],
      },
    });
    const result = explainCommand("libs/alpha/main.go:10:5", ctx, config());
    expect(result.explanation.verdict).toBe("unknown");
    const envelope = JSON.parse(result.report.json);
    expect(envelope.result.verdict).toBe("unknown");
    // Additive proof: the unresolvable shape's old fields are untouched.
    expect(envelope.result.unresolvable).toBe(true);
    expect(envelope.result.reason).toBe("non-literal argument");
  });

  // -------------------------------------------------------------------------
  // violations[].remediation — a guaranteed key, verbatim or explicit null
  // -------------------------------------------------------------------------

  it("surfaces a declared remediation string verbatim on the violation entry", () => {
    const ctx = commandContext({ graph: violatingGraph() });
    const cfg = config({
      depConstraints: [
        {
          sourceTag: "layer:domain",
          onlyDependOnLibsWithTags: ["layer:domain", "layer:util"],
          remediation: "Depend on the domain's published interface instead",
        },
      ],
    });
    const result = explainCommand("libs/alpha/main.go:10:5", ctx, cfg);
    const envelope = JSON.parse(result.report.json);
    expect(envelope.result.violations[0].remediation).toBe(
      "Depend on the domain's published interface instead",
    );
  });

  it("guarantees remediation as an explicit null when the row declares none", () => {
    const ctx = commandContext({ graph: violatingGraph() });
    const result = explainCommand("libs/alpha/main.go:10:5", ctx, config());
    const envelope = JSON.parse(result.report.json);
    for (const v of envelope.result.violations) {
      // The guarantee IS the test: the key exists, and its value is null —
      // never an absent key a consumer cannot tell from a field that does
      // not exist yet.
      expect(Object.hasOwn(v, "remediation")).toBe(true);
      expect(v.remediation).toBe(null);
    }
  });

  // -------------------------------------------------------------------------
  // violations[].allowed — the governing row's own law-fact, never a computed
  // complement
  // -------------------------------------------------------------------------

  it("surfaces the governing row's onlyDependOnLibsWithTags verbatim as allowed", () => {
    const ctx = commandContext({ graph: violatingGraph() });
    const result = explainCommand("libs/alpha/main.go:10:5", ctx, config());
    const envelope = JSON.parse(result.report.json);
    const constraintViolation = envelope.result.violations.find(
      (v) => v.constraint?.onlyDependOnLibsWithTags,
    );
    expect(constraintViolation.allowed).toEqual(["layer:domain", "layer:util"]);
  });

  it("guarantees allowed as null for a notDependOnLibsWithTags row, computing no complement", () => {
    // gamma carries a tag the ban list does not name: a computed complement
    // would surface it ("everything but grade:closed"), and the law never
    // stated that direction — so it must appear nowhere in the entry.
    const ctx = commandContext({
      graph: {
        nodes: {
          alpha: { name: "alpha", type: "lib", data: { root: "libs/alpha", tags: ["zone:x"] } },
          beta: { name: "beta", type: "lib", data: { root: "libs/beta", tags: ["grade:closed"] } },
          gamma: { name: "gamma", type: "lib", data: { root: "libs/gamma", tags: ["grade:open"] } },
        },
        dependencies: {
          alpha: [{ target: "beta", type: "static" }],
        },
      },
    });
    const cfg = config({
      depConstraints: [{ sourceTag: "zone:x", notDependOnLibsWithTags: ["grade:closed"] }],
    });
    const result = explainCommand("libs/alpha/main.go:10:5", ctx, cfg);
    const envelope = JSON.parse(result.report.json);
    expect(envelope.result.verdict).toBe("violation");
    for (const v of envelope.result.violations) {
      expect(Object.hasOwn(v, "allowed")).toBe(true);
      expect(v.allowed).toBe(null);
      // The complement tag must not have been invented anywhere in the entry.
      expect(JSON.stringify(v)).not.toContain("grade:open");
    }
  });

  // -------------------------------------------------------------------------
  // Determinism — same fixture, byte-identical JSON
  // -------------------------------------------------------------------------

  it("produces byte-identical JSON across two runs over the same fixture", () => {
    const first = explainCommand("libs/alpha/main.go:10:5", commandContext(), config());
    const second = explainCommand("libs/alpha/main.go:10:5", commandContext(), config());
    expect(first.report.json).toBe(second.report.json);
  });
});
