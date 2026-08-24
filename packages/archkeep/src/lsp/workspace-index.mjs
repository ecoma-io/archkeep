/**
 * The workspace as the rule engine needs to see it: an Nx-shaped project graph,
 * and the `Workspace` object every analyzer resolves against.
 *
 * `evaluate(sites, graph, config)` is pure and takes a graph it does not build
 * (`../rules/README.md`). Under Nx that graph arrives from Nx. A language
 * server has no Nx — it is spawned by an editor, in a directory, with nothing
 * else — so this module builds the same shape from whichever source of truth
 * the root actually carries: the tracked `project.json` files when there is no
 * `archkeep.json` at the root, `../providers/native/`'s own `discover()`/
 * `buildGraph()` when there is (`buildNativeWorkspaceIndex` below), and
 * `../providers/moon.mjs`'s one-call `readProjectGraph` when the root carries
 * `.moon/` or `.config/moon/` (`buildMoonWorkspaceIndex`) — the same provider
 * object `../commands/context.mjs` hands `check`, so the editor's graph and
 * the CLI's come from one dispatch rather than two (#223). Before that Moon
 * branch existed, this module fell through to `discoverProjects` on a
 * `.moon`-rooted tree — which finds a project only by its `project.json`, a
 * file a Moon workspace never has — and built a zero-node index that read as
 * clean while `check` exited 1 on the same tree.
 *
 * `nodeTypeOf`, `PROJECT_CONFIG_FILE` and `buildDependencies` are imported
 * from `../providers/native/`, not defined here — that package is where a
 * `project.json`-shaped graph is built for BOTH the Nx-less native provider
 * and this server, so the two do not grow separate copies of Nx's own
 * `getProjectType` rule and its implicit-dependency expansion
 * (`../../AGENTS.md`, "`src/providers/` is the only layer allowed to build a
 * graph"). `discoverProjects` and `buildNodes` below are the Nx-shaped
 * branch's own project discovery — reading `project.json` is correct THERE,
 * because a root with no `archkeep.json` has no other source of truth to read.
 *
 * ## Why the native branch cannot reuse `discoverProjects`
 *
 * A native workspace can declare or infer a project with no `project.json` at
 * all — the whole point of `archkeep.json` is not needing one — and
 * `discoverProjects` below finds nothing there. A silently missing project is
 * indistinguishable from a project that legitimately has no boundary
 * violations, which is exactly the hole `../../../../AGENTS.md`'s invariant
 * refuses ("An empty result is a claim, not a shrug"). So a root carrying
 * `ARCHKEEP_MODEL_FILE` runs `buildNativeWorkspaceIndex` instead: it drives
 * `../providers/native/`'s own `discover()` (declared∪inferred projects, the
 * files none of them own) and `buildGraph()` (nodes and dependencies from the
 * import sites this module still analyzes itself — provider-agnostic, and
 * unchanged either way).
 *
 * A `discover()` throw — a malformed `archkeep.json`, a declared root with no
 * tracked file under it, a `projectRules` row matching no project, a stale
 * `coverage.exempt` entry — is caught rather than left to blank the whole
 * session: it becomes `nativeModelFailure` on the returned index, which
 * `indexGaps` turns into a diagnostic naming the defect, on an index that is
 * otherwise a valid, empty `workspace`/`graph` shape every caller downstream
 * can still iterate over. `archkeep.json` is a watched file (`./server.mjs`),
 * so fixing it clears the gap the same way fixing a broken `project.json`
 * clears a `skippedProjects` one.
 *
 * ## What it may assume about the tree, which is nothing
 *
 * No project name, no directory layout, no tag vocabulary (`../../AGENTS.md` —
 * the tool is installed into workspaces it has never seen). Everything below is
 * derived: projects from the `project.json` files that exist (Nx-shaped
 * branch) or from `archkeep.json`'s declared∪inferred model (native branch),
 * node types from `projectType` by Nx's own rule either way, tags from each
 * project's own list, edges from the imports the analyzers actually find.
 *
 * ## Why the file list comes from git
 *
 * The analysis contract's `filesOf` means "the project's tracked files", and
 * git is the one component that already answers that exactly. The alternative
 * is a directory walk with a skip list — `node_modules`, `dist`, `target`,
 * `.venv` — which is a config nobody maintains until the day it swallows a real
 * source directory and the boundary quietly stops being enforced there. The
 * list is TRACKED files only, the same set `../../cli.mjs`'s `check` reads
 * (`../workspace.mjs`'s `listTrackedFiles`, one git spawn shared by both faces)
 * — an untracked file is a file `archkeep check` does not judge, and an editor
 * verdict must match the CLI's or the two would disagree about the same tree.
 *
 * A workspace git cannot answer for is a LOUD failure, never a silent empty
 * index: `buildWorkspaceIndex` throws, and the server turns that into a
 * diagnostic on every open document rather than a clean bill of health.
 *
 * ## What the index could not read is data the caller must publish
 *
 * The two failures below are recorded rather than thrown, because one project
 * being edited must not blank the graph for the other nineteen. Recording them
 * is only half an answer: an index missing a project or an edge produces a
 * verdict that is not the verdict, and a caller that reads neither list
 * publishes that verdict as if the tree had been read whole. `indexGaps` turns
 * both lists into sentences, and `./diagnose.mjs` refuses to call a document
 * analyzed while either is non-empty.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { analyzeFile } from "../analysis/analyze.mjs";
import { fileFailure, isWholeFileFailure } from "../analysis/source-util.mjs";
import { containmentViolation } from "../containment.mjs";
import { parseNxJson } from "../nx-json.mjs";
import {
  NX_CONFIG_FILE,
  readWorkspaceLayout,
  requireCompleteWorkspaceLayout,
} from "../options.mjs";
import {
  analyzeWorkspace,
  annotateMFERemotes,
  annotatePackageFacts,
  createWorkspace,
  listTrackedFiles,
} from "../workspace.mjs";
import { buildDependencies } from "../providers/native/graph.mjs";
import { nodeTypeOf, PROJECT_CONFIG_FILE } from "../providers/native/discover.mjs";
import { ARCHKEEP_MODEL_FILE } from "../providers/native/model.mjs";
import { nativeProvider } from "../providers/native/index.mjs";
import { requireSingleProjectModel } from "../commands/context.mjs";
import { mergeImportEdges, moonProvider } from "../providers/moon.mjs";

export { PROJECT_CONFIG_FILE, nodeTypeOf, buildDependencies };

/**
 * One `project.json` — or the `package.json` beside it — read the way Nx reads
 * it, which is NOT `JSON.parse`.
 *
 * The reader itself is `../nx-json.mjs`, shared with `../options.mjs` because
 * `nx.json` has to be read the same way for the same reason. This name stays as
 * the local one because the stakes are specific to a project config, and worth
 * stating where a reader of this module will look for them: losing a
 * `project.json` here is the worst failure this server can have. The project
 * leaves the graph; an import into it then resolves as external rather than
 * cross-project; the rule engine's npm branch returns before the tag checks
 * run; and the editor paints a real violation clean.
 *
 * @param {string} text
 * @returns {object} Whatever the JSON describes.
 * @throws {Error} when neither parser can read it.
 */
