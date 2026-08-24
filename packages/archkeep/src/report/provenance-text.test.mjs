import { describe, expect, it } from "vitest";

import { formatProvenanceReport } from "./provenance-text.mjs";

describe("formatProvenanceReport", () => {
  it("names the commit and remote when repo provenance is established", () => {
    const text = formatProvenanceReport({
      establishment: true,
      repo: { commit: "abc1234", remote: "https://example.invalid/repo.git", dirty: false },
      rowsTotal: 2,
      unattested: [],
      decisionRefTotal: 0,
      unresolvedDecisionRefs: [],
    });
    expect(text).toContain("repo      abc1234");
    expect(text).toContain("— https://example.invalid/repo.git");
    expect(text).not.toContain("(dirty)");
  });

  it("flags a dirty tree", () => {
    const text = formatProvenanceReport({
      establishment: true,
      repo: { commit: "abc1234", remote: null, dirty: true },
      rowsTotal: 1,
      unattested: [],
      decisionRefTotal: 0,
      unresolvedDecisionRefs: [],
    });
    expect(text).toContain("abc1234 (dirty)");
  });

  it("says provenance is unavailable rather than printing a commit that does not exist", () => {
    const text = formatProvenanceReport({
      establishment: false,
      repo: null,
      rowsTotal: 1,
      unattested: [],
      decisionRefTotal: 0,
      unresolvedDecisionRefs: [],
    });
    expect(text).toContain(
      "repo      provenance unavailable — not a git repository or git not installed",
    );
  });

  it("claims every row carries an origin only when unattested is empty", () => {
    const text = formatProvenanceReport({
      establishment: true,
      repo: { commit: "abc1234", remote: null, dirty: false },
      rowsTotal: 1,
      unattested: [],
      decisionRefTotal: 0,
      unresolvedDecisionRefs: [],
    });
    expect(text).toContain("✔ every governance row carries an origin");
    expect(text).not.toContain("unattested");
  });

  it("lists every unattested row and states the count with no decision behind it", () => {
    const text = formatProvenanceReport({
      establishment: true,
      repo: { commit: "abc1234", remote: null, dirty: false },
      rowsTotal: 2,
      unattested: [
        { kind: "forbidden[0]", label: "forbidden[0] packages→extensions", note: "no origin" },
      ],
      decisionRefTotal: 0,
      unresolvedDecisionRefs: [],
    });
    expect(text).toContain("1 without");
    expect(text).toContain("unattested (no origin recorded — cannot attest):");
    expect(text).toContain("  forbidden[0]");
    expect(text).toContain("1 of them carry no decision behind the rule");
  });

  it("renders no decisionRef section at all when no row cites one", () => {
    const text = formatProvenanceReport({
      establishment: true,
      repo: { commit: "abc1234", remote: null, dirty: false },
      rowsTotal: 1,
      unattested: [],
      decisionRefTotal: 0,
      unresolvedDecisionRefs: [],
    });
    expect(text).not.toContain("decisionRef");
  });

  // The regression this section exists to guard: a workspace where every row
  // that cites a decisionRef resolves must state that positively, never stay
  // silent the way an empty `unresolvedDecisionRefs` array alone would read.
  it("states every decisionRef citation resolves when none are unresolved", () => {
    const text = formatProvenanceReport({
      establishment: true,
      repo: { commit: "abc1234", remote: null, dirty: false },
      rowsTotal: 2,
      unattested: [],
      decisionRefTotal: 2,
      unresolvedDecisionRefs: [],
    });
    expect(text).toContain("✔ every decisionRef citation (2) resolves to a known ADR");
    expect(text).not.toContain("unresolved decisionRefs");
  });

  it("lists every unresolved decisionRef and states the count against the total cited", () => {
    const text = formatProvenanceReport({
      establishment: true,
      repo: { commit: "abc1234", remote: null, dirty: false },
      rowsTotal: 2,
      unattested: [],
      decisionRefTotal: 2,
      unresolvedDecisionRefs: [
        {
          kind: "depConstraints[0]",
          label: "depConstraints[0]",
          decisionRef: "0999-ghost",
          note: '"0999-ghost" does not resolve — no matching ADR, rule, or fitness record',
        },
      ],
    });
    expect(text).toContain("unresolved decisionRefs (cite no known ADR, rule, or fitness record):");
    expect(text).toContain('  depConstraints[0] — "0999-ghost"');
    expect(text).toContain("1 of 2 decisionRef citations do not resolve");
  });

  it("produces byte-identical output for the same facts across calls", () => {
    const input = {
      establishment: true,
      repo: { commit: "abc1234", remote: "https://example.invalid/repo.git", dirty: false },
      rowsTotal: 3,
      unattested: [{ kind: "depConstraints[0]", label: "depConstraints[0]", note: "no origin" }],
      decisionRefTotal: 1,
      unresolvedDecisionRefs: [],
    };
    expect(formatProvenanceReport(input)).toBe(formatProvenanceReport(input));
  });
});
