import { describe, expect, it } from "vitest";

import { buildRankedCandidates } from "./reconcile-candidates.mjs";

/** A simple scored element deck, matching the ScoredElement typedef. */
const element = (overrides) => ({
  plane: "project",
  name: "x",
  state: "unexpected",
  severity: 4,
  classification: "intentUnknownProject",
  intentRow: null,
  confidence: "stated",
  ...overrides,
});

describe("buildRankedCandidates", () => {
  it("never proposes for match or unknown states", () => {
    const scores = {
      projects: [
        element({ state: "match", severity: 0, classification: "match" }),
        element({
          state: "unknown",
          severity: Number.POSITIVE_INFINITY,
          classification: "unanalyzed",
        }),
      ],
      edges: [],
      intentRows: [],
    };
    expect(buildRankedCandidates(scores)).toEqual([]);
  });

  it("proposes an add for an observed project outside the declared model", () => {
    const scores = {
      projects: [element({ name: "orphan", classification: "intentUnknownProject" })],
      edges: [],
      intentRows: [],
    };
    const candidates = buildRankedCandidates(scores);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      kind: "add",
      plane: "project",
      name: "orphan",
      state: "unexpected",
      proposed: true,
      notAuthoritative: true,
      edit: { section: "projects", action: "add" },
    });
  });

  it("proposes an add for a dependency outside the allowlist", () => {
    const scores = {
      projects: [],
      edges: [element({ plane: "edge", name: "a → b", classification: "dependencyNotAllowed" })],
      intentRows: [],
    };
    const candidates = buildRankedCandidates(scores);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      kind: "add",
      edit: { section: "dependencies", action: "add" },
    });
  });

  it("proposes removal for a required project the architecture does not build", () => {
    const scores = {
      projects: [],
      edges: [],
      intentRows: [
        element({
          plane: "project",
          name: "ghost",
          state: "absent",
          severity: 3,
          classification: "projectMissing",
          intentRow: { plane: "project", index: 0, kind: "required", key: "ghost" },
        }),
      ],
    };
    const candidates = buildRankedCandidates(scores);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      kind: "removal",
      edit: { section: "projects.required", action: "remove" },
    });
  });

  it("proposes tag-change for a missing required tag", () => {
    const scores = {
      projects: [],
      edges: [],
      intentRows: [
        element({
          plane: "project",
          name: "core  scope-nx",
          state: "absent",
          severity: 3,
          classification: "projectTagMissing",
          intentRow: { plane: "project", index: 0, kind: "required", key: "core" },
        }),
      ],
    };
    const candidates = buildRankedCandidates(scores);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      kind: "tag-change",
      edit: { action: "update required tags", section: "projects.required" },
    });
  });

  it("proposes boundary-change for a forbidden boundary row being built", () => {
    const scores = {
      projects: [],
      edges: [],
      intentRows: [
        element({
          plane: "intent-row",
          name: "packages → apps",
          state: "unexpected",
          severity: 4,
          classification: "intentForbiddenEdge",
          intentRow: { plane: "intent-row", index: 0, kind: "forbidden", key: "packages → apps" },
        }),
      ],
    };
    const candidates = buildRankedCandidates(scores);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      kind: "boundary-change",
      edit: { action: "change boundary row", value: { from: "packages", to: "apps" } },
    });
  });

  it("ranks unexpected before absent, then by plane and name deterministically", () => {
    const scores = {
      projects: [
        element({
          name: "zc",
          state: "unexpected",
          severity: 4,
          classification: "intentUnknownProject",
        }),
        element({
          name: "aa",
          state: "unexpected",
          severity: 4,
          classification: "intentUnknownProject",
        }),
      ],
      edges: [],
      intentRows: [
        element({
          plane: "project",
          name: "missing",
          state: "absent",
          severity: 3,
          classification: "projectMissing",
          intentRow: { plane: "project", index: 0, kind: "required", key: "missing" },
        }),
      ],
    };
    const candidates = buildRankedCandidates(scores);
    expect(candidates.map((c) => c.name)).toEqual(["aa", "zc", "missing"]);
    // Determinism: same input, same order.
    expect(buildRankedCandidates(scores).map((c) => c.name)).toEqual(["aa", "zc", "missing"]);
  });

  it("does not double-propose a divergence that appears on both sides", () => {
    // A forbidden edge's witness is scored on the edge plane as
    // `dependencyForbidden` (not in the observed-element kind table → no `add`)
    // and on the intent-row plane as a boundary-change → exactly one candidate.
    const scores = {
      projects: [],
      edges: [
        element({ plane: "edge", name: "core → app", classification: "intentForbiddenEdge" }),
      ],
      intentRows: [
        element({
          plane: "intent-row",
          name: "packages → apps",
          state: "unexpected",
          classification: "intentForbiddenEdge",
          intentRow: { plane: "intent-row", index: 0, kind: "forbidden", key: "packages → apps" },
        }),
      ],
    };
    const candidates = buildRankedCandidates(scores);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe("boundary-change");
  });
});
