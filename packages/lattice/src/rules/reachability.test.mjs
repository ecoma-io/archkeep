import { describe, expect, it } from "vitest";

import {
  buildReachability,
  checkCircularPath,
  circularPathHasPair,
  expandIgnoredCircularDependencies,
  getPath,
  pathExists,
} from "./reachability.mjs";

const node = (name) => ({ name, type: "lib", data: { root: `area/${name}`, tags: [] } });

const graphOf = (names, dependencies = {}) => ({
  nodes: Object.fromEntries(names.map((name) => [name, node(name)])),
  dependencies,
});

const edge = (source, target) => ({ source, target, type: "static" });

describe("buildReachability", () => {
  it("closes over every chain of edges, not just the direct ones", () => {
    const graph = graphOf(["a", "b", "c"], { a: [edge("a", "b")], b: [edge("b", "c")] });
    const reach = buildReachability(graph);
    expect(pathExists(reach, "a", "c")).toBe(true);
    expect(pathExists(reach, "c", "a")).toBe(false);
  });

  it("treats a project as reaching itself, which is what makes a tag check include it", () => {
    expect(pathExists(buildReachability(graphOf(["a"])), "a", "a")).toBe(true);
  });

  it("terminates on a graph that cycles back on itself", () => {
    const graph = graphOf(["a", "b"], { a: [edge("a", "b")], b: [edge("b", "a")] });
    const reach = buildReachability(graph);
    expect(pathExists(reach, "a", "a")).toBe(true);
    expect(pathExists(reach, "b", "a")).toBe(true);
  });

  it("ignores edges pointing at nodes the graph does not have", () => {
    // External (npm) targets live in a separate map, and upstream's adjacency
    // list drops them the same way.
    const graph = graphOf(["a"], { a: [edge("a", "npm:some-package")] });
    expect(pathExists(buildReachability(graph), "a", "npm:some-package")).toBe(false);
  });

  it("survives a dependency list keyed on a project the graph does not have", () => {
    // Upstream indexes this unguarded and throws. An enforcer that crashes
    // reports nothing, which is the one outcome worse than a wrong answer.
    const graph = graphOf(["a"], { ghost: [edge("ghost", "a")] });
    expect(() => buildReachability(graph)).not.toThrow();
    expect(pathExists(buildReachability(graph), "a", "a")).toBe(true);
  });
});

describe("getPath", () => {
  it("returns the nodes along a route, source first", () => {
    const graph = graphOf(["a", "b", "c"], { a: [edge("a", "b")], b: [edge("b", "c")] });
    const path = getPath(buildReachability(graph), graph, "a", "c");
    expect(path.map((n) => n.name)).toEqual(["a", "b", "c"]);
  });

  it("returns nothing when the two are the same project", () => {
    const graph = graphOf(["a"]);
    expect(getPath(buildReachability(graph), graph, "a", "a")).toEqual([]);
  });

  it("returns nothing when no route exists", () => {
    const graph = graphOf(["a", "b"]);
    expect(getPath(buildReachability(graph), graph, "a", "b")).toEqual([]);
  });
});

describe("checkCircularPath", () => {
  it("looks for a route from the target back to the source, not the other way", () => {
    const graph = graphOf(["a", "b"], { b: [edge("b", "a")] });
    const path = checkCircularPath(buildReachability(graph), graph, graph.nodes.a, graph.nodes.b);
    expect(path.map((n) => n.name)).toEqual(["b", "a"]);
  });

  it("returns nothing for a target the graph does not contain", () => {
    const graph = graphOf(["a"]);
    expect(
      checkCircularPath(buildReachability(graph), graph, graph.nodes.a, node("absent")),
    ).toEqual([]);
  });
});

describe("circularPathHasPair", () => {
  const ignored = new Map([["a", new Set(["b"])]]);

  it("excuses a path containing an ignored hop", () => {
    expect(circularPathHasPair([node("a"), node("b")], ignored)).toBe(true);
  });

  it("does not excuse a path whose hops are all unlisted", () => {
    expect(circularPathHasPair([node("b"), node("a")], ignored)).toBe(false);
  });

  it("does not excuse a path with fewer than two nodes", () => {
    expect(circularPathHasPair([node("a")], ignored)).toBe(false);
  });
});

describe("expandIgnoredCircularDependencies", () => {
  const selectByName = (patterns, nodes) => patterns.filter((p) => nodes[p]);

  it("records both directions of every ignored pair", () => {
    const graph = graphOf(["a", "b"]);
    const ignored = expandIgnoredCircularDependencies([["a", "b"]], graph, selectByName);
    expect(ignored.get("a").has("b")).toBe(true);
    expect(ignored.get("b").has("a")).toBe(true);
  });

  it("returns an empty map when nothing is ignored", () => {
    expect(expandIgnoredCircularDependencies([], graphOf(["a"]), selectByName).size).toBe(0);
  });
});
