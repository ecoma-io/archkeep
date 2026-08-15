/**
 * The workspace's boundary law, read by a process that outlives edits to it.
 *
 * `../config.mjs` already loads and validates that file, and this module reuses
 * its pure validators (`policyKeyViolations`, `policyFrom`) rather than
 * restating what a well-formed policy looks like — one answer to "is this
 * table well-formed", shared by every dialect and every face. What it does NOT
 * reuse is `loadBoundaryConfig`/`loadBoundaryConfigFile` themselves, and for
 * the `.mjs`/`.js` dialect the reason is one line of ESM semantics: `import()`
 * memoises a module URL for the life of the process. A CLI run imports the
 * config once and exits, so memoisation is invisible there. A language server
 * runs for hours across edits to that very file, and a second `import()` of
 * the same URL would hand back the constraint table as it was when the editor
 * opened — the editor would then re-diagnose every file against a config that
 * no longer exists, which is precisely the failure re-diagnosing on a config
 * change is meant to prevent.
 *
 * So the `.mjs`/`.js` URL carries a revision the caller controls. The `.json`
 * dialect needs no such trick — `readFile` reads whatever is on disk at the
 * moment it is called, with no module cache in the way — so `revision` is
 * accepted for both dialects (one entry point, one signature) but only spent
 * on the one that needs it.
 *
 * A THIRD dialect exists — `../config.mjs`'s ESLint flat-config reader
 * (`../eslint-config.mjs`), which the CLI and Nx-plugin faces both read
 * (`docs/concepts/policies.md`) — and this server does not read it yet. That
 * reader resolves the workspace's own installed `@nx/eslint-plugin` and has
 * no notion of a revisioned `import()` to defeat this process's module cache
 * across edits; wiring both mechanisms together belongs to the milestone that
 * actually adds live ESLint-dialect support to the editor, not to this one.
 * Until then, an `eslint.config.*` or legacy `.eslintrc*` `boundaryConfig` is
 * refused BY NAME below — on basename, before the extension dispatch ever
 * runs — rather than reaching `readModulePolicy`'s bare `import()` and
 * failing on an unrelated "not a module object" a reader could not connect
 * back to "this is an ESLint config".
 */
import { readFile as readFileFromDisk } from "node:fs/promises";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ESLINT_FLAT_CONFIG_BASENAME,
  LEGACY_ESLINTRC_BASENAME,
  policyFrom,
  policyKeyViolations,
} from "../config.mjs";

/**
 * Loads and validates the `.mjs`/`.js` dialect through a revisioned `import()`
 * — see this module's header for why the revision exists.
 *
 * @param {string} path Absolute path of the config file.
 * @param {string|number} revision Busts the ESM module cache across edits.
 * @returns {Promise<{ depConstraints: object[], options: object, suppressions: object[] }>}
 * @throws {Error} when the file is missing, unloadable, or malformed.
 */
async function readModulePolicy(path, revision) {
  const url = `${pathToFileURL(path).href}?revision=${encodeURIComponent(String(revision))}`;
  let module;
  try {
    module = await import(url);
  } catch (cause) {
    throw new Error(`lattice: cannot load ${path}: ${cause?.message ?? cause}`, { cause });
  }
  return policyFrom(module, path);
}

/**
 * Loads and validates the `.json` dialect: plain `JSON.parse`, never JSONC —
 * `../config.mjs`'s `loadJsonPolicy` documents why, and this is the same
 * check, reached through the same two exported validators rather than a
 * second copy of either.
 *
 * @param {string} path Absolute path of the config file.
 * @param {(path: string, encoding: "utf8") => Promise<string>} readFile
 *   Injected so a test can drive this without a real file — see
 *   `readBoundaryConfig` below.
 * @returns {Promise<{ depConstraints: object[], options: object, suppressions: object[] }>}
 * @throws {Error} when the file is missing, unreadable, not valid JSON, or
 *   malformed — either by `../config.mjs`'s `findBoundaryConfigViolations` or
 *   by carrying a top-level key none of those rules knows about.
 */
