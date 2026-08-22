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
 * on the one that needs it. The inline form spends it least of all: it arrives
 * as an object `./server.mjs` already re-read from `lattice.json`, so there is
 * no read here to make stale.
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
import { existsSync } from "node:fs";
import { readFile as readFileFromDisk } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { containmentViolation } from "../containment.mjs";
import {
  ESLINT_FLAT_CONFIG_BASENAME,
  LEGACY_ESLINTRC_BASENAME,
  policyFrom,
  policyKeyViolations,
} from "../config.mjs";
import { LATTICE_MODEL_FILE } from "../providers/native/model.mjs";

/**
 * Loads and validates the `.mjs`/`.js` dialect through a revisioned `import()`
 * — see this module's header for why the revision exists.
 *
 * The top-level exports carry the same key law `../config.mjs`'s
 * `loadModulePolicy` applies: an export beyond the four this loader reads is
 * refused by name, through the same `policyKeyViolations` the `.json` arm and
 * the CLI both use — a config the CLI refuses must not load clean in the editor
 * and re-paint every open file against a typo'd, no-op law.
 *
 * @param {string} path Absolute path of the config file.
 * @param {string|number} revision Busts the ESM module cache across edits.
 * @returns {Promise<{ depConstraints: object[], options: object, suppressions: object[], fitness?: object[], customRules?: object[] }>}
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
  return policyFrom(module, path, policyKeyViolations(module, { allowSchema: false }));
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
 * @returns {Promise<{ depConstraints: object[], options: object, suppressions: object[], fitness?: object[], customRules?: object[] }>}
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
 * @param {string|object} boundaryConfig The config's filename in this
 *   workspace, resolved from the plugin's options by the server that owns the
 *   session — or, on a native root that carries its law on `lattice.json`
 *   itself, that inline policy object, validated and returned with no file
 *   read at all (the first branch of the body says why none is needed).
 * @param {{readFile?: (path: string, encoding: "utf8") => Promise<string>}} [io]
 *   Injectable read, used only by the `.json` dialect, defaulting to
 *   `node:fs/promises`'s `readFile`.
 * @returns {Promise<{depConstraints: object[], options: object, suppressions: object[], fitness?: object[], customRules?: object[]}>}
 *   `suppressions` is `[]` when the config declares none; `fitness` and
 *   `customRules` are present only when the policy declares them, the same
 *   absent-is-a-decision shape `../config.mjs`'s `policyFrom` returns to
 *   every other face. This server READS both and evaluates neither — a
 *   fitness function and a custom rule are per-run workspace judgments, not
 *   per-file diagnostics — so what it owes them is to load them and to fail
 *   loudly on a row it cannot read.
 * @throws {Error} when `boundaryConfig` names the ESLint flat-config dialect
 *   or a legacy `.eslintrc*` file (this reader does not read either yet — see
 *   above), or — for a dialect it does read — when the file is missing,
 *   unloadable, or malformed, or names an extension neither dialect reads, or
 *   — for the inline form — when the policy object is malformed. The same
 *   contract `loadBoundaryConfigFile` has, for the same reason: an enforcer
 *   that starts with no rules enforces nothing and says nothing.
 */
export async function readBoundaryConfig(
  workspaceRoot,
  revision,
  boundaryConfig,
  { readFile = readFileFromDisk } = {},
) {
  // An inline policy is DATA, not a path, so every mechanic below it is moot:
  // there is no name to resolve, nothing to contain, no dialect to dispatch on,
  // and no module cache for `revision` to defeat. `./server.mjs`'s
  // `readWorkspaceOptions` has already re-read this object out of
  // `lattice.json` for the current revision, and that file is watched
  // unconditionally by `watchedFilesFor`, so an edit to the law arrives here as
  // a different object rather than as a file this function would have to
  // re-read.
  //
  // It is still validated rather than trusted. `../providers/native/model.mjs`
  // checked it at load, which makes this the second pass over a table small
  // enough to review by eye — cheap, and the alternative is a face that
  // enforces whatever its caller hands it. `allowSchema` matches the `.json`
  // arm below because the inline form accepts `$schema` for the same
  // editor-validation reason a policy file does.
  if (typeof boundaryConfig !== "string") {
    return policyFrom(
      boundaryConfig,
      `the inline policy on ${LATTICE_MODEL_FILE}'s boundaryConfig at ${workspaceRoot}`,
      policyKeyViolations(boundaryConfig, { allowSchema: true }),
    );
  }
  const path = `${workspaceRoot.replace(/\/$/, "")}/${boundaryConfig}`;
  // Resolved ONCE, and the IDENTICAL string feeds the containment check and
  // the read below. The law name is tree-derived (`nx.json`/`lattice.json`
  // options), so a tracked symlink in an intermediate component of it would
  // hand outside constraint rows in as the workspace's law — the same read
  // escape `../config.mjs`'s `loadBoundaryConfig` now refuses; this is that
  // check held on the language-server face. Resolving first is the
  // resolve-first contract `../containment.mjs`'s `containsDotDot` refusal
  // exists for: a `..` in the raw name would be normalised away for the check
  // while the read still followed it (`../containment.mjs`, read-side G-10).
  const resolved = resolve(path);
  if (existsSync(workspaceRoot)) {
    const violation = containmentViolation(workspaceRoot, resolved);
    if (violation !== null) {
      throw new Error(`lattice: cannot load ${path}: ${violation}`);
    }
  }
  const name = basename(resolved);
  if (ESLINT_FLAT_CONFIG_BASENAME.test(name) || LEGACY_ESLINTRC_BASENAME.test(name)) {
    throw new Error(
      `lattice: ${path} names an ESLint config (${name}) as boundaryConfig — the language ` +
        "server reads only the .mjs/.js and .json policy-file dialects for now, not ESLint's " +
        "flat-config dialect the CLI and Nx-plugin faces also read " +
        "(../../../../docs/reference/policy-schema.md). Point boundaryConfig at an .mjs, .js, or .json " +
        "boundary-law file to use it from the editor.",
    );
  }
  const extension = extname(resolved);
  if (extension === ".mjs" || extension === ".js") return readModulePolicy(resolved, revision);
  if (extension === ".json") return readJsonPolicy(resolved, readFile);
  throw new Error(
    `lattice: ${path} names an unsupported boundaryConfig extension '${extension || "(none)"}' — ` +
      `expected .mjs, .js, or .json`,
  );
}
