import { describe, expect, it } from "vitest";

import { computeDrift, DRIFT_MESSAGE_IDS } from "./drift.mjs";

const intent = (overrides = {}) => ({
  requiredProjects: [],
  forbiddenProjects: [],
  allowedDependencies: [],
  forbiddenDependencies: [],
  forbiddenTags: [],
  ...overrides,
});

const project = (name, tags = []) => ({ name, tags });

/** The edge model `buildDependencies` produces, with `type` on the record. */
const edge = (source, target, type = "static") => ({ source, target, type });

const observed = (projects = [], edges = []) => ({ projects, edges });

/** The findings reduced to what each assertion actually branches on. */
const ids = (verdict) => verdict.findings.map((f) => f.messageId).sort();

describe("a matching intent produces no drift", () => {
  it("is silent when every required project exists with its tags and nothing is forbidden", () => {
    const verdict = computeDrift(
      intent({
        requiredProjects: [{ name: "app", tags: ["scope:app"] }],
      }),
      observed([project("app", ["scope:app"])]),
    );
    expect(verdict.findings).toEqual([]);
    expect(verdict.projects).toBe(1);
    expect(verdict.edges).toBe(0);
    expect(verdict.implicitEdges).toBe(0);
  });

  it("is silent when a present project is not required (presence of more is not drift)", () => {
    const verdict = computeDrift(
      intent({ requiredProjects: [{ name: "app", tags: [] }] }),
      observed([project("app"), project("unmentioned")]),
    );
    expect(verdict.findings).toEqual([]);
  });

  it("is silent when an observed edge is both allowed and not forbidden", () => {
    const verdict = computeDrift(
      intent({
        allowedDependencies: [{ source: "app", target: "lib" }],
        forbiddenDependencies: [],
      }),
      observed([project("app"), project("lib")], [edge("app", "lib")]),
    );
    expect(verdict.findings).toEqual([]);
  });

  it("is silent when no allowlist exists and an observed edge is not forbidden", () => {
    // Omitted `allowed` means only forbidden rules can fire — an unlisted edge
    // is not drift when the intent never declared an exhaustive whitelist.
    const verdict = computeDrift(
      intent({ forbiddenDependencies: [{ source: "app", target: "other" }] }),
      observed([project("app"), project("lib"), project("other")], [edge("app", "lib")]),
    );
    expect(verdict.findings).toEqual([]);
  });
});

describe("projects.required", () => {
  it("reports a missing required project as projectMissing", () => {
    const verdict = computeDrift(
      intent({ requiredProjects: [{ name: "domain", tags: [] }] }),
      observed([]),
    );
    expect(ids(verdict)).toEqual(["projectMissing"]);
    expect(verdict.findings[0]).toMatchObject({
      messageId: "projectMissing",
      kind: "projects.required",
      row: "domain",
      project: "domain",
    });
  });

  it("reports a present project missing a required tag as projectTagMissing, naming the tag", () => {
    const verdict = computeDrift(
      intent({ requiredProjects: [{ name: "app", tags: ["layer:domain"] }] }),
      observed([project("app", ["scope:app"])]),
    );
    expect(ids(verdict)).toEqual(["projectTagMissing"]);
    expect(verdict.findings[0].detail).toBe("layer:domain");
  });

  it("reports one projectTagMissing per missing tag, never one per project", () => {
    const verdict = computeDrift(
      intent({ requiredProjects: [{ name: "app", tags: ["t1", "t2", "t3"] }] }),
      observed([project("app", ["t1"])]),
    );
    expect(verdict.findings.map((f) => f.detail)).toEqual(["t2", "t3"]);
  });

  it("does not report projectTagMissing when extra tags are present (presence-only)", () => {
    const verdict = computeDrift(
      intent({ requiredProjects: [{ name: "app", tags: ["t1"] }] }),
      observed([project("app", ["t1", "t2", "t3"])]),
    );
    expect(verdict.findings).toEqual([]);
  });
});

