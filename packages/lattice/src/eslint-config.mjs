/**
 * Reads the workspace's module-boundary law out of an ESLint flat config, for
 * the `boundaryConfig` dialect selected on basename — a name matching
 * `eslint.config.*` — by `./config.mjs`'s own dispatch (that module's header
 * carries the dispatch as a whole; this one only reads what it hands off to).
 *
 * A TypeScript workspace already keeps its module-boundary law in
 * `@nx/enforce-module-boundaries`'s own rule entry, because that is what
 * ESLint reads. This dialect lets such a workspace point `boundaryConfig`
 * straight at that file instead of maintaining a second, `.mjs` copy of the
 * same table — the two tables disagreeing the day one changed is exactly the
 * drift a single source of truth is meant to prevent.
 *
 * `extractBoundaryRule` moved here from `scripts/differential-real-trees.mjs`
 * (which now re-exports it): the differential and this reader parse the
 * identical shape — a flat-config array's `@nx/enforce-module-boundaries`
 * entry, bound the way ESLint itself binds it, last matching entry wins — and
 * a second copy of that parser is exactly the drift `AGENTS.md`'s "never
 * state a rule twice" rule exists to catch.
 *
 * Every option `@nx/enforce-module-boundaries` accepts but this ESLint entry
 * does not state is defaulted from the workspace's own installed
 * `@nx/eslint-plugin` — never from a value copied into this package, which
 * would drift the day upstream changed a default. `depConstraints` has no
 * such default read: an entry that does not state it at all is refused rather
 * than read as an empty table (see `parseRuleValue`) — the eslint dialect
 * makes the same "an unstated table is not an empty one" claim the `.mjs`
 * dialect makes, just for a different reason: there, an unstated
 * `depConstraints` key never happens because the exported object is this
 * tool's own shape; here, a workspace's real ESLint entry can genuinely
 * configure the rule on with only, say, `buildTargets` stated, and reading
 * that as "no constraints" would report a clean tree over a table nobody
 * wrote.
 *
 * Everything this file reports is loud: an ESLint config this reader cannot
 * map to a constraint table throws, naming why, so a workspace mid-migration
 * to this dialect gets one clear error rather than a boundary check that
 * quietly ran with no constraints (`AGENTS.md`'s invariant). Four classes of
 * "cannot map" beyond the ones already documented on `extractBoundaryRule`
 * and `parseRuleValue`:
 *
 * - A flat-config array element that is not a plain object — a nested array
 *   (flat config permits composing configs by nesting arrays, flattened by
 *   ESLint's own loader before a rule ever runs), a function, or anything
 *   else this reader was not built to read — is refused BY INDEX rather than
 *   skipped. Skipping it silently would let an earlier, already-matched entry
 *   keep binding with no sign that a later entry — possibly the one that
 *   actually configures the rule — was never read at all: the confident-wrong
 *   answer this whole file exists to avoid.
 * - An element carrying an `extends` key is refused the same way: this reader
 *   walks the array ESLint's loader has already flattened, not a config
 *   ESLint has resolved through an `extends` chain (see "What the extraction
 *   structurally cannot see" below).
 * - A `files`-scoped entry is refused UNLESS every glob in its `files` is a
 *   bare source-extension pattern over the whole tree, with no directory
 *   component — see `BARE_EXTENSION_GLOB`. That is the shape `nx g
 *   @nx/eslint` itself emits, and it states which languages ESLint parses,
 *   never which part of the tree the law covers, so lattice applies the
 *   table tree-wide and records the fact as a note rather than refusing a
 *   config this dialect is meant to read with no rewriting at all.
 * - An entry carrying a non-empty `ignores` is refused outright, with no
 *   bare-extension exception: unlike `files`, an `ignores` list is a set of
 *   paths by construction — there is no shape of it that states languages
 *   rather than territory — so it is folded into the same refusal a
 *   directory-component `files` glob gets, never applied tree-wide with the
 *   exclusion silently dropped.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/** The severities ESLint itself recognises for a rule entry. */
