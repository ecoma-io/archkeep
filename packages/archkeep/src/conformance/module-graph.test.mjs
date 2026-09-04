/**
 * The engine's module graph must stay acyclic — and this file is the gate that
 * says so instead of assuming it.
 *
 * Until #644 the engine carried exactly one import cycle:
 * `src/commands/evaluation-primitives.mjs` → `src/commands/impact.mjs` →
 * `src/commands/impact-statement.mjs` → `src/commands/evaluation-primitives.mjs`.
 * ESM tolerates a cycle at runtime (bindings are hoisted before use), so
 * nothing failed — which is the whole problem: a cycle is byte-for-byte
 * indistinguishable from a clean graph, the silent direction
 * `../../../../AGENTS.md` is written against, and it forces the three modules
 * to load together with no dependency-order reasoning left. This guard walks
 * the static runtime import graph of the shipped surface and fails, naming the
 * cycle, the moment one forms again.
 *
 * Scope, and why each boundary sits where it sits:
 *
 *  - **Nodes** are the package's published entries and bins (read from
 *    `package.json`'s `exports`/`bin`, never a second list) plus every
 *    non-test `.mjs` under `src/`, grown by transitive closure over relative
 *    imports. A module reachable from a published entry is part of the shipped
 *    runtime no matter which directory it sits in, so the closure — not a
 *    directory list — decides what is scanned.
 *  - **Edges** are static `import … from` / `export … from` statements only.
 *    A dynamic `import()` is the package's laziness mechanism
 *    (`src/config.mjs`'s dialect import, `src/analysis/vue.mjs`'s compiler),
 *    and a cycle through a lazily-resolved module is a different finding with
 *    a different fix; folding it in here would also make this verdict depend
 *    on which spellings of `import(` happen to appear. Bare specifiers are
 *    outside the package and owned by `./boundary.test.mjs`'s allow-list.
 *  - **Comments and strings do not produce edges.** The issue that found the
 *    real cycle also found a near-miss: a JSDoc type annotation in
 *    `src/analysis/typescript.mjs` names `./analyze.mjs` without importing it,
 *    and a guard that counted it would report a cycle nobody can remove.
 *    Every match is therefore validated against `../intent/mask-non-code.mjs`'s
 *    position-preserving mask — a match survives only where the masked text
 *    still shows code at the same offset. The masker is reused rather than
 *    rewritten because it is the one scanner here whose comment/string
 *    classification is already pinned by its own tests.
 *
 * The guard proves its own teeth before it proves the tree: the first two
 * tests run the detector and the extractor over synthetic input with a known
 * answer, so a detector that silently stopped detecting (the guard's own
 * silent direction) cannot sit green under a clean tree.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { maskNonCode } from "../intent/mask-non-code.mjs";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Static-import spellings, one regex per shape. Each captures the specifier
 * in group 1. Deliberately line-unanchored: an `import { a, b } from "…"`
 * spans lines in this tree, and a line-anchored scanner would drop that edge
 * in the silent direction — the exact bug a cycle guard must not have.
 *
 * @type {RegExp[]}
 */
const STATIC_IMPORT_PATTERNS = [
  /\bimport\s*\{[^}]*\}\s*from\s*["']([^"']+)["']/g,
  /\bimport\s*\*\s*as\s+[\w$]+\s*from\s*["']([^"']+)["']/g,
  /\bimport\s+[\w$]+\s*(?:,\s*(?:\{[^}]*\}|\*\s*as\s+[\w$]+\}))?\s*from\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bexport\s*\{[^}]*\}\s*from\s*["']([^"']+)["']/g,
  /\bexport\s*\*\s*from\s*["']([^"']+)["']/g,
  /\bexport\s*\*\s*as\s+[\w$]+\s*from\s*["']([^"']+)["']/g,
];

