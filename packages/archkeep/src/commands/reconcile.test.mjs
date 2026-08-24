import { describe, expect, it, vi } from "vitest";

import { reconcileCommand } from "./reconcile.mjs";

// The intent is loaded through an overridable seam, so the command paths below
// drive the real judge over an in-memory canonical intent — exactly as
// `drift.test.mjs` drives its loader. Nothing here touches disk or mounts a
// provider.
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
    marker: "archkeep.json",
    tracked: ["archkeep.json", "architecture-intent.json"],
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

describe("reconcileCommand", () => {
  it("reports no divergence when the intent matches, and names the comparison facts", async () => {
    const context = commandContext({
      graph: {
        nodes: {
          core: { name: "core", data: { root: "libs/core", tags: ["type-package"] } },
        },
        dependencies: {},
      },
    });
    const result = await reconcileCommand(
      context,
      ioWithIntent(
        intent({
          projects: { required: [{ name: "core", tags: ["type-package"] }] },
        }),
      ),
    );
    expect(result.status).toBe("ok");
    expect(result.reconcile.intent.file).toBe("architecture-intent.json");
    expect(result.reconcile.unknownFiles).toEqual([]);
    expect(result.report.text).toContain("✔ no divergence");
    // The counts clause is the half that says what "no divergence" looked
    // at — pinned here against numbers computed from THIS context, so a
    // regression that rendered a clean verdict over zeroed or stale counts
    // goes red instead of reporting coverage nobody measured.
    const observedProjects = Object.keys(context.graph.nodes).length;
    const observedEdges = Object.values(context.graph.dependencies).reduce(
      (count, list) => count + list.length,
      0,
    );
    expect(result.report.text).toContain(
      `observed  ${observedProjects} project, ${observedEdges} edges`,
    );
    expect(result.report.text).toContain(
      `✔ no divergence — the observed architecture matches the intended model ` +
        `(${observedProjects} project and ${observedEdges} edges)`,
    );
  });

  it("scores divergence element by element and names the counts", async () => {
    const result = await reconcileCommand(
      commandContext(),
      ioWithIntent(
        intent({
          projects: { required: [{ name: "ghost", tags: [] }], forbidden: [{ name: "core" }] },
        }),
      ),
    );
    expect(result.status).toBe("ok");
    const states = result.reconcile.scores;
    const projectStates = states.projects.map((p) => p.classification).sort();
    expect(projectStates).toContain("projectPresent");
    const intentRowStates = states.intentRows.map((r) => r.state).sort();
    expect(intentRowStates).toContain("absent");
    expect(result.report.text).toContain("divergence");
  });

  it("refuses over incomplete coverage — every 'absent' score would be ambiguous", async () => {
    await expect(
      reconcileCommand(
        commandContext({
          analysis: {
            analyzed: 3,
            imports: [],
            failures: [{ sourceFile: "libs/app/app.go", reason: "unreadable file", line: null }],
          },
        }),
        ioWithIntent(intent()),
      ),
    ).rejects.toThrow(/reconcile has incomplete coverage/);
  });

  it("refuses when no tracked intent file is present — reconcile is about a declared intent", async () => {
    await expect(
      reconcileCommand(commandContext(), { loadIntentOverride: async () => undefined }),
    ).rejects.toThrow(/reconcile requires a tracked architecture-intent\.json/);
  });

  it("refuses when a boundary or row side matched no observed project — 'cannot verify' must not read as 'no divergence'", async () => {
    await expect(
      reconcileCommand(
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
            boundaries: [
              { name: "packages", match: ["tag:type-package"] },
              { name: "apps", match: ["tag:type-app"] }, // matches no project
            ],
          }),
        ),
      ),
    ).rejects.toThrow(/boundary\/row apps: matches no observed project/);
  });

  it("emits a ranked candidate list under --propose, explicitly proposed and not authoritative", async () => {
    const result = await reconcileCommand(
      commandContext(),
      ioWithIntent(
        intent({
          projects: { forbidden: [{ name: "core" }] },
          dependencies: { allowed: [{ source: "a", target: "b" }] },
        }),
      ),
      { propose: true },
    );
    expect(result.reconcile.proposed).toBe(true);
    expect(result.reconcile.notAuthoritative).toBe(true);
    expect(Array.isArray(result.reconcile.candidates)).toBe(true);
    expect(result.reconcile.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.reconcile.candidates) {
      expect(candidate.proposed).toBe(true);
      expect(candidate.notAuthoritative).toBe(true);
    }
    expect(result.report.text).toContain("proposal");
  });

  it("carries the ranked candidate list with the intent row an operator would edit", async () => {
    const result = await reconcileCommand(
      commandContext(),
      ioWithIntent(
        intent({
          projects: { required: [{ name: "ghost", tags: [] }] },
        }),
      ),
      { propose: true },
    );
    const removal = result.reconcile.candidates.find((c) => c.kind === "removal");
    expect(removal).toBeDefined();
    expect(removal.name).toBe("ghost");
    expect(removal.evidence).toBe("projectMissing");
    expect(removal.intentRow).toEqual({
      plane: "project",
      index: 0,
      kind: "required",
      key: "ghost",
    });
  });
});
