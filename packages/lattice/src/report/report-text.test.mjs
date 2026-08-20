import { describe, expect, it } from "vitest";

import { formatGovernanceReport } from "./report-text.mjs";

// The renderer is pure, so these tests hand it the shapes
// `../commands/report.mjs` builds and read the bytes back. What they pin is
// not the wording — that would be half a test — but the three rules the
// document must never break: an uninspectable surface is never rendered as a
// clean zero, `not_applicable` never reads like `ok`, and an unresolved
// citation never reads like a documented one.

/** Every metric measured and clean. */
const okMetrics = {
  projects: { verdict: "ok", value: 2 },
  edges: { verdict: "ok", value: 1 },
  coverage: { verdict: "ok", value: 0 },
  violations: { verdict: "ok", value: 0 },
  waiverSurface: { verdict: "ok", value: 0 },
  cycles: { verdict: "ok", value: 0 },
  edgeDensity: { verdict: "ok", value: 0.5 },
  debt: { verdict: "ok", value: 0 },
  fitness: { verdict: "ok", value: 0 },
};

const coverage = {
  complete: true,
  projects: 2,
  analyzedFiles: 4,
  imports: 3,
  notAnalyzed: [],
  blindSpots: [],
  notes: [],
};

const context = { root: "/workspace", provider: "native", marker: "lattice.json" };

/**
 * A whole input in the shape the command produces, with everything clean
 * unless a test overrides it.
 *
 * @param {object} [overrides]
 */
function input(overrides = {}) {
  return {
    coverage,
    metrics: okMetrics,
    trends: null,
    waivers: { verdict: "ok", note: null, counts: zeroCounts, rows: [] },
    fitness: {
      verdict: "not_applicable",
      note: "the boundary law declares no fitness functions",
      functions: [],
    },
    decisions: {
      verdict: "not_applicable",
      note: "no ADRs in docs/adr/ — the workspace records no decisions there",
      registry: { dir: "docs/adr", count: 0 },
      records: [],
      citations: [],
    },
    provenance: {
      repo: { commit: "abc1234", remote: "git@example.invalid:tree.git", dirty: false },
      established: true,
      policySource: "module-boundaries.config.mjs",
      rows: { total: 1, unattested: [] },
    },
    uninspectable: [],
    context,
    ...overrides,
  };
}

const zeroCounts = {
  waivers: 0,
  covered: 0,
  expired: 0,
  stale: 0,
  suppressions: 0,
  suppressed: 0,
};

describe("formatGovernanceReport — the headline states the document's own verdict", () => {
  it("says every surface reached a verdict when none is uninspectable", () => {
    const text = formatGovernanceReport(input());
    expect(text.split("\n")[0]).toBe(
      "architecture governance report — every surface reached a verdict",
    );
  });

  it("leads with NO VERDICT and counts the gaps when any surface could not be inspected", () => {
    const text = formatGovernanceReport(
      input({
        uninspectable: [
          { surface: "metric:violations", reason: "the boundary could not be fully inspected" },
          { surface: "waivers", reason: "lattice: waivers has incomplete coverage — 1 file" },
        ],
      }),
    );
    // The silent direction: a reader who stops after the first line must not
    // be able to read this document as a clean one.
    expect(text.split("\n")[0]).toBe(
      "architecture governance report — NO VERDICT: 2 surfaces could not be inspected",
    );
    expect(text).not.toContain("every surface reached a verdict");
    // And each gap is named again at the end, with its reason.
    expect(text).toContain("  metric:violations: the boundary could not be fully inspected");
    expect(text).toContain("  waivers: lattice: waivers has incomplete coverage — 1 file");
  });

  it("renders the closing block even when it is empty — the empty block IS the claim", () => {
    const text = formatGovernanceReport(input());
    expect(text).toContain("\ncould not inspect\n");
    expect(text).toContain("nothing — every surface in this report reached a verdict");
  });
});

