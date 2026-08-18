import { describe, expect, it } from "vitest";

import { formatProvenanceReport } from "./provenance-text.mjs";

describe("formatProvenanceReport", () => {
  it("names the commit and remote when repo provenance is established", () => {
    const text = formatProvenanceReport({
      establishment: true,
      repo: { commit: "abc1234", remote: "https://example.invalid/repo.git", dirty: false },
      rowsTotal: 2,
      unattested: [],
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
    });
    expect(text).toContain("abc1234 (dirty)");
  });

  it("says provenance is unavailable rather than printing a commit that does not exist", () => {
    const text = formatProvenanceReport({
      establishment: false,
      repo: null,
      rowsTotal: 1,
      unattested: [],
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
    });
    expect(text).toContain("1 without");
    expect(text).toContain("unattested (no origin recorded — cannot attest):");
    expect(text).toContain("  forbidden[0]");
    expect(text).toContain("1 of them carry no decision behind the rule");
  });

  it("produces byte-identical output for the same facts across calls", () => {
    const input = {
      establishment: true,
      repo: { commit: "abc1234", remote: "https://example.invalid/repo.git", dirty: false },
      rowsTotal: 3,
      unattested: [{ kind: "depConstraints[0]", label: "depConstraints[0]", note: "no origin" }],
    };
    expect(formatProvenanceReport(input)).toBe(formatProvenanceReport(input));
  });
});
