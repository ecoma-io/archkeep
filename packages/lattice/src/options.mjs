/**
 * The plugin's options: what a workspace may tell this tool about itself.
 *
 * Two filenames, and nothing else. Both are Nx CONVENTIONS rather than fixed
 * contracts — a workspace is free to name them otherwise, and when it does,
 * every answer this tool gives about that workspace is silently wrong: a
 * `tsconfig.base.json` under another name means no path alias resolves, and a
 * boundary config under another name means the enforcer cannot find the law and
 * says so at best, reads a stale one at worst. That is the difference between
 * this pair and the manifests next door: `go.mod`, `Cargo.toml`,
 * `pyproject.toml`, `nx.json` and `project.json` are named by their own
 * toolchains and cannot be renamed by a workspace decision, so they stay
 * hardcoded at their single use site: a literal belongs inline only where it is
 * intrinsic to a fixed external contract and appears in exactly one place.
 *
 * ## Where the options come from, and why there is no config file for them
 *
 * `nx.json → plugins` already carries a per-plugin `options` object, and Nx
 * threads it into every hook (`CreateDependencies<T> = (options, context) =>`).
 * A workspace that registers this plugin has already written the entry; adding
 * two keys to it costs nothing and adds no file. Inventing an
 * `lattice.config.mjs` instead would add a file when the workspace
 * already carries the same options in `nx.json` — and it would need its own
 * filename option to find itself, which is the joke that gives the game away.
 *
 * ```json
 * "plugins": [
 *   {
 *     "plugin": "@ecoma-io/lattice/nx",
 *     "options": { "boundaryConfig": "module-boundaries.config.mjs", "tsConfig": "tsconfig.base.json" }
 *   }
 * ]
 * ```
 *
 * ## What is deliberately NOT an option: the language list
 *
 * The obvious next key is `languages: ["go", "rust"]`, and it must not exist.
 * Switching a language off there is indistinguishable, in every report this
 * tool prints, from that language having no violations — which is the exact
 * silence the whole project exists to end (`AGENTS.md`: an empty result is a
 * claim, not a shrug). A workspace with no Go pays nothing for Go support
 * already: each resolver keys off the manifests that exist, so it finds none
 * and does nothing. There is no cost to buy off, and the option would only sell
 * a way to turn enforcement off where nobody would see it happen.
 *
 * ## Why an unknown key throws
 *
 * `./config.mjs` takes the same posture with `depConstraints`, for the same
 * reason. A `tsconfigBase` typed for `tsConfig` that quietly fell back to the
 * default would produce a full green run against a rule nobody wrote. The
 * failure has to arrive at the first `nx` invocation, naming the key.
 */
import { readFileSync } from "node:fs";

import { parseNxJson } from "./nx-json.mjs";

/**
 * The Nx conventions, so a workspace that follows them writes no options at
 * all. Frozen: a caller that mutated this would move the default for every
 * later reader in the process.
 */
export const DEFAULT_OPTIONS = Object.freeze({
  /** The workspace's module-boundary law — the table ESLint reads too. */
  boundaryConfig: "module-boundaries.config.mjs",
  /** Where the workspace's shared `compilerOptions` and `paths` live. */
  tsConfig: "tsconfig.base.json",
});

/** The file Nx reads to learn a workspace exists — and where the options live. */
export const NX_CONFIG_FILE = "nx.json";

/**
 * Merges a raw options object over the defaults, refusing anything it does not
 * recognise.
 *
 * Pure, and takes the object rather than a path, for the reason every gate in
 * this repository takes its facts as arguments: a function that reads a file
 * AND decides something has to be split before it can be tested, and the split
 * is the improvement. `readPluginOptions` below is the only half that touches
 * a filesystem.
 *
 * @param {object|undefined|null} rawOptions Whatever `nx.json` carried, or
 *   whatever Nx handed the hook. Absent is legal and means "all defaults".
 * @returns {{boundaryConfig: string, tsConfig: string}}
 * @throws {Error} on an unknown key, a non-object, or a value that is not a
 *   non-empty string. An empty string would build `<root>/` and read a
 *   directory as a config, which fails somewhere far from the typo.
 */
