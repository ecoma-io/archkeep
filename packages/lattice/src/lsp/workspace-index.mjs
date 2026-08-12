/**
 * The workspace as the rule engine needs to see it: an Nx-shaped project graph,
 * and the `Workspace` object every analyzer resolves against.
 *
 * `evaluate(sites, graph, config)` is pure and takes a graph it does not build
 * (`../rules/README.md`). Under Nx that graph arrives from Nx. A language
 * server has no Nx — it is spawned by an editor, in a directory, with nothing
 * else — so this module builds the same shape from whichever source of truth
 * the root actually carries: the tracked `project.json` files when there is no
 * `lattice.json` at the root, and `../providers/native/`'s own `discover()`/
 * `buildGraph()` when there is (`buildNativeWorkspaceIndex` below).
 *
 * `nodeTypeOf`, `PROJECT_CONFIG_FILE` and `buildDependencies` are imported
 * from `../providers/native/`, not defined here — that package is where a
 * `project.json`-shaped graph is built for BOTH the Nx-less native provider
 * and this server, so the two do not grow separate copies of Nx's own
 * `getProjectType` rule and its implicit-dependency expansion
 * (`../../CLAUDE.md`, "`src/providers/` is the only layer allowed to build a
 * graph"). `discoverProjects` and `buildNodes` below are the Nx-shaped
 * branch's own project discovery — reading `project.json` is correct THERE,
 * because a root with no `lattice.json` has no other source of truth to read.
 *
 * ## Why the native branch cannot reuse `discoverProjects`
 *
 * A native workspace can declare or infer a project with no `project.json` at
 * all — the whole point of `lattice.json` is not needing one — and
 * `discoverProjects` below finds nothing there. A silently missing project is
 * indistinguishable from a project that legitimately has no boundary
 * violations, which is exactly the hole `../../../../AGENTS.md`'s invariant
 * refuses ("An empty result is a claim, not a shrug"). So a root carrying
 * `LATTICE_MODEL_FILE` runs `buildNativeWorkspaceIndex` instead: it drives
 * `../providers/native/`'s own `discover()` (declared∪inferred projects, the
 * files none of them own) and `buildGraph()` (nodes and dependencies from the
 * import sites this module still analyzes itself — provider-agnostic, and
 * unchanged either way).
 *
 * A `discover()` throw — a malformed `lattice.json`, a declared root with no
 * tracked file under it, a `projectRules` row matching no project, a stale
 * `coverage.exempt` entry — is caught rather than left to blank the whole
 * session: it becomes `nativeModelFailure` on the returned index, which
 * `indexGaps` turns into a diagnostic naming the defect, on an index that is
 * otherwise a valid, empty `workspace`/`graph` shape every caller downstream
 * can still iterate over. `lattice.json` is a watched file (`./server.mjs`),
 * so fixing it clears the gap the same way fixing a broken `project.json`
 * clears a `skippedProjects` one.
 *
 * ## What it may assume about the tree, which is nothing
 *
 * No project name, no directory layout, no tag vocabulary (`../../CLAUDE.md` —
 * the tool is installed into workspaces it has never seen). Everything below is
 * derived: projects from the `project.json` files that exist (Nx-shaped
 * branch) or from `lattice.json`'s declared∪inferred model (native branch),
 * node types from `projectType` by Nx's own rule either way, tags from each
 * project's own list, edges from the imports the analyzers actually find.
 *
 * ## Why the file list comes from git
 *
 * The analysis contract's `filesOf` means "the project's tracked files", and
 * git is the one component that already answers that exactly. The alternative
 * is a directory walk with a skip list — `node_modules`, `dist`, `target`,
 * `.venv` — which is a config nobody maintains until the day it swallows a real
 * source directory and the boundary quietly stops being enforced there. `--others --exclude-standard` adds
 * files that exist but are not committed yet, because a file a developer
 * created five seconds ago is exactly the one they are about to import.
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
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { analyzeFile, languageOf } from "../analysis/analyze.mjs";
import { parseNxJson } from "../nx-json.mjs";
import {
  NX_CONFIG_FILE,
  readWorkspaceLayout,
  requireCompleteWorkspaceLayout,
} from "../options.mjs";
import { annotateMFERemotes, annotatePackageFacts, environmentForTree } from "../workspace.mjs";
import { buildDependencies } from "../providers/native/graph.mjs";
import { nodeTypeOf, PROJECT_CONFIG_FILE } from "../providers/native/discover.mjs";
import { LATTICE_MODEL_FILE } from "../providers/native/model.mjs";
import { nativeProvider } from "../providers/native/index.mjs";

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
  let stdout;
  try {
    // `environmentForTree` and not the inherited environment: `GIT_DIR` beats
    // `cwd`, so a server started from a git hook would list another
    // repository's files and resolve them against this root.
    stdout = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      env: environmentForTree(),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (cause) {
    throw new Error(
      `lattice: cannot list the files of ${root}: ${cause?.message ?? cause}. ` +
        `The language server reads the workspace's file list from git; without it there is ` +
        `no project list, and every file would be reported as having no boundary to cross.`,
      { cause },
    );
  }
  return stdout.split("\0").filter((file) => file !== "");
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
  const nodes = {};
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
 * @param {{root: string, tsConfig?: string, listFiles?: (root: string) => string[], readFileAt?: (root: string, path: string) => string|null, readLayout?: typeof readWorkspaceLayout}} options
 * @returns {{root: string, files: string[], workspace: object, graph: object, skippedProjects: object[], fileFailures: object[], nativeMarker: boolean, nativeModelFailure: string|null, workspaceLayoutFailure: string|null}}
 * @throws {Error} when the file list cannot be obtained. Loud on purpose: an
 *   index built from no files would put every file in no project, and a file in
 *   no project has no boundary to cross — a clean report, produced by not
 *   looking.
 */
