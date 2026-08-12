/**
 * Reads the workspace's module-boundary law and refuses to run on a malformed
 * one.
 *
 * The law itself lives in a file at the workspace root — by default
 * `module-boundaries.config.mjs`, which is also where ESLint reads it (that
 * file's header says why it moved out of `eslint.config.mjs`), and otherwise
 * wherever the plugin's `boundaryConfig` option names. This module is the second
 * reader's side of that seam: it loads the file and checks its shape, so a typo
 * fails here, once, naming the offending row — rather than downstream as a rule
 * that silently matches nothing. A constraint that matches nothing does not
 * error; it approves.
 *
 * **Both the path and the filename come from the caller, never from this file's
 * own location and never from a constant here.** The path, because this tool
 * runs in trees it is not part of: pointed at a consumer's root while its own
 * directory sits under that consumer's pinned reference clone, a
 * `../../../../` relative import would resolve to the tool's own copy — the
 * wrong tree's rules, silently. The filename, because it is an Nx convention
 * rather than a contract, and a workspace that renamed it would otherwise get
 * "cannot load `module-boundaries.config.mjs`" — a message that reads like a
 * missing config instead of a misconfigured tool. Same reason nothing here
 * assumes a project name, an area, or a tag value: everything comes from the
 * graph and the config.
 *
 * Validation covers shape, and one thing beyond it: whether every pattern the
 * table contains can actually be used. Nx feeds tags, external-import globs and
 * `allow` entries to three different matchers, each of which builds a `RegExp`,
 * so an unbalanced bracket in a constraint row throws from inside a rule
 * halfway through a run — and an EMPTY entry throws nothing at all, it just
 * quietly matches nothing (or, in `allow`, everything). Both classes are caught
 * here by asking `./rules/match.mjs` — the same matchers the rules use, so the
 * check is the real one and not a second opinion about it. That is why a module
 * this low imports one from `./rules/`: the alternative is a second copy of the
 * matchers, which is the failure mode this whole file exists to prevent.
 *
 * What it still has no opinion on is the VALUES. Whether `layer:adapter` should
 * be allowed to reach `layer:domain` is the workspace's decision, stated in that
 * config with its reasoning; this module must not grow a view on it.
 *
 * The one shape here that upstream has no counterpart for is
 * `boundarySuppressions`: the exemptions a workspace has decided to accept, each
 * with the reason it was accepted. ESLint takes those as `eslint-disable`
 * comments, which is a JavaScript convention with no equivalent in Go, Rust or
 * Python and would give exemptions a second home besides the config this file
 * exists to keep single. Validation is where the mandatory reason is enforced,
 * loudly, at load — see `suppressionRowViolations`.
 */
import { posix } from "node:path";
import { pathToFileURL } from "node:url";

import {
  globPatternError,
  importPatternError,
  projectPatternError,
  tagPatternError,
} from "./rules/match.mjs";
import { MESSAGE_IDS } from "./rules/messages.mjs";

/**
 * The filename the config has when a workspace has not said otherwise lives in
 * `./options.mjs`, with the option that overrides it — the two are one fact, and
 * they used to be two: this module owned a `MODULE_BOUNDARIES_CONFIG_FILE`
 * constant, and a workspace that named its law something else had no way to say
 * so. Nothing here spells the name at all now. The loaders below take a path or
 * a filename from their caller, who resolved it.
 */

/**
 * The eight non-table options, with the type each must have, and — where the
 * option's entries are patterns rather than plain names — the matcher they have
 * to survive. `../rules/match.mjs` owns those matchers; asking them directly is
 * what makes this check the real one rather than an approximation of it.
 *
 * `buildTargets` carries no matcher because its entries are target names,
 * compared with `===`. It still gets the empty-string check every list gets.
 */
