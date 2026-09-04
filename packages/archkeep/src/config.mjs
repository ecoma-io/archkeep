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
 *
 * `customRules` is the second such shape, and the fifth top-level law: each row
 * DECLARES a rule this engine did not write — the artifact carrying it, the
 * hash pinning that artifact's bytes, the parameters it is judged under, and
 * the reason it exists (`../../../docs/adr/0002-custom-rules-one-contract.md`
 * records the decision, "Declared in the policy, never discovered"). What is
 * checked here is the DECLARATION and nothing else: this module never reads the
 * artifact, hashes it, or runs it — it is handed a policy rather than a tree,
 * and a loader that reached the filesystem for a row's bytes would be asking a
 * question its callers (the Nx hook, the language server, an inline
 * `archkeep.json` object) are not all in a position to answer. What it does
 * refuse is a declaration that could never name a real rule: a name two rows
 * share, a `sha256` no digest can equal, an `artifact` that leaves the
 * workspace, `params` that cannot survive serialization into a rule's
 * evidence — see `customRuleRowViolations`.
 *
 * ## Three dialects, one validator, one dispatch
 *
 * `boundaryConfig` may name a `.mjs`/`.js` module (`import()`ed, as above and
 * always), a `.json` file (`JSON.parse`d — never JSONC, never `import()`ed, so
 * a `.json` boundary law carries no more parser leniency than the language it
 * is written in promises), or an ESLint flat config (`./eslint-config.mjs`
 * reads the workspace's own `@nx/enforce-module-boundaries` rule entry off
 * it, rather than a second, hand-kept copy of the same table —
 * `docs/concepts/policies.md` is the dialect reference for what that reader
 * can and cannot see). `loadBoundaryConfigFile` is the one place that
 * dispatches between them, on **basename first, extension second**: a name
 * matching `eslint.config.*` (`ESLINT_FLAT_CONFIG_BASENAME`) always reaches
 * the ESLint dialect and a legacy `.eslintrc*` name
 * (`LEGACY_ESLINTRC_BASENAME`) is always refused by name, before either one's
 * extension — `.mjs`, `.js`, or none at all for a bare `.eslintrc` — ever
 * reaches the extension dispatch below. Basename has to run first: both
 * shapes are `.mjs`/`.js`-extensioned far more often than not, and reaching
 * the module dialect's bare `import()` first would either half-work (a
 * flat-config array is a valid ES module, so it would "load" and then fail on
 * `findBoundaryConfigViolations` with a message that never mentions ESLint)
 * or, for a `.eslintrc.json`, land in the `.json` dialect's
 * unrecognised-top-level-key refusal — neither reads as what actually went
 * wrong: this is an ESLint config, of the wrong dialect or shape, not a
 * malformed archkeep policy file. Only once both basenames are ruled out does
 * the extension decide between the `.mjs`/`.js` module dialect and the
 * `.json` file dialect.
 *
 * All three dialects hand their parsed data to the same
 * `findBoundaryConfigViolations` above (through the shared `policyFrom` tail
 * — see there), so a constraint row is validated identically regardless of
 * which file held it — the alternative is a second copy of these rules that
 * drifts from this one the first time any of them changes.
 *
 * The `.mjs`/`.js` and `.json` dialects share the same top-level key law: a
 * top-level export (or key) beyond `depConstraints`, `moduleBoundaryOptions`,
 * `boundarySuppressions`, `fitness`, `customRules` and `coverage` is rejected
 * by name. The
 * `.mjs` dialect's tolerance for a helper export used to let a misspelled key
 * (`moduleBoundaryOptions` → `moduleBoundaryOption`) disappear into silence —
 * a typo'd law is a law that is not enforced, the exact silent direction this
 * file exists to end — so it now carries the same refusal as the `.json`
 * dialect, through the same `policyKeyViolations`. One carve-out remains, for
 * the `.json` dialect only: `$schema`, which editors write into a JSON file
 * unasked for IDE validation and which states no rule of its own (accepted
 * and checked there and in a native workspace's inline policy; an ES module
 * has no editor-validation hook to point it at). The ESLint dialect has no
 * `boundarySuppressions` counterpart at all — ESLint has its own
 * `eslint-disable` convention for that, with no equivalent this reader can
 * read back — so it always reports an empty suppression list, and it has no
 * home for a `customRules` declaration either: a flat config's one rule entry
 * is a constraint table and its options, with nowhere to name a rule artifact,
 * so a policy read through that dialect carries NO `customRules` key rather
 * than an empty one — absent is the workspace's own statement, where an empty
 * list would read as "custom rules are configured here, and there are none".
 * See `loadBoundaryConfigFile`'s ESLint branch.
 */
import { basename, extname, posix, resolve } from "node:path";
import { existsSync } from "node:fs";
import { readFile as readFileFromDisk } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { containmentViolation, pathEscapes } from "./containment.mjs";

import { loadEslintBoundaryConfig } from "./eslint-config.mjs";
import { describe, isPlainObject, isStringArray } from "./values.mjs";
import { findFitnessViolations } from "./governance/fitness-registry.mjs";
import { declaredFitnessNames, stripRuleFitnessPrefix } from "./governance/adr-registry.mjs";
import { GOVERNANCE_ROW_KEYS, rowSchemaViolations } from "./governance/row-schema.mjs";
import {
  GLOB_METACHARACTERS,
  globComplexityError,
  globPatternError,
  importPatternError,
  projectPatternError,
  safeMatchesGlob,
  tagPatternError,
} from "./rules/match.mjs";
import { MESSAGE_IDS } from "./rules/messages.mjs";

/**
 * The basename that selects the ESLint flat-config dialect
 * (`./eslint-config.mjs`) — an explicit opt-in, matched on basename rather
 * than extension so `eslint.config.mjs`, `.cjs`, `.js`, `.ts`, `.mts` and
 * `.cts` all reach the dispatch below. The DISPATCH matches all of them;
 * whether importing one of the TypeScript-extension spellings then actually
 * loads is a separate question this dispatch has no opinion on — it is the
 * runtime's own TS support that decides, and it disagrees across the
 * versions this package supports: Node 24 strips types before running the
 * file, Node 20 and 22 error on the `import()` before this module ever sees
 * it (`.node-version` pins the version CI itself runs). Nothing shorter than
 * this literal prefix is accepted: a workspace's own boundary law living in a
 * file that merely CONTAINS "eslint" somewhere in its name must not be
 * silently routed through a reader built for a different shape. Exported so
 * `src/lsp/boundary-config.mjs` can refuse the same basenames by name rather
 * than repeating the two patterns — `AGENTS.md`'s "never state a rule twice".
 */