describe("projects.forbidden", () => {
  it("reports a forbidden project that exists as projectPresent", () => {
    const verdict = computeDrift(
      intent({ forbiddenProjects: [{ name: "legacy" }] }),
      observed([project("legacy")]),
    );
    expect(ids(verdict)).toEqual(["projectPresent"]);
    expect(verdict.findings[0].row).toBe("legacy");
  });

  it("is silent when a forbidden project does not exist", () => {
    const verdict = computeDrift(
      intent({ forbiddenProjects: [{ name: "legacy" }] }),
      observed([project("app")]),
    );
    expect(verdict.findings).toEqual([]);
  });
});

describe("dependencies.forbidden", () => {
  it("reports an observed forbidden edge as dependencyForbidden", () => {
    const verdict = computeDrift(
      intent({ forbiddenDependencies: [{ source: "app", target: "db" }] }),
      observed([project("app"), project("db")], [edge("app", "db")]),
    );
    expect(ids(verdict)).toEqual(["dependencyForbidden"]);
    expect(verdict.findings[0]).toMatchObject({
      messageId: "dependencyForbidden",
      kind: "dependencies.forbidden",
      row: "app → db",
      source: "app",
      target: "db",
    });
  });

  it("reports the edge once even when it appears twice (static + dynamic types)", () => {
    const verdict = computeDrift(
      intent({ forbiddenDependencies: [{ source: "app", target: "db" }] }),
      observed(
        [project("app"), project("db")],
        [edge("app", "db", "static"), edge("app", "db", "dynamic")],
      ),
    );
    expect(ids(verdict)).toEqual(["dependencyForbidden"]);
  });

  it("does not judge implicit edges, counting them separately so the report can state what it excluded", () => {
    const verdict = computeDrift(
      intent({ forbiddenDependencies: [{ source: "app", target: "db" }] }),
      observed([project("app"), project("db")], [edge("app", "db", "implicit")]),
    );
    expect(verdict.findings).toEqual([]);
    expect(verdict.implicitEdges).toBe(1);
    expect(verdict.edges).toBe(0);
  });

  it("is silent when a forbidden edge does not appear", () => {
    const verdict = computeDrift(
      intent({ forbiddenDependencies: [{ source: "app", target: "db" }] }),
      observed([project("app"), project("db"), project("lib")], [edge("app", "lib")]),
    );
    expect(verdict.findings).toEqual([]);
  });
});

describe("dependencies.allowed (exhaustive whitelist)", () => {
  it("reports an edge that is neither allowed nor forbidden as dependencyNotAllowed", () => {
    const verdict = computeDrift(
      intent({
        allowedDependencies: [{ source: "app", target: "lib" }],
      }),
      observed(
        [project("app"), project("lib"), project("other")],
        [edge("app", "lib"), edge("app", "other")],
      ),
    );
    expect(ids(verdict)).toEqual(["dependencyNotAllowed"]);
    expect(verdict.findings[0].row).toBe("app → other");
  });

  it("lets a forbidden edge win over the allowlist — one decisive verdict per edge", () => {
    const verdict = computeDrift(
      intent({
        allowedDependencies: [{ source: "app", target: "lib" }],
        forbiddenDependencies: [{ source: "app", target: "lib" }],
      }),
      observed([project("app"), project("lib")], [edge("app", "lib")]),
    );
    expect(ids(verdict)).toEqual(["dependencyForbidden"]);
  });
});

