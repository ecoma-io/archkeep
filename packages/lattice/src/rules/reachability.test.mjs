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

  it("answers a graph with no nodes or dependencies at all", () => {
    // The null-prototype and defensive `?? {}` reads must survive a graph
    // that is only a shape, not a tree.
    const reach = buildReachability({});
    expect(pathExists(reach, "a", "b")).toBe(false);
  });

  it("survives a dependency key whose value is not a list", () => {
    const graph = graphOf(["a"], { a: undefined });
    expect(() => buildReachability(graph)).not.toThrow();
  });

  it("keeps a project literally named __proto__ in the closure, like every other name", () => {
    // G-01 sibling: `adjList` and `matrix` are keyed by project NAME, and names
    // come from attacker-controlled manifests. A plain `{}` answered
    // `adjList["__proto__"] = []` by repointing the map's OWN prototype, so
    // the project vanished from the closure and `adjList["__proto__"]` read a
    // poisoned prototype back — a Node object, whose `.filter`/`.push` are not
    // functions. That is the exact `adjList[current].filter is not a function`
    // diagnostic an LSP editor published in place of a boundary verdict. The
    // graph fixture itself must be null-prototype too, or `Object.keys` drops
    // the name before this function ever sees it.
    const nodes = Object.create(null);
    nodes.child = node("child");
    nodes.__proto__ = node("__proto__");
    const dependencies = Object.create(null);
    dependencies.child = [edge("child", "__proto__")];
    const graph = { nodes, dependencies };

    const reach = buildReachability(graph);

    expect(pathExists(reach, "child", "__proto__")).toBe(true);
    expect(pathExists(reach, "__proto__", "__proto__")).toBe(true);
    expect(pathExists(reach, "__proto__", "child")).toBe(false);
    expect(Object.keys(reach.adjList)).toContain("__proto__");
    expect(Object.keys(reach.matrix)).toContain("__proto__");
    expect(reach.adjList.__proto__).toEqual([]);
  });

  it("does not invent reach into a __proto__ project no edge leads to", () => {
    // The silent-direction half the previous case cannot see: with NO edge into
    // `__proto__`, a plain `{}` matrix row answers `matrix.child.__proto__`
    // with the inherited accessor (truthy `Object.prototype`), so a
    // `notDependOnLibsWithTags` check against an unreachable `__proto__`
    // project would report a violation that is not real — a born-again
    // prototype pollution exactly one key deeper than the outer maps. With
    // null-prototype rows the read is `undefined` and the answer is the false
    // that matches there being no path.
    const nodes = Object.create(null);
    nodes.child = node("child");
    nodes.__proto__ = node("__proto__");
    const reach = buildReachability({ nodes, dependencies: Object.create(null) });

    expect(pathExists(reach, "child", "__proto__")).toBe(false);
    expect(Object.keys(reach.matrix.child)).not.toContain("__proto__");
  });

  it("walks a route through a __proto__ project instead of skipping it", () => {
    // The other silent direction: a route that RUNS THROUGH a `__proto__`
    // project. With plain `{}` rows the walk's `if (matrix[start][adj])` sees
    // `__proto__` as already-reached on every read (inherited accessor again),
    // bails, and declares `grandchild` unreachable from `child` — dropping a
    // real violation. A null-prototype row records the real `__proto__`-indexed
    // writes, so the closure completes.
    const nodes = Object.create(null);
    nodes.child = node("child");
    nodes.__proto__ = node("__proto__");
    nodes.grandchild = node("grandchild");
    const dependencies = Object.create(null);
    dependencies.child = [edge("child", "__proto__")];
    dependencies.__proto__ = [edge("__proto__", "grandchild")];
    const reach = buildReachability({ nodes, dependencies });

    expect(pathExists(reach, "child", "__proto__")).toBe(true);
    expect(pathExists(reach, "__proto__", "grandchild")).toBe(true);
    expect(pathExists(reach, "child", "grandchild")).toBe(true);
    // The hop was recorded as an own entry in the row, not skipped.
    expect(reach.matrix.child.__proto__).toBe(true);
    expect(Object.keys(reach.matrix.child)).toContain("__proto__");
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

  it("returns nothing for a source the graph does not contain", () => {
    const graph = graphOf(["a"]);
    expect(getPath(buildReachability(graph), graph, "ghost", "a")).toEqual([]);
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

  it("expands a pair whose two sides overlap", () => {
    // A pair like `["a", "a"]` matches the same project on both sides; the
    // second direction's guards must read the set the first direction just
    // wrote, not double-register it.
    const graph = graphOf(["a", "b"]);
    const ignored = expandIgnoredCircularDependencies([["a", "a"]], graph, selectByName);
    expect(ignored.get("a")).toEqual(new Set(["a"]));
  });
});
