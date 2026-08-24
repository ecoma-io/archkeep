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
 * throwing from inside a rule halfway through a run — and, since a pattern
 * that compiles can still cost more than the whole run is worth,
 * `regexComplexityError` rejects the shapes that backtrack catastrophically at
 * that same door. All three dialects above compile a pattern the consumer
 * wrote, so all three reach it.
 *
 * What that guard bounds is the pattern. The cost is a product of two things,
 * and the other one — how long the SUBJECT is — is bounded by
 * `MAX_SPECIFIER_LENGTH` at the doors a specifier arrives at, here and in
 * `./specifiers.mjs`. Neither bound is sufficient alone.
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
 * The most repetitions one pattern may be forced to RE-SPLIT before
 * `regexComplexityError` refuses it — chosen from measurement, the way
 * `MAX_GLOB_EXPANSIONS` further down was.
 *
 * **How many `*`s a pattern carries is not what decides its cost.** What
 * decides it is whether a required atom that CAN FAIL follows them: a failing
 * atom is what makes a backtracking engine try every division of the subject
 * across the wildcards before it gives up, and an anchor at the end of a `.*`
 * cannot fail, so it never starts. Measured on Node v24.16.0, one
 * `re.test(subject)` on a subject the pattern never matches, by subject
 * length:
 *
 * | pattern                 | subject           | 500   | 1000  | 2000   |
 * | ----------------------- | ----------------- | ----- | ----- | ------ |
 * | `^a.*a.*a.*z$`          | `"a"*n`           | 27ms  | 190ms | 1505ms |
 * | `^.*-.*-.*x$`           | `"-"*n`           | 25ms  | 194ms | 1483ms |
 * | `^@scope\/.*\/.*\/.*x$` | `"@scope/"+"/"*n` | 26ms  | 193ms | 1499ms |
 * | `^.*-.*-.*$`            | `"-"*n`           | 0.0ms | 0.0ms | 0.0ms  |
 * | `^@scope\/.*\/.*\/.*$`  | `"@scope/"+"/"*n` | 0.0ms | 0.0ms | 0.0ms  |
 *
 * The bottom two rows carry three unbounded repetitions each and an
 * adversarial subject, and cost nothing at all: their last `.*` runs to the
 * end of the subject where `$` succeeds, so no division is ever retried. The
 * top three differ from them by one character. That difference is what this
 * guard counts, because it is the difference that shows up in the clock — and
 * it is why the cap can be as low as two without refusing the shapes a real
 * policy is written in. `mapGlobToRegExp` ANCHORS everything it builds, so
 * a glob naming three wildcard segments under a scope compiles to
 * `^@acme\/.*\/.*\/.*$` — the bottom two rows, provably — while the same glob
 * with one more literal segment after it compiles to a failing tail and is
 * genuinely the top three.
 *
 * Two is the cap because three is where the clock moves: with a failing tail,
 * `a+a+a+$` costs 23ms against a 140-character subject where `a+a+$` costs
 * 0.7ms, and `^a.*a.*a.*z$` costs 1.5 SECONDS against a 2000-character one
 * where `^a.*a.*z$` costs 2.3ms. What the polynomial that survives the cap
 * costs is bounded at the other end, by `MAX_SPECIFIER_LENGTH` below, because
 * a degree-2 pattern is still quadratic in a subject nothing else limits.
 */
export const MAX_RESPLIT_REPETITIONS = 2;

/**
 * The most repetitions a SINGLE-DELIMITER chain may carry — the one shape
 * that is allowed past `MAX_RESPLIT_REPETITIONS`, because for it the
 * exhaustive re-split cannot happen.
 *
 * `^.*\/.*\/.*\/.*$` — what a glob of four wildcard segments compiles to —
 * has three repetitions in front of a required atom, and is free on every
 * subject:
 * every atom it requires after the first wildcard is the SAME character, so a
 * subject with enough of them MATCHES — greedily, on the first or second
 * attempt — and a subject without enough of them has fewer than three places
 * to try. Abundance and failure cannot happen at once, which is exactly what
 * `^a.*a.*a.*z$` arranges by asking for a `z` that never comes.
 *
 * It is a cap and not a licence because the small search that remains still
 * grows with the number of segments. Measured on Node v24.16.0 against a
 * 2000-character subject holding one delimiter fewer than the pattern needs —
 * the worst case, a guaranteed failure with the most positions to try:
 *
 * | segments | 6     | 8     | 12    | 16    | 18     | 20     |
 * | -------- | ----- | ----- | ----- | ----- | ------ | ------ |
 * | cost     | 0.0ms | 0.0ms | 0.3ms | 3.6ms | 11.8ms | 69.1ms |
 *
 * Eight is far below where that curve turns and far above any real glob: a
 * path pattern naming every segment of `libs/<area>/<name>/<entry>` needs
 * four.
 */
export const MAX_DELIMITED_SEGMENTS = 8;

/**
 * The longest import specifier this engine will match a consumer-written
 * pattern against. Past it the specifier is not judged, and not judging is
 * reported rather than passed — `assertMatchableSpecifier` at the foot of
 * this section is where that happens and carries the argument.
 *
 * The two refusals above bound the SHAPE of a pattern; this bounds the other
 * multiplicand. A pattern that survives them is still quadratic in the length
 * of a subject that does not match, and nothing else in this pipeline limits
 * that length: a specifier is text read out of a source file, and a source
 * file is attacker-supplied (`../../../../SECURITY.md`). Measured on Node
 * v24.16.0, a chain at exactly the cap (`^a.*a.*z$` against `"a"*n`, and
 * `^@s\/.*\/.*x$` against `"@s/"+"/"*n`) by subject length:
 *
 * | length          | 256    | 512    | 1024   | 2048   | 4096    |
 * | --------------- | ------ | ------ | ------ | ------ | ------- |
 * | `^a.*a.*z$`     | 0.04ms | 0.16ms | 0.58ms | 2.28ms | 9.16ms  |
 * | `^@s\/.*\/.*x$` | 0.05ms | 0.20ms | 0.80ms | 3.18ms | 13.45ms |
 *
 * 1024 is the last length at which that chain stays under a millisecond per
 * site, and it is an order of magnitude past anything a specifier can actually
 * be: the longest thing the four analyzers emit is a path or a dotted module
 * name, and `../analysis/` has never produced one over 200 characters. A 400KB
 * "specifier" is not a specifier.
 *
 * The two named chains are not the ceiling, only the calibration. Three
 * thousand randomly generated patterns were run against seventeen adversarial
 * subjects of exactly this length, and the worst SINGLE call any pattern the
 * guards accept managed was 7.4ms — `((a|[a-z]?)b{2,})?x+(?:\d){2,}` against
 * 1024 `b`s. That is the number to compare a change here against; before this
 * bound and the refusals above, the same sweep found 59 SECONDS.
 */