export const ESLINT_FLAT_CONFIG_BASENAME = /^eslint\.config\./u;

/**
 * A legacy (pre-flat-config) ESLint config basename. `@nx/enforce-module-boundaries`
 * itself requires ESLint 9's flat config, so a `boundaryConfig` naming one of
 * these can never have meant "read my ESLint rule entry" — it is refused by
 * name, immediately, rather than falling through to the `.mjs`-module dialect
 * and failing on an unrelated "not a module object" a reader would have no way
 * to connect back to "this is an ESLint config, and the wrong kind of one".
 * Exported for the same reuse reason as `ESLINT_FLAT_CONFIG_BASENAME` above.
 */
export const LEGACY_ESLINTRC_BASENAME = /^\.eslintrc(\.|$)/u;

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
 * `buildTargets` carries a matcher even though its entries are target names,
 * compared with `===` (see `OPTION_ENTRY_MATCHERS`): a NAME is exact by
 * definition, so an entry containing glob syntax can never match a target
 * declared in any graph — it is refused at load rather than silently
 * selecting nothing. It still gets the empty-string check every list gets.
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
  // A target NAME is matched with `===` against a project's declared targets
  // (`../rules/topology.mjs`'s `hasBuildExecutor`), so an entry carrying glob
  // syntax can never match anything — Nx users conventionally write target
  // patterns (`"build:*"`), and this engine reproduces no target patterns, so
  // the entry is refused by name rather than silently selecting no project.
  buildTargets: targetPatternError,
};

/**
 * The keys a constraint row may carry, per `@nx/enforce-module-boundaries`'
 * own schema, each with the matcher its entries are fed to. Two row shapes
 * share one list of lists: a row keys on either one `sourceTag` or an
 * `allSourceTags` array, and both then take the same four optional list fields.
 */
/**
 * Why a `buildTargets` entry cannot name a target in this engine, or `null`.
 *
 * `hasBuildExecutor` compares entries to a project's declared target names
 * with `===` — the same exact lookup upstream uses — so an entry containing
 * glob syntax (`"build:*"`, `"*"`) can never match any target, and a workspace
 * that wrote one believes `enforceBuildableLibDependency` is live when no
 * project can possibly be selected.
 *
 * @param {string} entry
 * @returns {string|null}
 */
function targetPatternError(entry) {
  if (GLOB_METACHARACTERS.test(entry)) {
    return (
      `is a glob, but buildTargets entries are compared with === against a project's declared ` +
      `target names — this entry can never match any target. Name targets exactly, or omit this ` +
      `entry (buildTargets defaults to ['build'])`
    );
  }
  return null;
}

const ROW_LIST_MATCHERS = {
  onlyDependOnLibsWithTags: tagPatternError,
  notDependOnLibsWithTags: tagPatternError,
  allowedExternalImports: globPatternError,
  bannedExternalImports: globPatternError,
};

const ROW_LIST_KEYS = Object.keys(ROW_LIST_MATCHERS);

/** @type {(value: unknown) => value is [string, string][]} */
const isTagPairArray = (value) =>
  Array.isArray(value) && value.every((pair) => isStringArray(pair) && pair.length === 2);

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
function constraintRowViolations(row, index, io) {
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
  // Optional informational fields — they do not change evaluation, but they
  // give a constraint row a name and a remediation hint that reports and
  // explanations can surface. An unnamed constraint still enforces; a named
  // one is easier to act on.
  if ("description" in row) {
    if (typeof row.description !== "string" || row.description === "") {
      violations.push(
        `${at}.description: must be a non-empty string when present, got ${describe(row.description)}`,
      );
    }
  }
  if ("remediation" in row) {
    if (typeof row.remediation !== "string" || row.remediation === "") {
      violations.push(
        `${at}.remediation: must be a non-empty string when present, got ${describe(row.remediation)}`,
      );
    }
  }
  // The governance block (Contract 2): origin/rationale/decisionRef/
  // fitnessBindings, validated by the ONE shared schema (`./governance/row-schema.mjs`)
  // so a constraint row and an intent row are checked identically across the
  // wave — never a second copy of what a governance key may hold. Additive: a
  // row without the block is a legacy row and stays valid byte-identical.
  // Resolution of a decisionRef/fitnessBinding id is the registry capability's
  // (`./governance/row-schema.mjs`); shape is validated here, loudly.
  if ("origin" in row || "rationale" in row || "decisionRef" in row || "fitnessBindings" in row) {
    violations.push(...rowSchemaViolations(row, at, io));
  }
  // Rejected rather than ignored: an unknown key is almost always a
  // misspelling of one above (`bannedExternalImport`), and the rule would
  // accept the row, enforce the half it understood, and drop the ban.
  const ROW_SCALAR_KEYS = ["description", "remediation"];
  for (const key of Object.keys(row)) {
    if (
      key === "sourceTag" ||
      key === "allSourceTags" ||
      ROW_LIST_KEYS.includes(key) ||
      ROW_SCALAR_KEYS.includes(key) ||
      GOVERNANCE_ROW_KEYS.includes(key)
    )
      continue;
    violations.push(
      `${at}.${key}: not a constraint field — expected one of ` +
        `sourceTag, allSourceTags, ${ROW_LIST_KEYS.join(", ")}, ${ROW_SCALAR_KEYS.join(", ")}, ` +
        GOVERNANCE_ROW_KEYS.join(", "),
    );
  }
  return violations;
}

/**
 * The keys a suppression entry may carry. `reason` is not optional, and that is
 * the whole point of the shape — see `suppressionRowViolations`. A row that
 * also carries `expiresAt` is a WAIVER (temporary acceptance) rather than a
 * suppression (permanent one): both validate through this same shape, and the
 * waiver semantics live in `./governance/waiver.mjs`.
 */
const SUPPRESSION_KEYS = ["path", "messageId", "reason", "expiresAt", "origin"];

