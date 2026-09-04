/**
 * The Moon project-model provider: `.moon/` or `.config/moon/` directory, no Nx installed.
 *
 * A Moonrepo workspace is identified by a `.moon/` directory at its root.
 * Moonrepo v2.0+ also supports `.config/moon/` as an alternative config
 * directory; which one a given root carries is answered by `moonMarkerAt`
 * below — the one dispatcher every consumer shares, and the place a root
 * carrying both is refused. The winner is recorded in the `CommandContext`'s
 * `marker` field (`../commands/context.mjs`).
 *
 * This provider reads the project graph via `moon project-graph --json`,
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

import { existsSync } from "node:fs";
import { delimiter, join, posix } from "node:path";

import { environmentForTree, runProcess } from "../process.mjs";
import { buildDependencies } from "./native/graph.mjs";

/**
 * The directory that marks a Moonrepo workspace root.
 *
 * Moonrepo v1 uses `.moon/`; Moonrepo v2.0+ also supports `.config/moon/`
 * as an alternative config directory. Both are valid markers; which one a
 * workspace uses is Moon's own convention, not this tool's to decide.
 */
export const MOON_DIR = ".moon";

/**
 * The alternative config directory Moonrepo v2.0+ supports.
 *
 * A workspace may carry either `.moon/` or `.config/moon/`. Moon treats them
 * as mutually exclusive roots, and so does this tool: a root carrying BOTH is
 * refused outright by `moonMarkerAt` below, naming both directories, rather
 * than silently judged against one of them. This constant lets that check —
 * and the marker walk (`../commands/context.mjs`'s `WORKSPACE_MARKERS`) —
 * recognize either spelling, the same way they already check for `nx.json`
 * and `archkeep.json`.
 */
export const MOON_ALT_DIR = ".config/moon";

/**
 * The file that makes a Moon directory a workspace-root marker for the walk
 * (`../workspace.mjs`'s `findWorkspaceRoot`): `workspace.yml`, the one file
 * moonrepo's own documentation marks "required" of a workspace. The directory
 * alone is NOT a marker — `~/.moon` exists on every machine moonrepo has ever
 * run on, as moonrepo's user-level state (its documentation puts the shared
 * cache at `~/.moon/cache/shared`), and a walk that treated directory
 * presence as enough selected the user's home directory as a "Moon
 * workspace" (#339). These constants name the FILE so the walk's marker list
 * (`../commands/context.mjs`'s `WORKSPACE_MARKERS`) holds the shaped marker.
 *
 * The provider gate (`moonMarkerAt` below) keeps reading directory presence,
 * deliberately: given a root the walk already chose, a `.moon` directory
 * beside an `nx.json` is two project models at one root whether or not the
 * `.moon` is shaped — a decision nobody made — and refusing that stays loud.
 */
export const MOON_WORKSPACE_MARKER = posix.join(MOON_DIR, "workspace.yml");

/**
 * The v2 spelling of {@link MOON_WORKSPACE_MARKER}, under
 * {@link MOON_ALT_DIR} — same shape, same reason.
 */
export const MOON_ALT_WORKSPACE_MARKER = posix.join(MOON_ALT_DIR, "workspace.yml");

/**
 * Which Moon directory marks `root` as a Moonrepo workspace — `.moon/`,
 * `.config/moon/`, or neither.
 *
 * The one answer to that question, shared by every entry point that must
 * answer it identically: `../commands/context.mjs`'s provider choice reads it
 * for the CLI, and `../lsp/workspace-index.mjs`'s dispatch reads it for the
 * language server — so the editor and `check` cannot disagree about which
 * marker resolves a Moon tree (#223's two-faces defect).
 *
 * A root carrying both directories is REFUSED rather than silently resolved:
 * Moon treats them as mutually exclusive roots, and picking one for the
 * consumer would judge their workspace against a config nobody chose. It is
 * the same posture the `.moon`+`nx.json`, `.moon`+`archkeep.json` and
 * `nx.json`+`archkeep.json` refusals take one level out
 * (`../commands/context.mjs`), applied inside the pair itself.
 *
 * @param {string} root Absolute workspace root.
 * @param {{exists?: (path: string) => boolean}} [io] Injectable existence test
 *   (absolute paths), so a test drives this without a filesystem. The default
 *   is plain filesystem existence, matching how every other marker is read.
 * @returns {string} `MOON_DIR` or `MOON_ALT_DIR` — whichever the root carries;
 *   `.config/moon/` alone wins nothing over `.moon/` alone, each simply names
 *   itself when it is the only one present.
 * @throws {Error} when both directories are present.
 */
export function moonMarkerAt(root, { exists = existsSync } = {}) {
  const hasPrimary = exists(join(root, MOON_DIR));
  const hasAlt = exists(join(root, MOON_ALT_DIR));
  if (hasPrimary && hasAlt) {
    throw new Error(
      `archkeep: ${root} declares both ${MOON_DIR} and ${MOON_ALT_DIR} — Moonrepo treats them as ` +
        `mutually exclusive config roots, and this tool refuses to pick between them rather than ` +
        `judge the workspace against a config nobody chose. Remove whichever one is not the ` +
        `workspace's real source of truth.`,
    );
  }
  return hasAlt ? MOON_ALT_DIR : hasPrimary ? MOON_DIR : null;
}

