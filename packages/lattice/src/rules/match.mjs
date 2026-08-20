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
 *
 * A fourth dialect lives at the bottom of this file, unrelated to Nx:
 * `path.posix.matchesGlob`, the Node built-in `boundarySuppressions[].path`,
 * `coverage.exempt[].path`, `projectRules[].match` and
 * `projects.infer.include`/`exclude` are matched with. `safeMatchesGlob` and
 * its `globComplexityError` guard live here for the same reason the three
 * dialects above do: one shared implementation every caller reaches through,
 * rather than each one reimplementing the check.
 */
import { posix } from "node:path";

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
 *
 * Exported so `../config.mjs` can reject the same characters in
 * `buildTargets` entries — a target NAME containing a glob character can
 * never match a target under `hasBuildExecutor`'s exact `===` lookup, so it
 * is refused at load rather than silently selecting nothing
 * (`../../../../docs/reference/policy-schema.md`, "`moduleBoundaryOptions`").
 */
export const GLOB_METACHARACTERS = /[*?[\]{}()]/;

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
      throw new Error(`lattice: project pattern '${stringPattern}' ${unsupported}`);
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

/**
 * The most brace-driven alternatives one glob pattern may expand to before
 * `globComplexityError` refuses it — chosen from measurement, not guessed.
 *
 * Against this engine's own `path.posix.matchesGlob` (Node 22.22.2, ordinary
 * hardware): thirteen sequential two-way brace groups
 * (`{a0,b0}{a1,b1}…{a12,b12}`, an expansion count of 2**13 = 8192) already
 * cost around 600ms in a single call, and three groups of forty alternatives
 * each (an expansion count of 40**3 = 64000) cost around 21 SECONDS — the
 * cost grows far faster than the expansion count does, and the same way
 * whether the alternatives arrive as many small groups or a few large ones.
 * Capping the count at 512 keeps an ALLOWED pattern's worst single call under
 * ten milliseconds in that same measurement, with generous headroom over
 * anything a real suppression, exemption or project rule plausibly needs to
 * name from ONE glob string.
 */
export const MAX_GLOB_EXPANSIONS = 512;

/**
 * A brace group's content matches one of these two shapes instead of a
 * `,`-separated union: `path.posix.matchesGlob` treats `{start..end}` and
 * `{start..end..step}` as a RANGE, fully expanding every integer (or, with
 * single letters on both sides, every character) from `start` to `end` —
 * `{1..300000}` is 300000 alternatives from a comma-free 12-character
 * pattern, which `braceExpansionCount` would previously see as one
 * alternative (no `,` inside) and let straight through the cap. Both are
 * exact-match patterns (no partial match inside a longer group content, the
 * same way a real range only fires when it is the group's entire body) and
 * both accept a signed step so a descending range (`{10..1}`) still matches.
 */
const NUMERIC_RANGE_PATTERN = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/;
const ALPHA_RANGE_PATTERN = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/;

/**
 * How many literal strings a brace group's raw `content` (the text strictly
 * between one matched `{` and `}`, before any nested group inside it is
 * resolved) expands to if — and only if — that content is a `{start..end}`
 * or `{start..end..step}` range in its entirety. `null` when it is not a
 * range at all (a comma union, a nested group, or a literal), so the caller
 * falls back to the comma-counting arithmetic that already handles those.
 *
 * The cardinality is `floor(|end-start|/max(1,|step|)) + 1` — the same count
 * real brace expansion produces — computed from the endpoints alone, never by
 * generating the range: the number can be arbitrarily large (`{1..300000}`)
 * while this stays a handful of arithmetic operations. `max(1, |step|)`
 * absorbs a step of `0`, which the real matcher rejects outright — treating
 * it as step `1` only ever overcounts against that error, the safe direction
 * for a guard that must never return fewer alternatives than the real
 * expansion would.
 *
 * @param {string} content
 * @returns {number|null}
 */
function rangeCardinality(content) {
  const numeric = NUMERIC_RANGE_PATTERN.exec(content);
  const alpha = numeric ? null : ALPHA_RANGE_PATTERN.exec(content);
  const match = numeric ?? alpha;
  if (!match) return null;
  const start = numeric ? Number(match[1]) : match[1].charCodeAt(0);
  const end = numeric ? Number(match[2]) : match[2].charCodeAt(0);
  const step = match[3] === undefined ? 1 : Number(match[3]);
  return Math.floor(Math.abs(end - start) / Math.max(1, Math.abs(step))) + 1;
}