const OPTION_TYPES = {
  allow: "string[]",
  buildTargets: "string[]",
  enforceBuildableLibDependency: "boolean",
  allowCircularSelfDependency: "boolean",
  checkDynamicDependenciesExceptions: "string[]",
  ignoredCircularDependencies: "pair[]",
  banTransitiveDependencies: "boolean",
  checkNestedExternalImports: "boolean",
};

const OPTION_ENTRY_MATCHERS = {
  // Both are matched with `matchImportWithWildcard`, whose fallback branch is
  // an unanchored `new RegExp(entry)`. `""` compiles to a regex matching every
  // string, so one empty entry in `allow` exempts the entire workspace from all
  // fifteen rules — silently, and reading like an empty list.
  allow: importPatternError,
  checkDynamicDependenciesExceptions: importPatternError,
  // Expanded through Nx's `findMatchingProjects`; this engine reproduces only
  // the part it can reproduce exactly, and rejects the rest here rather than
  // suppressing cycles it half-understands.
  ignoredCircularDependencies: projectPatternError,
};

/**
 * The keys a constraint row may carry, per `@nx/enforce-module-boundaries`'
 * own schema, each with the matcher its entries are fed to. Two row shapes
 * share one list of lists: a row keys on either one `sourceTag` or an
 * `allSourceTags` array, and both then take the same four optional list fields.
 */
const ROW_LIST_MATCHERS = {
  onlyDependOnLibsWithTags: tagPatternError,
  notDependOnLibsWithTags: tagPatternError,
  allowedExternalImports: globPatternError,
  bannedExternalImports: globPatternError,
};

const ROW_LIST_KEYS = Object.keys(ROW_LIST_MATCHERS);

/** @type {(value: unknown) => value is string[]} */
const isStringArray = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** @type {(value: unknown) => value is [string, string][]} */
const isTagPairArray = (value) =>
  Array.isArray(value) && value.every((pair) => isStringArray(pair) && pair.length === 2);

/** @type {(value: unknown) => value is Record<string, unknown>} */
const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * What is wrong with the entries of one string list, each message naming the
 * entry's own index so a long list points at the offender rather than at
 * itself.
 *
 * Two classes of problem, and neither would ever throw at runtime — which is
 * why they are caught here. An **empty entry** is silent: depending on the list
 * it lands in, it matches nothing (a rule that reads as enforced and is not),
 * or it matches everything (`allow: [""]`). A **pattern that will not compile**
 * throws from inside a rule, halfway through a run, with no idea which config
 * row produced it.
 *
 * @param {string[]} values
 * @param {string} at Dotted path of the list, for the message.
 * @param {((pattern: string) => string|null)|undefined} patternError
 * @returns {string[]}
 */
function listEntryViolations(values, at, patternError) {
  const violations = [];
  values.forEach((value, index) => {
    if (value === "") {
      violations.push(
        `${at}[${index}]: must not be empty — an empty pattern is never what a reader ` +
          `expects, and in 'allow' it matches every import in the workspace`,
      );
      return;
    }
    const problem = patternError?.(value);
    if (problem) violations.push(`${at}[${index}]: '${value}' ${problem}`);
  });
  return violations;
}

