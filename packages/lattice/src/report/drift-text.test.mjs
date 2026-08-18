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
});