/**
 * Does this suppression cover a violation at `sourceFile` with `messageId`?
 *
 * `path` is a glob over the workspace-relative path of the importing file,
 * matched with `node:path`'s own `matchesGlob`, through `./rules/match.mjs`'s
 * `safeMatchesGlob` — the stdlib, deliberately: this project may import no
 * third-party matcher (project `AGENTS.md`), and the alternative —
 * hand-rolling an almost-minimatch — is exactly what `projectPatternError`
 * already refuses to do for `ignoredCircularDependencies`. A pattern it
 * cannot parse returns false rather than throwing, which for a suppression
 * fails toward reporting; a pattern whose brace groups expand combinatorially
 * throws instead, guarded by `safeMatchesGlob` — `suppressionRowViolations`
 * below refuses the same pattern at config load, so this throw is a backstop
 * for a suppression that reached matching without going through it, not the
 * primary defence.
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
  return safeMatchesGlob(violation.sourceFile, suppression.path);
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
/**
 * @param {object} row
 * @param {number} index
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
  } else {
    const problem = globComplexityError(row.path);
    if (problem) violations.push(`${at}.path: '${row.path}' ${problem}`);
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
  if ("expiresAt" in row) {
    // A waiver's term. Must be a full ISO-8601 instant carrying an explicit
    // UTC or offset designator — the shape `Date.prototype.toISOString()`
    // itself produces, and the one spellings like `"2026-09-01"` or `"0"`
    // (`Date.parse`'s epoch) or `"2026-09-01 03:00"` deliberately do not
    // match. Those parse, but ambiguity is the bug: a date-only or TZ-less
    // string is interpreted in the machine's local zone, so the same law
    // yields a different term — and a different expiry verdict — under two
    // machines' `TZ`. A waiver whose term means different things to different
    // machines is not a term; an instant-bearing spelling means the same
    // instant everywhere.
    const expiryMatches = typeof row.expiresAt === "string" ? row.expiresAt : null;
    const expiryMatch = expiryMatches
      ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(
          expiryMatches,
        )
      : null;
    const expiry = expiryMatch ? Date.parse(expiryMatches) : NaN;
    // A calendar-impossible instant like `2026-02-30` passes the shape regex
    // AND `Date.parse`, which silently normalises it to a different calendar
    // day (`2026-03-02`) — a term that quietly extends acceptance past what
    // its author wrote, the one direction this repository treats as poison.
    // The written calendar fields are checked against the same fields of the
    // instant they claim, independent of the string's timezone: `Date.UTC`
    // normalises the impossible and the round-trip no longer matches.
    // The capture groups destructure as `unknown` under tsc's strict JSDoc
    // checking (the regex `.exec` return type does not name them), so each is
    // coerced here — the calendar comparison wants numbers anyway.
    const [, ...captures] = expiryMatch ?? [];
    const [y, mo, d, h, mi, s] = captures.map(Number);
    const normalized =
      expiryMatch && !Number.isNaN(expiry) ? new Date(Date.UTC(y, mo - 1, d, h, mi, s)) : null;
    const impossibleCalendar =
      normalized !== null &&
      (normalized.getUTCFullYear() !== y ||
        normalized.getUTCMonth() !== mo - 1 ||
        normalized.getUTCDate() !== d ||
        normalized.getUTCHours() !== h ||
        normalized.getUTCMinutes() !== mi ||
        normalized.getUTCSeconds() !== s);
    if (!expiryMatch || Number.isNaN(expiry) || impossibleCalendar) {
      violations.push(
        `${at}.expiresAt: must be a full ISO-8601 instant with an explicit UTC/offset, ` +
          `like "2026-09-01T00:00:00.000Z", got ${describe(row.expiresAt)} — a term with no ` +
          `designator is interpreted in the machine's local zone, so the same waiver would mean ` +
          `different things under different TZ environments${
            impossibleCalendar
              ? `; a calendar date this calendar does not contain (like ${`${y}-${mo}-${d}`}) would be ` +
                `silently shifted to another day by the parser, extending the waiver past what was written`
              : ""
          }`,
      );
    }
  }
  if ("origin" in row && (typeof row.origin !== "string" || row.origin.trim() === "")) {
    violations.push(
      `${at}.origin: must be a non-empty string naming where the waiver came from, got ` +
        `${describe(row.origin)}`,
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

/**
 * The keys a `coverage.unowned` row may carry. `reason` is not optional, for
 * the same reason it is not optional on a suppression row above and on a
 * native `coverage.exempt` row (`./providers/native/model.mjs`'s
 * `exemptRowViolations`, whose semantics this row copies exactly): an
 * accepted coverage hole with no reason written down is indistinguishable
 * from coverage that quietly stopped being enforced.
 */
const COVERAGE_UNOWNED_KEYS = ["path", "reason"];

/**
 * One `coverage.unowned` row's problems, prefixed with its index.
 *
 * @param {unknown} row
 * @param {number} index
 * @returns {string[]}
 */
function coverageUnownedRowViolations(row, index) {
  const at = `coverage.unowned[${index}]`;
  if (!isPlainObject(row)) return [`${at}: must be an object, got ${describe(row)}`];

  const violations = [];
  if (typeof row.path !== "string" || row.path === "") {
    violations.push(
      `${at}.path: must be a non-empty glob over a workspace-relative path, matched with ` +
        `\`path.posix.matchesGlob\`, got ${describe(row.path)}`,
    );
  } else {
    const problem = globComplexityError(row.path);
    if (problem) violations.push(`${at}.path: '${row.path}' ${problem}`);
  }
  if (typeof row.reason !== "string" || row.reason.trim() === "") {
    violations.push(
      `${at}.reason: must be a non-empty string — an accepted coverage hole with no reason ` +
        `written down reads as coverage that is still enforced`,
    );
  }
  for (const key of Object.keys(row)) {
    if (!COVERAGE_UNOWNED_KEYS.includes(key)) {
      violations.push(
        `${at}.${key}: not a coverage.unowned field — expected one of ` +
          COVERAGE_UNOWNED_KEYS.join(", "),
      );
    }
  }
  return violations;
}

/**
 * Everything wrong with a policy's `coverage` key, as messages; empty when it
 * is well-formed.
 *
 * The key holds exactly one field: `unowned`, an array of `{path, reason}`
 * rows — a recorded acceptance of tracked files no project owns, for the Nx
 * and Moon providers whose project model has no channel of its own for that
 * decision (`../../../docs/reference/policy-schema.md`, "`coverage`"). A row
 * is matched ONLY against files already decided to be unowned, so even a `**`
 * row can never silence a verdict about an owned file — the same guarantee
 * the native provider's `coverage.exempt` states
 * (`./providers/native/coverage.mjs`). An empty `unowned` list is accepted
 * for the reason an empty suppression list is: it accepts nothing, which is
 * the direction that cannot hide anything.
 *
 * @param {unknown} value The parsed `coverage` value.
 * @returns {string[]}
 */