export const MAX_SPECIFIER_LENGTH = 1024;

/**
 * The deepest group nesting this model reads. Past it a pattern is refused
 * rather than modelled — the walk below is recursive over group structure, and
 * a pattern is a config value a pull request can write, so a thousand nested
 * `(` would trade the denial of service this file exists to prevent for a
 * stack overflow instead (the reason `braceExpansionCount` further down uses
 * an explicit stack). No regular expression a boundary policy is written in
 * nests past three.
 */
const MAX_GROUP_DEPTH = 32;

/* ------------------------------------------------------------------------ *
 * A regular expression, read as a shape
 * ------------------------------------------------------------------------ */

/**
 * The characters one atom can match: explicit code-point ranges, or `any`.
 *
 * `any` is the answer for everything this model does not resolve exactly —
 * `.`, a negated class, `\D`/`\W`/`\S`, a `\p{…}` property, a backreference.
 * Every question asked of a `CharSet` below is "can these two match the same
 * character?", and answering yes can only ever make this file REFUSE a
 * pattern that would have been cheap. It can never let an expensive one
 * through, which is the direction that matters.
 *
 * @typedef {{ any: boolean, ranges: [number, number][] }} CharSet
 */

/** @type {CharSet} */
const ANY_CHARS = { any: true, ranges: [] };
/** @type {CharSet} */
const NO_CHARS = { any: false, ranges: [] };
/** @type {CharSet} */
const DIGIT_CHARS = { any: false, ranges: [[48, 57]] };
/** @type {CharSet} */
const WORD_CHARS = {
  any: false,
  ranges: [
    [48, 57],
    [65, 90],
    [95, 95],
    [97, 122],
  ],
};
/**
 * `\s` as ECMA-262 defines it, the Unicode entries included: a tag or a
 * specifier is not restricted to ASCII.
 *
 * @type {CharSet}
 */
const SPACE_CHARS = {
  any: false,
  ranges: [
    [9, 13],
    [32, 32],
    [160, 160],
    [5760, 5760],
    [8192, 8202],
    [8232, 8233],
    [8239, 8239],
    [8287, 8287],
    [12288, 12288],
    [65279, 65279],
  ],
};

/**
 * @param {number} code
 * @returns {CharSet}
 */
const oneChar = (code) => ({ any: false, ranges: [[code, code]] });

/**
 * @param {CharSet[]} sets
 * @returns {CharSet}
 */
function unionChars(sets) {
  /** @type {[number, number][]} */
  const ranges = [];
  for (const set of sets) {
    if (set.any) return ANY_CHARS;
    ranges.push(...set.ranges);
  }
  return { any: false, ranges };
}

/**
 * Can these two atoms match the same character? The one question this whole
 * model is built to answer, and the reason `any` resolves to `true`.
 *
 * @param {CharSet} a
 * @param {CharSet} b
 * @returns {boolean}
 */
function charsOverlap(a, b) {
  if (a.any || b.any) return true;
  for (const [lo, hi] of a.ranges) {
    for (const [otherLo, otherHi] of b.ranges) {
      if (lo <= otherHi && otherLo <= hi) return true;
    }
  }
  return false;
}

/**
 * The single code point this set is, or `null` when it is anything else —
 * how the single-delimiter exemption recognises "every separator is the same
 * character".
 *
 * @param {CharSet} set
 * @returns {number|null}
 */
function loneChar(set) {
  if (set.any || set.ranges.length !== 1) return null;
  const [lo, hi] = set.ranges[0];
  return lo === hi ? lo : null;
}

/**
 * One node of the shape a pattern is read as.
 *
 * `pinned` is the property Rule 1 turns on: a node is pinned when repeating it
 * cannot produce two different ways to match the same text. `chars` is
 * everything it can consume ANYWHERE inside it, `first` everything it can
 * begin with; the two differ exactly where a leading delimiter does its work.
 *
 * @typedef {object} PatternNode
 * @property {"atom"|"anchor"|"look"|"seq"|"alt"|"rep"} kind
 * @property {CharSet} chars Every character reachable anywhere inside it.
 * @property {CharSet} first Every character it can begin with.
 * @property {number} minLen
 * @property {number} maxLen `Infinity` when unbounded.
 * @property {boolean} pinned Repeating it cannot re-split the same text.
 * @property {boolean} opaque The model did not resolve the shape exactly.
 * @property {boolean} elastic It can consume a varying amount of text itself.
 * @property {boolean} repeats It runs its body more than once.
 * @property {string|null} problem The first Rule-1 refusal found inside it.
 * @property {"^"|"$"|"b"|null} anchor
 * @property {number} start Offset into the pattern source.
 * @property {number} end
 * @property {PatternNode[]} children
 */

/**
 * @param {Partial<PatternNode> & {kind: PatternNode["kind"], start: number, end: number}} fields
 * @returns {PatternNode}
 */
function node(fields) {
  return {
    chars: NO_CHARS,
    first: NO_CHARS,
    minLen: 0,
    maxLen: 0,
    pinned: false,
    opaque: false,
    elastic: false,
    repeats: false,
    problem: null,
    anchor: null,
    children: [],
    ...fields,
  };
}

/**
 * @param {CharSet} chars
 * @param {number} start
 * @param {number} end
 * @param {boolean} [opaque]
 * @returns {PatternNode}
 */
const atomNode = (chars, start, end, opaque = false) =>
  node({
    kind: "atom",
    chars,
    first: chars,
    minLen: 1,
    maxLen: 1,
    pinned: !opaque,
    opaque,
    start,
    end,
  });

/**
 * @param {"^"|"$"|"b"} anchor
 * @param {number} start
 * @param {number} end
 * @returns {PatternNode}
 */
const anchorNode = (anchor, start, end) => node({ kind: "anchor", anchor, start, end });