export function resolveOptions(rawOptions) {
  if (rawOptions === undefined || rawOptions === null) return { ...DEFAULT_OPTIONS };
  if (typeof rawOptions !== "object" || Array.isArray(rawOptions)) {
    throw new Error(
      `lattice: plugin options must be an object, got ${Array.isArray(rawOptions) ? "an array" : typeof rawOptions}`,
    );
  }

  const known = Object.keys(DEFAULT_OPTIONS);
  const resolved = { ...DEFAULT_OPTIONS };
  for (const [key, value] of Object.entries(rawOptions)) {
    if (!known.includes(key)) {
      throw new Error(
        `lattice: unknown plugin option '${key}' — expected one of ${known.join(", ")}. ` +
          `Refused rather than ignored: an option that falls back to its default in silence is a ` +
          `green run against a rule nobody wrote.`,
      );
    }
    if (typeof value !== "string" || value === "") {
      throw new Error(
        `lattice: plugin option '${key}' must be a non-empty string, got ` +
          `${value === "" ? "an empty string" : typeof value}`,
      );
    }
    resolved[key] = value;
  }
  return resolved;
}

/**
 * This plugin's own entry in an `nx.json` `plugins` array, in either form Nx
 * accepts: a bare string, or `{plugin, options}`.
 *
 * Matched on the specifier's TAIL rather than by equality, because the same
 * plugin is named three legitimate ways — `@ecoma-io/lattice/nx` once it
 * resolves from the registry, `./packages/lattice/nx.mjs` inside this
 * repository, and a path with or without the `.mjs` in a workspace that
 * vendored it. Requiring one spelling would make the options invisible in the
 * other two, and invisible options mean the defaults — silently.
 *
 * The bare package specifier (`@ecoma-io/lattice`, with no `/nx`) does NOT
 * match: that resolves to the engine entry, which exports neither `name` nor
 * `createDependencies`, so Nx would not have loaded a plugin at all — an entry
 * this function accepted there would claim options for a plugin Nx never ran.
 *
 * @param {unknown} entry One element of `nx.json`'s `plugins`.
 * @returns {boolean}
 */
function namesThisPlugin(entry) {
  const specifier =
    typeof entry === "string" ? entry : /** @type {{ plugin?: unknown }} */ (entry)?.plugin;
  if (typeof specifier !== "string") return false;
  const withoutExt = specifier.replace(/\.mjs$/u, "");
  return withoutExt === "lattice/nx" || withoutExt.endsWith("/lattice/nx");
}

/**
 * `nx.json`'s parsed contents, or `null` when the workspace has none.
 *
 * The one place this file spawns a read and a parse, so `readPluginOptions`
 * and `readWorkspaceLayout` below — two independent readers of the same file
 * — cannot disagree about whether it is readable: both go through here, and
 * both therefore throw the identical `cannot read <path>` message on the same
 * malformed input rather than each carrying its own copy that could drift.
 *
 * @param {string} workspaceRoot
 * @param {(path: string) => string|null} readFile
 * @returns {object|null}
 * @throws {Error} when the file exists but `parseNxJson` cannot read it.
 */
function readNxJsonOrNull(workspaceRoot, readFile) {
  const path = `${String(workspaceRoot).replace(/\/$/u, "")}/${NX_CONFIG_FILE}`;
  const text = readFile(path);
  if (text === null) return null;
  try {
    return parseNxJson(text);
  } catch (cause) {
    throw new Error(`lattice: cannot read ${path}: ${cause?.message ?? cause}`, {
      cause,
    });
  }
}

/**
 * The resolved options a workspace root declares.
 *
 * The read is injectable, which is what keeps the one filesystem-touching
 * function here testable without a tree on disk: `readFile` takes an absolute
 * path and answers `null` for a file that is not there, so a test states an
 * `nx.json` as a string and every branch below is exercised over it. The
 * default reader is the only code in this module that reaches outside the
 * process.
 *
 * A workspace with no `nx.json`, no `plugins` array, or no entry for this
 * plugin gets the defaults. That is not the silent fallback the unknown-key
 * check refuses: the CLI and the language server are both usable in a tree that
 * never registered the plugin at all, and defaulting there is the Nx convention
 * being what it is. A `plugins` entry that IS present and carries a bad option
 * still throws.
 *
 * @param {string} workspaceRoot Absolute path of the tree being judged — never
 *   derived from this file's own location, for the reason `./config.mjs` gives.
 * @param {{readFile?: (path: string) => string|null}} [io] Injectable read, so
 *   `resolveOptions`'s callers can be driven over a tree that is not on disk.
 * @returns {{boundaryConfig: string, tsConfig: string}}
 * @throws {Error} when `nx.json` is unparseable, or its options are malformed.
 *   Loud on purpose, and the same posture as everywhere else here: a tool that
 *   could not read its own configuration must not answer as though it had.
 */