const KNOWN_SEVERITIES = new Set(["off", "warn", "error", 0, 1, 2]);
const OFF_SEVERITIES = new Set(["off", 0]);

// The shape `files` takes in the canonical config `nx g @nx/eslint` emits —
// two asterisks, a slash, an asterisk, a dot, then a bare extension, nothing
// before it and nothing after: `**` + `/*.ts`, `**` + `/*.tsx`, `**` + `/*.js`,
// `**` + `/*.jsx`. Both pinned real trees `scripts/differential-real-trees.mjs`
// drives carry exactly that array. A glob with a directory component
// (`apps/**` + `/*.ts`) states WHICH PART of the tree the law covers and is
// refused (see `extractBoundaryRule`); a bare extension glob states only
// WHICH LANGUAGES ESLint parses, which is not a scoping decision this reader
// has to honour to stay correct — every file lattice analyzes is already one
// of the four languages it knows, TS/JS included.
//
// Brace expansion (`**` + `/*.{ts,tsx}`) is deliberately NOT treated as the
// same shape: expanding brace syntax means reimplementing a slice of ESLint's
// own glob engine here, the same reason `./config.mjs`'s `suppressionCovers`
// reaches for `node:path`'s `matchesGlob` instead of hand-rolling one. A
// brace-form `files` entry is refused as scoped, same as a directory-scoped
// one — a stricter refusal than strictly necessary, not a silent guess.
const BARE_EXTENSION_GLOB = /^\*\*\/\*\.[A-Za-z0-9]+$/u;

/** @type {(value: unknown) => value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A rule entry's severity — the bare value itself, or the `[severity, …]` pair's first element. */
function severityOf(value) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Whether a rule entry states an options element at all (`[severity, options]`,
 * as opposed to a bare severity or a one-element `[severity]` array). Measured
 * against eslint 10.8.0's own `FlatConfigArray`: a later flat-config entry
 * that states only a severity does not clear the options an earlier entry
 * stated for the same rule — ESLint keeps that options object and merges only
 * the severity forward. `extractBoundaryRule` mirrors that merge instead of
 * reading a severity-only winning entry as "no depConstraints key stated" for
 * a config ESLint is actively enforcing under an earlier table.
 */
function statesOptions(value) {
  return Array.isArray(value) && value.length > 1;
}

/** A flat-config array element's shape, for a message naming what was found instead of a plain object. */
function describeElement(value) {
  if (Array.isArray(value)) return "an array";
  if (typeof value === "function") return "a function";
  if (value === null) return "null";
  return `a ${typeof value}`;
}

/**
 * One flat-config entry's `@nx/enforce-module-boundaries` value, parsed into
 * its options — or a thrown, named refusal when the severity is unrecognised,
 * switched off, the options are not an object, or the entry states no
 * `depConstraints` key at all.
 *
 * Called exactly once by `extractBoundaryRule`, on the entry that actually
 * BINDS — never mapped over every matching entry. An earlier entry that
 * happens to be off, or malformed, never configured anything ESLint would
 * have run with, and must not be able to refuse a run over an entry that
 * itself is perfectly valid and wins.
 *
 * @param {unknown} value The rule's configured value — a bare severity, or an
 *   `[severity, options]` pair.
 * @param {number} index The entry's position in the flat-config array, so the
 *   message points at the offending entry rather than at the rule in general.
 * @returns {Record<string, unknown>} The entry's options object, with
 *   `depConstraints` present (the caller strips it back out).
 * @throws {Error} when the severity is not one ESLint recognises, the
 *   severity is `off`/`0`, the options are stated but not an object, or the
 *   options carry no `depConstraints` key — reading that last case as an
 *   empty table would report a clean tree over an entry that is on but never
 *   said what it enforces.
 */
