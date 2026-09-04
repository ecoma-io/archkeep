/**
 * Position-preserving masker: returns a string the same length as `src` where
 * every non-code region (comments, string literals, template literals, regex
 * literals) is replaced with spaces and every code character is kept in place.
 * Newlines survive the blanking, so line N of the result is line N of `src`.
 *
 * Same length is the contract: `match.index` in the result is the byte offset
 * in the original `src`, so a guard can map a hit back to the exact `file:line`
 * in the source. The guard exists to name the site of a violation; a
 * position-preserving mask is what makes that naming exact.
 *
 * **The two ways this can be wrong are not equal, and every decision below is
 * settled by that.** Masking a region that was really code hides whatever it
 * held from every guard that scans the result, and a hidden `Date.now()` is
 * byte-for-byte indistinguishable from a module that never had one — the
 * silent direction `../../../../AGENTS.md` is written against. Leaving a
 * region unmasked that was really a literal costs at most a spurious hit,
 * which someone reads and disputes. So where this scanner cannot decide it
 * declines to mask: **every scan below refuses rather than masking when it
 * cannot find its own close**, and refusing leaves the opening character
 * standing as ordinary code. Two of the four constructs cannot cross an
 * unescaped newline (a string literal, a regex literal), so the newline is
 * their bound; the other two legally can (a template literal, a block
 * comment), so end of input is theirs and reaching it means the lexer lost
 * sync rather than that the construct was long. A `//` comment is the one
 * region with no close to miss — end of line and end of input both legitimately
 * end it — so it is the one scan with nothing to refuse. A scan that masked to end of input on losing sync
 * would blank the rest of the file — the silent direction, and measured: a
 * regex literal holding a backtick, left unmasked because `)` was read as an
 * operand, put that backtick in code position, and the template scan it opened
 * ran to end of input and blanked every line after it.
 *
 * Deliberately a small hand-written lexer rather than a parser: it is a gate
 * on raw `Date.now()`/`Math.random()`/`new Date()` and `localeCompare`, and
 * for that it only needs the classifier "is this position inside a
 * comment/string/template/regex". The one thing it does need a real answer to
 * is regex-versus-division, because that is the single decision where being
 * wrong is silent — which is why `scanCodeToken` and the `prev` token class
 * below exist instead of the previous-character test they replace.
 *
 * The measured failure that shape could not survive: the old branch keyed the
 * decision off the last non-space CHARACTER, so the `/` in
 * `src/workspace.mjs`'s `return /('|")?exposes('|")?:/.test(config);` was
 * judged against the `n` of `return` and read as division. The regex was left
 * unmasked, the apostrophe inside it opened the string branch — which had no
 * newline stop — and everything from there to end of file was blanked: 83.5%
 * of that module's non-space characters, with the masked result coming out one
 * byte LONGER than its source on top of it. Every wall-clock read in that tail
 * scanned clean.
 *
 * These are the shapes the seam must recognize and their failure modes, each
 * pinned by `mask-non-code.test.mjs` and by `intent.test.mjs`'s Contract K
 * guard running against the shipped tree it is a part of:
 *
 *  - A `//` inside a string (e.g. `"https://"`) is never misread as a comment
 *    because the string branch runs first and consumes the whole literal.
 *  - A `'` or `"` inside a template expression is skipped by the template
 *    branch's own intra-`${}` scan, which tracks nested strings, templates,
 *    comments, and brace depth, so a `}` inside a string (e.g. `${ map["}"] }`)
 *    or inside an object literal (`${ {a: 1} }`) never ends the interpolation
 *    early.
 *  - A division `/` after a `]`, an identifier, a numeric literal or a
 *    `++`/`--` is not a regex, and a `/` after an operator, a `(`, a `,`, a
 *    `{`/`}`, a `;` or one of the keywords that can only be followed by an
 *    expression (`return`, `typeof`, `case`, `throw`, …) is. That is the whole
 *    of the regex/division rule, and it reads the previous TOKEN rather than
 *    the previous character.
 *  - A keyword is only a keyword in KEYWORD POSITION. Every word in the set
 *    below is also a legal property name — `mod.default`, `Array.of`,
 *    `obj.in` — so `mod.default / 2` is a division. The rule is general
 *    rather than a list of the ones that turned up:
 *    a name directly after `.` or `?.` is a PROPERTY and carries no keyword
 *    identity at all, which is also why a private name (`this.#default`) is
 *    scanned as one token. Reading `mod.default` as the keyword put the `/`
 *    after it in operator position, and the regex scan that opened blanked
 *    `Date.now()` out of `const q = mod.default / 2 + Date.now() / 3;`.
 *  - A `)` is classified by the `(` it closes, not by being a `)`. A paren
 *    opened directly after `if`, `while`, `for`, `switch`, `catch` or `with`
 *    IN KEYWORD POSITION heads a control structure, and what follows its `)`
 *    is a statement — where a `/` can only be a regex, since no statement may
 *    begin with a division. Every other `)` ends a value, so a `/` after it
 *    divides. The stack that answers this is one boolean per open paren, and
 *    it is the whole reason `if (x) /re/.test(y)` no longer leaves a regex in
 *    code position (`a.if(x) / 2` still divides: property, not keyword).
 *
 * Regex literals are also masked so a pattern that spells out `Date.now()` in
 * source does not trip the wall-clock guard it documents.
 *
 * Three residual limits, stated so a reader can tell a limit from a bug. The
 * first two can only over-report; the third cannot, and is called out as the
 * one place this file still answers in the silent direction:
 *
 *  - `}` is read as an operator, so a division right after an object literal
 *    (`({a: 1} / 2)`) would start a regex scan. That scan stops at the end of
 *    the line unless a second `/` appears on it, so the blast radius is one
 *    line rather than the rest of the file. Deciding `}` needs to know whether
 *    the brace closed a block or a value, which needs a parser — the paren
 *    stack above is affordable only because a control head sits one token in
 *    front of its `(`, and a `{` has no such marker.
 *  - A block comment that never closes is not masked at all: the scan refuses,
 *    the `/` falls back to the code arm, and the comment's prose is read as
 *    code from there. It can only over-report, and it is unreachable from
 *    valid JavaScript, where an opened block comment always closes.
 *  - **A template literal is masked whole, its interpolations included.** A
 *    `${Date.now()}` inside one is real code, blanked, and invisible to the
 *    guard that scans this result — the silent direction. This is a limit of
 *    the region model rather than of the lexer: `scanTemplate` already walks
 *    every interpolation and knows where each begins and ends, so closing it
 *    means having that scan report the text runs it masks instead of the one
 *    span from backtick to backtick that `maskNonCode` masks today. Measured
 *    on the shipped tree: no production module spells a forbidden read inside
 *    an interpolation, so no guard verdict turns on it right now — which is
 *    precisely how it would rot unnoticed.
 */