export const parseProjectJson = parseNxJson;

/**
 * Every file git considers part of the working tree, workspace-relative and
 * `/`-separated.
 *
 * `-z` because a path may legitimately contain a newline, and splitting on one
 * would invent two files that do not exist.
 *
 * @param {string} root Absolute workspace root.
 * @returns {string[]}
 * @throws {Error} when git cannot answer — not a git tree, git not installed.
 */
export function listWorkspaceFiles(root) {
  try {
    // The one git spawn both faces share (`../workspace.mjs`'s
    // `listTrackedFiles`), not a second git invocation with a different flag
    // set: a CLI verdict and an editor verdict over the same tree must agree
    // about which files even exist. `listTrackedFiles` runs through
    // `../process.mjs`'s `runProcess`, which uses the same `environmentForTree`
    // guard against an ambient `GIT_DIR` this branch used to apply itself.
    return listTrackedFiles(root);
  } catch (cause) {
    throw new Error(
      `archkeep: cannot list the files of ${root}: ${cause?.message ?? cause}. ` +
        `The language server reads the workspace's file list from git; without it there is ` +
        `no project list, and every file would be reported as having no boundary to cross.`,
      { cause },
    );
  }
}

/** The directory part of a workspace-relative path; `""` at the tree root. */
const directoryOf = (file) => {
  const slash = file.lastIndexOf("/");
  return slash === -1 ? "" : file.slice(0, slash);
};

/**
 * The projects declared in a tree, from its `project.json` files.
 *
 * A `project.json` that will not parse is SKIPPED and reported, not thrown on:
 * one project being edited must not blank the graph for the other nineteen. The
 * caller decides how loud to be about the ones that were skipped.
 *
 * @param {{files: string[], readFile: (path: string) => string|null}} tree
 * @returns {{projects: {name: string, root: string, config: object}[], skipped: {file: string, reason: string}[]}}
 */
export function discoverProjects({ files, readFile }) {
  const projects = [];
  const skipped = [];
  for (const file of files) {
    if (file !== PROJECT_CONFIG_FILE && !file.endsWith(`/${PROJECT_CONFIG_FILE}`)) continue;
    const text = readFile(file);
    if (text === null) {
      skipped.push({ file, reason: "could not be read" });
      continue;
    }
    let config;
    try {
      config = parseProjectJson(text);
    } catch (cause) {
      skipped.push({ file, reason: `is not valid JSON: ${cause?.message ?? cause}` });
      continue;
    }
    const root = directoryOf(file);
    // Nx's own precedence: the name a project states, then the one its
    // `package.json` states, then the directory it lives in.
    const packageName = (() => {
      const manifest = readFile(root === "" ? "package.json" : `${root}/package.json`);
      if (manifest === null) return undefined;
      try {
        // The same parser, because Nx reads this file with the same
        // `readJsonFile` — a `package.json` Nx can name a project from must
        // not become a project named after its directory here.
        return parseProjectJson(manifest).name;
      } catch {
        return undefined;
      }
    })();
    const name =
      config.name ?? packageName ?? (root === "" ? "" : root.slice(root.lastIndexOf("/") + 1));
    if (typeof name !== "string" || name === "") {
      skipped.push({ file, reason: "declares no usable project name" });
      continue;
    }
    projects.push({ name, root, config });
  }
  return { projects, skipped };
}

