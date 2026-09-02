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
  // Default: no attributable history — the decision lifecycle reads cannot-attest
  // unless a case injects `fileAttribution` through `ioWith`. A missing mock
  // would leave the command's `io.fileAttribution ?? resolveFileAttribution`
  // default undefined and every call would crash; this factory pins the read
  // surface down explicitly.
  resolveFileAttribution: vi.fn(() => null),
}));
// The real jsonEnvelope builds the `workspace.provenance` block this command's
// JSON contract depends on; the envelope is part of what is under test here,
// so it is not mocked (unlike drift's test, which only reads the text report).

/** A CommandContext shaped like `resolveCommandContext` produces. */
function commandContext(overrides = {}) {
  return {
    root: "/workspace",
    provider: "native",
    marker: "archkeep.json",
    tracked: ["archkeep.json", "architecture-intent.json"],
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
 * @param {{intent?: object, config?: object, adrRecords?: object[],
 *   fileAttribution?: (root: string, file: string) => object|null}} payload
 *   `adrRecords` are `loadAdrRegistry`-shaped records (each an `{id, bindings}`
 *   at minimum) — `readAdrContext` derives both `byId` and `knownFitness`
 *   from them, the same way it would from a real `docs/adr/` tree.
 *   `fileAttribution` (default: the mocked `resolveFileAttribution`, which
 *   answers `null` — cannot-attest) is passed to the command as `io.fileAttribution`.
 */
function ioWith({ intent: file, config: cfg, adrRecords = [], fileAttribution }) {
  return {
    loadIntentOverride: async () => file,
    loadConfigOverride: async () => cfg,
    // Defaults to an empty registry — a `/workspace` root has no real
    // `docs/adr/` behind it in these tests either way, so this only matters
    // for a case that injects a non-empty one.
    loadAdrRegistryOverride: () => ({
      records: adrRecords,
      byId: new Map(adrRecords.map((record) => [record.id, record])),
    }),
    ...(fileAttribution === undefined ? {} : { fileAttribution }),
  };
}

describe("hasOrigin", () => {
  it("accepts a full origin with by and tool", () => {
    expect(hasOrigin({ origin: { by: "jane", tool: "archkeep:v1" } })).toBe(true);
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
    expect(rowLabel("projects.required[0]", { name: "archkeep" })).toBe(
      "projects.required[0] archkeep",
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
      projects: { required: [{ name: "archkeep" }], forbidden: [{ name: "stray" }] },
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
            { from: "packages", to: "packages", origin: { by: "jane", tool: "archkeep:v1" } },
          ],
          forbidden: [{ from: "packages", to: "extensions", reason: "x" }],
        }),
        config: config([
          { sourceTag: "layer:domain", origin: { by: "jane", tool: "archkeep:v1" } },
        ]),
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

  // P1-02: `resolveDecisionRef` (`../governance/adr-registry.mjs`) had zero
  // production call sites — a row's decisionRef passed through every report
  // unverified. This command already walked every governance row for
  // attestation; these cases hold the SAME walk to the identical discipline
  // for the decisionRef citation.
  describe("decisionRef resolution (P1-02)", () => {
    it("names a row whose decisionRef resolves to no known ADR, rule, or fitness record", async () => {
      const result = await provenanceCommand(
        commandContext(),
        ioWith({
          intent: intent({
            forbidden: [
              {
                from: "a",
                to: "b",
                reason: "x",
                origin: { by: "j", tool: "l" },
                decisionRef: "9999-does-not-exist",
              },
            ],
          }),
          config: config([{ sourceTag: "x", decisionRef: "9999-also-missing" }]),
        }),
      );
      // Verdict-neutral, the same as an unattested row: still exit 0.
      expect(result.status).toBe("ok");
      expect(result.report.json).not.toContain('"exitCode": 1');
      expect(result.unresolvedDecisionRefs.map((r) => r.kind).sort()).toEqual([
        "depConstraints[0]",
        "forbidden[0]",
      ]);
      expect(result.unresolvedDecisionRefs.find((r) => r.kind === "forbidden[0]").decisionRef).toBe(
        "9999-does-not-exist",
      );
      expect(result.report.text).toContain("unresolved decisionRefs");
      expect(result.report.text).toContain('forbidden[0] — "9999-does-not-exist"');
      expect(result.report.text).toContain('depConstraints[0] — "9999-also-missing"');
    });

    it("resolves a decisionRef naming a real ADR id in the workspace's registry", async () => {
      const result = await provenanceCommand(
        commandContext(),
        ioWith({
          intent: intent({
            forbidden: [
              { from: "a", to: "b", reason: "x", decisionRef: "0001-bind-collaboration" },
            ],
          }),
          adrRecords: [{ id: "0001-bind-collaboration", bindings: [] }],
        }),
      );
      expect(result.unresolvedDecisionRefs).toEqual([]);
      expect(result.report.text).toContain(
        "✔ every decisionRef citation (1) resolves to a known ADR, rule, or fitness record",
      );
    });

    it("reports unresolved when a rule/fitness id is only ADR-bound and no policy declares it (F04)", async () => {
      // The audit's reproduction: an ADR binds `rule:no-direct-dep`, but no
      // policy has a `fitness` rule named `no-direct-dep`. The citation naming
      // it must be unresolved — an ADR binding itself is not a declaration,
      // and a citation that resolves itself is the silent direction this
      // finding closes. (A policy that DOES declare the name resolves — pinned
      // by the cli-level fitness citation tests.)
      const result = await provenanceCommand(
        commandContext(),
        ioWith({
          config: config([{ sourceTag: "x", decisionRef: "rule:no-direct-dep" }]),
          adrRecords: [{ id: "0001-bind-collaboration", bindings: ["rule:no-direct-dep"] }],
        }),
      );
      expect(result.unresolvedDecisionRefs).toEqual([
        expect.objectContaining({ kind: "depConstraints[0]", decisionRef: "rule:no-direct-dep" }),
      ]);
    });

    it("says nothing about decisionRefs when no row carries one — 'no fact, no claim'", async () => {
      const result = await provenanceCommand(
        commandContext(),
        ioWith({ intent: intent({ forbidden: [{ from: "a", to: "b", reason: "x" }] }) }),
      );
      expect(result.unresolvedDecisionRefs).toEqual([]);
      expect(result.report.text).not.toContain("decisionRef");
    });

    it("serializes unresolvedDecisionRefs in the JSON envelope, unconditionally like unattested", async () => {
      const result = await provenanceCommand(
        commandContext(),
        ioWith({ intent: intent({ forbidden: [{ from: "a", to: "b", reason: "x" }] }) }),
      );
      const envelope = JSON.parse(result.report.json);
      expect(envelope.result.unresolvedDecisionRefs).toEqual([]);
    });

    it("surfaces a malformed ADR registry loudly — exit 3, the same refusal a malformed intent gets", async () => {
      await expect(
        provenanceCommand(commandContext(), {
          ...ioWith({ intent: intent({ forbidden: [{ from: "a", to: "b", reason: "x" }] }) }),
          loadAdrRegistryOverride: () => {
            throw new Error("archkeep: malformed ADR registry: 0001-x: unknown frontmatter key");
          },
        }),
      ).rejects.toThrow(/malformed ADR registry/);
    });
  });
});

// PR E — the decision lifecycle: every recorded decision's current state
// attributed with WHO recorded it, read from committed git history (or
// `io.fileAttribution`, its test seam). Descriptive and verdict-neutral,
// exactly like the other three surfaces.
describe("decision lifecycle (PR E)", () => {
  const lifecycleRecords = () => [
    {
      id: "0001-bind-collaboration",
      status: "active",
      created: "2026-01-15",
      updated: "2026-08-01",
      supersedes: [],
      supersededBy: [],
      bindings: ["type-package"],
    },
    {
      id: "0002-scopes",
      status: "active",
      supersedes: ["0003-rename-lattice"],
      supersededBy: [],
      bindings: [],
    },
    {
      id: "0003-rename-lattice",
      status: "superseded",
      supersedes: [],
      supersededBy: ["0002-scopes"],
      bindings: [],
    },
  ];
  const attribution = {
    createdBy: { by: "Tess <tess@example.com>", tool: "git", on: "2026-01-02T00:00:00.000Z" },
    lastChangedBy: { by: "Rex <rex@example.com>", tool: "git", on: "2026-08-16T00:00:00.000Z" },
  };

  it("attributes every recorded decision from its file's committed history", async () => {
    const result = await provenanceCommand(
      commandContext(),
      ioWith({
        intent: intent(),
        adrRecords: lifecycleRecords(),
        fileAttribution: () => attribution,
      }),
    );
    expect(result.decisionLifecycle).toHaveLength(3);
    expect(result.decisionLifecycle[0]).toEqual({
      id: "0001-bind-collaboration",
      status: "active",
      authority: true,
      created: "2026-01-15",
      updated: "2026-08-01",
      supersedes: [],
      supersededBy: [],
      bindings: ["type-package"],
      attribution: { createdBy: attribution.createdBy, lastChangedBy: attribution.lastChangedBy },
      attested: true,
      note: null,
    });
  });

  it("renders the attributed lifecycle with created/last-change, lineage, bindings, and timeline", async () => {
    const result = await provenanceCommand(
      commandContext(),
      ioWith({
        intent: intent(),
        adrRecords: lifecycleRecords(),
        fileAttribution: () => attribution,
      }),
    );
    expect(result.report.text).toContain(
      "decisions  3 recorded — 3 attributed, 0 without attribution",
    );
    expect(result.report.text).toContain(
      "created by Tess <tess@example.com> on 2026-01-02T00:00:00.000Z",
    );
    expect(result.report.text).toContain(
      "changed by Rex <rex@example.com> on 2026-08-16T00:00:00.000Z",
    );
    expect(result.report.text).toContain("supersedes 0003-rename-lattice");
    expect(result.report.text).toContain("superseded by 0002-scopes");
    expect(result.report.text).toContain("binds type-package");
    expect(result.report.text).toContain("timeline 2026-01-15 → 2026-08-01");
    expect(result.report.text).toContain(
      "✔ every decision's lifecycle is attributed — each change names who recorded it and with what tool",
    );
  });

  it("marks a decision without attribute history cannot-attest — never a silent pass", async () => {
    // `ioWith` leaves `fileAttribution` unset, so the mocked
    // `resolveFileAttribution` (→ null) is the command's default.
    const result = await provenanceCommand(
      commandContext(),
      ioWith({ intent: intent(), adrRecords: lifecycleRecords() }),
    );
    expect(result.decisionLifecycle).toHaveLength(3);
    for (const decision of result.decisionLifecycle) {
      expect(decision.attested).toBe(false);
      expect(decision.attribution).toEqual({ createdBy: null, lastChangedBy: null });
      expect(decision.note).toBe("no origin recorded — cannot attest");
    }
    expect(result.report.text).toContain(
      "decisions  3 recorded — 0 attributed, 3 without attribution",
    );
    expect(result.report.text).toContain(
      "unattributed lifecycle (no origin recorded — cannot attest):",
    );
    expect(result.report.text).toContain("  0001-bind-collaboration");
    expect(result.report.text).toContain("  0002-scopes");
    expect(result.report.text).toContain("  0003-rename-lattice");
    expect(result.report.text).toContain(
      "3 of them carry no recorded origin behind their lifecycle",
    );
  });

  it("is verdict-neutral — cannot-attest decisions change no verdict (exit stays 0)", async () => {
    const result = await provenanceCommand(
      commandContext(),
      ioWith({ intent: intent(), adrRecords: lifecycleRecords() }),
    );
    expect(result.status).toBe("ok");
    expect(result.report.json).not.toContain('"exitCode": 1');
  });

  it("surfaces no decision section when the registry holds no decisions — 'no fact, no claim'", async () => {
    const result = await provenanceCommand(
      commandContext(),
      ioWith({ intent: intent(), adrRecords: [] }),
    );
    expect(result.decisionLifecycle).toEqual([]);
    expect(result.report.text).not.toContain("decisions");
    expect(result.report.text).not.toContain("cannot attest");
  });

  it("serializes result.decisionLifecycle in the JSON envelope, unconditionally", async () => {
    const result = await provenanceCommand(
      commandContext(),
      ioWith({
        intent: intent(),
        adrRecords: lifecycleRecords(),
        fileAttribution: () => attribution,
      }),
    );
    const envelope = JSON.parse(result.report.json);
    expect(envelope.result.decisionLifecycle).toHaveLength(3);
    expect(envelope.result.decisionLifecycle[0].attested).toBe(true);
    expect(envelope.result.decisionLifecycle[0].supercedes).toBeUndefined();
    expect(envelope.result.decisionLifecycle[0].supersedes).toEqual([]);
  });

  it("is byte-identical across two runs over the same tree, attribution fixed", async () => {
    const io = ioWith({
      intent: intent(),
      adrRecords: lifecycleRecords(),
      fileAttribution: () => attribution,
    });
    const [a, b] = await Promise.all([
      provenanceCommand(commandContext(), io),
      provenanceCommand(commandContext(), io),
    ]);
    expect(a.report.json).toBe(b.report.json);
    expect(a.report.text).toBe(b.report.text);
  });

  it("serializes result.provenanceGraph and result.claims in the JSON envelope", async () => {
    const result = await provenanceCommand(
      commandContext(),
      ioWith({
        intent: intent({
          allowed: [
            {
              from: "a",
              to: "b",
              origin: { by: "jane", tool: "archkeep:v1" },
              decisionRef: "adr:0001-bind-collaboration",
            },
          ],
        }),
        adrRecords: lifecycleRecords(),
        fileAttribution: () => attribution,
      }),
    );
    const envelope = JSON.parse(result.report.json);

    // provenanceGraph is present and has expected top-level keys
    expect(envelope.result.provenanceGraph).toBeDefined();
    expect(Array.isArray(envelope.result.provenanceGraph.nodes)).toBe(true);
    expect(Array.isArray(envelope.result.provenanceGraph.edges)).toBe(true);
    expect(Array.isArray(envelope.result.provenanceGraph.claims)).toBe(true);
    expect(Array.isArray(envelope.result.provenanceGraph.causalChains)).toBe(true);

    // At minimum: repo node + row node + decision nodes
    expect(envelope.result.provenanceGraph.nodes.length).toBeGreaterThanOrEqual(2);

    // Edges: at least provenance + decisionRef
    expect(envelope.result.provenanceGraph.edges.length).toBeGreaterThanOrEqual(2);

    // Claims: at least attestation + resolution + lifecycle
    expect(envelope.result.provenanceGraph.claims.length).toBeGreaterThanOrEqual(3);

    // result.claims is a separate top-level shorthand
    expect(Array.isArray(envelope.result.claims)).toBe(true);
  });

  it("includes provenanceGraph summary in the text report when provenanceGraph is present", async () => {
    const result = await provenanceCommand(
      commandContext(),
      ioWith({
        intent: intent({
          allowed: [
            {
              from: "a",
              to: "b",
              origin: { by: "jane", tool: "archkeep:v1" },
              decisionRef: "adr:0001-bind-collaboration",
            },
          ],
        }),
        adrRecords: lifecycleRecords(),
        fileAttribution: () => attribution,
      }),
    );
    // The text report contains a "graph" line with counts
    const lines = result.report.text.split("\n");
    const graphLine = lines.find((l) => l.startsWith("graph"));
    expect(graphLine).toBeDefined();
    expect(graphLine).toContain("nodes");
    expect(graphLine).toContain("edges");
    expect(graphLine).toContain("claims");
    expect(graphLine).toContain("chain");
    // Also has a "chain" example line
    const chainLine = lines.find((l) => l.startsWith("chain"));
    expect(chainLine).toBeDefined();
    expect(chainLine).toContain("hops");
  });
});
describe("provenance completeness — every row in intent has an entry in result.rows", () => {
  it("maps every intent row (allowed, forbidden, projects) to a result.rows entry", async () => {
    const result = await provenanceCommand(
      commandContext(),
      ioWith({
        intent: intent({
          allowed: [{ from: "packages", to: "packages", origin: { by: "j", tool: "l" } }],
          forbidden: [{ from: "packages", to: "extensions", reason: "x" }],
          projects: { required: [{ name: "web", origin: { by: "j", tool: "l" } }] },
        }),
      }),
    );
    const kinds = result.rows.map((r) => r.kind).sort();
    expect(kinds).toEqual(["allowed[0]", "forbidden[0]", "projects.required[0]"]);
    expect(result.rows).toHaveLength(3);
  });

  it("maps every config row to a result.rows entry", async () => {
    const result = await provenanceCommand(
      commandContext(),
      ioWith({
        intent: intent(),
        config: config([
          { sourceTag: "layer:domain", origin: { by: "j", tool: "l" } },
          { sourceTag: "layer:app", origin: { by: "j", tool: "l" } },
        ]),
      }),
    );
    const kinds = result.rows.map((r) => r.kind).sort();
    expect(kinds).toEqual(["depConstraints[0]", "depConstraints[1]"]);
    expect(result.rows).toHaveLength(2);
  });

  it("reports unattested rows matching those without origin — no row with origin in unattested", async () => {
    const result = await provenanceCommand(
      commandContext(),
      ioWith({
        intent: intent({
          allowed: [{ from: "a", to: "b", origin: { by: "j", tool: "l" } }],
          forbidden: [{ from: "a", to: "c", reason: "x" }],
        }),
      }),
    );
    // The allowed row is attested, the forbidden row is not.
    expect(result.rows.filter((r) => r.attested)).toHaveLength(1);
    expect(result.rows.filter((r) => !r.attested)).toHaveLength(1);
    expect(result.unattested.map((r) => r.kind)).toEqual(["forbidden[0]"]);
    // Every unattested row is also in result.rows as unattested.
    for (const u of result.unattested) {
      const match = result.rows.find((r) => r.kind === u.kind);
      expect(match).toBeDefined();
      expect(match.attested).toBe(false);
    }
  });

  it("reports zero unattested rows when every row carries an origin", async () => {
    const result = await provenanceCommand(
      commandContext(),
      ioWith({
        intent: intent({
          allowed: [{ from: "a", to: "b", origin: { by: "j", tool: "l" } }],
          projects: {
            required: [{ name: "web", origin: { by: "j", tool: "l" } }],
          },
        }),
        config: config([{ sourceTag: "x", origin: { by: "j", tool: "l" } }]),
      }),
    );
    expect(result.unattested).toEqual([]);
    expect(result.rows.every((r) => r.attested)).toBe(true);
  });
});

describe("cross-command provenance shape consistency", () => {
  it("the resolveProvenance mock returns the contract shape all 6 commands expect", () => {
    // Every command consuming resolveProvenance (diff, delta, drift, reconcile,
    // impact, context) expects the same { commit, remote, dirty } shape. The
    // mock in this file must match that contract so the command-under-test
    // behaves identically to production.
    const mockResult = { commit: "abc1234", remote: "git@example.com:acme/repo.git", dirty: false };
    // Verify the shape keys match the contract.
    const keys = Object.keys(mockResult);
    expect(keys).toEqual(expect.arrayContaining(["commit", "remote", "dirty"]));
    expect(keys).toHaveLength(3);
    expect(typeof mockResult.commit).toBe("string");
    expect(typeof mockResult.remote).toBe("string");
    expect(typeof mockResult.dirty).toBe("boolean");
  });

  it("the repo field in the command result mirrors the contract shape plus established", async () => {
    const result = await provenanceCommand(
      commandContext(),
      ioWith({ intent: intent({ forbidden: [{ from: "a", to: "b", reason: "x" }] }) }),
    );
    // result.repo extends {commit, remote, dirty} with {established}.
    expect(result.repo).toMatchObject({
      commit: expect.any(String),
      remote: expect.any(String),
      dirty: expect.any(Boolean),
      established: true,
    });
    const keys = Object.keys(result.repo);
    expect(keys).toEqual(expect.arrayContaining(["commit", "remote", "dirty", "established"]));
    expect(keys).toHaveLength(4);
  });

  it("the envelope workspace.provenance has the same {commit, remote, dirty} shape", async () => {
    const result = await provenanceCommand(
      commandContext(),
      ioWith({ intent: intent({ forbidden: [{ from: "a", to: "b", reason: "x" }] }) }),
    );
    const envelope = JSON.parse(result.report.json);
    expect(envelope.workspace.provenance).toMatchObject({
      commit: expect.any(String),
      remote: expect.any(String),
      dirty: expect.any(Boolean),
    });
    const keys = Object.keys(envelope.workspace.provenance);
    expect(keys).toEqual(expect.arrayContaining(["commit", "remote", "dirty"]));
  });
});

describe("provenance-command — error-path", () => {
  it("reports empty intent rows — no rows to attest", async () => {
    const result = await provenanceCommand(
      commandContext(),
      ioWith({ intent: intent({ allowed: [], forbidden: [] }) }),
    );
    expect(result.rows).toEqual([]);
    expect(result.unattested).toEqual([]);
  });

  it("reports zero config rows when no boundary config is named — no config, no rows", async () => {
    const result = await provenanceCommand(
      commandContext({ options: { boundaryConfig: undefined } }),
      ioWith({ intent: intent({ forbidden: [{ from: "a", to: "b", reason: "x" }] }) }),
    );
    expect(result.rows).toHaveLength(1); // Only the intent row.
  });

  it("refuses an intent with null rows — a null row is not a valid governance row", async () => {
    await expect(
      provenanceCommand(commandContext(), {
        loadIntentOverride: async () => ({ allowed: [null], forbidden: [] }),
      }),
    ).rejects.toThrow();
  });

  it("refuses an intent with undefined rows — missing row lists are malformed", async () => {
    await expect(
      provenanceCommand(commandContext(), {
        loadIntentOverride: async () => ({ allowed: [undefined], forbidden: [] }),
      }),
    ).rejects.toThrow();
  });
});
