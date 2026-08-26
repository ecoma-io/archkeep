/**
 * The JVM lexical mask — the shared scanner both source frontends and the
 * package index read through, because Java and Kotlin disagree about exactly
 * one thing a scanner has to know (whether block comments nest) and agree
 * about everything else that matters here.
 *
 * Like `../go.mjs`'s `maskGoComments`, the mask BLANKS rather than deletes:
 * the result is byte-for-byte the same length with every line break in
 * place, so an offset into the mask is the same offset into the original
 * and `positionAt` reports the line the reader sees. A regex over the mask
 * cannot see a comment's or a string literal's contents, which is the point:
 * a commented-out import or a text block quoting one is text, not a written
 * import, and counting it would report a violation naming code nobody wrote.
 *
 * Why one scanner, parameterized, rather than two copies: the package index
 * (`./packages.mjs`) reads BOTH extensions from one tree — a mixed
 * Java/Kotlin module compiles into one package namespace, so a `.java`
 * import may resolve into a package only a `.kt` file declares. The
 * dialects' literal grammars differ in exactly the places this table pins,
 * so the parameterization IS the honesty; folding the two into one average
 * grammar would misread one of them.
 *
 * Per dialect, the literals and comments this scanner knows:
 *
 * | Token            | Java                          | Kotlin                     |
 * |------------------|-------------------------------|----------------------------|
 * | line comment     | two slashes to end of line    | two slashes to end of line |
 * | block comment    | slash-star .. star-slash,
 * |                  | does NOT nest                 | NESTS                      |
 * | string           | `"…"` with `\` escapes        | `"…"` with `\` escapes     |
 * | triple-quoted    | text block `"""…"""`, escaped | raw string `"""…"""`,
 * |                  |                               | NO escapes                 |
 * | char             | `'…'`                         | `'…'`                      |
 *
 * The nesting difference is load-bearing in the loud direction. Treating a
 * Java block comment as nesting would keep masking past its first closer
 * when a comment's prose holds a second opener — javadoc quoting a code
 * snippet is ordinary Java — and every real import below the swallowed
 * region would vanish: the silent direction, byte-for-byte identical to a
 * clean file. Scanning each dialect by its own rule keeps the worst case a
 * spurious record naming text the file really contains, never a missed
 * import.
 */

/**
 * Every character of `text` except its line breaks, replaced by a space.
 */
const blankOut = (text) => text.replace(/[^\n]/g, " ");

/** Escape-walk over a `"…"` / `'…'` literal body: `\` skips the next char. */
const escapedStringLength = (text, start, quote) => {
  let at = start + 1;
  while (at < text.length && text[at] !== quote && text[at] !== "\n") {
    at += text[at] === "\\" ? 2 : 1;
  }
  return Math.min(text[at] === quote ? at + 1 : at, text.length) - start;
};

/** Length of a triple-quoted literal opened at `start`. */
const tripleQuotedLength = (text, start, escapes) => {
  const terminator = '"""';
  let at = start + 3;
  while (at < text.length) {
    const close = text.indexOf(terminator, at);
    if (close === -1) return text.length - start;
    if (!escapes) return close + 3 - start;
    // Count the backslashes immediately before the candidate terminator: an
    // even run leaves all three quotes unescaped (the literal ends), an odd
    // run escapes the first of them, leaving two — not a terminator.
    let slashes = 0;
    for (let back = close - 1; back >= at && text[back] === "\\"; back--) slashes++;
    if (slashes % 2 === 0) return close + 3 - start;
    at = close + 3;
  }
  return text.length - start;
};

/** Length of the comment (or unterminated run) opened at `start`. */
const blockCommentLength = (text, start, nests) => {
  let depth = 1;
  let at = start + 2;
  while (at < text.length) {
    if (text.startsWith("/*", at)) {
      if (!nests) {
        // Java: a second opener inside the open comment is prose; skip it
        // without counting, so the first closer still ends the comment.
        at += 2;
        continue;
      }
      depth++;
      at += 2;
      continue;
    }
    if (text.startsWith("*/", at)) {
      depth--;
      at += 2;
      if (depth === 0) return at - start;
      continue;
    }
    at++;
  }
  return text.length - start;
};

const LEXICAL_START = /\/\/|\/\*|"""|["']/g;

/**
 * `sourceText` with every comment AND literal blanked out, same length, line
 * breaks in place. See the module header for why the dialect decides nesting
 * and escaping rather than one average grammar serving both.
 *
 * Literals are blanked here where Go's mask keeps its raw strings intact —
 * the opposite choice on purpose. A Go import path IS a string literal, so a
 * Go mask that ate strings would have nothing left to read; a JVM import is
 * bare words after the keyword, and every literal body (a text block quoting
 * a tutorial's `package` line, a string holding a class name) can only plant
 * spurious declarations into text that scans like code.
 *
 * @param {string} sourceText
 * @param {{ nests: boolean, tripleEscapes: boolean }} dialect
 * @returns {string} Same length as `sourceText`.
 */
function maskJvmDialect(sourceText, dialect) {
  const scan = new RegExp(LEXICAL_START.source, "g");
  let masked = "";
  let copied = 0;
  let match;
  while ((match = scan.exec(sourceText)) !== null) {
    const start = match.index;
    let end;
    if (match[0] === "//") {
      const newline = sourceText.indexOf("\n", start);
      end = newline === -1 ? sourceText.length : newline;
    } else if (match[0] === "/*") {
      end = start + blockCommentLength(sourceText, start, dialect.nests);
    } else if (match[0] === '"""') {
      end = start + tripleQuotedLength(sourceText, start, dialect.tripleEscapes);
    } else {
      end = start + escapedStringLength(sourceText, start, match[0]);
    }
    // Newlines survive everywhere; every other byte of the span goes.
    masked += sourceText.slice(copied, start) + blankOut(sourceText.slice(start, end));
    copied = end;
    scan.lastIndex = end;
  }
  return masked + sourceText.slice(copied);
}

/**
 * `javaText` with every Java comment and literal blanked out — see the
 * module header.
 *
 * @param {string} javaText
 * @returns {string} Same length as `javaText`.
 */
export const maskJavaComments = (javaText) =>
  maskJvmDialect(javaText, { nests: false, tripleEscapes: true });

/**
 * `kotlinText` with every Kotlin comment and literal blanked out — see the module
 * header. Kept beside `maskJavaComments` from the day the package index
 * lands, because the index reads `.kt` sources too: a mixed Java/Kotlin
 * module compiles into one package namespace, and a `.java` import may
 * reach a package only a `.kt` file declares.
 *
 * @param {string} kotlinText
 * @returns {string} Same length as `kotlinText`.
 */
export const maskKotlinComments = (kotlinText) =>
  maskJvmDialect(kotlinText, { nests: true, tripleEscapes: false });
