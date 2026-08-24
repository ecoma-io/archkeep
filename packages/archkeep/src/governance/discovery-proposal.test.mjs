import { describe, expect, it } from "vitest";

import {
  boundaryAssertions,
  candidateRules,
  CONFIDENCE,
  componentsByDirectory,
  dominantTags,
  evaluateDiscovery,
  tagAxes,
  tagVocabulary,
} from "./discovery-proposal.mjs";

// The proposal evaluator is the deterministic core of `discover --propose`.
// Every test here pins a concrete fact → concrete candidate derivation, and
// the empty-proposal invariant: a workspace with nothing observed must yield
// the unknown proposal, never a fabricated candidate set.

/** A project row the evaluator reads. */
const project = (name, root, tags = []) => ({ name, root, type: "lib", tags });

describe("componentsByDirectory", () => {
  it("groups projects by their root's first path segment", () => {
    const components = componentsByDirectory([
      project("app", "apps/app"),
      project("core", "libs/core"),
      project("util", "libs/util"),
    ]);
    expect(components.get("apps").map((p) => p.name)).toEqual(["app"]);
    expect(components.get("libs").map((p) => p.name)).toEqual(["core", "util"]);
  });

  it("roots a zero-segment project at the empty component", () => {
    const components = componentsByDirectory([project("rootapp", "")]);
    expect(components.get("").map((p) => p.name)).toEqual(["rootapp"]);
  });

  it("sorts members and keys deterministically, whatever order the input had", () => {
    const first = componentsByDirectory([
      project("util", "libs/util"),
      project("app", "apps/app"),
      project("core", "libs/core"),
    ]);
    const reversed = componentsByDirectory([
      project("core", "libs/core"),
      project("app", "apps/app"),
      project("util", "libs/util"),
    ]);
    expect([...first.keys()]).toEqual([...reversed.keys()]);
    expect(first.get("libs").map((p) => p.name)).toEqual(reversed.get("libs").map((p) => p.name));
  });
});

describe("dominantTags", () => {
  it("proposes a tag a strict majority of a component's projects share", () => {
    const tags = dominantTags(
      componentsByDirectory([
        project("core", "libs/core", ["layer:domain"]),
        project("domain", "libs/domain", ["layer:domain"]),
        project("util", "libs/util", ["layer:util"]),
      ]),
    );
    expect(tags).toEqual([{ tag: "layer:domain", component: "libs", members: ["core", "domain"] }]);
  });

  it("does not propose a tag that a minority of a component carries", () => {
    const tags = dominantTags(
      componentsByDirectory([
        project("a", "libs/a", ["scope:s"]),
        project("b", "libs/b", ["scope:s"]),
        project("c", "libs/c", ["scope:other"]),
        project("d", "libs/d", []),
      ]),
    );
    // 2 of 4 is not a strict majority.
    expect(tags).toEqual([]);
  });

  it("never proposes a tag from a single-project component", () => {
    const tags = dominantTags(
      componentsByDirectory([project("solo", "apps/solo", ["layer:domain"])]),
    );
    expect(tags).toEqual([]);
  });
});

describe("tagAxes", () => {
  it("derives an axis from the tag strings' shape", () => {
    const axes = tagAxes([
      project("a", "libs/a", ["scope:core", "layer:domain"]),
      project("b", "libs/b", ["scope:util"]),
    ]);
    expect(axes).toEqual([
      { axis: "layer", values: ["domain"] },
      { axis: "scope", values: ["core", "util"] },
    ]);
  });

  it("ignores a tag with no colon and one with an empty value", () => {
    const axes = tagAxes([project("a", "libs/a", ["naked", "scope:", "scope:core"])]);
    expect(axes).toEqual([{ axis: "scope", values: ["core"] }]);
  });
});

describe("boundaryAssertions", () => {
  it("proposes a component assertion per shared directory and an edge assertion per cross-component edge", () => {
    const assertions = boundaryAssertions({
      projects: [
        project("core", "libs/core"),
        project("util", "libs/util"),
        project("app", "apps/app"),
      ],
      edges: [
        { source: "app", target: "core", type: "static" },
        { source: "core", target: "util", type: "static" },
      ],
    });
    // libs members core+util share a component (component assertion); app→core
    // crosses components (edge assertion); core→util stays within libs (no
    // assertion — it observes no boundary crossing).
    expect(assertions).toHaveLength(2);
    expect(assertions.find((a) => a.kind === "component")?.component).toBe("libs");
    const edge = assertions.find((a) => a.kind === "edge");
    expect(edge).toEqual({
      kind: "edge",
      source: "app",
      target: "core",
      component: undefined,
      evidence: [{ kind: "observed-edge", source: "app", target: "core", type: "static" }],
      confidence: "medium",
    });
  });

  it("is silent on an intra-component edge — it observes no boundary crossing", () => {
    const assertions = boundaryAssertions({
      projects: [project("core", "libs/core"), project("util", "libs/util")],
      edges: [{ source: "core", target: "util", type: "static" }],
    });
    expect(assertions.filter((a) => a.kind === "edge")).toEqual([]);
  });

  it("drops an edge whose source or target is not an observed project", () => {
    const assertions = boundaryAssertions({
      projects: [project("core", "libs/core")],
      edges: [{ source: "core", target: "npm:lodash", type: "static" }],
    });
    expect(assertions.filter((a) => a.kind === "edge")).toEqual([]);
  });
});

