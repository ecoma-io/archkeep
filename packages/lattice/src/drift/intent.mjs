/**
 * The intent: the workspace's declared intended architecture, loaded and
 * validated, ready for `computeDrift` (`./drift.mjs`).
 *
 * The intent is a consumer-facing, declarative contract — which projects must
 * and must not exist, which dependencies are permitted or forbidden, which
 * project→tag assignments are required. It is *not* the existing
 * `../intent/intent-manifest.json`, which is this repository's own v1.0
 * evidence manifest about the tool being correct; the design spec
 * (`../../drift-DESIGN.md`) states that the two share a word and not a
 * mechanism. This module is the consumer's law, validated.
 *
 * ## Loading
 *
 * `loadIntent` recovers and parses a plain-ESM `architecture-intent.config.mjs`
 * (or the name the workspace configured via the `intentConfig` option — the
 * same seam `boundaryConfig`/`tsConfig` use). An intent is a module, never a
 * JSON file: the workspace authors an expression that computes its law, so an
 * inline intent (the object form `lattice.json` accepts for `boundaryConfig`)
 * is impossible and stays impossible — this file is named by filename only,
 * and the CLI is the only surface that reads it (`../CLAUDE.md`).
 *
 * ## Validation shape rules
 *
 * Every violation of the *config shape* is a loud error (the command turns it
 * into exit 3), because a malformed intent that silently matched nothing would
 * be the silent direction:
 *
 * - the default export must be a plain object (`projects`, `dependencies`,
 *   `tags` — each section optional but, when present, an object);
 * - `projects.required[]`: `name` a non-empty string; `tags` optional, an
 *   array of non-empty strings;
 * - `projects.forbidden[]`: `name` a non-empty string;
 * - `dependencies.allowed[]` / `dependencies.forbidden[]`: `source` and
 *   `target` non-empty strings;
 * - `tags.forbid[]`: `from` and `to` non-empty strings, and `to !== from`
 *   (a tag depending on itself is a no-op the author should not phrase as a
 *   rule);
 * - an explicit `dependencies.allowed: []` is rejected. Omitted means "no
 *   allowlist" (only forbidden rules fire); an explicit empty array is
 *   ambiguous between that reading and "exactly nothing may exist" (every edge
 *   is `dependencyNotAllowed`). The engine cannot tell which was written, so
 *   it refuses to guess — omit the section instead.
 * - unknown keys are rejected at every level — the section, and each row —
 *   naming the path, so a typo'd section (`dependencs`) and a typo'd row field
 *   (`tgas` for `tags`) are both caught rather than silently ignored.
 */

/**
 * The validated, normalised intent — exactly what `validateIntent` returns and
 * what `computeDrift` (`./drift.mjs`) consumes.
 *
 * @typedef {object} DriftIntent
 * @property {{name: string, tags: string[]}[]} requiredProjects
 * @property {{name: string}[]} forbiddenProjects
 * @property {{source: string, target: string}[]} allowedDependencies
 * @property {{source: string, target: string}[]} forbiddenDependencies
 * @property {{from: string, to: string}[]} forbiddenTags
 */
export {};

/** A non-empty string, else throw with a message naming `what`. */
function requireNonEmptyString(value, what) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`intent: ${what} must be a non-empty string, got ${describeValue(value)}`);
  }
}

/**
 * Refuse a row that names a field this schema does not know, by that spelling.
 * A typo'd field (`tgas` for `tags`) must be a loud refusal, never a silently
 * dropped requirement — a weaker rule read as "clean" is the silent direction.
 *
 * @param {object} row The row object being validated.
 * @param {string[]} allowed The field names it may carry, in schema order.
 * @param {string} path The row's location (`projects.required[0]`), path prefix.
 */
function rejectUnknownRowKeys(row, allowed, path) {
  for (const key of Object.keys(row)) {
    if (!allowed.includes(key)) {
      throw new IntentValidationError(
        `intent: unknown key in ${path}: "${key}" — expected only ${allowed.map((k) => `"${k}"`).join(", ")}`,
      );
    }
  }
}