/**
 * The key `env` spells PATH under, decided by the PLATFORM rather than by
 * which spellings the object happens to carry.
 *
 * The two platforms disagree about what `Path` and `PATH` even ARE, and
 * nothing about the keys present can settle it:
 *
 * - **Windows** — variable names are case-INSENSITIVE. `Path`, `PATH` and
 *   `path` are three spellings of ONE variable, and `Path` is the spelling
 *   the system itself writes. `process.env` mirrors that case-insensitivity,
 *   but the copy `../process.mjs`'s `environmentForTree` hands back is a plain
 *   spread, and a plain object is not: reading `clean.PATH` there answers
 *   `undefined` on a machine whose PATH is perfectly present, and writing
 *   `PATH` back onto it would leave the child holding two spellings of one
 *   variable with only the synthesized one populated — the system PATH
 *   dropped, silently. So on Windows the key is found case-insensitively and
 *   written back under the spelling it was read from, and `resolveMoonEnv`
 *   collapses the remaining case-variants.
 * - **POSIX** — variable names are case-SENSITIVE. `Path` and `PATH` are two
 *   ordinary, unrelated variables; both may exist, and the loader resolves the
 *   child's binary from `PATH` alone. So `PATH` is the only key this function
 *   may answer with there, and the only one `resolveMoonEnv` may write or
 *   remove.
 *
 * Guessing the key from `Object.keys` order instead is what made this
 * function delete a real POSIX PATH: measured, env `{Path: "/opt/foo", PATH:
 * "/usr/bin:/bin"}` reached the child as `{Path:
 * "<root>/node_modules/.bin:/opt/foo"}` and nothing else — `PATH` gone, `moon`
 * therefore ENOENT, and `isMoonBinaryMissing` below telling a consumer with
 * Moon installed to install Moon. Loudly, confidently wrong.
 *
 * On Windows a populated spelling wins over an empty one; with no spelling
 * present at all the answer is `"PATH"` on both platforms, the name the
 * variable is then created under.
 *
 * @param {Record<string, string|undefined>} env
 * @param {boolean} windows Whether the platform this env is built for treats
 *   variable names case-insensitively.
 * @returns {string}
 */
function pathVariableKey(env, windows) {
  if (!windows) return "PATH";
  const spellings = Object.keys(env).filter((key) => key.toUpperCase() === "PATH");
  return spellings.find((key) => env[key]) ?? spellings[0] ?? "PATH";
}

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
 * **No entry of the PATH this builds is ever empty.** POSIX resolves an empty
 * entry — a leading, trailing, or doubled delimiter — as the CURRENT
 * DIRECTORY, and the current directory of the spawn this env is built for is
 * the untrusted workspace being judged: a `moon` file committed into that tree
 * would be executed in place of the real CLI. Joining the bin dir to an absent
 * PATH produced exactly that trailing empty entry, and the Windows spelling
 * `pathVariableKey` exists for is what made "absent" reachable on an ordinary
 * machine. Empty entries inherited from the caller are dropped for the same
 * reason: this env is built for one spawn into one untrusted tree, and no
 * entry of it may mean "here".
 *
 * **Exactly one variable is touched, and which one is the platform's answer.**
 * `pathVariableKey` above owns that decision; what follows from it here is the
 * removal, which happens on Windows ONLY. There, the leftover case-variants
 * are the same variable under other spellings and handing the child two views
 * of it — one populated, one not — is ambiguous. On POSIX they are unrelated
 * variables that merely look alike, so nothing is removed: deleting a POSIX
 * `Path` because `PATH` was written is destroying a variable this tool was
 * never asked about, and deleting the `PATH` a child is resolved through is
 * how `moon` became ENOENT on a machine that had it.
 *
 * This function cannot fail. It reports where Moon will be looked for, not
 * whether it is there — that is answered by the spawn itself, in
 * `readProjectGraph`, which is the only place that can tell.
 *
 * @param {string} workspaceRoot
 * @param {{ env?: Record<string, string|undefined>, platform?: string }} [io]
 *   The environment to build from, and the platform whose variable-name case
 *   rules apply. `platform` is injectable for one reason: the two branches
 *   below are opposite behaviours and a machine can only run one of them, so a
 *   Windows-only rule tested nowhere is a rule that ships unproven. It governs
 *   the case rule alone — the separator stays `node:path`'s `delimiter`,
 *   because the child really does run on this host.
 * @returns {{ moon: string, env: Record<string, string|undefined> }}
 *   The Moon binary name and an env with the adjusted PATH.
 */
function resolveMoonEnv(workspaceRoot, { env = process.env, platform = process.platform } = {}) {
  const windows = platform === "win32";
  // Strip ambient git redirects first — the same protection every other
  // provider gets — then add the workspace's node_modules/.bin to PATH.
  const clean = environmentForTree(env);
  const binDir = join(workspaceRoot, "node_modules", ".bin");
  const key = pathVariableKey(clean, windows);
  const entries = String(clean[key] ?? "")
    .split(delimiter)
    .filter((entry) => entry !== "");
  // Segment equality, never substring containment: a directory named
  // `<root>/node_modules/.bin-old` CONTAINS the bin dir as a substring, and a
  // containment test reads that as "already on PATH" and never prepends the
  // real one — leaving `moon` to resolve to whatever else on the machine
  // answers to the name.
  if (!entries.includes(binDir)) entries.unshift(binDir);
  /** @type {Record<string, string|undefined>} */
  const next = { ...clean, [key]: entries.join(delimiter) };
  if (windows) {
    // One variable, one spelling, on the platform where they are one variable.
    for (const spelling of Object.keys(next)) {
      if (spelling !== key && spelling.toUpperCase() === "PATH") delete next[spelling];
    }
  }
  return { moon: "moon", env: next };
}

