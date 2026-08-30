import { describe, expect, it } from "vitest";

import { computeDebtLedger } from "./debt-ledger.mjs";

/**
 * The lifecycle surface W5 adds to the debt ledger (design §6): stable ids,
 * event-linked `introducedBy`/`resolvedBy`, an `active`/`resolved` split, and
 * the invariants that hold it honest — idempotency (same facts ⇒ same ids,
 * never a clock or sequence), monotonicity (repair ⇒ active count decreases,
 * history retained), and the SILENT direction (a vanished fact without
 * evidence is NOT auto-resolved; refs are never fabricated).
 *
 * The ledger facts are the same candid kinds the base ledger already derives
 * (suppressions / aspirational notes / drift findings / unresolved). Events use
 * the canonical EvolutionEvent shape (`evolution-event.mjs`): each carries a
 * stable `id` and a `debt.introduced` / `debt.resolved` set of debt entry ids.
 */
const aged = {
  files: [
    {
      name: "0001-a.json",
      envelope: {
        result: {
          projects: [{ name: "app", root: "libs/app", tags: [] }],
          dependencies: [],
        },
      },
      id: "a",
    },
    {
      name: "0002-b.json",
      envelope: {
        result: {
          projects: [{ name: "app", root: "libs/app", tags: [] }],
          dependencies: [],
        },
      },
      id: "b",
    },
  ],
};

const WAIVER = { path: "libs/app/v.go", reason: "legacy" };
const waiverCurrent = (overrides = {}) => ({
  suppressions: [WAIVER],
  intentNotes: [],
  findings: [],
  unresolved: [],
  ...overrides,
});
const noDebt = () => ({ suppressions: [], intentNotes: [], findings: [], unresolved: [] });

/** The stable id the ledger assigns to the `libs/app/v.go` waiver. */
function waiverId() {
  return computeDebtLedger(waiverCurrent(), aged).entries[0].id;
}

describe("computeDebtLedger — stable ids", () => {
  it("assigns every entry a stable, clock-free id — two runs over identical facts produce identical ids", () => {
    const a = computeDebtLedger(waiverCurrent(), aged, {
      referenceTime: "2026-08-16T00:00:00.000Z",
    });
    const b = computeDebtLedger(waiverCurrent(), aged, {
      referenceTime: "2026-08-16T01:00:00.000Z",
    });
    expect(a.entries).toHaveLength(1);
    expect(a.entries[0].id).toBe(b.entries[0].id);
    // This assertion is the one that goes red if ids were sequential: a
    // sequence/clock would differ between the two runs above.
    expect(a.entries[0].status).toBe("active");
  });

  it("gives a different fact a different id — identity is the semantic fact, never a position", () => {
    const a = computeDebtLedger(waiverCurrent(), aged);
    const b = computeDebtLedger(
      waiverCurrent({ suppressions: [{ path: "libs/app/other.go", reason: "legacy" }] }),
      aged,
    );
    expect(a.entries[0].id).not.toBe(b.entries[0].id);
  });

  it("keeps an expired waiver's id equal to the same waiver unexpired — identity cannot depend on a transient state", () => {
    // A waiver that lapsed (reassert) and the same waiver still suppressed are
    // the SAME accepted violation; its id must not change when expiresAt passes.
    const active = computeDebtLedger(waiverCurrent(), aged);
    const expired = computeDebtLedger(
      waiverCurrent({
        suppressions: [
          { path: "libs/app/v.go", reason: "legacy", expiresAt: "2000-01-01T00:00:00.000Z" },
        ],
      }),
      aged,
    );
    expect(expired.entries[0].kind).toBe("expired-waiver");
    expect(expired.entries[0].id).toBe(active.entries[0].id);
  });

  it("gives distinct drift findings in the same source project distinct ids (F-DEB-5)", () => {
    // Two findings `{source:"A",target:"B"}` and `{source:"A",target:"C"}` — a
    // change whose drift spans two targets — must NOT collide onto one id. Keying
    // on `source` alone (or the prose message) would over-resolve A's whole drift
    // when one REPAIR closes one edge. The identity is the full `{source, target,
    // rule}` tuple (F-DEB-5).
    const current = {
      suppressions: [],
      intentNotes: [],
      findings: [
        { source: "A", target: "B", rule: "intentForbiddenEdge", message: "m1" },
        { source: "A", target: "C", rule: "intentForbiddenEdge", message: "m2" },
      ],
      unresolved: [],
    };
    const ledger = computeDebtLedger(current, aged);
    expect(ledger.entries).toHaveLength(2);
    expect(ledger.entries[0].id).not.toBe(ledger.entries[1].id);
  });

  it("keys an aspirational gap by its {from,to} fact, not its prose note (F-DEB-8)", () => {
    // The same optional allowed row, however its note is worded, must hash to the
    // SAME id — a reworded note must not orphan event-linked refs.
    const a = computeDebtLedger(
      {
        suppressions: [],
        intentNotes: [],
        gaps: [
          {
            from: "payments",
            to: "api",
            note: 'optional allowed intent "payments" → "api" is not yet observed — aspirational, not drift',
          },
        ],
        findings: [],
        unresolved: [],
      },
      aged,
    );
    const b = computeDebtLedger(
      {
        suppressions: [],
        intentNotes: [],
        gaps: [
          {
            from: "payments",
            to: "api",
            note: "completely reworded - build payments reaching api eventually",
          },
        ],
        findings: [],
        unresolved: [],
      },
      aged,
    );
    expect(a.entries).toHaveLength(1);
    expect(a.entries[0].kind).toBe("aspirational-gap");
    expect(a.entries[0].id).toBe(b.entries[0].id);
  });
});

