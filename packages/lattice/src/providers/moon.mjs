/**
 * The Moon project-model provider: `.moon/` or `.config/moon/` directory, no Nx installed.
 *
 * A Moonrepo workspace is identified by a `.moon/` directory at its root.
 * Moonrepo v2.0+ also supports `.config/moon/` as an alternative config
 * directory; which one a given root carries is answered by `moonMarkerAt`
 * below — the one dispatcher every consumer shares, and the place a root
 * carrying both is refused. The winner is recorded in the `CommandContext`'s
 * `marker` field (`../commands/context.mjs`).
 *
 * This provider reads the project graph via `moon project-graph --json`,
 * the same way `./nx.mjs` reads the Nx graph via `nx graph --file=`.
 *
 * This provider implements the one-call contract `./nx.mjs` already follows
 * (`readProjectGraph`), not the two-call `./native/` contract
 * (`discover`/`buildGraph`): Moon already resolves projects, tags and edges
 * before this package ever asks, so a single call is enough — the same
 * reason the Nx provider has no `discover` step.
 *
 * @typedef {object} ProjectModelProvider
 * @property {string} name Short, stable identifier — `"moon"` here — for a
 *   diagnostic that needs to say which provider answered (or failed to).
 * @property {(workspaceRoot: string, io?: object) => object} readProjectGraph
 *   The workspace root, plus whatever spawns/reads this provider needs
 *   injected for a test — and back comes the graph half of the shape
 *   `evaluate()` consumes: `{nodes, dependencies}`, plus `workspaceLayout`
 *   when the provider infers one.
 */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import { environmentForTree, runProcess } from "../process.mjs";
import { buildDependencies } from "./native/graph.mjs";

/**
 * The directory that marks a Moonrepo workspace root.
 *
 * Moonrepo v1 uses `.moon/`; Moonrepo v2.0+ also supports `.config/moon/`
 * as an alternative config directory. Both are valid markers; which one a
 * workspace uses is Moon's own convention, not this tool's to decide.
 */
export const MOON_DIR = ".moon";

/**
 * The alternative config directory Moonrepo v2.0+ supports.
 *
 * A workspace may carry either `.moon/` or `.config/moon/`. Moon treats them
 * as mutually exclusive roots, and so does this tool: a root carrying BOTH is
 * refused outright by `moonMarkerAt` below, naming both directories, rather
 * than silently judged against one of them. This constant lets that check —
 * and the marker walk (`../commands/context.mjs`'s `WORKSPACE_MARKERS`) —
 * recognize either spelling, the same way they already check for `nx.json`
 * and `lattice.json`.
 */
export const MOON_ALT_DIR = ".config/moon";

/**
 * Which Moon directory marks `root` as a Moonrepo workspace — `.moon/`,
 * `.config/moon/`, or neither.
 *
 * The one answer to that question, shared by every entry point that must
 * answer it identically: `../commands/context.mjs`'s provider choice reads it
 * for the CLI, and `../lsp/workspace-index.mjs`'s dispatch reads it for the
 * language server — so the editor and `check` cannot disagree about which
 * marker resolves a Moon tree (#223's two-faces defect).
 *
 * A root carrying both directories is REFUSED rather than silently resolved:
 * Moon treats them as mutually exclusive roots, and picking one for the
 * consumer would judge their workspace against a config nobody chose. It is
 * the same posture the `.moon`+`nx.json`, `.moon`+`lattice.json` and
 * `nx.json`+`lattice.json` refusals take one level out
 * (`../commands/context.mjs`), applied inside the pair itself.
 *
 * @param {string} root Absolute workspace root.
 * @param {{exists?: (path: string) => boolean}} [io] Injectable existence test
 *   (absolute paths), so a test drives this without a filesystem. The default
 *   is plain filesystem existence, matching how every other marker is read.
 * @returns {string} `MOON_DIR` or `MOON_ALT_DIR` — whichever the root carries;
 *   `.config/moon/` alone wins nothing over `.moon/` alone, each simply names
 *   itself when it is the only one present.
 * @throws {Error} when both directories are present.
 */
