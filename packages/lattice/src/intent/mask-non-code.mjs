/**
 * Position-preserving masker: returns a string the same length as `src` where
 * every non-code region (comments, string literals, template literals, regex
 * literals) is replaced with spaces and every code character is kept in place.
 *
 * Same length is the contract: `match.index` in the result is the byte offset
 * in the original `src`, so a guard can map a hit back to the exact `file:line`
 * in the source. The guard exists to name the site of a violation; a
 * position-preserving mask is what makes that naming exact.
 *
 * Deliberately single-pass and heuristic rather than a full tokenizer: it is a
 * gate on raw `Date.now()`/`Math.random()`/`new Date()` and `localeCompare`,
 * and for that purpose it only needs the classifier "is this position inside a
 * comment/string/template/regex". These are the shapes the seam must recognize
 * and their failure modes, each pinned by `intent.test.mjs`'s Contract K guard
 * running against the shipped tree it is a part of:
 *
 *  - A `//` inside a string (e.g. `"https://"`) is never misread as a comment
 *    because the string branch runs first and consumes the whole literal.
 *  - A `'` or `"` inside a template expression is skipped by the template
 *    branch's own intra-`${}` scan, which tracks nested strings, templates,
 *    and brackets, so a `}` inside a string (e.g. `${ map["}"] }`) never
 *    ends the interpolation early.
 *  - A division `/` after a `)` is not a regex; the regex branch keys off a
 *    leading operator character, the same heuristic `stripStrings` has used
 *    beside it since before the R7 extraction.
 *
 * Regex literals are also masked so a pattern that spells out `Date.now()` in
 * source does not trip the wall-clock guard it documents.
 *
 * Deliberate simplification marked `ponytail:` — template expressions are
 * scanned to the depth of nested `${`, but a template expression that contains
 * a COMMENT is read past using only the string/template/bracket skip below
 * (no comment handling inside `${}`); a comment star-slash pair inside a
 * template expression swallows to the next one. That is a comment-containing
 * `${}` inside a template literal, which no production module here uses; it
 * would only ever
 * noise the mask (never a silent pass of a raw `Date.now()` after it, since
 * the swallow is still a mask that cannot name a real read a reader cannot
 * see). Convert to a full tokenizer when a production module needs it.
 */
/**
 * Scans a template literal starting just after its opening backtick and
 * returns the index of that opening backtick's matching close.
 *
 * `${` opens an interpolation expression; inside one, `}` closes it only
 * while that expression is open (a `}` inside a nested string or nested
 * template is consumed by that sub-scan and never decrements the open
 * interpolation). Nested template literals inside an interpolation are
 * scanned by this same function recursively. The backtick that closes the
 * literal is found only at interpolation depth zero.
 *
 * Mirrors the structure of `maskNonCode` for the regions it can contain, so
 * a `}` inside `${ map["}"] }` or `${ `inner${v}` }` does not end the
 * expression early. `ponytail:` — a comment inside an interpolation is not
 * handled here (no comment skip there); a comment-containing `${}` inside a
 * template literal would noise the mask, never silently pass a raw read
 * after it. A full tokenizer is the upgrade when a production module needs
 * that shape.
 *
 * @param {string} src Source text.
 * @param {number} i Index just past the opening backtick.
 * @returns {number} Index of the closing backtick.
 */
