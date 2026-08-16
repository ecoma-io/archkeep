import { describe, expect, it, vi } from "vitest";

import { buildObserved, driftCommand, driftForCheck, refuseIncompleteGraph } from "./drift.mjs";

// The intent is loaded through an overridable `import` seam, so the command
// paths below drive the real validate->compute pipeline over an in-memory
// intent, exactly as `diff.test.mjs` drives its baseline reader. Nothing here
// touches disk or mounts a provider.
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
    options: { intentConfig: "architecture-intent.config.mjs" },
    graph: {
      nodes: {
        app: { name: "app", type: "app", data: { root: "apps/app", tags: ["layer:adapter"] } },
        lib: { name: "lib", type: "lib", data: { root: "libs/lib", tags: ["layer:domain"] } },
      },
      dependencies: {
        app: [
          { source: "app", target: "lib", type: "static" },
          { source: "app", target: "npm:lodash", type: "static" },
        ],
      },
    },
    analysis: {
      analyzed: 3,
      imports: [{ sourceFile: "apps/app/main.go", specifier: "lib", line: 1, column: 1 }],
      failures: [],
    },
    pluginGap: { registered: true, manifests: [] },
    ...overrides,
  };
}

/** The validated intent shape `validateIntent` returns, minimally filled. */
const intentConfig = (overrides = {}) => ({
  requiredProjects: [],
  forbiddenProjects: [],
  allowedDependencies: [],
  forbiddenDependencies: [],
  forbiddenTags: [],
  ...overrides,
});

/** `io.loadIntentOverride` returning a ready intent. */
const ioWithIntent = (intent) => ({
  loadIntentOverride: async () => intent,
});

/**
 * What `drift` guarantees: the observed side is compared to the intent only
 * over a complete, project-internal graph. Two refusals guard the invariant
 * that an empty finding list means "no drift, and nothing else": a graph that
 * could not fully be read (the plugin unregistered over polyglot manifests)
 * refuses before any verdict, and external edges — packages outside the
 * workspace's own project set — never enter the observed model at all.
 */
describe("drift's observed model", () => {
  it("drops edges whose target is not a project in the model (external packages)", () => {
    const { projects, edges } = buildObserved(commandContext());
    expect(projects.map((p) => p.name)).toEqual(["app", "lib"]);
    // The npm: external edge never enters drift's model — an external package
    // is not a project an intent row can name, and without the filter an Nx
    // consumer with an allowlist would report every npm edge as drift.
    expect(edges).toEqual([{ source: "app", target: "lib", type: "static" }]);
  });

  it("drops an edge whose source is not a project in the model", () => {
    const ctx = commandContext({
      graph: {
        nodes: {
          lib: { name: "lib", type: "lib", data: { root: "libs/lib", tags: [] } },
        },
        dependencies: {
          orphan: [{ source: "orphan", target: "lib", type: "static" }],
          lib: [{ source: "lib", target: "orphan", type: "static" }],
        },
      },
    });
    const { edges } = buildObserved(ctx);
    expect(edges).toEqual([]);
  });
});

describe("refuseIncompleteGraph", () => {
  it("does not refuse a native workspace with manifests", () => {
    expect(() =>
      refuseIncompleteGraph(
        commandContext({
          provider: "native",
          pluginGap: { registered: false, manifests: ["libs/lib/go.mod"] },
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
          pluginGap: { registered: false, manifests: ["libs/lib/go.mod"] },
        }),
      ),
    ).toThrow(/plugin is not registered but polyglot manifests exist/);
  });

  it("is silent when the plugin is registered", () => {
    expect(() =>
      refuseIncompleteGraph(
        commandContext({
          provider: "nx",
          marker: "nx.json",
          pluginGap: { registered: true, manifests: ["libs/lib/go.mod"] },
        }),
      ),
    ).not.toThrow();
  });
});

describe("driftCommand", () => {
  it("returns ok with no findings when the observed matches an empty intent", async () => {
    const result = await driftCommand(commandContext(), ioWithIntent(intentConfig()));
    expect(result.status).toBe("ok");
    expect(result.drift.findings).toEqual([]);
    expect(result.drift.intent.file).toBe("architecture-intent.config.mjs");
    expect(result.drift.intent.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports a forbidden observed edge as a drift finding", async () => {
    const result = await driftCommand(
      commandContext(),
      ioWithIntent(intentConfig({ forbiddenDependencies: [{ source: "app", target: "lib" }] })),
    );
    expect(result.drift.findings.map((f) => f.messageId)).toEqual(["dependencyForbidden"]);
  });

  it("refuses (throws) on the unregistered-plugin gap, naming the manifests", async () => {
    await expect(
      driftCommand(
        commandContext({
          provider: "nx",
          marker: "nx.json",
          pluginGap: { registered: false, manifests: ["libs/lib/go.mod"] },
        }),
        ioWithIntent(intentConfig()),
      ),
    ).rejects.toThrow(/plugin is not registered but polyglot manifests exist/);
  });

  it("refuses (throws) on incomplete analysis coverage", async () => {
    await expect(
      driftCommand(
        commandContext({
          analysis: {
            analyzed: 2,
            imports: [],
            failures: [
              { sourceFile: "libs/gone/unreadable.go", line: null, column: null, reason: "nocan" },
            ],
          },
        }),
        ioWithIntent(intentConfig()),
      ),
    ).rejects.toThrow(/incomplete coverage/);
  });
});

describe("driftForCheck", () => {
  it("folds a forbidden edge into the findings count", async () => {
    const verdict = await driftForCheck(
      commandContext(),
      ioWithIntent(intentConfig({ forbiddenDependencies: [{ source: "app", target: "lib" }] })),
    );
    expect(verdict.findings.map((f) => f.messageId)).toEqual(["dependencyForbidden"]);
    expect(verdict.observed).toEqual({ projects: 2, edges: 1, implicitEdges: 0 });
  });

  it("refuses the unregistered-plugin gap the same way the descriptive command does", async () => {
    await expect(
      driftForCheck(
        commandContext({
          provider: "nx",
          marker: "nx.json",
          pluginGap: { registered: false, manifests: ["libs/lib/go.mod"] },
        }),
        ioWithIntent(intentConfig()),
      ),
    ).rejects.toThrow(/plugin is not registered but polyglot manifests exist/);
  });

  it("never sees an external npm edge, so an allowlist does not fire on it", async () => {
    // The graph holds app→lib (allowed) and app→npm:lodash (external). With an
    // allowlist present the external edge must not become dependencyNotAllowed.
    const api = commandContext();
    const verdict = await driftForCheck(
      api,
      ioWithIntent(intentConfig({ allowedDependencies: [{ source: "app", target: "lib" }] })),
    );
    expect(verdict.findings).toEqual([]);
    expect(verdict.observed.edges).toBe(1);
  });
});