/**
 * The graph nodes for a project list, in Nx's shape: `data` is the project's
 * own configuration with `tags` guaranteed present, because `../rules/tags.mjs`
 * reads it unguarded and an absent list is not the same fact as an empty one.
 *
 * @param {{name: string, root: string, config: object}[]} projects
 * @returns {Record<string, object>}
 */
export function buildNodes(projects) {
  // Null-prototype for the same reason `../providers/native/graph.mjs` and
  // `../providers/moon.mjs` use them: every key here is a project NAME, and
  // project names come from a `project.json`'s own `name` field —
  // attacker-supplied the moment a pull request adds a project called
  // `__proto__`. A plain `{}` answers `nodes["__proto__"] = …` by repointing
  // the object's OWN prototype rather than adding an entry, so the project
  // vanishes from `graph.nodes` while `filesOf` still attributes it files — a
  // real cross-project import into it then read a poisoned Node as a graph
  // node and flips/throws on every rule that touches it. `Object.create(null)`
  // has no inherited `__proto__` accessor to collide with, so the name behaves
  // like every other project name: a real, own, enumerable entry.
  const nodes = Object.create(null);
  for (const { name, root, config } of projects) {
    nodes[name] = {
      name,
      type: nodeTypeOf(name, config.projectType),
      data: { ...config, root, tags: config.tags ?? [] },
    };
  }
  return nodes;
}

/**
 * Everything a diagnosis needs about the tree, computed once.
 *
 * The `workspace` object is built ONCE and reused for every analysis, on
 * purpose: `../analysis/source-util.mjs`'s `perWorkspace` cache is keyed on
 * that object's identity, so a fresh object per file would re-read every Go,
 * Cargo and uv manifest in the tree per file analyzed.
 *
 * That identity is also why `tsConfig` is a property of the object rather than
 * an argument beside it — see `createWorkspace` in `../workspace.mjs`. A server
 * that reloads its options after an `nx.json` edit rebuilds the index, so the
 * new name arrives with a new object and the old parse is dropped with the old
 * one.
 *
 * @param {{root: string, tsConfig?: string, listFiles?: (root: string) => string[], readFileAt?: (root: string, path: string) => string|null, readLayout?: typeof readWorkspaceLayout, pathExists?: (path: string) => boolean, readGraph?: (root: string) => object}} options
 *   `pathExists` and `readGraph` are the Moon branch's seams — plain
 *   filesystem existence (the marker is a directory, which `readFileAt`
 *   cannot answer) and the provider's one-call graph reader, both injectable
 *   for the same reason `listFiles` is.
 * @returns {{root: string, files: string[], workspace: object, graph: object, skippedProjects: object[], fileFailures: object[], nativeMarker: boolean, nativeModelFailure: string|null, moonModelFailure: string|null, nxModelFailure: string|null, workspaceLayoutFailure: string|null}}
 * @throws {Error} when the file list cannot be obtained. Loud on purpose: an
 *   index built from no files would put every file in no project, and a file in
 *   no project has no boundary to cross — a clean report, produced by not
 *   looking. Also when the root carries more than one project-model marker —
 *   a Moon directory beside `nx.json`/`archkeep.json`, both Moon spellings at
 *   once, or `nx.json` beside `archkeep.json` (`../commands/context.mjs`'s
 *   `requireSingleProjectModel`, the same refusal `check` makes) — which
 *   config governs at all is a decision nobody made, refused the same way an
 *   unreadable `nx.json` is, through this function's caller in `./server.mjs`.
 */