function parseRuleValue(value, index) {
  const isArray = Array.isArray(value);
  const severity = isArray ? value[0] : value;
  if (!KNOWN_SEVERITIES.has(/** @type {any} */ (severity))) {
    throw new Error(
      `lattice: flatConfig[${index}]'s @nx/enforce-module-boundaries severity is ` +
        `${JSON.stringify(severity)} — expected one of off, warn, error, 0, 1, 2. Anything else ` +
        "is refused rather than read as on, because there is no rule for what it means.",
    );
  }
  if (OFF_SEVERITIES.has(/** @type {any} */ (severity))) {
    throw new Error(
      `lattice: flatConfig[${index}] configures @nx/enforce-module-boundaries as ` +
        `${JSON.stringify(value)} — switched off, there is no constraint table to compare against.`,
    );
  }
  const rawOptions = isArray ? value[1] : undefined;
  if (rawOptions !== undefined && !isPlainObject(rawOptions)) {
    throw new Error(
      `lattice: flatConfig[${index}]'s @nx/enforce-module-boundaries options must be an object, ` +
        `got ${JSON.stringify(rawOptions)}`,
    );
  }
  const options = rawOptions ?? {};
  if (!("depConstraints" in options)) {
    throw new Error(
      `lattice: flatConfig[${index}] configures @nx/enforce-module-boundaries as ` +
        `${JSON.stringify(value)} — on, but with no depConstraints key stated. Reading an unstated ` +
        "table as an empty one would report a clean tree over an entry that never said what it " +
        "enforces; state depConstraints explicitly — [] if the workspace really means no " +
        "constraints — so an unstated table and a deliberately empty one are not the same shape on " +
        "disk.",
    );
  }
  return options;
}

/**
 * Reads the `@nx/enforce-module-boundaries` entry off a flat-config array,
 * exactly as ESLint would bind it: the LAST unscoped-or-accepted entry that
 * configures the rule wins. Pure — the caller has already imported the config
 * and handed the array in.
 *
 * @param {unknown} flatConfig The config module's default export, expected to
 *   be a flat-config array.
 * @returns {{depConstraints: object[], options: Record<string, unknown>,
 *   note?: string}} The constraint table, the entry's own stated options
 *   (`depConstraints` stripped out), and — only when there is something worth
 *   telling a reader about which entry bound — a note recording it. Three
 *   independent facts can each contribute a sentence: several unscoped (or
 *   accepted files-scoped) entries configuring the rule differently, the
 *   winning entry itself being files-scoped under the accepted shape, and the
 *   winning entry stating only a severity so its options were read off an
 *   earlier entry instead (see `statesOptions`). None of the three is a
 *   refusal: several overrides layered across a monorepo's `eslint.config.mjs`
 *   composing other configs is a normal, common shape, and ESLint's own
 *   binding rule already says unambiguously which one wins; a bare
 *   source-extension `files` entry states languages, not territory; and a
 *   severity-only override is exactly how ESLint expects a later config to
 *   dial a rule up or down without restating its table.
 * @throws {Error} when `flatConfig` is not an array, an element is not a
 *   plain object or carries an `extends` key, no entry configures the rule,
 *   an entry scopes the rule under a `files` glob with a directory component
 *   or carries a non-empty `ignores` (a per-glob law this reader cannot
 *   express — see below), or the winning entry's severity/options are
 *   malformed (`parseRuleValue`) once any severity-only fallback has been
 *   applied.
 */
