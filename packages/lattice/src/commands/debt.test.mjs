import { describe, expect, it, vi } from "vitest";

import { debtCommand } from "./debt.mjs";

vi.mock("./provenance.mjs", () => ({ resolveProvenance: vi.fn(() => "mock-provenance") }));
vi.mock("../report/json.mjs", () => ({
  jsonEnvelope: (input) => input,
  renderJson: (input) => JSON.stringify(input),
}));
vi.mock("../report/debt-text.mjs", () => ({
  formatDebtReport: (input) => JSON.stringify(input),
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
        ring: { name: "ring", data: { root: "libs/ring", tags: ["type-package"] } },
      },
      dependencies: {
        core: [{ source: "core", target: "ring", type: "static" }],
      },
    },
    analysis: {
      analyzed: 3,
      imports: [{ sourceFile: "libs/core/main.go", specifier: "ring", line: 1, column: 1 }],
      failures: [],
    },
    pluginGap: { registered: true, manifests: [] },
    options: { boundaryConfig: "module-boundaries.config.mjs" },
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

const ioWith = (overrides) => ({
  readSnapshots: () => ({
    files: [{ name: "0001-a.json", envelope: { result: { projects: [] } } }],
  }),
  loadIntentOverride: async () => intent(),
  ...overrides,
});

/** Two-snapshot history: `core` present in both (age 2), `ring` only in the head. */
const agedRead = {
  files: [
    {
      name: "0001-a.json",
      envelope: {
        result: { projects: [{ name: "core", root: "libs/core", tags: [] }] },
      },
      id: "a",
    },
    {
      name: "0002-b.json",
      envelope: {
        result: {
          projects: [
            { name: "core", root: "libs/core", tags: [] },
            { name: "ring", root: "libs/ring", tags: [] },
          ],
        },
      },
      id: "b",
    },
  ],
};

describe("debtCommand", () => {
  it("reports an empty ledger when the workspace carries no debt", async () => {
    const result = await debtCommand("/ws/hist", commandContext(), {
      config: { depConstraints: [], options: {}, suppressions: [] },
      io: ioWith({ readSnapshots: () => agedRead }),
    });
    expect(result.status).toBe("ok");
    expect(result.ledger.total).toBe(0);
    expect(result.coverage).toMatchObject({ complete: true });
  });

  it("ages a waiver by its owning project across snapshots", async () => {
    const result = await debtCommand("/ws/hist", commandContext(), {
      config: {
        depConstraints: [],
        options: {},
        suppressions: [{ path: "libs/core/violation.go", reason: "legacy" }],
      },
      io: ioWith({ readSnapshots: () => agedRead }),
    });
    expect(result.ledger.agings).toBe(true);
    expect(result.ledger.total).toBe(1);
    expect(result.ledger.entries[0].kind).toBe("waiver");
    expect(result.ledger.entries[0].age).toBe(2);
  });

  it("records drift findings and marks a waiver-return-to-FAIL high", async () => {
    const result = await debtCommand("/ws/hist", commandContext(), {
      config: {
        depConstraints: [],
        options: {},
        suppressions: [{ path: "libs/core/violation.go", reason: "legacy" }],
      },
      io: ioWith({
        readSnapshots: () => agedRead,
        loadIntentOverride: async () =>
          intent({
            forbidden: [{ from: "core", to: "ring", reason: "must not" }],
          }),
      }),
    });
    const drift = result.ledger.entries.find((e) => e.kind === "drift");
    expect(drift.severity).toBe("high");
    // The waiver is NOT hidden — it is still listed.
    expect(result.ledger.entries.some((e) => e.kind === "waiver")).toBe(true);
    expect(result.ledger.bySeverity.high).toBe(1);
  });

  it("refuses when there is no tracked intent file", async () => {
    await expect(
      debtCommand("/ws/hist", commandContext(), {
        config: { depConstraints: [], options: {}, suppressions: [] },
        io: ioWith({ loadIntentOverride: async () => undefined }),
      }),
    ).rejects.toThrow(/requires a tracked architecture-intent.json/);
  });

  it("refuses when the intent cannot be verified (unresolved boundary)", async () => {
    const io = ioWith({
      loadIntentOverride: async () =>
        intent({
          boundaries: [{ name: "ghost", match: ["name:ghost"] }],
          allowed: [{ from: "ghost", to: "core" }],
        }),
    });
    await expect(debtCommand("/ws/hist", commandContext(), { config: null, io })).rejects.toThrow(
      /cannot be verified/,
    );
  });

  it("refuses over incomplete coverage", async () => {
    const ctx = commandContext();
    ctx.analysis.failures = [
      { sourceFile: "x.go", line: null, column: null, reason: "parse error" },
    ];
    await expect(
      debtCommand("/ws/hist", ctx, {
        config: null,
        io: ioWith(),
      }),
    ).rejects.toThrow(/incomplete coverage/);
  });

  it("refuses when the snapshot directory cannot be read", async () => {
    const io = ioWith({
      readSnapshots: () => {
        throw new Error("lattice: cannot read the history directory '/ws/missing'");
      },
    });
    await expect(
      debtCommand("/ws/missing", commandContext(), { config: null, io }),
    ).rejects.toThrow(/cannot read the history directory/);
  });

  it("reports agings false when fewer than two snapshots exist", async () => {
    const result = await debtCommand("/ws/hist", commandContext(), {
      config: {
        depConstraints: [],
        options: {},
        suppressions: [{ path: "libs/core/v.go", reason: "r" }],
      },
      io: ioWith(),
    });
    expect(result.ledger.agings).toBe(false);
    expect(result.ledger.entries[0].age).toBe(0);
  });
});