export function moonMarkerAt(root, { exists = existsSync } = {}) {
  const hasPrimary = exists(join(root, MOON_DIR));
  const hasAlt = exists(join(root, MOON_ALT_DIR));
  if (hasPrimary && hasAlt) {
    throw new Error(
      `lattice: ${root} declares both ${MOON_DIR} and ${MOON_ALT_DIR} — Moonrepo treats them as ` +
        `mutually exclusive config roots, and this tool refuses to pick between them rather than ` +
        `judge the workspace against a config nobody chose. Remove whichever one is not the ` +
        `workspace's real source of truth.`,
    );
  }
  return hasAlt ? MOON_ALT_DIR : hasPrimary ? MOON_DIR : null;
}

/**
 * Resolves the Moon CLI binary by adding the workspace root's
 * `node_modules/.bin` to PATH, the same directory pnpm installs platform
 * shims into. This is the convention `npx` uses and the one
 * `scripts/check-packages.mjs` follows for `moon projects --json`.
 *
 * Moon is not a peer dependency of this package — it is a dev dependency of
 * the consumer workspace — so `require.resolve` cannot find it the way
 * `./nx.mjs` resolves `nx`. Instead, the binary is found on PATH after the
 * workspace's `node_modules/.bin` is prepended.
 *
 * @param {string} workspaceRoot
 * @param {{ env?: Record<string, string|undefined> }} [io]
 * @returns {{ moon: string, env: Record<string, string|undefined> }}
 *   The Moon binary name and an env with the adjusted PATH.
 * @throws {Error} when Moon cannot be found on the augmented PATH.
 */
function resolveMoonEnv(workspaceRoot, { env = process.env } = {}) {
  // Strip ambient git redirects first — the same protection every other
  // provider gets — then add the workspace's node_modules/.bin to PATH.
  const clean = environmentForTree(env);
  const binDir = `${workspaceRoot}/node_modules/.bin`;
  const pathEnv = clean.PATH ?? "";
  const pathWithBin = pathEnv.includes(binDir) ? pathEnv : `${binDir}${delimiter}${pathEnv}`;
  return { moon: "moon", env: { ...clean, PATH: pathWithBin } };
}

/**
 * Moon dependency scope (plus, where known, its `source`) → Lattice edge type.
 *
 * `source` is checked first and wins: Moon's own `"implicit"`/`"explicit"`
 * marks whether a dependency was declared (`moon.yml`'s `dependsOn`) or
 * inferred by Moon itself with no author-written declaration behind it — the
 * same "no code-level backing" fact Nx's `implicitDependencies` and the
 * native provider's own `implicitDependencies` row both carry, and the exact
 * criterion `check`'s `declaredEdgeViolationsForCheck`
 * (`../commands/edge-constraints.mjs`) and `drift.mjs`'s/`discover.mjs`'s own
 * exclusions already key off: `edge.type === "implicit"`. Before this
 * function read `source` at all, EVERY Moon-sourced edge — implicit or not —
 * fell through to a `scope`-derived type (`"static"`/`"dynamic"`), so an
 * implicit Moon dependency was structurally indistinguishable from a real,
 * code-derived one to every one of those callers.
 *
 * `source` is only available on a project node's own `dependencies[]` array
 * (`transformMoonGraph`'s second edge-building loop) — `raw.graph.edges`'
 * `[source, target, scope]` tuples carry no such field, so that loop's call
 * always passes `source: undefined` and this function's behavior there is
 * unchanged.
 *
 * Once `source` is not `"implicit"` (or is unknown), Moon's `scope` decides:
 * - `"production"` — a runtime dependency. Maps to `"static"`.
 * - `"development"` — a build-time-only dependency. Maps to `"dynamic"`,
 *   because `noImportsOfLazyLoadedLibraries` is decided on exactly that
 *   distinction (`../../rules/topology.mjs`).
 * - `"build"` — a build-system dependency (not a source-level import). Maps
 *   to `"static"` as a conservative default; Lattice judges source imports,
 *   not build graphs.
 * - `"peer"` — a peer dependency. Maps to `"static"`.
 * - `"root"` — the root workspace depends on a project. These are not
 *   project-to-project edges Lattice judges, so they are omitted — checked
 *   before `source`, because a root-to-project edge is not a boundary either
 *   way.
 *
 * @param {string} scope
 * @param {string} [source] Moon's own `"implicit"`/`"explicit"` marker for
 *   this specific dependency, when the caller has one.
 * @returns {string|undefined} Lattice edge type, or `undefined` to skip.
 */