/**
 * Moon dependency scope (plus, where known, its `source`) → Archkeep edge type.
 *
 * **Moon's `"implicit"` is the INVERSE of Archkeep's, and this is the one place
 * that has to know it.** The two vocabularies use the same word for opposite
 * facts:
 *
 * - **Archkeep** (from Nx's `implicitDependencies`, and `archkeep.json`'s own
 *   row of that name): `type: "implicit"` means *a human declared this edge
 *   and there is no import behind it*. That is precisely why
 *   `../rules/edge-constraints.mjs`'s `declaredEdgeViolationsForCheck`
 *   exists — such an edge never becomes an `importSites` record, so
 *   `evaluate()` structurally cannot reach it and `check` judges it as an edge
 *   instead. `../commands/drift.mjs` and `../commands/discover.mjs` exclude
 *   the same set for the mirror reason: a declaration is not evidence of code.
 * - **Moon**: `source` is `"explicit"` when a human wrote the dependency in
 *   `moon.yml`'s `dependsOn`, and `"implicit"` when **Moon derived it from
 *   source files** — a `package.json` entry under
 *   `javascript.syncProjectWorkspaceDependencies`, say. Moon's own shipped
 *   schema says so in as many words (`.moon/cache/schemas/project.json`,
 *   `DependencySource`, moon 2.4.6): *"The source where the dependency comes
 *   from. Either explicitly defined in configuration, or implicitly derived
 *   from source files."*
 *
 * So Moon's `"explicit"` carries Archkeep's `"implicit"` fact, and Moon's
 * `"implicit"` is a code-backed edge that gets a `scope`-derived type. Mapping
 * the two words onto each other by their spelling — which is what this
 * function did — made `declaredEdgeViolationsForCheck` judge exactly the set it
 * was written NOT to judge: every manifest-derived edge judged as though it had
 * no import site, and every hand-declared edge, the only kind that really has
 * none, skipped. A workspace with a forbidden dependency written into a
 * `moon.yml` and no import to hide behind reported `no declared-edge
 * violations` and exited 0 (#262).
 *
 * `source` is only available on a project node's own `dependencies[]` array
 * (`transformMoonGraph`'s second edge-building loop) — `raw.graph.edges`'
 * `[source, target, scope]` tuples carry no such field, so that loop's call
 * always passes `source: undefined`, which cannot equal `"explicit"` and so
 * always falls through to `scope`. The node loop is the only place a
 * dependency can be typed `"implicit"` at all, which is what makes the
 * "implicit wins per pair" rule in `transformMoonGraph`'s `add` correct: the
 * loop that can see `source` overrules the loop that cannot.
 *
 * Once `source` is not `"explicit"` (or is unknown), Moon's `scope` decides —
 * and every scope it can decide maps to `"static"`, never to `"dynamic"`
 * (#280). A scope is a fact about a MANIFEST ROW — when the dependency is
 * needed, runtime or build time — while `"dynamic"` upstream is a fact about
 * SOURCE TEXT (`import()` written at an import site,
 * `../../rules/topology.mjs`'s `noImportsOfLazyLoadedLibraries`). Feeding the
 * first to rules that read the second manufactured lazy-loading nobody wrote:
 * every dev-only dependency looked lazy-loaded, and that rule fired at the
 * declaring project's own test file. The previous `"dynamic"` mapping existed
 * only to serve that rule, which is exactly why a scope cannot feed it.
 * Nothing is lost by refusing: genuine lazy loading still arrives through
 * ANALYSIS — `mergeImportEdges` below folds real `import()` sites into this
 * graph keyed `[source, target, type]`, so a real dynamic import adds its own
 * `dynamic` edge regardless of the declared scope:
 * - `"production"` — a runtime dependency. Maps to `"static"`.
 * - `"development"` — a build-time-only dependency. Maps to `"static"`
 *   (#280).
 * - `"build"` — a build-system dependency (not a source-level import). Maps
 *   to `"static"` as a conservative default; Archkeep judges source imports,
 *   not build graphs.
 * - `"peer"` — a peer dependency. Maps to `"static"`.
 * - `"root"` — the root workspace depends on a project. These are not
 *   project-to-project edges Archkeep judges, so they are omitted — checked
 *   before `source`, because a root-to-project edge is not a boundary either
 *   way.
 *
 * @param {string} scope
 * @param {string} [source] Moon's own `"explicit"`/`"implicit"` marker for
 *   this specific dependency, when the caller has one.
 * @returns {string|undefined} Archkeep edge type, or `undefined` to skip.
 */
