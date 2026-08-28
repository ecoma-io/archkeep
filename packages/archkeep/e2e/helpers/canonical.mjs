// The canonical oracle: one hand-authored architecture, written down here
// once, that every provider fixture expresses in its own config language, and
// the assertions that compare a real graph against it.
//
// Provider-independent by construction: an edge is identified by its
// (source, target) pair and nothing else. `type` (static/implicit/dynamic)
// and `sourceFile` are provider-specific contracts — the Nx hook face
// deliberately emits two records for one agreeing pair while the engine's
// semantic graph emits one — so the oracle must never compare them, or a
// correct provider fails and a wrong one passes for the wrong reason.
//
// The topology is the branching diamond:
//
//   core ← application ← api
//            │
//            └→ infrastructure
//
// Every assertion here fails loudly on all four silent directions: a missing
// edge, an unexpected edge, a reversed edge, and a duplicated pair. An empty
// actual set therefore fails as "missing", never passes as "equal".

/** The canonical projects. `tooling` exists only as a mutation target. */
export const CANONICAL_PROJECTS = ["core", "application", "api", "infrastructure"];

/** The canonical edges as (source, target) pairs. */
export const CANONICAL_EDGES = [
  { source: "application", target: "core" },
  { source: "api", target: "application" },
  { source: "application", target: "infrastructure" },
];

/** The canonical architecture: the one diagram every provider must draw. */
export const CANONICAL = { projects: CANONICAL_PROJECTS, edges: CANONICAL_EDGES };

/**
 * The pair identity of one edge — `"source->target"`.
 *
 * @param {{source: string, target: string}} edge Any source/target pair.
 * @returns {string} The canonical pair key.
 */
export function canonicalPair(edge) {
  if (typeof edge?.source !== "string" || typeof edge?.target !== "string") {
    throw new Error(`edge without a source/target pair: ${JSON.stringify(edge)}`);
  }
  return `${edge.source}->${edge.target}`;
}

/**
 * The canonical boundary law for the canonical tags. Hand-written: the same
 * `layer/<name>` vocabulary the fixtures put on their projects, permitting
 * downward dependencies only. All eight `moduleBoundaryOptions` are stated
 * because the loader defaults nothing.
 *
 * The separator is `/`, not the more conventional `:`: a moon tag may only
 * contain alphanumeric characters, dashes, slashes, underscores, and periods
 * (measured against `moon project-graph --json`, `@moonrepo/cli` 2.4.6 — a
 * `layer:` tag aborts the provider's whole project graph), and the one
 * canonical architecture must be spellable in every provider's config
 * language without a provider-private translation.
 */
export const CANONICAL_BOUNDARY_CONFIG = `export const depConstraints = [
  { sourceTag: "layer/core", onlyDependOnLibsWithTags: ["layer/core"] },
  { sourceTag: "layer/infrastructure", onlyDependOnLibsWithTags: ["layer/infrastructure", "layer/core"] },
  { sourceTag: "layer/application", onlyDependOnLibsWithTags: ["layer/application", "layer/core", "layer/infrastructure"] },
  { sourceTag: "layer/api", onlyDependOnLibsWithTags: ["layer/api", "layer/application", "layer/core", "layer/infrastructure"] },
];

export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};

export const boundarySuppressions = [];
`;

/**
 * Tags a canonical project carries in every fixture.
 *
 * @param {string} project A canonical project name.
 * @returns {string[]} Its `layer/` tags.
 */
export function canonicalTags(project) {
  return [`layer/${project}`];
}

/**
 * Assert the actual project-name set equals the expected set exactly.
 *
 * @param {string[]} actualNames Names read off a graph envelope.
 * @param {string[]} [expected] Defaults to the canonical projects.
 */
export function assertCanonicalProjects(actualNames, expected = CANONICAL.projects) {
  const actual = [...actualNames].sort();
  const expectedSorted = [...expected].sort();
  const missing = expectedSorted.filter((name) => !actual.includes(name));
  const unexpected = actual.filter((name) => !expectedSorted.includes(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `project set mismatch\n  missing: ${missing.join(", ") || "(none)"}\n  unexpected: ${
        unexpected.join(", ") || "(none)"
      }`,
    );
  }
}

/**
 * Assert the actual edge list equals the expected pair set exactly — no
 * missing edge, no unexpected edge, no reversed pair reported as a bare
 * "unexpected", and no pair appearing twice.
 *
 * @param {Array<{source: string, target: string, type?: string}>} actualEdges
 *   Edges read off a graph envelope's `dependencies`.
 * @param {Array<{source: string, target: string}>} [expected] Defaults to the
 *   canonical edges.
 */
