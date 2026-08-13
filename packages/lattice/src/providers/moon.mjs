/**
 * The Moon project-model provider: `.moon/` directory, no Nx installed.
 *
 * A Moonrepo workspace is identified by a `.moon/` directory at its root.
 * Moonrepo computes its own project graph — including dependencies between
 * projects — and this provider reads that graph via `moon project-graph --json`,
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

import { environmentForTree, runProcess } from "../process.mjs";

/** The directory that marks a Moonrepo workspace root. */
export const MOON_DIR = ".moon";

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
  const pathWithBin = pathEnv.includes(binDir) ? pathEnv : `${binDir}:${pathEnv}`;
  return { moon: "moon", env: { ...clean, PATH: pathWithBin } };
}

/**
 * Moon dependency scope → Lattice edge type.
 *
 * Moon's `project-graph --json` labels each edge with a scope:
 * - `"production"` — a runtime dependency. Maps to `"static"`, the same type
 *   an Nx `implicitDependencies` edge carries.
 * - `"development"` — a build-time-only dependency. Maps to `"dynamic"`,
 *   because `noImportsOfLazyLoadedLibraries` is decided on exactly that
 *   distinction (`../../rules/topology.mjs`).
 * - `"build"` — a build-system dependency (not a source-level import). Maps
 *   to `"static"` as a conservative default; Lattice judges source imports,
 *   not build graphs.
 * - `"peer"` — a peer dependency. Maps to `"static"`.
 * - `"root"` — the root workspace depends on a project. These are not
 *   project-to-project edges Lattice judges, so they are omitted.
 *
 * @param {string} scope
 * @returns {string|undefined} Lattice edge type, or `undefined` to skip.
 */
function edgeTypeFromScope(scope) {
  switch (scope) {
    case "production":
      return "static";
    case "development":
      return "dynamic";
    case "build":
    case "peer":
      return "static";
    case "root":
      // Root-to-project edges are not project-to-project boundaries.
      return undefined;
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
 * from the result. If neither prefix is found, `null` is returned —
 * `../../rules/index.mjs`'s `graph.workspaceLayout ?? DEFAULT_WORKSPACE_LAYOUT`
 * then applies the default, exactly as it does when the Nx or native provider
 * omits the field.
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
  if (appsDir === undefined && libsDir === undefined) return null;
  const layout = {};
  if (appsDir !== undefined) layout.appsDir = appsDir;
  if (libsDir !== undefined) layout.libsDir = libsDir;
  return layout;
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
  const seen = new Set();
  const add = (source, target, type) => {
    if (!source || !target || source === target) return;
    if (!nodes[target]) return;
    const key = JSON.stringify([source, target, type]);
    if (seen.has(key)) return;
    seen.add(key);
    (dependencies[source] ??= []).push({ source, target, type });
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
  for (const node of projectNodes) {
    if (!node.id || !Array.isArray(node.dependencies)) continue;
    for (const dep of node.dependencies) {
      if (!dep.id) continue;
      const type = edgeTypeFromScope(dep.scope);
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
 * workspace root carries a `.moon/` directory rather than `nx.json` or
 * `lattice.json`.
 */
export const moonProvider = {
  name: "moon",
  marker: MOON_DIR,
  readProjectGraph,
};
