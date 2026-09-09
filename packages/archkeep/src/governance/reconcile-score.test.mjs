import { describe, expect, it } from "vitest";
import { buildRankedCandidates } from "./reconcile-candidates.mjs";

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

  it("scores a forbidden dependency row violated through the judge's transitive finding", () => {
    // The judge reports `dependencyForbidden` on the any-path closure (witness
    // `a → m → core`); the observed graph holds no direct `a → core` edge, so
    // scoring the row from direct edges read it as "match" while `check` and
    // `drift` — fed by the same canonical verdict — reported the finding.
    const model = intent({ dependencies: { forbidden: [{ source: "a", target: "core" }] } });
    const verdict = {
      findings: [
        {
          source: "a",
          target: "core",
          rule: "dependencyForbidden",
          boundaryFrom: null,
          boundaryTo: null,
          message:
            "a → m → core — architecture-intent.json forbids this dependency, but the observed graph contains it",
        },
      ],
    };
    const transitive = {
      projects: [project("a"), project("m"), project("core")],
      edges: [edge("a", "m"), edge("m", "core")],
    };
    const rows = scoreIntentRows(model, verdict, transitive, new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "unexpected", classification: "dependencyForbidden" });
  });

  it("scores a forbidden dependency row only from the judge's findings — never from a direct edge", () => {
    // The row's verdict IS the judge's verdict: a direct `a → core` edge with
    // no `dependencyForbidden` finding (the canonical judge cannot produce
    // that combination, since a direct path is on the closure too) stays
    // `match`, so a scorer that re-derived the row from observed edges — the
    // silent direction this fix removes — fails this test.
    const model = intent({ dependencies: { forbidden: [{ source: "a", target: "core" }] } });
    const rows = scoreIntentRows(
      model,
      emptyVerdict,
      { projects: [project("a"), project("core")], edges: [edge("a", "core")] },
      new Map(),
    );
    expect(rows[0]).toMatchObject({ state: "match", classification: "match" });
  });

  it("detects a violated forbiddenTags rule through the judge's finding", () => {
    const model = intent({ forbiddenTags: [{ from: "type-package", to: "type-application" }] });
    const rows = scoreIntentRows(model, emptyVerdict, observed, tagsByProject);
    expect(rows[0]).toMatchObject({ state: "match" });

    const verdict = {
      findings: [
        {
          source: "core",
          target: "app",
          rule: "tagDependencyForbidden",
          boundaryFrom: null,
          boundaryTo: null,
          message:
            "core → app — architecture-intent.json forbids a dependency from any project carrying " +
            'tag "type-package" to any project carrying tag "type-application"',
        },
      ],
    };
    const violating = scoreIntentRows(model, verdict, observed, tagsByProject);
    expect(violating[0]).toMatchObject({
      state: "unexpected",
      classification: "tagDependencyForbidden",
    });
  });

  it("attributes a tag-rule witness only to the row whose tags its pair carries", () => {
    // The judge reports concrete (source, target) witnesses; a witness whose
    // pair does NOT carry the row's `from`/`to` tags must not violate the row
    // — attribution through `tagsByProject`, never through a second graph walk.
    const model = intent({ forbiddenTags: [{ from: "type-package", to: "type-application" }] });
    const verdict = {
      findings: [
        {
          source: "worker",
          target: "app",
          rule: "tagDependencyForbidden",
          boundaryFrom: null,
          boundaryTo: null,
          message: "worker → app — architecture-intent.json forbids",
        },
      ],
    };
    const rows = scoreIntentRows(model, verdict, observed, tagsByProject);
    // "worker" is not an observed project in this fixture, so it carries no
    // tag — the row must stay a match, not read the finding as its own.
    expect(rows[0]).toMatchObject({ state: "match", classification: "match" });
  });

  it("scores a forbiddenTags row violated through the judge's transitive witness", () => {
    // Same any-path closure as `dependencies.forbidden` above: the witness
    // `a → m → core` crosses the tagged pair with no direct edge between its
    // endpoints, so a direct-edge `observed.edges.some(...)` re-derivation
    // scored the row "match" while the canonical judge reported the finding.
    const model = intent({ forbiddenTags: [{ from: "frontend", to: "core" }] });
    const verdict = {
      findings: [
        {
          source: "a",
          target: "core",
          rule: "tagDependencyForbidden",
          boundaryFrom: null,
          boundaryTo: null,
          message: "a → m → core — architecture-intent.json forbids",
        },
      ],
    };
    const transitive = {
      projects: [project("a", ["frontend"]), project("m"), project("core", ["core"])],
      edges: [edge("a", "m"), edge("m", "core")],
    };
    const rows = scoreIntentRows(
      model,
      verdict,
      transitive,
      new Map([
        ["a", ["frontend"]],
        ["m", []],
        ["core", ["core"]],
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: "unexpected",
      classification: "tagDependencyForbidden",
    });
  });

  it("scores a dependencies.forbidden row with an unknown target as unknown/unverifiable — never match/stated (SEM-04)", () => {
    // A forbidden row naming a project the observed architecture does not have
    // can never fire — the judge emits intentUnknownProject (source: null,
    // target: null) for it. The scoring must mirror the boundary plane and
    // score the row unknown/unverifiable rather than silently match/stated.
    const model = intent({ dependencies: { forbidden: [{ source: "core", target: "ghost" }] } });
    const verdict = {
      findings: [
        {
          source: null,
          target: null,
          rule: "intentUnknownProject",
          boundaryFrom: null,
          boundaryTo: null,
          message:
            'architecture-intent.json names project "ghost", but the observed architecture has no project of that name',
        },
      ],
    };
    const rows = scoreIntentRows(model, verdict, observed, tagsByProject);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      plane: "edge",
      state: "unknown",
      classification: "intentUnknownProject",
      confidence: "unverifiable",
      intentRow: { plane: "edge", index: 0, kind: "forbidden", key: "core → ghost" },
    });
  });

  it("scores a forbiddenTags row with an unknown tag as unknown/unverifiable — never match/stated (SEM-04)", () => {
    // A tag rule referencing tags no observed project carries can never fire —
    // the judge emits intentUnknownTag (source: null, target: null). The
    // scoring must mirror the boundary plane.
    const model = intent({
      forbiddenTags: [{ from: "no-such-a", to: "no-such-b" }],
    });
    const verdict = {
      findings: [
        {
          source: null,
          target: null,
          rule: "intentUnknownTag",
          boundaryFrom: null,
          boundaryTo: null,
          message:
            'architecture-intent.json forbids a dependency from tag "no-such-a" to tag "no-such-b", but no observed project carries "no-such-a" and "no-such-b"',
        },
      ],
    };
    const rows = scoreIntentRows(model, verdict, observed, tagsByProject);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      plane: "tag",
      state: "unknown",
      classification: "intentUnknownTag",
      confidence: "unverifiable",
      intentRow: { plane: "tag", index: 0, kind: "tag-forbidden", key: "no-such-a → no-such-b" },
    });
  });

  it("scores a real forbidden dependency row with known names still as unexpected/dependencyForbidden (loud direction intact)", () => {
    // A forbidden row whose endpoints ARE observed and violated must still
    // score unexpected — the fix must not blunt the loud direction.
    const model = intent({ dependencies: { forbidden: [{ source: "core", target: "app" }] } });
    const verdict = {
      findings: [
        {
          source: "core",
          target: "app",
          rule: "dependencyForbidden",
          boundaryFrom: null,
          boundaryTo: null,
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
    expect(rows[0]).toMatchObject({ state: "unexpected", classification: "dependencyForbidden" });
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

describe("reconcile-score → reconcile-candidates (the --propose face)", () => {
  it("proposes one removal candidate per forbidden row the judge's closure violates", () => {
    // The issue's fixture: the observed graph reaches `core` only through `m`
    // (`a → m → core`), while the intent forbids `a → core` by name and, on
    // the tag axis, any `frontend`-tagged project reaching a `core`-tagged one.
    // `check`/`drift` report both findings; reconcile must score both rows
    // violated and `--propose` must list both as `removal` candidates.
    const model = intent({
      dependencies: { forbidden: [{ source: "a", target: "core" }] },
      forbiddenTags: [{ from: "frontend", to: "core" }],
    });
    const verdict = {
      findings: [
        {
          source: "a",
          target: "core",
          rule: "dependencyForbidden",
          boundaryFrom: null,
          boundaryTo: null,
          message: "a → m → core — architecture-intent.json forbids this dependency",
        },
        {
          source: "a",
          target: "core",
          rule: "tagDependencyForbidden",
          boundaryFrom: null,
          boundaryTo: null,
          message: "a → m → core — architecture-intent.json forbids a dependency by tag",
        },
      ],
    };
    const transitive = {
      projects: [project("a", ["frontend"]), project("m"), project("core", ["core"])],
      edges: [edge("a", "m"), edge("m", "core")],
    };
    const scores = reconcileScores(model, verdict, transitive, { failures: [] });
    const candidates = buildRankedCandidates(scores);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => `${c.kind} ${c.name}`)).toEqual([
      "removal a → core",
      "removal frontend → core",
    ]);
    expect(candidates[0].evidence).toBe("dependencyForbidden");
    expect(candidates[0].intentRow).toMatchObject({ plane: "edge", kind: "forbidden" });
    expect(candidates[1].evidence).toBe("tagDependencyForbidden");
    expect(candidates[1].intentRow).toMatchObject({ plane: "tag", kind: "tag-forbidden" });
  });
});
