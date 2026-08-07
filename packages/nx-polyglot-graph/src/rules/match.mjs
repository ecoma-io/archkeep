/**
 * Nx's own matchers, ported literally — the three places where "it looked like
 * a glob" is wrong.
 *
 * `@nx/enforce-module-boundaries` matches patterns in three different dialects,
 * none of them minimatch, and each is a place a reimplementation silently
 * stops agreeing with ESLint:
 *
 * 1. `allow` and `checkDynamicDependenciesExceptions` use
 *    `matchImportWithWildcard`, which understands exactly three shapes — a
 *    trailing `…/**`, a trailing `…/*`, and a double-star segment between a
 *    prefix and a suffix — and otherwise falls through to
 *    `new RegExp(pattern)` — UNANCHORED. `allow: ["@scope/pkg"]` is a regular
 *    expression, so it also matches `@scope/pkg-internal` and `x@scopeYpkg`.
 * 2. `bannedExternalImports` / `allowedExternalImports` and glob-shaped tags use
 *    `mapGlobToRegExp`, which turns every run of `*` into `.*` and anchors the
 *    result. Every other regex metacharacter survives — `.` still means "any
 *    character", so `@tauri-apps/api` also matches `@tauri-appsXapi`.
 * 3. `ignoredCircularDependencies` entries go through Nx's
 *    `findMatchingProjects`, whose unlabeled patterns are neither names nor
 *    globs but a case-insensitive word-boundary regex over project names.
 *
 * Swapping any of these for a glob library keeps the tests green on the simple
 * cases and quietly changes which imports escape, which is why they are ported
 * here rather than approximated. The `…Error` helpers exist so `../config.mjs`
 * can reject a pattern that will not compile at load, naming it, instead of
 * throwing from inside a rule halfway through a run.
 */

/**
 * Does `extractedImport` match the wildcard pattern `allowableImport`?
 *
 * Port of `matchImportWithWildcard` in `@nx/eslint-plugin`'s
 * `utils/runtime-lint-utils`. The final branch is a bare, unanchored RegExp —
 * that is upstream's behaviour and the reason `allow` entries are far broader
 * than they read.
 *
 * @param {string} allowableImport May contain `*`; may be a regular expression.
 * @param {string} extractedImport The raw specifier, as written.
 * @returns {boolean}
 */
export function matchImportWithWildcard(allowableImport, extractedImport) {
  if (allowableImport.endsWith("/**")) {
    const prefix = allowableImport.substring(0, allowableImport.length - 2);
    return extractedImport.startsWith(prefix);
  } else if (allowableImport.endsWith("/*")) {
    const prefix = allowableImport.substring(0, allowableImport.length - 1);
    if (!extractedImport.startsWith(prefix)) return false;
    return extractedImport.substring(prefix.length).indexOf("/") === -1;
  } else if (allowableImport.indexOf("/**/") > -1) {
    const [prefix, suffix] = allowableImport.split("/**/");
    return extractedImport.startsWith(prefix) && extractedImport.endsWith(suffix);
  } else {
    return new RegExp(allowableImport).test(extractedImport);
  }
}

/**
 * Turns an import definition into the anchored RegExp Nx tests it with.
 *
 * Port of `mapGlobToRegExp`. The double construction is upstream's: the inner
 * `RegExp` normalises the source (escaping `/`) before the outer one anchors
 * it, and reproducing it matters because the two produce different sources.
 *
 * @param {string} importDefinition
 * @returns {RegExp}
 */
export function mapGlobToRegExp(importDefinition) {
  // Every instance of `*`, `**..*` and `.*` becomes `.*` — upstream's comment.
  const mappedWildcards = importDefinition.split(/(?:\.\*)|\*+/).join(".*");
  return new RegExp(`^${new RegExp(mappedWildcards).source}$`);
}

/**
 * Does a tag list satisfy one constraint tag? The core of upstream's `hasTag`,
 * taken over the tag array rather than a project node so it can be reused for
 * both source matching and target matching.
 *
 * Four dialects, in upstream's order: `*` matches everything (so a single
 * `{ sourceTag: "*" }` row disarms the no-constraint-is-an-error rule for the
 * whole workspace), `/…/` is a regular expression tested against each tag,
 * anything containing `*` is a `mapGlobToRegExp` glob, and everything else is
 * an exact string comparison.
 *
 * @param {string[]} tags The project's tags.
 * @param {string} tag The constraint's tag.
 * @returns {boolean}
 */
export function tagMatches(tags, tag) {
  if (tag === "*") return true;
  if (tag.startsWith("/") && tag.endsWith("/")) {
    const regex = new RegExp(tag.substring(1, tag.length - 1));
    return tags.some((t) => regex.test(t));
  }
  if (tag.includes("*")) {
    const regex = mapGlobToRegExp(tag);
    return tags.some((t) => regex.test(t));
  }
  return tags.indexOf(tag) > -1;
}

/** Why `pattern` cannot serve as an `allow`-style import pattern, or `null`. */
export function importPatternError(pattern) {
  try {
    matchImportWithWildcard(pattern, "");
    return null;
  } catch (cause) {
    return `is not a valid import pattern: ${cause?.message ?? cause}`;
  }
}

/** Why `pattern` cannot serve as an external-import glob, or `null`. */
export function globPatternError(pattern) {
  try {
    mapGlobToRegExp(pattern);
    return null;
  } catch (cause) {
    return `is not a valid import glob: ${cause?.message ?? cause}`;
  }
}

/** Why `tag` cannot serve as a constraint tag, or `null`. */
export function tagPatternError(tag) {
  try {
    tagMatches([], tag);
    return null;
  } catch (cause) {
    return `is not a valid tag pattern: ${cause?.message ?? cause}`;
  }
}