function edgeTypeFromScope(scope, source) {
  if (scope === "root") {
    // Root-to-project edges are not project-to-project boundaries, declared
    // or not.
    return undefined;
  }
  // Moon "explicit" — written by hand in `moon.yml` — IS Archkeep "implicit".
  if (source === "explicit") return "implicit";
  switch (scope) {
    // A manifest scope says WHEN a dependency is needed, never HOW its imports
    // are written — "dynamic" is a source-text fact only analysis can attest,
    // which `mergeImportEdges` below keeps flowing — so every scope lands on
    // "static" (#280).
    case "production":
    case "development":
    case "build":
    case "peer":
      return "static";
    default:
      // Unknown scopes become "static" — conservative, and never silent.
      return "static";
  }
}

/**
 * Maps a Moon `layer` value to a Archkeep `node.type`.
 *
 * Moon's `layer` is one of: `automation`, `application`, `tool`, `library`,
 * `scaffolding`, `configuration`, `unknown` (or null). Archkeep's `type` is
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
 * Derives the set of Archkeep tags from a Moon project node's metadata.
 *
 * Moon provides three sources of tag-like information:
 * - `config.tags[]` — explicit tags declared in `moon.yml`. These become
 *   Archkeep tags verbatim.
 * - `layer` — the project's layer classification. Becomes a derived tag
 *   `layer:<value>` (e.g. `layer:application`), matching Archkeep's tag
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
  // Derived tags from layer/stack — colon-prefixed to match Archkeep
  // convention for constraint tables.
  if (projectNode.layer) tags.add(`layer:${projectNode.layer}`);
  if (projectNode.stack) tags.add(`stack:${projectNode.stack}`);
  return [...tags].sort();
}

/**
 * A Moon project `source`'s canonical workspace-relative root, or the reason
 * it cannot have one.
 *
 * `node.source` is the only spelling of a project's location this provider
 * gets, and every consumer downstream answers by comparing it against
 * workspace-relative tracked paths — `../analysis/source-util.mjs`'s
 * `projectOwning` matches `path.startsWith(`${root}/`)`, byte for byte. The
 * other two providers already hold that discipline: `../workspace.mjs`
 * normalises Nx's `"."` to `""` at ingestion, and
 * `./native/model.mjs`'s `declaredProjectViolations` refuses `\`,
 * leading/trailing slashes and `.`/`..` segments at config load. This
 * function is the Moon provider's copy of it, applied where Moon's output is
 * ingested:
 *
 * - **normalised** — spellings that provably name the same directory a
 *   canonical one would: `""` and `"."` (the root project, which Moon has
 *   spelled both ways) become `""`; a leading `./` and any trailing `/` are
 *   dropped, so `"./apps/web/"` reads as `"apps/web"`.
 * - **refused** — everything else, returned as a named problem rather than
 *   rewritten or kept: a backslash (paths are matched posix-style regardless
 *   of platform), a leading `/` (absolute — a directory outside the
 *   workspace), a `.`/`..` segment, an empty `//` segment, or a non-string.
 *   A root that matches no tracked path's spelling makes its project own
 *   nothing, silently — `projectOwning` cannot report a miss it structurally
 *   cannot see (#367) — so the spelling is refused loudly instead.
 *
 * @param {unknown} source A project node's `source` from
 *   `moon project-graph --json`.
 * @returns {{root: string, problem: null}|{root: null, problem: string}}
 */
function canonicalMoonRoot(source) {
  if (typeof source !== "string") {
    return {
      root: null,
      problem: `must be a string, got ${typeof source} (${JSON.stringify(source) ?? String(source)})`,
    };
  }
  let spelling = source;
  while (spelling.startsWith("./")) spelling = spelling.slice(2);
  while (spelling.endsWith("/")) spelling = spelling.slice(0, -1);
  if (spelling === "" || spelling === ".") return { root: "", problem: null };
  if (spelling.includes("\\")) {
    return {
      root: null,
      problem:
        `'${source}' must use forward slashes — this tool matches paths posix-style ` +
        "regardless of the platform the tree is checked out on",
    };
  }
  if (spelling.startsWith("/")) {
    return {
      root: null,
      problem: `'${source}' must be workspace-relative — a leading slash names a directory outside the workspace`,
    };
  }
  for (const segment of spelling.split("/")) {
    if (segment === "." || segment === "..") {
      return {
        root: null,
        problem: `'${source}' must be a canonical path — no '.' or '..' segment`,
      };
    }
    if (segment === "") {
      return {
        root: null,
        problem: `'${source}' must be a canonical path — no empty '//' segment`,
      };
    }
  }
  return { root: spelling, problem: null };
}

