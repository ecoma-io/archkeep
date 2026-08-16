/**
 * The preamble every command shares: which workspace, which provider, which
 * files, and what a whole-tree read of them found. `../../cli.mjs`'s `check`
 * built exactly this before `--format json` existed; this module is that
 * preamble lifted out so a second command can reuse it rather than reimplement
 * it a rule at a time. What is deliberately NOT here: the boundary policy
 * (`../config.mjs`'s `loadBoundaryConfig`/`loadBoundaryConfigFile`), the
 * go.work drift check, and the tsconfig paths hygiene check — all three are
 * `check`'s own concerns, judged from what this module hands back, not part of
 * establishing "which tree, which files, what did reading them find" that a
 * later command (`graph`, `explain`, `impact`, `diff`) needs identically.
 *
 * Everything below is a straight extraction: no branch here changes what
 * `check` decided before this module existed, because the byte-for-byte
 * unchanged verdict on an unchanged tree is itself part of the contract
 * (`../../../../AGENTS.md`, "a change to what is reported on an unchanged
 * workspace is a breaking change").
 *
 * `../providers/native/index.mjs`'s header states that module imports nothing
 * from `../workspace.mjs`; this module is the one place both a provider and
 * `../workspace.mjs` are composed, which is why it lives beside the commands
 * that need the composition rather than inside either provider
 * (`./README.md`).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_OPTIONS,
  NX_CONFIG_FILE,
  pluginIsRegistered,
  readPluginOptions,
} from "../options.mjs";
import { readProjectGraph } from "../providers/nx.mjs";
import { LATTICE_MODEL_FILE } from "../providers/native/model.mjs";
import { MOON_DIR, MOON_ALT_DIR, moonProvider } from "../providers/moon.mjs";
import { nativeProvider } from "../providers/native/index.mjs";
import {
  analyzeWorkspace,
  annotateMFERemotes,
  annotatePackageFacts,
  createWorkspace,
  findWorkspaceRoot,
  listTrackedFiles,
  polyglotManifests,
  selectFiles,
} from "../workspace.mjs";

/**
 * Workspace-relative read from `root` — the same default `createWorkspace`
 * builds when no reader is injected (`../workspace.mjs`), duplicated here
 * rather than imported because it is needed BEFORE a `Workspace` exists to
 * read from: `nativeProvider.discover` needs one to load `lattice.json`
 * itself.
 *
 * @param {string} root
 * @returns {(path: string) => string|null}
 */
function readWorkspaceRoot(root) {
  return (path) => {
    try {
      return readFileSync(join(root, path), "utf8");
    } catch {
      return null;
    }
  };
}

/**
 * The real-filesystem reader `pluginIsRegistered` (`../options.mjs`) gets
 * when no seam overrides it. Unlike `readWorkspaceRoot` above, this one takes
 * an ALREADY-ABSOLUTE path: `pluginIsRegistered` builds
 * `${workspaceRoot}/${NX_CONFIG_FILE}` itself before calling its reader, so a
 * `join(root, path)`-style reader would double the root onto an already-full
 * path.
 *
 * @param {string} path
 * @returns {string|null}
 */
