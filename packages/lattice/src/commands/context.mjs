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

import { languageOf } from "../analysis/registry.mjs";
import { pythonUnmodelledFailures } from "../analysis/python.mjs";
import { fileFailure } from "../analysis/source-util.mjs";
import {
  DEFAULT_OPTIONS,
  NX_CONFIG_FILE,
  pluginIsRegistered,
  readPluginOptions,
} from "../options.mjs";
import { readProjectGraph } from "../providers/nx.mjs";
import { buildDependencies } from "../providers/native/graph.mjs";
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
 * Every marker a workspace root may be recognised by, as one list.
 *
 * Exported because `cli.mjs` walks for a root a second time — `--help` and
 * `adr` need one before a `CommandContext` exists — and that walk kept its own
 * copy of this list. The copy went stale: it named `nx.json` and `lattice.json`
 * only, so `adr` answered "no workspace root" on every Moon tree while naming
 * `.moon` in the very message, and `--help` fell back to defaults there. The
 * two callers still differ in posture — one throws where the other returns a
 * default — but they may not differ in what a workspace root IS.
 *
 * @type {string[]}
 */
export const WORKSPACE_MARKERS = [NX_CONFIG_FILE, LATTICE_MODEL_FILE, MOON_DIR, MOON_ALT_DIR];

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
 *   analyzedFiles: string[], exemptedFiles: string[]}} analysis The
 *   whole-tree-then-scoped (native) or scoped-then-analyzed (nx/moon) result —
 *   see the branches below for why the order is not the same on all three.
 *   `exemptedFiles` is always `[]` on nx/moon: `coverage.exempt` is a
 *   native-only `lattice.json` key.
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
 * The languages Nx cannot draw an edge for and ESLint cannot parse at all —
 * `../../../AGENTS.md`'s own opening line: "Nx reads TypeScript and
 * JavaScript imports and so `nx affected` and `@nx/enforce-module-boundaries`
 * work there; for the other three both go quiet." TypeScript, JavaScript
 * (and their `.mjs`/`.cjs`/`.jsx`/`.tsx` siblings) and Vue are deliberately
 * OUTSIDE this set: Nx's own graph already draws their edges from real
 * imports, and `@nx/enforce-module-boundaries` already lints them through
 * ESLint's normal file scoping, so a root-level tooling script in one of
 * those languages sitting outside every declared project is the ordinary,
 * unremarkable shape of an Nx or Moon workspace — this very repository's own
 * root carries a whole `scripts/` directory of them, plus `.opencode/plugins/`
 * and `commitlint.config.mjs`, inside neither of its two Moon projects — not
 * a gap this tool introduces. `../workspace.mjs`'s `polyglotManifests` already
 * draws this exact same line for the unregistered-plugin coverage gap, over
 * the three languages' manifests rather than their sources; this is that
 * same boundary restated for `unclaimedFileFailures` below, which has no
 * manifest to key off since an unclaimed file is, by definition, one with no
 * project (and so no `go.mod`/`Cargo.toml`/`pyproject.toml`) to belong to.
 *
 * Scoping to these three is not a smaller fix chosen for convenience — it is
 * the fix: widening this to every analyzable language turns `check` into a
 * breaking change for nearly every real Nx/Moon consumer, measured by running
 * it over this repository's own tree, whose tooling layer is exactly this
 * shape and whose own `check` must keep exiting 0.
 */
const UNCLAIMED_CHECK_LANGUAGES = new Set(["go", "rust", "python"]);