/**
 * Whether repeating this node can produce two ways to match one string — the
 * whole of Rule 1, as three sufficient tests. Each is cheap and each is
 * one-directional: it either proves the node cannot re-split, or says nothing,
 * and saying nothing refuses.
 *
 * 1. **Fixed width.** Every match is the same length, so a run of them divides
 *    exactly one way. `(a|b)+`, `(ab)+`, `(a{2})+`.
 * 2. **A pinned leading atom.** The body opens with an atom of fixed width
 *    whose characters appear nowhere else in the body, so every iteration
 *    starts at a character the previous one could not have eaten.
 *    `(\.\w+)*` — `\.` and `\w` are disjoint, which is what makes that idiom
 *    safe and what makes `(a+)+` and `(\s*a)+` not.
 * 3. **A deterministic alternation.** No branch matches the empty string, each
 *    branch is itself pinned, and no two branches can begin with the same
 *    character — so at most one branch is ever in play. `(ui|core)+` is
 *    pinned; `(a|aa)+` and `(?:a|b|ab)*` are not.
 *
 * A body that is pinned by NONE of the three is refused. That includes shapes
 * that are in fact unambiguous — `([a-z]+-)+` is pinned by its TRAILING
 * delimiter, which none of these three sees — and refusing them is the
 * deliberate direction: the overlap this decides is a property of the whole
 * language a group matches, deciding it exactly is not cheap, and an
 * over-refused pattern fails a config load loudly where an under-refused one
 * hangs a run.
 *
 * @param {PatternNode} candidate
 * @returns {boolean}
 */
function isPinned(candidate) {
  if (candidate.opaque) return false;
  if (candidate.minLen >= 1 && candidate.minLen === candidate.maxLen) return true;
  if (candidate.kind === "alt") {
    const branches = candidate.children;
    if (branches.some((branch) => branch.minLen === 0 || !branch.pinned)) return false;
    for (let i = 0; i < branches.length; i++) {
      for (let j = i + 1; j < branches.length; j++) {
        if (charsOverlap(branches[i].first, branches[j].first)) return false;
      }
    }
    return true;
  }
  if (candidate.kind === "seq") {
    const [head, ...rest] = candidate.children;
    if (!head || head.minLen < 1 || head.minLen !== head.maxLen) return false;
    return !charsOverlap(head.chars, unionChars(rest.map((item) => item.chars)));
  }
  return false;
}

/**
 * @param {PatternNode[]} items
 * @param {number} start
 * @param {number} end
 * @returns {PatternNode}
 */
function seqNode(items, start, end) {
  let minLen = 0;
  let maxLen = 0;
  /** @type {CharSet[]} */
  const firsts = [];
  let firstSettled = false;
  for (const item of items) {
    minLen += item.minLen;
    maxLen += item.maxLen;
    if (!firstSettled) {
      firsts.push(item.first);
      if (item.minLen >= 1) firstSettled = true;
    }
  }
  const built = node({
    kind: "seq",
    chars: unionChars(items.map((item) => item.chars)),
    first: unionChars(firsts),
    minLen,
    maxLen,
    opaque: items.some((item) => item.opaque),
    problem: items.map((item) => item.problem).find(Boolean) ?? null,
    children: items,
    start,
    end,
  });
  built.pinned = isPinned(built);
  return built;
}

/**
 * @param {PatternNode[]} branches
 * @param {number} start
 * @param {number} end
 * @returns {PatternNode}
 */
function altNode(branches, start, end) {
  const built = node({
    kind: "alt",
    chars: unionChars(branches.map((branch) => branch.chars)),
    first: unionChars(branches.map((branch) => branch.first)),
    minLen: Math.min(...branches.map((branch) => branch.minLen)),
    maxLen: Math.max(...branches.map((branch) => branch.maxLen)),
    opaque: branches.some((branch) => branch.opaque),
    problem: branches.map((branch) => branch.problem).find(Boolean) ?? null,
    children: branches,
    start,
    end,
  });
  built.pinned = isPinned(built);
  return built;
}

/**
 * A lookaround: zero width, and opaque on purpose. Nothing here models what a
 * lookahead asserts, so it consumes no characters, pins nothing, and counts as
 * a requirement that can fail — while its body is still walked, because
 * `(?=(a+)+)` is the same exponential as `(a+)+`.
 *
 * @param {PatternNode} body
 * @param {number} start
 * @param {number} end
 * @returns {PatternNode}
 */
const lookNode = (body, start, end) =>
  node({ kind: "look", opaque: true, problem: body.problem, children: [body], start, end });

/**
 * @param {PatternNode} item
 * @param {number} min
 * @param {number} max `Infinity` for `*`, `+` and `{n,}`.
 * @param {string} text The source slice, for the refusal message.
 * @param {number} start
 * @param {number} end
 * @returns {PatternNode}
 */
function repNode(item, min, max, text, start, end) {
  const minLen = item.minLen * min;
  const maxLen =
    max === 0 || item.maxLen === 0 ? 0 : max === Infinity ? Infinity : item.maxLen * max;
  const built = node({
    kind: "rep",
    chars: item.chars,
    first: item.first,
    minLen,
    maxLen,
    opaque: item.opaque,
    // A repetition that can vary how much it consumes is one a failing atom
    // can force to try every division. `?` and `{2,3}` can vary by one, which
    // is a constant factor rather than a factor of the subject's length.
    elastic: max === Infinity || max - min >= 2,
    repeats: max >= 2,
    problem: item.problem ?? (max >= 2 && !item.pinned ? nestedRepetitionReason(text) : null),
    children: [item],
    start,
    end,
  });
  built.pinned = minLen >= 1 && minLen === maxLen;
  return built;
}

/** A `{n}` / `{n,}` / `{n,m}` quantifier, read where the scan already is. */
const BRACE_QUANTIFIER = /\{(\d+)(?:,(\d*))?\}/y;

/**
 * The quantifier at `index`, or `null` when what is there is an ordinary
 * character.
 *
 * @param {string} source
 * @param {number} index
 * @returns {{length: number, min: number, max: number}|null}
 */
function quantifierAt(source, index) {
  const ch = source[index];
  if (ch === "*") return { length: 1, min: 0, max: Infinity };
  if (ch === "+") return { length: 1, min: 1, max: Infinity };
  if (ch === "?") return { length: 1, min: 0, max: 1 };
  if (ch !== "{") return null;
  BRACE_QUANTIFIER.lastIndex = index;
  const match = BRACE_QUANTIFIER.exec(source);
  if (match === null) return null; // a literal `{`, which JS regexes allow
  const min = Number(match[1]);
  const max = match[2] === undefined ? min : match[2] === "" ? Infinity : Number(match[2]);
  return { length: match[0].length, min, max };
}