describe("tags.forbid", () => {
  it("reports an edge between two observed tag values as tagDependencyForbidden", () => {
    const verdict = computeDrift(
      intent({ forbiddenTags: [{ from: "layer:adapter", to: "layer:domain" }] }),
      observed(
        [project("adapter", ["layer:adapter"]), project("domain", ["layer:domain"])],
        [edge("adapter", "domain")],
      ),
    );
    expect(ids(verdict)).toEqual(["tagDependencyForbidden"]);
    expect(verdict.findings[0]).toMatchObject({
      messageId: "tagDependencyForbidden",
      kind: "tags.forbid",
      row: "layer:adapter → layer:domain",
      source: "adapter",
      target: "domain",
    });
  });

  it("does not fire when the source lacks the from tag or the target lacks the to tag", () => {
    // Both tags are observed somewhere (so intentUnknownTag stays quiet), but
    // the edge's source and target do not carry the pair — no rule fires.
    const verdict = computeDrift(
      intent({ forbiddenTags: [{ from: "a", to: "b" }] }),
      observed(
        [
          project("x", ["z"]),
          project("y", ["w"]),
          project("a-carrier", ["a"]),
          project("b-carrier", ["b"]),
        ],
        [edge("x", "y")],
      ),
    );
    expect(verdict.findings).toEqual([]);
  });

  it("emits one finding per edge, not one per matching row", () => {
    const verdict = computeDrift(
      intent({ forbiddenTags: [{ from: "a", to: "b" }] }),
      observed(
        [project("x", ["a"]), project("y", ["b"]), project("z", ["b"])],
        [edge("x", "y"), edge("x", "z")],
      ),
    );
    expect(verdict.findings.length).toBe(2);
  });

  it("does not double-report an edge that already fired dependencyForbidden (dedup)", () => {
    const verdict = computeDrift(
      intent({
        forbiddenDependencies: [{ source: "x", target: "y" }],
        forbiddenTags: [{ from: "a", to: "b" }],
      }),
      observed([project("x", ["a"]), project("y", ["b"])], [edge("x", "y")]),
    );
    expect(ids(verdict)).toEqual(["dependencyForbidden"]);
  });
});

describe("intent rows that can never be judged", () => {
  it("reports a dependency row naming an unknown project as intentUnknownProject", () => {
    const verdict = computeDrift(
      intent({
        forbiddenDependencies: [{ source: "typo", target: "lib" }],
      }),
      observed([project("lib")]),
    );
    expect(ids(verdict)).toEqual(["intentUnknownProject"]);
    expect(verdict.findings[0].row).toBe("typo");
  });

  it("deduplicates an unknown project named by several rows into one finding", () => {
    const verdict = computeDrift(
      intent({
        allowedDependencies: [{ source: "typo", target: "lib" }],
        forbiddenDependencies: [{ source: "typo", target: "other" }],
      }),
      observed([project("lib"), project("other")]),
    );
    expect(verdict.findings.filter((f) => f.messageId === "intentUnknownProject")).toHaveLength(1);
  });

  it("does not report intentUnknownProject for project-name positions that are known", () => {
    const verdict = computeDrift(
      intent({ forbiddenDependencies: [{ source: "app", target: "lib" }] }),
      observed([project("app"), project("lib")], [edge("app", "lib")]),
    );
    expect(ids(verdict)).not.toContain("intentUnknownProject");
  });

  it("reports a tag row carried by no observed project as intentUnknownTag", () => {
    const verdict = computeDrift(
      intent({ forbiddenTags: [{ from: "ghost", to: "layer:domain" }] }),
      observed([project("domain", ["layer:domain"])]),
    );
    expect(ids(verdict)).toEqual(["intentUnknownTag"]);
    expect(verdict.findings[0].row).toBe("ghost → layer:domain");
  });

  it("is silent about a tag row whose both tags are observed, even if no edge fires", () => {
    const verdict = computeDrift(
      intent({ forbiddenTags: [{ from: "a", to: "b" }] }),
      observed([project("x", ["a"]), project("y", ["b"])]),
    );
    expect(verdict.findings).toEqual([]);
  });
});

describe("multiple simultaneous drifts", () => {
  it("reports every distinct finding in a single run", () => {
    const verdict = computeDrift(
      intent({
        requiredProjects: [
          { name: "gone", tags: ["t"] },
          { name: "here", tags: ["missing"] },
        ],
        forbiddenProjects: [{ name: "legacy" }],
        forbiddenDependencies: [{ source: "app", target: "db" }],
        forbiddenTags: [{ from: "layer:adapter", to: "layer:domain" }],
      }),
      observed(
        [
          project("here", []),
          project("legacy"),
          project("app", ["layer:adapter"]),
          project("db", ["layer:domain"]),
          project("adapter", ["layer:adapter"]),
          project("domain", ["layer:domain"]),
        ],
        [edge("app", "db"), edge("adapter", "domain")],
      ),
    );
    expect(ids(verdict)).toEqual([
      "dependencyForbidden",
      "projectMissing",
      "projectPresent",
      "projectTagMissing",
      "tagDependencyForbidden",
    ]);
  });
});