export function extractBoundaryRule(flatConfig) {
  if (!Array.isArray(flatConfig)) {
    throw new Error(
      "lattice: the ESLint config's default export is not a flat-config array, so the module " +
        "boundary law cannot be read from it.",
    );
  }

  /** @type {{index: number, files: unknown, ignores: unknown, value: unknown, scope: "unscoped"|"extension"|"path"}[]} */
  const matches = [];
  flatConfig.forEach((item, index) => {
    if (!isPlainObject(item)) {
      throw new Error(
        `lattice: flatConfig[${index}] is ${describeElement(item)}, not a plain config object — ` +
          "this reader walks a flat-config array of plain objects only; a nested array, a " +
          "function, or any other shape it cannot read is refused rather than skipped, because " +
          "skipping it silently would let an earlier, already-matched entry keep binding with no " +
          "sign that a later entry was never read.",
      );
    }
    if ("extends" in item) {
      throw new Error(
        `lattice: flatConfig[${index}] carries an 'extends' key — this reader walks the array ` +
          "ESLint's own loader has already flattened, not a chain it resolves itself (see this " +
          'module\'s header, "What the extraction structurally cannot see"). Export the ' +
          "already-composed array instead, or move the @nx/enforce-module-boundaries entry to an " +
          "element with no 'extends'.",
      );
    }
    const value = /** @type {any} */ (item.rules)?.["@nx/enforce-module-boundaries"];
    if (value === undefined) return;
    const files = item.files;
    const ignores = item.ignores;
    // An `ignores` array on the same entry as `files`/`rules` excludes part of
    // the tree from what that entry configures — a scoping decision no less
    // territorial than a directory-component `files` glob (the `pathScoped`
    // check below), and unlike `files` there is no bare-extension shape that
    // reads as "which languages", never "which files": an ignore list is a
    // set of paths by construction. Reading past it — the bug this branch
    // closes — bound the table tree-wide with no note at all, silently
    // dropping the very exclusion the workspace wrote. Folding it into the
    // same `"path"` scope reuses the existing named refusal rather than
    // inventing a second one for the same class of problem.
    const hasIgnores = Array.isArray(ignores) && ignores.length > 0;
    const scope = hasIgnores
      ? "path"
      : files === undefined
        ? "unscoped"
        : Array.isArray(files) &&
            files.every((glob) => typeof glob === "string" && BARE_EXTENSION_GLOB.test(glob))
          ? "extension"
          : "path";
    matches.push({ index, files, ignores, value, scope });
  });

  if (matches.length === 0) {
    throw new Error(
      "lattice: no @nx/enforce-module-boundaries entry in this ESLint config — there is no " +
        "constraint table to read.",
    );
  }

  // A `files`-scoped entry configures the rule for a glob, not for the whole
  // tree. ESLint's own last-wins binding is unscoped: it does not know or care
  // which entry's `files` a given source file matched, because it never has
  // to — ESLint evaluates the rule per source file, scoped correctly, while
  // this reader has to pick ONE table for the entire workspace up front. A
  // scope with a directory component (`apps/**`, `libs/foo/**`) really does
  // say "only here", and taking the last entry regardless would silently
  // apply the wrong table to files outside its glob — refused by name. A
  // scope whose every glob is a bare source-extension pattern (`scope ===
  // "extension"`, see `BARE_EXTENSION_GLOB`) says no such thing and is left
  // in the pool below.
  const pathScoped = matches.find((match) => match.scope === "path");
  if (pathScoped !== undefined) {
    const hasIgnores = Array.isArray(pathScoped.ignores) && pathScoped.ignores.length > 0;
    throw new Error(
      hasIgnores
        ? `lattice: flatConfig[${pathScoped.index}] configures @nx/enforce-module-boundaries under ` +
            `ignores: ${JSON.stringify(pathScoped.ignores)} — lattice reads one global constraint ` +
            "table and has no way to express a law that excludes part of the tree. State the rule " +
            "in an entry with no ignores instead, or move ignores to a separate entry that carries " +
            "no @nx/enforce-module-boundaries key."
        : `lattice: flatConfig[${pathScoped.index}] configures @nx/enforce-module-boundaries under ` +
            `files: ${JSON.stringify(pathScoped.files)} — lattice reads one global constraint table ` +
            "and has no way to express a law that differs per file glob. A files entry whose every " +
            "glob is a bare source-extension pattern over the whole tree (no directory component) is " +
            "accepted instead and applied tree-wide, because that shape states which languages ESLint " +
            "parses rather than which part of the tree the law covers.",
    );
  }

  // Only the entry that actually BINDS is parsed — an earlier entry that is
  // off, malformed, or missing depConstraints never configured anything and
  // must not be able to refuse a run over the entry ESLint itself would run
  // with.
  const last = matches[matches.length - 1];

  // A winning entry that states only a severity (`"warn"`, not
  // `["warn", {...}]`) does not, under ESLint's own merge, clear whatever
  // options an earlier entry stated for this rule — see `statesOptions`.
  // Reading it as "on, with no depConstraints key" would refuse a config
  // ESLint is actively enforcing under the most recent earlier table; fall
  // back to that table instead, keeping the winning entry's own severity.
  let priorWithOptions;
  let effectiveValue = last.value;
  if (!statesOptions(effectiveValue)) {
    // `Array.prototype.findLast` needs an ES2023 lib target this package
    // does not carry (`tsconfig.json` targets es2022) — a plain backward
    // loop instead of widening the lib for one call site.
    for (let i = matches.length - 2; i >= 0; i--) {
      if (statesOptions(matches[i].value)) {
        priorWithOptions = matches[i];
        break;
      }
    }
    if (priorWithOptions !== undefined) {
      effectiveValue = [severityOf(last.value), priorWithOptions.value[1]];
    }
  }

  const { depConstraints: rawDepConstraints, ...options } = parseRuleValue(
    effectiveValue,
    last.index,
  );
  const depConstraints = /** @type {object[]} */ (rawDepConstraints);

  const noteParts = [];
  if (priorWithOptions !== undefined) {
    noteParts.push(
      `flatConfig[${last.index}] states only a severity (${JSON.stringify(last.value)}) for ` +
        "@nx/enforce-module-boundaries — ESLint's own merge keeps the options an earlier entry " +
        `stated for the rule rather than clearing them, so lattice read the constraint table off ` +
        `flatConfig[${priorWithOptions.index}], the most recent entry that stated one.`,
    );
  }
  if (matches.length > 1) {
    const differs = matches.some(
      (entry) => JSON.stringify(entry.value) !== JSON.stringify(last.value),
    );
    if (differs) {
      const indices = matches.map((entry) => entry.index).join(", ");
      noteParts.push(
        `flatConfig[${last.index}] is the entry lattice bound for @nx/enforce-module-boundaries ` +
          `— the last of ${matches.length} entries setting the rule (at index ${indices}), per ` +
          "ESLint's own last-wins binding order.",
      );
    }
  }
  if (last.scope === "extension") {
    noteParts.push(
      `flatConfig[${last.index}] scopes @nx/enforce-module-boundaries under files: ` +
        `${JSON.stringify(last.files)} — every glob there is a bare source-extension pattern with ` +
        "no directory component, so lattice applied the table tree-wide rather than refusing it " +
        "as a per-directory law.",
    );
  }

  return {
    depConstraints,
    options,
    ...(noteParts.length > 0 ? { note: noteParts.join(" ") } : {}),
  };
}