/**
 * The glob metacharacters Nx hands to minimatch and this engine deliberately
 * does not reimplement. A bare `*` is exempt: upstream short-circuits that one
 * before minimatch ever sees it, so "every project" is reproducible exactly.
 */
const GLOB_METACHARACTERS = /[*?[\]{}()]/;

/**
 * Why `pattern` cannot be used to select projects here, or `null`.
 *
 * Nx resolves these patterns with minimatch, which this project may not import
 * (Node built-ins and `typescript` only). Rather than hand-roll an
 * almost-minimatch — an ignore list that expands to nearly the right set is a
 * false negative generator, and `ignoredCircularDependencies` is the one option
 * whose whole job is to suppress a violation — the unreproducible subset is
 * rejected at config load, naming the entry. Refusing to start beats starting
 * with an ignore list that means something slightly different here than it does
 * in ESLint.
 *
 * @param {string} pattern
 * @returns {string|null}
 */
export function projectPatternError(pattern) {
  const value = pattern.startsWith("!") ? pattern.slice(1) : pattern;
  const withoutLabel = value.includes(":") ? value.slice(value.indexOf(":") + 1) : value;
  if (withoutLabel === "*") return null;
  if (GLOB_METACHARACTERS.test(withoutLabel)) {
    return (
      `uses glob syntax this engine does not reproduce — Nx expands it with minimatch, ` +
      `which this tool cannot import, and an ignore list that expands to almost the right ` +
      `set silently hides real cycles. Name projects, tags or directories exactly, or '*'`
    );
  }
  return null;
}

/** A pattern's `{type, value, exclude}`, as `parseStringPattern` splits it. */
const VALID_PATTERN_TYPES = ["name", "tag", "directory", "unlabeled"];

function parseStringPattern(pattern, nodes) {
  const exclude = pattern.startsWith("!");
  const body = exclude ? pattern.substring(1) : pattern;
  const separator = body.indexOf(":");
  if (nodes[body]) return { type: "name", value: body, exclude };
  if (separator === -1) return { type: "unlabeled", value: body, exclude };
  const potentialType = body.substring(0, separator);
  return {
    type: VALID_PATTERN_TYPES.includes(potentialType) ? potentialType : "unlabeled",
    value: body.substring(separator + 1),
    exclude,
  };
}

function applyName(nodes, pattern, matched) {
  if (nodes[pattern.value]) {
    if (pattern.exclude) matched.delete(pattern.value);
    else matched.add(pattern.value);
    return;
  }
  // Upstream's own regex: `\b` widened to treat `-` as a boundary and `_` as
  // not one, so `foo` selects `foo_bar` but not `foo-e2e`. Case-insensitive.
  const regex = new RegExp(`(?<![@a-zA-Z0-9-])${pattern.value}(?![@a-zA-Z0-9-])`, "i");
  for (const name of Object.keys(nodes)) {
    if (!regex.test(name)) continue;
    if (pattern.exclude) matched.delete(name);
    else matched.add(name);
  }
}

function applyDirectory(nodes, pattern, matched) {
  for (const [name, node] of Object.entries(nodes)) {
    // Exact root comparison where Nx globs. A strict subset, and the direction
    // is safe for the only caller: fewer ignored pairs means more cycles
    // reported, never fewer.
    if (node.data?.root !== pattern.value) continue;
    if (pattern.exclude) matched.delete(name);
    else matched.add(name);
  }
}

function applyTag(nodes, pattern, matched) {
  for (const [name, node] of Object.entries(nodes)) {
    if (!(node.data?.tags || []).includes(pattern.value)) continue;
    if (pattern.exclude) matched.delete(name);
    else matched.add(name);
  }
}

/**
 * Project names selected by a list of patterns — the subset of Nx's
 * `findMatchingProjects` this engine reproduces exactly. Patterns outside that
 * subset are rejected earlier by `projectPatternError`, so reaching one here is
 * a caller that skipped validation and it throws rather than guessing.
 *
 * @param {string[]} patterns
 * @param {Record<string, {data?: {root?: string, tags?: string[]}}>} nodes
 * @returns {string[]}
 */
export function findMatchingProjects(patterns, nodes) {
  if (!patterns.length || patterns.filter((p) => p.length).length === 0) return [];
  const matched = new Set();
  // A list opening with an exclusion means "everything except…", so Nx prepends
  // a wildcard. Reproduced because it changes the result set entirely.
  const effective = patterns[0].startsWith("!") ? ["*", ...patterns] : patterns;

  for (const stringPattern of effective) {
    if (!stringPattern.length || stringPattern.startsWith("nx-cloud:")) continue;
    const unsupported = projectPatternError(stringPattern);
    if (unsupported) {
      throw new Error(`nx-polyglot-graph: project pattern '${stringPattern}' ${unsupported}`);
    }
    const pattern = parseStringPattern(stringPattern, nodes);
    if (pattern.value === "*") {
      for (const name of Object.keys(nodes)) {
        if (pattern.exclude) matched.delete(name);
        else matched.add(name);
      }
      continue;
    }
    if (pattern.type === "tag") {
      applyTag(nodes, pattern, matched);
      continue;
    }
    if (pattern.type === "name") {
      applyName(nodes, pattern, matched);
      continue;
    }
    if (pattern.type === "directory") {
      applyDirectory(nodes, pattern, matched);
      continue;
    }
    // Unlabeled waterfalls: names first, directories only if nothing matched.
    const before = matched.size;
    applyName(nodes, pattern, matched);
    if (matched.size !== before) continue;
    applyDirectory(nodes, pattern, matched);
  }
  return Array.from(matched);
}