/**
 * The class of the previous significant token — the only thing the
 * regex/division decision turns on.
 *
 * `operand` is anything a value can end with (identifier, keyword that is a
 * value, numeric literal, string, template, regex, a call's `)`, `]`, `++`,
 * `--`): a `/` after one of those divides. `operator` is everything else,
 * including program start: a `/` there opens a regex literal. `member` is the
 * `.` of a member access, an operator that additionally tells the NEXT token
 * it is a property name rather than whatever keyword it may spell — the whole
 * of the keyword-position rule, and the reason this is three values and not a
 * boolean.
 *
 * @typedef {"operand" | "operator" | "member"} TokenKind
 */

/**
 * The lexer state the regex/division decision reads, threaded through one
 * token scan at a time.
 *
 * `keyword` is the KEYWORD IDENTITY of the last significant token: its text
 * when it was an identifier in keyword position, and `""` for everything else
 * — punctuation, numbers, masked literals, and a name after `.`, which is a
 * property and spells no keyword. Only `(` reads it, and only to ask whether
 * the paren it is opening heads a control structure.
 *
 * `parens` carries one boolean per open paren, `true` when that paren was a
 * control structure's head. `)` pops it to decide whether it ended a value or
 * a condition. A pop on an empty stack answers `false` (operand), which is the
 * conservative half: it can only leave a regex unmasked.
 *
 * @typedef {{ prev: TokenKind, keyword: string, parens: boolean[] }} CodeState
 */

