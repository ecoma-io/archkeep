import { describe, expect, it } from "vitest";

import { adrCommand, readAdrContext } from "./adr.mjs";

/** A registry as `loadAdrRegistryOverride` returns it (post-A records carry
 * the derived `supersededBy` reverse-link array on every entry). */
function REGISTRY_ENTRIES() {
  return [
    {
      id: "0001-bind-collaboration",
      status: "accepted",
      supersedes: [],
      supersededBy: ["0002-bind-logs"],
      bindings: ["rule:no-direct-dep", "fitness:hotspot"],
    },
    {
      id: "0002-bind-logs",
      status: "superseded",
      supersedes: ["0001-bind-collaboration"],
      supersededBy: [],
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

const ioWith = (override, extra = {}) => ({ loadAdrRegistryOverride: override, ...extra });

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
    expect(result.result.adrs).toEqual(["0001-bind-collaboration", "0002-bind-logs"]);
    expect(result.result.registry).toEqual({ dir: "docs/adr", count: 2 });
    expect(result.result.supersedes).toEqual([
      { adr: "0002-bind-logs", supersedes: "0001-bind-collaboration" },
    ]);
    // The derived reverse link is mirrored into the envelope, not only the text.
    expect(result.result.supersededBy).toEqual([
      { adr: "0001-bind-collaboration", supersededBy: "0002-bind-logs" },
    ]);
    // The supersession chain is stated in text, not just the payload.
    expect(result.report.text).toContain("supersedes: 0001-bind-collaboration");
    expect(result.report.text).toContain("supersededBy: 0002-bind-logs");
    // Both records' status sets listed.
    expect(result.report.text).toContain("(accepted)");
    expect(result.report.text).toContain("(superseded)");
  });

  it("derives per-decision fitness from injected verdicts, honestly when none resolve", () => {
    const result = adrCommand(
      "/ws",
      {},
      ioWith(() => registry()),
    );
    // No verdicts were supplied: the authority decision verifies nothing →
    // unverifiable (never healthy), the superseded one is not measured.
    expect(result.result.fitness).toEqual([
      {
        id: "0001-bind-collaboration",
        status: "accepted",
        level: "unverifiable",
        verified: false,
        reason:
          "no bound constraint for 0001-bind-collaboration resolves or was evaluated — none can be verified",
      },
      {
        id: "0002-bind-logs",
        status: "superseded",
        level: "not_applicable",
        verified: false,
        reason:
          'status "superseded" carries no authority — only active/accepted decisions are measured',
      },
    ]);
    expect(result.report.text).toContain(
      `fitness:      unverifiable — no bound constraint for 0001-bind-collaboration resolves or was evaluated — none can be verified`,
    );
    // The derivation is per-record; the dump carries one line per record.
    expect(result.report.text).toContain(
      `fitness:      not_applicable — status "superseded" carries no authority — only active/accepted decisions are measured`,
    );
  });

  it("reports enforced / partially-enforced / violated levels from injected verdicts", () => {
    // `fitness:hotspot` strips to `hotspot`; `rule:no-direct-dep` strips to
    // `no-direct-dep`. One declared name passes → partially-enforced; both
    // pass → enforced; one fails → violated (failure wins over everything).
    const withVerdicts = (functions) =>
      adrCommand(
        "/ws",
        {},
        ioWith(() => registry(), { fitnessVerdicts: functions }),
      );

    const partial = withVerdicts([{ name: "hotspot", verdict: "pass" }]);
    expect(partial.result.fitness[0].level).toBe("partially-enforced");
    expect(partial.result.fitness[0].reason).toContain("1 of 2 bound constraint(s) verified true");
    expect(partial.report.text).toContain("fitness:      partially-enforced —");

    const enforced = withVerdicts([
      { name: "hotspot", verdict: "pass" },
      { name: "no-direct-dep", verdict: "pass" },
    ]);
    expect(enforced.result.fitness[0]).toMatchObject({ level: "enforced", verified: true });
    expect(enforced.report.text).toContain(
      "fitness:      enforced — verified true: bound constraints resolve and pass",
    );

    const violated = withVerdicts([
      { name: "hotspot", verdict: "pass" },
      { name: "no-direct-dep", verdict: "fail" },
    ]);
    expect(violated.result.fitness[0].level).toBe("violated");
    expect(violated.report.text).toContain(
      'fitness:      violated — bound constraint "no-direct-dep" FAILED — what-must-remain-true is currently false',
    );
  });

  it("shows created/updated and prose fields on the single-record face", () => {
    const entries = REGISTRY_ENTRIES();
    entries[0].created = "2026-01-05";
    entries[0].updated = "2026-02-11";
    entries[0].context = "Two projects must not reach across the boundary.\n\nSee the doc.";
    entries[0].rationale = "Collaboration ties in the wrong direction.";
    const result = adrCommand(
      "/ws",
      { id: "0001-bind-collaboration" },
      ioWith(() => ({ records: entries, byId: new Map(entries.map((r) => [r.id, r])) })),
    );
    expect(result.status).toBe("ok");
    expect(result.report.text).toContain("created:   2026-01-05");
    expect(result.report.text).toContain("updated:   2026-02-11");
    expect(result.report.text).toContain(
      "context:     Two projects must not reach across the boundary.",
    );
    expect(result.report.text).toContain("             See the doc.");
    expect(result.report.text).toContain("rationale:   Collaboration ties in the wrong direction.");
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

  // The supersession chain used to be shape-checked and never resolved:
  // `validateRecord` (`../governance/adr-registry.mjs`) requires a supersedes
  // entry to LOOK like an ADR id and stops there, so a record superseding an
  // id no file carries loaded clean and the command printed the chain as fact
  // — `supersedes: 0000-does-not-exist` in the text, a `{adr, supersedes}` row
  // in `result.supersedes` — under `status: "ok"`, `exitCode: 0`,
  // `coverage.complete: true` and `unresolved: []`. That is the module
  // header's own refusal ("a supersedes target ... that names nothing") going
  // unmade, and the silent direction: a reader is told the older decision was
  // replaced by a decision this workspace never recorded.
  it("reports a supersedes target that names no record as no-verdict, never a printed chain at exit 0", () => {
    const entries = REGISTRY_ENTRIES();
    entries[1].supersedes = ["0000-does-not-exist"];
    const dangling = { records: entries, byId: new Map(entries.map((r) => [r.id, r])) };
    const result = adrCommand(
      "/ws",
      {},
      ioWith(() => dangling),
    );
    // The load-bearing half: no verdict at all, whatever the wording.
    expect(result.status).toBe("no-verdict");
    expect(result.coverage.complete).toBe(false);
    expect(JSON.parse(result.report.json).exitCode).toBe(3);
    expect(result.result.unresolved).toEqual([
      {
        ref: "0000-does-not-exist",
        why: "0002-bind-logs supersedes 0000-does-not-exist, which is not an ADR in docs/adr",
      },
    ]);
  });

  it("keeps a supersedes target that names a real record resolved, in both spellings", () => {
    // The other direction of the same check: the refusal above must not fire
    // on a chain that does resolve, and `adr:`-prefixed — the spelling this
    // tool's own decisionRef docs recommend — must not be the one spelling
    // that fails against a record that exists.
    for (const spelling of ["0001-bind-collaboration", "adr:0001-bind-collaboration"]) {
      const entries = REGISTRY_ENTRIES();
      entries[1].supersedes = [spelling];
      const result = adrCommand(
        "/ws",
        {},
        ioWith(() => ({ records: entries, byId: new Map(entries.map((r) => [r.id, r])) })),
      );
      expect(result.result.unresolved).toEqual([]);
      expect(result.status).toBe("ok");
    }
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
      throw new Error("archkeep: cannot read docs/adr: EACCES: permission denied");
    });
    expect(() => adrCommand("/ws", {}, thrower)).toThrow(/cannot read docs\/adr/);
  });
});