export function buildWorkspaceIndex({
  root,
  tsConfig,
  listFiles = listWorkspaceFiles,
  readFileAt = readWorkspaceFile,
  readLayout = readWorkspaceLayout,
}) {
  const files = listFiles(root);
  const readFile = (path) => readFileAt(root, path);
  // A root carrying LATTICE_MODEL_FILE has a project model this module does
  // not read from `project.json` at all — see this file's header — so it is
  // handed to the native branch below rather than to `discoverProjects`.
  if (files.includes(LATTICE_MODEL_FILE)) {
    return buildNativeWorkspaceIndex({ root, files, readFile, tsConfig });
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

  // Longest root wins, for the reason `../analysis/source-util.mjs` gives: a
  // project nested inside another's directory matches both roots, and a
  // first-match answer would attribute every one of its files to its parent.
  const byLongestRoot = [...projects].sort((a, b) => b.root.length - a.root.length);
  const projectOf = (file) =>
    byLongestRoot.find(({ root: r }) => r === "" || file === r || file.startsWith(`${r}/`))?.name;

  const filesByProject = new Map(projects.map(({ name }) => [name, []]));
  for (const file of files) {
    const owner = projectOf(file);
    if (owner !== undefined) filesByProject.get(owner).push(file);
  }

  const workspace = {
    root,
    projects: projects.map(({ name, root: projectRoot }) => ({ name, root: projectRoot })),
    filesOf: (name) => filesByProject.get(name) ?? [],
    readFile,
    tsConfig,
  };

  const { importSites, fileFailures } = analyzeTrackedFiles({ files, readFile, workspace });

  // `nx.json`'s `workspaceLayout` reaches the rule engine here the same way
  // `../providers/nx.mjs`'s `readProjectGraph` merges it onto the graph it
  // returns to `cli.mjs` — see that function's own doc for why a merge step
  // exists at all (`nx graph --file=` itself emits no such key) and why a
  // declared-but-incomplete layout is refused rather than completed
  // (`requireCompleteWorkspaceLayout`, `../options.mjs`). Without this, an
  // editor open on a workspace with a non-default `appsDir`/`libsDir` would
  // draw no diagnostic for exactly the import `lattice check` flags on the
  // same tree — the language server's own stated rule (this package's
  // `CLAUDE.md`, "An empty diagnostic list must mean 'no violation'"),
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
 * @param {{files: string[], readFile: (path: string) => string|null, workspace: object}} args
 * @returns {{importSites: object[], fileFailures: {sourceFile: string, reason: string}[]}}
 */
function analyzeTrackedFiles({ files, readFile, workspace }) {
  const importSites = [];
  const fileFailures = [];
  for (const file of files) {
    if (languageOf(file) === null) continue;
    const text = readFile(file);
    if (text === null) {
      fileFailures.push({ sourceFile: file, reason: "could not be read" });
      continue;
    }
    try {
      importSites.push(...analyzeFile({ sourceFile: file, text, workspace }).imports);
    } catch (cause) {
      // `analyzeFile` throws for a language whose analyzer is not written yet.
      // Recorded rather than rethrown: one unimplemented language must not cost
      // the whole graph, and the document-level diagnosis re-analyzes the open
      // file itself, where the same throw becomes a diagnostic the reader sees.
      fileFailures.push({ sourceFile: file, reason: cause?.message ?? String(cause) });
    }
  }
  return { importSites, fileFailures };
}

/**
 * The native branch of `buildWorkspaceIndex`: drives `../providers/native/`'s
 * two-call contract (`discover()` then `buildGraph()`) instead of
 * `discoverProjects`/`buildNodes`, because a `lattice.json` project can have no
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
    // is not thrown onward: one broken `lattice.json` must not take the whole
    // session down. It still has to be LOUD (`../../../../AGENTS.md`), so it
    // becomes `nativeModelFailure` on an index that is otherwise a valid,
    // empty shape rather than a missing one. `workspaceLayoutFailure` stays
    // `null` here rather than growing a second try/catch of its own: a
    // malformed `lattice.json`'s `workspaceLayout` is one of the shapes
    // `loadNativeModel` already refuses (`../providers/native/model.mjs`'s
    // `workspaceLayoutViolations`), so it surfaces as THIS failure, not a
    // separate one — the two fields would otherwise say the same thing twice.
    const workspace = { root, projects: [], filesOf: () => [], readFile, tsConfig };
    return {
      root,
      files,
      workspace,
      graph: { nodes: {}, dependencies: {} },
      skippedProjects: [],
      fileFailures: [],
      nativeMarker: true,
      nativeModelFailure: cause?.message ?? String(cause),
      workspaceLayoutFailure: null,
    };
  }

  const projects = discovered.projects.map(({ name, root: projectRoot }) => ({
    name,
    root: projectRoot,
  }));
  const filesByProject = new Map(projects.map(({ name }) => [name, []]));
  for (const file of files) {
    const owner = discovered.projectOf(file);
    if (owner !== undefined) filesByProject.get(owner).push(file);
  }

  const workspace = {
    root,
    projects,
    filesOf: (name) => filesByProject.get(name) ?? [],
    readFile,
    tsConfig,
  };

  const { importSites, fileFailures: analysisFailures } = analyzeTrackedFiles({
    files,
    readFile,
    workspace,
  });
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
 *   defect in `lattice.json` or the tree it describes, not merely the fact
 *   that the root carries one — and it **clears itself** the same way:
 *   `lattice.json` is already a watched file (`./server.mjs`), so fixing it
 *   republishes every open document without any editor action.
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
 * @param {{skippedProjects?: {file: string, reason: string}[], fileFailures?: {sourceFile: string, reason: string}[], nativeModelFailure?: string|null, workspaceLayoutFailure?: string|null}} index
 * @returns {string[]}
 */
export function indexGaps({
  skippedProjects = [],
  fileFailures = [],
  nativeModelFailure = null,
  workspaceLayoutFailure = null,
} = {}) {
  return [
    ...(nativeModelFailure === null
      ? []
      : [
          `${LATTICE_MODEL_FILE} at the workspace root could not be turned into a project model ` +
            `(${firstLine(nativeModelFailure)}), so every project it declares or infers is ` +
            `missing from the graph entirely`,
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
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return null;
  }
}