export function buildWorkspaceIndex({
  root,
  tsConfig,
  listFiles = listWorkspaceFiles,
  readFileAt = readWorkspaceFile,
  readLayout = readWorkspaceLayout,
  pathExists = existsSync,
  readGraph = moonProvider.readProjectGraph,
}) {
  const files = listFiles(root);
  const readFile = (path) => readFileAt(root, path);
  // Which provider may judge this root at all — the SAME gate
  // (`../commands/context.mjs`'s `requireSingleProjectModel`) the CLI reads
  // before any command runs, so a tree carrying a Moon directory beside
  // `nx.json`/`archkeep.json` is refused here exactly as `check` refuses it,
  // in the same words, from the one copy of the rule. Before the shared
  // gate, this module judged such trees anyway — `.moon` beside `archkeep.json`
  // fell to the native branch and indexed nothing, silently; `.moon` beside
  // `nx.json` built a Moon index and never read the `nx.json` it sat beside.
  // Moon-versus-Moon coexistence rides the same gate through
  // `../providers/moon.mjs`'s `moonMarkerAt`. Checked on the REAL filesystem
  // (`pathExists`, default `existsSync`), never git's tracked list: a
  // directory cannot be read the way `archkeep.json` is below, and the
  // tracked-list gate is exactly the native-branch defect that check records
  // in its own comment.
  const { hasNx, moonMarker } = requireSingleProjectModel(root, { exists: pathExists });
  // A root carrying ARCHKEEP_MODEL_FILE has a project model this module does
  // not read from `project.json` at all — see this file's header — so it is
  // handed to the native branch below rather than to `discoverProjects`.
  //
  // Detected by READING the file, not by whether git tracks it: `../../cli.mjs`
  // and this server's own `readWorkspaceOptions` (`./server.mjs`'s `markersAt`)
  // both dispatch on `existsSync(join(root, ARCHKEEP_MODEL_FILE))` — plain
  // filesystem existence — and an untracked-but-present `archkeep.json` (added
  // to the tree but not yet `git add`ed) exists by that test. Dispatching here
  // on `files.includes(...)` instead — `files` is the TRACKED list `listFiles`
  // returns — disagreed with both of them: this branch would fall through to
  // `discoverProjects`, find no `project.json` for a native-only tree, and
  // build a zero-node, zero-edge index that publishes `analyzed: true` with an
  // empty diagnostic list on a workspace `archkeep check` exits 1 on — the gap
  // machinery below has no entry for "wrong provider" to report. `readFile`
  // reads the real filesystem the same way `existsSync` does (through
  // `readFileAt`, `./workspace-index.mjs`'s own `readWorkspaceFile` by
  // default), so this now agrees with the CLI regardless of git's index.
  if (readFile(ARCHKEEP_MODEL_FILE) !== null) {
    return buildNativeWorkspaceIndex({ root, files, readFile, tsConfig });
  }
  if (moonMarker !== null) {
    return buildMoonWorkspaceIndex({ root, files, readFile, tsConfig, readGraph });
  }

  const { projects, skipped } = discoverProjects({ files, readFile });
  const nodes = buildNodes(projects);
  // The same Module Federation fact the CLI path computes, from the same
  // predicate (`../workspace.mjs` → `annotateMFERemotes`): a CLI verdict and an
  // editor verdict on the same import must match, and the field failing closed
  // means an index that skipped this write would flag every import of a real
  // remote as `noImportsOfApps`.
  annotateMFERemotes(nodes, readFile);
  // And the two `package.json` facts, from the same shared functions the CLI
  // path calls (`../workspace.mjs` → `annotatePackageFacts`). Skipping this
  // write would fail closed — extra reports, not waived ones — but the two
  // faces would then disagree about the same import, which is the line
  // `src/lsp/` exists to hold. It also DELETES a stale `entryPoints` or
  // `declaredPackages` riding in from `project.json` (`buildNodes` spreads that
  // config into `data` verbatim), because an unmeasured claim that waives
  // violations is the silent direction.
  annotatePackageFacts(nodes, readFile);

  // The `Workspace` object and the per-project file index, from the SAME
  // `createWorkspace` the CLI path uses (`../commands/context.mjs`) — longest
  // root wins by `projectOwning`, and its root normalisation is what keeps a
  // root-level project (`"."`) owning the root-level files at all (cf. #32).
  // One implementation is also why `projectOf` here and the CLI's agree about
  // which file belongs to which project; a second copy is a second answer.
  const { workspace, owned } = createWorkspace({
    root,
    graph: { nodes },
    files,
    tsConfig,
    read: readFile,
  });
  const projectOfFile = new Map(owned.map(({ file, project }) => [file, project]));
  const projectOf = (file) => projectOfFile.get(file);

  const { importSites, fileFailures } = analyzeTrackedFiles({ files, workspace });

  // `nx.json`'s `workspaceLayout` reaches the rule engine here the same way
  // `../providers/nx.mjs`'s `readProjectGraph` merges it onto the graph it
  // returns to `cli.mjs` — see that function's own doc for why a merge step
  // exists at all (`nx graph --file=` itself emits no such key) and why a
  // declared-but-incomplete layout is refused rather than completed
  // (`requireCompleteWorkspaceLayout`, `../options.mjs`). Without this, an
  // editor open on a workspace with a non-default `appsDir`/`libsDir` would
  // draw no diagnostic for exactly the import `archkeep check` flags on the
  // same tree — the language server's own stated rule (this package's
  // `AGENTS.md`, "An empty diagnostic list must mean 'no violation'"),
  // violated from the direction it exists to catch. A read/validation
  // failure is caught rather than thrown onward — one malformed `nx.json`
  // must not blank the whole index — and recorded as `workspaceLayoutFailure`
  // for `indexGaps` to turn into a diagnostic, the same shape
  // `nativeModelFailure` already uses for the native branch's own
  // model-load failure.
  let workspaceLayout;
  let workspaceLayoutFailure = null;
  try {
    const declared = requireCompleteWorkspaceLayout(readLayout(root));
    if (declared !== null) workspaceLayout = declared;
  } catch (cause) {
    workspaceLayoutFailure = cause?.message ?? String(cause);
  }

  // An Nx-marked root that yielded no project at all is a tree this branch
  // could not see the shape of, not a tree with nothing in it.
  // `discoverProjects` above finds a project only by its `project.json`, and a
  // PACKAGE-BASED Nx workspace has none: its projects are declared in
  // `package.json` files, which this module reads only to resolve the NAME of a
  // project a `project.json` already found. `../providers/nx.mjs`'s
  // `readProjectGraph` asks Nx itself (`nx graph --file=`) and DOES see them,
  // so `../../cli.mjs`'s `check` reports violations on exactly the tree this
  // index would otherwise publish clean — zero nodes, every file in no project,
  // no boundary to cross, an empty diagnostic list byte-for-byte identical to a
  // clean workspace (`../../../../AGENTS.md`).
  //
  // Recorded, not thrown, and not resolved: this branch does not learn to read
  // package-based projects — that is the second project-model reader this
  // package must not grow (`../../AGENTS.md`) — it says it could not see the shape
  // of the tree. The field is the same shape `nativeModelFailure` and
  // `moonModelFailure` already use, a string on an index that is otherwise a
  // valid, empty shape, so `indexGaps` turns it into one diagnostic and
  // `./diagnose.mjs` refuses to call any document analyzed while it stands. It
  // clears itself like the rest of that family: `nx.json` and `project.json`
  // are both watched (`./server.mjs`), so the first `project.json` the tree
  // gains republishes every open document.
  //
  // Gated on the `nx.json` marker `requireSingleProjectModel` already read,
  // never on "zero nodes" alone: a root carrying NO project-model marker
  // reaches this same branch, and what to say about a directory that is not a
  // workspace at all is a different question, decided by the marker walk in
  // `../commands/context.mjs` rather than here.
  const nxModelFailure =
    hasNx && Object.keys(nodes).length === 0
      ? `no ${PROJECT_CONFIG_FILE} is among this tree's tracked files, and this server ` +
        `discovers an Nx workspace's projects from those files only — a package-based ` +
        `workspace, whose projects are declared in package.json, yields none`
      : null;

  return {
    root,
    files,
    workspace,
    graph: {
      nodes,
      dependencies: buildDependencies({ importSites, nodes, projectOf }),
      ...(workspaceLayout === undefined ? {} : { workspaceLayout }),
    },
    skippedProjects: skipped,
    fileFailures,
    nativeMarker: false,
    nativeModelFailure: null,
    moonModelFailure: null,
    nxModelFailure,
    workspaceLayoutFailure,
  };
}

