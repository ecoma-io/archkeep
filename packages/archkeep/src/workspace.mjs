/**
 * The tree a run judges: which projects exist, which files they own, and what
 * analyzing all of them produces.
 *
 * This is the layer neither `analysis/` nor `rules/` is allowed to be. An
 * analyzer is handed one file and never decides which files to visit
 * (`analysis/contract.md`); a rule is handed records and never reads a file
 * (`rules/README.md`). Somebody still has to answer both questions, and the
 * answer touches the filesystem and spawns processes — so it lives here, once,
 * behind injectable seams, rather than inside `../cli.mjs` where a spawned
 * subprocess is the only way to test it.
 *
 * **Projects and tags come from a project-model provider, never from a walk of
 * our own.** `createWorkspace` below takes a `graph` it does not build — the
 * caller's answer to "what is a project and what is it tagged", derived from
 * `project.json`, `nx.json` plugins and whatever inference Nx applies. A
 * second reader of `project.json` files would be a second answer, and the two
 * would disagree exactly where a plugin contributes an edge. For a workspace
 * running under Nx, that graph comes from `./providers/nx.mjs`'s
 * `readProjectGraph`, which spawns `nx graph --file=` rather than importing
 * Nx: `nx` is not on this project's import list (project `AGENTS.md`), and
 * `nx graph --file=` is a stable documented surface where Nx's internal module
 * layout is not.
 *
 * **Files come from git.** `nx graph --file=` emits no file map, and the
 * alternative — walking the tree — would need its own ignore rules that drift
 * from `.gitignore` the first time a build directory is added. `git ls-files`
 * is the same tracked-file set every resolver in this project already reasons
 * about ("Resolvers read tracked files only", project `AGENTS.md`).
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";

import { containmentViolation } from "./containment.mjs";
import { analyzeFile, languageOf } from "./analysis/analyze.mjs";
import { basenameMatches } from "./analysis/manifest-util.mjs";
import { fileFailure, projectOwning } from "./analysis/source-util.mjs";
import { UsageError } from "./errors.mjs";
import { parseNxJson } from "./nx-json.mjs";
import { NX_CONFIG_FILE } from "./options.mjs";
// `runProcess` and `environmentForTree` moved to `./process.mjs`, which
// imports nothing beyond `node:child_process` — see that file's header for
// why. Imported (not just re-exported) because `listTrackedFiles` below still
// spawns through `runProcess` itself; re-exported so every import site that
// predates the split keeps working unchanged.
import { environmentForTree, runProcess } from "./process.mjs";

export { environmentForTree, runProcess };

/**
 * The workspace root at or above `from`, identified by a marker file.
 *
 * Nx's own root-finding rule, reproduced because the CLI has to agree with the
 * `nx` it spawns about which tree is being judged. It is deliberately NOT
 * derived from this file's own location: installed from a registry, this file
 * sits inside the consumer's `node_modules` and the tree it judges is above
 * that, so walking up from `import.meta.url` would find the wrong root — or,
 * with a hoisted install, the right one by luck (same reason
 * `loadBoundaryConfig` takes a root — see `config.mjs`).
 *
 * The walk is bounded by the enclosing git repository: a marker above the top
 * level `git rev-parse --show-toplevel` names for `from` is tooling state,
 * not this workspace's root. The case that made the bound necessary is
 * `~/.moon` — moonrepo's user-level state directory, present on every machine
 * moonrepo has ever run on (its own documentation puts the shared cache at
 * `~/.moon/cache/shared`), which a walk reading only directory existence
 * climbed to from any unmarked directory under the home directory, selecting
 * `$HOME` as a "Moon workspace" and failing to load
 * `$HOME/module-boundaries.config.mjs` instead of refusing (#339). The bound
 * is inclusive: a marker ON the top level is the ordinary case, a repository
 * that is itself the workspace. With no enclosing repository — or no `git` to
 * ask — there is no bound, and the walk climbs as far as it did before one
 * existed; the shape of the Moon markers is what holds the line there.
 *
 * `markers` defaults to `nx.json` alone, so every existing caller keeps
 * finding exactly the root it found before. A native-provider caller passes
 * `[NX_CONFIG_FILE, ARCHKEEP_MODEL_FILE]` to recognise either root marker in
 * one walk — see `../cli.mjs`, which is the only caller that needs to tell
 * the two apart, and does so by checking which marker(s) the returned
 * directory actually carries. A Moon marker names the directory's
 * `workspace.yml` — the file moonrepo itself requires of a workspace — never
 * the directory alone (`../providers/moon.mjs`'s `MOON_WORKSPACE_MARKER`):
 * a bare `.moon` is the user-level state directory again, and directory
 * presence alone is exactly what selected `$HOME`.
 *
 * @param {string} from Absolute directory to start at.
 * @param {string[]} [markers] Filenames or relative paths whose presence
 *   marks a workspace root. `existsSync` works for all of them — a relative
 *   path like `.moon/workspace.yml` is detected the same way a filename like
 *   `nx.json` is.
 * @param {{gitTopLevel?: (from: string) => string|null}} [io] The git seam:
 *   how the walk asks for the enclosing repository's top level, injectable
 *   for the same reason every spawn here is. The default runs
 *   `git rev-parse --show-toplevel` through `runProcess` — so ambient
 *   `GIT_DIR`-style redirects are stripped, the boundary describing the tree
 *   at `from` rather than whatever repository a hook exported — and answers
 *   `null` when git cannot (no repository encloses `from`, or git is absent).
 *   `null` is a missing boundary, never a refusal: the walk then climbs
 *   unbounded, exactly as it did before the boundary existed.
 * @returns {string|null} Absolute path, or `null` when no ancestor has one.
 */
