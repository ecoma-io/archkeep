import { describe, expect, it } from "vitest";

import { formatEvolutionReport } from "./evolution-text.mjs";

const coverage = {
  complete: true,
  projects: 2,
  analyzedFiles: 4,
  imports: 7,
  notAnalyzed: [],
  blindSpots: [],
  notes: [],
};

const transition = (over = {}) => ({
  from: "a".repeat(40),
  to: "b".repeat(40),
  architectureChanged: false,
  changes: null,
  policyChanged: false,
  policyOneSided: false,
  provenanceChanged: false,
  providerChanged: false,
  codeDrift: true,
  notes: [],
  ...over,
});

describe("the evolution terminal report", () => {
  it("names the compared range and counts revisions and transitions", () => {
    const text = formatEvolutionReport({
      result: {
        base: "1".repeat(40),
        head: "2".repeat(40),
        revisions: [
          { commit: "1".repeat(40), id: "x".repeat(64) },
          { commit: "2".repeat(40), id: "y".repeat(64) },
        ],
        transitions: [transition()],
      },
      coverage,
    });
    expect(text.split("\n")[0]).toBe(`evolution  ${"1".repeat(12)}..${"2".repeat(12)}`);
    expect(text).toContain("2 revisions, 1 transition");
  });

  it("counts only architectural transitions in the footer", () => {
    const text = formatEvolutionReport({
      result: {
        base: "1".repeat(40),
        head: "2".repeat(40),
        revisions: [
          { commit: "1".repeat(40), id: "x".repeat(64) },
          { commit: "2".repeat(40), id: "y".repeat(64) },
        ],
        transitions: [transition({ codeDrift: false, policyChanged: true })],
      },
      coverage,
    });
    // Policy is how the record reads, not the architecture — the footer must
    // not read as if the architecture moved.
    expect(text).toContain("(policy)");
    expect(text).toContain("no architectural change across the selected revisions");
  });

  it("renders a diff's added edges beneath an architectural transition", () => {
    const text = formatEvolutionReport({
      result: {
        base: "1".repeat(40),
        head: "2".repeat(40),
        revisions: [
          { commit: "1".repeat(40), id: "x".repeat(64) },
          { commit: "2".repeat(40), id: "y".repeat(64) },
        ],
        transitions: [
          transition({
            architectureChanged: true,
            codeDrift: false,
            changes: {
              addedProjects: [],
              removedProjects: [],
              changedProjects: [],
              addedEdges: [{ source: "alpha", target: "beta", type: "static" }],
              removedEdges: [],
            },
          }),
        ],
      },
      coverage,
    });
    expect(text).toContain("+ 1 added edge");
    expect(text).toContain("alpha → beta (static)");
    expect(text).toMatch(/1 transition recorded an architectural change/u);
  });

  it("neutralises control characters in rendered names", () => {
    const text = formatEvolutionReport({
      result: {
        base: "1".repeat(40),
        head: "2".repeat(40),
        revisions: [
          { commit: "1".repeat(40), id: "x".repeat(64) },
          { commit: "2".repeat(40), id: "y".repeat(64) },
        ],
        transitions: [
          transition({
            architectureChanged: true,
            changes: {
              addedProjects: [{ name: "evil\u001B[31m", root: "libs/evil", tags: [] }],
              removedProjects: [],
              changedProjects: [],
              addedEdges: [],
              removedEdges: [],
            },
          }),
        ],
      },
      coverage,
    });
    expect(text).toContain("evil\\x1b[31m");
    expect(text).not.toContain("\u001B");
  });
  it("renders an unjudgeable summary policy as n/a, never a fabricated count", () => {
    const text = formatEvolutionReport({
      result: {
        base: "1".repeat(40),
        head: "2".repeat(40),
        revisions: [
          { commit: "1".repeat(40), id: "x".repeat(64) },
          { commit: "2".repeat(40), id: "y".repeat(64) },
        ],
        transitions: [transition()],
        summary: {
          transitions: 1,
          disposition: "accepted",
          classifications: [],
          observed: {
            architectureChanged: 0,
            policyChanged: {
              available: false,
              reason: "policy could not be compared at transition 0",
            },
            providerChanged: 0,
          },
          affected: {},
        },
      },
      coverage,
    });
    // The marker must print its reason, never a silent "policy changed: 0".
    expect(text).toContain("policy: n/a — policy could not be compared at transition 0");
    expect(text).not.toContain("policy changed:");
  });
});
