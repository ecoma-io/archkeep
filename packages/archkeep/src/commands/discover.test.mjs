import { describe, expect, it, vi } from "vitest";

import { buildObserved, discoverCommand, proposalToIntent } from "./discover.mjs";
import { formatDiscoverReport } from "../report/discover-text.mjs";

vi.mock("./provenance.mjs", () => ({ resolveProvenance: vi.fn(() => "mock-provenance") }));

/** A CommandContext shaped like `resolveCommandContext` produces. */
function commandContext(overrides = {}) {
  return {
    root: "/workspace",
    provider: "native",
    marker: "archkeep.json",
    graph: {
      nodes: {
        core: { name: "core", data: { root: "libs/core", tags: ["layer:domain"] } },
        util: { name: "util", data: { root: "libs/util", tags: [] } },
        app: { name: "app", data: { root: "apps/app", tags: [] } },
      },
      dependencies: {
        app: [{ source: "app", target: "core", type: "static" }],
        core: [{ source: "core", target: "util", type: "static" }],
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

describe("buildObserved", () => {
  it("reports the same project model every command judges, dropping external and implicit edges", () => {
    const { projects, edges } = buildObserved(
      commandContext({
        graph: {
          nodes: {
            app: { name: "app", data: { root: "apps/app", tags: [] } },
            lib: { name: "lib", data: { root: "libs/lib", tags: [] } },
          },
          dependencies: {
            app: [
              { source: "app", target: "lib", type: "static" },
              { source: "app", target: "npm:lodash", type: "static" },
              { source: "app", target: "lib", type: "implicit" },
            ],
          },
        },
      }),
    );
    expect(projects.map((p) => p.name)).toEqual(["app", "lib"]);
    expect(edges).toEqual([{ source: "app", target: "lib", type: "static" }]);
  });
});

describe("discoverCommand", () => {
  it("reports observed facts descriptively and never proposes without --propose", () => {
    const result = discoverCommand(commandContext());
    expect(result.status).toBe("ok");
    expect(result.proposal).toBeNull();
    expect(result.discovery.projects.map((p) => p.name)).toEqual(["app", "core", "util"]);
    expect(result.discovery.edges).toEqual([
      { source: "app", target: "core", type: "static" },
      { source: "core", target: "util", type: "static" },
    ]);
    // The tags union is sorted and deduplicated.
    expect(result.discovery.tags).toEqual(["layer:domain"]);
    // The envelope result carries the discovery payload with no proposal field.
    expect(JSON.parse(result.report.json).result.discovery.projects.length).toBe(3);
    expect(JSON.parse(result.report.json).result.proposal).toBeUndefined();
  });

  it("emits marked proposals under --propose, never the authority of a decision", () => {
    const result = discoverCommand(commandContext(), { propose: true });
    expect(result.proposal.proposed).toBe(true);
    expect(result.proposal.notAuthoritative).toBe(true);
    for (const list of [
      result.proposal.components.items,
      result.proposal.boundaryAssertions.items,
      result.proposal.tagVocabulary.items,
      result.proposal.rules.items,
    ]) {
      for (const item of list) {
        expect(item.proposed).toBe(true);
        expect(item.notAuthoritative).toBe(true);
      }
    }
    // A component emerges for libs (core+util) and an edge assertion for
    // app→core crossing apps/libs.
    expect(result.proposal.components.items.map((c) => c.name)).toContain("libs");
    expect(
      result.proposal.boundaryAssertions.items.some((a) => a.kind === "edge" && a.source === "app"),
    ).toBe(true);
    // The JSON envelope carries the proposal under result.proposal.
    expect(JSON.parse(result.report.json).result.proposal.proposed).toBe(true);
  });

  it("yields the unknown proposal on an empty workspace — nothing observed means nothing to propose", () => {
    const result = discoverCommand(
      commandContext({
        graph: { nodes: {}, dependencies: {} },
        analysis: { analyzed: 0, imports: [], failures: [] },
      }),
      { propose: true },
    );
    expect(result.status).toBe("ok");
    expect(result.proposal.unknown).toBe(true);
    expect(result.proposal.components.total).toBe(0);
    expect(result.discovery.projects).toEqual([]);
  });

  it("returns no-verdict over an incomplete coverage — every candidate would be ambiguous", () => {
    const result = discoverCommand(
      commandContext({
        analysis: {
          analyzed: 3,
          imports: [],
          failures: [
            { sourceFile: "libs/core/broken.go", line: null, column: null, reason: "parse error" },
          ],
        },
      }),
    );
    expect(result.status).toBe("no-verdict");
    expect(result.coverage.complete).toBe(false);
  });

  it("refuses --propose over incomplete coverage — the silent direction", () => {
    expect(() =>
      discoverCommand(
        commandContext({
          analysis: {
            analyzed: 3,
            imports: [],
            failures: [
              {
                sourceFile: "libs/core/broken.go",
                line: null,
                column: null,
                reason: "parse error",
              },
            ],
          },
        }),
        { propose: true },
      ),
    ).toThrow(/discover --propose has incomplete coverage/);
  });

  it("refuses an Nx workspace with polyglot manifests and the plugin unregistered", () => {
    expect(() =>
      discoverCommand(
        commandContext({
          provider: "nx",
          marker: "nx.json",
          pluginGap: { registered: false, manifests: ["libs/core/go.mod"] },
        }),
      ),
    ).toThrow(/refusing to judge/);
  });

  it("reports blind spots without failing the descriptive run", () => {
    const result = discoverCommand(
      commandContext({
        analysis: {
          analyzed: 4,
          imports: [],
          failures: [
            { sourceFile: "libs/core/a.go", line: 7, column: 2, reason: "unresolvable specifier" },
          ],
        },
      }),
    );
    expect(result.status).toBe("ok");
    expect(result.coverage.complete).toBe(true);
    expect(result.coverage.blindSpots).toEqual([
      { file: "libs/core/a.go", line: 7, column: 2, reason: "unresolvable specifier" },
    ]);
  });

  it("produces deterministic byte-identical JSON across runs", () => {
    const first = discoverCommand(commandContext(), { propose: true });
    const second = discoverCommand(commandContext(), { propose: true });
    expect(second.report.json).toBe(first.report.json);
    expect(second.report.text).toBe(first.report.text);
  });
});

describe("formatDiscoverReport", () => {
  it("states the coverage claim above the listing", () => {
    const report = formatDiscoverReport({
      discovery: {
        projects: [{ name: "a", root: "libs/a", tags: [] }],
        edges: [],
        tags: [],
      },
      proposal: null,
      coverage: { complete: true, imports: 0, analyzedFiles: 1, projects: 1, notAnalyzed: [] },
    });
    expect(report.split("\n")[0]).toContain("discovery complete");
  });

  it("renders the proposal-only banner on every candidate line and names the no-commitment posture", () => {
    const report = formatDiscoverReport({
      discovery: {
        projects: [
          { name: "core", root: "libs/core", type: "lib", tags: ["layer:domain"] },
          { name: "util", root: "libs/util", type: "lib", tags: [] },
        ],
        edges: [],
        tags: ["layer:domain"],
      },
      proposal: {
        unknown: false,
        components: {
          total: 1,
          items: [
            {
              kind: "component",
              name: "libs",
              projects: ["core", "util"],
              confidence: "medium",
              proposed: true,
              notAuthoritative: true,
            },
          ],
        },
        boundaryAssertions: { total: 0, items: [] },
        tagVocabulary: { total: 0, items: [] },
        rules: { total: 0, items: [] },
        uncertainty: { high: 0, medium: 1, low: 0 },
      },
      coverage: { complete: true, imports: 0, analyzedFiles: 2, projects: 2, notAnalyzed: [] },
    });
    expect(report).toContain("proposed architecture — NOT authoritative, never written");
    expect(report).toContain("[proposed — not authoritative]");
    expect(report).not.toContain(
      "[proposed — not authoritative] component libs\n    members: core, util\n\n",
    ); // no phantom blank groups
  });

  it("says nothing to propose on the unknown proposal", () => {
    const report = formatDiscoverReport({
      discovery: { projects: [], edges: [], tags: [] },
      proposal: { unknown: true },
      coverage: { complete: true, imports: 0, analyzedFiles: 0, projects: 0, notAnalyzed: [] },
    });
    expect(report).toContain("no observed projects — nothing to propose");
  });
});

describe("proposalToIntent", () => {
  it("converts components to boundaries with directory: selectors", () => {
    const proposal = {
      proposed: true,
      notAuthoritative: true,
      unknown: false,
      components: {
        items: [
          {
            name: "libs/core",
            commonDirectory: "libs/core",
            projects: ["core-a", "core-b"],
            evidence: [],
            confidence: "medium",
          },
        ],
        total: 1,
      },
      rules: { items: [], total: 0 },
    };

    const intent = proposalToIntent(proposal);
    expect(intent.version).toBe("1");
    expect(intent.boundaries).toEqual([{ name: "libs/core", match: ["directory:libs/core"] }]);
    expect(intent.forbidden).toBeUndefined();
  });

  it("converts noDependency rules to forbidden entries", () => {
    const proposal = {
      proposed: true,
      notAuthoritative: true,
      unknown: false,
      components: { items: [], total: 0 },
      rules: {
        items: [
          {
            kind: "noDependency",
            source: "web-app",
            target: "core-lib",
            evidence: [],
            confidence: "medium",
          },
        ],
        total: 1,
      },
    };

    const intent = proposalToIntent(proposal);
    expect(intent.forbidden).toEqual([{ source: "web-app", target: "core-lib" }]);
  });

  it("skips boundary-kind rules (they carry no source/target)", () => {
    const proposal = {
      proposed: true,
      notAuthoritative: true,
      unknown: false,
      components: { items: [], total: 0 },
      rules: {
        items: [
          { kind: "boundary", component: "libs/core", evidence: [], confidence: "medium" },
          {
            kind: "noDependency",
            source: "a",
            target: "b",
            evidence: [],
            confidence: "medium",
          },
        ],
        total: 2,
      },
    };

    const intent = proposalToIntent(proposal);
    expect(intent.forbidden).toHaveLength(1);
    expect(intent.forbidden[0]).toEqual({ source: "a", target: "b" });
  });

  it("returns empty boundaries and no forbidden key for an empty proposal", () => {
    const proposal = {
      proposed: true,
      notAuthoritative: true,
      unknown: true,
      components: { items: [], total: 0 },
      rules: { items: [], total: 0 },
    };

    const intent = proposalToIntent(proposal);
    expect(intent.boundaries).toEqual([]);
    expect(intent.forbidden).toBeUndefined();
  });

  it("produces valid architecture-intent.json (version '1')", () => {
    const proposal = {
      proposed: true,
      notAuthoritative: true,
      unknown: false,
      components: {
        items: [
          {
            name: "libs/shared",
            commonDirectory: "libs/shared",
            projects: ["shared-utils", "shared-ui"],
            evidence: [],
            confidence: "medium",
          },
          {
            name: "apps/portal",
            commonDirectory: "apps/portal",
            projects: ["portal-web"],
            evidence: [],
            confidence: "medium",
          },
        ],
        total: 2,
      },
      rules: {
        items: [
          {
            kind: "noDependency",
            source: "portal-web",
            target: "shared-ui",
            evidence: [],
            confidence: "medium",
          },
        ],
        total: 1,
      },
    };

    const intent = proposalToIntent(proposal);
    // The output must be valid JSON with the expected top-level keys.
    const raw = JSON.stringify(intent);
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(intent).toHaveProperty("version", "1");
    expect(intent).toHaveProperty("boundaries");
    expect(intent).toHaveProperty("forbidden");
    expect(intent.boundaries).toHaveLength(2);
    expect(intent.forbidden).toHaveLength(1);
  });
});