describe("determinism", () => {
  // Feed the same intent and observed model in different orders; the verdict
  // must be byte-identical, including the finding order.
  const scenarios = [
    {
      name: "edge findings order by row, not by insertion order",
      intent: () =>
        intent({
          allowedDependencies: [
            { source: "zz-app", target: "lib" },
            { source: "aa-app", target: "lib" },
          ],
        }),
      observed: () =>
        observed(
          [project("lib"), project("zz-app"), project("aa-app"), project("unlisted")],
          [edge("zz-app", "lib"), edge("aa-app", "lib"), edge("unlisted", "lib")],
        ),
    },
    {
      name: "tag rows and edges are independent of their written order",
      intent: () =>
        intent({
          forbiddenTags: [
            { from: "z-tag", to: "lib" },
            { from: "a-tag", to: "lib" },
          ],
        }),
      observed: () =>
        observed(
          [project("z", ["z-tag"]), project("a", ["a-tag"]), project("lib", ["lib"])],
          [edge("z", "lib"), edge("a", "lib")],
        ),
    },
  ];

  it("is byte-identical across shuffled inputs, and the findings are sorted", () => {
    for (const { name, intent: makeIntent, observed: makeObserved } of scenarios) {
      const a = computeDrift(makeIntent(), makeObserved());
      const shuffledObserved = {
        projects: [...makeObserved().projects].reverse().sort((x, y) => (x.name < y.name ? -1 : 1)),
        edges: [...makeObserved().edges].reverse(),
      };
      const b = computeDrift(makeIntent(), shuffledObserved);
      expect(JSON.stringify(a.findings), name).toBe(JSON.stringify(b.findings));
      // The findings are in a total order — no two adjacent entries are out of
      // (messageId, row) order.
      const rows = a.findings.map((f) => `${f.messageId} ${f.row} ${f.detail}`);
      const sorted = [...rows].sort();
      expect(rows, name).toEqual(sorted);
    }
  });

  it("produces identical JSON for repeated runs over unchanged input", () => {
    const one = computeDrift(
      intent({ forbiddenDependencies: [{ source: "app", target: "db" }] }),
      observed([project("app"), project("db")], [edge("app", "db")]),
    );
    const two = computeDrift(
      intent({ forbiddenDependencies: [{ source: "app", target: "db" }] }),
      observed([project("app"), project("db")], [edge("app", "db")]),
    );
    expect(JSON.stringify(one.findings)).toBe(JSON.stringify(two.findings));
  });
});

describe("the finding taxonomy is closed and stable", () => {
  it("exposes exactly the ids the engine can emit, in catalogue order", () => {
    expect(DRIFT_MESSAGE_IDS).toEqual([
      "projectMissing",
      "projectPresent",
      "projectTagMissing",
      "dependencyForbidden",
      "dependencyNotAllowed",
      "tagDependencyForbidden",
      "intentUnknownProject",
      "intentUnknownTag",
    ]);
  });

  it("reports the intent row count", () => {
    const verdict = computeDrift(
      intent({
        requiredProjects: [{ name: "a", tags: [] }],
        forbiddenProjects: [{ name: "b" }],
        allowedDependencies: [{ source: "a", target: "c" }],
        forbiddenDependencies: [{ source: "a", target: "d" }],
        forbiddenTags: [{ from: "t1", to: "t2" }],
      }),
      observed([project("a", ["t1"]), project("c"), project("d", ["t2"])]),
    );
    expect(verdict.intentRows).toBe(5);
  });
});
