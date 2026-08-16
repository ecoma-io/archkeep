import { describe, expect, it, vi } from "vitest";

import {
  configRows,
  hasOrigin,
  intentRows,
  provenanceCommand,
  rowLabel,
} from "./provenance-command.mjs";

vi.mock("./provenance.mjs", () => ({
  resolveProvenance: vi.fn(() => ({
    commit: "abc1234",
    remote: "git@example.com:acme/repo.git",
    dirty: false,
  })),
}));
// The real jsonEnvelope builds the `workspace.provenance` block this command's
// JSON contract depends on; the envelope is part of what is under test here,
// so it is not mocked (unlike drift's test, which only reads the text report).

/** A CommandContext shaped like `resolveCommandContext` produces. */
function commandContext(overrides = {}) {
  return {
    root: "/workspace",
    provider: "native",
    marker: "lattice.json",
    tracked: ["lattice.json", "architecture-intent.json"],
    options: { boundaryConfig: "module-boundaries.config.mjs" },
    ...overrides,
  };
}

/** A normalized canonical intent model with the rows the walker reads. */
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

const config = (rows = []) => ({ depConstraints: rows });

/**
 * `io` playing both the intent and config loaders off these payloads.
 *
 * @param {{intent?: object, config?: object}} payload
 */
function ioWith({ intent: file, config: cfg }) {
  return {
    loadIntentOverride: async () => file,
    loadConfigOverride: async () => cfg,
  };
}

describe("hasOrigin", () => {
  it("accepts a full origin with by and tool", () => {
    expect(hasOrigin({ origin: { by: "jane", tool: "lattice:v1" } })).toBe(true);
  });

  it("accepts an origin with a committed on", () => {
    expect(hasOrigin({ origin: { by: "jane", tool: "l", on: "2026-08-16" } })).toBe(true);
  });

  it("rejects a row with no origin at all", () => {
    expect(hasOrigin({ from: "a", to: "b" })).toBe(false);
  });

  it("rejects a row whose origin is missing its by or tool", () => {
    expect(hasOrigin({ origin: { by: "jane" } })).toBe(false);
    expect(hasOrigin({ origin: { tool: "l" } })).toBe(false);
    expect(hasOrigin({ origin: { by: "", tool: "" } })).toBe(false);
  });

  it("rejects a row whose origin is not a plain object", () => {
    expect(hasOrigin({ origin: null })).toBe(false);
    expect(hasOrigin({ origin: "attested" })).toBe(false);
  });
});

describe("rowLabel", () => {
  it("names a source→target pair when the row carries one", () => {
    expect(rowLabel("allowed[0]", { from: "packages", to: "extensions" })).toBe(
      "allowed[0] packages→extensions",
    );
    expect(rowLabel("depConstraints[2]", { source: "a", target: "b" })).toBe(
      "depConstraints[2] a→b",
    );
  });

  it("falls back to the row's name, then its sourceTag, then just the kind", () => {
    expect(rowLabel("projects.required[0]", { name: "lattice" })).toBe(
      "projects.required[0] lattice",
    );
    expect(rowLabel("depConstraints[0]", { sourceTag: "layer:domain" })).toBe(
      "depConstraints[0] layer:domain",
    );
    expect(rowLabel("forbiddenTags[0]", {})).toBe("forbiddenTags[0]");
  });
});

describe("intentRows and configRows — the canonical walk order", () => {
  it("walks every row type in the same order drift's judge counts them", () => {
    const model = intent({
      allowed: [{ from: "a", to: "b" }],
      forbidden: [{ from: "b", to: "c", reason: "x" }],
      projects: { required: [{ name: "lattice" }], forbidden: [{ name: "stray" }] },
      dependencies: {
        allowed: [{ source: "a", target: "b" }],
        forbidden: [{ source: "a", target: "b" }],
      },
      forbiddenTags: [{ from: "ui", to: "domain" }],
    });
    const kinds = intentRows(model).map(({ kind }) => kind);
    expect(kinds).toEqual([
      "allowed[0]",
      "forbidden[0]",
      "projects.required[0]",
      "projects.forbidden[0]",
      "dependencies.allowed[0]",
      "dependencies.forbidden[0]",
      "forbiddenTags[0]",
    ]);
  });

  it("walks depConstraints in order", () => {
    const kinds = configRows(config([{ sourceTag: "x" }, { sourceTag: "y" }])).map(
      ({ kind }) => kind,
    );
    expect(kinds).toEqual(["depConstraints[0]", "depConstraints[1]"]);
  });
});

