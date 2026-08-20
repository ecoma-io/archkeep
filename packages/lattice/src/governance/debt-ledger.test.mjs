import { describe, expect, it } from "vitest";

import { computeDebtLedger } from "./debt-ledger.mjs";

/**
 * Two snapshots a "aged" workspace holds: `libs/app` present in both (age 2),
 * `libs/ring` present only in the head (age 1). The suppression lives in
 * `libs/app/policy-violation.go`; the drift finding lives in project `app`.
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
          projects: [
            { name: "app", root: "libs/app", tags: [] },
            { name: "ring", root: "libs/ring", tags: [] },
          ],
          dependencies: [{ source: "app", target: "ring", type: "static" }],
        },
      },
      id: "b",
    },
  ],
};

const singleSnapshot = {
  files: [
    {
      name: "0001-a.json",
      envelope: { result: { projects: [{ name: "app", root: "libs/app", tags: [] }] } },
      id: "a",
    },
  ],
};

describe("computeDebtLedger", () => {
  it("ages a waiver-owning project from the first snapshot it was observed", () => {
    const ledger = computeDebtLedger(
      { suppressions: [{ path: "libs/app/policy-violation.go", reason: "legacy" }] },
      aged,
      { referenceTime: "2026-08-16T00:00:00Z" },
    );
    expect(ledger.agings).toBe(true);
    expect(ledger.total).toBe(1);
    const waiver = ledger.entries[0];
    expect(waiver.kind).toBe("waiver");
    expect(waiver.age).toBe(2);
    expect(ledger.sampleTime).toBe("2026-08-16T00:00:00.000Z");
  });

  it("books an expired waiver as a medium expired-waiver, never a low still-suppressed row (F06)", () => {
    const ledger = computeDebtLedger(
      {
        suppressions: [
          {
            path: "libs/app/policy-violation.go",
            reason: "was true",
            expiresAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
      aged,
      { referenceTime: "2026-08-16T00:00:00Z" },
    );
    const entry = ledger.entries[0];
    expect(entry.kind).toBe("expired-waiver");
    expect(entry.severity).toBe("medium");
    expect(entry.remediationHint).toContain("expired");
    expect(entry.remediationHint).toContain("live again");
    // The same fate the gate applies — an expired waiver covers nothing.
    expect(ledger.bySeverity.medium).toBe(1);
    expect(ledger.bySeverity.low).toBe(0);
    // `byKind` must count `"expired-waiver"` under its own key — an aggregate
    // that only ever seeded `waiver`/`aspirational-gap`/`drift`/`unresolved`
    // reads `byKind["expired-waiver"]` as `undefined`, and `undefined + 1` is
    // `NaN` — which serializes to JSON `null`, not a number a caller can sum.
    // The sum-to-total check is the tripwire: a silently-uncounted kind still
    // shows up in `entries`/`total`, so only the per-kind aggregate would lie.
    expect(ledger.byKind["expired-waiver"]).toBe(1);
    const sumOfKinds = Object.values(ledger.byKind).reduce((a, b) => a + b, 0);
    expect(sumOfKinds).toBe(ledger.total);
  });

  it("keeps a still-active waiver low — the F06 complement", () => {
    const ledger = computeDebtLedger(
      {
        suppressions: [
          {
            path: "libs/app/policy-violation.go",
            reason: "still true",
            expiresAt: "2099-01-01T00:00:00Z",
          },
        ],
      },
      aged,
      { referenceTime: "2026-08-16T00:00:00Z" },
    );
    const entry = ledger.entries[0];
    expect(entry.kind).toBe("waiver");
    expect(entry.severity).toBe("low");
  });

  it("ages a waiver that only ever sat in the head snapshot at youth", () => {
    const ledger = computeDebtLedger(
      { suppressions: [{ path: "libs/ring/nested.go", reason: "legacy" }] },
      aged,
      { referenceTime: "2026-08-16T00:00:00Z" },
    );
    expect(ledger.entries[0].age).toBe(1);
  });

  it("classifies a drift finding in the same project as a waiver as high", () => {
    const ledger = computeDebtLedger(
      {
        suppressions: [{ path: "libs/app/policy-violation.go", reason: "legacy" }],
        findings: [
          {
            source: "app",
            target: "ring",
            rule: "dependencyForbidden",
            message: "app → ring forbidden",
          },
        ],
      },
      aged,
      { referenceTime: "2026-08-16T00:00:00Z" },
    );
    const drift = ledger.entries.find((e) => e.kind === "drift");
    const waiver = ledger.entries.find((e) => e.kind === "waiver");
    // The ledger carries BOTH — a waiver that returns to FAIL is never hidden.
    expect(waiver).toBeDefined();
    expect(drift.severity).toBe("high");
    expect(drift.age).toBe(2);
    expect(ledger.bySeverity.high).toBe(1);
  });

  it("ranks an unrelated drift finding medium", () => {
    const ledger = computeDebtLedger(
      {
        suppressions: [{ path: "packages/other/thing.go", reason: "legacy" }],
        findings: [
          { source: "app", target: "ring", rule: "dependencyForbidden", message: "app → ring" },
        ],
      },
      aged,
      { referenceTime: "2026-08-16T00:00:00Z" },
    );
    expect(ledger.entries.find((e) => e.kind === "drift").severity).toBe("medium");
  });

  it("marks an unresolved intent unknown and counts aggregate by severity faithfully", () => {
    const ledger = computeDebtLedger(
      { unresolved: [{ boundary: "packages", issue: "matches nothing" }] },
      aged,
      { referenceTime: "2026-08-16T00:00:00Z" },
    );
    expect(ledger.entries[0].severity).toBe("unknown");
    expect(ledger.bySeverity).toEqual({ high: 0, medium: 0, low: 0 });
    expect(ledger.byKind.unresolved).toBe(1);
  });

  it("makes the aspirational gap a low entry and identifies the owning project for waivers", () => {
    const ledger = computeDebtLedger(
      {
        suppressions: [{ path: "packages/shared/internal.go", reason: "decided" }],
        intentNotes: ["optional allowed intent from → to is not yet observed — aspirational"],
      },
      aged,
      { referenceTime: "2026-08-16T00:00:00Z" },
    );
    expect(ledger.byKind["aspirational-gap"]).toBe(1);
    const gap = ledger.entries.find((e) => e.kind === "aspirational-gap");
    expect(gap.severity).toBe("low");
    // A suppression inside `packages/shared` maps to no head project with root
    // `libs/app`/`libs/ring` — so its age honesty reads 0, not a false age.
    const waiver = ledger.entries.find((e) => e.kind === "waiver");
    expect(waiver.age).toBe(0);
  });

  it("returns an empty ledger and clean aggregates for a debt-free workspace", () => {
    const ledger = computeDebtLedger(
      { suppressions: [], intentNotes: [], findings: [], unresolved: [] },
      aged,
      { referenceTime: "2026-08-16T00:00:00Z" },
    );
    expect(ledger.total).toBe(0);
    expect(ledger.entries).toEqual([]);
    expect(ledger.byKind).toEqual({
      waiver: 0,
      "expired-waiver": 0,
      "aspirational-gap": 0,
      drift: 0,
      unresolved: 0,
    });
    expect(ledger.bySeverity).toEqual({ high: 0, medium: 0, low: 0 });
  });

  it("reports all ages at 0 when the directory has fewer than two snapshots", () => {
    const ledger = computeDebtLedger(
      { suppressions: [{ path: "libs/app/v.go", reason: "legacy" }] },
      singleSnapshot,
      { referenceTime: "2026-08-16T00:00:00Z" },
    );
    expect(ledger.agings).toBe(false);
    expect(ledger.entries[0].age).toBe(0);
  });

  it("is deterministic: two runs over identical inputs produce byte-identical ledgers", () => {
    const input = {
      suppressions: [{ path: "libs/app/v.go", reason: "r" }],
      intentNotes: ["gap"],
      findings: [{ source: "app", target: "ring", rule: "dependencyForbidden", message: "m" }],
      unresolved: [{ boundary: "packages", issue: "x" }],
    };
    const a = computeDebtLedger(input, aged, { referenceTime: "2026-08-16T00:00:00Z" });
    const b = computeDebtLedger(input, aged, { referenceTime: "2026-08-16T00:00:00Z" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("sorts entries by kind then source, never localeCompare", () => {
    const ledger = computeDebtLedger(
      {
        suppressions: [
          { path: "libs/ring/z.go", reason: "r" },
          { path: "libs/app/a.go", reason: "r" },
        ],
        intentNotes: ["gap"],
      },
      aged,
      { referenceTime: "2026-08-16T00:00:00Z" },
    );
    expect(ledger.entries.map((e) => e.source)).toEqual(["gap", "libs/app/a.go", "libs/ring/z.go"]);
  });
});
