import { describe, expect, it, vi } from "vitest";

import { buildObserved, driftCommand, driftForCheck, refuseIncompleteGraph } from "./drift.mjs";

// The intent is loaded through an overridable seam, so the command paths below
// drive the real judge over an in-memory canonical intent — exactly as
// `diff.test.mjs` drives its baseline reader. Nothing here touches disk or
// mounts a provider.
vi.mock("./provenance.mjs", () => ({ resolveProvenance: vi.fn(() => "mock-provenance") }));
vi.mock("../report/json.mjs", () => ({
  jsonEnvelope: (input) => input,
  renderJson: (input) => JSON.stringify(input),
}));

/** A CommandContext shaped like `resolveCommandContext` produces. */
function commandContext(overrides = {}) {
  return {
    root: "/workspace",
    provider: "native",
    marker: "lattice.json",
    tracked: ["lattice.json", "architecture-intent.json"],
    graph: {
      nodes: {
        core: { name: "core", data: { root: "libs/core", tags: ["type-package"] } },
        app: { name: "app", data: { root: "apps/app", tags: ["type-application"] } },
      },
      dependencies: {
        core: [{ source: "core", target: "app", type: "static" }],
      },
    },
    analysis: {
      analyzed: 3,
      imports: [{ sourceFile: "libs/core/main.go", specifier: "app", line: 1, column: 1 }],
      failures: [],
    },
    pluginGap: { registered: true, manifests: [] },
    ...overrides,
  };
}

/** A normalized canonical intent model, minimally filled. */
const intent = (overrides = {}) => ({
  version: "1",
  boundaries: [],
  allowed: [],
  forbidden: [],
  projects: undefined,
  dependencies: undefined,
  forbiddenTags: [],
  ...overrides,
});

/** `io.loadIntentOverride` returning a ready intent. */
const ioWithIntent = (model) => ({ loadIntentOverride: async () => model });

describe("drift's observed model", () => {
  it("drops edges whose target is not a project in the model (external packages)", () => {
    const { projects, edges, implicitEdges } = buildObserved(
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
            ],
          },
        },
      }),
    );
    expect(projects.map((p) => p.name)).toEqual(["app", "lib"]);
    // The npm: external edge never enters drift's model — an external package
    // is not a project an intent row can name.
    expect(edges).toEqual([{ source: "app", target: "lib", type: "static" }]);
    expect(implicitEdges).toBe(0);
  });

  it("drops an edge whose source is not a project in the model", () => {
    const { edges } = buildObserved(
      commandContext({
        graph: {
          nodes: {
            lib: { name: "lib", data: { root: "libs/lib", tags: [] } },
          },
          dependencies: {
            orphan: [{ source: "orphan", target: "lib", type: "static" }],
            lib: [{ source: "lib", target: "orphan", type: "static" }],
          },
        },
      }),
    );
    expect(edges).toEqual([]);
  });

  it("counts implicit edges separately and excludes them from the observed set", () => {
    const { edges, implicitEdges } = buildObserved(
      commandContext({
        graph: {
          nodes: {
            a: { name: "a", data: { root: "apps/a", tags: [] } },
            b: { name: "b", data: { root: "libs/b", tags: [] } },
          },
          dependencies: {
            a: [{ source: "a", target: "b", type: "implicit" }],
          },
        },
      }),
    );
    expect(edges).toEqual([]);
    expect(implicitEdges).toBe(1);
  });
});

describe("refuseIncompleteGraph", () => {
  it("does not refuse a native workspace with manifests", () => {
    expect(() =>
      refuseIncompleteGraph(
        commandContext({
          provider: "native",
          pluginGap: { registered: false, manifests: ["libs/core/go.mod"] },
        }),
      ),
    ).not.toThrow();
  });

  it("does not refuse an Nx workspace that is complete without the plugin", () => {
    expect(() =>
      refuseIncompleteGraph(
        commandContext({
          provider: "nx",
          marker: "nx.json",
          pluginGap: { registered: false, manifests: [] },
        }),
      ),
    ).not.toThrow();
  });

  it("refuses an Nx workspace with polyglot manifests and the plugin unregistered", () => {
    expect(() =>
      refuseIncompleteGraph(
        commandContext({
          provider: "nx",
          marker: "nx.json",
          pluginGap: { registered: false, manifests: ["libs/core/go.mod"] },
        }),
      ),
    ).toThrow(/refusing to judge drift/);
  });
});