function findCoverageViolations(value) {
  if (!isPlainObject(value)) {
    return [`coverage: must be an object carrying an 'unowned' array, got ${describe(value)}`];
  }
  const violations = [];
  if (!Array.isArray(value.unowned)) {
    violations.push(
      `coverage.unowned: must be an array of {path, reason} rows, got ${describe(value.unowned)}`,
    );
  } else {
    value.unowned.forEach((row, index) =>
      violations.push(...coverageUnownedRowViolations(row, index)),
    );
  }
  for (const key of Object.keys(value)) {
    if (key !== "unowned") {
      violations.push(`coverage.${key}: not a coverage field — expected 'unowned'`);
    }
  }
  return violations;
}

/**
 * The grammar a custom rule's `name` is written in: lowercase letters and
 * digits, single `-` separators, nothing else.
 *
 * A name is a SELECTOR rather than a label — it is what a row is identified by,
 * and what the duplicate check below compares — so two names a human reads as
 * identical must never be able to exist as two different strings. That is the
 * same reason `./governance/profile-registry.mjs` gives for restricting a
 * profile name, one axis narrower: no uppercase either, so a policy cannot
 * carry both `no-cycles` and `No-Cycles` and leave a reader to work out which
 * of them a message is about.
 *
 * Exported because it is the grammar of a NAME rather than of this file's row
 * shape: anything that has to spell or check one answers from here rather than
 * from a second copy of the pattern (`../../../AGENTS.md`, "Never state a rule
 * twice").
 */
export const CUSTOM_RULE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * A `sha256`, as `node:crypto`'s own `digest("hex")` spells it: 64 lowercase
 * hex characters. Uppercase is refused rather than folded, because the hash is
 * compared to a digest string and a comparison that lowercased one side would
 * be a second opinion about what the declared bytes are; refusing at load names
 * the spelling, where a mismatch later would only name the bytes.
 */
const CUSTOM_RULE_SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/** The keys a custom-rule row may carry, beside the governance block. */
const CUSTOM_RULE_KEYS = ["name", "artifact", "sha256", "params", "reason"];

/**
 * An absolute path in either family — a leading separator, or a Windows drive
 * (`C:\rules\x.wasm`, `C:rules\x.wasm`). Tested against the raw spelling rather
 * than through `node:path`'s `isAbsolute`, which answers about the platform the
 * check happens to run on: a policy is committed once and read on every
 * machine, so a `C:`-rooted artifact has to be refused by a POSIX CI runner
 * too, not silently read as a relative directory named `C:`.
 */
const ABSOLUTE_ARTIFACT_PATH = /^(?:[\\/]|[A-Za-z]:)/u;

/**
 * The root the containment question is asked against, LEXICALLY. A row names a
 * workspace-relative path and this validator never sees a workspace root — the
 * loaders it runs behind are handed a policy, not a tree, and the inline
 * dialect has no file of its own to be relative to. So the half that can be
 * answered from the string is answered here: does the path leave the directory
 * it is relative to? `./containment.mjs`'s `pathEscapes` is asked rather than
 * reimplemented, so there is one answer to "this path leaves the tree". The
 * other half — a symlink that resolves out of the workspace — needs a real root
 * and a real filesystem, and belongs to whatever reads the artifact's bytes;
 * what this closes is a declared `../../etc/rule.wasm` failing at load instead
 * of at read.
 */
const NOMINAL_WORKSPACE_ROOT = "/archkeep-workspace";

/**
 * Why `artifact` cannot name a file inside the workspace, or `null`.
 *
 * @param {string} artifact The declared, workspace-relative path.
 * @returns {string|null}
 */
function artifactPathProblem(artifact) {
  if (ABSOLUTE_ARTIFACT_PATH.test(artifact)) {
    return (
      `is absolute — an artifact is named relative to the workspace root, so the same policy ` +
      `resolves to the same bytes on every machine that reads it`
    );
  }
  // Separators are normalised to `/` before the question is asked: a `..\`
  // written on Windows escapes exactly as far as a `../` does, and POSIX's
  // `normalize` would otherwise read the whole `..\rules` as one filename.
  const resolved = posix.normalize(
    `${NOMINAL_WORKSPACE_ROOT}/${artifact.split(/[\\/]/u).join("/")}`,
  );
  if (pathEscapes(NOMINAL_WORKSPACE_ROOT, resolved)) {
    return (
      `leaves the workspace — a custom rule's artifact is a file inside the tree its policy ` +
      `governs, so that a reviewer reads the same bytes CI runs`
    );
  }
  return null;
}

/**
 * Whether `value` is an object JSON carries as itself: a plain one, or a
 * null-prototype one (`JSON.parse` builds those for a `__proto__` key). An
 * array, a `Map`, a `Set`, a `RegExp`, a `Date` and a class instance all answer
 * `false` — they carry a prototype of their own, and `isPlainObject` above
 * accepts most of them, which is right for the config shapes it guards and
 * wrong here, where the question is what survives serialization rather than
 * what has properties.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isJsonObject(value) {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Where `params` holds a value JSON cannot carry, or `null`.
 *
 * `params` is handed to the rule as serialized evidence, so a value with no
 * JSON form does not fail loudly there — it DISAPPEARS. `JSON.stringify` drops
 * a function, a symbol and an `undefined` from an object outright, renders
 * `NaN`/`Infinity` as `null`, flattens a `Map` or a `Set` to `{}`, and turns a
 * `Date` into a string; a rule would then be judged under parameters nobody
 * wrote, which is this repository's poison direction. A cycle is the one shape
 * that throws instead, and it throws from wherever the serialization happens
 * rather than naming the row — so it is caught here too, by name.
 *
 * The offending value is named by KIND rather than through `describe`: a `Map`
 * renders as `object ({})` there — precisely the thing it serializes to, which
 * is what makes it silent — and a `BigInt` cannot be rendered at all, because
 * `describe`'s own `JSON.stringify` throws on one.
 *
 * @param {unknown} value
 * @param {string} at Dotted path of the value, for the message.
 * @param {Set<unknown>} seen Objects on the current path, for the cycle check.
 * @returns {string|null}
 */