function edgeTypeFromScope(scope, source) {
  if (scope === "root") {
    // Root-to-project edges are not project-to-project boundaries, implicit
    // or not.
    return undefined;
  }
  if (source === "implicit") return "implicit";
  switch (scope) {
    case "production":
      return "static";
    case "development":
      return "dynamic";
    case "build":
    case "peer":
      return "static";
    default:
      // Unknown scopes become "static" — conservative, and never silent.
      return "static";
  }
}

/**
 * Maps a Moon `layer` value to a Lattice `node.type`.
 *
 * Moon's `layer` is one of: `automation`, `application`, `tool`, `library`,
 * `scaffolding`, `configuration`, `unknown` (or null). Lattice's `type` is
 * `"app"`, `"e2e"`, or `"lib"` — a coarser taxonomy that the rule engine
 * uses for the `noImportsOfApps`/`enforceBuildableLibDependency` checks.
 *
 * @param {string|null} layer
 * @returns {string} One of `"app"`, `"e2e"`, `"lib"`.
 */
function nodeTypeFromLayer(layer) {
  switch (layer) {
    case "application":
      return "app";
    case "automation":
      return "e2e";
    default:
      return "lib";
  }
}

/**
 * Derives the set of Lattice tags from a Moon project node's metadata.
 *
 * Moon provides three sources of tag-like information:
 * - `config.tags[]` — explicit tags declared in `moon.yml`. These become
 *   Lattice tags verbatim.
 * - `layer` — the project's layer classification. Becomes a derived tag
 *   `layer:<value>` (e.g. `layer:application`), matching Lattice's tag
 *   convention for constraint tables. Moon tags use dashes (`type-lib`);
 *   the derived `layer:` and `stack:` tags use colons to match the
 *   convention the constraint table will use, just as Nx tags do.
 * - `stack` — the project's stack. Becomes `stack:<value>`.
 *
 * All three are merged, deduplicated, and sorted.
 *
 * @param {object} projectNode A project node from `moon project-graph --json`.
 * @returns {string[]}
 */
function deriveTags(projectNode) {
  const tags = new Set();
  // Explicit tags from moon.yml — carried verbatim.
  const declared = projectNode.config?.tags;
  if (Array.isArray(declared)) {
    for (const tag of declared) tags.add(tag);
  }
  // Derived tags from layer/stack — colon-prefixed to match Lattice
  // convention for constraint tables.
  if (projectNode.layer) tags.add(`layer:${projectNode.layer}`);
  if (projectNode.stack) tags.add(`stack:${projectNode.stack}`);
  return [...tags].sort();
}

/**
 * Infers `workspaceLayout` from the source paths of Moon's projects.
 *
 * Moon does not declare `appsDir`/`libsDir` — there is no `nx.json`-style
 * `workspaceLayout` key. This function examines each project's `source`
 * (workspace-relative root) and checks for a common directory prefix shared
 * by all projects of the same `layer`:
 * - `application`-layer projects whose sources all share a prefix → `appsDir`
 * - `library`-layer projects whose sources all share a prefix → `libsDir`
 *
 * A prefix is "shared" when every project of that layer starts with the same
 * top-level directory. If no consistent prefix exists, that key is omitted
 * from the result. If either prefix is found but the other is not, `null` is
 * returned — a partial layout like `{appsDir: "apps"}` would pass through
 * `graph.workspaceLayout ?? DEFAULT_WORKSPACE_LAYOUT` unchanged (the object
 * is truthy, so `??` does not fire) and `isAbsoluteImportIntoAnotherProject`
 * would evaluate `${workspaceLayout.libsDir}/` as `"undefined/"`, silently
 * disabling the absolute-import rule for the missing axis. Returning `null`
 * forces the `??` fallback, which applies the complete default
 * `{libsDir: "libs", appsDir: "apps"}`. If neither prefix is found, `null`
 * is returned for the same reason.
 *
 * @param {object[]} projectNodes Project nodes from Moon's `data` map values.
 * @returns {{appsDir: string, libsDir: string}|null}
 */