/**
 * @returns {CodeState} Program start, which is operator position: a file whose
 *   first token is a regex literal masks it.
 */
function createCodeState() {
  return { prev: "operator", keyword: "", parens: [] };
}

/**
 * Records that a complete VALUE was just consumed — a string, template or
 * regex literal the caller masked, or a nested one a sub-scan skipped. A `/`
 * after any of those divides, and none of them carries a keyword identity.
 *
 * @param {CodeState} state Mutated in place.
 * @returns {void}
 */
function markOperand(state) {
  state.prev = "operand";
  state.keyword = "";
}

/**
 * Keywords after which a `/` can only begin a regex literal, because each one
 * must be followed by an expression and none of them is a value itself.
 *
 * `this`, `super`, `true`, `false` and `null` are deliberately absent: they
 * have identifier shape and ARE values, so `/` after them is division.
 */
const EXPRESSION_KEYWORDS = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "delete",
  "void",
  "instanceof",
  "new",
  "do",
  "else",
  "yield",
  "await",
  "throw",
  "default",
]);

/**
 * Keywords whose parenthesized head belongs to a CONTROL STRUCTURE rather than
 * to a call, so that what follows the closing `)` is a statement.
 *
 * A statement cannot begin with a division — `/` there can only open a regex
 * literal — which is what makes this decidable without a parser: the whole
 * question is whether the `(` was preceded by one of these six in keyword
 * position, and that is one token of lookbehind rather than a grammar.
 * `switch`, `catch` and `with` can only be followed by `{`, so they change no
 * verdict on their own; they are listed because leaving them out would make
 * the set a list of the cases that came up rather than the rule.
 */
const CONTROL_HEADS = new Set(["if", "while", "for", "switch", "catch", "with"]);

/**
 * Character classes by code unit rather than by `RegExp.test` per character.
 *
 * This masker is run over every production module in the tree on every
 * invocation of the determinism guard, so the per-character classification is
 * the whole cost of the scan; a regex call per character puts it in seconds
 * where these put it in milliseconds. `code > 127` counts as identifier
 * material because the main loop tests whitespace FIRST — anything non-ASCII
 * left over is part of a name, and ending an identifier run early would put a
 * following `/` in operator position and mask a division.
 *
 * @param {number} code
 * @returns {boolean}
 */
function isSpaceCode(code) {
  return code === 32 || (code >= 9 && code <= 13) || code === 0xa0 || code === 0xfeff;
}

/**
 * @param {number} code
 * @returns {boolean}
 */
function isIdentifierStart(code) {
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    code === 95 ||
    code === 36 ||
    code > 127
  );
}

/**
 * @param {number} code
 * @returns {boolean}
 */
function isDigit(code) {
  return code >= 48 && code <= 57;
}

/**
 * Replaces every character with a space, except newlines, which are kept so
 * the masked result keeps the source's line structure. Indexed by code UNIT
 * rather than iterated with `for…of`, which walks code POINTS and would
 * collapse a surrogate pair into a single space — one byte short, and the
 * same-length contract broken by a literal containing an emoji.
 *
 * @param {string} text
 * @returns {string}
 */
function blank(text) {
  return text.replace(/[^\n]/g, " ");
}

