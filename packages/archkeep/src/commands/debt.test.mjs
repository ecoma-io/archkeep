import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { debtCommand } from "./debt.mjs";

vi.mock("./provenance.mjs", () => ({ resolveProvenance: vi.fn(() => "mock-provenance") }));

vi.mock("../report/json.mjs", () => ({
  SCHEMA_VERSION: 2,
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
    marker: "archkeep.json",
    tracked: ["archkeep.json", "architecture-intent.json"],
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

  it("reports no-verdict over incomplete coverage", async () => {
    const ctx = commandContext();
    ctx.analysis.failures = [
      { sourceFile: "x.go", line: null, column: null, reason: "parse error" },
    ];
    const result = await debtCommand("/ws/hist", ctx, {
      config: null,
      io: ioWith(),
    });
    // The refusal keeps its meaning but speaks the graph family's contract:
    // a structured no-verdict envelope, not a throw with no envelope at all.
    expect(result.status).toBe("no-verdict");
    const envelope = JSON.parse(result.report.json);
    expect(envelope.status).toBe("no-verdict");
    expect(envelope.exitCode).toBe(3);
    expect(envelope.coverage.complete).toBe(false);
    expect(envelope.coverage.notAnalyzed).toEqual([{ file: "x.go", reason: "parse error" }]);
    expect(result.report.text).toContain("coverage incomplete");
  });

  it("refuses when the snapshot directory cannot be read", async () => {
    const io = ioWith({
      readSnapshots: () => {
        throw new Error("archkeep: cannot read the history directory '/ws/missing'");
      },
    });
    await expect(
      debtCommand("/ws/missing", commandContext(), { config: null, io }),
    ).rejects.toThrow(/cannot read the history directory/);
  });

  // The silent direction, and the reason this case is a refusal rather than a
  // "0 snapshots" ledger: a directory that EXISTS and holds nothing reads back
  // as `✔ no architecture debt`, exit 0, byte-for-byte what a genuinely clean
  // workspace prints. A fresh `.archkeep/history/`, or a CI cache whose capture
  // step never ran, turns a `archkeep debt` gate into a no-op nobody can see.
  // `historyCommand` already refuses the identical directory ("An empty
  // directory is not an empty history"), and this command's own header says
  // exit 3 covers "no snapshots".
  it("refuses a snapshot directory that exists but holds no snapshots, rather than reporting a clean ledger", async () => {
    // A resolved promise is the defect this pins, whatever the ledger says —
    // the message check is the second half, not the assertion that matters.
    const io = ioWith({ readSnapshots: () => ({ files: [] }) });
    await expect(debtCommand("/ws/empty", commandContext(), { config: null, io })).rejects.toThrow(
      /contains no snapshots/,
    );
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

describe("debtCommand — determinism", () => {
  const T1 = "2026-08-16T00:00:00.000Z";
  const T2 = "2026-08-16T01:00:00.000Z";

  const debtConfig = {
    depConstraints: [],
    options: {},
    suppressions: [{ path: "libs/core/v.go", reason: "r" }],
  };

  /** Every field of a debt envelope except the one documented as time-relative. */
  function stripTimeRelativeFields(envelope) {
    const { sampleTime: _sampleTime, ...rest } = envelope.result;
    return { ...envelope, result: rest };
  }

  it("silent-direction guard: two runs of an unchanged tree at different reference times must not diverge anywhere but the documented field", async () => {
    const a = await debtCommand("/ws/hist", commandContext(), {
      config: debtConfig,
      io: ioWith({ readSnapshots: () => agedRead }),
      referenceTime: T1,
    });
    const b = await debtCommand("/ws/hist", commandContext(), {
      config: debtConfig,
      io: ioWith({ readSnapshots: () => agedRead }),
      referenceTime: T2,
    });
    const envelopeA = JSON.parse(a.report.json);
    const envelopeB = JSON.parse(b.report.json);

    // The isolated field genuinely moves with the injected clock — a frozen
    // value here would silently defeat the "when was this ledger taken" fact
    // it exists to report, the opposite failure from the one this test's
    // title guards.
    expect(envelopeA.result.sampleTime).toBe(T1);
    expect(envelopeB.result.sampleTime).toBe(T2);
    expect(envelopeA.result.sampleTime).not.toBe(envelopeB.result.sampleTime);

    // Before this fix, nothing marked `sampleTime` as the sanctioned
    // exception, so a naive full-envelope diff/hash across two real runs
    // reported drift on every single run — "five runs, five distinct
    // hashes" — indistinguishable from an actual change to the workspace's
    // debt. Stripping only the one documented field must leave the two
    // envelopes byte-identical; any other field moving here would be the
    // silent regression this test exists to catch.
    expect(JSON.stringify(stripTimeRelativeFields(envelopeA))).toBe(
      JSON.stringify(stripTimeRelativeFields(envelopeB)),
    );
  });

  it("discloses the excluded field in-band, in coverage.notes, on every run — not only in prose docs", async () => {
    const result = await debtCommand("/ws/hist", commandContext(), {
      config: debtConfig,
      io: ioWith({ readSnapshots: () => agedRead }),
      referenceTime: T1,
    });
    const envelope = JSON.parse(result.report.json);
    expect(envelope.coverage.notes).toEqual(
      expect.arrayContaining([expect.stringContaining("sampleTime is the wall clock")]),
    );
  });
});

describe("debtCommand — corrupt-middle snapshot composition", () => {
  /** A minimal graph envelope that `parseBaseline` accepts (schemaVersion 2). */
  const validSnapshot = JSON.stringify({
    schemaVersion: 2,
    command: "graph",
    coverage: { complete: true },
    result: {
      projects: [{ name: "core", root: "libs/core", tags: [] }],
      dependencies: [],
    },
    workspace: { provider: "native", provenance: "test" },
  });

  // The silent direction this pins: a reader that tolerated a malformed file
  // between two valid ones — skipping it, aging over it, counting the
  // survivors — would ship a plausible-looking ledger computed from snapshots
  // 1 and 3 while the record it claims to read is broken. The extremes are
  // already covered above (unreadable directory, empty directory, malformed
  // snapshot in a single-file directory), but none of those exercise the
  // real reader encountering a corrupt file sandwiched between valid ones.
  // `readSnapshots` refuses at the first unparsable file (history.mjs:238 —
  // `parseBaseline` is called without a guard), and `debt` must let that
  // refusal reach the consumer (exit 3), never compute a ledger over a
  // partial record.
  it("refuses loudly naming the corrupt file when the middle of three snapshots is malformed, never emitting a ledger from survivors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "archkeep-debt-corrupt-"));
    try {
      await writeFile(join(dir, "0001-first.json"), validSnapshot);
      await writeFile(join(dir, "0002-corrupt.json"), "not valid json {{{");
      await writeFile(join(dir, "0003-last.json"), validSnapshot);

      // `loadIntentOverride` is the only io injected: the real `readSnapshots`
      // runs (debt.mjs:110 falls through to it when `io.readSnapshots` is
      // absent), and the injected intent lets the command reach the ledger
      // computation if it gets past the read — which is exactly the silent
      // direction this test must catch. The command must reject with the
      // error `parseBaseline` produced — which names the corrupt file's full
      // path — never resolve with a ledger computed from survivors.
      await expect(
        debtCommand(dir, commandContext(), {
          config: null,
          io: { loadIntentOverride: async () => intent() },
        }),
      ).rejects.toThrow(/the baseline snapshot at '.*0002-corrupt\.json' is not valid JSON/);

      // The throw itself is the proof that no ledger exists: the read
      // failure at debt.mjs:110 precedes `computeDebtLedger` (debt.mjs:163)
      // and `formatDebtReport` (debt.mjs:241), so a ledger computed from the
      // surviving snapshots 1 and 3 is unreachable — the command either
      // refuses the broken record or it does not, and this pins "it does".
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