describe("driftCommand", () => {
  it("reports no drift when the intent matches, and names the comparison facts", async () => {
    const result = await driftCommand(
      commandContext({
        graph: {
          nodes: {
            core: { name: "core", data: { root: "libs/core", tags: ["type-package"] } },
          },
          dependencies: {},
        },
      }),
      ioWithIntent(
        intent({
          boundaries: [{ name: "packages", match: ["tag:type-package"] }],
          projects: { required: [{ name: "core", tags: ["type-package"] }] },
        }),
      ),
    );
    expect(result.status).toBe("ok");
    expect(result.drift.intent.file).toBe("architecture-intent.json");
    expect(result.drift.findings).toEqual([]);
    expect(result.report.text).toContain("✔ no drift");
  });

  it("reports drift findings for a forbidden dependency and presence rules", async () => {
    const result = await driftCommand(
      commandContext(),
      ioWithIntent(
        intent({
          boundaries: [
            { name: "packages", match: ["tag:type-package"] },
            { name: "apps", match: ["tag:type-application"] },
          ],
          forbidden: [{ from: "packages", to: "apps", reason: "the engine must not reach out" }],
          projects: { required: [{ name: "ghost", tags: [] }], forbidden: [{ name: "core" }] },
        }),
      ),
    );
    expect(result.status).toBe("ok");
    const rules = result.drift.findings.map((f) => f.rule).sort();
    expect(rules).toContain("intentForbiddenEdge");
    expect(rules).toContain("projectMissing");
    expect(rules).toContain("projectPresent");
    expect(result.report.text).toContain("3 drift findings");
  });

  it("refuses over incomplete coverage — every 'project missing' would be ambiguous", async () => {
    await expect(
      driftCommand(
        commandContext({
          analysis: {
            analyzed: 3,
            imports: [],
            failures: [
              {
                sourceFile: "libs/core/main.go",
                reason: "not a whole-file failure",
                line: 1,
                column: 1,
              },
              {
                sourceFile: "libs/app/app.go",
                reason: "unreadable file",
                line: null,
              },
            ],
          },
        }),
        ioWithIntent(intent()),
      ),
    ).rejects.toThrow(/drift has incomplete coverage/);
  });

  it("refuses when no tracked intent file is present — drift is about a declared intent", async () => {
    // The load override returning undefined plays the real `loadIntent`'s
    // answer when `architecture-intent.json` is not tracked: the loader
    // treats an untracked file as absent, and a workspace with no declared
    // intent cannot be judged for drift.
    await expect(
      driftCommand(commandContext(), { loadIntentOverride: async () => undefined }),
    ).rejects.toThrow(/drift requires a tracked architecture-intent\.json/);
  });
});

describe("driftForCheck — the check fold", () => {
  it("judges the workspace's declared intent against the observed graph", async () => {
    const verdict = await driftForCheck(
      commandContext(),
      ioWithIntent(
        intent({
          boundaries: [
            { name: "packages", match: ["tag:type-package"] },
            { name: "apps", match: ["tag:type-application"] },
          ],
          forbidden: [{ from: "packages", to: "apps", reason: "the engine must not reach out" }],
        }),
      ),
    );
    expect(verdict.intent.file).toBe("architecture-intent.json");
    expect(verdict.observed.projects).toBe(2);
    expect(verdict.observed.edges).toBe(1);
    expect(verdict.findings.some((f) => f.rule === "intentForbiddenEdge")).toBe(true);
  });
});