describe("computeDebtLedger — event linkage (introducedBy)", () => {
  it("links an active entry to the event that introduced it", () => {
    const id = waiverId();
    const events = [
      { id: "evt-intro", classifications: ["VIOLATION"], debt: { introduced: [id], resolved: [] } },
    ];
    const ledger = computeDebtLedger(waiverCurrent(), aged, { events });
    expect(ledger.entries[0].introducedBy).toBe("evt-intro");
    expect(ledger.entries[0].status).toBe("active");
  });

  it("accepts a { getEvents(dir) }-shaped reader, the command's lazy seam (design §4)", () => {
    const id = waiverId();
    const events = [
      { id: "evt-intro", classifications: ["VIOLATION"], debt: { introduced: [id], resolved: [] } },
    ];
    const ledger = computeDebtLedger(waiverCurrent(), aged, {
      events: { getEvents: () => events },
    });
    expect(ledger.entries[0].introducedBy).toBe("evt-intro");
    expect(ledger.lifecycle.linked).toBe(true);
  });
});

describe("computeDebtLedger — resolved list", () => {
  it("moves a closed debt to resolved when its fact is gone at head AND a REPAIR event evidences it, retaining the record", () => {
    const id = waiverId();
    const events = [
      { id: "evt-intro", classifications: ["VIOLATION"], debt: { introduced: [id], resolved: [] } },
      { id: "evt-repair", classifications: ["REPAIR"], debt: { introduced: [], resolved: [id] } },
    ];
    // The fact is gone at head: current facts carry no waiver.
    const ledger = computeDebtLedger(noDebt(), aged, { events });
    expect(ledger.entries).toHaveLength(0);
    expect(ledger.resolved).toHaveLength(1);
    // The resolved surface is evidence-backed ONLY — no fabricated
    // kind/severity/age/count (the original entry lives in the history
    // snapshots, never a stand-in row) (F-DEB-2).
    expect(ledger.resolved[0]).toEqual({
      id,
      status: "resolved",
      resolvedBy: "evt-repair",
    });
  });

  it("does NOT resolve a debt that is still active at head — an id that came back is not resolved", () => {
    const id = waiverId();
    const events = [
      { id: "evt-intro", classifications: ["VIOLATION"], debt: { introduced: [id], resolved: [] } },
      { id: "evt-repair", classifications: ["REPAIR"], debt: { introduced: [], resolved: [id] } },
    ];
    // The waiver is still present at head → still an active finding.
    const ledger = computeDebtLedger(waiverCurrent(), aged, { events });
    expect(ledger.entries.some((e) => e.id === id && e.status === "active")).toBe(true);
    expect(ledger.resolved).toEqual([]);
  });

  it("deduplicates a debt id resolved by several REPAIR events", () => {
    const id = waiverId();
    const events = [
      { id: "evt-intro", classifications: ["VIOLATION"], debt: { introduced: [id], resolved: [] } },
      { id: "evt-repair-1", classifications: ["REPAIR"], debt: { introduced: [], resolved: [id] } },
      { id: "evt-repair-2", classifications: ["REPAIR"], debt: { introduced: [], resolved: [id] } },
    ];
    const ledger = computeDebtLedger(noDebt(), aged, { events });
    expect(ledger.resolved).toHaveLength(1);
    expect(ledger.resolved[0].resolvedBy).toBe("evt-repair-1");
  });

  it("never resolves an id NO event introduced — a foreign id is not debt (F-DEB-2)", () => {
    const id = waiverId();
    // The REPAIR names `id`, but no event ever put it on `debt.introduced`:
    // it was never debt, so resolving it would invent a foreign fact. The
    // list must come back empty — never a fabricated "resolved" row.
    const events = [
      { id: "evt-repair", classifications: ["REPAIR"], debt: { introduced: [], resolved: [id] } },
    ];
    const ledger = computeDebtLedger(noDebt(), aged, { events });
    expect(ledger.resolved).toEqual([]);
  });
});

