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
export function maskNonCode(src) {
  let result = "";
  let i = 0;
  while (i < src.length) {
    // Single-line comment
    if (src[i] === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      result += " ".repeat((end === -1 ? src.length : end) - i);
      i = end === -1 ? src.length : end + 1;
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
    // inside a nested string/`${}` that the inner scan consumed, never
    // decrements into the negative). The closing backtick ends the literal.
    if (src[i] === "`") {
      let j = i + 1;
      let depth = 0;
      while (j < src.length) {
        if (src[j] === "\\") {
          j++;
          j++;
          continue;
        }
        if (src[j] === "$" && src[j + 1] === "{") {
          depth++;
          j += 2;
          continue;
        }
        if (depth === 0) {
          // Template text: only the backtick (and interpolation) matters.
          if (src[j] === "`") break;
          j++;
          continue;
        }
        // Inside an interpolation expression.
        if (src[j] === "`") {
          // Nested template: scan it to its closing backtick, recursively.
          j++;
          let nestedDepth = 0;
          while (j < src.length) {
            if (src[j] === "\\") {
              j += 2;
              continue;
            }
            if (src[j] === "$" && src[j + 1] === "{") {
              nestedDepth++;
              j += 2;
              continue;
            }
            if (src[j] === "`") {
              if (nestedDepth === 0) {
                j++;
                break;
              }
              nestedDepth--;
            }
            j++;
          }
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
          // Regex inside an interpolation expression, else division.
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
      const to = Math.min(j + 1, src.length);
      result += " ".repeat(to - i);
      i = to;
      continue;
    }
    // Regex literal (simplified: /pattern/flags) — keyed off a leading
    // operator so a division after an identifier is not a regex.
    if (src[i] === "/" && i > 0 && /[=([{}!|&?:;,~^<>+\-*/%\n]/.test(src[i - 1])) {
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