/**
 * How many characters after `(` belong to the group's own opener rather than
 * to its body — `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!` and `(?<name>`. Read so
 * the `?` in `(?:` is never mistaken for the optional quantifier.
 *
 * @param {string} source
 * @param {number} open Index of the `(`.
 * @returns {number}
 */
function groupPrefixLength(source, open) {
  if (source[open + 1] !== "?") return 0;
  const third = source[open + 2];
  if (third === ":" || third === "=" || third === "!") return 2;
  if (third === "<") {
    const fourth = source[open + 3];
    if (fourth === "=" || fourth === "!") return 3;
    const close = source.indexOf(">", open + 3);
    return close === -1 ? 2 : close - open;
  }
  return 1;
}

/** Is the group opening at `open` a lookahead or lookbehind? */
function isLookaround(source, open) {
  if (source[open + 1] !== "?") return false;
  const third = source[open + 2];
  if (third === "=" || third === "!") return true;
  return third === "<" && (source[open + 3] === "=" || source[open + 3] === "!");
}

/** The classes an escape resolves to; anything not here is `any` or a literal. */
const ESCAPE_CLASSES = new Map([
  ["d", DIGIT_CHARS],
  ["w", WORD_CHARS],
  ["s", SPACE_CHARS],
]);
/** The control escapes that are one literal character. */
const ESCAPE_LITERALS = new Map([
  ["n", 10],
  ["t", 9],
  ["r", 13],
  ["f", 12],
  ["v", 11],
  ["0", 0],
]);

/**
 * The atom the escape at `index` denotes, and where the scan resumes.
 *
 * @param {string} source
 * @param {number} index Offset of the `\`.
 * @returns {{node: PatternNode, next: number, code: number|null}} `code` is the
 *   single code point it is, for a caller reading a `[a-z]` range endpoint.
 */
function readEscape(source, index) {
  const ch = source[index + 1];
  const end = index + 2;
  if (ch === undefined) {
    return { node: atomNode(oneChar(92), index, index + 1), next: index + 1, code: 92 };
  }
  const named = ESCAPE_CLASSES.get(ch);
  if (named) return { node: atomNode(named, index, end), next: end, code: null };
  if (ch === "D" || ch === "W" || ch === "S" || ch === "k") {
    return { node: atomNode(ANY_CHARS, index, end, true), next: end, code: null };
  }
  if (ch === "b" || ch === "B") {
    return { node: anchorNode("b", index, end), next: end, code: 8 };
  }
  if (ch === "p" || ch === "P") {
    const close = source.indexOf("}", end);
    const next = source[end] === "{" && close !== -1 ? close + 1 : end;
    return { node: atomNode(ANY_CHARS, index, next, true), next, code: null };
  }
  if (ch >= "1" && ch <= "9") {
    // A backreference matches whatever the group did — a length this model
    // cannot know, so nothing containing one is ever pinned.
    return { node: atomNode(ANY_CHARS, index, end, true), next: end, code: null };
  }
  const literal = ESCAPE_LITERALS.get(ch);
  if (literal !== undefined) {
    return { node: atomNode(oneChar(literal), index, end), next: end, code: literal };
  }
  if (ch === "x" || ch === "u") {
    const hex = readHexEscape(source, index);
    if (hex)
      return { node: atomNode(oneChar(hex.code), index, hex.next), next: hex.next, code: hex.code };
    return { node: atomNode(ANY_CHARS, index, end, true), next: end, code: null };
  }
  const code = ch.codePointAt(0) ?? 0;
  return { node: atomNode(oneChar(code), index, end), next: end, code };
}

/**
 * `\xNN`, `\uNNNN` and `\u{N…}`, or `null` when what follows is not one.
 *
 * @param {string} source
 * @param {number} index Offset of the `\`.
 * @returns {{code: number, next: number}|null}
 */
function readHexEscape(source, index) {
  const kind = source[index + 1];
  const digits = kind === "x" ? 2 : 4;
  if (kind === "u" && source[index + 2] === "{") {
    const close = source.indexOf("}", index + 3);
    if (close === -1) return null;
    const body = source.slice(index + 3, close);
    if (!/^[0-9a-fA-F]+$/.test(body)) return null;
    return { code: Number.parseInt(body, 16), next: close + 1 };
  }
  const body = source.slice(index + 2, index + 2 + digits);
  if (body.length !== digits || !/^[0-9a-fA-F]+$/.test(body)) return null;
  return { code: Number.parseInt(body, 16), next: index + 2 + digits };
}

/**
 * One member of a character class — a literal, an escape, or a class escape —
 * and where the scan resumes.
 *
 * @param {string} source
 * @param {number} index
 * @returns {{chars: CharSet, code: number|null, next: number, opaque: boolean}}
 */
function readClassMember(source, index) {
  if (source[index] === "\\") {
    // `\b` inside a class is a backspace, not a word boundary — the one place
    // an escape means something different in here than out there.
    if (source[index + 1] === "b")
      return { chars: oneChar(8), code: 8, next: index + 2, opaque: false };
    const escape = readEscape(source, index);
    return {
      chars: escape.node.chars,
      code: escape.node.opaque ? null : escape.code,
      next: escape.next,
      opaque: escape.node.opaque,
    };
  }
  const code = source.codePointAt(index) ?? 0;
  return {
    chars: oneChar(code),
    code,
    next: index + String.fromCodePoint(code).length,
    opaque: false,
  };
}

/**
 * The atom the character class starting at `index` denotes.
 *
 * A NEGATED class resolves to `any`: what `[^;]` matches is very nearly every
 * character, and the one question asked of the answer is whether two atoms can
 * overlap — where "very nearly everything" and "everything" give the same
 * verdict for every pattern that is not contrived, and the contrived direction
 * is a refusal.
 *
 * @param {string} source
 * @param {number} index Offset of the `[`.
 * @returns {{node: PatternNode, next: number}}
 */
