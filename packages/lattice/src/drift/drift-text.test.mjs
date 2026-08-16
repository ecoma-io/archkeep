import { describe, expect, it } from "vitest";

import { formatDriftReport } from "./drift-text.mjs";

const intent = { fingerprint: "a".repeat(64), rows: 3 };
const observed = { projects: 2, edges: 1, implicitEdges: 0 };

const finding = (overrides) => ({
  messageId: "dependencyForbidden",
  message: "the intent forbids the dependency app → db",
  kind: "dependencies.forbidden",
  row: "app → db",
  detail: "",
  project: null,
  source: "app",
  target: "db",
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

  it("groups findings by kind in taxonomy order, each under a named heading", () => {
    const text = formatDriftReport({
      findings: [
        finding({ messageId: "dependencyForbidden", source: "app", target: "db" }),
        finding({
          messageId: "projectMissing",
          row: "domain",
          source: null,
          target: null,
          project: "domain",
        }),
      ],
      intent,
      observed,
    });
    const projectIndex = text.indexOf("projects the intent requires are missing");
    const dependencyIndex = text.indexOf("dependencies the intent forbids exist");
    // projectMissing (taxonomy position 0) prints before dependencyForbidden (position 3).
    expect(projectIndex).toBeLessThan(dependencyIndex);
    expect(text).toContain("⚠ 1 finding: projects the intent requires are missing");
    expect(text).toContain("  domain");
    expect(text).toContain("  app → db");
    expect(text).toContain("2 drift findings (2 projects and 1 edge)");
  });

  it("renders a projectTagMissing with the missing tag as the secondary column", () => {
    const text = formatDriftReport({
      findings: [
        finding({
          messageId: "projectTagMissing",
          row: "app",
          detail: "layer:domain",
          project: "app",
          source: null,
          target: null,
        }),
      ],
      intent,
      observed,
    });
    expect(text).toContain("  app  layer:domain");
    expect(text).toContain("required projects lack required tags");
  });

  it("produces byte-identical output for the same facts across calls", () => {
    const first = formatDriftReport({ findings: [finding()], intent, observed });
    const second = formatDriftReport({ findings: [finding()], intent, observed });
    expect(first).toBe(second);
  });
});
