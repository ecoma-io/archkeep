/**
 * The Nx provider's static acquisition — the graph built from the tree's own
 * tracked `project.json` files, with no Nx process asked.
 *
 * This is the acquisition `../lsp/workspace-index.mjs` composes: a language
 * server is spawned by an editor, in a directory, with nothing else — no `nx`
 * binary to resolve, and a spawn per index build would put `nx graph` on
 * every file save. So beside
 * `./nx.mjs`'s `readProjectGraph` (which asks Nx itself and is what
 * `../../cli.mjs`'s `check` runs) this module builds the same `{nodes,
 * dependencies}`-shaped starting point — here just the nodes; the caller
 * folds the edges in, because edges need the import sites and the
 * file→project map only the caller's analysis produces (`buildDependencies`,
 * `./native/graph.mjs`).
 *
 * ## The blind spot this acquisition accepts, and says
 *
 * `project.json` is the only thing discovery reads, so a PACKAGE-BASED Nx
 * workspace — projects declared in `package.json`, no `project.json` anywhere
 * — yields zero nodes. `./nx.mjs`'s `readProjectGraph` asks Nx and does see
 * them. The caller turns zero nodes under an `nx.json` marker into a recorded
 * gap (`../lsp/workspace-index.mjs`'s `nxModelFailure`) that refuses
 * `analyzed` on every open document, rather than a clean verdict over a graph
 * that was never built — the loud direction, deliberately, because reading
 * package-based projects here would be the second project-model reader this
 * package must not grow (`../../../../AGENTS.md`).
 *
 * ## Failure policy: records for per-project defects, a throw for nothing
 *
 * A `project.json` that will not parse is skipped and reported, not thrown on —
 * one project being edited must not blank the graph for the other nineteen.
 * That is the same policy `./native/`'s `discover()` applies to its manifests
 * (records riding the returned object) and the OPPOSITE of `./nx.mjs`'s
 * `readProjectGraph` (which throws on anything, because a CLI that cannot
 * answer leaves nothing to index). The `workspaceLayout` read is caught into
 * `workspaceLayoutFailure` for the same reason — one malformed `nx.json` must
 * not blank the index — where `readProjectGraph` throws the identical refusal;
 * the two policies are the recorded difference between an acquisition that
 * still has a tree to index and one that does not.
 *
 * One refusal THROWS rather than skipping: a `package.json` beside a
 * `project.json` that exists but cannot be read or parsed (#846). Falling
 * through to the directory basename there would put the project in the graph
 * under a name no constraint row names — a silently wrong identity. Absent
 * (null) stays the legitimate basename fallback per Nx's own precedence.
 */

import { readWorkspaceLayout, requireCompleteWorkspaceLayout } from "../options.mjs";
import { parseNxJson } from "../nx-json.mjs";
import { nodeTypeOf, PROJECT_CONFIG_FILE } from "./native/discover.mjs";

/**
 * The directory part of a workspace-relative path; `""` at the tree root.
 *
 * @param {string} file
 * @returns {string}
 */
const directoryOf = (file) => {
  const slash = file.lastIndexOf("/");
  return slash === -1 ? "" : file.slice(0, slash);
};

/**
 * One `project.json` — or the `package.json` beside it — read the way Nx reads
 * it, which is NOT `JSON.parse`.
 *
 * The reader is `../nx-json.mjs`, shared with `../options.mjs` because
 * `nx.json` has to be read the same way for the same reason. The local name
 * stays because the stakes are specific to a project config: losing a
 * `project.json` here is the worst failure this acquisition can have. The
 * project leaves the graph; an import into it then resolves as external rather
 * than cross-project; the rule engine's npm branch returns before the tag
 * checks run; and the editor paints a real violation clean.
 *
 * @param {string} text
 * @returns {object} Whatever the JSON describes.
 * @throws {Error} when neither parser can read it.
 */