function readClass(source, index) {
  let i = index + 1;
  let negated = false;
  if (source[i] === "^") {
    negated = true;
    i++;
  }
  /** @type {[number, number][]} */
  const ranges = [];
  let any = false;
  while (i < source.length && source[i] !== "]") {
    const member = readClassMember(source, i);
    i = member.next;
    if (
      member.code !== null &&
      source[i] === "-" &&
      i + 1 < source.length &&
      source[i + 1] !== "]"
    ) {
      const upper = readClassMember(source, i + 1);
      i = upper.next;
      if (upper.code !== null) {
        ranges.push([member.code, upper.code]);
        continue;
      }
      any = any || upper.opaque || upper.chars.any;
      ranges.push(...member.chars.ranges, ...upper.chars.ranges, [45, 45]);
      continue;
    }
    if (member.chars.any || member.opaque) any = true;
    else ranges.push(...member.chars.ranges);
  }
  const end = i < source.length ? i + 1 : i;
  const chars = negated || any ? ANY_CHARS : { any: false, ranges };
  return { node: atomNode(chars, index, end), next: end };
}

/**
 * `source` read as a shape — total, never throwing, and never running
 * anything. Every construct it does not model becomes an `any` atom or an
 * opaque one, both of which only ever make the rules below refuse more.
 *
 * @param {string} source
 * @returns {{root: PatternNode, tooDeep: boolean}}
 */
function parsePattern(source) {
  /** @type {{branches: PatternNode[], items: PatternNode[], start: number, bodyStart: number, look: boolean}[]} */
  const stack = [{ branches: [], items: [], start: 0, bodyStart: 0, look: false }];
  let tooDeep = false;
  let i = 0;

  /** @param {PatternNode} item */
  const push = (item) => stack[stack.length - 1].items.push(item);

  /**
   * @param {{branches: PatternNode[], items: PatternNode[], start: number, bodyStart: number, look: boolean}} frame
   * @param {number} end
   */
  const close = (frame, end) => {
    const tail = seqNode(frame.items, frame.bodyStart, end);
    const body =
      frame.branches.length === 0 ? tail : altNode([...frame.branches, tail], frame.start, end);
    const closed = frame.look ? lookNode(body, frame.start, end) : body;
    // The span is the GROUP's, opening parenthesis included, not the body's:
    // it is what a refusal quotes back, and `a+)+` names nothing a reader can
    // find in their config.
    closed.start = frame.start;
    closed.end = end;
    return closed;
  };

  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      const escape = readEscape(source, i);
      push(escape.node);
      i = escape.next;
      continue;
    }
    if (ch === "[") {
      const parsed = readClass(source, i);
      push(parsed.node);
      i = parsed.next;
      continue;
    }
    if (ch === "(") {
      if (stack.length >= MAX_GROUP_DEPTH) {
        tooDeep = true;
        break;
      }
      const bodyStart = i + 1 + groupPrefixLength(source, i);
      stack.push({ branches: [], items: [], start: i, bodyStart, look: isLookaround(source, i) });
      i = bodyStart;
      continue;
    }
    if (ch === ")") {
      // An unbalanced `)` is a literal here rather than an error: a pattern
      // that is not a valid regular expression at all is reported by
      // `new RegExp` itself a moment later, and reading it as a character can
      // only make this file refuse a pattern that would have been cheap.
      if (stack.length === 1) {
        push(atomNode(oneChar(41), i, i + 1));
        i++;
        continue;
      }
      const frame = /** @type {NonNullable<typeof stack[0]>} */ (stack.pop());
      push(close(frame, i + 1));
      i++;
      continue;
    }
    if (ch === "|") {
      const frame = stack[stack.length - 1];
      frame.branches.push(seqNode(frame.items, frame.bodyStart, i));
      frame.items = [];
      frame.bodyStart = i + 1;
      i++;
      continue;
    }
    if (ch === "^" || ch === "$") {
      push(anchorNode(ch, i, i + 1));
      i++;
      continue;
    }
    if (ch === ".") {
      push(atomNode(ANY_CHARS, i, i + 1));
      i++;
      continue;
    }
    const quantifier = quantifierAt(source, i);
    if (quantifier === null) {
      const code = source.codePointAt(i) ?? 0;
      const width = String.fromCodePoint(code).length;
      push(atomNode(oneChar(code), i, i + width));
      i += width;
      continue;
    }
    let next = i + quantifier.length;
    if (source[next] === "?") next++; // the lazy marker, not a second quantifier
    const frame = stack[stack.length - 1];
    const item = frame.items.pop();
    if (item === undefined) {
      // A quantifier with nothing in front of it is not a valid pattern; read
      // it as the character it is and let `new RegExp` say so.
      push(atomNode(oneChar(source.codePointAt(i) ?? 0), i, i + 1));
      i++;
      continue;
    }
    frame.items.push(
      repNode(
        item,
        quantifier.min,
        quantifier.max,
        source.slice(item.start, next),
        item.start,
        next,
      ),
    );
    i = next;
  }

  while (stack.length > 1) {
    const frame = /** @type {NonNullable<typeof stack[0]>} */ (stack.pop());
    stack[stack.length - 1].items.push(close(frame, source.length));
  }
  return { root: close(stack[0], source.length), tooDeep };
}

/* ------------------------------------------------------------------------ *
 * What a failing match costs, read off that shape
 * ------------------------------------------------------------------------ */

/**
 * A sequence read as the chain it actually runs as: bare groups spliced in, so
 * `^.*x(.*y.*z)$` is five links rather than three with two hidden inside one —
 * and a group that runs AT MOST ONCE spliced in too, because `(?:.*)?x` gives
 * that `.*` exactly the same re-splitting to do as `.*x` does. Measured, that
 * hiding place was worth a factor of the subject's length:
 * `[^/]{2,}.?:{1,4}(?:.*)?x$` costs 7.6 SECONDS against a 1024-character
 * subject of colons.
 *
 * What is NOT spliced in is a group that repeats. Its body is one iteration,
 * Rule 1 has already established that the iterations divide only one way, and
 * re-splitting inside one pinned iteration buys the engine nothing — measured,
 * `^\w+(\.\w+)*$` is 0.0ms against every subject built to defeat it.
 *
 * Splicing an optional group in loses its optionality: its parts read as
 * required here. That direction only ever adds requirements, and a requirement
 * only ever makes this file count MORE repetitions, so the error it can cause
 * is a refusal and never an acceptance.
 *
 * @param {PatternNode} candidate
 * @returns {PatternNode[]}
 */
function flattenSeq(candidate) {
  if (candidate.kind === "rep" && candidate.maxLen !== 0 && candidate.children[0]) {
    return isRepeated(candidate) ? [candidate] : flattenSeq(candidate.children[0]);
  }
  if (candidate.kind !== "seq") return [candidate];
  /** @type {PatternNode[]} */
  const out = [];
  for (const child of candidate.children) out.push(...flattenSeq(child));
  return out;
}