/**
 * The static relative import specifiers of one module's source text, comments,
 * strings, template literals and regex literals excluded.
 *
 * A match is kept only where `maskNonCode` still shows the source character at
 * the match's own offset — inside a masked region the character is a space,
 * and a specifier spelled in prose is a citation, not an edge.
 *
 * @param {string} raw Module source text.
 * @returns {{specifier: string, offset: number}[]} In source order.
 */
export function staticRelativeImports(raw) {
  const masked = maskNonCode(raw);
  const found = [];
  for (const pattern of STATIC_IMPORT_PATTERNS) {
    for (const match of raw.matchAll(pattern)) {
      if (masked[match.index] !== raw[match.index]) continue;
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue; // bare or node: — outside the package
      found.push({ specifier, offset: match.index });
    }
  }
  // One pattern per import shape, so the same statement can be reached by two
  // patterns' scan order and not by either's source position — the walk is
  // edge-collecting, but a caller reading the list should still see the file
  // it read.
  found.sort((a, b) => a.offset - b.offset);
  return found;
}

/**
 * Resolves one relative specifier to a package-root-relative posix key.
 *
 * @param {string} fromKey The importing module's package-root-relative key.
 * @param {string} specifier The relative specifier as written.
 * @returns {string}
 */
function resolveKey(fromKey, specifier) {
  return posix.normalize(posix.join(posix.dirname(fromKey), specifier));
}

/**
 * Walks the shipped surface and returns its static import graph.
 *
 * Seeds are the published entries and bins (`package.json`'s `exports`/`bin`
 * `.mjs` values) and every non-test `.mjs` under `src/`; any relative import
 * landing on another `.mjs` file of the package joins the graph too, so a
 * module a published entry reaches is scanned no matter where it sits. A
 * relative specifier that does not resolve to a scanned module is reported in
 * `dangling` rather than dropped — an edge nobody can see is a cycle the guard
 * would never find.
 *
 * @returns {{nodes: string[], edges: Map<string, string[]>, dangling: string[]}}
 */
export function collectModuleGraph() {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
  /** @type {string[]} */
  const nodes = [];
  const isTest = (key) => /\.test\.mjs$/.test(key);
  /** @param {string} key */
  const seed = (key) => {
    if (key.startsWith("e2e/") || isTest(key) || !key.endsWith(".mjs")) return;
    const path = join(PACKAGE_ROOT, key);
    if (!existsSync(path) || !statSync(path).isFile()) return;
    if (!nodes.includes(key)) nodes.push(key);
  };
  for (const value of Object.values(pkg.exports ?? {})) {
    if (typeof value === "string") seed(posix.normalize(value));
  }
  for (const value of Object.values(pkg.bin ?? {})) seed(posix.normalize(value));
  for (const entry of readdirSync(join(PACKAGE_ROOT, "src"), { recursive: true })) {
    seed(posix.join("src", String(entry)));
  }
  // Closure: an import target that exists in the package is part of the
  // shipped runtime, so it joins the scan even when no directory walk named it.
  for (let i = 0; i < nodes.length; i++) {
    const raw = readFileSync(join(PACKAGE_ROOT, nodes[i]), "utf8");
    for (const { specifier } of staticRelativeImports(raw)) {
      seed(resolveKey(nodes[i], specifier));
    }
  }

  /** @type {Map<string, string[]>} */
  const edges = new Map();
  /** @type {string[]} */
  const dangling = [];
  for (const key of nodes) {
    const raw = readFileSync(join(PACKAGE_ROOT, key), "utf8");
    const targets = new Set();
    for (const { specifier } of staticRelativeImports(raw)) {
      const target = resolveKey(key, specifier);
      if (nodes.includes(target)) targets.add(target);
      else dangling.push(`${key} -> ${specifier} (resolved ${target})`);
    }
    edges.set(key, [...targets].sort());
  }
  return { nodes, edges, dangling };
}

