import { describe, expect, it } from "vitest";

import {
  scoreIntentRows,
  scoreProject,
  scoreEdge,
  reconcileScores,
  SEVERITY_ORDER,
} from "./reconcile-score.mjs";

/** A normalized intent model, minimally filled. */
const intent = (overrides = {}) => ({
  version: "1",
  boundaries: [],
  allowed: [],
  forbidden: [],
  forbiddenTags: [],
  ...overrides,
});

/** An observed project fact, the `buildObserved` shape (tags on `data`). */
const project = (name, tags = [], root = `libs/${name}`) => ({ name, data: { root, tags } });

/** An observed edge, the `buildObserved` shape. */
const edge = (source, target) => ({ source, target, type: "static" });

describe("scoreProject", () => {
  const noKeys = {
    requiredNames: new Set(),
    forbiddenNames: new Set(),
    projectSectionDeclared: false,
  };

  it("matches a project the intent requires", () => {
    const keys = {
      ...noKeys,
      requiredNames: new Set(["core"]),
      projectSectionDeclared: true,
    };
    const { project: score } = scoreProject(project("core", ["type-package"]), keys, new Map());
    expect(score.state).toBe("match");
    expect(score.confidence).toBe("stated");
    expect(score.severity).toBe(SEVERITY_ORDER.match);
  });

  it("is 'not governed' (still a match) when the intent has no existence model", () => {
    const { project: score } = scoreProject(project("core"), noKeys, new Map());
    expect(score.state).toBe("match");
    expect(score.confidence).toBe("not governed");
  });

  it("flags a project the intent forbids", () => {
    const keys = {
      ...noKeys,
      forbiddenNames: new Set(["core"]),
      projectSectionDeclared: true,
    };
    const { project: score } = scoreProject(project("core"), keys, new Map());
    expect(score.state).toBe("unexpected");
    expect(score.classification).toBe("projectPresent");
  });

  it("flags a project outside a declared existence model as unexpected", () => {
    const keys = { ...noKeys, projectSectionDeclared: true };
    const { project: score } = scoreProject(project("orphan"), keys, new Map());
    expect(score.state).toBe("unexpected");
    expect(score.classification).toBe("intentUnknownProject");
  });

  it("reports a missing required tag as an absent tag element", () => {
    const keys = { ...noKeys, requiredNames: new Set(["core"]), projectSectionDeclared: true };
    const requiredTags = new Map([["core", ["type-package", "scope-nx"]]]);
    const { tags } = scoreProject(project("core", ["type-package"]), keys, requiredTags);
    expect(tags).toHaveLength(1);
    expect(tags[0].state).toBe("absent");
    expect(tags[0].classification).toBe("projectTagMissing");
    expect(tags[0].name).toContain("scope-nx");
  });

  it("does not report a tag the project carries", () => {
    const keys = { ...noKeys, requiredNames: new Set(["core"]), projectSectionDeclared: true };
    const requiredTags = new Map([["core", ["type-package"]]]);
    const { tags } = scoreProject(project("core", ["type-package"]), keys, requiredTags);
    expect(tags).toHaveLength(0);
  });

  it("reads tags at the top level when data.tags is absent (the buildProjects shape)", () => {
    const keys = { ...noKeys, requiredNames: new Set(["core"]), projectSectionDeclared: true };
    const requiredTags = new Map([["core", ["type-package"]]]);
    const { project: score } = scoreProject(
      { name: "core", root: "libs/core", tags: ["type-package"] },
      keys,
      requiredTags,
    );
    expect(score.state).toBe("match");
  });
});

describe("scoreEdge", () => {
  const noKeys = {
    forbiddenEdges: new Set(),
    allowedEdges: new Set(),
    edgeAllowlistDeclared: false,
  };

  it("matches an ungoverned edge", () => {
    const score = scoreEdge(edge("a", "b"), noKeys, new Set(), new Set());
    expect(score.state).toBe("match");
    expect(score.confidence).toBe("not governed");
  });

  it("flags an edge the intent forbids by name", () => {
    const keys = { ...noKeys, forbiddenEdges: new Set(["a → b"]) };
    const score = scoreEdge(edge("a", "b"), keys, new Set(), new Set());
    expect(score.state).toBe("unexpected");
    expect(score.classification).toBe("dependencyForbidden");
  });

  it("flags an edge outside an explicit allowlist", () => {
    const keys = {
      ...noKeys,
      allowedEdges: new Set(["a → b"]),
      edgeAllowlistDeclared: true,
    };
    expect(scoreEdge(edge("a", "b"), keys, new Set(), new Set()).state).toBe("match");
    expect(scoreEdge(edge("a", "c"), keys, new Set(), new Set()).state).toBe("unexpected");
    expect(scoreEdge(edge("a", "c"), keys, new Set(), new Set()).classification).toBe(
      "dependencyNotAllowed",
    );
  });

  it("scores a judge witness edge of a boundary row as unexpected", () => {
    const score = scoreEdge(edge("a", "b"), noKeys, new Set(["a → b"]), new Set());
    expect(score.state).toBe("unexpected");
    expect(score.classification).toBe("intentForbiddenEdge");
  });

  it("scores a tag-rule witness edge as unexpected", () => {
    const score = scoreEdge(edge("a", "b"), noKeys, new Set(), new Set(["a → b"]));
    expect(score.state).toBe("unexpected");
    expect(score.classification).toBe("tagDependencyForbidden");
  });
});

