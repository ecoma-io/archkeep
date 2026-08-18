import { describe, expect, it } from "vitest";

import { adrCommand, readAdrContext } from "./adr.mjs";

/** A registry as `loadAdrRegistryOverride` returns it. */
function REGISTRY_ENTRIES() {
  return [
    {
      id: "0001-bind-collaboration",
      status: "accepted",
      supersedes: [],
      bindings: ["rule:no-direct-dep", "fitness:hotspot"],
    },
    {
      id: "0002-bind-logs",
      status: "superseded",
      supersedes: ["0001-bind-collaboration"],
      bindings: ["rule:sticky-logs"],
    },
  ];
}

function registry() {
  const entries = REGISTRY_ENTRIES();
  return {
    records: entries,
    byId: new Map(entries.map((r) => [r.id, r])),
  };
}

const ioWith = (override) => ({ loadAdrRegistryOverride: override });

describe("readAdrContext", () => {
  it("derives the known-fitness set from the bindings across records", () => {
    const ctx = readAdrContext(
      "/ws",
      ioWith(() => registry()),
    );
    expect([...ctx.knownFitness]).toEqual(
      expect.arrayContaining(["rule:no-direct-dep", "fitness:hotspot", "rule:sticky-logs"]),
    );
  });
});

describe("adrCommand", () => {
  it("dumps the whole registry with no id", () => {
    const result = adrCommand(
      "/ws",
      {},
      ioWith(() => registry()),
    );
    expect(result.status).toBe("ok");
    expect(result.coverage.complete).toBe(true);
    expect(result.result.adrs).toEqual(["0001-bind-collaboration", "0002-bind-logs"]);
    expect(result.result.registry).toEqual({ dir: "docs/adr", count: 2 });
    expect(result.result.supersedes).toEqual([
      { adr: "0002-bind-logs", supersedes: "0001-bind-collaboration" },
    ]);
    // The supersession chain is stated in text, not just the payload.
    expect(result.report.text).toContain("supersedes: 0001-bind-collaboration");
    // Both records' status sets listed.
    expect(result.report.text).toContain("(accepted)");
    expect(result.report.text).toContain("(superseded)");
  });

  it("shows one record for a known id", () => {
    const result = adrCommand(
      "/ws",
      { id: "0002-bind-logs" },
      ioWith(() => registry()),
    );
    expect(result.status).toBe("ok");
    expect(result.report.text).toContain("0002-bind-logs");
    expect(result.report.text).toContain("bindings:   rule:sticky-logs");
  });

  it("answers the reverse lookup — which ADRs bind a rule/fitness id", () => {
    const result = adrCommand(
      "/ws",
      { id: "rule:no-direct-dep" },
      ioWith(() => registry()),
    );
    expect(result.status).toBe("ok");
    expect(result.report.text).toContain("rule:no-direct-dep is bound by: 0001-bind-collaboration");
  });

  it("names a rule/fitness no ADR binds as unenforced, still ok", () => {
    const result = adrCommand(
      "/ws",
      { id: "rule:orphan" },
      ioWith(() => registry()),
    );
    expect(result.status).toBe("ok");
    expect(result.report.text).toContain("no ADR in docs/adr/ binds rule:orphan");
  });

  it("reads an empty registry as an empty, ok dump", () => {
    const result = adrCommand(
      "/ws",
      {},
      ioWith(() => ({ records: [], byId: new Map() })),
    );
    expect(result.status).toBe("ok");
    expect(result.report.text).toContain("no ADRs in docs/adr/");
  });

  it("reports an unknown ADR-id as no-verdict — exit 3, never clean", () => {
    const result = adrCommand(
      "/ws",
      { id: "0999-ghost" },
      ioWith(() => registry()),
    );
    expect(result.status).toBe("no-verdict");
    expect(result.coverage.complete).toBe(false);
    expect(result.result.unresolved).toEqual([
      { ref: "0999-ghost", why: "0999-ghost is not an ADR in docs/adr" },
    ]);
    expect(result.report.text).toContain("no ADR 0999-ghost in docs/adr/");
  });

  // P1-23: this tool's own decisionRef docs (`../governance/row-schema.mjs`)
  // recommend `adr:0012` as a valid ADR-id spelling right beside the bare
  // `0012-slug` form — but the lookup used to check `byId` verbatim, so the
  // one spelling the tool itself suggests never matched a real record. Worse,
  // because the id no longer matched `ADR_ID_PATTERN` once prefixed, it fell
  // through to the reverse-lookup branch and reported the generic "no ADR
  // binds it" sentence at exit 0 — indistinguishable from a legitimate,
  // unbound rule/fitness id.
  it("resolves the tool's own recommended `adr:`-prefixed spelling to the real record", () => {
    const result = adrCommand(
      "/ws",
      { id: "adr:0001-bind-collaboration" },
      ioWith(() => registry()),
    );
    expect(result.status).toBe("ok");
    expect(result.result.unresolved).toEqual([]);
    expect(result.report.text).toContain("0001-bind-collaboration  (accepted)");
    expect(result.report.text).toContain("bindings:   rule:no-direct-dep, fitness:hotspot");
    // The silent-direction failure mode this guards: reading as an unbound
    // reverse lookup instead of the real record.
    expect(result.report.text).not.toContain("no ADR in docs/adr/ binds");
  });

  // Same finding, the broader half: ANY near-miss spelling of a real id —
  // wrong case, a path-traversal shape, or the `adr:` prefix on an id that
  // does not exist either — must read as unresolved, never fall into the
  // "empty reverse lookup" bucket that a genuine `rule:`/`fitness:` reference
  // is allowed to land in empty.
  it.each([
    ["0001-BIND-COLLABORATION", "an uppercase near-miss of a real id"],
    ["../0001-bind-collaboration", "a path-traversal-shaped near-miss"],
    ["adr:0999-ghost", "the adr: prefix on an id that does not exist"],
  ])("reports %s (%s) as no-verdict, never a silent clean reverse lookup", (nearMiss) => {
    const result = adrCommand(
      "/ws",
      { id: nearMiss },
      ioWith(() => registry()),
    );
    expect(result.status).toBe("no-verdict");
    expect(result.coverage.complete).toBe(false);
    expect(result.result.unresolved).toEqual([
      { ref: nearMiss, why: `${nearMiss} is not an ADR in docs/adr` },
    ]);
    expect(result.report.text).toContain(`no ADR ${nearMiss} in docs/adr/`);
    // The silent-direction failure mode this guards: reading as a clean,
    // merely-unbound reverse lookup instead of an unresolved reference.
    expect(result.report.text).not.toContain("no ADR in docs/adr/ binds");
  });

  it("builds a versioned JSON envelope naming the command and provider", () => {
    const result = adrCommand(
      "/ws",
      {},
      ioWith(() => registry()),
    );
    const envelope = JSON.parse(result.report.json);
    expect(envelope.command).toBe("adr");
    expect(envelope.workspace.provider).toBe("native");
    expect(envelope.workspace.marker).toBe("docs/adr");
    expect(envelope.exitCode).toBe(0);
    expect(envelope.status).toBe("ok");
    expect(envelope.result.count ?? envelope.result.registry.count).toBe(2);
  });

  it("throws on an unreadable registry — never an empty answer", () => {
    const thrower = ioWith(() => {
      throw new Error("lattice: cannot read docs/adr: EACCES: permission denied");
    });
    expect(() => adrCommand("/ws", {}, thrower)).toThrow(/cannot read docs\/adr/);
  });
});