/**
 * Scans a single- or double-quoted string starting at its opening quote.
 *
 * A JavaScript string literal cannot contain a RAW newline — only an escaped
 * one (a `\` immediately before it, the line continuation), which the escape
 * skip below consumes. So an unescaped newline before the closing quote means
 * this was never a string literal, and the scan refuses rather than masking to
 * end of file. That refusal is the second line of defence behind the token
 * classifier: the measured failure in this file's header needed BOTH a regex
 * read as division AND a string scan with nothing to stop it, and this is the
 * half that caps the damage of any future misread at a single line.
 *
 * @param {string} src
 * @param {number} i Index of the opening quote.
 * @returns {number} Index just past the closing quote, or `-1` when the
 *   literal does not close on its own line.
 */
function scanQuoted(src, i) {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "\n") return -1;
    if (c === quote) return j + 1;
    j++;
  }
  return -1;
}

/**
 * Scans a regex literal starting at its opening `/`, flags included.
 *
 * A character class may hold an unescaped `/` (`/[/]/`), which is why `inClass`
 * exists; a regex literal may not hold an unescaped newline, which is why the
 * scan gives up at one rather than running to end of file. Giving up means the
 * caller keeps the `/` as code — the loud direction.
 *
 * @param {string} src
 * @param {number} i Index of the opening `/`.
 * @returns {number} Index just past the closing `/` and its flags, or `-1`
 *   when the literal does not close on its own line.
 */
function scanRegex(src, i) {
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "\n") return -1;
    if (inClass) {
      if (c === "]") inClass = false;
    } else if (c === "[") {
      inClass = true;
    } else if (c === "/") {
      let end = j + 1;
      while (end < src.length && /[dgimsuvy]/.test(src[end])) end++;
      return end;
    }
    j++;
  }
  return -1;
}

/**
 * Consumes the one CODE token starting at `src[i]`, advancing `state` to what
 * a following `/` should be read as. Callers consume comments, strings,
 * templates and regex literals before reaching here, so this only ever sees
 * identifiers, private names, numeric literals and punctuation.
 *
 * @param {string} src
 * @param {number} i Index of the token's first character.
 * @param {CodeState} state Mutated in place.
 * @returns {number} Index just past the token.
 */
function scanCodeToken(src, i, state) {
  const c = src[i];
  const code = src.charCodeAt(i);
  // Read the incoming keyword identity before any arm below overwrites it: the
  // `(` arm is asking about the token BEFORE it, not about itself.
  const previousKeyword = state.keyword;
  // A private name is one token (`#count`), and never a keyword: `#default` is
  // a legal field name, because a private name is `#` + any IdentifierName.
  const isPrivateName = c === "#" && isIdentifierStart(src.charCodeAt(i + 1));
  if (isPrivateName || isIdentifierStart(code)) {
    let j = i + 1;
    while (j < src.length) {
      const next = src.charCodeAt(j);
      if (!isIdentifierStart(next) && !isDigit(next)) break;
      j++;
    }
    // Keyword position, and the general rule the header argues: a name reached
    // through `.` or `?.` is a PROPERTY, so it spells no keyword at all —
    // `mod.default`, `Array.of`, `obj.in`, `a?.default` are names, and the `/`
    // after one of them divides.
    const keyword = state.prev === "member" || isPrivateName ? "" : src.slice(i, j);
    state.keyword = keyword;
    state.prev = EXPRESSION_KEYWORDS.has(keyword) ? "operator" : "operand";
    return j;
  }
  state.keyword = "";
  if (isDigit(code)) {
    // One run covers every numeric spelling that matters here — `0x1f`, `1e5`,
    // `1_000`, `1.5`, `10n` — because the only question asked of it is where
    // the literal ends, never what it is worth.
    let j = i + 1;
    while (j < src.length) {
      const next = src.charCodeAt(j);
      if (!isIdentifierStart(next) && !isDigit(next) && next !== 46) break;
      j++;
    }
    state.prev = "operand";
    return j;
  }
  if (c === ".") {
    // The `.` of a member access — and of `?.`, whose `?` is scanned as its
    // own operator token just before it. `...` reaches here three times, which
    // makes the name after a spread a property too: that only ever turns a
    // keyword into an operand, and an operand can only leave a `/` unmasked.
    state.prev = "member";
    return i + 1;
  }
  if (c === "(") {
    state.parens.push(CONTROL_HEADS.has(previousKeyword));
    state.prev = "operator";
    return i + 1;
  }
  if (c === ")") {
    state.prev = state.parens.pop() === true ? "operator" : "operand";
    return i + 1;
  }
  if (c === "]") {
    state.prev = "operand";
    return i + 1;
  }
  if ((c === "+" || c === "-") && src[i + 1] === c) {
    state.prev = "operand";
    return i + 2;
  }
  state.prev = "operator";
  return i + 1;
}