function inferWorkspaceLayout(projectNodes) {
  const appDirs = new Set();
  const libDirs = new Set();
  for (const node of projectNodes) {
    if (!node.source) continue;
    const topDir = node.source.split("/")[0];
    if (node.layer === "application") appDirs.add(topDir);
    else if (node.layer === "library") libDirs.add(topDir);
  }
  const appsDir = appDirs.size === 1 ? [...appDirs][0] : undefined;
  const libsDir = libDirs.size === 1 ? [...libDirs][0] : undefined;
  // Both keys must be present, or neither. A partial layout would silently
  // disable the absolute-import rule for the missing axis — see the header
  // comment for the mechanism.
  if (appsDir === undefined || libsDir === undefined) return null;
  return { appsDir, libsDir };
}

/**
 * Transforms Moon's `project-graph --json` output into the shape
 * `evaluate()` consumes: `{nodes, dependencies}`.
 *
 * Moon's graph uses integer-indexed nodes and edges:
 * ```jsonc
 * {
 *   "graph": { "nodes": [0, 1], "edges": [[0, 1, "production"]] },
 *   "data": { "0": { "id": "web", "source": "apps/web", ... }, ... }
 * }
 * ```
 *
 * Lattice's graph uses name-keyed records:
 * ```js
 * {
 *   nodes: { "web": { name: "web", type: "app", data: { root: "apps/web", tags: [...] } } },
 *   dependencies: { "web": [{ source: "web", target: "api", type: "static" }] }
 * }
 * ```
 *
 * Null-prototype objects for `nodes` and `dependencies`, for the same reason
 * `./native/graph.mjs` uses them: a project literally named `__proto__` is a
 * name this provider does not control (it comes from `moon.yml`'s `id`), and a
 * plain `{}` answers `nodes["__proto__"] = …` by repointing the object's own
 * prototype rather than adding an entry — silent, and exactly the shape
 * `../../../AGENTS.md`'s invariant refuses.
 *
 * @param {object} raw The parsed JSON from `moon project-graph --json`.
 * @returns {{nodes: Record<string, object>, dependencies: Record<string, object[]>, workspaceLayout?: object}}
 */
