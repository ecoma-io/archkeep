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
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { analyzeFile, languageOf } from "./analysis/analyze.mjs";
import { fileFailure, projectOwning } from "./analysis/source-util.mjs";

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
      `nx-polyglot-graph: \`${[file, ...args].join(" ")}\` failed in ${cwd}: ` +
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
 */
function nxCli() {
  const manifest = require.resolve("nx/package.json");
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
 * @param {{ run?: typeof runProcess }} [io] Injectable spawn.
 * @returns {object} `{ nodes, dependencies }`.
 */
export function readProjectGraph(workspaceRoot, { run = runProcess } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "nx-polyglot-graph-"));
  const file = join(dir, "graph.json");
  try {
    run(process.execPath, [nxCli(), "graph", `--file=${file}`], workspaceRoot);
    const { graph } = JSON.parse(readFileSync(file, "utf8"));
    if (!graph?.nodes) {
      throw new Error(
        `nx-polyglot-graph: \`nx graph\` produced no \`graph.nodes\` in ${file} — ` +
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
  const at = (name) =>
    projectRoot === "" || projectRoot === "." ? name : `${projectRoot}/${name}`;
  const config =
    readFile(at("module-federation.config.js")) || readFile(at("module-federation.config.ts"));
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
        `nx-polyglot-graph: '${path}' is outside the workspace at ${root} — ` +
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