/**
 * Scans a template literal starting just after its opening backtick and
 * returns the index of that opening backtick's matching close.
 *
 * `${` opens an interpolation expression; inside one, `}` closes a brace level
 * only while one is open, and a `{` opened inside the expression (an object
 * literal, a block-bodied arrow) opens one of its own, so `${ {a: 1} }` no
 * longer ends at the object's closing brace. A `}` inside a nested string,
 * comment or template is consumed by that sub-scan and never counts at all.
 * Nested template literals inside an interpolation are scanned by this same
 * function recursively. The backtick that closes the literal is found only at
 * depth zero.
 *
 * Mirrors the region set `maskNonCode` recognizes — including the same
 * previous-token regex/division rule, so a `${ x.replace(/'/g, "") }` inside a
 * template does not end the interpolation somewhere a reader cannot see. It
 * differs only in producing an index rather than masked text.
 *
 * A template literal legally spans newlines, so the newline that bounds
 * `scanQuoted` and `scanRegex` is not available here: end of input is the only
 * bound, and reaching it means this scan never found a close. It then DECLINES
 * — the same answer those two give — because masking to end of input is the
 * silent direction, and a backtick that opened nothing is exactly the shape a
 * lost-sync lexer produces. The caller keeps the backtick as code, so the cost
 * of a misread here is nothing blanked at all.
 *
 * @param {string} src Source text.
 * @param {number} i Index just past the opening backtick.
 * @returns {number} Index of the closing backtick, or `-1` when the literal
 *   never closes.
 */
function scanTemplate(src, i) {
  let j = i;
  let depth = 0;
  const state = createCodeState();
  while (j < src.length) {
    const c = src[j];
    if (depth === 0) {
      // Template text: only an escape, an interpolation, and the closing
      // backtick mean anything.
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "$" && src[j + 1] === "{") {
        depth++;
        state.prev = "operator";
        state.keyword = "";
        j += 2;
        continue;
      }
      if (c === "`") return j;
      j++;
      continue;
    }
    // Inside an interpolation expression.
    if (c === "/" && src[j + 1] === "/") {
      const nl = src.indexOf("\n", j);
      // A line comment running to end of input inside an interpolation is a
      // template that never closes — the same verdict as falling out of the
      // loop below, reached one step earlier.
      if (nl === -1) return -1;
      j = nl + 1;
      continue;
    }
    if (c === "/" && src[j + 1] === "*") {
      const end = src.indexOf("*/", j + 2);
      if (end === -1) return -1;
      j = end + 2;
      continue;
    }
    if (c === "`") {
      // Nested template: it closes at its own depth-zero backtick. A nested
      // one that never closes means this one cannot close either — there is no
      // backtick left in the file for it — so the refusal propagates outward
      // rather than being turned into an index by a `+ 1` on `-1`.
      const close = scanTemplate(src, j + 1);
      if (close === -1) return -1;
      j = close + 1;
      markOperand(state);
      continue;
    }
    if (c === "'" || c === '"') {
      const end = scanQuoted(src, j);
      if (end !== -1) {
        j = end;
        markOperand(state);
        continue;
      }
    }
    if (c === "/" && state.prev !== "operand") {
      const end = scanRegex(src, j);
      if (end !== -1) {
        j = end;
        markOperand(state);
        continue;
      }
    }
    if (c === "{") {
      depth++;
      state.prev = "operator";
      state.keyword = "";
      j++;
      continue;
    }
    if (c === "}") {
      depth--;
      markOperand(state);
      j++;
      continue;
    }
    if (isSpaceCode(src.charCodeAt(j))) {
      j++;
      continue;
    }
    j = scanCodeToken(src, j, state);
  }
  return -1;
}