function readFileAbsolute(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * The three facts that decide which project-model provider judges a workspace:
 * does `root` carry `nx.json`, `lattice.json`, `.moon/`, `.config/moon/`,
 * or — a state every command refuses — more than one.
 *
 * Moonrepo v2.0+ supports `.config/moon/` as an alternative to `.moon/`.
 * Both are checked: `hasMoon` is true when either exists.
 *
 * @param {string} root
 * @returns {{hasNx: boolean, hasNative: boolean, hasMoon: boolean}}
 */
export function markersAt(root) {
  return {
    hasNx: existsSync(join(root, NX_CONFIG_FILE)),
    hasNative: existsSync(join(root, LATTICE_MODEL_FILE)),
    hasMoon: existsSync(join(root, MOON_DIR)) || existsSync(join(root, MOON_ALT_DIR)),
  };
}

/**
 * @typedef {object} CommandContext
 * @property {string} root Absolute workspace root.
 * @property {"nx"|"native"|"moon"} provider Which project-model provider answered.
 * @property {string} marker `nx.json`, `lattice.json`, `.moon`, or `.config/moon` — whichever
 *   `root` carries, and the one this run's provider came from.
 * @property {object} graph `{nodes, dependencies}`, from `readProjectGraph`
 *   or `nativeProvider.buildGraph`.
 * @property {object} workspace The `Workspace` `../workspace.mjs`'s
 *   `createWorkspace` returns.
 * @property {string[]} tracked Every tracked file, from `listFiles(root)`.
 * @property {{imports: object[], failures: object[], analyzed: number,
 *   analyzedFiles: string[]}} analysis The whole-tree-then-scoped (native) or
 *   scoped-then-analyzed (nx/moon) result — see the branches below for why the
 *   order is not the same on all three.
 * @property {{boundaryConfig: string|object, tsConfig: object|undefined,
 *   profiles?: string, inline?: boolean}} options What this workspace names its
 *   boundary law, its shared tsconfig, and — when it uses one — its named
 *   profile registry. `check`'s `--config` flag, if given, still wins over
 *   `options.boundaryConfig`; that override is `check`'s decision, not this
 *   module's.
 * @property {{registered: boolean, manifests: string[]}} pluginGap Whether
 *   this workspace's own provider is the one Nx would actually run, and which
 *   tracked polyglot manifests sit under a project root either way. Always
 *   `{registered: true, manifests: []}` on a native or Moon workspace: there
 *   is no Nx plugin registration to be missing, because there is no `nx.json`.
 *   Computed and returned, but not consulted by `check`'s refusal logic —
 *   `../../../../docs/usage/` names the gap this fills and the issue tracking it
 *   wiring it in.
 * @property {{file: string, project: string}[]} owned Every tracked file that
 *   belongs to a project, paired with its owning project — the ownership map
 *   `createWorkspace` already built. A command that needs to know WHICH project
 *   owns a file (the planning context's path→project scoping, `./plan-context-command.mjs`)
 *   reads this rather than re-deriving ownership a second way.
 */

/**
 * Resolves everything a command needs before it can ask its own question:
 * which workspace, which provider, which files, and what analyzing them
 * found.
 *
 * Throws rather than returning a partial context on every condition that
 * would otherwise leave a caller building a verdict over a tree it could not
 * fully read — no workspace root, both markers present, or a requested path
 * outside the workspace (`../workspace.mjs`'s `selectFiles`). That is the
 * empty-result invariant (`../../../../AGENTS.md`) applied one layer before any
 * command's own report: a context half-built is exactly the silent direction
 * the invariant refuses.
 *
 * @param {{cwd: string, paths?: string[]}} request
 * @param {{readGraph?: Function, listFiles?: Function, readFile?: (path: string) => string|null}} [io]
 *   The seams that reach outside this process — Nx, git, and (on the Nx
 *   branch) the `nx.json` read behind `pluginGap.registered` — injectable for
 *   the same reason `check` always took the first two: a test drives the real
 *   analysis over a fixture tree with none of them touching a real
 *   filesystem or subprocess. `readFile` takes an ALREADY-ABSOLUTE path, the
 *   shape `pluginIsRegistered` (`../options.mjs`) calls its reader with.
 * @returns {CommandContext}
 */
export function resolveCommandContext(
  { cwd, paths = [] },
  { readGraph, listFiles = listTrackedFiles, readFile = readFileAbsolute } = {},
) {
  // All three markers in one walk (`../workspace.mjs`'s `findWorkspaceRoot`), so a
  // native root nested under an unrelated Nx tree — or vice versa — is found
  // from the working directory the same way either alone would be. Which
  // marker(s) the returned directory actually carries is then read back
  // below, because a walk that STOPPED at the first marker it saw could never
  // tell "only lattice.json here" from "both, one level up".
  const root = findWorkspaceRoot(cwd, [NX_CONFIG_FILE, LATTICE_MODEL_FILE, MOON_DIR, MOON_ALT_DIR]);
  if (root === null) {
    throw new Error(
      `lattice: no workspace root above ${cwd} — looked for an nx.json, a lattice.json, or a ` +
        `.moon (or .config/moon) directory in every parent. The tree to judge is found from the working directory, ` +
        `never from this tool's own location: installed from the registry, this tool lives under ` +
        `the consumer's node_modules and the two are always different trees.`,
    );
  }
  const { hasNx, hasNative, hasMoon } = markersAt(root);
  if (hasMoon && hasNx) {
    throw new Error(
      `lattice: ${root} declares both .moon and nx.json — this tool judges a workspace ` +
        `against exactly one project model, and a tree carrying both is a decision nobody made ` +
        `rather than one this tool can make for them. Remove whichever one is not the ` +
        `workspace's real source of truth for projects and tags.`,
    );
  }
  if (hasMoon && hasNative) {
    throw new Error(
      `lattice: ${root} declares both .moon and lattice.json — this tool judges a workspace ` +
        `against exactly one project model, and a tree carrying both is a decision nobody made ` +
        `rather than one this tool can make for them. Remove whichever one is not the ` +
        `workspace's real source of truth for projects and tags.`,
    );
  }
  if (hasNx && hasNative) {
    throw new Error(
      `lattice: ${root} declares both nx.json and lattice.json — this tool judges a workspace ` +
        `against exactly one project model, and a tree carrying both is a decision nobody made ` +
        `rather than one this tool can make for them. Remove whichever one is not the ` +
        `workspace's real source of truth for projects and tags.`,
    );
  }

  // Resolve the default graph reader based on provider: Moon workspaces read
  // their graph from `moon project-graph --json`, Nx workspaces from
  // `nx graph --file=`. The native provider uses a two-call discover/buildGraph
  // contract instead, so it never goes through `readGraph` at all.
  const defaultReadGraph = hasMoon ? moonProvider.readProjectGraph : readProjectGraph;
  const effectiveReadGraph = readGraph ?? defaultReadGraph;

  const tracked = listFiles(root);
  let graph;
  let workspace;
  let owned;
  let options;
  let imports;
  let failures;
  let analyzed;
  let analyzedFiles;
  let pluginGap;

  if (hasNative) {
    // No `nx graph`, no `nx.json`, and — verified by this branch existing at
    // all — no `nx` needing to be installed: `nativeProvider` is imported
    // from `../providers/native/index.mjs`, which imports nothing from
    // `../providers/nx.mjs` and nothing that resolves the `nx` package.
    const readFile = readWorkspaceRoot(root);
    const discovered = nativeProvider.discover({ root, files: tracked, readFile });
    // A graph with nodes but no dependencies yet — `createWorkspace` only
    // ever reads `data.root` off each node, and dependencies are not known
    // until the import sites below are analyzed against these same projects.
    const preGraph = {
      nodes: Object.fromEntries(
        discovered.projects.map((project) => [
          project.name,
          { name: project.name, data: { root: project.root } },
        ]),
      ),
    };
    ({ workspace, owned } = createWorkspace({
      root,
      graph: preGraph,
      files: tracked,
      tsConfig: discovered.model.tsConfig,
    }));

    // On the Nx path `graph.dependencies` comes from `nx graph`, computed
    // over the WHOLE workspace regardless of `paths`, so scoping only ever
    // narrows which import sites are handed back for reporting. The native
    // path has no such independent source — `nativeProvider.buildGraph`
    // DERIVES `dependencies` from import sites — so analyzing only the
    // requested scope first would drop every project outside it from the
    // dependency graph itself, and a cycle or a transitive violation that
    // only closes once the rest of the tree's imports are counted would go
    // unreported. Every owned file is analyzed here, unconditionally;
    // `selected` below only filters which of the resulting sites are handed
    // back.
    const wholeTreeAnalysis = analyzeWorkspace(
      workspace,
      owned.map(({ file }) => file),
    );
    graph = nativeProvider.buildGraph({
      discovered,
      importSites: wholeTreeAnalysis.imports,
    });
    annotateMFERemotes(graph.nodes, workspace.readFile);
    annotatePackageFacts(graph.nodes, workspace.readFile);

    options =
      typeof discovered.model.boundaryConfig === "string"
        ? { boundaryConfig: discovered.model.boundaryConfig, tsConfig: discovered.model.tsConfig }
        : {
            boundaryConfig: discovered.model.boundaryConfig,
            tsConfig: discovered.model.tsConfig,
            inline: true,
          };

    const selected = selectFiles(
      owned.map(({ file }) => file),
      paths,
      { root, cwd },
    );
    const selectedFiles = new Set(selected);
    imports = wholeTreeAnalysis.imports.filter((site) => selectedFiles.has(site.sourceFile));
    // Unclaimed analyzable files — a native-only fact; the Nx path has no
    // unclaimed-file check of its own (`../providers/native/coverage.mjs`'s
    // header) — join the SAME whole-file failure shape a language analyzer
    // produces for an unreadable file, so nothing downstream needs to know
    // which provider found the gap.
    failures = [
      ...wholeTreeAnalysis.failures.filter((failure) => selectedFiles.has(failure.sourceFile)),
      ...discovered.failures,
    ];
    analyzedFiles = wholeTreeAnalysis.analyzedFiles.filter((file) => selectedFiles.has(file));
    analyzed = analyzedFiles.length;

    // There is no Nx plugin registration to be missing on a workspace that
    // has no `nx.json` at all.
    pluginGap = { registered: true, manifests: [] };
  } else if (hasMoon) {
    // Moon provider — reads graph from `moon project-graph --json`, the same
    // one-call contract as the Nx path: Moon already resolved projects, tags
    // and edges before this package ever asked. Options from defaults (no
    // `nx.json` to carry a plugins table, no `lattice.json` for inline
    // options); a Moon workspace names the same two files by convention.
    options = {
      boundaryConfig: DEFAULT_OPTIONS.boundaryConfig,
      tsConfig: DEFAULT_OPTIONS.tsConfig,
    };

    graph = effectiveReadGraph(root);
    ({ workspace, owned } = createWorkspace({
      root,
      graph,
      files: tracked,
      tsConfig: options.tsConfig,
    }));
    annotateMFERemotes(graph.nodes, workspace.readFile);
    annotatePackageFacts(graph.nodes, workspace.readFile);

    const selected = selectFiles(
      owned.map(({ file }) => file),
      paths,
      { root, cwd },
    );
    ({ imports, failures, analyzed, analyzedFiles } = analyzeWorkspace(workspace, selected));

    // There is no Nx plugin registration to be missing on a workspace that
    // has no `nx.json` at all.
    pluginGap = { registered: true, manifests: [] };
  } else {
    // What this workspace calls the two files whose names are conventions
    // rather than contracts. Read before the graph, because it decides which
    // tsconfig `createWorkspace` resolves paths against.
    const pluginOptions = readPluginOptions(root);
    options = {
      boundaryConfig: pluginOptions.boundaryConfig,
      tsConfig: pluginOptions.tsConfig,
      ...(pluginOptions.profiles === undefined ? {} : { profiles: pluginOptions.profiles }),
    };

    graph = effectiveReadGraph(root);
    ({ workspace, owned } = createWorkspace({
      root,
      graph,
      files: tracked,
      tsConfig: pluginOptions.tsConfig,
    }));
    // `nx graph --file=` does not carry the Module Federation fact — see
    // `annotateMFERemotes` — so it is computed here, before any rule runs, or
    // every import of a real remote app would be a false `noImportsOfApps`.
    annotateMFERemotes(graph.nodes, workspace.readFile);
    // Nor the two `package.json` facts — `data.entryPoints` and
    // `data.declaredPackages`, see `annotatePackageFacts` — which decide the
    // secondary-entry-point exemptions and `noTransitiveDependencies`.
    annotatePackageFacts(graph.nodes, workspace.readFile);

    const selected = selectFiles(
      owned.map(({ file }) => file),
      paths,
      { root, cwd },
    );
    ({ imports, failures, analyzed, analyzedFiles } = analyzeWorkspace(workspace, selected));

    pluginGap = {
      registered: pluginIsRegistered(root, { readFile }),
      manifests: polyglotManifests(tracked, workspace.projects),
    };
  }

  // Which Moon directory was actually found — `.config/moon/` is an alternative
  // to `.moon/` that Moonrepo v2.0+ supports. The marker records whichever one
  // the workspace carries, so diagnostics can name it correctly.
  const moonMarker = existsSync(join(root, MOON_ALT_DIR)) ? MOON_ALT_DIR : MOON_DIR;

  return {
    root,
    provider: hasMoon ? "moon" : hasNative ? "native" : "nx",
    marker: hasMoon ? moonMarker : hasNative ? LATTICE_MODEL_FILE : NX_CONFIG_FILE,
    graph,
    workspace,
    tracked,
    analysis: { imports, failures, analyzed, analyzedFiles },
    options,
    pluginGap,
    // Every tracked file that belongs to a project, paired with its project —
    // the ownership map `createWorkspace` already built (`own ./workspace.mjs`).
    // A command that needs to know WHICH project owns a file (the planning
    // context's path→project scoping) reads this rather than re-deriving
    // ownership a second way. Not part of any existing command's consumption.
    owned,
  };
}

// Re-exported so a caller that only needs "does this tree look like a
// workspace at all" (`../../cli.mjs`'s `optionsForUsage`) is not forced to
// duplicate the marker check a second time; `DEFAULT_OPTIONS` rides along for
// the same reason, since the two are always read together there.
export { DEFAULT_OPTIONS };