/**
 * The eight `@nx/enforce-module-boundaries` option defaults, read from the
 * workspace's own installed `@nx/eslint-plugin` rather than duplicated here —
 * a copy here would drift the day upstream changed a default. Resolved from
 * `configPath` (the flat config's own location), never from this package, so
 * a workspace whose plugin is hoisted differently than this package's own
 * dependency tree still resolves the copy it actually lints with
 * (`../CLAUDE.md`: "never assume any workspace's project names, areas, or tag
 * values" — the same posture applies to which copy of a peer plugin answers).
 *
 * Resolution and loading are two separate steps with two separate refusals:
 * `require.resolve` alone answers "is the package there at all", with no side
 * effects, before anything of the plugin's own code runs; a package that
 * resolves but throws while its own entry point executes — an incompatible
 * dependency of the plugin's, say — is a different problem than one that is
 * simply not installed, and the two must not read as the same message. The
 * plugin's own `package.json` "exports" map exposes no subpath narrower than
 * the whole package (measured: requiring
 * `@nx/eslint-plugin/dist/src/rules/enforce-module-boundaries` directly
 * throws `ERR_PACKAGE_PATH_NOT_EXPORTED`), so loading the whole resolved
 * entry point is the least this reader can load and still reach the one
 * rule's defaults.
 *
 * @param {string} configPath Absolute path of the workspace's ESLint config.
 * @returns {Record<string, unknown>} The rule's own `defaultOptions[0]`, with
 *   `depConstraints` stripped — that default is always `[]` and is never what
 *   this reader wants read from it: the workspace's own stated table always
 *   wins, and an unstated one means empty, not upstream's fallback.
 * @throws {Error} naming the workspace's config path, when the plugin does
 *   not resolve from it, resolves but throws while loading, or loads but
 *   exposes no default options to ground the unstated ones against — any of
 *   the three leaves this reader nothing to fill the un-stated options with,
 *   and filling them with a guess would be exactly the silent default
 *   `../options.mjs` refuses for its own two keys.
 */
