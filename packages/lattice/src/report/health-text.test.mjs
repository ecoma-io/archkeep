import { describe, expect, it } from "vitest";

import { formatHealthReport } from "./health-text.mjs";

/** @typedef {import("../governance/metrics.mjs").Metric} Metric */

// The renderer is a pure function of `{metrics, trends, coverage}`, so every
// branch is pinned by feeding it shaped inputs directly — the same contract
// `history-text.mjs`'s tests follow. The two non-obvious rules under test:
//
// 1. Every metric renders as a `not_applicable`/`unknown`/`ok`/`findings`
//    verdict, the value appears ONLY when the metric measured something — a
//    `not_applicable` or `unknown` metric never carries a number, because a
//    number over no evidence would read as a measured zero.
// 2. The metric ORDER is fixed (decided here, not by object insertion): a
//    formatter that sorted or filtered would be a rule wearing a formatter's
//    name.

const coverage = {
  complete: true,
  projects: 2,
  analyzedFiles: 4,
  imports: 3,
  notAnalyzed: [],
  blindSpots: [],
  notes: [],
};

/** A fully-measured metric set: every verdict reached, none unknown. */
const cleanMetrics = () =>
  /** @type {Record<string, Metric>} */ ({
    projects: { verdict: "ok", value: 2 },
    edges: { verdict: "ok", value: 3 },
    coverage: { verdict: "ok", value: 0 },
    violations: { verdict: "ok", value: 0 },
    waiverSurface: { verdict: "ok", value: 1 },
    cycles: { verdict: "ok", value: 0 },
    edgeDensity: { verdict: "ok", value: 1.5 },
    debt: { verdict: "ok", value: 0 },
    fitness: { verdict: "ok", value: 0 },
  });

describe("formatHealthReport", () => {
  it("states the inspection scope and claim in the header", () => {
    const text = formatHealthReport({ metrics: cleanMetrics(), trends: null, coverage });
    expect(text).toContain("health over complete coverage");
    expect(text).toContain("3 imports in 4 files across 2 projects");
  });

  it("reports a partial run loudly — the incomplete- coverage line names the gap", () => {
    const text = formatHealthReport({
      metrics: cleanMetrics(),
      trends: null,
      coverage: {
        ...coverage,
        complete: false,
        notAnalyzed: [{ file: "apps/site/src/main.go", reason: "parse error" }],
      },
    });
    expect(text).toContain("incomplete coverage");
    expect(text).toContain("1 file could not be analyzed");
  });

  it("renders each metric as a verdict with the number only when measured", () => {
    const withGaps = cleanMetrics();
    withGaps.violations = /** @type {Metric} */ ({
      verdict: "unknown",
      note: "the boundary could not be fully inspected",
    });
    const text = formatHealthReport({ metrics: withGaps, trends: null, coverage });
    expect(text).toContain("violations");
    expect(text).toContain("unknown");
    // The unknown metric carries no number — a bare zero would read as clean.
    expect(text).not.toContain("unknown  0");
  });

  it("renders a measured number next to the verdict for ok/findings metrics", () => {
    const drifting = cleanMetrics();
    drifting.violations = { verdict: "findings", value: 3 };
    const text = formatHealthReport({ metrics: drifting, trends: null, coverage });
    expect(text).toContain("violations");
    expect(text).toContain("3");
  });

  it("renders the fixed metric order", () => {
    const text = formatHealthReport({ metrics: cleanMetrics(), trends: null, coverage });
    // The header also says "...across 2 projects", so index-based order is
    // compared only on the VERDICT LINES — every line after the header starts
    // with a two-space indent and a verdict word.
    const lines = text.split("\n").filter((l) => l.startsWith("  "));
    const names = [
      "projects",
      "edges",
      "coverage",
      "violations",
      "waiver surface",
      "cycles",
      "edge density",
      "debt rows",
      "intent fitness",
    ];
    expect(lines).toHaveLength(names.length);
    names.forEach((name, i) => {
      expect(lines[i]).toContain(name);
    });
  });

  it("renders a not_applicable metric with the reason it could not measure", () => {
    const withNa = cleanMetrics();
    withNa.fitness = /** @type {Metric} */ ({
      verdict: "not_applicable",
      note: "no architecture-intent.json; the workspace declared no intended architecture",
    });
    const text = formatHealthReport({ metrics: withNa, trends: null, coverage });
    expect(text).toContain("not_applicable");
    expect(text).toContain("no architecture-intent.json");
    expect(text).not.toMatch(/not_applicable\s+\d/);
  });

  it("lists each trend snapshot and the disclosure that rule-impact cannot be re-derived", () => {
    const trends = {
      snapshots: [
        { name: "0001-a.json", projects: 2, dependencies: 1 },
        { name: "0002-b.json", projects: 3, dependencies: 2 },
      ],
      notes: [
        "rule-impact metrics (violations, waivers, debt, fitness) cannot be re-derived from stored snapshots",
      ],
    };
    const text = formatHealthReport({ metrics: cleanMetrics(), trends, coverage });
    expect(text).toContain("trends  2 snapshots");
    expect(text).toContain("0001-a.json  2 projects, 1 edges");
    expect(text).toContain("0002-b.json  3 projects, 2 edges");
    expect(text).toContain("cannot be re-derived");
  });
});