/** One row's problems, prefixed with its index so a report names the offender. */
function constraintRowViolations(row, index) {
  const at = `depConstraints[${index}]`;
  if (!isPlainObject(row)) return [`${at}: must be an object, got ${describe(row)}`];

  const violations = [];
  const hasSourceTag = "sourceTag" in row;
  const hasAllSourceTags = "allSourceTags" in row;
  if (hasSourceTag === hasAllSourceTags) {
    violations.push(
      `${at}: must carry exactly one of 'sourceTag' or 'allSourceTags' — ` +
        `a row with neither matches no project and silently approves everything`,
    );
  }
  if (hasSourceTag && (typeof row.sourceTag !== "string" || row.sourceTag === "")) {
    violations.push(`${at}.sourceTag: must be a non-empty string, got ${describe(row.sourceTag)}`);
  }
  if (hasAllSourceTags && (!isStringArray(row.allSourceTags) || row.allSourceTags.length < 2)) {
    violations.push(
      `${at}.allSourceTags: must be an array of at least 2 strings, got ${describe(row.allSourceTags)}`,
    );
  } else if (hasAllSourceTags) {
    // A combo row matches only projects carrying EVERY tag it names, so one
    // unusable tag makes the whole row match nothing — and a row that matches
    // nothing does not error, it approves.
    violations.push(
      ...listEntryViolations(
        /** @type {string[]} */ (row.allSourceTags),
        `${at}.allSourceTags`,
        tagPatternError,
      ),
    );
  }
  if (hasSourceTag && typeof row.sourceTag === "string" && row.sourceTag !== "") {
    const problem = tagPatternError(row.sourceTag);
    if (problem) violations.push(`${at}.sourceTag: '${row.sourceTag}' ${problem}`);
  }
  for (const key of ROW_LIST_KEYS) {
    if (!(key in row)) continue;
    if (!isStringArray(row[key])) {
      violations.push(`${at}.${key}: must be an array of strings, got ${describe(row[key])}`);
      continue;
    }
    violations.push(...listEntryViolations(row[key], `${at}.${key}`, ROW_LIST_MATCHERS[key]));
  }
  // Rejected rather than ignored: an unknown key is almost always a
  // misspelling of one above (`bannedExternalImport`), and the rule would
  // accept the row, enforce the half it understood, and drop the ban.
  for (const key of Object.keys(row)) {
    if (key === "sourceTag" || key === "allSourceTags" || ROW_LIST_KEYS.includes(key)) continue;
    violations.push(
      `${at}.${key}: not a constraint field — expected one of ` +
        `sourceTag, allSourceTags, ${ROW_LIST_KEYS.join(", ")}`,
    );
  }
  return violations;
}

/**
 * The keys a suppression entry may carry. `reason` is not optional, and that is
 * the whole point of the shape — see `suppressionRowViolations`.
 */
const SUPPRESSION_KEYS = ["path", "messageId", "reason"];

/**
 * Does this suppression cover a violation at `sourceFile` with `messageId`?
 *
 * `path` is a glob over the workspace-relative path of the importing file,
 * matched with `node:path`'s own `matchesGlob`. The stdlib, deliberately: this
 * project may import no third-party matcher (project `CLAUDE.md`), and the
 * alternative — hand-rolling an almost-minimatch — is exactly what
 * `projectPatternError` already refuses to do for `ignoredCircularDependencies`.
 * A pattern it cannot parse returns false rather than throwing, which for a
 * suppression fails toward reporting.
 *
 * `posix` and not the platform default: every path in an analysis record is
 * workspace-relative and `/`-separated (`analysis/contract.md`), so there is no
 * platform to detect and a Windows run must not read `\` as an escape.
 *
 * An entry with no `messageId` covers every violation type at that path. That
 * is the broader form on purpose: the files this exists for are config files a
 * loader cannot resolve aliases in, and which message their one import draws is
 * a detail of the spelling rather than of the decision.
 *
 * @param {{path: string, messageId?: string}} suppression
 * @param {{sourceFile: string, messageId: string}} violation
 * @returns {boolean}
 */
export function suppressionCovers(suppression, violation) {
  if (suppression.messageId !== undefined && suppression.messageId !== violation.messageId) {
    return false;
  }
  return posix.matchesGlob(violation.sourceFile, suppression.path);
}

/**
 * One suppression entry's problems, prefixed with its index.
 *
 * **A missing `reason` is rejected, and that check is why this validator
 * exists.** A suppression is a violation someone decided to accept; with the
 * decision unwritten, what is left is a hole that reads as "clean" to every
 * later reader — the state this whole tool was built to end. Defaulting the
 * field to `""` would make it decorative, and a decorative field is one nobody
 * fills in.
 *
 * `messageId` is checked against the fifteen ids the rules layer can produce,
 * read from `messages.mjs` rather than listed here: a typo'd id suppresses
 * nothing, which is the safe direction, but it also reads as a decision that
 * has been taken when it has not.
 */
