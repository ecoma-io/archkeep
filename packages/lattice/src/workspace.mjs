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
 * **Projects and tags come from Nx, never from a walk of our own.** The graph
 * is the workspace's own answer to "what is a project and what is it tagged" —
 * derived from `project.json`, `nx.json` plugins (this one included) and
 * whatever inference Nx applies. A second reader of `project.json` files would
 * be a second answer, and the two would disagree exactly where a plugin
 * contributes an edge. Nx is spawned rather than imported for the same reason
 * the project imports no workspace code: `nx` is not on this project's import
 * list (project `CLAUDE.md`), and its own `nx graph --file=` is a stable
 * documented surface where its internal module layout is not.
 *
 * **Files come from git.** `nx graph --file=` emits no file map, and the
 * alternative — walking the tree — would need its own ignore rules that drift
 * from `.gitignore` the first time a build directory is added. `git ls-files`
 * is the same tracked-file set every resolver in this project already reasons
 * about ("Resolvers read tracked files only", project `CLAUDE.md`).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";

import { analyzeFile, languageOf } from "./analysis/analyze.mjs";
import { fileFailure, projectOwning } from "./analysis/source-util.mjs";
import { parseNxJson } from "./nx-json.mjs";

const require = createRequire(import.meta.url);

/**
 * The environment variables that point git at a repository OTHER than the one
 * containing the directory it runs in. Each overrides `cwd`, so a spawn that
 * inherits them reads a different tree than the caller asked for.
 *
 * A git hook is the case that matters, and it is where this tool runs: git
 * exports `GIT_DIR` (and often `GIT_INDEX_FILE`) to every hook, so a `check`
 * or a language server started from `pre-commit`/`pre-push` would list the
 * ambient repository's files while resolving them against the root it was
 * given. Every read then fails against a path that belongs to another tree —
 * a verdict about the wrong workspace, or none at all.
 *
 * Which tree is judged is `root`'s decision alone. `GIT_CEILING_DIRECTORIES`
 * is in the list for the same reason from the other direction: it can stop
 * discovery before reaching the root the caller named.
 */
const AMBIENT_GIT_REDIRECTS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
];

/**
 * `env` with every ambient git redirect removed, for a spawn that must read
 * the tree it is pointed at. Nx gets it too — it shells out to git itself, and
 * a graph built from another repository's files is the same defect one layer
 * further away.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {Record<string, string|undefined>}
 */
export function environmentForTree(env = process.env) {
  const clean = { ...env };
  for (const name of AMBIENT_GIT_REDIRECTS) delete clean[name];
  return clean;
}

/**
 * Runs a program and returns its stdout, throwing an `Error` that names the
 * program when it fails. The single seam every spawn in this module goes
 * through, so a test drives the whole scan without a git repository or an Nx
 * installation.
 *
 * @param {string} file Executable path.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
export function runProcess(file, args, cwd) {
  try {
    return execFileSync(file, args, {
      cwd,
      env: environmentForTree(),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (cause) {
    throw new Error(
      `lattice: \`${[file, ...args].join(" ")}\` failed in ${cwd}: ` +
        `${cause?.stderr || cause?.message || cause}`,
      { cause },
    );
  }
}

/**
 * The workspace root at or above `from`, identified by its `nx.json`.
 *
 * Nx's own root-finding rule, reproduced because the CLI has to agree with the
 * `nx` it spawns about which tree is being judged. It is deliberately NOT
 * derived from this file's own location: installed from a registry, this file
 * sits inside the consumer's `node_modules` and the tree it judges is above
 * that, so walking up from `import.meta.url` would find the wrong root — or,
 * with a hoisted install, the right one by luck (same reason
 * `loadBoundaryConfig` takes a root — see `config.mjs`).
 *
 * @param {string} from Absolute directory to start at.
 * @returns {string|null} Absolute path, or `null` when no ancestor has one.
 */