export function assertCanonicalEdges(actualEdges, expected = CANONICAL.edges) {
  const byPair = new Map();
  for (const edge of actualEdges) {
    const pair = canonicalPair(edge);
    if (!byPair.has(pair)) {
      byPair.set(pair, []);
    }
    byPair.get(pair).push(edge);
  }

  const duplicates = [...byPair.entries()].filter(([, records]) => records.length > 1);
  if (duplicates.length > 0) {
    throw new Error(
      `duplicate edge records — the same source→target pair more than once\n${duplicates
        .map(
          ([pair, records]) =>
            `  ${pair} ×${records.length} (types: ${records.map((r) => r.type ?? "?").join(", ")})`,
        )
        .join("\n")}`,
    );
  }

  const expectedPairs = expected.map((edge) => canonicalPair(edge));
  const actualPairs = [...byPair.keys()];
  const expectedSet = new Set(expectedPairs);
  const actualSet = new Set(actualPairs);

  const missing = expectedPairs.filter((pair) => !actualSet.has(pair));
  const reversed = missing.filter((pair) => {
    const [source, target] = pair.split("->");
    return actualSet.has(`${target}->${source}`) && !expectedSet.has(`${target}->${source}`);
  });
  const unexpected = actualPairs.filter((pair) => !expectedSet.has(pair));

  const lines = [];
  if (missing.length > 0) {
    lines.push(`  missing: ${missing.sort().join(", ")}`);
  }
  if (reversed.length > 0) {
    lines.push(
      `  reversed: ${reversed
        .sort()
        .map((pair) => {
          const [source, target] = pair.split("->");
          return `expected ${pair}, found ${target}->${source}`;
        })
        .join("; ")}`,
    );
  }
  if (unexpected.length > 0) {
    lines.push(`  unexpected: ${unexpected.sort().join(", ")}`);
  }
  if (lines.length > 0) {
    throw new Error(`edge set mismatch\n${lines.join("\n")}`);
  }
}

/**
 * Assert a whole graph envelope result against the canonical architecture.
 *
 * @param {{projects?: Array<string | {name: string}>, dependencies?: Array<{source: string, target: string}>, coverage?: {complete?: boolean, notAnalyzed?: Array<{file: string}>}}} result
 *   The `result` object of a `graph --format json` envelope.
 * @param {{projects: string[], edges: Array<{source: string, target: string}>}} [expected]
 *   Defaults to the canonical architecture.
 */
export function assertCanonicalGraph(result, expected = CANONICAL) {
  const projects = (result.projects ?? []).map((project) =>
    typeof project === "string" ? project : project.name,
  );
  assertCanonicalProjects(projects, expected.projects);
  assertCanonicalEdges(result.dependencies ?? [], expected.edges);
}

/**
 * Assert a diff result's five delta arrays exactly — every added/removed
 * edge by pair, every added/removed/changed project by name, order-insensitive,
 * and nothing extra in either direction.
 *
 * Project identity is the name. `diff`'s project arrays carry whole project
 * objects (`computeDiff` in `src/commands/diff.mjs` documents them as
 * `object[]`), so actual entries are normalized through `string | {name}`
 * exactly like the graph envelope's `projects` — the name is the contract,
 * the rest of the object is not.
 *
 * Edges are pairs in the registry, but `diff` moves RECORDS, and a record's
 * identity is `(source, target, type)` — the providers dedupe on that triple
 * (`src/governance/fitness-rules.mjs` states it where it first mattered), so
 * one pair can legitimately leave or enter twice on a provider whose graph
 * carries it through two channels (Moon: a TypeScript import as `static` and
 * a `dependsOn` as `implicit`). `recordsPerPair` states how many records one
 * pair of the registry row must move as: the default 1 asserts each pair
 * exactly once, 2 asserts exactly twice — under-tracking one channel fails
 * the same way over-tracking a third would.
 *
 * @param {{addedEdges?: Array<{source: string, target: string}>, removedEdges?: Array<{source: string, target: string}>, addedProjects?: Array<string | {name: string}>, removedProjects?: Array<string | {name: string}>, changedProjects?: Array<string | {name: string}>}} actual
 *   The `result` object of a `diff` envelope.
 * @param {{addedEdges?: Array<{source: string, target: string} | string>, removedEdges?: Array<{source: string, target: string} | string>, addedProjects?: string[], removedProjects?: string[], changedProjects?: string[]}} [expected]
 *   Defaults to the empty delta.
 * @param {{recordsPerPair?: number}} [options] How many records one
 *   registry pair must move as (default 1).
 */
export function assertDelta(actual, expected = {}, { recordsPerPair = 1 } = {}) {
  if (!Number.isInteger(recordsPerPair) || recordsPerPair < 1) {
    throw new Error(`recordsPerPair must be a positive integer, got ${recordsPerPair}`);
  }
  const want = {
    addedEdges: [],
    removedEdges: [],
    addedProjects: [],
    removedProjects: [],
    changedProjects: [],
    ...expected,
  };

  for (const key of ["addedProjects", "removedProjects", "changedProjects"]) {
    const actualSorted = (actual[key] ?? [])
      .map((project) => (typeof project === "string" ? project : project.name))
      .sort();
    const expectedSorted = [...want[key]].sort();
    if (
      actualSorted.length !== expectedSorted.length ||
      actualSorted.some((name, index) => name !== expectedSorted[index])
    ) {
      throw new Error(
        `${key} mismatch\n  expected: ${expectedSorted.join(", ") || "(none)"}\n  actual:   ${
          actualSorted.join(", ") || "(none)"
        }`,
      );
    }
  }

  for (const key of ["addedEdges", "removedEdges"]) {
    const actualPairs = (actual[key] ?? []).map(canonicalPair).sort();
    const registryPairs = want[key].map((edge) =>
      typeof edge === "string" ? edge : canonicalPair(edge),
    );
    const expectedPairs = registryPairs
      .flatMap((pair) => Array.from({ length: recordsPerPair }, () => pair))
      .sort();
    if (
      actualPairs.length !== expectedPairs.length ||
      actualPairs.some((pair, index) => pair !== expectedPairs[index])
    ) {
      throw new Error(
        `${key} mismatch\n  expected: ${expectedPairs.join(", ") || "(none)"}\n  actual:   ${
          actualPairs.join(", ") || "(none)"
        }`,
      );
    }
  }
}
