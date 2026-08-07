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
 * `nx-polyglot-graph.config.mjs` instead would add a file when the workspace
 * already carries the same options in `nx.json` — and it would need its own
 * filename option to find itself, which is the joke that gives the game away.
 *
 * ```json
 * "plugins": [
 *   {
 *     "plugin": "@ecoma-io/nx-polyglot-graph",
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
      `nx-polyglot-graph: plugin options must be an object, got ${Array.isArray(rawOptions) ? "an array" : typeof rawOptions}`,
    );
  }

  const known = Object.keys(DEFAULT_OPTIONS);
  const resolved = { ...DEFAULT_OPTIONS };
  for (const [key, value] of Object.entries(rawOptions)) {
    if (!known.includes(key)) {
      throw new Error(
        `nx-polyglot-graph: unknown plugin option '${key}' — expected one of ${known.join(", ")}. ` +
          `Refused rather than ignored: an option that falls back to its default in silence is a ` +
          `green run against a rule nobody wrote.`,
      );
    }
    if (typeof value !== "string" || value === "") {
      throw new Error(
        `nx-polyglot-graph: plugin option '${key}' must be a non-empty string, got ` +
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
 * plugin is named three legitimate ways — `@ecoma-io/nx-polyglot-graph` once it
 * resolves from the registry, `./packages/nx-polyglot-graph/index.mjs` inside
 * this repository, and a path with or without the `index.mjs` in a workspace
 * that vendored it. Requiring one spelling would make the options invisible in
 * the other two, and invisible options mean the defaults — silently.
 *
 * @param {unknown} entry One element of `nx.json`'s `plugins`.
 * @returns {boolean}
 */
function namesThisPlugin(entry) {
  const specifier = typeof entry === "string" ? entry : entry?.plugin;
  if (typeof specifier !== "string") return false;
  const withoutEntryFile = specifier.replace(/\/index\.mjs$/u, "");
  return (
    withoutEntryFile === "nx-polyglot-graph" || withoutEntryFile.endsWith("/nx-polyglot-graph")
  );
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
  const path = `${String(workspaceRoot).replace(/\/$/u, "")}/${NX_CONFIG_FILE}`;
  const text = readFile(path);
  if (text === null) return { ...DEFAULT_OPTIONS };

  let nxJson;
  try {
    nxJson = parseNxJson(text);
  } catch (cause) {
    throw new Error(`nx-polyglot-graph: cannot read ${path}: ${cause?.message ?? cause}`, {
      cause,
    });
  }

  const plugins = Array.isArray(nxJson?.plugins) ? nxJson.plugins : [];
  const entry = plugins.find(namesThisPlugin);
  if (entry === undefined) return { ...DEFAULT_OPTIONS };
  return resolveOptions(typeof entry === "string" ? undefined : entry.options);
}

/** A file's contents, or `null` when it does not exist or cannot be read. */
function readFileOrNull(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
