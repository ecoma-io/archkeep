/**
 * Import edges and implicit edges, reduced to Nx's own dependency-map shape —
 * the second half of what `../../lsp/workspace-index.mjs` used to build by
 * hand, promoted here so a native `lattice.json` workspace and the language
 * server share one implementation rather than growing two that drift
 * (`../../../CLAUDE.md`, "`src/providers/` is the layer that supplies a graph
 * to `evaluate()`").
 */
import { findMatchingProjects } from "../../rules/match.mjs";

/**
 * The dependency map, keyed by source project as Nx keys it.
 *
 * Two kinds of edge, and both are Nx's:
 *
 * - **Import edges**, from the analysis records. A `dynamic` import site
 *   becomes a `dynamic` edge, because `noImportsOfLazyLoadedLibraries` is
 *   decided on exactly that distinction (`../../rules/topology.mjs`).
 * - **Implicit edges**, from each project's `implicitDependencies`, expanded
 *   with the SAME matcher Nx uses — reached through `../../rules/match.mjs`
 *   rather than reimplemented, so a pattern that resolves one way for a
 *   constraint cannot resolve another way here.
 *
 * @param {{importSites: object[], nodes: Record<string, object>, projectOf: (file: string) => string|undefined}} input
 * @returns {Record<string, {source: string, target: string, type: string}[]>}
 */
export function buildDependencies({ importSites, nodes, projectOf }) {
  /** @type {Record<string, {source: string, target: string, type: string}[]>} */
  const dependencies = {};
  const seen = new Set();
  const add = (source, target, type) => {
    if (!source || !target || source === target) return;
    if (!nodes[target]) return;
    const key = `${source} ${target} ${type}`;
    if (seen.has(key)) return;
    seen.add(key);
    (dependencies[source] ??= []).push({ source, target, type });
  };

  for (const site of importSites) {
    add(
      projectOf(site.sourceFile),
      site.resolved?.target,
      site.kind === "dynamic" ? "dynamic" : "static",
    );
  }
  for (const [name, node] of Object.entries(nodes)) {
    const declared = node.data.implicitDependencies;
    if (!Array.isArray(declared) || declared.length === 0) continue;
    let expanded;
    try {
      expanded = findMatchingProjects(declared, nodes);
    } catch {
      // A pattern the matcher rejects is a project-definition problem, and it
      // is discovery's to report — `./discover.mjs` validates
      // `implicitDependencies` entries before a graph is ever built from them
      // (`./model.mjs`'s `declaredProjectViolations`), so a native workspace
      // never reaches this branch with a bad pattern. The language server can
      // (`../../lsp/workspace-index.mjs`'s `project.json` has no such
      // validator), which is why the catch stays: dropping the edge there
      // only ever loses a cycle this server would have found, and inventing
      // one would report a cycle that is not there.
      continue;
    }
    for (const target of expanded) add(name, target, "implicit");
  }
  return dependencies;
}

/**
 * The graph `evaluate()` judges, built from discovered native projects and
 * the import sites analysis found in them.
 *
 * Only `data.root` and `data.tags` are written here — the two facts this
 * provider actually measured (`./discover.mjs`). `entryPoints`,
 * `declaredPackages` and `mfeRemote` are NOT spread in from `lattice.json`;
 * they stay annotator-computed by the same functions the Nx path calls
 * (`../../workspace.mjs`'s `annotateMFERemotes`/`annotatePackageFacts`,
 * invoked by the caller afterward — see `../nx.mjs`'s
 * `ProjectModelProvider` doc for why that split holds for every provider).
 * `implicitDependencies` rides on `data` too, because `buildDependencies`
 * above reads it from there — the one field this provider both writes AND
 * reads back, by the same contract Nx's own `project.json` uses.
 *
 * `externalNodes` is never set: `../../rules/specifiers.mjs`'s
 * `findTransitiveExternalDependencies` already treats an absent
 * `graph.externalNodes` as "none", and `../../rules/index.mjs`'s
 * `externalNodeFor` synthesises a node for an external target on demand — a
 * native provider declaring npm-registry bookkeeping would be a second
 * source of truth for a fact this package already derives from the analysis
 * records.
 *
 * `data.targets` is synthesised, never measured: `lattice.json`'s
 * `projects.declared[].targets` names target NAMES only (spec §5), never an
 * executor or a config — this provider has no build system to ask for one.
 * Each declared name becomes `{executor: "lattice:declared"}`, a non-empty
 * executor string so `../../rules/topology.mjs`'s `hasBuildExecutor` (which
 * treats `executor === ''` as "not really buildable") reads it as real,
 * making `enforceBuildableLibDependency` live on a native tree the same way
 * it is on an Nx one. An empty `targets` list stays an ABSENT `data.targets`
 * rather than an empty object, so `hasBuildExecutor`'s own `Boolean(targets
 * && …)` sees "no targets" for a project that declared none, not a targets
 * table that happens to match nothing.
 *
 * `workspaceLayout` rides on the returned graph OBJECT, never inside a node's
 * `data` — it is a workspace-wide fact, not a per-project one, and
 * `../../rules/index.mjs`'s `createContext` reads it with exactly this
 * fallback: `graph.workspaceLayout ?? DEFAULT_WORKSPACE_LAYOUT`. Passing
 * `undefined` through (rather than defaulting it here) keeps that the only
 * place the default is ever applied — see `./model.mjs`'s
 * `normalizeNativeModel` for why a second default here could drift from it.
 *
 * @param {{projects: {name: string, root: string, type: string, tags: string[], implicitDependencies: string[], targets: string[]}[], importSites: object[], projectOf: (file: string) => string|undefined, workspaceLayout?: {appsDir: string, libsDir: string}}} args
 * @returns {{nodes: Record<string, object>, dependencies: Record<string, object[]>, workspaceLayout?: {appsDir: string, libsDir: string}}}
 */
export function buildNativeGraph({ projects, importSites, projectOf, workspaceLayout }) {
  /** @type {Record<string, object>} */
  const nodes = {};
  for (const project of projects) {
    nodes[project.name] = {
      name: project.name,
      type: project.type,
      data: {
        root: project.root,
        tags: project.tags,
        implicitDependencies: project.implicitDependencies,
        ...(project.targets && project.targets.length > 0
          ? {
              targets: Object.fromEntries(
                project.targets.map((name) => [name, { executor: "lattice:declared" }]),
              ),
            }
          : {}),
      },
    };
  }
  return {
    nodes,
    dependencies: buildDependencies({ importSites, nodes, projectOf }),
    ...(workspaceLayout ? { workspaceLayout } : {}),
  };
}