/**
 * Every import site the tracked, analyzable files yield, and what could not be
 * read or analyzed along the way — shared between the Nx-shaped branch above
 * and the native branch below, because the question ("what does this file
 * import, and what stopped it from answering") does not depend on which
 * provider found the project list.
 *
 * The loop is `../workspace.mjs`'s `analyzeWorkspace` — the SAME loop
 * `../../cli.mjs`'s `check` runs over the same files — with one injected
 * difference: a throw is caught into a whole-file `fileFailure` record rather
 * than allowed to cost the whole graph. `analyzeFile` throws for a language
 * whose analyzer is not written yet, and one such language must not blank
 * nineteen projects' worth of edges; the document-level diagnosis re-analyzes
 * the open file itself, where the same throw becomes a diagnostic the reader
 * sees. That catch is the only behavioural difference from the CLI's loop —
 * everything else (which files, which reads, which records) is the shared one.
 *
 * One filter: the loop records whole-file failures only
 * (`../analysis/source-util.mjs`'s `isWholeFileFailure`). A positioned
 * failure — a parse error at a line:column, a specifier TypeScript could not
 * resolve from a particular file — is a site failure: that import was not
 * judged, but the rest of the file was, and the document-level diagnosis
 * re-analyzes the open file and shows that site failure wherever a reader can
 * see it. A whole-file failure means the graph genuinely missed every import
 * that file makes, which is the incompleteness `indexGaps` must report.
 *
 * @param {{files: string[], workspace: object}} args
 * @returns {{importSites: object[], fileFailures: {sourceFile: string, reason: string}[]}}
 */
function analyzeTrackedFiles({ files, workspace }) {
  const analysis = analyzeWorkspace(workspace, files, {
    analyze: (request) => {
      try {
        return analyzeFile(request);
      } catch (cause) {
        return {
          imports: [],
          failures: [fileFailure(request.sourceFile, cause?.message ?? String(cause))],
        };
      }
    },
  });
  return {
    importSites: analysis.imports,
    // Whole-file failures only — the same split `../../cli.mjs`'s `check`
    // draws (`notAnalyzed` vs `blindSpots`): a file whose imports are entirely
    // unknown makes the graph INCOMPLETE for every open document, while a
    // POSITIONED failure (one unparseable site) is a site fact reported at
    // that file's own document level — its other import sites are still in the
    // graph, so the prelude would over-warn. This matches the pre-fork LSP,
    // which never surfaced positioned failures in `indexGaps` either.
    fileFailures: analysis.failures.filter(isWholeFileFailure),
  };
}

/**
 * The native branch of `buildWorkspaceIndex`: drives `../providers/native/`'s
 * two-call contract (`discover()` then `buildGraph()`) instead of
 * `discoverProjects`/`buildNodes`, because a `archkeep.json` project can have no
 * `project.json` at all — see this module's header.
 *
 * @param {{root: string, files: string[], readFile: (path: string) => string|null, tsConfig?: string}} args
 * @returns {ReturnType<typeof buildWorkspaceIndex>}
 */