function suppressionRowViolations(row, index) {
  const at = `boundarySuppressions[${index}]`;
  if (!isPlainObject(row)) return [`${at}: must be an object, got ${describe(row)}`];

  const violations = [];
  if (typeof row.path !== "string" || row.path === "") {
    violations.push(
      `${at}.path: must be a non-empty glob over the workspace-relative path of the ` +
        `importing file, got ${describe(row.path)}`,
    );
  }
  if (typeof row.reason !== "string" || row.reason.trim() === "") {
    violations.push(
      `${at}.reason: must be a non-empty string — a suppression is a violation someone ` +
        `decided to accept, and one with no reason written down is indistinguishable from ` +
        `a boundary that quietly stopped being enforced`,
    );
  }
  if ("messageId" in row && !MESSAGE_IDS.includes(/** @type {string} */ (row.messageId))) {
    violations.push(
      `${at}.messageId: ${describe(row.messageId)} is not a violation type this engine ` +
        `reports — expected one of ${MESSAGE_IDS.join(", ")}`,
    );
  }
  for (const key of Object.keys(row)) {
    if (SUPPRESSION_KEYS.includes(key)) continue;
    violations.push(
      `${at}.${key}: not a suppression field — expected one of ${SUPPRESSION_KEYS.join(", ")}`,
    );
  }
  return violations;
}

/** A value's type, for an error message that shows what was actually there. */
function describe(value) {
  if (Array.isArray(value)) return `an array (${JSON.stringify(value)})`;
  if (value === null) return "null";
  return `${typeof value} (${JSON.stringify(value) ?? String(value)})`;
}

/**
 * Everything wrong with a loaded boundary config, as messages; empty when it
 * is well-formed. Pure, so a test drives it without a file on disk.
 *
 * @param {unknown} module The config module's exports.
 * @returns {string[]}
 */
export function findBoundaryConfigViolations(module) {
  if (!isPlainObject(module)) return [`config: expected a module object, got ${describe(module)}`];

  const violations = [];
  const { depConstraints, moduleBoundaryOptions, boundarySuppressions } = module;

  // Absent means "nothing is suppressed", which is the only default that fails
  // toward reporting — unlike the eight options above, where a missing value
  // would be a second copy of something ESLint also reads and this module has
  // no business guessing. A suppression has no second reader: ESLint uses its
  // own directives, so there is nothing here to disagree with.
  if (boundarySuppressions !== undefined) {
    if (!Array.isArray(boundarySuppressions)) {
      violations.push(
        `boundarySuppressions: must be an exported array when present, got ` +
          `${describe(boundarySuppressions)}`,
      );
    } else {
      boundarySuppressions.forEach((row, index) =>
        violations.push(...suppressionRowViolations(row, index)),
      );
    }
  }

  if (!Array.isArray(depConstraints)) {
    violations.push(
      `depConstraints: must be an exported array, got ${describe(depConstraints)} — ` +
        `this is the constraint table both enforcers read`,
    );
  } else {
    depConstraints.forEach((row, index) => violations.push(...constraintRowViolations(row, index)));
  }

  if (!isPlainObject(moduleBoundaryOptions)) {
    violations.push(
      `moduleBoundaryOptions: must be an exported object, got ${describe(moduleBoundaryOptions)}`,
    );
    return violations;
  }
  for (const [key, type] of Object.entries(OPTION_TYPES)) {
    if (!(key in moduleBoundaryOptions)) {
      // Missing is rejected rather than defaulted. A default here would be a
      // second copy of a value the config file already states, and the two
      // would answer differently the day one of them changed.
      violations.push(`moduleBoundaryOptions.${key}: missing — every option is stated explicitly`);
      continue;
    }
    const value = moduleBoundaryOptions[key];
    const ok =
      type === "boolean"
        ? typeof value === "boolean"
        : type === "string[]"
          ? isStringArray(value)
          : isTagPairArray(value);
    if (!ok) {
      violations.push(`moduleBoundaryOptions.${key}: must be ${type}, got ${describe(value)}`);
      continue;
    }
    const at = `moduleBoundaryOptions.${key}`;
    if (type === "string[]") {
      violations.push(
        ...listEntryViolations(/** @type {string[]} */ (value), at, OPTION_ENTRY_MATCHERS[key]),
      );
    } else if (type === "pair[]") {
      /** @type {[string, string][]} */ (value).forEach((pair, index) =>
        violations.push(
          ...listEntryViolations(pair, `${at}[${index}]`, OPTION_ENTRY_MATCHERS[key]),
        ),
      );
    }
  }
  for (const key of Object.keys(moduleBoundaryOptions)) {
    if (!(key in OPTION_TYPES)) {
      violations.push(
        `moduleBoundaryOptions.${key}: not an option of @nx/enforce-module-boundaries — ` +
          `expected one of ${Object.keys(OPTION_TYPES).join(", ")}`,
      );
    }
  }
  return violations;
}