describe("scoreIntentRows", () => {
  const emptyVerdict = { findings: [], notes: [] };
  const observed = {
    projects: [project("core", ["type-package"]), project("app", ["type-application"])],
    edges: [],
  };
  const tagsByProject = new Map([
    ["core", ["type-package"]],
    ["app", ["type-application"]],
  ]);

  it("scores every row in file order with an intentRow index", () => {
    const model = intent({
      projects: { required: [{ name: "core", tags: ["type-package"] }, { name: "ghost" }] },
    });
    const rows = scoreIntentRows(model, emptyVerdict, observed, tagsByProject);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      plane: "project",
      name: "core",
      state: "match",
      intentRow: { plane: "project", index: 0, kind: "required", key: "core" },
    });
    expect(rows[1]).toMatchObject({
      state: "absent",
      classification: "projectMissing",
      intentRow: { index: 1 },
    });
  });

  it("scores a present forbidden project as unexpected with the exact judge rule", () => {
    const model = intent({ projects: { forbidden: [{ name: "core" }] } });
    const rows = scoreIntentRows(model, emptyVerdict, observed, tagsByProject);
    expect(rows[0]).toMatchObject({ state: "unexpected", classification: "projectPresent" });
  });

  it("scores forbidden boundary rows from the judge's findings by exact from/to", () => {
    const model = intent({
      boundaries: [
        { name: "packages", match: ["tag:type-package"] },
        { name: "apps", match: ["tag:type-application"] },
      ],
      forbidden: [{ from: "packages", to: "apps", reason: "the engine must not reach out" }],
    });
    const verdict = {
      findings: [
        {
          source: "core",
          target: "app",
          rule: "intentForbiddenEdge",
          boundaryFrom: "packages",
          boundaryTo: "apps",
          message: "core → app — architecture-intent.json forbids",
        },
      ],
    };
    const rows = scoreIntentRows(
      model,
      verdict,
      { projects: observed.projects, edges: [edge("core", "app")] },
      tagsByProject,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      plane: "intent-row",
      state: "unexpected",
      classification: "intentForbiddenEdge",
      name: "packages → apps",
    });
  });

  it("does not let two boundary name pairs with a colliding delimiter-free key steal each other's finding", () => {
    // `{from:"web", to:"appcore"}` and `{from:"webapp", to:"core"}` both join
    // to the identical string "webappcore" under a plain `${a}${b}` concat
    // key — the exact collision the collision-free `boundaryKey` helper
    // exists to avoid (matching `edgeKey` in `../architecture-intent/judge.mjs`).
    // Both pairs carry a REAL, distinct finding here; under the colliding key
    // only the LAST-inserted finding survives in the lookup map, so the
    // forbidden row's own real `intentForbiddenEdge` finding is shadowed by
    // the allowed row's `intentAllowedMissing` finding and silently reads
    // back as "match" — a real violation reported as clean.
    const model = intent({
      forbidden: [{ from: "web", to: "appcore", reason: "r1" }],
      allowed: [{ from: "webapp", to: "core", reason: "r2" }],
    });
    const verdict = {
      findings: [
        {
          source: "s1",
          target: "t1",
          rule: "intentForbiddenEdge",
          boundaryFrom: "web",
          boundaryTo: "appcore",
          message: "m1",
        },
        {
          source: "s2",
          target: "t2",
          rule: "intentAllowedMissing",
          boundaryFrom: "webapp",
          boundaryTo: "core",
          message: "m2",
        },
      ],
    };
    const rows = scoreIntentRows(model, verdict, observed, tagsByProject);
    const forbiddenRow = rows.find((r) => r.name === "web → appcore");
    const allowedRow = rows.find((r) => r.name === "webapp → core");
    expect(forbiddenRow).toMatchObject({
      state: "unexpected",
      classification: "intentForbiddenEdge",
    });
    expect(allowedRow).toMatchObject({ state: "absent", classification: "intentAllowedMissing" });
  });

  it("scores a satisfied forbidden boundary row as a match", () => {
    const model = intent({ forbidden: [{ from: "packages", to: "apps", reason: "r" }] });
    const rows = scoreIntentRows(model, emptyVerdict, observed, tagsByProject);
    expect(rows[0].state).toBe("match");
  });

  it("scores an allowed boundary row that is not being built as absent", () => {
    const model = intent({ allowed: [{ from: "packages", to: "apps", reason: "r" }] });
    const verdict = {
      findings: [
        {
          source: "core",
          target: "app",
          rule: "intentAllowedMissing",
          boundaryFrom: "packages",
          boundaryTo: "apps",
          message: "allows",
        },
      ],
    };
    const rows = scoreIntentRows(model, verdict, observed, tagsByProject);
    expect(rows[0]).toMatchObject({ state: "absent", classification: "intentAllowedMissing" });
  });

  it("scores an allowlist dependency row as a match either way (permission, not an existence claim)", () => {
    const model = intent({ dependencies: { allowed: [{ source: "a", target: "b" }] } });
    const rows = scoreIntentRows(model, emptyVerdict, observed, tagsByProject);
    expect(rows[0]).toMatchObject({ state: "match", classification: "match" });
  });

  it("detects a violated forbiddenTags rule through the observed edges", () => {
    const model = intent({ forbiddenTags: [{ from: "type-package", to: "type-application" }] });
    const rows = scoreIntentRows(model, emptyVerdict, observed, tagsByProject);
    expect(rows[0]).toMatchObject({ state: "match" });

    const observedWithEdge = {
      projects: observed.projects,
      edges: [edge("core", "app")],
    };
    const violating = scoreIntentRows(model, emptyVerdict, observedWithEdge, tagsByProject);
    expect(violating[0]).toMatchObject({
      state: "unexpected",
      classification: "tagDependencyForbidden",
    });
  });
});