function unserializableParam(value, at, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? null
      : `${at}: must be a finite number — ${String(value)} serializes as null, so the rule ` +
          `would be judged under a parameter nobody wrote`;
  }
  if (Array.isArray(value) || isJsonObject(value)) {
    if (seen.has(value)) {
      return `${at}: refers back to a value that contains it — a parameter table with a cycle has no serialization at all`;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        const problem = unserializableParam(item, `${at}[${index}]`, seen);
        if (problem) return problem;
      }
    } else {
      for (const [key, item] of Object.entries(value)) {
        const problem = unserializableParam(item, `${at}.${key}`, seen);
        if (problem) return problem;
      }
    }
    seen.delete(value);
    return null;
  }
  const kind = typeof value === "object" ? (value.constructor?.name ?? "object") : typeof value;
  return (
    `${at}: must be JSON data, got ${kind} — a value with no JSON form of its own is dropped or ` +
    `rewritten on the way into a rule's evidence rather than refused there, so the rule would ` +
    `run under parameters that differ from the ones written here`
  );
}

/**
 * One custom-rule row's problems, prefixed with its index so a report names the
 * offender.
 *
 * Every field is checked in the loud direction — the row DECLARES law this
 * engine did not write, so a field that cannot be read is a rule that cannot be
 * loaded, never a rule quietly skipped. `reason` is mandatory for the reason it
 * is mandatory on a suppression and a fitness row (`suppressionRowViolations`):
 * a rule nobody wrote a reason for is indistinguishable from a rule nobody
 * would defend.
 *
 * @param {unknown} row
 * @param {number} index
 * @param {Set<string>} names The names earlier rows already claimed — a name is
 *   a selector, so two rows sharing one make every report about that rule
 *   ambiguous.
 * @param {{resolve?: (key: "decisionRef"|"fitnessBindings", id: string) => boolean}} io
 *   Passed through to the shared governance schema, exactly as a constraint row
 *   passes it.
 * @returns {string[]}
 */
function customRuleRowViolations(row, index, names, io) {
  const at = `customRules[${index}]`;
  if (!isPlainObject(row)) return [`${at}: must be an object, got ${describe(row)}`];

  const violations = [];
  if (typeof row.name !== "string" || !CUSTOM_RULE_NAME_PATTERN.test(row.name)) {
    violations.push(
      `${at}.name: must be a non-empty name of lowercase letters and digits joined by single ` +
        `"-" separators (like "no-interface-outside-domain"), got ${describe(row.name)}`,
    );
  } else if (names.has(row.name)) {
    violations.push(
      `${at}.name: "${row.name}" is declared more than once — every custom rule name must be ` +
        `unique, because a finding names the rule that reported it`,
    );
  } else {
    names.add(row.name);
  }

  if (typeof row.artifact !== "string" || row.artifact === "") {
    violations.push(
      `${at}.artifact: must be a non-empty workspace-relative path to the rule's artifact, got ` +
        `${describe(row.artifact)}`,
    );
  } else {
    const problem = artifactPathProblem(row.artifact);
    if (problem) violations.push(`${at}.artifact: '${row.artifact}' ${problem}`);
  }

  if (typeof row.sha256 !== "string" || !CUSTOM_RULE_SHA256_PATTERN.test(row.sha256)) {
    violations.push(
      `${at}.sha256: must be 64 lowercase hex characters — the hash of the artifact's own bytes, ` +
        `which is what makes the law CI ran and the law a reviewer read the same law, got ` +
        `${describe(row.sha256)}`,
    );
  }

  if ("params" in row) {
    if (!isPlainObject(row.params)) {
      violations.push(
        `${at}.params: must be an object of JSON data when present, got ${describe(row.params)}`,
      );
    } else {
      const problem = unserializableParam(row.params, `${at}.params`, new Set());
      if (problem) violations.push(problem);
    }
  }

  if (typeof row.reason !== "string" || row.reason.trim() === "") {
    violations.push(
      `${at}.reason: must be a non-empty string — a custom rule is a policy decision, and one ` +
        `with no reason written down is indistinguishable from a rule nobody would defend`,
    );
  }

  // The governance block (Contract 2), through the ONE shared schema every
  // other row family asks (`./governance/row-schema.mjs`) — including the
  // resolution half, so a `fitnessBindings` entry naming no declared fitness
  // rule fails here exactly as it does on a constraint row.
  if ("origin" in row || "rationale" in row || "decisionRef" in row || "fitnessBindings" in row) {
    violations.push(...rowSchemaViolations(row, at, io));
  }

  // Rejected rather than ignored, for the reason a constraint row's unknown key
  // is: a misspelt `param`/`sha`/`artefact` would load, carry the half this
  // reader understood, and drop the rest of the declaration.
  for (const key of Object.keys(row)) {
    if (CUSTOM_RULE_KEYS.includes(key) || GOVERNANCE_ROW_KEYS.includes(key)) continue;
    violations.push(
      `${at}.${key}: not a custom-rule field — expected one of ${CUSTOM_RULE_KEYS.join(", ")}, ` +
        `plus the governance block keys ${GOVERNANCE_ROW_KEYS.join(", ")}`,
    );
  }
  return violations;
}

/**
 * Everything wrong with a `customRules` list, as messages; empty when it is
 * well-formed.
 *
 * An ABSENT list means "this workspace declares no custom rules", the same
 * decision an absent `boundarySuppressions` states. A list that is PRESENT and
 * empty is refused, the same way `findFitnessViolations`
 * (`./governance/fitness-registry.mjs`) refuses an empty `fitness`: both keys
 * declare law, and a law list present but empty reads as governed while judging
 * nothing. The difference from a suppression list — where `[]` is accepted — is
 * that an empty exemption list exempts nothing, which is the direction that
 * cannot hide anything.
 *
 * @param {unknown} list The parsed `customRules` value.
 * @param {{resolve?: (key: "decisionRef"|"fitnessBindings", id: string) => boolean}} io
 * @returns {string[]}
 */
function findCustomRuleViolations(list, io) {
  if (!Array.isArray(list)) {
    return [`customRules: must be an array of custom-rule rows, got ${describe(list)}`];
  }
  if (list.length === 0) {
    return [
      "customRules: must not be empty — a list present but empty reads as law while judging nothing",
    ];
  }
  const violations = [];
  const names = new Set();
  list.forEach((row, index) => violations.push(...customRuleRowViolations(row, index, names, io)));
  return violations;
}