/**
 * Loads and validates one boundary config, named by its own absolute path.
 *
 * The path-taking form exists because the config's location and the tree being
 * judged are two facts, not one. They coincide in this repository and come
 * apart wherever a workspace keeps its law somewhere else, and a run may need
 * to say so explicitly — `cli.mjs --config` is that seam. `loadBoundaryConfig`
 * below is the common case expressed in terms of this one, so both forms answer
 * through the same validation and neither can drift into a second opinion about
 * a malformed row.
 *
 * @param {string} path Absolute path of the config file.
 * @returns {Promise<{ depConstraints: object[], options: object, suppressions: object[] }>}
 *   `suppressions` is `[]` when the config declares none.
 * @throws {Error} when the file is missing, unloadable, or malformed. Loud on
 *   purpose: an enforcer that starts with no rules enforces nothing and says
 *   nothing, which is the failure this whole tool exists to end.
 */
export async function loadBoundaryConfigFile(path) {
  let module;
  try {
    module = await import(pathToFileURL(path).href);
  } catch (cause) {
    throw new Error(`lattice: cannot load ${path}: ${cause?.message ?? cause}`, {
      cause,
    });
  }
  const violations = findBoundaryConfigViolations(module);
  if (violations.length > 0) {
    throw new Error(`lattice: ${path} is malformed:\n  ${violations.join("\n  ")}`);
  }
  return {
    depConstraints: module.depConstraints,
    options: module.moduleBoundaryOptions,
    suppressions: module.boundarySuppressions ?? [],
  };
}

/**
 * Loads and validates the boundary config a workspace root implies.
 *
 * @param {string} workspaceRoot Absolute path of the workspace root — the tree
 *   being judged, which is not this module's own tree once the package is
 *   installed into a consumer's `node_modules`.
 * @param {string} boundaryConfig The config's filename in THIS workspace,
 *   resolved by the caller from the plugin's options (`./options.mjs`). Required
 *   rather than defaulted here, so no code path can read a filename this module
 *   guessed while the workspace uses another one — the failure that would follow
 *   is "cannot load", which reads like a missing config rather than a
 *   misconfigured tool.
 * @returns {Promise<{ depConstraints: object[], options: object, suppressions: object[] }>}
 * @throws {Error} as `loadBoundaryConfigFile`.
 */
export async function loadBoundaryConfig(workspaceRoot, boundaryConfig) {
  return loadBoundaryConfigFile(`${workspaceRoot.replace(/\/$/, "")}/${boundaryConfig}`);
}