/**
 * Tracked Go, Rust or Python files that no project in `owned` claims — the
 * same "unclaimed file" question `../providers/native/coverage.mjs`'s
 * `judgeCoverage` answers for a native workspace (over every analyzable
 * language there, `UNCLAIMED_CHECK_LANGUAGES` above argues why this narrower
 * set is the right one here), asked for the Nx and Moon branches below,
 * neither of which has a discovery step of its own to answer it from: both
 * build their graph from `nx graph`/`moon project-graph` rather than from
 * `lattice.json`, and `../providers/native/coverage.mjs`'s own header names
 * the gap this closes — "this package's Nx path ... has no unclaimed-file
 * check of its own: both compute imports and violations only for files a
 * project already claims."
 *
 * `owned` already IS the claimed half of this question: `createWorkspace`
 * (`../workspace.mjs`) computed it over the FULL tracked-file list by the
 * same longest-root-prefix match `../providers/native/coverage.mjs`'s
 * `projectOf` uses, silently dropping any file that matched no project
 * (`../workspace.mjs`'s own header — "A file no project owns ... is dropped
 * here rather than read and analyzed for a verdict that cannot exist").
 * Comparing against the set `createWorkspace` already produced, rather than
 * matching roots a second time, is what keeps this answer from being able to
 * disagree with what "owned" already means for this graph.
 *
 * A file this returns is exactly the silent hole `../../../../AGENTS.md`'s
 * invariant refuses: analyzed by nothing, judged by nothing, and an empty
 * violation list reading identically to a file that really was clean. It
 * ignores path scoping on purpose — `tracked`, not the caller's scoped
 * selection — the same workspace-wide posture native's own unclaimed check
 * already has (its failures ride in `discovered.failures` below, unfiltered
 * by `paths`), because a `check <path>` run must not be able to hide an
 * orphan file elsewhere in the tree by naming a path that excludes it.
 *
 * Returns the SAME whole-file `fileFailure` shape (`../analysis/source-util.mjs`)
 * a language analyzer produces for a file it could not read, so `../../cli.mjs`'s
 * existing `unchecked`/`coverage.complete` logic — already built to treat any
 * whole-file failure as a coverage hole — picks these up with no change of its
 * own, exactly as it already does for native's. The wording names
 * `providerLabel` rather than native's `lattice.json`/`coverage.exempt`
 * vocabulary, because neither Nx nor Moon has an exemption mechanism this
 * tool reads — inventing one is out of scope here; this only detects and
 * reports.
 *
 * @param {{tracked: string[], owned: {file: string, project: string}[], providerLabel: string}} args
 * @returns {object[]}
 */
function unclaimedFileFailures({ tracked, owned, providerLabel }) {
  const ownedFiles = new Set(owned.map(({ file }) => file));
  return tracked
    .filter((file) => UNCLAIMED_CHECK_LANGUAGES.has(languageOf(file)) && !ownedFiles.has(file))
    .map((file) =>
      fileFailure(
        file,
        `is not owned by any project in ${providerLabel} — every tracked Go, Rust or Python file ` +
          `must belong to exactly one declared project, so its cross-project imports can be checked`,
      ),
    );
}

