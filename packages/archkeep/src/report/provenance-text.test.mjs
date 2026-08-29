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

describe("formatProvenanceReport — the decision lifecycle section (PR E)", () => {
  const decision = (overrides = {}) => ({
    id: "0001-bind-collaboration",
    status: "active",
    authority: true,
    created: null,
    updated: null,
    supersedes: [],
    supersededBy: [],
    bindings: [],
    attribution: {
      createdBy: { by: "Tess <tess@example.com>", tool: "git", on: "2026-01-02T00:00:00.000Z" },
      lastChangedBy: { by: "Rex <rex@example.com>", tool: "git", on: "2026-08-16T00:00:00.000Z" },
    },
    attested: true,
    note: null,
    ...overrides,
  });
  const base = {
    establishment: true,
    repo: { commit: "abc1234", remote: null, dirty: false },
    rowsTotal: 1,
    unattested: [],
    decisionRefTotal: 0,
    unresolvedDecisionRefs: [],
  };

  it("renders the attributed lifecycle with created/last-change and the positive claim", () => {
    const text = formatProvenanceReport({
      ...base,
      decisionLifecycle: [
        decision({
          created: "2026-01-15",
          updated: "2026-08-01",
          bindings: ["type-package"],
        }),
      ],
    });
    expect(text).toContain("decisions  1 recorded — 1 attributed, 0 without attribution");
    expect(text).toContain(
      "  active      0001-bind-collaboration  created by Tess <tess@example.com> on 2026-01-02T00:00:00.000Z; changed by Rex <rex@example.com> on 2026-08-16T00:00:00.000Z; binds type-package; timeline 2026-01-15 → 2026-08-01",
    );
    expect(text).toContain(
      "✔ every decision's lifecycle is attributed — each change names who recorded it and with what tool",
    );
  });

  it("lists every unattributed decision and states the count — never a silent pass", () => {
    const text = formatProvenanceReport({
      ...base,
      decisionLifecycle: [
        decision({
          id: "0001-bind-collaboration",
          attribution: { createdBy: null, lastChangedBy: null },
          attested: false,
          note: "no origin recorded — cannot attest",
        }),
        decision({
          id: "0002-scopes",
          attribution: { createdBy: null, lastChangedBy: null },
          attested: false,
          note: "no origin recorded — cannot attest",
        }),
      ],
    });
    expect(text).toContain("decisions  2 recorded — 0 attributed, 2 without attribution");
    expect(text).toContain("unattributed lifecycle (no origin recorded — cannot attest):");
    expect(text).toContain("  0001-bind-collaboration");
    expect(text).toContain("  0002-scopes");
    expect(text).toContain("2 of them carry no recorded origin behind their lifecycle");
    expect(text).not.toContain("✔ every decision's lifecycle is attributed");
  });

  it("renders supersession lineage in both directions — attributed via the superseder's recorder", () => {
    const text = formatProvenanceReport({
      ...base,
      decisionLifecycle: [
        decision({
          id: "0002-scopes",
          supersedes: ["0003-rename-lattice"],
        }),
        decision({
          id: "0003-rename-lattice",
          status: "superseded",
          authority: false,
          supersededBy: ["0002-scopes"],
        }),
      ],
    });
    expect(text).toContain("supersedes 0003-rename-lattice");
    expect(text).toContain("superseded by 0002-scopes");
  });

  it("renders a per-fact cannot-attest when one fact lacks an origin but the record is otherwise attributed", () => {
    const text = formatProvenanceReport({
      ...base,
      decisionLifecycle: [
        decision({
          attribution: {
            createdBy: null,
            lastChangedBy: {
              by: "Rex <rex@example.com>",
              tool: "git",
              on: "2026-08-16T00:00:00.000Z",
            },
          },
        }),
      ],
    });
    expect(text).toContain("created — no origin recorded — cannot attest");
    expect(text).toContain("changed by Rex <rex@example.com> on 2026-08-16T00:00:00.000Z");
  });

  it("renders no decision section at all when decisionLifecycle is empty or omitted", () => {
    const empty = formatProvenanceReport({ ...base, decisionLifecycle: [] });
    const omitted = formatProvenanceReport(base);
    for (const text of [empty, omitted]) {
      expect(text).not.toContain("decisions");
      expect(text).not.toContain("cannot attest");
    }
  });

  it("produces byte-identical output for the same decision facts across calls", () => {
    const input = {
      ...base,
      decisionLifecycle: [
        decision({
          created: "2026-01-15",
          supersedes: ["0003-rename-lattice"],
          bindings: ["type-package"],
        }),
      ],
    };
    expect(formatProvenanceReport(input)).toBe(formatProvenanceReport(input));
  });
});