/**
 * @param {string} src Source text.
 * @returns {string} `src` with every non-code region blanked, same length,
 *   same line structure.
 */
export function maskNonCode(src) {
  // used by its own test
  /**
   * Chunks of the result, joined once at the end. Code is copied through in
   * RUNS rather than a token at a time — `plainFrom` is where the current
   * unmasked run began, and only a masked region flushes it.
   * @type {string[]}
   */
  const parts = [];
  let plainFrom = 0;
  let i = 0;
  /** The lexer state the regex/division decision reads. */
  const state = createCodeState();
  /**
   * Blanks `src[from…to)` into the result, flushing whatever code preceded it.
   * @param {number} from
   * @param {number} to
   */
  const mask = (from, to) => {
    if (plainFrom < from) parts.push(src.slice(plainFrom, from));
    parts.push(blank(src.slice(from, to)));
    plainFrom = to;
  };
  while (i < src.length) {
    const c = src[i];
    // Single-line comment, blanked up to but NOT including its newline: the
    // newline is copied through as code, which is what keeps the masked result
    // the same length as the source AND on the same lines. Dropping it would
    // move every `match.index` after the comment one byte early, and a
    // consumer computing a line number from that offset would land on the
    // wrong line (the determinism guard's regression: a `Date.now()` right
    // after an allow-listed line silently inheriting that line's exemption).
    //
    // `prev` is deliberately left alone here and in the block-comment arm: a
    // comment is not a token, so `return // why\n/re/.test(x)` still sees
    // `return` and still masks the regex.
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      const to = nl === -1 ? src.length : nl;
      mask(i, to);
      i = to;
      continue;
    }
    // Block comment. A block comment legally spans newlines, so like the
    // template below it has no bound short of end of input — and one that
    // never closes is not a comment this scanner can trust, so it refuses
    // instead of blanking the rest of the file. The `/` then falls through to
    // the code arm and the prose after it is read as code, which can only
    // over-report.
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end !== -1) {
        mask(i, end + 2);
        i = end + 2;
        continue;
      }
    }
    // String literal. An opening quote with no closer on its line was not a
    // string at all, so the character falls through to the code arm and the
    // rest of the line stays visible to whatever scans this.
    if (c === "'" || c === '"') {
      const end = scanQuoted(src, i);
      if (end !== -1) {
        mask(i, end);
        i = end;
        markOperand(state);
        continue;
      }
    }
    // Template literal. `${` opens an interpolation and `}` closes a brace
    // level; see `scanTemplate` for what it tracks in between, and for why a
    // literal that never closes is declined here rather than masked to end of
    // input. Declining drops the backtick to the code arm below.
    if (c === "`") {
      const close = scanTemplate(src, i + 1);
      if (close !== -1) {
        mask(i, close + 1);
        i = close + 1;
        markOperand(state);
        continue;
      }
    }
    // Regex literal — only outside operand position, and only when it closes
    // on its own line. Both refusals leave the `/` as code.
    if (c === "/" && state.prev !== "operand") {
      const end = scanRegex(src, i);
      if (end !== -1) {
        mask(i, end);
        i = end;
        markOperand(state);
        continue;
      }
    }
    // Whitespace is not a token: it is copied through and leaves `prev` alone,
    // so `= /re/` and `=/re/` reach the same verdict.
    if (isSpaceCode(src.charCodeAt(i))) {
      i++;
      continue;
    }
    i = scanCodeToken(src, i, state);
  }
  parts.push(src.slice(plainFrom));
  return parts.join("");
}
