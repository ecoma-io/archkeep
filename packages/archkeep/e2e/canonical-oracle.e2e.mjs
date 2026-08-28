// The oracle's own self-test: the canonical assertions must reject every
// silent direction — a missing edge, an unexpected edge, a reversed edge, a
// duplicated pair, an empty graph — before any consumer workspace trusts
// them. Builds no consumer; runs in milliseconds.

import { describe, expect, it } from "vitest";
import {
  assertCanonicalEdges,
  assertCanonicalGraph,
  assertCanonicalProjects,
  assertDelta,
  CANONICAL,
  canonicalPair,
  canonicalTags,
} from "./helpers/canonical.mjs";

const edge = (source, target, type = "static") => ({ source, target, type });

describe("canonicalPair", () => {
  it("names a pair from source and target", () => {
    expect(canonicalPair({ source: "api", target: "core" })).toBe("api->core");
  });

  it("refuses a record without a pair instead of naming it `undefined->undefined`", () => {
    expect(() =>
      canonicalPair(/** @type {{source: string, target: string}} */ ({ source: "api" })),
    ).toThrow(/without a source\/target pair/);
  });
});

describe("assertCanonicalProjects", () => {
  it("accepts the canonical set in any order", () => {
    expect(() =>
      assertCanonicalProjects(["api", "core", "infrastructure", "application"]),
    ).not.toThrow();
  });

  it("rejects a missing project", () => {
    expect(() => assertCanonicalProjects(["core", "application", "infrastructure"])).toThrow(
      /missing: .*api/,
    );
  });

  it("rejects an unexpected project", () => {
    expect(() => assertCanonicalProjects([...CANONICAL.projects, "tooling"])).toThrow(
      /unexpected: tooling/,
    );
  });

  it("rejects an empty set — nothing is silent", () => {
    expect(() => assertCanonicalProjects([])).toThrow(/missing:/);
  });
});

describe("assertCanonicalEdges", () => {
  it("accepts the canonical edges in any order and with any edge types", () => {
    expect(() =>
      assertCanonicalEdges([
        edge("application", "infrastructure", "implicit"),
        edge("application", "core"),
        edge("api", "application", "dynamic"),
      ]),
    ).not.toThrow();
  });

  it("rejects a missing edge", () => {
    expect(() =>
      assertCanonicalEdges([edge("application", "core"), edge("application", "infrastructure")]),
    ).toThrow(/missing: .*api->application/);
  });

  it("rejects an unexpected edge", () => {
    expect(() =>
      assertCanonicalEdges([
        edge("application", "core"),
        edge("api", "application"),
        edge("application", "infrastructure"),
        edge("api", "core"),
      ]),
    ).toThrow(/unexpected: api->core/);
  });

  it("rejects a reversed edge and names it a reversal", () => {
    expect(() =>
      assertCanonicalEdges([
        edge("core", "application"),
        edge("api", "application"),
        edge("application", "infrastructure"),
      ]),
    ).toThrow(/reversed: expected application->core, found core->application/);
  });

  it("rejects a duplicated pair", () => {
    expect(() =>
      assertCanonicalEdges([
        edge("application", "core", "static"),
        edge("application", "core", "implicit"),
        edge("api", "application"),
        edge("application", "infrastructure"),
      ]),
    ).toThrow(/duplicate edge records[\s\S]*application->core ×2/);
  });

  it("rejects an empty edge list — nothing is silent", () => {
    expect(() => assertCanonicalEdges([])).toThrow(/missing:/);
  });
});

describe("assertCanonicalGraph", () => {
  it("accepts a canonical envelope with extra provider fields", () => {
    expect(() =>
      assertCanonicalGraph({
        projects: CANONICAL.projects.map((name) => ({ name, tags: canonicalTags(name) })),
        dependencies: CANONICAL.edges.map((e) => ({ ...e, type: "static", sourceFile: "x.go" })),
        coverage: { complete: true },
      }),
    ).not.toThrow();
  });

  it("rejects a swapped direction in the envelope", () => {
    expect(() =>
      assertCanonicalGraph({
        projects: CANONICAL.projects,
        dependencies: [
          edge("core", "application"),
          edge("api", "application"),
          edge("application", "infrastructure"),
        ],
      }),
    ).toThrow(/reversed/);
  });

  it("rejects an envelope with no dependencies", () => {
    expect(() => assertCanonicalGraph({ projects: CANONICAL.projects })).toThrow(/missing:/);
  });
});

