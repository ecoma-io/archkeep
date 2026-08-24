import { describe, expect, it } from "vitest";

import { formatDeltaReport } from "./delta-text.mjs";

/**
 * What the delta report guarantees: every bucket the command computed is
 * rendered — introduced with its waived annotation, resolved, unchanged with
 * the occurrences-reduced note, unknown with its reason, and the
 * unresolvable block — and the closing line always states what was compared,
 * so an empty delta is a verifiable claim rather than silence
 * (`../../../../AGENTS.md`). The renderer decides nothing: it draws exactly
 * the payload it is handed.
 */

// ---------------------------------------------------------------------------
// Fixtures — invented names throughout.
// ---------------------------------------------------------------------------

const EMPTY_BUCKETS = { introduced: [], resolved: [], unchanged: [], unknown: [] };

function entry(overrides = {}) {
  return {
    classification: "introduced",
    messageId: "onlyTagsConstraintViolation",
    sourceProject: "acme-alpha",
    target: "acme-beta",
    targetIsSpecifier: false,
    constraint: null,
    baseCount: 0,
    headCount: 1,
    baseSites: [],
    headSites: [{ file: "libs/alpha/src/service.go", line: 5, column: 2 }],
    waived: false,
    ...overrides,
  };
}

function payload(overrides = {}) {
  const summary = {
    introduced: 0,
    introducedWaived: 0,
    resolved: 0,
    unchanged: 0,
    unknown: 0,
    unresolvable: { introduced: 0, resolved: 0, unchanged: 0, unknown: 0 },
    ...(overrides.summary ?? {}),
  };
  return {
    delta: {
      baseline: {
        path: "/invented/base.json",
        provenance: {
          commit: "0123456789abcdef0123456789abcdef01234567",
          remote: null,
          dirty: false,
        },
        records: 3,
        projects: 2,
        ...(overrides.baseline ?? {}),
      },
      head: {
        provenance: null,
        records: 4,
        projects: 2,
        ...(overrides.head ?? {}),
      },
      summary,
      violations: { ...EMPTY_BUCKETS, ...(overrides.violations ?? {}) },
      unresolvable: { ...EMPTY_BUCKETS, ...(overrides.unresolvable ?? {}) },
    },
    coverage: {
      analyzedFiles: 4,
      projects: 2,
      notes: overrides.notes ?? [],
    },
  };
}

describe("formatDeltaReport", () => {
  it("states both sides' identity, and an absent provenance as an honest unverified origin", () => {
    const report = formatDeltaReport(payload());
    expect(report).toContain("baseline  /invented/base.json — 01234567, 3 records, 2 projects");
    expect(report).toContain("head      unverified origin, 4 records, 2 projects");
  });

  it("closes an empty delta with the claim of what was compared, never silence", () => {
    const report = formatDeltaReport(payload());
    expect(report).toContain(
      "✔ no introduced violations — compared baseline 01234567 (3 records) against head " +
        "unverified origin (4 records, 4 analyzed files, 2 projects)",
    );
  });

  it("renders an introduced entry with its counts, site, and waived annotation", () => {
    const report = formatDeltaReport(
      payload({
        summary: { introduced: 2, introducedWaived: 1 },
        violations: {
          introduced: [
            entry({ reason: "absent at base" }),
            entry({
              target: "acme-gamma",
              waived: true,
              headSites: [{ file: "libs/alpha/src/other.go", line: 9, column: 1 }],
            }),
          ],
        },
      }),
    );
    expect(report).toContain("⚠ 2 introduced violations (1 waived — reported, not gating)");
    expect(report).toContain(
      "  acme-alpha → acme-beta  onlyTagsConstraintViolation  (0 at base, 1 at head)",
    );
    expect(report).toContain("    at libs/alpha/src/service.go:5:2");
    expect(report).toContain(
      "  acme-alpha → acme-gamma  onlyTagsConstraintViolation  (0 at base, 1 at head)  [waived]",
    );
    expect(report).toContain("1 introduced violations not waived — compared baseline");
  });

  it("renders a resolved entry from its last-known base sites", () => {
    const report = formatDeltaReport(
      payload({
        summary: { resolved: 1 },
        violations: {
          resolved: [
            entry({
              classification: "resolved",
              baseCount: 1,
              headCount: 0,
              baseSites: [{ file: "libs/alpha/src/legacy.go", line: 12, column: 3 }],
              headSites: [],
            }),
          ],
        },
      }),
    );
    expect(report).toContain("✔ 1 resolved violation");
    expect(report).toContain("    at libs/alpha/src/legacy.go:12:3");
  });

  it("renders the occurrences-reduced note on an unchanged entry — a shrink is not a resolution", () => {
    const report = formatDeltaReport(
      payload({
        summary: { unchanged: 1 },
        violations: {
          unchanged: [
            entry({
              classification: "unchanged",
              baseCount: 2,
              headCount: 1,
              note: "occurrencesReduced: 2 at base, 1 at head — the violation still exists",
            }),
          ],
        },
      }),
    );
    expect(report).toContain("= 1 unchanged violation");
    expect(report).toContain("occurrencesReduced: 2 at base, 1 at head");
  });

  it("renders every unknown item's reason — the load-bearing half of a refusal to guess", () => {
    const report = formatDeltaReport(
      payload({
        summary: { unknown: 1 },
        violations: {
          unknown: [
            {
              classification: "unknown",
              reason: "violation carries no usable messageId — got null",
            },
          ],
        },
      }),
    );
    expect(report).toContain("? 1 unclassifiable item");
    expect(report).toContain("? violation carries no usable messageId — got null");
  });

  it("renders the unresolvable block as its own carried category", () => {
    const report = formatDeltaReport(
      payload({
        summary: { unresolvable: { introduced: 1, resolved: 0, unchanged: 0, unknown: 0 } },
        unresolvable: {
          introduced: [
            {
              classification: "introduced",
              specifier: "@acme/phantom",
              kind: "dynamic",
              sourceProject: "acme-alpha",
              baseCount: 0,
              headCount: 1,
              baseSites: [],
              headSites: [{ file: "libs/alpha/src/loader.ts", line: 4, column: 1 }],
            },
          ],
        },
      }),
    );
    expect(report).toContain("unresolvable imports (carried, never counted as violations");
    expect(report).toContain("  + 1 introduced");
    expect(report).toContain("  acme-alpha ⇢ @acme/phantom  (dynamic; 0 at base, 1 at head)");
    expect(report).toContain("    at libs/alpha/src/loader.ts:4:1");
  });

  it("omits every empty section rather than rendering a zero row", () => {
    const report = formatDeltaReport(payload());
    expect(report).not.toContain("introduced violations\n");
    expect(report).not.toContain("resolved violation");
    expect(report).not.toContain("unchanged violation");
    expect(report).not.toContain("unresolvable imports");
  });

  it("folds the command's notes in as their own loud lines", () => {
    const report = formatDeltaReport(
      payload({
        notes: ["the boundary law changed since capture (baseline aaaaaaaa…, current bbbbbbbb…)"],
      }),
    );
    expect(report).toContain("⚠ the boundary law changed since capture");
  });

  it("marks a dirty side in its identity", () => {
    const report = formatDeltaReport(
      payload({
        head: {
          provenance: {
            commit: "89abcdef0123456789abcdef0123456789abcdef",
            remote: null,
            dirty: true,
          },
          records: 4,
          projects: 2,
        },
      }),
    );
    expect(report).toContain("head      89abcdef, dirty, 4 records, 2 projects");
  });
});
