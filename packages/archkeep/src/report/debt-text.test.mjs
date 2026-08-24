import { describe, expect, it } from "vitest";

import { formatDebtReport } from "./debt-text.mjs";

// The renderer is a pure function of the ledger and coverage, so every branch
// is pinned by feeding it shaped inputs directly — the same contract
// `history-text.mjs`'s tests follow for `formatHistoryReport`.

const coverage = { complete: true, projects: 2, analyzedFiles: 4, imports: 3 };

/** A minimal ledger in the shape `computeDebtLedger` produces. */
function ledger(overrides = {}) {
  return {
    dir: "/ws/hist",
    snapshots: 2,
    agings: true,
    sampleTime: "2026-08-16T00:00:00.000Z",
    entries: [],
    total: 0,
    byKind: { waiver: 0, "aspirational-gap": 0, drift: 0, unresolved: 0 },
    bySeverity: { high: 0, medium: 0, low: 0 },
    ...overrides,
  };
}

const waiverEntry = (overrides = {}) => ({
  source: "libs/app/violation.go",
  kind: "waiver",
  severity: "low",
  age: 2,
  count: 1,
  remediationHint: "the accepted violation at 'libs/app/violation.go' is still suppressed",
  ...overrides,
});

describe("formatDebtReport", () => {
  it("states the directory, counts, and the aging basis in the header", () => {
    const text = formatDebtReport({ ledger: ledger(), coverage });
    expect(text).toContain("debt  /ws/hist");
    expect(text).toContain("0 entries across 2 snapshots — a snapshot-relative ledger");
  });

  it("says when the ages are not yet established", () => {
    const text = formatDebtReport({
      ledger: ledger({
        snapshots: 1,
        agings: false,
        entries: [waiverEntry({ age: 0 })],
        total: 1,
        byKind: { waiver: 1, "aspirational-gap": 0, drift: 0, unresolved: 0 },
      }),
      coverage,
    });
    expect(text).toContain(
      "1 entry across 1 snapshot — ages not yet established (fewer than two snapshots)",
    );
    expect(text).toContain("age not yet established");
  });

  it("lists each entry under its kind section with age and count", () => {
    const text = formatDebtReport({
      ledger: ledger({
        entries: [waiverEntry()],
        total: 1,
        byKind: { waiver: 1, "aspirational-gap": 0, drift: 0, unresolved: 0 },
        bySeverity: { high: 0, medium: 0, low: 1 },
      }),
      coverage,
    });
    expect(text).toContain("1 waivers (accepted boundary violations):");
    expect(text).toContain("[waiver] low  libs/app/violation.go  (age 2, count 1)");
    expect(text).toContain("the accepted violation at 'libs/app/violation.go' is still suppressed");
  });

  it("prints a positive no-debt claim for an empty ledger, never a bare zero", () => {
    const text = formatDebtReport({ ledger: ledger(), coverage });
    expect(text).toContain(
      "✔ no architecture debt — no waivers, aspirational gaps, drift or unresolved intent",
    );
  });

  it("prints the aggregates even when empty, so a missing section is visible", () => {
    const text = formatDebtReport({ ledger: ledger(), coverage });
    expect(text).toContain("byKind: waiver 0, aspirational-gap 0, drift 0, unresolved 0");
    expect(text).toContain("bySeverity: high 0, medium 0, low 0");
    expect(text).toContain("sampled 2026-08-16T00:00:00.000Z");
  });

  it("states what the ledger is a claim about in the coverage line", () => {
    const text = formatDebtReport({ ledger: ledger(), coverage });
    expect(text).toContain("✔ complete (3 imports in 4 files across 2 projects)");
  });

  it("neutralises control and escape sequences in rendered sources", () => {
    const text = formatDebtReport({
      ledger: ledger({
        entries: [
          waiverEntry({
            source: "libs/esc[31mred[0m/violation.go",
            remediationHint: "hint with  bell",
          }),
          {
            source: "an unresolved boundary",
            kind: "unresolved",
            severity: "unknown",
            age: 0,
            count: 1,
            remediationHint: "an intent boundary matched no observed project",
          },
        ],
        total: 2,
        byKind: { waiver: 1, "aspirational-gap": 0, drift: 0, unresolved: 1 },
        bySeverity: { high: 0, medium: 0, low: 1 },
      }),
      coverage,
    });
    // No raw ESC byte may reach the output — not even a control character.
    expect(text).not.toContain("");
    expect(text).not.toContain("");
    expect(text).toContain("libs/esc\\x1b[31mred\\x1b[0m/violation.go");
    expect(text).toContain("hint with \\x07 bell");
  });

  it("renders an unknown-severity unresolved entry as its own kind section", () => {
    const text = formatDebtReport({
      ledger: ledger({
        entries: [
          {
            source: "an unresolved boundary",
            kind: "unresolved",
            severity: "unknown",
            age: 0,
            count: 1,
            remediationHint:
              "an intent boundary matched no observed project — the intent cannot be verified",
          },
        ],
        total: 1,
        byKind: { waiver: 0, "aspirational-gap": 0, drift: 0, unresolved: 1 },
      }),
      coverage,
    });
    expect(text).toContain("1 unresolved intent:");
    expect(text).toContain("[unresolved] unknown  an unresolved boundary");
  });
});