describe("computeDebtLedger — no event store linked", () => {
  it("appends the unavailable-refs note and fabricates nothing", () => {
    const ledger = computeDebtLedger(noDebt(), aged);
    expect(ledger.resolved).toEqual([]);
    expect(ledger.lifecycle.linked).toBe(false);
    expect(ledger.lifecycle.note).toBe("no event store linked — lifecycle refs unavailable");
  });

  it("omits introducedBy/resolvedBy from entries when no store is linked — refs are never guessed", () => {
    const ledger = computeDebtLedger(waiverCurrent(), aged);
    expect(Object.hasOwn(ledger.entries[0], "introducedBy")).toBe(false);
    expect(Object.hasOwn(ledger.entries[0], "resolvedBy")).toBe(false);
    expect(ledger.resolved).toEqual([]);
  });
});

describe("computeDebtLedger — monotonicity", () => {
  it("shows active count decreasing as debt is introduced then repaired, with history retained", () => {
    const id = waiverId();
    // Run A: the debt is live, introduced by an event.
    const activeEvents = [
      { id: "evt-intro", classifications: ["VIOLATION"], debt: { introduced: [id], resolved: [] } },
    ];
    const before = computeDebtLedger(waiverCurrent(), aged, { events: activeEvents });
    expect(before.entries).toHaveLength(1);
    expect(before.entries[0].status).toBe("active");
    expect(before.entries[0].introducedBy).toBe("evt-intro");
    expect(before.resolved).toHaveLength(0);

    // Run B: repaired — the fact is gone at head, a REPAIR event closes it.
    // The intro event precedes the repair in lineage, so the id is real debt
    // the repair closes — never a foreign id resolved from nothing.
    const repairedEvents = [
      { id: "evt-intro", classifications: ["VIOLATION"], debt: { introduced: [id], resolved: [] } },
      { id: "evt-repair", classifications: ["REPAIR"], debt: { introduced: [], resolved: [id] } },
    ];
    const after = computeDebtLedger(noDebt(), aged, { events: repairedEvents });
    expect(after.entries).toHaveLength(0); // active count decreased
    expect(after.resolved).toHaveLength(1); // the entry is retained, not deleted
    expect(after.resolved[0].id).toBe(id);
  });
});

describe("computeDebtLedger — SILENT direction", () => {
  it("never auto-resolves a fact that vanished without evidence — the list stays empty", () => {
    // The waiver is gone at head AND an event store is linked, but NOTHING in
    // the store resolves it. A vanished fact without evidence must NOT appear
    // on `resolved` — this assertion goes red if a vanished fact auto-resolved.
    const events = [
      { id: "evt-unrelated", classifications: ["DRIFT"], debt: { introduced: [], resolved: [] } },
    ];
    const ledger = computeDebtLedger(noDebt(), aged, { events });
    expect(ledger.resolved).toEqual([]);
    expect(ledger.entries).toHaveLength(0);
  });

  it("does not move an id to resolved unless a REPAIR names an id that was ever debt (F-DEB-2)", () => {
    // The store has a REPAIR, but it resolves a DIFFERENT debt id, not ours —
    // and that foreign id was never introduced by any event. Neither our
    // vanished waiver nor the foreign id counts as resolved: resolution only
    // ever names an id a REPAIR explicitly closed AND an event introduced.
    const events = [
      {
        id: "evt-repair-other",
        classifications: ["REPAIR"],
        debt: { introduced: [], resolved: ["debt-for-something-else"] },
      },
    ];
    const ledger = computeDebtLedger(noDebt(), aged, { events });
    expect(ledger.resolved).toEqual([]);
  });
});