export function findWorkspaceRoot(from) {
  let current = resolve(from);
  for (;;) {
    if (existsSync(join(current, "nx.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Absolute path to Nx's own CLI entry — the JS file its `nx` bin points at.
 *
 * Spawned under this Node binary rather than through `pnpm nx`, which takes the
 * package manager's platform-specific bin shim out of the picture instead of
 * wrapping it, and leaves no shell for a `TMPDIR` carrying metacharacters to
 * reach. It resolves by Node's own rules from this file's location, and that is
 * correct rather than incidental: `nx` is a **peer** dependency, so what those
 * rules find is the copy the consumer installed — the same version answering
 * `pnpm nx` in their tree — and never a second one bundled in here. A tool that
 * shipped its own Nx could report a graph the workspace's own CLI disagrees with.
 *
 * `nx` is declared `peerDependenciesMeta.nx.optional`, so this resolution is
 * allowed to fail — but `check()` calls `readProjectGraph` unconditionally
 * (`cli.mjs`), so a workspace that never installed `nx` gets no working
 * `lattice check` at all: every run exits 3 with the diagnostic below. The
 * "Installing it" section of `README.md` states the same thing for a reader
 * outside this file. What this function must not do on failure is let
 * Node's own
 * `MODULE_NOT_FOUND` reach the caller: that error names a package specifier,
 * not a workspace-facing action, and `cli.mjs` prints `error.message` verbatim
 * on the exit-3 path — a raw resolver stack there would read as a bug in this
 * tool rather than the true cause, an absent peer.
 *
 * `resolveNx` is injectable for the same reason `run` is: this repository has
 * `nx` installed, so nothing here can drive the real "not installed" path
 * without faking the resolver — `workspace.integration.test.mjs` does exactly
 * that, over a `resolveNx` that throws the way `require.resolve` does when
 * nothing on disk answers `nx/package.json`. It takes no argument because it
 * only ever resolves that one specifier — accepting one and forwarding it to
 * `require`'s own resolver would hand that call a variable rather than a
 * literal, which is exactly the load `src/conformance/boundary.test.mjs`
 * cannot see through and reports as opaque rather than trusting.
 *
 * @param {{ resolveNx?: () => string }} [io]
 * @throws {Error} named `lattice: nx is not installed`, when `resolveNx`
 *   cannot find it.
 */
function nxCli({ resolveNx = () => require.resolve("nx/package.json") } = {}) {
  let manifest;
  try {
    manifest = resolveNx();
  } catch (cause) {
    throw new Error(
      "lattice: nx is not installed — `nx` is an optional peer dependency, needed only for " +
        "`lattice check`'s project-graph discovery (`nx graph`). Install it in this workspace, " +
        "or run a command that does not need the graph.",
      { cause },
    );
  }
  const { bin } = JSON.parse(readFileSync(manifest, "utf8"));
  return join(dirname(manifest), typeof bin === "string" ? bin : bin.nx);
}

/**
 * The Nx project graph for `workspaceRoot`, in the shape `evaluate()` consumes.
 *
 * `nx graph --file=<json>` emits `{ graph: { nodes, dependencies } }` and no
 * `externalNodes`; the rule engine synthesises those from the analysis records
 * instead, which is what makes `bannedExternalImports` reachable for crates and
 * Go modules at all (`rules/index.mjs` → `externalNodeFor`).
 *
 * @param {string} workspaceRoot
 * @param {{ run?: typeof runProcess, resolveNx?: () => string }} [io]
 *   Injectable spawn, and injectable Nx resolution (see `nxCli`).
 * @returns {object} `{ nodes, dependencies }`.
 */
export function readProjectGraph(workspaceRoot, { run = runProcess, resolveNx } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lattice-"));
  const file = join(dir, "graph.json");
  try {
    run(process.execPath, [nxCli({ resolveNx }), "graph", `--file=${file}`], workspaceRoot);
    const { graph } = JSON.parse(readFileSync(file, "utf8"));
    if (!graph?.nodes) {
      throw new Error(
        `lattice: \`nx graph\` produced no \`graph.nodes\` in ${file} — ` +
          `nothing can be judged against a graph with no projects in it`,
      );
    }
    return graph;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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
    root: node.data.root,
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
      try {
        return readFileSync(join(root, path), "utf8");
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
 * @param {string[]} files Workspace-relative tracked files.
 * @param {string[]} paths As typed on the command line.
 * @param {{ root: string, cwd: string }} location
 * @returns {string[]} A subset of `files`.
 * @throws {Error} when a path lies outside the workspace — silently selecting
 *   nothing would report a clean tree for a run that inspected none of it.
 */
export function selectFiles(files, paths, { root, cwd }) {
  if (paths.length === 0) return files;
  const prefixes = paths.map((path) => {
    const absolute = isAbsolute(path) ? path : resolve(cwd, path);
    const rel = relative(root, absolute);
    if (rel === "") return "";
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(
        `lattice: '${path}' is outside the workspace at ${root} — ` +
          `there is nothing there this tool could check`,
      );
    }
    return rel;
  });
  return files.filter((file) =>
    prefixes.some((prefix) => prefix === "" || file === prefix || file.startsWith(`${prefix}/`)),
  );
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
 * @param {object} workspace The `Workspace` from `createWorkspace`.
 * @param {string[]} files Workspace-relative paths to consider.
 * @param {{ analyze?: typeof analyzeFile }} [io] Injectable analyzer.
 * @returns {{ imports: object[], failures: object[], analyzed: number }}
 */
export function analyzeWorkspace(workspace, files, { analyze = analyzeFile } = {}) {
  const imports = [];
  const failures = [];
  let analyzed = 0;
  for (const sourceFile of files) {
    if (languageOf(sourceFile) === null) continue;
    const text = workspace.readFile(sourceFile);
    if (text === null) {
      failures.push(fileFailure(sourceFile, "could not be read"));
      continue;
    }
    analyzed += 1;
    const result = analyze({ sourceFile, text, workspace });
    imports.push(...result.imports);
    failures.push(...result.failures);
  }
  return { imports, failures, analyzed };
}