function describeValue(value) {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  return `${Array.isArray(value) ? "array" : typeof value}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Named after the config-shape errors the command turns into exit 3. */
class IntentValidationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "IntentValidationError";
  }
}

/**
 * Validated intent with every array normalised to a plain list. Only the
 * fields `computeDrift` reads are returned; the original row objects are
 * flattened so the comparison can never read a raw field that validation let
 * past. Rows keep the order the author wrote (determinism is not pinned here —
 * `computeDrift` owns the total sort of findings).
 *
 * @param {object} raw The default export of the intent module.
 * @returns {{
 *   requiredProjects: {name: string, tags: string[]}[],
 *   forbiddenProjects: {name: string}[],
 *   allowedDependencies: {source: string, target: string}[],
 *   forbiddenDependencies: {source: string, target: string}[],
 *   forbiddenTags: {from: string, to: string}[],
 * }}
 * @throws {IntentValidationError} on any shape violation, naming the row.
 */
export function validateIntent(raw) {
  if (!isPlainObject(raw)) {
    throw new IntentValidationError(
      `intent: the default export must be a plain object (found ${describeValue(raw)})`,
    );
  }

  const knownSections = ["projects", "dependencies", "tags"];
  for (const key of Object.keys(raw)) {
    if (!knownSections.includes(key)) {
      throw new IntentValidationError(
        `intent: unknown top-level key "${key}" — expected only ${knownSections.map((k) => `"${k}"`).join(", ")}`,
      );
    }
  }

  const projects = raw.projects ?? {};
  if (!isPlainObject(projects)) {
    throw new IntentValidationError("intent: `projects` must be an object when present");
  }
  for (const key of Object.keys(projects)) {
    if (!["required", "forbidden"].includes(key)) {
      throw new IntentValidationError(
        `intent: unknown key in \`projects\`: "${key}" — expected "required" or "forbidden"`,
      );
    }
  }
  const requiredProjects = (projects.required ?? []).map((row, index) => {
    if (!isPlainObject(row)) {
      throw new IntentValidationError(`intent: projects.required[${index}] must be an object`);
    }
    rejectUnknownRowKeys(row, ["name", "tags"], `projects.required[${index}]`);
    const name = row.name;
    requireNonEmptyString(name, `projects.required[${index}].name`);
    const tags = row.tags ?? [];
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string" || tag.trim() === "")) {
      throw new IntentValidationError(
        `intent: projects.required[${index}].tags must be an array of non-empty strings`,
      );
    }
    return { name, tags: [...tags] };
  });

  const forbiddenProjects = (projects.forbidden ?? []).map((row, index) => {
    if (!isPlainObject(row)) {
      throw new IntentValidationError(`intent: projects.forbidden[${index}] must be an object`);
    }
    rejectUnknownRowKeys(row, ["name"], `projects.forbidden[${index}]`);
    const name = row.name;
    requireNonEmptyString(name, `projects.forbidden[${index}].name`);
    return { name };
  });

  const dependencies = raw.dependencies ?? {};
  if (!isPlainObject(dependencies)) {
    throw new IntentValidationError("intent: `dependencies` must be an object when present");
  }
  for (const key of Object.keys(dependencies)) {
    if (!["allowed", "forbidden"].includes(key)) {
      throw new IntentValidationError(
        `intent: unknown key in \`dependencies\`: "${key}" — expected "allowed" or "forbidden"`,
      );
    }
  }
  if (Array.isArray(dependencies.allowed) && dependencies.allowed.length === 0) {
    throw new IntentValidationError(
      "intent: `dependencies.allowed` may not be an explicit empty array — omit the section to " +
        "allow any dependency except the forbidden ones, which is the only non-ambiguous reading",
    );
  }
  const edgeRow = (row, path) => {
    if (!isPlainObject(row)) {
      throw new IntentValidationError(`intent: ${path} must be an object`);
    }
    rejectUnknownRowKeys(row, ["source", "target"], path);
    const source = row.source;
    const target = row.target;
    requireNonEmptyString(source, `${path}.source`);
    requireNonEmptyString(target, `${path}.target`);
    return { source, target };
  };
  const allowedDependencies = (dependencies.allowed ?? []).map((row, index) =>
    edgeRow(row, `dependencies.allowed[${index}]`),
  );
  const forbiddenDependencies = (dependencies.forbidden ?? []).map((row, index) =>
    edgeRow(row, `dependencies.forbidden[${index}]`),
  );

  const tags = raw.tags ?? {};
  if (!isPlainObject(tags)) {
    throw new IntentValidationError("intent: `tags` must be an object when present");
  }
  for (const key of Object.keys(tags)) {
    if (key !== "forbid") {
      throw new IntentValidationError(
        `intent: unknown key in \`tags\`: "${key}" — expected "forbid"`,
      );
    }
  }
  const forbiddenTags = (tags.forbid ?? []).map((row, index) => {
    if (!isPlainObject(row)) {
      throw new IntentValidationError(`intent: tags.forbid[${index}] must be an object`);
    }
    rejectUnknownRowKeys(row, ["from", "to"], `tags.forbid[${index}]`);
    const from = row.from;
    const to = row.to;
    requireNonEmptyString(from, `tags.forbid[${index}].from`);
    requireNonEmptyString(to, `tags.forbid[${index}].to`);
    if (from === to) {
      throw new IntentValidationError(
        `intent: tags.forbid[${index}] is a no-op — from and to are both "${from}"; a tag ` +
          `depending on itself is not a rule`,
      );
    }
    return { from, to };
  });

  return {
    requiredProjects,
    forbiddenProjects,
    allowedDependencies,
    forbiddenDependencies,
    forbiddenTags,
  };
}

/**
 * Loads and validates the intent module from disk. The observed side is not
 * read here — the caller passes completeness separately — so this function
 * returns the plain validated intent.
 *
 * @param {string} root The workspace root.
 * @param {string} intentConfig The configured intent filename.
 * @param {{importModule?: (specifier: string) => Promise<{default?: *}>}} [io]
 *   Overridable module loader for testability.
 * @returns {Promise<ReturnType<typeof validateIntent>>}
 * @throws {Error} on an unreadable or non-default-exporting module, and
 *   {IntentValidationError} on a shape violation.
 */
export async function loadIntent(root, intentConfig, io = {}) {
  const importModule = io.importModule ?? ((specifier) => import(specifier));
  const fileUrl = new URL(`file://${root}/${intentConfig}`);
  let mod;
  try {
    mod = await importModule(fileUrl.href);
  } catch (error) {
    throw new Error(`intent: could not load ${intentConfig}: ${error.message}`, { cause: error });
  }
  if (mod.default === undefined) {
    throw new Error(
      `intent: ${intentConfig} must default-export the intended architecture — a named export ` +
        `(or no export) means the engine cannot tell which value is the law`,
    );
  }
  return validateIntent(mod.default);
}
