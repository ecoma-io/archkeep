import { describe, expect, it } from "vitest";

import { formatDriftReport } from "./drift-text.mjs";

const intent = { fingerprint: "a".repeat(64), rows: 3 };
const observed = { projects: 2, edges: 1, implicitEdges: 0 };

/** A finding in the shape `judgeIntent` returns — `rule` is the verdict verb. */
const finding = (overrides) => ({
  rule: "dependencyForbidden",
  message: "the intent forbids the dependency app → db",
  source: "app",
  target: "db",
  boundaryFrom: null,
  boundaryTo: null,
  ...overrides,
});

describe("formatDriftReport", () => {
  it("states the comparison facts even when clean — 'no drift' is a claim about coverage", () => {
    const text = formatDriftReport({ findings: [], intent, observed });
    expect(text).toContain(`intent    ${"a".repeat(64)} — 3 rows`);
    expect(text).toContain("observed  2 projects, 1 edge");
    expect(text).toContain("✔ no drift — the observed architecture matches the intended one");
  });

  it("states how many implicit edges were excluded from the verdict", () => {
    const text = formatDriftReport({
      findings: [],
      intent,
      observed: { projects: 2, edges: 1, implicitEdges: 2 },
    });
    expect(text).toContain("1 edge (2 implicit edges excluded)");
    expect(text).toContain("2 implicit excluded");
  });

  it("groups findings by rule in taxonomy order, each under a named heading", () => {
    const text = formatDriftReport({
      findings: [
        finding({ rule: "dependencyForbidden", source: "app", target: "db" }),
        finding({
          rule: "projectMissing",
          source: null,
          target: null,
          message:
            'the intent requires project "domain" to exist, but the observed architecture has no project of that name',
        }),
      ],
      intent,
      observed,
    });
    const projectIndex = text.indexOf("projects the intent requires are missing");
    const dependencyIndex = text.indexOf("dependencies the intent forbids exist");
    // projectMissing prints before dependencyForbidden in the taxonomy.
    expect(projectIndex).toBeLessThan(dependencyIndex);
    expect(text).toContain("⚠ 1 finding: projects the intent requires are missing");
    expect(text).toContain('the intent requires project "domain" to exist');
    expect(text).toContain("  app → db");
    expect(text).toContain("2 drift findings (2 projects and 1 edge)");
  });

  it("renders a projectTagMissing finding by its message", () => {
    const text = formatDriftReport({
      findings: [
        finding({
          rule: "projectTagMissing",
          source: null,
          target: null,
          message:
            'architecture-intent.json requires project "app" to carry tag "layer:domain", but it does not',
        }),
      ],
      intent,
      observed,
    });
    expect(text).toContain('"layer:domain"');
    expect(text).toContain("required projects lack required tags");
  });

  it("produces byte-identical output for the same facts across calls", () => {
    const first = formatDriftReport({ findings: [finding()], intent, observed });
    const second = formatDriftReport({ findings: [finding()], intent, observed });
    expect(first).toBe(second);
  });

  // Bug B: `judgeIntent`'s `verdict.notes` (e.g. an `optional: true` allowed
  // row the team has not built yet, `../architecture-intent/judge.mjs`) used
  // to have nowhere to go in this report — this formatter never read a
  // `notes` field at all, so a workspace using that axis got a clean-looking
  // "no drift" line with no trace of the note. Matches how `check`'s text
  // face folds its own `notes` into its "inspected" line.
  it("folds notes into the observed line, the way check's text face folds its own notes", () => {
    const text = formatDriftReport({
      findings: [],
      intent,
      observed,
      notes: ['allowed row app → optional-db is "optional" and not yet observed'],
    });
    expect(text).toContain(
      'observed  2 projects, 1 edge; allowed row app → optional-db is "optional" and not yet observed',
    );
    expect(text).toContain("✔ no drift");
  });

  it("folds multiple notes onto the same line, semicolon-joined", () => {
    const text = formatDriftReport({
      findings: [],
      intent,
      observed,
      notes: ["note one", "note two"],
    });
    expect(text).toContain("observed  2 projects, 1 edge; note one; note two");
  });
});

// P1-02: a row's decisionRef used to reach every report unverified. This
// section names an unresolved citation without turning it into a drift
// finding — a documentation fact about the row, not about the architecture.
describe("formatDriftReport — unresolved decisionRefs (P1-02)", () => {
  it("says nothing when no row carries a decisionRef — 'no fact, no claim'", () => {
    const text = formatDriftReport({ findings: [], intent, observed });
    expect(text).not.toContain("decisionRef");
  });

  it("says nothing when the caller passes an empty list explicitly and never states decisionRefsChecked", () => {
    const text = formatDriftReport({ findings: [], intent, observed, unresolvedDecisionRefs: [] });
    expect(text).not.toContain("decisionRef");
  });

  it("states a positive line when the axis was checked and every citation resolves — never silent success", () => {
    // The same "no fact, no claim" split `formatGoWork` makes: an axis that
    // was exercised and found clean gets a stated line, not silence — silence
    // is reserved for a workspace that never used the field at all.
    const text = formatDriftReport({
      findings: [],
      intent,
      observed,
      unresolvedDecisionRefs: [],
      decisionRefsChecked: 2,
    });
    expect(text).toContain(
      "✔ every decisionRef citation (2) resolves to a known ADR, rule, or fitness record",
    );
  });

  it("names the row and the unresolvable citation, after the drift verdict", () => {
    const text = formatDriftReport({
      findings: [],
      intent,
      observed,
      unresolvedDecisionRefs: [
        { kind: "projects.required[0]", decisionRef: "9999-does-not-exist" },
      ],
    });
    expect(text).toContain("✔ no drift");
    expect(text).toContain(
      "⚠ 1 intent row cites a decisionRef that does not resolve to a known ADR, rule, or fitness record:",
    );
    expect(text).toContain('  projects.required[0] — "9999-does-not-exist"');
    // Rendered AFTER the drift verdict, so a clean "no drift" line is never
    // mistaken for having vouched for the citation above it.
    expect(text.indexOf("no drift")).toBeLessThan(text.indexOf("9999-does-not-exist"));
  });

  it("never counts an unresolved decisionRef into the drift-finding total", () => {
    const text = formatDriftReport({
      findings: [finding()],
      intent,
      observed,
      unresolvedDecisionRefs: [{ kind: "forbidden[0]", decisionRef: "9999-does-not-exist" }],
    });
    // One drift finding, one (separate) unresolved citation — the summary
    // line must still read "1 drift finding", not fold the second axis in.
    expect(text).toContain("1 drift finding (2 projects and 1 edge)");
  });

  it("uses the plural forms when more than one row cites an unresolvable decisionRef", () => {
    const text = formatDriftReport({
      findings: [],
      intent,
      observed,
      unresolvedDecisionRefs: [
        { kind: "allowed[0]", decisionRef: "9999-a" },
        { kind: "forbidden[0]", decisionRef: "9999-b" },
      ],
    });
    expect(text).toContain("⚠ 2 intent rows cite a decisionRef that does not resolve");
  });
});