/**
 * Infers `workspaceLayout` from the source paths of Moon's projects.
 *
 * Moon does not declare `appsDir`/`libsDir` — there is no `nx.json`-style
 * `workspaceLayout` key. This function examines each project's canonical
 * root (`canonicalMoonRoot`'s answer, not Moon's raw spelling) and checks for
 * a common directory prefix shared by all projects of the same `layer`:
 * - `application`-layer projects whose roots all share a prefix → `appsDir`
 * - `library`-layer projects whose roots all share a prefix → `libsDir`
 *
 * A project at the workspace ROOT contributes to neither: its canonical root
 * is `""` (whatever spelling Moon used for it), which names no directory the
 * workspace keeps apps or libs in — see the guard in the loop below for what
 * inferring one from it would do.
 *
 * A prefix is "shared" when every project of that layer starts with the same
 * top-level directory. If no consistent prefix exists, that key is omitted
 * from the result. If either prefix is found but the other is not, `null` is
 * returned — a partial layout like `{appsDir: "apps"}` would pass through
 * `graph.workspaceLayout ?? DEFAULT_WORKSPACE_LAYOUT` unchanged (the object
 * is truthy, so `??` does not fire) and `isAbsoluteImportIntoAnotherProject`
 * would evaluate `${workspaceLayout.libsDir}/` as `"undefined/"`, silently
 * disabling the absolute-import rule for the missing axis. Returning `null`
 * forces the `??` fallback, which applies the complete default
 * `{libsDir: "libs", appsDir: "apps"}`. If neither prefix is found, `null`
 * is returned for the same reason.
 *
 * @param {object[]} projectNodes Project nodes from Moon's `data` map values.
 * @param {Map<string, string>} rootById Each accepted project's canonical
 *   root, the map `transformMoonGraph` builds — the same spelling the built
 *   node carries in `data.root`, so the layout this infers and the graph it
 *   ships cannot disagree about where a project lives.
 * @returns {{appsDir: string, libsDir: string}|null}
 */