/**
 * Tarjan's strongly-connected components over an adjacency map.
 *
 * @param {Map<string, string[]>} edges
 * @returns {string[][]} One component per entry; a component of length > 1
 *   is a cycle, and so is a length-1 component importing itself.
 */
export function stronglyConnectedComponents(edges) {
  const indexOf = new Map();
  const lowOf = new Map();
  const onStack = new Set();
  /** @type {string[]} */
  const stack = [];
  /** @type {string[][]} */
  const components = [];
  let counter = 0;
  const walk = (v) => {
    indexOf.set(v, counter);
    lowOf.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!edges.has(w)) continue;
      if (!indexOf.has(w)) {
        walk(w);
        lowOf.set(v, Math.min(lowOf.get(v), lowOf.get(w)));
      } else if (onStack.has(w)) {
        lowOf.set(v, Math.min(lowOf.get(v), indexOf.get(w)));
      }
    }
    if (lowOf.get(v) === indexOf.get(v)) {
      const component = [];
      for (;;) {
        const w = stack.pop();
        onStack.delete(w);
        component.push(w);
        if (w === v) break;
      }
      components.push(component);
    }
  };
  for (const v of edges.keys()) if (!indexOf.has(v)) walk(v);
  return components;
}

/**
 * One concrete cycle through a component, as `[a, b, …, a]` — the shape an
 * error message needs, since a bare member list does not say in which order
 * the imports close the loop.
 *
 * @param {string[]} component A strongly-connected component with a cycle.
 * @param {Map<string, string[]>} edges
 * @returns {string[]}
 */
export function cyclePathThrough(component, edges) {
  const members = new Set(component);
  const start = component[0];
  /** @type {string[]} */
  const path = [start];
  /** @type {Map<string, string>} */
  const parent = new Map();
  /** @type {string[]} */
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of edges.get(current) ?? []) {
      if (!members.has(next)) continue;
      if (next === start) {
        // Reconstruct the walked path from `start` to `current`, then close
        // the loop back to `start`.
        /** @type {string[]} */
        const walked = [];
        let step = current;
        while (step !== undefined && step !== start) {
          walked.push(step);
          step = parent.get(step);
        }
        walked.reverse();
        return [start, ...walked, start];
      }
      if (parent.has(next) || path.includes(next)) continue;
      parent.set(next, current);
      path.push(next);
      queue.push(next);
    }
  }
  return component.sort(); // unreachable for a cyclic component; never silent
}

/** @returns {Map<string, string[]>} An adjacency map from a `{node: targets}` record. */
function graphOf(record) {
  return new Map(Object.entries(record).map(([k, v]) => [k, v]));
}

describe("module graph guard — the detector", () => {
  it("reports a synthetic three-module cycle and names its path", () => {
    const cyclic = graphOf({
      "src/a.mjs": ["src/b.mjs"],
      "src/b.mjs": ["src/c.mjs"],
      "src/c.mjs": ["src/a.mjs"],
      "src/standalone.mjs": [],
    });
    const components = stronglyConnectedComponents(cyclic);
    const cyclicComponents = components.filter(
      (c) => c.length > 1 || edgesOf(cyclic, c[0]).includes(c[0]),
    );
    expect(cyclicComponents).toHaveLength(1);
    // The path must be A cycle through the component — closed, entirely made
    // of the component's members, every hop a real edge — not one specific
    // rotation of it: which module the walk starts from is an artifact of the
    // component's construction order, not a fact worth pinning.
    const path = cyclePathThrough(cyclicComponents[0], cyclic);
    expect(path[0]).toBe(path[path.length - 1]);
    expect([...path.slice(0, -1)].sort()).toEqual(cyclicComponents[0].slice().sort());
    for (let i = 0; i < path.length - 1; i++) {
      expect(edgesOf(cyclic, path[i])).toContain(path[i + 1]);
    }
  });

  it("passes an acyclic graph — a diamond is not a cycle", () => {
    const acyclic = graphOf({
      "src/top.mjs": ["src/left.mjs", "src/right.mjs"],
      "src/left.mjs": ["src/base.mjs"],
      "src/right.mjs": ["src/base.mjs"],
      "src/base.mjs": [],
    });
    const components = stronglyConnectedComponents(acyclic);
    expect(components.filter((c) => c.length > 1)).toEqual([]);
  });
});