/** Does this repetition run its body more than once? `{0,1}` and `?` do not. */
const isRepeated = (element) => element.kind === "rep" && element.repeats;

/**
 * How many repetitions inside `candidate` a requirement OUTSIDE it can force to
 * try every division — every elastic one, except those sealed inside a group
 * that repeats, whose iterations Rule 1 has already pinned.
 *
 * Counted crudely and upward, because the precise question ("which of these
 * could actually trade text with which") is the one the linear chain answers
 * and an alternation is not a linear chain. Measured, the crude count is what
 * a branch really costs: `.*b?([a-z]([^/]{1,4}|[^/]*))xb?$` — one wildcard
 * outside a two-branch group, each branch holding one more — costs 458ms
 * against a 1024-character subject, and 1.15ms with a `^` in front of it.
 *
 * @param {PatternNode} candidate
 * @returns {number}
 */
function elasticWithin(candidate) {
  if (isRepeated(candidate)) return candidate.elastic ? 1 : 0;
  const inside = candidate.children.map(elasticWithin);
  const worst =
    candidate.kind === "alt" ? Math.max(0, ...inside) : inside.reduce((a, b) => a + b, 0);
  return worst + (candidate.kind === "rep" && candidate.elastic ? 1 : 0);
}

/**
 * Does this element have to match something, and can it fail?
 *
 * `$` is the case the whole calibration turns on. After a repetition that can
 * match every character, `$` cannot fail — the repetition runs to the end of
 * the subject and the anchor succeeds there — so it forces no re-splitting and
 * is not a requirement. After anything else it is one.
 *
 * @param {PatternNode[]} elements
 * @param {number} index
 * @returns {boolean}
 */
function isRequirement(elements, index) {
  const element = elements[index];
  if (element.kind === "anchor") {
    if (element.anchor === "^") return false;
    if (element.anchor === "b") return true;
    const previous = elements[index - 1];
    return !(previous?.kind === "rep" && previous.maxLen === Infinity && previous.chars.any);
  }
  if (element.kind === "look") return true;
  return element.minLen >= 1;
}

/** What an element requires FIRST — `any` for the zero-width ones, which nothing here resolves. */
const requiredFirst = (element) =>
  element.kind === "anchor" || element.kind === "look" ? ANY_CHARS : element.first;

/**
 * Would this verdict refuse the pattern it was computed for? Named once so
 * `resplitDegree`'s branch comparison and `regexComplexityError`'s decision
 * cannot drift into disagreeing about which verdicts are refusals.
 *
 * @param {{degree: number, exempt: boolean}} verdict
 * @returns {boolean}
 */
const isRefused = (verdict) => verdict.degree > MAX_RESPLIT_REPETITIONS && !verdict.exempt;

/**
 * How many repetitions a failing match can be forced to try every division of
 * the subject across — the exponent of the polynomial, read off the shape.
 *
 * A repetition is counted when both halves of the measurement at the top of
 * this file hold for it: something after it can still fail (otherwise the
 * greedy first attempt is the only one), and it can match the same characters
 * as the next thing that must match (otherwise it has one productive division,
 * which is why `a*b*c*d` is cheap and `.*b.*c.*d` is not).
 *
 * @param {PatternNode} candidate
 * @returns {{degree: number, exempt: boolean, delimiter: number|null}}
 */
function resplitDegree(candidate) {
  if (candidate.kind === "alt") {
    // The worst branch, where "worst" is what a REFUSAL turns on rather than
    // the raw number: `^.*\/.*\/.*\/.*$|^a.*a.*a.*z$` has two branches of the
    // same degree, one exempt and one not, and a comparison on the number
    // alone lets whichever came first decide — which is a dangerous
    // alternation accepted because a safe branch stood in front of it. The
    // engine tries every branch, so one costly branch is a costly pattern.
    let worst = { degree: 0, exempt: true, delimiter: /** @type {number|null} */ (null) };
    for (const branch of candidate.children) {
      const found = resplitDegree(branch);
      if (
        isRefused(found)
          ? !isRefused(worst) || found.degree > worst.degree
          : !isRefused(worst) && found.degree > worst.degree
      ) {
        worst = found;
      }
    }
    return worst;
  }
  const elements = flattenSeq(candidate);

  // An unanchored pattern is retried from every position in the subject, and
  // that retry is a factor of the subject's length like any other. Measured on
  // Node v24.16.0 against a 1024-character subject: `a.*b.*c` costs 61ms and
  // `^a.*b.*c` costs 0.29ms; `.*b?([a-z]([^/]{1,4}|[^/]*))xb?$` costs 458ms
  // and the same pattern with `^` in front costs 1.15ms. `mapGlobToRegExp`
  // anchors what it compiles, so no glob pays this.
  const scan = elements[0]?.anchor === "^" ? 0 : 1;

  let last = -1;
  for (let i = 0; i < elements.length; i++) if (isRequirement(elements, i)) last = i;
  if (last < 0) return { degree: scan, exempt: false, delimiter: null };

  /** @type {number[]} */
  const counted = [];
  let hidden = 0;
  for (let i = 0; i < last; i++) {
    const element = elements[i];
    // An alternation is not a chain, so its branches are counted whole: a
    // requirement further along the chain can force every elastic repetition
    // inside the branch that matched, and which branch that is depends on the
    // subject rather than on the pattern.
    if (element.kind === "alt" || element.kind === "look") {
      hidden = Math.max(hidden, elasticWithin(element));
      continue;
    }
    if (element.kind !== "rep" || !element.elastic) continue;
    let next = i + 1;
    while (next <= last && !isRequirement(elements, next)) next++;
    // Two ways for a repetition to be re-splittable, and a repetition that is
    // neither has one productive division and costs nothing. It can trade text
    // with the atom it has to hand over to — `.*` in front of a `/` — or with
    // an elastic NEIGHBOUR, nothing required in between, which is what
    // `[a-z]+b+[a-z]{2,}` is three of: measured, that chain in front of a
    // `\d{2,}` that never matches costs 188ms against a 1024-character subject
    // of `b`s where each of its parts alone costs nothing. `a*b*c*d` is the
    // same shape with none of the overlap, and is quadratic rather than
    // quartic for exactly that reason.
    if (charsOverlap(element.chars, requiredFirst(elements[next]))) counted.push(i);
    else if (tradesWithNeighbour(elements, i, last)) counted.push(i);
  }
  const degree = counted.length + hidden + scan;

  // The single-delimiter exemption: every atom required from the first counted
  // repetition onward is the SAME one character, and a repetition that can
  // match anything follows the last of them. Failure then means the subject is
  // short of that character, and a subject short of it has too few places to
  // try — the argument `MAX_DELIMITED_SEGMENTS` carries, and the reason
  // `^.*\/.*\/.*\/.*$` is free while `^.*c.*c.*c$`, which has no such tail,
  // costs 773ms against a 2000-character subject.
  let delimiter = null;
  let uniform = hidden === 0 && counted.length > 0;
  for (let i = counted[0] ?? 0; uniform && i <= last; i++) {
    if (!isRequirement(elements, i)) continue;
    const element = elements[i];
    const code = element.kind === "rep" || element.kind === "atom" ? loneChar(element.chars) : null;
    if (code === null || element.minLen !== 1 || element.maxLen !== 1) uniform = false;
    else if (delimiter === null) delimiter = code;
    else if (delimiter !== code) uniform = false;
  }
  const absorbs = elements
    .slice(last + 1)
    .some((element) => element.kind === "rep" && element.maxLen === Infinity && element.chars.any);
  const exempt = uniform && absorbs && degree <= MAX_DELIMITED_SEGMENTS;
  return { degree, exempt, delimiter: exempt ? delimiter : null };
}