async function readJsonPolicy(path, readFile) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    throw new Error(`lattice: cannot load ${path}: ${cause?.message ?? cause}`, { cause });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`lattice: cannot load ${path}: ${cause?.message ?? cause}`, { cause });
  }
  return policyFrom(parsed, path, policyKeyViolations(parsed, { allowSchema: true }));
}

/**
 * Loads and validates the boundary config at `workspaceRoot`.
 *
 * Basename is tested FIRST, exactly the same two patterns and the same order
 * `../config.mjs`'s `loadBoundaryConfigFile` uses, and for the identical
 * reason: both an `eslint.config.*` name and a legacy `.eslintrc*` name are
 * `.mjs`/`.js`-extensioned (or extensionless) often enough that reaching the
 * extension dispatch first would either half-work or fail on a message that
 * never mentions ESLint. Only once neither basename matches does the
 * extension decide between `.mjs`/`.js` (`readModulePolicy`) and `.json`
 * (`readJsonPolicy`); anything else is refused by name, in a message that
 * does not contain the words "cannot load" — a `boundaryConfig` misspelt to a
 * `.yaml` or `.toml` extension is a naming mistake, not a missing or
 * unreadable file, and the two must read as different problems. This server
 * used to only ever recognise the `.mjs`/`.js` spelling — a `.json`
 * `boundaryConfig` reached `readModulePolicy`'s bare `import()`, which Node
 * refuses for JSON with `ERR_IMPORT_ATTRIBUTE_MISSING`, a message that names
 * an import-attributes problem rather than the missing dialect support that
 * was the real cause.
 *
 * The ESLint dialect itself is refused rather than read — see this module's
 * header for why this server does not (yet) reuse `../eslint-config.mjs`.
 *
 * @param {string} workspaceRoot Absolute path of the tree being judged — never
 *   derived from this file's own location, for the reason `../config.mjs`
 *   states: pointed at a consumer's tree, the tool's own directory and the
 *   workspace's root are in different trees.
 * @param {string|number} revision Anything that changes when the file should be
 *   re-read. Spent only by the `.mjs`/`.js` arm — see this module's header.
 * @param {string} boundaryConfig The config's filename in this workspace,
 *   resolved from the plugin's options by the server that owns the session.
 * @param {{readFile?: (path: string, encoding: "utf8") => Promise<string>}} [io]
 *   Injectable read, used only by the `.json` dialect, defaulting to
 *   `node:fs/promises`'s `readFile`.
 * @returns {Promise<{depConstraints: object[], options: object, suppressions: object[]}>}
 *   `suppressions` is `[]` when the config declares none.
 * @throws {Error} when `boundaryConfig` names the ESLint flat-config dialect
 *   or a legacy `.eslintrc*` file (this reader does not read either yet — see
 *   above), or — for a dialect it does read — when the file is missing,
 *   unloadable, or malformed, or names an extension neither dialect reads —
 *   the same contract `loadBoundaryConfigFile` has, for the same reason: an
 *   enforcer that starts with no rules enforces nothing and says nothing.
 */
export async function readBoundaryConfig(
  workspaceRoot,
  revision,
  boundaryConfig,
  { readFile = readFileFromDisk } = {},
) {
  const path = `${workspaceRoot.replace(/\/$/, "")}/${boundaryConfig}`;
  const name = basename(path);
  if (ESLINT_FLAT_CONFIG_BASENAME.test(name) || LEGACY_ESLINTRC_BASENAME.test(name)) {
    throw new Error(
      `lattice: ${path} names an ESLint config (${name}) as boundaryConfig — the language ` +
        "server reads only the .mjs/.js and .json policy-file dialects for now, not ESLint's " +
        "flat-config dialect the CLI and Nx-plugin faces also read " +
        "(../../../../docs/reference/policy-schema.md). Point boundaryConfig at an .mjs, .js, or .json " +
        "boundary-law file to use it from the editor.",
    );
  }
  const extension = extname(path);
  if (extension === ".mjs" || extension === ".js") return readModulePolicy(path, revision);
  if (extension === ".json") return readJsonPolicy(path, readFile);
  throw new Error(
    `lattice: ${path} names an unsupported boundaryConfig extension '${extension || "(none)"}' — ` +
      `expected .mjs, .js, or .json`,
  );
}