export function readPluginOptions(workspaceRoot, { readFile = readFileOrNull } = {}) {
  const nxJson = readNxJsonOrNull(workspaceRoot, readFile);
  if (nxJson === null) return { ...DEFAULT_OPTIONS };

  const plugins = Array.isArray(nxJson?.plugins) ? nxJson.plugins : [];
  const entry = plugins.find(namesThisPlugin);
  if (entry === undefined) return { ...DEFAULT_OPTIONS };
  return resolveOptions(typeof entry === "string" ? undefined : entry.options);
}

/**
 * The two keys `nx.json`'s `workspaceLayout` may carry — the same pair
 * `./providers/native/model.mjs`'s `WORKSPACE_LAYOUT_KEYS` validates for
 * `lattice.json`'s identically-named field, kept as two separate constants
 * because the two files sit on opposite sides of the layer boundary
 * `packages/lattice/CLAUDE.md` draws (`src/options.mjs` owns what a workspace
 * may tell this tool about ITSELF via Nx's own config; `src/providers/native/`
 * owns the `lattice.json` dialect) — a shared constant would import one layer
 * into the other for two frozen strings.
 */
const WORKSPACE_LAYOUT_KEYS = Object.freeze(["appsDir", "libsDir"]);

/**
 * `nx.json`'s `workspaceLayout`, exactly as declared — never merged with a
 * default and never required to be complete. A caller downstream has to be
 * able to tell "declared nothing" from "declared the default", which is why
 * this returns `null` for the former and the declared object verbatim
 * (partial or not) for the latter, rather than folding either case into
 * `./rules/specifiers.mjs`'s `DEFAULT_WORKSPACE_LAYOUT`. Whether a PARTIAL
 * declaration is usable is a different, narrower question — this reader only
 * answers "is what's here well-formed" — and `requireCompleteWorkspaceLayout`
 * below answers the narrower one for the two callers that need it.
 *
 * @param {string} workspaceRoot
 * @param {{readFile?: (path: string) => string|null}} [io]
 * @returns {{appsDir?: string, libsDir?: string}|null} `null` when the
 *   workspace has no `nx.json`, or its `nx.json` declares no `workspaceLayout`
 *   key.
 * @throws {Error} when `workspaceLayout` is present but is not a plain
 *   object, names a key other than `appsDir`/`libsDir`, or gives either key a
 *   non-string or empty-string value. Reading any of those as "no layout
 *   declared" would silence `noRelativeOrAbsoluteImportsAcrossLibraries` on
 *   exactly the workspace whose configuration is broken — the same reasoning
 *   `./providers/native/model.mjs`'s `workspaceLayoutViolations` already
 *   applies to `lattice.json`'s identically-shaped field.
 */
export function readWorkspaceLayout(workspaceRoot, { readFile = readFileOrNull } = {}) {
  const nxJson = readNxJsonOrNull(workspaceRoot, readFile);
  if (nxJson === null) return null;
  const declared = /** @type {{workspaceLayout?: unknown}} */ (nxJson)?.workspaceLayout;
  if (declared === undefined) return null;
  if (typeof declared !== "object" || declared === null || Array.isArray(declared)) {
    throw new Error(
      `lattice: nx.json's workspaceLayout must be an object, got ` +
        `${Array.isArray(declared) ? "an array" : typeof declared}`,
    );
  }
  for (const key of Object.keys(declared)) {
    if (!WORKSPACE_LAYOUT_KEYS.includes(key)) {
      throw new Error(
        `lattice: nx.json's workspaceLayout.${key} is not a workspaceLayout field — expected ` +
          `one of ${WORKSPACE_LAYOUT_KEYS.join(", ")}`,
      );
    }
    const value = /** @type {Record<string, unknown>} */ (declared)[key];
    if (typeof value !== "string" || value === "") {
      throw new Error(
        `lattice: nx.json's workspaceLayout.${key} must be a non-empty string, got ` +
          `${value === "" ? "an empty string" : typeof value}`,
      );
    }
  }
  return /** @type {{appsDir?: string, libsDir?: string}} */ (declared);
}