export function transformMoonGraph(raw) {
  if (!raw?.data) {
    throw new Error(
      "lattice: `moon project-graph` produced no `data` map — " +
        "nothing can be judged against a graph with no projects in it",
    );
  }

  /** @type {Record<string, object>} */
  const nodes = Object.create(null);
  /** @type {Record<string, {source: string, target: string, type: string}[]>} */
  const dependencies = Object.create(null);
  // Keyed on the (source, target) PAIR alone, never on `type`: the same
  // dependency is represented twice in Moon's own output — once in
  // `raw.graph.edges` (typed only from `scope`, since that tuple carries no
  // `source` field) and once in the owning node's own `dependencies[]`
  // (which does carry `source`, and so is the only place a dependency can be
  // typed `"implicit"` at all). Keying on `[source, target, type]` — the
  // previous shape — let both survive as two distinct edges for one real
  // dependency: an `implicit` edge from the second loop, plus a phantom
  // `static`/`dynamic` duplicate from the first, and only the second loop's
  // exclusion callers (`../commands/drift.mjs`, `../commands/discover.mjs`)
  // ever look at `type`, so the phantom slipped past every `edge.type ===
  // "implicit"` check as a fake code-derived edge. One pair now always
  // resolves to exactly one entry, and `"implicit"` — Moon's own "no
  // author-written declaration behind this" fact — always wins over a
  // scope-derived type for that same pair, in whichever order the two loops
  // below discover it.
  /** @type {Map<string, {source: string, target: string, type: string}>} */
  const edgesByPair = new Map();
  const add = (source, target, type) => {
    if (!source || !target || source === target) return;
    if (!nodes[target]) return;
    const key = JSON.stringify([source, target]);
    const existing = edgesByPair.get(key);
    if (existing) {
      if (type === "implicit" && existing.type !== "implicit") existing.type = "implicit";
      return;
    }
    const entry = { source, target, type };
    edgesByPair.set(key, entry);
    (dependencies[source] ??= []).push(entry);
  };

  // Build nodes from Moon's data map. Each entry is indexed by integer key
  // but identified by its `id` string — which becomes the Lattice node key.
  const projectNodes = Object.values(raw.data);
  for (const node of projectNodes) {
    if (!node.id || !node.source) continue;
    const tags = deriveTags(node);
    const implicitDeps = Array.isArray(node.dependencies)
      ? node.dependencies.filter((d) => d.source === "implicit").map((d) => d.id)
      : [];
    const taskTargets = Array.isArray(node.taskTargets) ? node.taskTargets : [];
    nodes[node.id] = {
      name: node.id,
      type: nodeTypeFromLayer(node.layer),
      data: {
        root: node.source,
        tags,
        implicitDependencies: implicitDeps,
        ...(taskTargets.length > 0
          ? {
              targets: Object.fromEntries(
                taskTargets.map((target) => {
                  // Task targets are "projectId:taskId" — extract the task name.
                  const taskId = target.includes(":")
                    ? target.split(":").slice(1).join(":")
                    : target;
                  return [taskId, { executor: "moon:declared" }];
                }),
              ),
            }
          : {}),
      },
    };
  }

  // Build dependencies from Moon's graph edges.
  if (Array.isArray(raw.graph?.edges)) {
    for (const [srcIdx, tgtIdx, scope] of raw.graph.edges) {
      const srcNode = raw.data[String(srcIdx)];
      const tgtNode = raw.data[String(tgtIdx)];
      if (!srcNode?.id || !tgtNode?.id) continue;
      const type = edgeTypeFromScope(scope);
      if (type === undefined) continue; // e.g. "root" scope
      add(srcNode.id, tgtNode.id, type);
    }
  }

  // Also add dependencies from each project node's own `dependencies` array,
  // which carries `scope` and `source` metadata. This covers implicit
  // dependencies that the graph edges may not explicitly represent as edges.
  // `dep.source` is this loop's own reason to exist over the one above: it is
  // the only place this function's `source` argument is ever real.
  for (const node of projectNodes) {
    if (!node.id || !Array.isArray(node.dependencies)) continue;
    for (const dep of node.dependencies) {
      if (!dep.id) continue;
      const type = edgeTypeFromScope(dep.scope, dep.source);
      if (type === undefined) continue;
      add(node.id, dep.id, type);
    }
  }

  const workspaceLayout = inferWorkspaceLayout(projectNodes);
  return workspaceLayout === null
    ? { nodes, dependencies }
    : { nodes, dependencies, workspaceLayout };
}