function buildNativeWorkspaceIndex({ root, files, readFile, tsConfig }) {
  let discovered;
  try {
    discovered = nativeProvider.discover({ root, files, readFile });
  } catch (cause) {
    // A model defect — malformed JSON, a declared root with no tracked file
    // under it, a `projectRules` row matching nothing, a stale
    // `coverage.exempt` entry (`../providers/native/index.mjs`'s `discover`) —
    // is not thrown onward: one broken `archkeep.json` must not take the whole
    // session down. It still has to be LOUD (`../../../../AGENTS.md`), so it
    // becomes `nativeModelFailure` on an index that is otherwise a valid,
    // empty shape rather than a missing one. `workspaceLayoutFailure` stays
    // `null` here rather than growing a second try/catch of its own: a
    // malformed `archkeep.json`'s `workspaceLayout` is one of the shapes
    // `loadNativeModel` already refuses (`../providers/native/model.mjs`'s
    // `workspaceLayoutViolations`), so it surfaces as THIS failure, not a
    // separate one — the two fields would otherwise say the same thing twice.
    const workspace = { root, projects: [], filesOf: () => [], readFile, tsConfig };
    return {
      root,
      files,
      workspace,
      graph: { nodes: Object.create(null), dependencies: Object.create(null) },
      skippedProjects: [],
      fileFailures: [],
      nativeMarker: true,
      nativeModelFailure: cause?.message ?? String(cause),
      moonModelFailure: null,
      nxModelFailure: null,
      workspaceLayoutFailure: null,
    };
  }

  // The `Workspace` object, from the same `createWorkspace` the CLI's native
  // branch uses (`../commands/context.mjs`'s native composition, preGraph →
  // `createWorkspace` → `analyzeWorkspace`): the projects discovered here
  // become the graph's nodes, and the workspace is built over them exactly the
  // way `check` builds its own over the same discovery. `discovered.projectOf`
  // is still what `nativeProvider.buildGraph` resolves import sites through —
  // it and `createWorkspace`'s `projectOwning` answer the same longest-root
  // question, and one graph is the answer `evaluate()` actually judges.
  const preGraph = {
    nodes: Object.fromEntries(
      discovered.projects.map((project) => [
        project.name,
        { name: project.name, data: { root: project.root } },
      ]),
    ),
  };
  const { workspace } = createWorkspace({ root, graph: preGraph, files, tsConfig, read: readFile });

  const { importSites, fileFailures: analysisFailures } = analyzeTrackedFiles({ files, workspace });
  // `discovered.failures` — an unparseable `project.json`/`package.json`
  // (`../providers/native/discover.mjs`) and a tracked file none of the
  // discovered projects own (`../providers/native/coverage.mjs`) — are the
  // SAME whole-file `fileFailure` shape `analyzeTrackedFiles` above produces
  // for a file it could not read, so they fold into one list `indexGaps`
  // reports the same way: an unowned file is analyzed by nothing and judged
  // by nothing, which is exactly the hole `../providers/native/coverage.mjs`'s
  // own header names.
  const fileFailures = [...discovered.failures, ...analysisFailures];

  const graph = nativeProvider.buildGraph({ discovered, importSites });
  // The same Module Federation and `package.json` facts the Nx branch and
  // `../../cli.mjs`'s native branch both compute, from the same shared
  // functions (`../workspace.mjs`) — a CLI verdict and an editor verdict on
  // the same import must match.
  annotateMFERemotes(graph.nodes, readFile);
  annotatePackageFacts(graph.nodes, readFile);

  return {
    root,
    files,
    workspace,
    graph,
    skippedProjects: [],
    fileFailures,
    nativeMarker: true,
    nativeModelFailure: null,
    moonModelFailure: null,
    nxModelFailure: null,
    workspaceLayoutFailure: null,
  };
}

/**
 * The Moon branch of `buildWorkspaceIndex`: drives `../providers/moon.mjs`'s
 * one-call contract (`readProjectGraph`) — the same provider object
 * `../commands/context.mjs` hands `check` on this tree — instead of
 * `discoverProjects`/`buildNodes`, because a Moon project has no `project.json`
 * for those to find. See this module's header for the fall-through this branch
 * replaces.
 *
 * @param {{root: string, files: string[], readFile: (path: string) => string|null, tsConfig?: string, readGraph: (root: string) => object}} args
 * @returns {ReturnType<typeof buildWorkspaceIndex>}
 */