describe("reconcileScores", () => {
  const emptyAnalysis = { failures: [] };

  it("produces deterministic, sorted element sets", () => {
    const model = intent({
      projects: { required: [{ name: "core", tags: ["type-package"] }] },
    });
    const verdict = { findings: [], notes: [] };
    const observed = {
      projects: [project("core", ["type-package"]), project("app", ["type-application"])],
      edges: [edge("core", "app")],
    };
    const scores = reconcileScores(model, verdict, observed, emptyAnalysis);
    expect(scores.projects.map((p) => p.name)).toEqual(["app", "core"]);
    expect(scores.edges.map((e) => e.name)).toEqual(["core → app"]);
  });

  it("shadows every project as unknown when a whole-file failure exists", () => {
    const model = intent();
    const verdict = { findings: [], notes: [] };
    const observed = {
      projects: [project("core", ["type-package"])],
      edges: [],
    };
    const scores = reconcileScores(model, verdict, observed, {
      failures: [{ sourceFile: "libs/core/main.go", reason: "unreadable file", line: null }],
    });
    expect(scores.unknownFiles).toEqual([{ file: "libs/core/main.go", reason: "unreadable file" }]);
    for (const score of scores.projects) {
      expect(score.state).toBe("unknown");
      expect(score.classification).toBe("unanalyzed");
      expect(score.confidence).toBe("unverifiable");
    }
  });

  it("does not shadow projects for non-whole-file failures", () => {
    const model = intent();
    const verdict = { findings: [], notes: [] };
    const observed = { projects: [project("core", ["type-package"])], edges: [] };
    const scores = reconcileScores(model, verdict, observed, {
      failures: [
        { sourceFile: "libs/core/main.go", reason: "unresolvable specifier", line: 5, column: 5 },
      ],
    });
    expect(scores.unknownFiles).toEqual([]);
    expect(scores.projects[0].state).toBe("match");
  });

  it("scores a boundary by resolved membership", () => {
    const model = intent({
      boundaries: [{ name: "packages", match: ["tag:type-package"] }],
    });
    const verdict = { findings: [], notes: [] };
    const observed = {
      projects: [project("core", ["type-package"])],
      edges: [],
    };
    const scores = reconcileScores(model, verdict, observed, emptyAnalysis);
    expect(scores.boundaries).toHaveLength(1);
    expect(scores.boundaries[0]).toMatchObject({ name: "packages", state: "match" });
  });
});