/**
 * Resolves everything a command needs before it can ask its own question:
 * which workspace, which provider, which files, and what analyzing them
 * found.
 *
 * Throws rather than returning a partial context on every condition that
 * would otherwise leave a caller building a verdict over a tree it could not
 * fully read — no workspace root, both markers present, or a requested path
 * outside the workspace or matching no tracked file at all
 * (`../workspace.mjs`'s `selectFiles`). That is the empty-result invariant
 * (`../../../../AGENTS.md`) applied one layer before any command's own
 * report: a context half-built is exactly the silent direction the invariant
 * refuses.
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
  const root = findWorkspaceRoot(cwd, WORKSPACE_MARKERS);
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
  let exemptedFiles;

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
      { root, cwd, tracked },
    );
    const selectedFiles = new Set(selected);
    imports = wholeTreeAnalysis.imports.filter((site) => selectedFiles.has(site.sourceFile));
    // Unclaimed analyzable files — this branch's own source is native
    // discovery's `discovered.failures` (`../providers/native/coverage.mjs`'s
    // `judgeCoverage`, reached through `nativeProvider.discover` above), which
    // already carries the unclaimed-file list alongside any unparseable-
    // manifest failure. The Nx and Moon branches below have no such discovery
    // step to answer the same question from, so they compute the equivalent
    // list themselves (`unclaimedFileFailures` above) — three different
    // sources feeding the SAME whole-file failure shape a language analyzer
    // produces for an unreadable file, so nothing downstream needs to know
    // which provider found the gap.
    failures = [
      ...wholeTreeAnalysis.failures.filter((failure) => selectedFiles.has(failure.sourceFile)),
      ...discovered.failures,
      // Workspace-scoped on purpose, the same posture the two unclaimed
      // equivalents above hold: a wildcard run must not be able to hide a
      // project whose manifest it cannot read by naming a path that excludes
      // it (`../analysis/python.mjs`'s `pythonUnmodelledFailures`).
      ...pythonUnmodelledFailures(workspace),
    ];
    analyzedFiles = wholeTreeAnalysis.analyzedFiles.filter((file) => selectedFiles.has(file));
    analyzed = analyzedFiles.length;
    // Unaffected by `paths`: an exempted file is by definition unowned by any
    // project, so it was never a candidate for `owned`/`selected` in the
    // first place — the same reason `pluginGap` below is a workspace-wide
    // fact rather than a scoped one.
    exemptedFiles = discovered.exempted;

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

    // Unlike the Nx path, Moon's own graph carries NO edge this package's own
    // analysis found: `moon project-graph --json` only knows a project
    // depends on another when `moon.yml` says `dependsOn`, because Moon has no
    // plugin hook this package can register the way `../nx.mjs`'s
    // `createDependencies` registers into Nx's own graph computation. A Go,
    // Rust or Python import crossing a project boundary with no hand-written
    // `dependsOn` entry is therefore invisible to `graph.dependencies` and to
    // every verdict computed from it — architecture-intent, drift, cycles,
    // `impact`, `diff` — while `check`'s own import-site rules judge it fine,
    // because those read analysis records directly rather than the graph.
    // Analyzing the whole tree first, before `paths` narrows anything, mirrors
    // the native branch above for the same reason it states there: an edge
    // from a project outside the scoped paths is still part of the graph a
    // cycle or a transitive violation is judged against.
    const wholeTreeAnalysis = analyzeWorkspace(
      workspace,
      owned.map(({ file }) => file),
    );
    const projectOfFile = new Map(owned.map(({ file, project }) => [file, project]));
    const importEdges = buildDependencies({
      importSites: wholeTreeAnalysis.imports,
      nodes: graph.nodes,
      projectOf: (file) => projectOfFile.get(file),
    });
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

    const selected = selectFiles(
      owned.map(({ file }) => file),
      paths,
      { root, cwd, tracked },
    );
    const selectedFiles = new Set(selected);
    imports = wholeTreeAnalysis.imports.filter((site) => selectedFiles.has(site.sourceFile));
    // Unclaimed analyzable files — `unclaimedFileFailures` above — join the
    // scoped read failures unconditionally, the same workspace-wide posture
    // native's own `discovered.failures` has (this branch's header already
    // analyzes the whole tree before `paths` narrows anything, for the same
    // reason).
    failures = [
      ...wholeTreeAnalysis.failures.filter((failure) => selectedFiles.has(failure.sourceFile)),
      ...unclaimedFileFailures({ tracked, owned, providerLabel: "the Moon project graph" }),
      ...pythonUnmodelledFailures(workspace),
    ];
    analyzedFiles = wholeTreeAnalysis.analyzedFiles.filter((file) => selectedFiles.has(file));
    analyzed = analyzedFiles.length;
    // `coverage.exempt` is a native-only key (`../providers/native/coverage.mjs`'s
    // header: "Nx has no equivalent question") — Moon carries no such list.
    exemptedFiles = [];

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
      { root, cwd, tracked },
    );
    ({ imports, failures, analyzed, analyzedFiles } = analyzeWorkspace(workspace, selected));
    // Unclaimed analyzable files — `unclaimedFileFailures` above — join
    // unconditionally, the same workspace-wide posture native's own
    // `discovered.failures` has, so a scoped `check <path>` cannot hide an
    // orphan file elsewhere in the tree by naming a path that excludes it.
    failures = [
      ...failures,
      ...unclaimedFileFailures({ tracked, owned, providerLabel: "the Nx project graph" }),
      ...pythonUnmodelledFailures(workspace),
    ];
    // Same reason as the Moon branch above: `coverage.exempt` is a native-only
    // concept, so an Nx workspace has nothing to report here.
    exemptedFiles = [];

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
    analysis: { imports, failures, analyzed, analyzedFiles, exemptedFiles },
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