/**
 * Can the repetition at `index` trade the text it consumes with an elastic
 * repetition beside it — nothing that must match in between, and character
 * sets that overlap?
 *
 * Looked for in both directions, because either neighbour makes the pair a
 * choice point: `[a-z]+b+` divides a run of `b`s any way it likes, and adding
 * a third overlapping repetition adds a whole factor of the subject's length
 * to what a failing tail costs.
 *
 * @param {PatternNode[]} elements
 * @param {number} index
 * @param {number} last Index of the last requirement — nothing past it can
 *   force a retry, so nothing past it is a neighbour worth counting.
 * @returns {boolean}
 */
function tradesWithNeighbour(elements, index, last) {
  const subject = elements[index];
  for (const step of [-1, 1]) {
    for (let i = index + step; i >= 0 && i <= last; i += step) {
      const neighbour = elements[i];
      if (neighbour.kind === "rep" && neighbour.elastic) {
        if (charsOverlap(subject.chars, neighbour.chars)) return true;
      }
      // Anything that must match its own text stands between them, and the
      // pair can no longer shift the boundary past it.
      if (neighbour.minLen >= 1 && !(neighbour.kind === "rep" && neighbour.elastic)) break;
      if (neighbour.kind === "anchor" || neighbour.kind === "look") break;
    }
  }
  return false;
}

/**
 * Why `source` cannot be compiled and run as a regular expression here, or
 * `null`.
 *
 * Two refusals, both structural — read off the pattern's SHAPE, never by
 * running it against a subject and never by timing anything:
 *
 * 1. **A repetition may not be applied to a group that can match the same text
 *    more than one way.** `(a+)+`, `(a*)*`, `(a|aa)+`, `([a-z]+)*` are all the
 *    same defect: the group's own body leaves the engine a choice about where
 *    one iteration ends and the next begins, so a subject that never matches
 *    costs four times more for every two characters it grows. `isPinned`
 *    above carries the three tests that decide it, and the reason it is
 *    ambiguity rather than "there is a quantifier in there" — `^\w+(\.\w+)*$`
 *    has one and is instant, because `\.` and `\w` cannot match the same
 *    character.
 * 2. **At most `MAX_RESPLIT_REPETITIONS` repetitions may be re-split by a
 *    requirement that can fail**, which bounds the polynomial the first rule
 *    does not reach — `resplitDegree` above carries the counting, and the
 *    constants at the top of this file carry the measurement.
 *
 * Both are refusals of a SHAPE, not of a slow run: the criterion is stated
 * here, decided at config load, and identical on every machine — the same
 * discipline `globComplexityError` applies to the fourth dialect at the bottom
 * of this file. A pattern this refuses is not a pattern this engine matches
 * slowly; it is one no run ever starts.
 *
 * The model is deliberately more suspicious than a regex parser: a construct
 * it does not resolve — a negated class, a property escape, a backreference,
 * an unbalanced `)` — becomes "matches anything" or "cannot be pinned", and
 * both of those can only make it refuse a pattern that would have been cheap.
 * A pattern that is not a valid regular expression at all is reported by
 * `new RegExp` itself a moment later.
 *
 * @param {string} source Exactly the string that will be handed to `RegExp`.
 * @returns {string|null}
 */
export function regexComplexityError(source) {
  const { root, tooDeep } = parsePattern(source);
  if (tooDeep) {
    return (
      `nests groups more than ${MAX_GROUP_DEPTH} deep, which this engine reads no further into ` +
      `— past that depth it cannot tell a cheap pattern from one that never returns, and ` +
      `guessing in that direction is how a boundary check stops running. Flatten the groups`
    );
  }
  if (root.problem) return root.problem;
  const verdict = resplitDegree(root);
  return isRefused(verdict) ? resplitReason(verdict.degree) : null;
}

/** The first refusal's message, naming the sub-pattern that earned it. */
function nestedRepetitionReason(offender) {
  return (
    `repeats a group that can match the same text more than one way ('${offender}'), which ` +
    `backtracks exponentially on a subject that does not match: measured on Node v24.16.0 ` +
    `against '(a+)+$', 12ms at a 20-character import specifier, 201ms at 24, 775ms at 26 and ` +
    `12.4 SECONDS at 30 — four times the work for every two characters after that, so 40 ` +
    `characters is hours and 50 is months, from one config value and one specifier this tool ` +
    `does not control. A repeated group has to be pinned: every iteration the same length ` +
    `('(ab)+', '(a|b)+'), or opening with a fixed character that appears nowhere else inside ` +
    `it ('(\\.\\w+)*')`
  );
}

/** The second refusal's message. */
function resplitReason(degree) {
  return (
    `re-splits ${degree} repetitions against a requirement that can fail, more than the ` +
    `${MAX_RESPLIT_REPETITIONS} this engine will run — each one multiplies the work an import ` +
    `specifier that does NOT match costs, and specifiers come from source files this tool does ` +
    `not control (measured on Node v24.16.0: '^a.*a.*a.*z$' costs 190ms against a ` +
    `1000-character specifier and 1.5 seconds against 2000, where '^a.*a.*z$' costs 2.3ms and ` +
    `'^.*-.*-.*$', which ends in a wildcard nothing can fail after, costs 0.0ms at every ` +
    `length). End the pattern in its last wildcard, or narrow it`
  );
}