describe("tagVocabulary", () => {
  it("proposes observed tags and suggested axes with distinct confidence markers", () => {
    const vocabulary = tagVocabulary([
      project("core", "libs/core", ["layer:domain"]),
      project("domain", "libs/domain", ["layer:domain", "scope:domain"]),
    ]);
    const observed = vocabulary.find((v) => v.kind === "observed");
    const suggestedScope = vocabulary.find((v) => v.kind === "suggested" && v.axis === "scope");
    const suggestedLayer = vocabulary.find((v) => v.kind === "suggested" && v.axis === "layer");
    expect(observed).toMatchObject({ kind: "observed", tag: "layer:domain", confidence: "high" });
    expect(observed.evidence[0].kind).toBe("majority-shared-tag");
    expect(suggestedScope).toMatchObject({ kind: "suggested", axis: "scope", confidence: "low" });
    expect(suggestedScope.evidence[0].kind).toBe("tag-shape");
    expect(suggestedLayer).toMatchObject({ axis: "layer", values: ["domain"] });
    // The same tag value across two projects is deduplicated in the values list.
    expect(suggestedLayer.values).toEqual(["domain"]);
  });
});

describe("candidateRules", () => {
  it("derives a noDependency rule from each cross-component edge assertion and a boundary rule from each component assertion", () => {
    const rules = candidateRules([
      {
        kind: "edge",
        source: "app",
        target: "core",
        evidence: [{ kind: "observed-edge", source: "app", target: "core" }],
        confidence: "medium",
      },
      {
        kind: "component",
        component: "libs",
        evidence: [{ kind: "shared-directory", project: "core", directory: "libs" }],
        confidence: "medium",
      },
    ]);
    expect(rules).toEqual([
      {
        kind: "boundary",
        source: undefined,
        target: undefined,
        component: "libs",
        evidence: [{ kind: "shared-directory", project: "core", directory: "libs" }],
        confidence: "medium",
      },
      {
        kind: "noDependency",
        source: "app",
        target: "core",
        component: undefined,
        evidence: [{ kind: "observed-edge", source: "app", target: "core" }],
        confidence: "medium",
      },
    ]);
  });
});

describe("evaluateDiscovery", () => {
  it("yields the unknown proposal on an empty workspace, never fabricated candidates", () => {
    const proposal = evaluateDiscovery({ projects: [], edges: [] });
    expect(proposal.unknown).toBe(true);
    expect(proposal.proposed).toBe(true);
    expect(proposal.notAuthoritative).toBe(true);
    expect(proposal.components).toEqual({ items: [], total: 0 });
    expect(proposal.boundaryAssertions).toEqual({ items: [], total: 0 });
    expect(proposal.tagVocabulary).toEqual({ items: [], total: 0 });
    expect(proposal.rules).toEqual({ items: [], total: 0 });
    expect(proposal.uncertainty).toEqual({ high: 0, medium: 0, low: 0 });
  });

  it("is deterministic — two runs over the same model produce byte-identical proposals", () => {
    const observed = {
      projects: [
        project("app", "apps/app", ["layer:app"]),
        project("core", "libs/core", ["layer:domain"]),
        project("util", "libs/util", ["layer:domain"]),
      ],
      edges: [{ source: "app", target: "core", type: "static" }],
    };
    const first = JSON.stringify(evaluateDiscovery(observed));
    const second = JSON.stringify(evaluateDiscovery(JSON.parse(JSON.stringify(observed))));
    expect(second).toBe(first);
  });

  it("marks every candidate proposed and not authoritative", () => {
    const proposal = evaluateDiscovery({
      projects: [project("a", "libs/a", ["scope:s"]), project("b", "libs/b", ["scope:s"])],
      edges: [],
    });
    for (const list of [
      proposal.components.items,
      proposal.boundaryAssertions.items,
      proposal.tagVocabulary.items,
      proposal.rules.items,
    ]) {
      for (const item of list) {
        expect(item.proposed).toBe(true);
        expect(item.notAuthoritative).toBe(true);
      }
    }
  });

  it("assigns every candidate one of the three bounded confidence markers", () => {
    const proposal = evaluateDiscovery({
      projects: [
        project("app", "apps/app", ["layer:app"]),
        project("core", "libs/core", ["layer:domain"]),
        project("util", "libs/util", ["layer:domain"]),
      ],
      edges: [{ source: "app", target: "core", type: "static" }],
    });
    const all = [
      ...proposal.components.items,
      ...proposal.boundaryAssertions.items,
      ...proposal.tagVocabulary.items,
      ...proposal.rules.items,
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const item of all) {
      expect(CONFIDENCE.includes(item.confidence)).toBe(true);
    }
    // The uncertainty rollup counts exactly the candidates emitted.
    expect(proposal.uncertainty.high + proposal.uncertainty.medium + proposal.uncertainty.low).toBe(
      all.length,
    );
  });
});