function buildMoonWorkspaceIndex({ root, files, readFile, tsConfig, readGraph }) {
  let graph;
  try {
    graph = readGraph(root);
  } catch (cause) {
    // A Moon invocation that cannot answer — binary missing from the
    // workspace's `node_modules/.bin`, nonzero exit, output that will not
    // parse (`../providers/moon.test.mjs` pins each at the provider) — leaves
    // ZERO nodes, and a zero-node graph judges every file clean. Recorded as
    // `moonModelFailure` on an otherwise-valid empty index rather than thrown:
    // one broken invocation must not blank the session, exactly as a broken
    // `archkeep.json` does not (`buildNativeWorkspaceIndex`'s catch above), and
    // `indexGaps` turns it into a diagnostic naming the failed command on every
    // open document. The next successful rebuild clears it; nothing watches the
    // binary, so that rebuild arrives through any watched-file change or an
    // editor restart.
    return {
      root,
      files,
      workspace: { root, projects: [], filesOf: () => [], readFile, tsConfig },
      graph: { nodes: Object.create(null), dependencies: Object.create(null) },
      skippedProjects: [],
      fileFailures: [],
      nativeMarker: false,
      nativeModelFailure: null,
      moonModelFailure: cause?.message ?? String(cause),
      nxModelFailure: null,
      workspaceLayoutFailure: null,
    };
  }

  // The `Workspace` object and ownership map, from the same `createWorkspace`
  // every other branch here uses — one longest-root answer to "which project
  // owns this file" for both faces.
  const { workspace, owned } = createWorkspace({ root, graph, files, tsConfig, read: readFile });
  const projectOfFile = new Map(owned.map(({ file, project }) => [file, project]));
  // The same Module Federation and `package.json` facts the Nx branch, the
  // native branch and `../../cli.mjs`'s Moon branch all compute, from the same
  // shared functions (`../workspace.mjs`) — a CLI verdict and an editor verdict
  // on the same import must match.
  annotateMFERemotes(graph.nodes, readFile);
  annotatePackageFacts(graph.nodes, readFile);

  const { importSites, fileFailures } = analyzeTrackedFiles({ files, workspace });
  // Moon's own graph carries only edges Moon itself resolved (`dependsOn`);
  // the imports this tree writes are folded in by the SAME merge the CLI's
  // Moon branch runs (`../providers/moon.mjs`'s `mergeImportEdges`), so an
  // undeclared crossing is judged by the reachability rules in the editor
  // exactly as `check` judges it — one implementation, not two (#223).
  mergeImportEdges(graph, {
    importSites,
    projectOf: (file) => projectOfFile.get(file),
  });

  return {
    root,
    files,
    workspace,
    graph,
    skippedProjects: [],
    fileFailures,
    nativeMarker: false,
    nativeModelFailure: null,
    moonModelFailure: null,
    nxModelFailure: null,
    workspaceLayoutFailure: null,
  };
}

/**
 * What the index could not read, as sentences a reader can act on — empty when
 * the tree was read whole.
 *
 * ## Why a gap is reported to EVERY document and not to a chosen few
 *
 * The obvious economy is to tell only the documents a gap can plausibly reach:
 * the files inside the project that vanished, the imports that pointed at it.
 * It is not sound. Two of the fifteen rules are decided on the transitive
 * closure of the graph — `noCircularDependencies`, and the upstream half of
 * `notDependOnLibsWithTags` — and `../rules/reachability.mjs` builds that
 * closure over every node. A project missing from `nodes` also silently drops
 * every edge that pointed at it (`buildDependencies` refuses an edge to a node
 * it does not have), and a file recorded in `fileFailures` was never analyzed,
 * so it contributed none. Either one moves the closure for projects that are
 * nowhere near the file that broke. Deciding a document is unaffected would
 * mean recomputing its verdict against the complete graph — which is the thing
 * that could not be built.
 *
 * ## Why saying it everywhere is still not noise
 *
 * Not because the audience is narrow, but because of what is said and when:
 *
 * - **One diagnostic, never one per gap.** Every gap folds into a single
 *   warning with a bounded list (`./diagnostics.mjs`), so the marker count does
 *   not scale with the breakage.
 * - **A `skippedProjects`/`fileFailures` gap exists only while Nx is broken
 *   too.** `project.json` is parsed the way Nx parses it, so a skipped
 *   project is a file `nx graph` also refuses — a state a developer is
 *   walking out of, not one they work in. It also **clears itself**:
 *   `project.json` is already a watched file (`./server.mjs`), so the fix
 *   republishes every open document without any editor action.
 * - **A `nativeModelFailure` gap behaves like the other two, not like the
 *   permanent one this replaced.** It is present only while
 *   `../providers/native/index.mjs`'s `discover()` actually threw — a
 *   defect in `archkeep.json` or the tree it describes, not merely the fact
 *   that the root carries one — and it **clears itself** the same way:
 *   `archkeep.json` is already a watched file (`./server.mjs`), so fixing it
 *   republishes every open document without any editor action.
 * - **A `moonModelFailure` gap is the Moon branch's own member of that same
 *   family**, not a second copy of any of them: present only while
 *   `../providers/moon.mjs`'s `readProjectGraph` actually threw — binary
 *   missing, nonzero exit, unparseable output — never merely because the root
 *   carries a Moon marker. It clears itself on the next successful rebuild,
 *   which nothing watches the `moon` binary to trigger: it arrives through
 *   any watched-file change or an editor restart, and the gap names the
 *   command whose failure a developer has to resolve.
 * - **An `nxModelFailure` gap is that same family again, for the Nx-shaped
 *   branch's own project discovery.** Present only while `nx.json` marks the
 *   root AND `discoverProjects` found no project in it at all — never merely
 *   because the root carries `nx.json`. A package-based Nx workspace (projects
 *   declared in `package.json`, no `project.json` anywhere) is the shape that
 *   reaches it, and reading that shape is NOT what this server does about it:
 *   `../providers/nx.mjs`'s `readProjectGraph` asks Nx for that graph and
 *   `../../cli.mjs`'s `check` reports violations on the same tree, so silence
 *   here is the editor painting clean a workspace the CLI is failing. It
 *   **clears itself** like the rest: `nx.json` and `project.json` are both
 *   watched (`./server.mjs`), so the first `project.json` the tree gains
 *   republishes every open document.
 * - **A `workspaceLayoutFailure` gap is the Nx-shaped branch's own
 *   equivalent of `nativeModelFailure`, not a second copy of it.** It is
 *   present only while `NX_CONFIG_FILE`'s own `workspaceLayout` is malformed
 *   or declared partially (`../options.mjs`'s `readWorkspaceLayout` /
 *   `requireCompleteWorkspaceLayout`, called from `buildWorkspaceIndex`
 *   above) — never on the native branch, where the identically-shaped
 *   failure already surfaces as `nativeModelFailure` instead (see
 *   `buildNativeWorkspaceIndex`). It **clears itself** the same way: `nx.json`
 *   is already a watched file (`./server.mjs`), so fixing it republishes
 *   every open document without any editor action. Silently discarding the
 *   whole declaration instead — falling back to a default layout — would
 *   evaluate `noRelativeOrAbsoluteImportsAcrossLibraries` against a layout
 *   the workspace does not use, which reads to a developer as "no
 *   violation" rather than "this could not be checked".
 *
 * Each sentence names a path, so the diagnostic says which file to open.
 *
 * @param {{skippedProjects?: {file: string, reason: string}[], fileFailures?: {sourceFile: string, reason: string}[], nativeModelFailure?: string|null, moonModelFailure?: string|null, nxModelFailure?: string|null, workspaceLayoutFailure?: string|null}} index
 * @returns {string[]}
 */