/**
 * The number of literal strings `pattern`'s brace groups would expand to,
 * without ever generating them: multiplied across a concatenation (`{a,b}c`
 * is 2, `{a,b}{c,d}` is 4), summed across a `,`-separated union (`{a,{b,c}}`
 * is 2 — `a`, plus the nested pair), and — per `rangeCardinality` above —
 * folded in for a `{start..end}`/`{start..end..step}` range exactly the way
 * a comma union would be, the same arithmetic real brace expansion performs,
 * so the number returned is never smaller than what `path.posix.matchesGlob`
 * would actually have to work through.
 *
 * An explicit stack, not recursion: a pattern built from thousands of nested
 * `{` would otherwise make counting itself recurse thousands of frames deep,
 * trading the DoS this function exists to prevent for a stack overflow
 * instead. Saturates at `cap + 1` the moment any open frame's own running
 * total would exceed `cap`, so neither a wide pattern (many alternatives) nor
 * a deep one (many nested groups) costs this function more than the linear
 * scan already in flight — the property `globComplexityError` needs from it
 * to be a cheap gate in front of the real, unbounded matcher.
 *
 * An unbalanced `{` with no closing `}` is folded in as though the string had
 * ended there. This function only ever needs to REFUSE a pattern that really
 * would explode, never to reproduce `path.posix.matchesGlob`'s exact grammar
 * (escapes, a `{`/`}` meant literally inside a `[...]` class) — so treating
 * anything that looks like brace syntax as brace syntax is the safe
 * direction: it can only make this function refuse a pattern that would
 * actually have been cheap, never the reverse.
 *
 * @param {string} pattern
 * @param {number} cap
 * @returns {number} The exact count when it is at most `cap`, or `cap + 1` —
 *   a sentinel, not a precise count past that point — once the pattern is
 *   certain to exceed `cap`.
 */
export function braceExpansionCount(pattern, cap) {
  const limit = cap + 1;
  /** @type {{alternatives: number, branchProduct: number, start: number}[]} */
  const frames = [{ alternatives: 0, branchProduct: 1, start: 0 }];
  for (let i = 0; i < pattern.length; i++) {
    const nested = frames.length > 1;
    const top = frames[frames.length - 1];
    const ch = pattern[i];
    if (nested && ch === "}") {
      const range = top.alternatives === 0 ? rangeCardinality(pattern.slice(top.start, i)) : null;
      const contribution = range === null ? top.branchProduct : Math.min(range, limit);
      top.alternatives += contribution;
      frames.pop();
      const parent = frames[frames.length - 1];
      parent.branchProduct = Math.min(parent.branchProduct * top.alternatives, limit);
    } else if (nested && ch === ",") {
      top.alternatives += top.branchProduct;
      top.branchProduct = 1;
    } else if (ch === "{") {
      frames.push({ alternatives: 0, branchProduct: 1, start: i + 1 });
    }
    const current = frames[frames.length - 1];
    if (current.alternatives + current.branchProduct > cap) return limit;
  }
  // An unbalanced '{' leaves frames still open — close each one as though the
  // pattern had ended right there, folding its count into its parent. Never a
  // range: a range that reached end-of-string with no closing '}' is not
  // valid range syntax either, so it falls back to the same "one alternative"
  // treatment an unbalanced literal group gets.
  while (frames.length > 1) {
    const frame = frames.pop();
    frame.alternatives += frame.branchProduct;
    const parent = frames[frames.length - 1];
    parent.branchProduct = Math.min(parent.branchProduct * frame.alternatives, limit);
    if (parent.alternatives + parent.branchProduct > cap) return limit;
  }
  const root = frames[0];
  return Math.min(root.alternatives + root.branchProduct, limit);
}

/**
 * Why `pattern` cannot be handed to `path.posix.matchesGlob`, or `null`.
 *
 * `path.posix.matchesGlob`'s brace-group support expands combinatorially
 * (`braceExpansionCount`'s own doc comment carries the measurement), and
 * `boundarySuppressions[].path`, `coverage.exempt[].path`,
 * `projectRules[].match` and `projects.infer.include`/`exclude` are all
 * matched with it while validating only that the string is non-empty. Every
 * one of those four fields is attacker-controlled the moment a pull request
 * edits `lattice.json` or the boundary config (`../../../../SECURITY.md`), so a
 * crafted pattern reaching the real matcher unchecked is a denial of
 * service — refusing it here, loudly, at config load is both the security
 * fix and the "empty result is a claim, not a shrug" fix
 * (`../../../../AGENTS.md`): a config that fails to validate must never be
 * silently treated as "no suppressions/exemptions/rules declared."
 *
 * @param {string} pattern
 * @returns {string|null}
 */
export function globComplexityError(pattern) {
  if (braceExpansionCount(pattern, MAX_GLOB_EXPANSIONS) <= MAX_GLOB_EXPANSIONS) return null;
  return (
    `expands to more than ${MAX_GLOB_EXPANSIONS} brace-driven alternatives for ` +
    `'path.posix.matchesGlob' to match without the combinatorial cost this engine refuses to ` +
    `pay — narrow the brace groups`
  );
}

/**
 * `path.posix.matchesGlob`, guarded by `globComplexityError` first — the one
 * place `boundarySuppressions` (`../config.mjs`'s `suppressionCovers`),
 * `coverage.exempt`, `projectRules` and `projects.infer.include`/`exclude`
 * (`../providers/native/model.mjs`'s `matchesGlob` export) reach the real
 * matcher, so a pattern that slipped past config-load validation — or a
 * future caller that never validates — still cannot reach the expensive call
 * uncounted.
 *
 * @param {string} path
 * @param {string} pattern
 * @returns {boolean}
 * @throws {Error} when `pattern` fails `globComplexityError`.
 */
export function safeMatchesGlob(path, pattern) {
  const problem = globComplexityError(pattern);
  if (problem) throw new Error(`lattice: glob pattern '${pattern}' ${problem}`);
  return posix.matchesGlob(path, pattern);
}