export function findWorkspaceRoot(
  from,
  markers = [NX_CONFIG_FILE],
  { gitTopLevel = gitTopLevelOf } = {},
) {
  const ceiling = gitTopLevel(resolve(from));
  let current = resolve(from);
  for (;;) {
    if (markers.some((marker) => existsSync(join(current, marker)))) return current;
    // Inclusive on purpose: the marker check above already ran for the top
    // level itself, so reaching the ceiling with no marker means no ancestor
    // within the repository is a workspace root — and every ancestor beyond
    // it is outside the tree `git ls-files` would answer for.
    if (ceiling !== null && sameDirectory(current, ceiling)) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * The top level of the git repository enclosing `from` — the ceiling
 * `findWorkspaceRoot` above stops its walk at.
 *
 * `null` when none does or when git cannot answer (absent binary, bare
 * repository, unreadable `.git`): a boundary that cannot be measured is a
 * boundary absent, and the walk degrades to its previous unbounded climb
 * rather than refusing a root it never looked at. A repository git genuinely
 * cannot read is caught loudly one call later by `listTrackedFiles`, whose
 * own spawn has no `null` answer.
 */
function gitTopLevelOf(from) {
  try {
    // `stderr: "ignore"` because a directory no repository encloses is the
    // COMMON case this probe must answer quietly — git's `fatal: not a git
    // repository` belongs nowhere near a user's terminal for it.
    return runProcess("git", ["rev-parse", "--show-toplevel"], from, undefined, {
      stderr: "ignore",
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Do `a` and `b` name the same directory? `git rev-parse --show-toplevel`
 * answers a fully resolved path while the walk holds the spelling it was
 * given — on macOS every `os.tmpdir()` path starts `/var/folders/…`, whose
 * real spelling is `/private/var/folders/…`, and a plain `===` would let the
 * ceiling silently never bind there. Doubt answers false: a boundary that
 * fails to bind is the old walk, while one that binds wrongly refuses a real
 * workspace.
 */
const sameDirectory = (a, b) => {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

/**
 * Every tracked file in the workspace, workspace-relative.
 *
 * `-z` because a path may contain a newline, and because git otherwise quotes
 * and escapes any path outside plain ASCII — a quoted path would then be read
 * as a filename that does not exist.
 *
 * @param {string} workspaceRoot
 * @param {{ run?: typeof runProcess }} [io]
 * @returns {string[]}
 */
export function listTrackedFiles(workspaceRoot, { run = runProcess } = {}) {
  const out = run("git", ["ls-files", "-z"], workspaceRoot);
  return out.split("\0").filter((path) => path !== "");
}

/**
 * Every file present in the worktree that git does NOT track, workspace-
 * relative — the complement of `listTrackedFiles` above, and the answer to
 * the only question that pair can ask: what exists in the tree the tracked
 * universe was cut from, but never entered it (#675).
 *
 * `--exclude-standard` is what keeps this answer a git answer and not a walk
 * of our own: ignored files — build outputs, dependency installs, anything a
 * `.gitignore`, `.git/info/exclude` or `core.excludesFile` names — are not
 * part of the workspace's population, exactly as for the tracked list. The
 * header's argument for `git ls-files` over a tree walk applies here with one
 * more clause: walking the tree for the untracked half would need those ignore
 * rules reimplemented, and the copy would drift from `.gitignore` the first
 * time a build directory was added.
 *
 * The order is git's worktree-traversal order, not a sorted order — every
 * consumer of this list sorts before it renders (a file list in a report must
 * not vary with git's traversal), the same discipline
 * `../commands/check.mjs`'s `sortViolations` states for the tracked list.
 *
 * @param {string} workspaceRoot
 * @param {{ run?: typeof runProcess }} [io]
 * @returns {string[]}
 */
export function listUntrackedFiles(workspaceRoot, { run = runProcess } = {}) {
  const out = run("git", ["ls-files", "--others", "--exclude-standard", "-z"], workspaceRoot);
  return out.split("\0").filter((path) => path !== "");
}

/**
 * The `Workspace` the analysis contract defines — `{ root, projects, filesOf,
 * readFile, tsConfig }` — plus the per-project file index it is built from,
 * which the caller needs to decide what to analyze.
 *
 * Files are attributed by longest-root-prefix match, which is `projectOwning`'s
 * job and not a second copy of it: a project nested in another's directory owns
 * its own files, and a first-match answer would hand them to the parent.
 *
 * `tsConfig` rides on the workspace rather than being passed alongside it for
 * the reason `analysis/typescript.mjs` states: the parsed compiler options are
 * cached in a `WeakMap` keyed on this object, so a filename travelling beside
 * the key could disagree with the context stored under it. Omitted, the
 * analyzer falls back to the Nx convention.
 *
 * @param {{ root: string, graph: object, files: string[], tsConfig?: string,
 *   read?: (path: string) => string|null }} input
 * @returns {{ workspace: object, filesByProject: Map<string, string[]>, owned: {file: string, project: string}[] }}
 */
export function createWorkspace({ root, graph, files, tsConfig, read }) {
  const projects = Object.values(graph.nodes).map((node) => ({
    name: node.name,
    // Nx spells a root-level project's root as the literal string ".",
    // but `projectOwning` only treats "" as "matches every path" — a root
    // of "." fails both `path !== root` and `path.startsWith("./")` for every
    // real tracked path, so every root-level file would be silently unowned.
    // Normalise here, at the data-ingestion boundary, so the predicate stays
    // pure and both the Nx and native paths are fixed. cf. #32
    root: node.data.root === "." ? "" : node.data.root,
  }));
  const filesByProject = new Map(projects.map((project) => [project.name, []]));
  const owned = [];
  for (const file of files) {
    const project = projectOwning(projects, file);
    // A file no project owns is outside the boundary system entirely — the rule
    // engine returns nothing for it (`rules/index.mjs`), so it is dropped here
    // rather than read and analyzed for a verdict that cannot exist.
    if (!project) continue;
    filesByProject.get(project.name).push(file);
    owned.push({ file, project: project.name });
  }

  const readFile =
    read ??
    ((path) => {
      const abs = join(root, path);
      // A tracked symlink whose realpath leaves the workspace is outside code
      // reached as if it were the workspace's own source (`../AGENTS.md`'s
      // empty-result invariant: bytes read into the verdict from outside the
      // tree, reported clean). Returning null makes the file a whole-file
      // failure — loud, never a silent read-and-judge (`containment.mjs`).
      if (containmentViolation(root, abs) !== null) return null;
      try {
        return readFileSync(abs, "utf8");
      } catch {
        return null;
      }
    });

  return {
    workspace: {
      root,
      projects,
      filesOf: (name) => filesByProject.get(name) ?? [],
      readFile,
      tsConfig,
    },
    filesByProject,
    owned,
  };
}

/**
 * A file's workspace-relative path inside a project. `""` (the LSP index) and
 * `"."` (Nx's graph output) both mean the workspace root itself, and neither
 * may leak into the path: an in-memory reader keyed by exact path would answer
 * `null` for `./package.json`.
 */
const fileUnder = (projectRoot, name) =>
  projectRoot === "" || projectRoot === "." ? name : `${projectRoot}/${name}`;

/**
 * Is the project at `projectRoot` a Module Federation remote? Upstream's own
 * test, reproduced from `@nx/eslint-plugin`'s `appIsMFERemote` in its
 * `runtime-lint-utils` (measured at 23.1.1): read
 * `module-federation.config.js` beside the project root, fall back to the `.ts`
 * spelling when the `.js` one yields nothing — upstream's `readFileIfExisting`
 * answers `''` for a missing file and the `||` between the two reads treats an
 * existing-but-empty `.js` exactly the same way, so this does too — then grep
 * whichever text arrived for an `exposes:` key. A regex over the raw text,
 * never a parse: upstream's pattern matches the key quoted or bare, anywhere in
 * the file, and reproducing the pattern rather than improving on it is what
 * keeps the two enforcers giving one answer.
 *
 * @param {string} projectRoot Workspace-relative; `""` (the LSP index) and
 *   `"."` (Nx's graph output) both mean the workspace root itself.
 * @param {(path: string) => string|null} readFile Workspace-relative reader.
 * @returns {boolean}
 */
export function projectIsMFERemote(projectRoot, readFile) {
  const config =
    readFile(fileUnder(projectRoot, "module-federation.config.js")) ||
    readFile(fileUnder(projectRoot, "module-federation.config.ts"));
  if (!config) return false;
  return /('|")?exposes('|")?:/.test(config);
}

/**
 * Marks every app node with whether it is a Module Federation remote — the
 * fact the `noImportsOfApps` exemption turns on (`rules/topology.mjs` →
 * `appIsMFERemote` reads `data.mfeRemote`, and its absence fails closed, so an
 * adapter that does not write the field reports every import of a real remote).
 *
 * The fact is NOT in `nx graph --file=` output — nothing in nx 23.1.1 emits an
 * `mfeRemote` field anywhere (verified by searching its dist); upstream ESLint
 * computes it per lint run off the filesystem — so both adapters compute it
 * here, through the one predicate above, which is what keeps a CLI verdict and
 * an LSP verdict on the same import from disagreeing.
 *
 * Only app nodes are marked: the one check that reads the field
 * (`rules/index.mjs`) tests `type === "app"` first, exactly as upstream calls
 * its helper only on that branch — and not probing two candidate paths per
 * library keeps the read count from scaling with a tree's project count.
 *
 * @param {Record<string, object>} nodes Graph nodes, mutated in place.
 * @param {(path: string) => string|null} readFile Workspace-relative reader.
 */
export function annotateMFERemotes(nodes, readFile) {
  for (const node of Object.values(nodes)) {
    if (node.type !== "app") continue;
    node.data.mfeRemote = projectIsMFERemote(node.data.root, readFile);
  }
}

/**
 * The parsed `package.json` of the project at `projectRoot`, or `null` when
 * there is nothing to measure.
 *
 * Upstream reads this file through `readFileIfExisting`, which answers `''`
 * for a missing file, and then tests that answer for truthiness — so an
 * existing-but-empty manifest and an absent one are the same non-answer there,
 * and they are here. The parser is `parseNxJson`, because upstream hands the
 * text to `@nx/devkit`'s `parseJson` and a manifest carrying a trailing comma
 * or a comment is a manifest upstream reads.
 *
 * One deliberate divergence, in the loud direction: on a manifest neither
 * parser can read, upstream's `parseJson` throws mid-lint. Here the answer is
 * `null` — the fact was not measured, the field stays absent, and absence
 * fails closed in the rule layer (`rules/topology.mjs`), so the broken
 * manifest costs extra reports and never a waived violation. An editor's
 * language server re-reads on every keystroke, and a manifest is malformed for
 * exactly as long as someone is typing inside it.
 *
 * @param {string} projectRoot Workspace-relative; `""` and `"."` both mean the
 *   workspace root itself.
 * @param {(path: string) => string|null} readFile Workspace-relative reader.
 * @returns {object|null}
 */
function readPackageManifest(projectRoot, readFile) {
  const text = readFile(fileUnder(projectRoot, "package.json"));
  if (!text) return null;
  try {
    return parseNxJson(text);
  } catch {
    return null;
  }
}

/**
 * The secondary entry points a project's `package.json` `exports` map
 * declares, as the `{path, file}` pairs `rules/topology.mjs` walks — or `null`
 * when the manifest itself could not be measured (`readPackageManifest`), so
 * the caller keeps the graph field absent rather than claiming an empty list.
 *
 * Port of `@nx/eslint-plugin`'s `getPackageEntryPoints` + `parseExports` in
 * its `runtime-lint-utils` (measured at 23.1.1), the only files/fields
 * upstream consults for this fact: `<projectRoot>/package.json`, field
 * `exports`, and nothing else — `project.json` is never read for it, and the
 * `ng-package.json` fallback lives inside upstream's `getEntryPoint` walk, the
 * part `rules/topology.mjs` declares it does not reproduce. A manifest with no
 * `exports` answers `[]` exactly as upstream does.
 *
 * @param {string} projectRoot Workspace-relative; `""` and `"."` both mean the
 *   workspace root itself.
 * @param {(path: string) => string|null} readFile Workspace-relative reader.
 * @returns {{path: string, file: string}[]|null}
 */
export function packageEntryPoints(projectRoot, readFile) {
  const manifest = readPackageManifest(projectRoot, readFile);
  if (manifest === null) return null;
  if (!manifest.exports) return [];
  const entryPaths = [];
  parseExportsInto(manifest.exports, projectRoot, entryPaths);
  return entryPaths;
}

/**
 * Upstream's `parseExports`, reproduced quirk for quirk rather than repaired,
 * because the walk in `rules/topology.mjs` compares against exactly the pairs
 * upstream builds (each measured against the installed 23.1.1 by calling it):
 *
 * - A string at the top level, or under the `"."` key, is the MAIN entry point
 *   and yields nothing — only secondary entry points are collected.
 * - A conditional-exports object is detected by `import || require || default
 *   || node` but resolved as `default || import || require || node` — the two
 *   orders differ, so `{import, default}` follows `default`. The test is
 *   truthiness, so a key present with value `""` does not count.
 * - Any other object recurses per key with the KEY as the new base path —
 *   which discards the parent key (`{"./sub": {"./deep": f}}` yields
 *   `<root>/deep`), and turns a lone non-conditional key like `types` into an
 *   entry at `<root>/types`. An array walks the same branch, one entry per
 *   index (`<root>/0`, `<root>/1`).
 * - `path` and `file` are `joinPathFragments(projectRoot, …)`; `posix.join`
 *   computes the same answer on the workspace-relative `/`-separated paths
 *   both adapters feed it, including preserving a key's trailing slash — the
 *   one shape whose walk can match, see `./conformance/README.md`
 *   ("`getEntryPoint`'s directory branch is dead upstream" — corrected).
 *
 * @param {unknown} exports The `exports` value, any shape a manifest can hold.
 * @param {string} projectRoot
 * @param {{path: string, file: string}[]} entryPaths Mutated in place.
 * @param {string} [basePath]
 */
function parseExportsInto(exports, projectRoot, entryPaths, basePath = ".") {
  if (exports === null) return;
  if (typeof exports === "string") {
    if (basePath === ".") return;
    entryPaths.push({
      path: posix.join(projectRoot, basePath),
      file: posix.join(projectRoot, exports),
    });
    return;
  }
  const table = /** @type {Record<string, unknown>} */ (exports);
  if (table.import || table.require || table.default || table.node) {
    parseExportsInto(
      table.default || table.import || table.require || table.node,
      projectRoot,
      entryPaths,
      basePath,
    );
    return;
  }
  for (const [key, value] of Object.entries(table)) {
    parseExportsInto(value, projectRoot, entryPaths, key);
  }
}

/**
 * The external packages the project at `projectRoot` may treat as DIRECT
 * dependencies — the fact `noTransitiveDependencies` turns on — or `null` when
 * neither manifest could be measured, so the caller keeps the field absent.
 *
 * Port of `@nx/eslint-plugin`'s `isDirectDependency` in its
 * `runtime-lint-utils` (measured at 23.1.1), which answers
 * `packageExistsInPackageJson(name, '.') ||
 * packageExistsInPackageJson(name, source.data.root)` — the workspace root's
 * `package.json` and the source project's own, as one union, which is why one
 * list per node is enough for `rules/topology.mjs` to reproduce the `||`.
 * `packageExistsInPackageJson` itself is reproduced quirk for quirk:
 *
 * - Only `dependencies`, `peerDependencies` and `devDependencies` are read.
 *   `optionalDependencies` is NOT — upstream's own `getAllDependencies` in its
 *   `package-json-utils` includes it, but the boundary rule never calls that.
 * - The test is `dependencies[packageName]` — truthiness of the VALUE — so a
 *   dependency declared as `"pkg": ""` is invisible to upstream, and so it is
 *   invisible here.
 *
 * @param {string} projectRoot Workspace-relative; `""` and `"."` both mean the
 *   workspace root itself, whose manifest is then read once, not unioned with
 *   itself.
 * @param {(path: string) => string|null} readFile Workspace-relative reader.
 * @returns {string[]|null}
 */
export function declaredPackages(projectRoot, readFile) {
  const own = readPackageManifest(projectRoot, readFile);
  const atWorkspaceRoot = projectRoot === "" || projectRoot === ".";
  const workspace = atWorkspaceRoot ? own : readPackageManifest(".", readFile);
  if (own === null && workspace === null) return null;
  const names = new Set();
  for (const manifest of workspace === own ? [own] : [workspace, own]) {
    if (manifest === null) continue;
    for (const section of ["dependencies", "peerDependencies", "devDependencies"]) {
      const packages = manifest[section];
      if (!packages) continue;
      for (const [name, version] of Object.entries(packages)) {
        if (version) names.add(name);
      }
    }
  }
  return [...names];
}

/**
 * Writes the two `package.json` facts the rule layer reads as optional graph
 * fields — `data.entryPoints` (the secondary-entry-point exemptions) and
 * `data.declaredPackages` (`noTransitiveDependencies`) — onto every project
 * node, from the same manifests upstream reads per lint run.
 *
 * Neither fact is in `nx graph --file=` output — nothing in nx 23.1.1 writes
 * an `entryPoints` or `declaredPackages` field onto a graph node (verified by
 * searching its dist: `declaredPackages` appears nowhere, and every
 * `entryPoints` hit is the internal `entryPointsToProjectMap` its import
 * resolver builds and discards); upstream ESLint computes both per lint run
 * off the filesystem — so both adapters compute them here, through the two
 * functions above, which is what keeps a CLI verdict and an LSP verdict on the
 * same import from disagreeing (the arrangement `annotateMFERemotes`
 * established).
 *
 * Every project node is annotated, not one type: upstream reads the SOURCE
 * project's manifest for `belongsToDifferentEntryPoint` and
 * `isDirectDependency`, and the TARGET project's for its lazy-load check, so
 * any node can be asked for either fact.
 *
 * On these two adapters' graphs the fields mean "measured from
 * `package.json`", so a node whose manifest answers nothing has the field
 * DELETED rather than left as whatever the node carried: `nx graph --file=`
 * copies arbitrary `project.json` keys into `data` verbatim, and a stale
 * `entryPoints` or `declaredPackages` riding in from config would WAIVE
 * violations on a claim nobody measured — the silent direction. An absent
 * manifest therefore keeps (or makes) the field absent, and absence keeps
 * failing closed downstream.
 *
 * @param {Record<string, object>} nodes Graph nodes, mutated in place.
 * @param {(path: string) => string|null} readFile Workspace-relative reader.
 */
export function annotatePackageFacts(nodes, readFile) {
  // One read per distinct manifest per pass: every project's answer unions the
  // workspace root's manifest, and n reads of one unchanged file are n − 1
  // more than the fact needs.
  const seen = new Map();
  const readOnce = (path) => {
    if (!seen.has(path)) seen.set(path, readFile(path));
    return seen.get(path);
  };
  for (const node of Object.values(nodes)) {
    const entryPoints = packageEntryPoints(node.data.root, readOnce);
    if (entryPoints === null) delete node.data.entryPoints;
    else node.data.entryPoints = entryPoints;
    const declared = declaredPackages(node.data.root, readOnce);
    if (declared === null) delete node.data.declaredPackages;
    else node.data.declaredPackages = declared;
  }
}

/**
 * The tracked files a scoped run covers, given the paths a user named.
 *
 * A path may be absolute or relative to `cwd`, and may name a file or a
 * directory; a directory selects everything under it. No paths means the whole
 * workspace, which is the gate's mode — a scoped run is a local pre-check and
 * cannot be more, because the cycle and lazy-load rules judge the file graph as
 * a whole and the engine's index describes what was analyzed rather than what
 * exists (`rules/index.mjs` → `createFileDependencyIndex`).
 *
 * @param {string[]} files Workspace-relative tracked files to select from —
 *   typically already narrowed to the files a project owns.
 * @param {string[]} paths As typed on the command line.
 * @param {{ root: string, cwd: string, tracked?: string[] }} location `tracked`
 *   is the wider, ownership-independent universe a named path is checked
 *   against before `files` is filtered — defaults to `files` itself. The two
 *   differ for a caller like `check`, whose `files` is already narrowed to
 *   project-owned files: a path into a real, tracked-but-unowned area (a
 *   `docs/` directory, a root `README.md`) would match zero of `files` even
 *   though it names a legitimate, merely-empty slice — not a usage mistake.
 *   Testing the raw path against the untrimmed tracked set is what tells that
 *   apart from a path git has never heard of at all: a typo, the wrong `cwd`,
 *   or a file that was created but never `git add`ed — the case that made
 *   `archkeep check` exit 0 clean on a file whose committed twin, byte for
 *   byte, reported a real violation.
 * @returns {string[]} A subset of `files`.
 * @throws {UsageError} when a path lies outside the workspace, or matches no
 *   tracked file at all — silently selecting nothing would report a clean tree
 *   for a run that inspected none of it.
 */
export function selectFiles(files, paths, { root, cwd, tracked = files }) {
  if (paths.length === 0) return files;
  const withinPrefix = (file, prefix) =>
    prefix === "" || file === prefix || file.startsWith(`${prefix}/`);
  const prefixes = paths.map((path) => {
    const absolute = isAbsolute(path) ? path : resolve(cwd, path);
    const rel = relative(root, absolute);
    if (rel === "") return "";
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new UsageError(
        `archkeep: '${path}' is outside the workspace at ${root} — ` +
          `there is nothing there this tool could check`,
      );
    }
    if (!tracked.some((file) => withinPrefix(file, rel))) {
      throw new UsageError(
        `archkeep: '${path}' matches no tracked file at ${root} — check the ` +
          `path and the working directory, or 'git add' it first if it is new`,
      );
    }
    return rel;
  });
  return files.filter((file) => prefixes.some((prefix) => withinPrefix(file, prefix)));
}

/**
 * Analyzes every file that has an analyzer, in the order given.
 *
 * A file whose extension no analyzer claims is skipped before it is read —
 * `analyzeFile` would return the empty envelope for it anyway, and most of a
 * tracked tree is Markdown, JSON and images. A file that cannot be READ is a
 * failure record, never a throw: one unreadable file must not blank a run, or a
 * report empty because the tool tripped and a report empty because the tree is
 * clean print the same thing (`analysis/contract.md`).
 *
 * `analyzedFiles` carries the same count as a list, additively: a caller that
 * ran this over a wider set than it ultimately reports on (the native
 * provider's whole-tree analysis, scoped down for a `check <path>` run —
 * `cli.mjs`) needs to know WHICH files were analyzed, not just how many, to
 * recompute a scope-correct count without analyzing the tree a second time.
 *
 * @param {object} workspace The `Workspace` from `createWorkspace`.
 * @param {string[]} files Workspace-relative paths to consider.
 * @param {{ analyze?: typeof analyzeFile }} [io] Injectable analyzer.
 * @returns {{ imports: object[], failures: object[], analyzed: number, analyzedFiles: string[] }}
 */
/**
 * Extensions that cannot carry an import or a boundary crossing, so their
 * silence in analysis is never a coverage gap (#601): documentation,
 * structured data and configuration, binary assets, generated lockfiles.
 * A file in one of these formats has no imports for ANY analyzer to read —
 * listing it under "unsupported language" would name every README in every
 * workspace, and a gap that always fires teaches a reader to skip the line
 * it is written on (the argument `./commands/context.mjs`'s
 * `unownedAnalyzableFiles` already states for the same reason). The set must
 * never intersect `LANGUAGE_BY_EXTENSION` — a format that cannot carry an
 * import cannot become an analyzed language; `workspace.test.mjs` holds that
 * line, because an entry that crossed it would turn this exemption into the
 * silent direction.
 */
const DATA_BY_EXTENSION = Object.freeze(
  new Set([
    // Documentation.
    ".md",
    ".txt",
    ".rst",
    ".adoc",
    // Structured data and configuration.
    ".json",
    ".json5",
    ".jsonc",
    ".yaml",
    ".yml",
    ".toml",
    ".ini",
    ".cfg",
    ".conf",
    ".properties",
    ".xml",
    // Binary assets.
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".webp",
    ".ico",
    ".bmp",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".eot",
    ".mp4",
    ".mp3",
    ".wav",
    ".pdf",
    // Archives and generated artifacts.
    ".zip",
    ".gz",
    ".tgz",
    ".tar",
    ".br",
    // Generated lockfiles.
    ".lock",
    ".sum",
  ]),
);

/**
 * Extension-less basenames that are workspace furniture, not source: legal
 * notices and the two command files whose bodies are shell commands rather
 * than imports. `languageOf` answers `null` for every dotless name already —
 * this set is what keeps them out of the unsupported-language row without
 * inventing a general dotfile list.
 */
const DOTLESS_FURNITURE = Object.freeze(
  new Set([
    "LICENSE",
    "NOTICE",
    "AUTHORS",
    "CHANGELOG",
    "CODEOWNERS",
    "CONTRIBUTING",
    "SECURITY",
    "Makefile",
    "Dockerfile",
  ]),
);

/**
 * Whether a file no analyzer claims is nevertheless not a coverage gap —
 * the predicate `analyzeWorkspace` applies before naming a skipped file
 * under `unsupported-language` (#601). Three exemptions, each with the same
 * shape of reason: the file was never part of what this tool could judge.
 *
 * @param {string} sourceFile Workspace-relative path.
 * @returns {boolean}
 */
export function exemptFromUnsupportedLanguage(sourceFile) {
  // used by its own test
  const base = sourceFile.slice(sourceFile.lastIndexOf("/") + 1);
  // Dotfiles are editor and tool state (`.gitignore`, `.env`, `.npmrc`).
  if (base.startsWith(".")) return true;
  const dot = base.lastIndexOf(".");
  if (dot > 0 && DATA_BY_EXTENSION.has(base.slice(dot))) return true;
  if (DOTLESS_FURNITURE.has(base)) return true;
  // The polyglot manifests the manifest track itself reads — a `go.mod` is
  // claimed by the engine one layer down, not skipped by it.
  return basenameMatches(base, POLYGLOT_MANIFEST_NAMES, posix.matchesGlob);
}

export function analyzeWorkspace(workspace, files, { analyze = analyzeFile } = {}) {
  const imports = [];
  const failures = [];
  const analyzedFiles = [];
  // Files whose extension no analyzer claims AND whose silence is a coverage
  // gap (#601): skipped before reading, so naming them here is the only
  // record the run will ever carry that they existed — "not analyzed" must
  // not be indistinguishable from "not present". READMEs, manifests and
  // other formats that cannot carry an import are exempt
  // (`exemptFromUnsupportedLanguage` above): they are not an unsupported
  // language, they are workspace furniture the tool has always declined.
  const unsupportedLanguageFiles = [];
  for (const sourceFile of files) {
    if (languageOf(sourceFile) === null) {
      if (!exemptFromUnsupportedLanguage(sourceFile)) {
        unsupportedLanguageFiles.push(sourceFile);
      }
      continue;
    }
    const text = workspace.readFile(sourceFile);
    if (text === null) {
      failures.push(fileFailure(sourceFile, "could not be read"));
      continue;
    }
    analyzedFiles.push(sourceFile);
    const result = analyze({ sourceFile, text, workspace });
    imports.push(...result.imports);
    failures.push(...result.failures);
  }
  return {
    imports,
    failures,
    analyzed: analyzedFiles.length,
    analyzedFiles,
    unsupportedLanguageFiles,
  };
}

/** The polyglot manifests `polyglotManifests` looks for. */
const POLYGLOT_MANIFEST_NAMES = [
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "pom.xml",
  "settings.gradle",
  "settings.gradle.kts",
  "*.csproj",
];

/**
 * Tracked Go, Rust, Python, Maven and .NET manifests that sit under some project's
 * root — the fact the unregistered-Nx-plugin gap turns on
 * (`./commands/context.mjs`'s `pluginGap.manifests` is where a caller reads
 * it, and `./options.mjs`'s `pluginIsRegistered` is the other half of that
 * gap). A workspace running under Nx draws no edge for any of these languages
 * unless this plugin is registered in `nx.json` — Nx parses only TypeScript
 * and JavaScript imports natively (`../../../AGENTS.md`, "for the other
 * three both go quiet") — so a tracked manifest with no registered plugin is
 * exactly the silent hole that invariant refuses. This function only names
 * the manifests; it does not decide whether the plugin is registered. The
 * pair the gap turns on is wired in twice today: `resolveCommandContext`
 * reads both into its `pluginGap`, which every descriptive command refuses
 * on, while `check` renders the same fact as a `coverageGaps`
 * degraded-coverage note rather than a refusal (`../cli.mjs`) — the checker's
 * own analysis covers what the graph does not, so a note is the right level
 * there.
 *
 * Root matching mirrors `projectOwning`'s longest-prefix attribution of a
 * source file: a project rooted at the workspace root (`root: ""` or `"."`)
 * matches every tracked file, and a project rooted elsewhere matches only its
 * own directory or a path beneath it — never a sibling that merely shares a
 * prefix (`apps/foo-bar/go.mod` does not match a project rooted at
 * `apps/foo`).
 *
 * @param {string[]} tracked Every tracked file, workspace-relative.
 * @param {{name: string, root: string}[]} projects
 * @returns {string[]} The matching manifest paths, in `tracked`'s order.
 */
export function polyglotManifests(tracked, projects) {
  const roots = projects.map((project) => project.root);
  return tracked.filter((file) => {
    const base = file.slice(file.lastIndexOf("/") + 1);
    // Literal-first: four of the five names answer by equality, and only
    // `*.csproj` reaches the glob — this filter runs once per tracked file
    // (`./analysis/manifest-util.mjs`'s `basenameMatches` owns why).
    if (!basenameMatches(base, POLYGLOT_MANIFEST_NAMES, posix.matchesGlob)) return false;
    return roots.some(
      (root) => root === "" || root === "." || file === root || file.startsWith(`${root}/`),
    );
  });
}