/**
 * Why `specifier` cannot be matched against a consumer-written pattern, or
 * `null`.
 *
 * The pattern guards above bound the SHAPE; this bounds the subject, and both
 * are needed because the cost is the product. `MAX_SPECIFIER_LENGTH` carries
 * the measurement.
 *
 * @param {string} specifier
 * @returns {string|null}
 */
export function specifierLengthError(specifier) {
  if (specifier.length <= MAX_SPECIFIER_LENGTH) return null;
  return (
    `is ${specifier.length} characters, past the ${MAX_SPECIFIER_LENGTH} this engine will match ` +
    `a boundary pattern against — every pattern that survives config load is still quadratic in ` +
    `the length of a specifier that does not match, and nothing upstream of here bounds that ` +
    `length. It begins '${specifier.slice(0, 60)}'`
  );
}

/**
 * The same bound, as the throw that makes an unjudged site loud.
 *
 * Refusing to match and returning `false` would be the silent direction: no
 * violation reported for a specifier nothing looked at, byte-for-byte a clean
 * site (`../../../../AGENTS.md`). This throws instead, which `cli.mjs check`
 * turns into exit 3 — the run could not complete — the same class a malformed
 * config or a missing graph lands in, and the same thing `../rules/index.mjs`
 * does for a record its analyzer left incomplete.
 *
 * @param {string} specifier
 * @param {string} where What was being matched, for the message.
 * @returns {void}
 */
export function assertMatchableSpecifier(specifier, where) {
  const problem = specifierLengthError(specifier);
  if (problem) throw new Error(`archkeep: the ${where} ${problem}`);
}

/**
 * A refusal by `regexComplexityError`, carrying the half of the message the
 * `…Error` helpers return so a config-load report reads as one sentence about
 * the row rather than an exception quoted inside another exception.
 */
class RegexComplexityError extends Error {
  /**
   * @param {string} reason
   * @param {string} message
   */
  constructor(reason, message) {
    super(message);
    this.name = "RegexComplexityError";
    this.reason = reason;
  }
}

/**
 * `new RegExp(source)`, refused first by `regexComplexityError` — the same
 * arrangement `safeMatchesGlob` has with `globComplexityError` at the bottom
 * of this file, and for the same reason: a caller that skipped config-load
 * validation, or a future one that never validates, still cannot reach the
 * expensive call.
 *
 * @param {string} source
 * @param {string} label What the pattern is and how it was written, for the
 *   thrown message — the compiled `source` is not always what the consumer
 *   typed (`mapGlobToRegExp` maps stars first).
 * @returns {RegExp}
 */
function guardedRegExp(source, label) {
  const problem = regexComplexityError(source);
  if (problem) throw new RegexComplexityError(problem, `archkeep: ${label} ${problem}`);
  return new RegExp(source);
}

/**
 * The reason a `…Error` helper reports for a pattern its matcher threw on:
 * the structural refusal as one sentence, or the compiler's own complaint.
 *
 * @param {unknown} cause
 * @param {string} prefix
 * @returns {string}
 */
function patternReason(cause, prefix) {
  if (cause instanceof RegexComplexityError) return cause.reason;
  return `${prefix}: ${/** @type {Error} */ (cause)?.message ?? cause}`;
}

/**
 * Does `extractedImport` match the wildcard pattern `allowableImport`?
 *
 * Port of `matchImportWithWildcard` in `@nx/eslint-plugin`'s
 * `utils/runtime-lint-utils`. The final branch is a bare, unanchored RegExp —
 * that is upstream's behaviour and the reason `allow` entries are far broader
 * than they read.
 *
 * The subject is bounded here rather than in the branch that compiles one:
 * this is a door a specifier arrives at, and one rule about what may come
 * through a door is easier to hold than four rules about what each branch does
 * with it.
 *
 * @param {string} allowableImport May contain `*`; may be a regular expression.
 * @param {string} extractedImport The raw specifier, as written.
 * @returns {boolean}
 * @throws {Error} when `extractedImport` is past `MAX_SPECIFIER_LENGTH`.
 */
export function matchImportWithWildcard(allowableImport, extractedImport) {
  assertMatchableSpecifier(
    extractedImport,
    `specifier matched against import pattern '${allowableImport}'`,
  );
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
    return guardedRegExp(allowableImport, `import pattern '${allowableImport}'`).test(
      extractedImport,
    );
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
  // Guarded on the ANCHORED source, which is exactly what gets run — not on
  // the raw spelling, which would refuse `@scope/**` for carrying two stars
  // where the engine sees one `.*`, and not on the intermediate either: the
  // anchors are half of what makes a glob cheap. `^…$` is the difference
  // between a last wildcard nothing can fail after and one a start position
  // can be retried in front of, which is the difference between 0.0ms and
  // seconds (`MAX_RESPLIT_REPETITIONS`). Compiling the intermediate first is
  // upstream's own double construction — it normalises the source, escaping
  // `/` — and compiling never runs anything.
  const source = new RegExp(mappedWildcards).source;
  return guardedRegExp(`^${source}$`, `glob pattern '${importDefinition}'`);
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
    const regex = guardedRegExp(tag.substring(1, tag.length - 1), `tag pattern '${tag}'`);
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
    return patternReason(cause, "is not a valid import pattern");
  }
}

/** Why `pattern` cannot serve as an external-import glob, or `null`. */
export function globPatternError(pattern) {
  try {
    mapGlobToRegExp(pattern);
    return null;
  } catch (cause) {
    return patternReason(cause, "is not a valid import glob");
  }
}

/** Why `tag` cannot serve as a constraint tag, or `null`. */
export function tagPatternError(tag) {
  try {
    tagMatches([], tag);
    return null;
  } catch (cause) {
    return patternReason(cause, "is not a valid tag pattern");
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
      throw new Error(`archkeep: project pattern '${stringPattern}' ${unsupported}`);
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
 * edits `archkeep.json` or the boundary config (`../../../../SECURITY.md`), so a
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
  if (problem) throw new Error(`archkeep: glob pattern '${pattern}' ${problem}`);
  return posix.matchesGlob(path, pattern);
}