function inferWorkspaceLayout(projectNodes, rootById) {
  const appDirs = new Set();
  const libDirs = new Set();
  for (const node of projectNodes) {
    const root = rootById.get(node.id);
    // `undefined` is a node the transform did not accept; `""` is the
    // workspace root itself. Either way it names no directory BELOW the
    // workspace root, and inferring `appsDir: "."` from one would make
    // `../rules/specifiers.mjs`'s `isAbsoluteImportIntoAnotherProject` test
    // `imp.startsWith("./")`: EVERY ordinary relative import in the workspace
    // reported as an absolute import into another project, from one
    // root-level `moon.yml`. Every other spelling has been refused by
    // `canonicalMoonRoot` before it reaches here, so no `.`/`..`/empty top
    // segment can land in a prefix — one test on the canonical root covers
    // the whole vocabulary. Excluding a root project can only leave a prefix
    // set empty, which returns the incomplete layout `null` below and falls
    // back to the complete default: the loud direction.
    if (root === undefined || root === "") continue;
    const topDir = root.split("/")[0];
    if (node.layer === "application") appDirs.add(topDir);
    else if (node.layer === "library") libDirs.add(topDir);
  }
  const appsDir = appDirs.size === 1 ? [...appDirs][0] : undefined;
  const libsDir = libDirs.size === 1 ? [...libDirs][0] : undefined;
  // Both keys must be present, or neither. A partial layout would silently
  // disable the absolute-import rule for the missing axis — see the header
  // comment for the mechanism.
  if (appsDir === undefined || libsDir === undefined) return null;
  return { appsDir, libsDir };
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
 * Archkeep's graph uses name-keyed records:
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
 * **Two disciplines meet here, and both must refuse rather than drop.**
 *
 * **Anomalous output is refused loudly, never skipped** (#365) — the same
 * posture `./native/discover.mjs` holds for the native provider's graph:
 * collect every anomaly, throw once naming each. A `data` entry that is not a
 * project node (no `id`, or no `source` at all), one project `id` claimed by
 * two entries, and an edge or declared dependency naming a project the graph
 * does not contain, would each drop a project or an edge from the graph
 * silently — a graph judged over less than the tree, byte-for-byte identical
 * to one that never had them. Two facts pin the boundaries of "anomalous":
 *
 * - Every `Project` Moon serializes carries a non-optional `id` and `source`
 *   (moon's `crates/project` source, read at @moonrepo/cli 2.5.3), and its
 *   graph is keyed by `id` — so an entry missing either field, or a duplicate
 *   `id`, did not come from a well-formed `moon project-graph`.
 * - A root-level project's `source` is spelled `"."` on some Moon versions
 *   and `""` on others (moon's own `is_root_level_source`, in `crates/common`,
 *   accepts both — `"."` is the spelling 2.5.3 emits — and
 *   `inferWorkspaceLayout`'s header owns the pair). The empty spelling is a
 *   project root, not a missing one, and is accepted here — a falsy-source
 *   skip would vanish the root project from the graph on the versions that
 *   spell it that way.
 *
 * One anomaly class is reachable from ordinary configuration rather than
 * malformed output, measured on @moonrepo/cli 2.5.3: a `moon.yml`
 * `dependsOn:` naming a project that does not exist exits 0, keeps the record
 * in the owning node's own `dependencies[]`, and drops it from
 * `graph.edges`. Before #365 this provider dropped it too (`!nodes[target]`),
 * vanishing a hand-declared edge — the #262 defect shape, reached through a
 * typo'd id.
 *
 * On top of that, each node's `data.root` is the `source`'s CANONICAL
 * spelling (`canonicalMoonRoot`, #367), never Moon's raw one — and a `source`
 * with no canonical spelling (a backslash, a leading `/`, a `.`/`..`/empty
 * `//` segment, a non-string) refuses the transform before any graph is
 * built, because a root that matches no tracked path's spelling makes its
 * project own nothing silently. Unlike an anomaly, which is collected and
 * thrown with the rest at the end, this refusal is its own throw naming every
 * offending project and spelling — a distinct failure class.
 *
 * @param {object} raw The parsed JSON from `moon project-graph --json`.
 * @returns {{nodes: Record<string, object>, dependencies: Record<string, object[]>, workspaceLayout?: object}}
 * @throws {Error} naming every anomaly at once when the payload carries any,
 *   and separately when any project's `source` cannot be read as a
 *   workspace-relative root, naming every offending project and spelling.
 */
export function transformMoonGraph(raw) {
  if (!raw?.data) {
    throw new Error(
      "archkeep: `moon project-graph` produced no `data` map — " +
        "nothing can be judged against a graph with no projects in it",
    );
  }

  /** @type {Record<string, object>} */
  const nodes = Object.create(null);
  /** @type {Record<string, {source: string, target: string, type: string}[]>} */
  const dependencies = Object.create(null);
  // Keyed on the (source, target) PAIR alone, never on `type`: the same
  // dependency is represented twice in Moon's own output — once in
  // `raw.graph.edges` (typed only from `scope`, since that tuple carries no
  // `source` field) and once in the owning node's own `dependencies[]`
  // (which does carry `source`, and so is the only place a dependency can be
  // typed `"implicit"` at all). Keying on `[source, target, type]` — the
  // previous shape — let both survive as two distinct edges for one real
  // dependency: an `implicit` edge from the second loop, plus a phantom
  // `static`/`dynamic` duplicate from the first, and only the second loop's
  // exclusion callers (`../commands/drift.mjs`, `../commands/discover.mjs`)
  // ever look at `type`, so the phantom slipped past every `edge.type ===
  // "implicit"` check as a fake code-derived edge. One pair now always
  // resolves to exactly one entry, and `"implicit"` — the hand-declared fact,
  // which only the node loop can see (`edgeTypeFromScope`'s header) — always
  // wins over a scope-derived type for that same pair, in whichever order the
  // two loops below discover it.
  /** @type {Map<string, {source: string, target: string, type: string}>} */
  const edgesByPair = new Map();
  // Both edge loops validate their endpoints BEFORE calling: membership in
  // `nodes` is checked where a refusal can name the dropped edge, not in
  // here where it could only drop it namelessly — the exact silent `return`
  // this function used to carry, and the shape #365 exists to remove.
  const add = (source, target, type) => {
    if (source === target) {
      anomalies.push(`self-edge [${source}, ${target}] is not a dependency between projects`);
      return;
    }
    const key = JSON.stringify([source, target]);
    const existing = edgesByPair.get(key);
    if (existing) {
      if (type === "implicit" && existing.type !== "implicit") existing.type = "implicit";
      return;
    }
    const entry = { source, target, type };
    edgesByPair.set(key, entry);
    (dependencies[source] ??= []).push(entry);
  };

  // Every anomaly this provider refuses to judge over, collected across all
  // three loops and thrown as ONE error — `./native/discover.mjs`'s
  // collect-and-throw posture, so a payload carrying several defects names
  // them all in a single refusal instead of failing one-per-run.
  /** @type {string[]} */
  const anomalies = [];

  // Build nodes from Moon's data map. Each entry is indexed by integer key
  // but identified by its `id` string — which becomes the Archkeep node key.
  // An entry that is not a project node, or a second entry claiming an `id`
  // already keyed, is an anomaly: skipping the first or letting the second
  // overwrite it would judge the graph over one project fewer — the silent
  // direction. See this function's header for the moon-source facts that
  // bound "anomalous" (including why `source: ""` is not).
  /** @type {Map<string, {key: string, source: string}>} */
  const firstClaimOf = new Map();
  const projectNodes = Object.values(raw.data);
  /**
   * Each accepted project's canonical workspace-relative root — the one
   * spelling the built node, `inferWorkspaceLayout` and every consumer after
   * them judge by (`canonicalMoonRoot`'s answer, never Moon's raw spelling).
   *
   * @type {Map<string, string>}
   */
  const rootById = new Map();
  /** @type {string[]} */
  const rootProblems = [];
  for (const [key, node] of Object.entries(raw.data)) {
    if (typeof node?.id !== "string" || node.id === "") {
      anomalies.push(`data entry ${key} carries no id — it names no project`);
      continue;
    }
    if (node?.source == null) {
      anomalies.push(`data entry ${key} ('${node.id}') carries no source path`);
      continue;
    }
    const first = firstClaimOf.get(node.id);
    if (first) {
      anomalies.push(
        `data entries ${first.key} and ${key} both declare project '${node.id}' ` +
          `(sources '${first.source}' and '${node.source}') — the second would overwrite the first`,
      );
      continue;
    }
    firstClaimOf.set(node.id, { key, source: node.source });
    // #367 — the source is now a confirmed string: canonicalise it to the
    // workspace-relative root, and refuse (as a rootProblem) any spelling
    // that has no canonical form rather than let the project own nothing.
    const canonical = canonicalMoonRoot(node.source);
    if (canonical.problem !== null) {
      rootProblems.push(`  ${node.id}: ${canonical.problem}`);
      continue;
    }
    rootById.set(node.id, canonical.root);
    const tags = deriveTags(node);
    // Nx's `implicitDependencies` is the hand-declared list — so it is Moon's
    // `"explicit"` dependencies that belong here, not its `"implicit"` ones.
    // Same inversion as `edgeTypeFromScope` above, same reason.
    const implicitDeps = Array.isArray(node.dependencies)
      ? node.dependencies.filter((d) => d.source === "explicit").map((d) => d.id)
      : [];
    const taskTargets = Array.isArray(node.taskTargets) ? node.taskTargets : [];
    nodes[node.id] = {
      name: node.id,
      type: nodeTypeFromLayer(node.layer),
      data: {
        root: canonical.root,
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

  // A source with no canonical spelling refuses the whole transform, naming
  // every project and every spelling: a root that matches no tracked path's
  // spelling makes its project own nothing, silently (#367) — the forbidden
  // direction. Downstream, this throw is the CLI's exit 3 and the language
  // server's named index gap, never an empty-looking graph.
  if (rootProblems.length > 0) {
    throw new Error(
      "archkeep: `moon project-graph --json` emitted project sources this tool " +
        "cannot read as workspace-relative roots:\n" +
        rootProblems.join("\n") +
        "\nA project whose root matches no tracked path owns nothing, with nothing " +
        "naming why — refusing instead.",
    );
  }

  // Build dependencies from Moon's graph edges. The scope check runs FIRST:
  // a "root"-scoped edge judges nothing (see `edgeTypeFromScope`), so what it
  // names at either end is Moon's own bookkeeping and can never be a boundary
  // this provider dropped.
  if (Array.isArray(raw.graph?.edges)) {
    for (const [srcIdx, tgtIdx, scope] of raw.graph.edges) {
      const type = edgeTypeFromScope(scope);
      if (type === undefined) continue; // e.g. "root" scope
      const srcNode = raw.data[String(srcIdx)];
      const tgtNode = raw.data[String(tgtIdx)];
      if (srcNode === undefined || tgtNode === undefined) {
        anomalies.push(
          `graph edge [${srcIdx}, ${tgtIdx}, ${scope}] names a data entry the payload does not carry`,
        );
        continue;
      }
      // An endpoint whose entry was already refused by the node loop's checks
      // has been named there; dropping this edge is a consequence of that
      // anomaly, not a second one — and the function throws before any of it
      // reaches a verdict.
      if (typeof srcNode?.id !== "string" || srcNode.id === "") continue;
      if (typeof tgtNode?.id !== "string" || tgtNode.id === "") continue;
      add(srcNode.id, tgtNode.id, type);
    }
  }

  // Also add dependencies from each project node's own `dependencies` array,
  // which carries `scope` and `source` metadata. This covers implicit
  // dependencies that the graph edges may not explicitly represent as edges.
  // `dep.source` is this loop's own reason to exist over the one above: it is
  // the only place this function's `source` argument is ever real.
  for (const node of projectNodes) {
    // An entry already refused by the node loop was named there.
    if (typeof node?.id !== "string" || node.id === "" || !Array.isArray(node.dependencies))
      continue;
    for (const dep of node.dependencies) {
      if (!dep?.id) {
        anomalies.push(`project '${node.id}' has a dependency record with no id`);
        continue;
      }
      const type = edgeTypeFromScope(dep.scope, dep.source);
      if (type === undefined) continue;
      if (!nodes[dep.id]) {
        anomalies.push(
          `project '${node.id}' declares a dependency on '${dep.id}', which the graph does not contain`,
        );
        continue;
      }
      add(node.id, dep.id, type);
    }
  }

  if (anomalies.length > 0) {
    throw new Error(
      "archkeep: `moon project-graph` produced anomalous output this provider refuses to judge " +
        "over — every line below would otherwise drop a project or an edge from the graph " +
        "silently, and a graph judged over less than the tree is the forbidden direction:\n  " +
        anomalies.join("\n  "),
    );
  }

  const workspaceLayout = inferWorkspaceLayout(projectNodes, rootById);
  return workspaceLayout === null
    ? { nodes, dependencies }
    : { nodes, dependencies, workspaceLayout };
}

/**
 * Folds the package's own import analysis into a Moon graph, in place.
 *
 * `moon project-graph --json` knows a project depends on another only when
 * `moon.yml` says `dependsOn` — Moon has no hook this package can register
 * the way `./nx.mjs`'s `createDependencies` registers into Nx's own graph
 * computation. A Go, Rust or Python import crossing a project boundary with
 * no such entry is therefore invisible to the graph alone, while the
 * reachability rules read exactly these lists (`noCircularDependencies`, the
 * upstream half of `notDependOnLibsWithTags`) — an edge missing here hides a
 * cycle or a transitive finding from every verdict built on the graph, which
 * is the silent direction. The dedupe key is `[source, target, type]`: an
 * import that agrees with a declared edge adds nothing; one that disagrees in
 * kind (a dynamic import of a statically declared dependency) survives as its
 * own record, because `noImportsOfLazyLoadedLibraries` turns on that kind.
 *
 * ONE implementation serves both faces that compose a Moon graph — the CLI's
 * preamble (`../commands/context.mjs`) and the language server's index
 * (`../lsp/workspace-index.mjs`) — so the editor and `check` cannot disagree
 * about which edges exist (#223).
 *
 * @param {{nodes: object, dependencies: Record<string, object[]>}} graph The
 *   graph `transformMoonGraph` (or an equivalent) returned; mutated in place.
 * @param {{importSites: object[], projectOf: (file: string) => string|undefined}} analysis
 *   Import records in the analysis contract's shape, and the file→project map
 *   to attribute them with.
 * @returns {{nodes: object, dependencies: Record<string, object[]>}} The same graph.
 */
export function mergeImportEdges(graph, { importSites, projectOf }) {
  const importEdges = buildDependencies({ importSites, nodes: graph.nodes, projectOf });
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
  return graph;
}

/**
 * The name or path this provider will spawn as the Moon CLI.
 *
 * Unlike `./nx.mjs`'s `nxCli()`, this resolves nothing and verifies nothing.
 * `moon` is not a peer dependency of this package, so there is no
 * `node_modules/moon` to `require.resolve`, and the binary may legitimately
 * sit either in the workspace's own `node_modules/.bin` (the usual case, which
 * `resolveMoonEnv` puts on PATH) or anywhere else on the consumer's PATH. The
 * default therefore returns the bare name `"moon"` and lets the spawn be the
 * existence check — the only test that covers both places without this file
 * reimplementing `which`, and one that cannot refuse a globally installed Moon
 * the way a `node_modules/.bin` stat would.
 *
 * It used to document a "Moon cannot be found" error it had no way to throw:
 * the default resolver is a constant. The error a consumer actually meets is
 * built in `readProjectGraph` below, from the spawn's own `ENOENT` — the only
 * place the fact is available to name.
 *
 * `resolveMoon` stays injectable so a test can point the spawn at a known
 * binary path without a system-wide Moon installation.
 *
 * @param {string} workspaceRoot
 * @param {{ resolveMoon?: (workspaceRoot: string) => string }} [io]
 * @returns {string} Path or name of the Moon CLI binary.
 */
function resolveMoonCli(workspaceRoot, { resolveMoon = () => "moon" } = {}) {
  return resolveMoon(workspaceRoot);
}

/**
 * Is this spawn failure "the binary is not there", as opposed to "it ran and
 * failed"?
 *
 * Those are different facts and only the first has an install action behind
 * it. Telling a consumer whose Moon ran and exited 2 to install Moon sends
 * them to fix something that is not broken — the same mistake `./nx.mjs`'s
 * `nxCli` guards against from the other direction, where only a
 * `MODULE_NOT_FOUND` earns the "not installed" story.
 *
 * `../process.mjs`'s `runProcess` wraps the child's failure and carries the
 * original on `cause`, so the code is read from there; the direct `code` is
 * read too, for a `run` seam that surfaces a spawn error unwrapped.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isMoonBinaryMissing(error) {
  const thrown = /** @type {{code?: unknown, cause?: {code?: unknown}}|null|undefined} */ (error);
  return thrown?.code === "ENOENT" || thrown?.cause?.code === "ENOENT";
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
 * @param {{ run?: typeof runProcess, resolveMoon?: (workspaceRoot: string) => string, env?: Record<string, string|undefined>, platform?: string }} [io]
 *   Injectable spawn, injectable Moon resolution, injectable env, and the
 *   platform whose environment-variable case rules `resolveMoonEnv` applies —
 *   see its own header for why that one is a seam.
 * @returns {object} `{ nodes, dependencies }`, plus `workspaceLayout` when
 *   the project paths imply one.
 * @throws {Error} naming the install action when the Moon binary is in neither
 *   place it is looked for. Every other spawn failure, and a JSON parse
 *   failure, propagates untouched — already named by `../process.mjs`'s
 *   `runProcess`. Anomalous graph shape — duplicate project ids, entries that
 *   are not project nodes, dependencies naming projects the graph does not
 *   contain — is refused by `transformMoonGraph`, naming every instance in
 *   one error. No path here answers with an empty graph.
 */
export function readProjectGraph(
  workspaceRoot,
  { run = runProcess, resolveMoon, env, platform } = {},
) {
  const moonEnv = resolveMoonEnv(workspaceRoot, {
    env: env ?? process.env,
    platform: platform ?? process.platform,
  });
  const moon = resolveMoonCli(workspaceRoot, { resolveMoon });
  let output;
  try {
    output = run(moon, ["project-graph", "--json"], workspaceRoot, moonEnv.env);
  } catch (cause) {
    // Everything except an absent binary propagates untouched: `runProcess`
    // already names the command, the working directory and the child's own
    // stderr, and rewriting a real Moon error here would bury it. The absent
    // binary is re-thrown because it is the failure a consumer meets FIRST and
    // its raw text — `spawnSync moon ENOENT` — names no action they can take.
    if (!isMoonBinaryMissing(cause)) throw cause;
    throw new Error(
      `archkeep: the Moon CLI (\`${moon}\`) could not be run in ${workspaceRoot} — the Moon ` +
        "provider reads the project graph with `moon project-graph --json`, looking for the " +
        `binary in ${join(workspaceRoot, "node_modules", ".bin")} and then on PATH, and neither ` +
        "answered. Install Moon in this workspace (`pnpm add -D @moonrepo/cli`), or put `moon` " +
        "on PATH.",
      { cause },
    );
  }
  const raw = JSON.parse(output);
  return transformMoonGraph(raw);
}

/**
 * The `ProjectModelProvider`-family object `../../cli.mjs` selects when a
 * workspace root carries a `.moon/` or `.config/moon/` directory rather than
 * `nx.json` or `archkeep.json`.
 */
export const moonProvider = {
  name: "moon",
  marker: MOON_DIR,
  readProjectGraph,
};