/**
 * Everything wrong with a loaded boundary config, as messages; empty when it
 * is well-formed. Pure, so a test drives it without a file on disk.
 *
 * @param {unknown} module The config module's exports.
 * @returns {string[]}
 */
export function findBoundaryConfigViolations(module, io = {}) {
  if (!isPlainObject(module)) return [`config: expected a module object, got ${describe(module)}`];

  const violations = [];
  const {
    depConstraints,
    moduleBoundaryOptions,
    boundarySuppressions,
    fitness,
    customRules,
    coverage,
  } = module;
  // F05: the resolution half of the governance block (`row-schema.mjs`'s
  // `io.resolve`) was validator-only until now — no production caller passed
  // one, so a row bound to a fitness rule that does not exist loaded and ran
  // as if verified. When no caller supplies one, fill it from this module's
  // OWN `fitness` export: a row may only claim a fitness rule this very
  // policy declares (F04's authority, `declaredFitnessNames`). An ADR id needs
  // the registry, which no config loader holds — `unresolvedDecisionRefRows`
  // (`./governance/adr-registry.mjs`) is the check/adr/provenance callers'
  // game, run where the registry lives. What is resolved HERE is the half that
  // can answer from the policy alone.
  if (!io.resolve) {
    const declared = declaredFitnessNames(module);
    io = {
      ...io,
      resolve: (key, id) =>
        key === "fitnessBindings"
          ? declared.has(stripRuleFitnessPrefix(id))
          : // A row's `decisionRef` has two name spaces — a `rule:`/`fitness:`-shaped
            // citation must name a declared fitness here (the half this loader can
            // answer), while a bare `NNN-slug` or `adr:`-prefixed one is an ADR
            // citation the registry owns, judged where the registry lives
            // (`unresolvedDecisionRefRows`, run by check/adr/provenance).
            stripRuleFitnessPrefix(id) === id || declared.has(stripRuleFitnessPrefix(id)),
    };
  }

  // The fitness list — declared where every other executable policy is
  // (`../governance/fitness-registry.mjs` owns the shape). Absent means "no
  // fitness declared", which is a workspace decision the report states; a list
  // present but malformed is refused here, loudly, the same way a malformed
  // suppression is.
  if (fitness !== undefined) {
    violations.push(...findFitnessViolations(fitness, io));
  }

  // The custom-rule list — the fifth top-level law, declared here and executed
  // nowhere near here (this module's header says why). Absent means "no custom
  // rules declared"; present and malformed is refused loudly, because a row
  // this reader could not understand is a rule that would not run while the
  // policy still says it does.
  if (customRules !== undefined) {
    violations.push(...findCustomRuleViolations(customRules, io));
  }

  // The unowned-file acceptances — the sixth top-level law, shaped here and
  // matched by `./commands/coverage-acceptance.mjs` against files already
  // decided to be unowned, never against owned ones. Absent means "no
  // acceptance recorded"; present and malformed is refused loudly, because a
  // row this reader could not understand is an acceptance that would not
  // apply while the policy still says it does.
  if (coverage !== undefined) {
    violations.push(...findCoverageViolations(coverage));
  }

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
    depConstraints.forEach((row, index) =>
      violations.push(...constraintRowViolations(row, index, io)),
    );
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
 * The `.json` dialect's top-level keys, beyond the three every dialect reads.
 * `$schema` is the one key the `.mjs` dialect has no counterpart for at all —
 * an ES module has no analogous editor-validation hook — so the `.mjs`
 * dialect refuses it by name like any other unknown export while the `.json`
 * dialect carves it out by name (accepted and checked, never folded into a
 * general "ignore unknown" rule, which is exactly the leniency this file's
 * header argues a JSON object must not get). `fitness` is the fourth: the
 * boundary dialect's key for the fitness-functions list, validated as an array
 * of fitness rows. `customRules` is the fifth — the declared rules
 * this engine did not write, validated as an array of custom-rule rows.
 * `coverage` is the sixth and newest: the recorded acceptances of unowned
 * files on an Nx or Moon workspace (`findCoverageViolations` above owns the
 * shape). On a native tree the key is refused — `archkeep.json`'s own
 * `coverage.exempt` is that provider's one channel for the same decision —
 * and the refusal lives in `./commands/policy.mjs`'s `resolvePolicy` and
 * `./providers/native/model.mjs`'s inline-policy check, because only they
 * know which provider is reading.
 *
 * The name says `.json` and the list binds both file dialects: `loadModulePolicy`
 * runs the same check over an ES module's exports, which is what makes a
 * misspelt `customRule` export a named refusal in either spelling rather than a
 * law that silently never loads.
 */
const JSON_POLICY_KEYS = [
  "depConstraints",
  "moduleBoundaryOptions",
  "boundarySuppressions",
  "fitness",
  "customRules",
  "coverage",
];

/**
 * The `.json` dialect's own shape check, on top of `findBoundaryConfigViolations`:
 * a top-level key that is neither one of the three every dialect reads nor —
 * when `allowSchema` is set — `$schema` is rejected by name. Run only when
 * `parsed` is itself a plain object — a non-object top level is already
 * `findBoundaryConfigViolations`' first check, and this function would have
 * nothing to enumerate.
 *
 * When `allowSchema` is set, `$schema` is accepted but CHECKED rather than
 * ignored: an editor writes it in unasked, but a `$schema` that is not a
 * non-empty string states nothing an editor can validate against and reads as
 * a false green — the same silent-direction rule this file applies to every
 * other key. The check lives here so the `.json` file dialect and a native
 * workspace's inline `archkeep.json → boundaryConfig` object share it
 * (`./providers/native/model.mjs`) — one validator, one key law.
 * (`../../../docs/reference/policy-schema.md`, "Inline policy (`archkeep.json` only)").
 *
 * @param {unknown} parsed
 * @param {{allowSchema: boolean}} options
 * @returns {string[]}
 */
export function policyKeyViolations(parsed, { allowSchema }) {
  if (!isPlainObject(parsed)) return [];
  const violations = [];
  for (const key of Object.keys(parsed)) {
    if (allowSchema && key === "$schema") {
      if (typeof parsed[key] !== "string" || parsed[key].trim() === "") {
        violations.push(
          `$schema: must be a non-empty string naming the schema the editor should validate ` +
            `against, got ${describe(parsed[key])}`,
        );
      }
      continue;
    }
    if (JSON_POLICY_KEYS.includes(key)) continue;
    violations.push(
      `${key}: not a recognised top-level key — expected one of ${JSON_POLICY_KEYS.join(", ")}` +
        (allowSchema ? `, plus '$schema' (for editor validation)` : "") +
        (key === "default" ? " — the .mjs dialect reads named exports, not a default export" : ""),
    );
  }
  return violations;
}

/**
 * The validate-then-reshape tail every policy loader shares, whichever
 * dialect or spelling produced `parsed`: run `findBoundaryConfigViolations`
 * against it, alongside whatever dialect-specific violations the caller
 * already found (the `.json` dialect's `policyKeyViolations`, for instance),
 * throw one error naming every violation at once when there are any, and
 * otherwise reshape the three keys into the `{depConstraints, options,
 * suppressions}` shape every caller reads.
 *
 * Extracted because this exact sequence used to be copied, by hand, into
 * `loadModulePolicy` and `loadJsonPolicy` below, with a third, UN-validated
 * copy in `../cli.mjs`'s native inline-`boundaryConfig` branch — three places
 * that had to be kept in agreement across every future change to either
 * `findBoundaryConfigViolations` or this return shape, with nothing that
 * would fail if one of them drifted. `./lsp/boundary-config.mjs`'s `.json`
 * arm calls this too, for the identical reason — as does this module's own
 * ESLint-dialect branch of `loadBoundaryConfigFile` below, so a malformed
 * `depConstraints` row is refused identically whether it arrived through an
 * ES module, a JSON file, or an ESLint flat config's rule entry.
 *
 * @param {any} parsed The dialect's parsed data — a module's exports, a
 *   parsed JSON object, or a native workspace's inline policy object. Typed
 *   loosely on purpose: this function is the one place that reshapes it, and
 *   every field it reads has already been through `findBoundaryConfigViolations`
 *   by the time the return statement below is reached.
 * @param {string} sourceLabel What failed, named in the thrown message — an
 *   absolute path for a file-backed dialect, a descriptive phrase for an
 *   inline one.
 * @param {string[]} [extraViolations] Violations the caller already found that
 *   `findBoundaryConfigViolations` does not check on its own.
 * @returns {{ depConstraints: object[], options: object, suppressions: object[], fitness?: object[], customRules?: object[], coverage?: object }}
 *   `fitness` and `customRules` are present only when the config declares
 *   them — a workspace without one carries no key, the same "absent is a
 *   decision" posture `cli.mjs`'s `check` uses for a missing
 *   architecture-intent file. Both ride through exactly as the file declared
 *   them, with nothing defaulted in: a row here is the workspace's own text,
 *   and a reader that filled a field in would be stating law the policy does
 *   not.
 * @throws {Error} `archkeep: ${sourceLabel} is malformed:` followed by every
 *   violation found, when `extraViolations` or `findBoundaryConfigViolations`
 *   found any.
 */
export function policyFrom(parsed, sourceLabel, extraViolations = []) {
  const violations = [...extraViolations, ...findBoundaryConfigViolations(parsed)];
  if (violations.length > 0) {
    throw new Error(`archkeep: ${sourceLabel} is malformed:\n  ${violations.join("\n  ")}`);
  }
  return {
    depConstraints: parsed.depConstraints,
    options: parsed.moduleBoundaryOptions,
    suppressions: parsed.boundarySuppressions ?? [],
    ...(parsed.fitness === undefined ? {} : { fitness: parsed.fitness }),
    ...(parsed.customRules === undefined ? {} : { customRules: parsed.customRules }),
    ...(parsed.coverage === undefined ? {} : { coverage: parsed.coverage }),
  };
}

/**
 * Loads and validates the `.mjs`/`.js` dialect: an ES module whose exports
 * `findBoundaryConfigViolations` above reads by name.
 *
 * The module's own top-level exports get the same unknown-key law the `.json`
 * dialect applies to its top-level keys: an export that is not one of the five
 * this loader reads is almost always a misspelling of one of them
 * (`moduleBoundaryOptions` → `moduleBoundaryOptions` silent-ignored), and
 * a misspelled law is a law that is not enforced. A genuine helper export is
 * refused by name; the header's older position that ESM exports are a
 * legitimate namespace to share a helper in gave a typo the same silence.
 *
 * @param {string} path Absolute path of the config file.
 * @returns {Promise<{ depConstraints: object[], options: object, suppressions: object[], fitness?: object[], customRules?: object[], coverage?: object }>}
 * @throws {Error} when the file is missing, unloadable, or malformed.
 */
async function loadModulePolicy(path) {
  let module;
  try {
    module = await import(pathToFileURL(path).href);
  } catch (cause) {
    throw new Error(`archkeep: cannot load ${path}: ${cause?.message ?? cause}`, {
      cause,
    });
  }
  return policyFrom(module, path, policyKeyViolations(module, { allowSchema: false }));
}

/**
 * Loads and validates the `.json` dialect: plain `JSON.parse`, never JSONC and
 * never `import()`, so the file this loader reads carries no more syntax than
 * the format it declares itself to be. Its three data keys go through the
 * exact same `findBoundaryConfigViolations` the `.mjs` dialect uses — this
 * module's header explains why that has to be one function rather than two.
 *
 * @param {string} path Absolute path of the config file.
 * @param {{readFile?: (path: string, encoding: "utf8") => Promise<string>}} [io]
 *   Injectable read, defaulting to `node:fs/promises`' `readFile` — the only
 *   code in this function that reaches outside the process.
 * @returns {Promise<{ depConstraints: object[], options: object, suppressions: object[], fitness?: object[], customRules?: object[], coverage?: object }>}
 * @throws {Error} when the file is missing, unreadable, not valid JSON, or
 *   malformed — either by `findBoundaryConfigViolations`' rules or by carrying
 *   a top-level key none of those rules knows about.
 */
async function loadJsonPolicy(path, { readFile = readFileFromDisk } = {}) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    throw new Error(`archkeep: cannot load ${path}: ${cause?.message ?? cause}`, {
      cause,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`archkeep: cannot load ${path}: ${cause?.message ?? cause}`, {
      cause,
    });
  }
  return policyFrom(parsed, path, policyKeyViolations(parsed, { allowSchema: true }));
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
 * Dispatches on the path's extension: `.mjs`/`.js` through `loadModulePolicy`
 * (an `import()`, as this loader has always done) and `.json` through
 * `loadJsonPolicy` (a `JSON.parse`, new — this module's header explains the
 * dialect). Anything else is refused by name, in a message that does not
 * contain the words "cannot load" — a `boundaryConfig` misspelt to a `.yaml`
 * or `.toml` extension is a naming mistake, not a missing or unreadable file,
 * and the two must read as different problems.
 *
 * @param {string} path Absolute path of the config file.
 * @param {{readFile?: (path: string, encoding: "utf8") => Promise<string>}} [io]
 *   Injectable read, used only by the `.json` dialect — see `loadJsonPolicy`.
 * @returns {Promise<{ depConstraints: object[], options: object, suppressions: object[], fitness?: object[], customRules?: object[], coverage?: object, notes?: string[] }>}
 *   `suppressions` is `[]` when the config declares none. `notes` is present
 *   only under the ESLint dialect, and only when `./eslint-config.mjs` has
 *   something worth telling a reader about which entry it bound — see
 *   `extractBoundaryRule`'s own `@returns`. `cli.mjs`'s `check` surfaces it on
 *   the report's coverage line, next to what was inspected, rather than
 *   computing it and dropping it: a fact worth noting and never shown is the
 *   silent direction with extra steps.
 * @throws {Error} when the file is missing, unloadable, or malformed. Loud on
 *   purpose: an enforcer that starts with no rules enforces nothing and says
 *   nothing, which is the failure this whole tool exists to end.
 */
export async function loadBoundaryConfigFile(path, io = {}) {
  // Basename tests run STRICTLY BEFORE the extension dispatch below — both
  // `eslint.config.*` and `.eslintrc*` are `.mjs`/`.js`-extensioned far more
  // often than not, and reaching the module dialect's bare `import()` first
  // would either half-work (a flat-config array is a valid ES module, so
  // `.mjs` would "load" it and then fail on `findBoundaryConfigViolations`
  // with a message that never mentions ESLint) or fail on a `.eslintrc.json`
  // with the `.json` dialect's unrecognised-top-level-key refusal — neither
  // reads as what actually went wrong: this is an ESLint config, of the wrong
  // dialect or shape, not a malformed archkeep policy file.
  const name = basename(path);

  if (LEGACY_ESLINTRC_BASENAME.test(name)) {
    throw new Error(
      `archkeep: ${path} names a legacy ESLint config (${name}) as boundaryConfig — ` +
        "@nx/enforce-module-boundaries itself only runs under ESLint's flat config, so archkeep's " +
        "ESLint dialect reads only a file named eslint.config.* exporting a flat-config array. " +
        "Point boundaryConfig at that file once the workspace has migrated, or at an .mjs " +
        "boundary-law module directly.",
    );
  }

  if (ESLINT_FLAT_CONFIG_BASENAME.test(name)) {
    const { depConstraints, options, note } = await loadEslintBoundaryConfig(path);
    // The ESLint dialect's assembled data goes through the same
    // validate-then-reshape tail every other dialect uses — `policyFrom`
    // reads `depConstraints`/`moduleBoundaryOptions` by the identical names
    // `findBoundaryConfigViolations` checks, so a malformed constraint row is
    // refused the same way regardless of which dialect produced it. `notes`
    // has no counterpart in that shared shape (no other dialect produces
    // one), so it is folded back in afterwards rather than taught to
    // `policyFrom` itself.
    const policy = policyFrom({ depConstraints, moduleBoundaryOptions: options }, path);
    return {
      ...policy,
      // The ESLint dialect has no counterpart for `boundarySuppressions`: it
      // is this tool's own concept, with nothing for ESLint to read it back
      // from (see this module's header). Never populated under this dialect —
      // `policyFrom` already resolves that to `[]` since the object above
      // states no `boundarySuppressions` key, and it leaves `customRules`
      // and `coverage` absent for the same reason, the header's own
      // distinction between an absent law and an empty one: a flat config's
      // one rule entry is a constraint table and its options, with nowhere to
      // name a rule artifact or an unowned-file acceptance
      // (`../../../docs/reference/policy-schema.md`'s dialect table names both
      // gaps on the consumer-facing side).
      ...(note !== undefined ? { notes: [note] } : {}),
    };
  }

  const extension = extname(path);
  if (extension === ".mjs" || extension === ".js") return loadModulePolicy(path);
  if (extension === ".json") return loadJsonPolicy(path, io);
  throw new Error(
    `archkeep: ${path} names an unsupported boundaryConfig extension '${extension || "(none)"}' — ` +
      `expected .mjs, .js, or .json`,
  );
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
 * @param {{readFile?: (path: string, encoding: "utf8") => Promise<string>}} [io]
 *   Forwarded to `loadBoundaryConfigFile` — see there.
 * @returns {Promise<{ depConstraints: object[], options: object, suppressions: object[], fitness?: object[], customRules?: object[], coverage?: object, notes?: string[] }>}
 * @throws {Error} as `loadBoundaryConfigFile`.
 */
export async function loadBoundaryConfig(workspaceRoot, boundaryConfig, io = {}) {
  const path = `${workspaceRoot.replace(/\/$/, "")}/${boundaryConfig}`;
  // Resolved ONCE, and the IDENTICAL string feeds the containment check and
  // the read (`loadBoundaryConfigFile`). The boundary law is the workspace's
  // own declared fact, and the name `boundaryConfig` is tree-derived
  // (`nx.json`/`archkeep.json` options) — so a tracked symlink in an
  // intermediate component of that name would hand outside constraint rows in
  // as the workspace's law, judged with zeros. The `--config` override is the
  // caller's explicit choice and takes the path-taking form, NOT this
  // function, so refusing here traps exactly the tree-derived case and leaves
  // the explicit override alone. Resolving first (rather than checking the
  // raw spelling) is the resolve-first contract `../containment.mjs`'s
  // `containsDotDot` refusal exists for: a `..` in the raw name would be
  // normalised away by `resolve` for the check while the read still followed
  // it (`./containment.mjs`, the read-side G-10 closure).
  const resolved = resolve(path);
  if (existsSync(workspaceRoot)) {
    const violation = containmentViolation(workspaceRoot, resolved);
    if (violation !== null) {
      throw new Error(`archkeep: cannot load ${path}: ${violation}`);
    }
  }
  return loadBoundaryConfigFile(resolved, io);
}