describe("provenanceCommand", () => {
  it("reports repo provenance and every row's attestation", async () => {
    const result = await provenanceCommand(
      commandContext(),
      ioWith({
        intent: intent({
          allowed: [
            { from: "packages", to: "packages", origin: { by: "jane", tool: "lattice:v1" } },
          ],
          forbidden: [{ from: "packages", to: "extensions", reason: "x" }],
        }),
        config: config([{ sourceTag: "layer:domain", origin: { by: "jane", tool: "lattice:v1" } }]),
      }),
    );
    expect(result.status).toBe("ok");
    expect(result.repo).toEqual({
      commit: "abc1234",
      remote: "git@example.com:acme/repo.git",
      dirty: false,
      established: true,
    });
    // 2 intent rows + 1 config row; the allowed row and the depConstraints row
    // carry origins, the forbidden row does not.
    expect(result.rows).toHaveLength(3);
    expect(result.rows.filter((r) => r.attested)).toHaveLength(2);
    expect(result.unattested.map((r) => r.kind)).toEqual(["forbidden[0]"]);
    expect(result.unattested[0].note).toBe("no origin recorded — cannot attest");
    expect(result.report.text).toContain("abc1234");
    expect(result.report.text).toContain("1 without");
    expect(result.report.text).toContain("forbidden[0]");
  });

  it("reports a clean attestation when every row carries an origin", async () => {
    const result = await provenanceCommand(
      commandContext(),
      ioWith({
        intent: intent({
          allowed: [{ from: "a", to: "b", origin: { by: "j", tool: "l" } }],
        }),
        config: config([{ sourceTag: "x", origin: { by: "j", tool: "l" } }]),
      }),
    );
    expect(result.unattested).toEqual([]);
    expect(result.report.text).toContain("✔ every governance row carries an origin");
  });

  it("reports provenance unavailable when git cannot answer — never a silent success", async () => {
    /** @type {import("vitest").MockInstance<() => object|null>} */
    const resolveSpy = vi.mocked((await import("./provenance.mjs")).resolveProvenance);
    resolveSpy.mockReturnValueOnce(null);
    const result = await provenanceCommand(
      commandContext(),
      ioWith({ intent: intent({ forbidden: [{ from: "a", to: "b", reason: "x" }] }) }),
    );
    expect(result.repo.established).toBe(false);
    expect(result.repo.commit).toBeNull();
    expect(result.report.text).toContain("repo      provenance unavailable");
    // The uncovered row is still named — a missing repo never hides a missing origin.
    expect(result.report.text).toContain("cannot attest");
  });

  it("covers config rows only when the workspace actually names a boundary config", async () => {
    const result = await provenanceCommand(
      commandContext({ options: { boundaryConfig: undefined } }),
      ioWith({ intent: intent() }),
    );
    expect(result.rows).toEqual([]);
    expect(result.unattested).toEqual([]);
  });

  it("surfaces a malformed intent loudly — a row list cannot be built off a file it could not read", async () => {
    await expect(
      provenanceCommand(commandContext(), {
        loadIntentOverride: async () => {
          throw new Error('architecture-intent.json: version: must be exactly "1"');
        },
      }),
    ).rejects.toThrow(/architecture-intent\.json/);
  });

  it("serializes the JSON envelope with the canonical result shape", async () => {
    const result = await provenanceCommand(
      commandContext(),
      ioWith({
        intent: intent({
          allowed: [{ from: "a", to: "b", origin: { by: "j", tool: "l" } }],
        }),
      }),
    );
    const envelope = JSON.parse(result.report.json);
    expect(envelope.command).toBe("provenance");
    expect(envelope.status).toBe("ok");
    expect(envelope.exitCode).toBe(0);
    expect(envelope.result.rows[0]).toEqual({
      kind: "allowed[0]",
      attested: true,
      origin: { by: "j", tool: "l" },
    });
    expect(envelope.workspace.provenance.commit).toBe("abc1234");
  });

  it("is verdict-neutral — a row without an origin changes no verdict (exit stays 0)", async () => {
    const result = await provenanceCommand(
      commandContext(),
      ioWith({ intent: intent({ forbidden: [{ from: "a", to: "b", reason: "x" }] }) }),
    );
    expect(result.status).toBe("ok");
    expect(result.report.json).not.toContain('"exitCode": 1');
  });

  it("is byte-identical across two runs over the same tree — determinism's command half", async () => {
    const io = ioWith({
      intent: intent({
        forbidden: [{ from: "a", to: "b", reason: "x", origin: { by: "j", tool: "l" } }],
        projects: { required: [{ name: "p" }] },
      }),
      config: config([{ sourceTag: "x" }]),
    });
    const [a, b] = await Promise.all([
      provenanceCommand(commandContext(), io),
      provenanceCommand(commandContext(), io),
    ]);
    expect(a.report.json).toBe(b.report.json);
    expect(a.report.text).toBe(b.report.text);
  });
});