/** @returns {string[]} The recorded edge list of `edges` for `key`. */
function edgesOf(edges, key) {
  return edges.get(key) ?? [];
}

describe("module graph guard — the extractor", () => {
  it("reads an import that spans lines — the shape a line-anchored scan drops", () => {
    const raw = [
      "import {",
      "  buildCompleteness,",
      "  evaluationStatus,",
      '} from "./completeness.mjs";',
      "export const x = 1;",
    ].join("\n");
    expect(staticRelativeImports(raw).map((e) => e.specifier)).toEqual(["./completeness.mjs"]);
  });

  it("reads a default, namespace, side-effect and export-from spelling", () => {
    const raw = [
      'import computeImpact from "./a.mjs";',
      'import * as ns from "./b.mjs";',
      'import "./c.mjs";',
      'export { helper } from "./d.mjs";',
      'export * from "./e.mjs";',
    ].join("\n");
    expect(staticRelativeImports(raw).map((e) => e.specifier)).toEqual([
      "./a.mjs",
      "./b.mjs",
      "./c.mjs",
      "./d.mjs",
      "./e.mjs",
    ]);
  });

  it("does not count a JSDoc type annotation as an edge — the near-miss the real cycle was found beside", () => {
    const raw = [
      "/**",
      ' * @throws {import("../errors.mjs").UsageError} when the project is unknown.',
      " */",
      "export function f() {}",
    ].join("\n");
    expect(staticRelativeImports(raw)).toEqual([]);
  });

  it("does not count a specifier spelled inside a string or a template literal", () => {
    const raw = [
      "const quoted = \"import { x } from './quoted.mjs';\";",
      'const template = `see import { y } from "./templated.mjs" for details`;',
      '// import { z } from "./commented.mjs";',
      '/* import { w } from "./blocked.mjs"; */',
      "export const done = 1;",
    ].join("\n");
    expect(staticRelativeImports(raw)).toEqual([]);
  });

  it("does not count a dynamic import() — the package's laziness mechanism, not a static edge", () => {
    const raw = ['const load = () => import("./lazy.mjs");', "export { load };"].join("\n");
    expect(staticRelativeImports(raw)).toEqual([]);
  });
});

describe("module graph guard — the shipped tree", () => {
  const { nodes, edges, dangling } = collectModuleGraph();

  it("scans the shipped surface", () => {
    // A guard that accidentally walked nothing reports any graph clean, so the
    // size itself is load-bearing: far below the real module count means the
    // walk broke, not that the tree got small. Pinned as a floor, never a
    // ceiling — new modules must join the scan, not be excused from it.
    expect(nodes.length).toBeGreaterThan(100);
    expect(nodes).toContain("src/commands/impact.mjs");
    expect(nodes).toContain("src/commands/evaluation-primitives.mjs");
    expect(nodes).toContain("src/commands/impact-statement.mjs");
  });

  it("every relative import resolves to a scanned module — nothing is dropped from the graph", () => {
    expect(dangling).toEqual([]);
  });

  it("the shipped module graph is acyclic", () => {
    const selfLoops = [...edges.entries()]
      .filter(([key, targets]) => targets.includes(key))
      .map(([key]) => key);
    const cyclic = stronglyConnectedComponents(edges).filter((c) => c.length > 1);
    const report = [
      ...selfLoops.map((key) => `${key} imports itself`),
      ...cyclic.map((c) => cyclePathThrough(c, edges).join(" -> ")),
    ];
    expect(report).toEqual([]);
  });
});