/**
 * Folds the package's own import analysis into a Moon graph, in place.
 *
 * `moon project-graph --json` knows a project depends on another only when
 * `moon.yml` says `dependsOn` — Moon has no hook this package can register
 * the way `./nx.mjs`'s `createDependencies` registers into Nx's own graph
 * computation. A Go, Rust or Python import crossing a project boundary with
 * no such entry is therefore invisible to the graph alone, while the
 * reachability rules read exactly these lists (`noCircularDependencies`, the
 * upstream half of `notDependOnLibsWithTags`) — an edge missing here hides a
 * cycle or a transitive finding from every verdict built on the graph, which
 * is the silent direction. The dedupe key is `[source, target, type]`: an
 * import that agrees with a declared edge adds nothing; one that disagrees in
 * kind (a dynamic import of a statically declared dependency) survives as its
 * own record, because `noImportsOfLazyLoadedLibraries` turns on that kind.
 *
 * ONE implementation serves both faces that compose a Moon graph — the CLI's
 * preamble (`../commands/context.mjs`) and the language server's index
 * (`../lsp/workspace-index.mjs`) — so the editor and `check` cannot disagree
 * about which edges exist (#223).
 *
 * @param {{nodes: object, dependencies: Record<string, object[]>}} graph The
 *   graph `transformMoonGraph` (or an equivalent) returned; mutated in place.
 * @param {{importSites: object[], projectOf: (file: string) => string|undefined}} analysis
 *   Import records in the analysis contract's shape, and the file→project map
 *   to attribute them with.
 * @returns {{nodes: object, dependencies: Record<string, object[]>}} The same graph.
 */
export function mergeImportEdges(graph, { importSites, projectOf }) {
  const importEdges = buildDependencies({ importSites, nodes: graph.nodes, projectOf });
  const seenEdges = new Set(
    Object.values(graph.dependencies)
      .flat()
      .map((edge) => JSON.stringify([edge.source, edge.target, edge.type])),
  );
  for (const [source, edges] of Object.entries(importEdges)) {
    for (const edge of edges) {
      const key = JSON.stringify([edge.source, edge.target, edge.type]);
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      (graph.dependencies[source] ??= []).push(edge);
    }
  }
  return graph;
}

/**
 * Resolves the Moon CLI entry point, or throws if Moon is not installed.
 *
 * Unlike `./nx.mjs`'s `nxCli()`, this does not resolve through
 * `require.resolve` — `moon` is not a peer dependency of this package, so
 * there is no `node_modules/moon` to resolve from. The CLI is found on the
 * system PATH after the workspace's `node_modules/.bin` is prepended (see
 * `resolveMoonEnv`). Tests inject `resolveMoon` to provide a known binary
 * path without depending on a system-wide Moon installation.
 *
 * @param {string} workspaceRoot
 * @param {{ resolveMoon?: (workspaceRoot: string) => string }} [io]
 * @returns {string} Path or name of the Moon CLI binary.
 * @throws {Error} when Moon cannot be found.
 */
function resolveMoonCli(workspaceRoot, { resolveMoon = () => "moon" } = {}) {
  return resolveMoon(workspaceRoot);
}

/**
 * The Moon project graph for `workspaceRoot`, in the shape `evaluate()` consumes.
 *
 * `moon project-graph --json` emits a project graph that includes the nodes
 * and dependencies Moonrepo computed. This function reads that output,
 * transforms it into the `{nodes, dependencies}` shape the rule engine
 * expects, and returns it.
 *
 * @param {string} workspaceRoot
 * @param {{ run?: typeof runProcess, resolveMoon?: (workspaceRoot: string) => string, env?: Record<string, string|undefined> }} [io]
 *   Injectable spawn, injectable Moon resolution, and injectable env.
 * @returns {object} `{ nodes, dependencies }`, plus `workspaceLayout` when
 *   the project paths imply one.
 */
export function readProjectGraph(workspaceRoot, { run = runProcess, resolveMoon, env } = {}) {
  const moonEnv = resolveMoonEnv(workspaceRoot, { env: env ?? process.env });
  const moon = resolveMoonCli(workspaceRoot, { resolveMoon });
  const output = run(moon, ["project-graph", "--json"], workspaceRoot, moonEnv.env);
  const raw = JSON.parse(output);
  return transformMoonGraph(raw);
}

/**
 * The `ProjectModelProvider`-family object `../../cli.mjs` selects when a
 * workspace root carries a `.moon/` or `.config/moon/` directory rather than
 * `nx.json` or `lattice.json`.
 */
export const moonProvider = {
  name: "moon",
  marker: MOON_DIR,
  readProjectGraph,
};