export function indexGaps({
  skippedProjects = [],
  fileFailures = [],
  nativeModelFailure = null,
  moonModelFailure = null,
  nxModelFailure = null,
  workspaceLayoutFailure = null,
} = {}) {
  return [
    ...(nativeModelFailure === null
      ? []
      : [
          `${ARCHKEEP_MODEL_FILE} at the workspace root could not be turned into a project model ` +
            `(${firstLine(nativeModelFailure)}), so every project it declares or infers is ` +
            `missing from the graph entirely`,
        ]),
    ...(moonModelFailure === null
      ? []
      : [
          "`moon project-graph --json` could not be turned into a project model " +
            `(${firstLine(moonModelFailure)}), so every project it resolves is missing from ` +
            `the graph entirely`,
        ]),
    ...(nxModelFailure === null
      ? []
      : [
          `${NX_CONFIG_FILE} at the workspace root marks an Nx workspace whose projects could ` +
            `not be found (${firstLine(nxModelFailure)}), so every project it has is ` +
            `missing from the graph entirely — \`archkeep check\`, which asks Nx itself for the ` +
            `graph, still judges this tree`,
        ]),
    ...(workspaceLayoutFailure === null
      ? []
      : [
          `${NX_CONFIG_FILE}'s workspaceLayout could not be read (${firstLine(workspaceLayoutFailure)}), ` +
            `so imports across a non-default apps/libs boundary are judged against the default layout ` +
            `instead of the one this workspace declared`,
        ]),
    ...skippedProjects.map(
      ({ file, reason }) =>
        `${file} ${firstLine(reason)}, so that project is missing from the graph entirely`,
    ),
    ...fileFailures.map(
      ({ sourceFile, reason }) =>
        `${sourceFile} could not be analyzed (${firstLine(reason)}), so the imports it makes are ` +
        `missing from the graph`,
    ),
  ];
}

/**
 * The first line of a recorded reason.
 *
 * Nx's parse errors carry a multi-line code frame after their first line, and
 * that frame is decoration around a fact the first line already states — the
 * `line:column` of the offending character. A diagnostic message that opens an
 * ASCII drawing mid-sentence is read as noise, which is the one thing this
 * report cannot afford to be. The full text stays in the index's own records.
 */
const firstLine = (reason) => String(reason).split("\n")[0].trimEnd();

/**
 * Workspace-relative read; `null` for a file that is absent or unreadable.
 *
 * The contract's own reader shape (`../analysis/contract.md`): `null` rather
 * than a throw, because an analyzer treats a file it cannot read as a failure
 * record and one such file must not blank a whole run.
 *
 * @param {string} root Absolute workspace root.
 * @param {string} path Workspace-relative.
 * @returns {string|null}
 */
export function readWorkspaceFile(root, path) {
  const abs = join(root, path);
  // Same containment rule as `createWorkspace`'s default reader
  // (`../workspace.mjs`): a tracked symlink whose realpath leaves the
  // workspace is outside code read as the workspace's own source, so it is
  // refused rather than read. `null` is a whole-file failure here — the
  // analyzer records it, `analyzeTrackedFiles` surfaces it as an `indexGaps`
  // diagnostic, never a silently empty index (`../../AGENTS.md`).
  if (containmentViolation(root, abs) !== null) return null;
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}