/**
 * Narrows a `readWorkspaceLayout` result to "usable by the rule engine":
 * either nothing declared (`null`, unchanged) or BOTH `appsDir` and `libsDir`
 * present. `./rules/specifiers.mjs`'s `isAbsoluteImportIntoAnotherProject`
 * reads both keys off one object with no per-key fallback — a workspace
 * declaring only `libsDir` would silently evaluate `appsDir` as `undefined`
 * and never match a real `apps/` import, the exact silent degradation
 * `AGENTS.md`'s invariant rules out.
 *
 * This is also the parity point between the two providers:
 * `./providers/native/model.mjs`'s `workspaceLayoutViolations` already
 * refuses an incomplete `workspaceLayout` for `lattice.json` — it never
 * merges a partial declaration onto a default, it rejects the whole file — so
 * `./providers/nx.mjs` and `./lsp/workspace-index.mjs` both call this
 * function rather than each deciding independently, and the same declared
 * object is accepted or refused identically by both.
 *
 * @param {{appsDir?: string, libsDir?: string}|null} declared
 * @returns {{appsDir: string, libsDir: string}|null}
 * @throws {Error} when `declared` is non-null but missing `appsDir` or
 *   `libsDir`.
 */
export function requireCompleteWorkspaceLayout(declared) {
  if (declared === null) return null;
  const missing = WORKSPACE_LAYOUT_KEYS.filter((key) => !(key in declared));
  if (missing.length === 0) {
    return /** @type {{appsDir: string, libsDir: string}} */ (declared);
  }
  throw new Error(
    `lattice: nx.json's workspaceLayout declares ${Object.keys(declared).join(", ") || "nothing"} ` +
      `but is missing ${missing.join(", ")} — declare both appsDir and libsDir, or neither.`,
  );
}

/**
 * Whether `workspaceRoot`'s `nx.json` registers THIS plugin — the other half
 * of the unregistered-plugin gap `./workspace.mjs`'s `polyglotManifests`
 * names the manifests for. A workspace can carry a tracked `go.mod` and never
 * have told Nx to look, and that tree's `nx affected` under-selects with no
 * warning at all — measured, the same silence `AGENTS.md`'s empty-result
 * invariant refuses. This function only answers the yes/no; it is exported
 * and tested on its own, and it is not currently consulted by `check`'s
 * refusal logic — a later caller wires the two facts together.
 *
 * Shares `readPluginOptions`'s reader convention deliberately: `readFile`
 * takes an absolute path and answers `null` for a file that is not there, the
 * same default as that function, so a caller that already has one reader for
 * this workspace's `nx.json` uses it for both calls.
 *
 * @param {string} workspaceRoot Absolute path of the tree being judged.
 * @param {{readFile?: (path: string) => string|null}} [io]
 * @returns {boolean} `false` for no `nx.json`, no `plugins` array, or no
 *   entry naming this plugin — the same three no-registration states
 *   `readPluginOptions` treats as "use the defaults". `true` for either form
 *   `namesThisPlugin` accepts: a bare string, or `{plugin, options}`.
 * @throws {Error} when `nx.json` exists but cannot be parsed — the same
 *   posture as `readPluginOptions`: a tool that could not read its own
 *   configuration must not answer as though it had.
 */
export function pluginIsRegistered(workspaceRoot, { readFile = readFileOrNull } = {}) {
  const nxJson = readNxJsonOrNull(workspaceRoot, readFile);
  if (nxJson === null) return false;

  const plugins = Array.isArray(nxJson?.plugins) ? nxJson.plugins : [];
  return plugins.some(namesThisPlugin);
}

/** A file's contents, or `null` when it does not exist or cannot be read. */
function readFileOrNull(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