const parseProjectJson = parseNxJson;

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
      const pkgPath = root === "" ? "package.json" : `${root}/package.json`;
      let manifest;
      try {
        manifest = readFile(pkgPath);
      } catch (cause) {
        throw new Error(
          `package.json '${pkgPath}' beside project '${root || "."}' could not be read: ${cause?.message ?? cause}`,
          { cause },
        );
      }
      if (manifest === null) return undefined;
      try {
        // The same parser, because Nx reads this file with the same
        // `readJsonFile` — a `package.json` Nx can name a project from must
        // not become a project named after its directory here.
        return parseProjectJson(manifest).name;
      } catch (cause) {
        // An unreadable package.json that was READ must not fall through to
        // the directory basename (#846) — that is a project the graph knows
        // under one name and every constraint row names under another.
        throw new Error(
          `package.json '${pkgPath}' beside project '${root || "."}' could not be read: ${cause?.message ?? cause}`,
          { cause },
        );
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
 * @returns {{nodes: Record<string, object>, duplicateProjects: {name: string, roots: string[]}[]}}
 *   `duplicateProjects` names every name two or more projects resolved to and
 *   every root that claimed it (#375): a silent `nodes[name] = …` overwrite
 *   drops the shadowed project from the graph, its files match no root, and
 *   the editor publishes no diagnostics for real boundary crossings — the
 *   exact silent direction `../../../../AGENTS.md`'s invariant refuses. The
 *   first project still wins in `nodes` (the index stays usable); the caller
 *   publishes the collision through `indexGaps`.
 */
export function buildNodes(projects) {
  // Null-prototype for the same reason `./native/graph.mjs` and `./moon.mjs`
  // use them: every key here is a project NAME, and project names come from a
  // `project.json`'s own `name` field — attacker-supplied the moment a pull
  // request adds a project called `__proto__`. A plain `{}` answers
  // `nodes["__proto__"] = …` by repointing the object's OWN prototype rather
  // than adding an entry, so the project vanishes from `graph.nodes` while
  // `filesOf` still attributes it files — a real cross-project import into it
  // then read a poisoned Node as a graph node and flips/throws on every rule
  // that touches it. `Object.create(null)` has no inherited `__proto__`
  // accessor to collide with, so the name behaves like every other project
  // name: a real, own, enumerable entry.
  const nodes = Object.create(null);
  /** @type {Map<string, string>} name → root of the first project that claimed it. */
  const seenNames = new Map();
  /** @type {Map<string, string[]>} name → every root that resolved to it, for names claimed twice or more. */
  const duplicateMap = new Map();

  for (const { name, root, config } of projects) {
    if (seenNames.has(name)) {
      // Duplicate name detected — record it for loud reporting
      if (!duplicateMap.has(name)) {
        duplicateMap.set(name, [seenNames.get(name)]);
      }
      duplicateMap.get(name).push(root);
      // Skip adding the duplicate to nodes — first project wins
      continue;
    }
    seenNames.set(name, root);
    nodes[name] = {
      name,
      type: nodeTypeOf(name, config.projectType),
      data: { ...config, root, tags: config.tags ?? [] },
    };
  }

  // Convert the duplicate map to the expected output format
  const duplicateProjects = [];
  for (const [name, roots] of duplicateMap.entries()) {
    duplicateProjects.push({ name, roots });
  }

  return { nodes, duplicateProjects };
}

/**
 * The static Nx-shaped acquisition, composed: discovery, node building, and
 * `nx.json`'s `workspaceLayout` merged onto the result — the merge
 * `./nx.mjs`'s `readProjectGraph` also performs, for the same reason (see that
 * function's doc: `nx graph --file=` emits no such key, and a non-default
 * `appsDir`/`libsDir` must not silently become the default layout). Here a
 * read/validation failure is caught into `workspaceLayoutFailure` rather than
 * thrown — see this module's failure-policy note.
 *
 * @param {{root: string, files: string[], readFile: (path: string) => string|null,
 *   readLayout?: typeof readWorkspaceLayout}} args
 * @returns {{nodes: Record<string, object>, skippedProjects: {file: string, reason: string}[],
 *   duplicateProjects: {name: string, roots: string[]}[], workspaceLayout: object|undefined,
 *   workspaceLayoutFailure: string|null}}
 *   `workspaceLayout` is `undefined` when `nx.json` declares nothing, so the
 *   caller can keep the key absent — the graph shape `evaluate()` reads is
 *   "declared or absent", never defaulted.
 */
export function readStaticProjectGraph({
  root,
  files,
  readFile,
  readLayout = readWorkspaceLayout,
}) {
  const { projects, skipped } = discoverProjects({ files, readFile });
  const { nodes, duplicateProjects } = buildNodes(projects);

  let workspaceLayout;
  let workspaceLayoutFailure = null;
  try {
    const declared = requireCompleteWorkspaceLayout(readLayout(root));
    if (declared !== null) workspaceLayout = declared;
  } catch (cause) {
    workspaceLayoutFailure = cause?.message ?? String(cause);
  }

  return {
    nodes,
    skippedProjects: skipped,
    duplicateProjects,
    workspaceLayout,
    workspaceLayoutFailure,
  };
}