describe("formatGovernanceReport — surfaces state what they could not do", () => {
  it("prints an unknown surface with its reason, and no count beside it", () => {
    const text = formatGovernanceReport(
      input({
        waivers: {
          verdict: "unknown",
          note: "lattice: waivers has incomplete coverage",
          counts: null,
          rows: [],
        },
        uninspectable: [{ surface: "waivers", reason: "lattice: waivers has incomplete coverage" }],
      }),
    );
    expect(text).toContain("  unknown         waivers  (lattice: waivers has incomplete coverage)");
    // A "0 waivers" line here would be the whole defect: it would read as
    // "nothing is waived" over a table the run never established.
    expect(text).not.toMatch(/0 waivers/u);
  });

  it("keeps not_applicable distinguishable from a pass", () => {
    const text = formatGovernanceReport(input());
    expect(text).toContain(
      "  not_applicable  fitness gates  (the boundary law declares no fitness functions)",
    );
    expect(text).not.toContain("pass            fitness gates");
  });

  it("names each waiver and each permanent suppression with what it covers", () => {
    const text = formatGovernanceReport(
      input({
        waivers: {
          verdict: "ok",
          note: null,
          counts: { ...zeroCounts, waivers: 1, expired: 1, suppressions: 1, suppressed: 2 },
          rows: [
            {
              kind: "waiver",
              path: "libs/alpha/**",
              status: "expired",
              covered: 1,
              reason: "scheduled for removal",
              expiresAt: "2026-01-01T00:00:00.000Z",
              decisionRef: "0001-layering",
            },
            {
              kind: "suppression",
              path: "libs/beta/**",
              status: "permanent",
              covered: 2,
              reason: null,
              expiresAt: null,
              decisionRef: null,
            },
          ],
        },
      }),
    );
    expect(text).toContain(
      "expired   libs/alpha/** until 2026-01-01T00:00:00.000Z — covers 1 violation  [0001-layering]",
    );
    expect(text).toContain("      reason: scheduled for removal");
    // A permanent suppression appears in no other report at all, so it must
    // never be dropped for having no term.
    expect(text).toContain("permanent libs/beta/** — covers 2 violations");
  });

  it("prints an unestablished origin as a stated absence", () => {
    const text = formatGovernanceReport(
      input({
        provenance: {
          repo: { commit: null, remote: null, dirty: null },
          established: false,
          policySource: null,
          rows: { total: 0, unattested: [] },
        },
      }),
    );
    expect(text).toContain("repo provenance unavailable — this report carries no origin claim");
    expect(text).toContain("policy      none declared — no boundary law governs this run");
    // Never a blank commit line a reader could skim past.
    expect(text).not.toMatch(/commit\s*$/mu);
  });
});

describe("formatGovernanceReport — decisions", () => {
  it("links a resolved citation to the record and its status", () => {
    const text = formatGovernanceReport(
      input({
        decisions: {
          verdict: "ok",
          note: null,
          registry: { dir: "docs/adr", count: 1 },
          records: [{ id: "0001-layering", status: "accepted", bindings: ["no-cycles"] }],
          citations: [
            {
              kind: "depConstraints[0]",
              label: "depConstraints[0] *",
              decisionRef: "0001-layering",
              resolution: "adr",
              adr: { id: "0001-layering", status: "accepted" },
            },
          ],
        },
      }),
    );
    expect(text).toContain("0001-layering  (accepted)  binds no-cycles");
    expect(text).toContain("adr       depConstraints[0] * → 0001-layering (accepted)");
  });

  it("renders an unresolved citation as unknown, never as a documented row", () => {
    const text = formatGovernanceReport(
      input({
        decisions: {
          verdict: "unknown",
          note: null,
          registry: { dir: "docs/adr", count: 1 },
          records: [{ id: "0001-layering", status: "accepted", bindings: [] }],
          citations: [
            {
              kind: "forbidden[0]",
              label: "forbidden[0] a→b",
              decisionRef: "0009-missing",
              resolution: "unknown",
              adr: null,
            },
          ],
        },
        uninspectable: [{ surface: "decisionRef:forbidden[0] a→b", reason: "does not resolve" }],
      }),
    );
    expect(text).toContain("unknown   forbidden[0] a→b → 0009-missing — does not resolve");
    expect(text).toContain("binds nothing — not yet enforceable");
  });

  it("says so when no governed row cites a decision at all", () => {
    const text = formatGovernanceReport(input());
    // Silence here would be indistinguishable from "every citation resolved".
    expect(text).toContain("no governed row cites a decisionRef");
  });

  it("marks a gate's ADR link unknown when the registry could not be read", () => {
    const text = formatGovernanceReport(
      input({
        fitness: {
          verdict: "pass",
          note: null,
          functions: [{ name: "cycle-free", verdict: "pass", message: "held", adrs: null }],
        },
      }),
    );
    // `null` is "could not look"; `[]` is "no decision binds it". Rendering
    // both as "no recorded decision" would collapse the two.
    expect(text).toContain("bound by: unknown — the decision registry could not be read");
  });
});

describe("formatGovernanceReport — determinism", () => {
  it("produces identical bytes for identical input", () => {
    expect(formatGovernanceReport(input())).toBe(formatGovernanceReport(input()));
  });

  it("renders trends in the order the command handed them over", () => {
    const text = formatGovernanceReport(
      input({
        trends: {
          snapshots: [
            { name: "0001-aaaaaaa.json", projects: 2, dependencies: 1 },
            { name: "0002-bbbbbbb.json", projects: 3, dependencies: 2 },
          ],
          notes: ["rule-impact metrics cannot be re-derived from stored snapshots"],
        },
      }),
    );
    const first = text.indexOf("0001-aaaaaaa.json");
    const second = text.indexOf("0002-bbbbbbb.json");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(text).toContain("  2 snapshots");
    expect(text).toContain("rule-impact metrics cannot be re-derived");
  });
});