function scanTemplate(src, i) {
  let j = i;
  let depth = 0;
  while (j < src.length) {
    if (src[j] === "\\") {
      j += 2;
      continue;
    }
    if (src[j] === "$" && src[j + 1] === "{") {
      depth++;
      j += 2;
      continue;
    }
    if (depth === 0) {
      // Template text: only the backtick (and interpolation) matters.
      if (src[j] === "`") return j;
      j++;
      continue;
    }
    // Inside an interpolation expression.
    if (src[j] === "`") {
      // Nested template: it closes at its own depth-zero backtick.
      j = scanTemplate(src, j + 1) + 1;
      continue;
    }
    if (src[j] === "'") {
      j++;
      while (j < src.length && src[j] !== "'") {
        if (src[j] === "\\") j += 2;
        else j++;
      }
      if (j < src.length) j++;
      continue;
    }
    if (src[j] === '"') {
      j++;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\") j += 2;
        else j++;
      }
      if (j < src.length) j++;
      continue;
    }
    if (src[j] === "/") {
      // Regex inside an interpolation expression, else division: `/re/`
      // starts after an operator/opening char; division after an operand is
      // just an expression char.
      const prev = src[j - 1];
      if (prev === undefined || /[=([{,:;!&|?+\-*%^~<>]/.test(prev)) {
        let k = j + 1;
        let inClass = false;
        while (k < src.length && (inClass || src[k] !== "/")) {
          if (src[k] === "\\") {
            k += 2;
            continue;
          }
          if (src[k] === "[") inClass = true;
          else if (src[k] === "]") inClass = false;
          k++;
        }
        if (k < src.length) j = k + 1;
        else j = k;
        continue;
      }
    }
    if (src[j] === "}" && depth > 0) {
      depth--;
      j++;
      continue;
    }
    j++;
  }
  return j;
}

/**
 * Whether the `/` at `src[i]` opens a regex literal rather than a division —
 * decided from the last SIGNIFICANT character before it, skipping over any
 * run of spaces/tabs first. Checking only the immediately-previous character
 * (as this used to) misreads a normally-spaced regex like `= /re/` as
 * division, because the character right before the slash is a space rather
 * than the leading `=`; read as division the slash is left unmasked, and a
 * `'`/`"` inside the pattern (e.g. `/don't/`) then opens the string-mask
 * branch on real code that follows, silently swallowing it.
 *
 * @param {string} src
 * @param {number} i Index of the `/`.
 * @returns {boolean}
 */
function isRegexPosition(src, i) {
  let p = i - 1;
  while (p >= 0 && (src[p] === " " || src[p] === "\t")) p--;
  const prevChar = p < 0 ? undefined : src[p];
  return prevChar === undefined || /[=([{}!|&?:;,~^<>+\-*/%\n]/.test(prevChar);
}

export function maskNonCode(src) {
  let result = "";
  let i = 0;
  while (i < src.length) {
    // Single-line comment. The trailing `\n` (when there is one) is kept as a
    // literal newline rather than folded into the run of spaces: dropping it
    // shortens the masked result by one character per comment, which breaks
    // the same-length contract this header promises — every `match.index`
    // after the comment would then point one byte too early in `src`, and a
    // consumer computing a line number from that offset would land on the
    // wrong line (the determinism guard's regression: a `Date.now()` right
    // after an allow-listed line silently inheriting that line's exemption).
    if (src[i] === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      if (end === -1) {
        result += " ".repeat(src.length - i);
        i = src.length;
      } else {
        result += " ".repeat(end - i) + "\n";
        i = end + 1;
      }
      continue;
    }
    // Block comment
    if (src[i] === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const to = end === -1 ? src.length : end + 2;
      result += " ".repeat(to - i);
      i = to;
      continue;
    }
    // Single-quoted string
    if (src[i] === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== "'") {
        if (src[j] === "\\") j++;
        j++;
      }
      result += " ".repeat(Math.min(j + 1, src.length) - i);
      i = j + 1;
      continue;
    }
    // Double-quoted string
    if (src[i] === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\") j++;
        j++;
      }
      result += " ".repeat(Math.min(j + 1, src.length) - i);
      i = j + 1;
      continue;
    }
    // Template literal. `${` opens an interpolation; `}` closes one only when
    // an interpolation is open (a literal `}` in template text, or a `}`
    // inside a nested string/template that the inner scan consumed, never
    // decrements into the negative). The closing backtick ends the literal.
    if (src[i] === "`") {
      const j = scanTemplate(src, i + 1);
      result += " ".repeat(Math.min(j + 1, src.length) - i);
      i = j + 1;
      continue;
    }
    // Regex literal (simplified: /pattern/flags) — keyed off a leading
    // operator so a division after an identifier is not a regex; see
    // `isRegexPosition` for why whitespace before the `/` is skipped first.
    if (src[i] === "/" && isRegexPosition(src, i)) {
      let j = i + 1;
      while (j < src.length && src[j] !== "/") {
        if (src[j] === "\\") {
          j++;
          j++;
          continue;
        }
        if (src[j] === "[") {
          j++;
          while (j < src.length && src[j] !== "]") {
            if (src[j] === "\\") j++;
            j++;
          }
        }
        j++;
      }
      let end = j + 1;
      while (end < src.length && /[gimsuy]/.test(src[end])) end++;
      result += " ".repeat(end - i);
      i = end;
      continue;
    }
    result += src[i];
    i++;
  }
  return result;
}