describe("assertDelta", () => {
  it("accepts an empty delta on a clean diff", () => {
    expect(() =>
      assertDelta({ addedEdges: [], removedEdges: [], addedProjects: [], removedProjects: [] }),
    ).not.toThrow();
  });

  it("rejects one extra added edge", () => {
    expect(() =>
      assertDelta(
        { addedEdges: [edge("api", "core"), edge("api", "infrastructure")], removedEdges: [] },
        { addedEdges: ["api->core"] },
      ),
    ).toThrow(/addedEdges mismatch[\s\S]*api->infrastructure/);
  });

  it("rejects one missing added edge", () => {
    expect(() =>
      assertDelta({ addedEdges: [], removedEdges: [] }, { addedEdges: ["api->core"] }),
    ).toThrow(/addedEdges mismatch/);
  });

  it("is order-insensitive on both sides", () => {
    expect(() =>
      assertDelta(
        {
          addedEdges: [edge("api", "core"), edge("core", "api")],
          removedEdges: [edge("application", "core"), edge("application", "infrastructure")],
        },
        {
          addedEdges: [{ source: "core", target: "api" }, "api->core"],
          removedEdges: ["application->infrastructure", "application->core"],
        },
      ),
    ).not.toThrow();
  });

  it("rejects a direction swap the pair identity must catch", () => {
    expect(() =>
      assertDelta(
        { addedEdges: [edge("core", "application")], removedEdges: [] },
        {
          addedEdges: ["application->core"],
        },
      ),
    ).toThrow(/addedEdges mismatch[\s\S]*core->application/);
  });

  it("compares project arrays exactly", () => {
    expect(() =>
      assertDelta(
        { addedProjects: ["tooling"], removedProjects: [] },
        { addedProjects: ["tooling"] },
      ),
    ).not.toThrow();
    expect(() =>
      assertDelta({ addedProjects: [], removedProjects: [] }, { addedProjects: ["tooling"] }),
    ).toThrow(/addedProjects mismatch/);
  });

  it("rejects a changedProjects mismatch", () => {
    expect(() => assertDelta({ changedProjects: ["core"] }, {})).toThrow(
      /changedProjects mismatch/,
    );
  });

  it("defaults every array to empty — an unexpected removal cannot hide", () => {
    expect(() => assertDelta({ removedProjects: ["infrastructure"] })).toThrow(
      /removedProjects mismatch/,
    );
  });

  it("expands expected pairs by recordsPerPair for multi-channel providers", () => {
    // Moon moves one pair as two records (static + implicit) — exactly two
    // passes, one record fails, three records fail.
    const dual = { addedEdges: [edge("api", "core"), edge("api", "core")], removedEdges: [] };
    expect(() =>
      assertDelta(dual, { addedEdges: ["api->core"] }, { recordsPerPair: 2 }),
    ).not.toThrow();
    expect(() =>
      assertDelta(
        { addedEdges: [edge("api", "core")], removedEdges: [] },
        { addedEdges: ["api->core"] },
        { recordsPerPair: 2 },
      ),
    ).toThrow(/addedEdges mismatch/);
    expect(() =>
      assertDelta(
        {
          addedEdges: [edge("api", "core"), edge("api", "core"), edge("api", "core")],
          removedEdges: [],
        },
        { addedEdges: ["api->core"] },
        { recordsPerPair: 2 },
      ),
    ).toThrow(/addedEdges mismatch/);
    expect(() => assertDelta(dual, { addedEdges: ["api->core"] })).toThrow(/addedEdges mismatch/);
  });

  it("rejects a non-positive recordsPerPair instead of silently treating it as 1", () => {
    expect(() =>
      assertDelta({ addedEdges: [], removedEdges: [] }, {}, { recordsPerPair: 0 }),
    ).toThrow(/recordsPerPair/);
  });
});
