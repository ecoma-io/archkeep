/**
 * Finding the language server this extension drives.
 *
 * The server is **not bundled into the extension**, and that is the single most
 * consequential decision in this package. A bundled copy would be pinned to
 * whatever version was published to the marketplace, while the workspace's CI
 * runs the version in its own lockfile — so the editor and the pipeline could
 * disagree about the same import, each reporting confidently. An extension that
 * says "clean" about a file CI is about to fail on is a worse artifact than no
 * extension.
 *
 * So the server is resolved out of the workspace being edited, and when it is
 * not there this module returns a sentence rather than a fallback. There is
 * deliberately no "install it for you" path and no vendored default: the state
 * where nothing is checking has to be reachable, because it is the only state
 * this project cannot afford to look clean.
 */

import { dirname, isAbsolute, join, resolve } from "node:path";

/** The package that ships the server. */
export const SERVER_PACKAGE = "@ecoma-io/lattice";

/**
 * The server entry point inside that package.
 *
 * It is reached by path rather than by specifier because the package's `exports`
 * map publishes `.` and `./package.json` and nothing else — `lsp.mjs` is a `bin`
 * and a file, not a subpath export. Resolving `./package.json` and joining is
 * therefore the supported way to find it, and it survives pnpm's symlinked
 * store, hoisting, and a nested `node_modules` that a literal path guess does
 * not.
 */
export const SERVER_ENTRY = "lsp.mjs";

/**
 * @typedef {object} ServerLocation
 * @property {string | null} path absolute path to the server entry, or null
 * @property {"setting" | "workspace" | null} source how it was found
 * @property {string[]} searched every candidate tried, in order
 * @property {string} [reason] a sentence naming what is missing, when path is null
 */

/**
 * Locate the server for one workspace root.
 *
 * @param {object} input
 * @param {string} input.nxRoot absolute path of the workspace root
 * @param {string} [input.configuredPath] the `lattice.server.path` setting
 * @param {(path: string) => boolean} input.exists filesystem predicate
 * @param {(fromDirectory: string) => string | null} input.resolvePackageJson
 *   resolves `<SERVER_PACKAGE>/package.json` as Node would from a directory,
 *   or returns null when the package is not installed there
 * @returns {ServerLocation}
 */
export function locateServer({ nxRoot, configuredPath = "", exists, resolvePackageJson }) {
  const searched = [];

  if (configuredPath.trim() !== "") {
    const configured = isAbsolute(configuredPath)
      ? configuredPath
      : resolve(nxRoot, configuredPath);
    searched.push(configured);

    if (exists(configured)) {
      return { path: configured, source: "setting", searched };
    }

    // No fallback from here. A setting that points at nothing is a mistake
    // someone made on purpose, and quietly using a different server than the one
    // they named is how a wrong answer gets trusted.
    return {
      path: null,
      source: "setting",
      searched,
      reason: `lattice.server.path is set to ${configuredPath}, and there is no file at ${configured}.`,
    };
  }

  const manifest = resolvePackageJson(nxRoot);
  if (manifest) {
    const resolved = join(dirname(manifest), SERVER_ENTRY);
    searched.push(resolved);
    if (exists(resolved)) {
      return { path: resolved, source: "workspace", searched };
    }
  }

  // The literal path is the second attempt rather than the first: it is what
  // catches an installation Node's resolver will not answer for — a store the
  // extension host cannot see from its own module graph — and it is wrong often
  // enough that it must not pre-empt a real resolution.
  const literal = join(nxRoot, "node_modules", ...SERVER_PACKAGE.split("/"), SERVER_ENTRY);
  if (!searched.includes(literal)) {
    searched.push(literal);
    if (exists(literal)) {
      return { path: literal, source: "workspace", searched };
    }
  }

  return {
    path: null,
    source: null,
    searched,
    reason: `${SERVER_PACKAGE} is not installed in ${nxRoot}, so nothing is checking module boundaries in this window. Add it to the workspace, or set lattice.server.path to an lsp.mjs.`,
  };
}