function resolveEslintPluginDefaults(configPath) {
  const require = createRequire(configPath);
  let resolvedPath;
  try {
    resolvedPath = require.resolve("@nx/eslint-plugin");
  } catch (cause) {
    throw new Error(
      `lattice: @nx/eslint-plugin does not resolve from ${configPath} — the ESLint ` +
        "boundaryConfig dialect reads its unstated option defaults off the workspace's own " +
        "installed plugin, and a workspace naming this dialect without that plugin installed has " +
        "no defaults to read.",
      { cause },
    );
  }
  let plugin;
  try {
    // The literal specifier again, not `resolvedPath` — `require` and
    // `require.resolve` are the same bound function, so resolving then
    // requiring the same specifier reaches the identical file `resolvedPath`
    // already names (Node resolves and caches by the same algorithm both
    // times), and a literal keeps this load visible to the conformance walk
    // (`src/conformance/boundary.test.mjs`), which cannot follow a `require`
    // call built from a variable — that is opacity the walk is built to
    // refuse, not a shape it is meant to approximate.
    plugin = require("@nx/eslint-plugin");
  } catch (cause) {
    throw new Error(
      `lattice: @nx/eslint-plugin resolved from ${resolvedPath} but could not be loaded: ` +
        `${cause?.message ?? cause} — a plugin that resolves but fails while its own entry point ` +
        "runs is a different problem than one that is simply not installed, and must not read as " +
        "the same refusal.",
      { cause },
    );
  }
  const rule = /** @type {any} */ (plugin)?.rules?.["enforce-module-boundaries"];
  const defaults = rule?.defaultOptions?.[0];
  if (!isPlainObject(defaults)) {
    throw new Error(
      `lattice: @nx/eslint-plugin resolved from ${resolvedPath} but its enforce-module-boundaries ` +
        "rule exposes no default options to ground the unstated ones against.",
    );
  }
  const { depConstraints: _pluginDepConstraintsDefault, ...optionDefaults } = defaults;
  return optionDefaults;
}

/**
 * Loads and reads the boundary law out of an ESLint flat config at `path`.
 *
 * Handles exactly one default-export shape: a plain array, the flat-config
 * form ESLint itself treats as already-resolved. Every other shape ESLint
 * also accepts — a Promise (the async-config form), a function (a config
 * factory), a single bare object (auto-wrapped by ESLint's own loader) — is
 * refused by name rather than coerced: coercing a bare object into a
 * one-element array, or awaiting a Promise, would mean reimplementing
 * ESLint's own config-resolution pipeline here, and answering for a table
 * ESLint's real pipeline might resolve differently.
 *
 * @param {string} path Absolute path of the ESLint config file.
 * @returns {Promise<{depConstraints: object[], options: Record<string, unknown>, note?: string}>}
 * @throws {Error} when the file cannot be imported, its default export is not
 *   a flat-config array, `extractBoundaryRule` refuses the rule entry it
 *   contains, or `@nx/eslint-plugin` cannot supply the unstated defaults.
 */
export async function loadEslintBoundaryConfig(path) {
  let loaded;
  try {
    loaded = await import(pathToFileURL(path).href);
  } catch (cause) {
    throw new Error(`lattice: cannot load ${path}: ${cause?.message ?? cause}`, { cause });
  }

  const { depConstraints, options, note } = extractBoundaryRule(loaded.default);
  const optionDefaults = resolveEslintPluginDefaults(path);
  return { depConstraints, options: { ...optionDefaults, ...options }, note };
}
