/**
 * The dotnet lexical mask — the shared scanner both the C# frontend and the
 * namespace index read through. It follows the same length-preserving
 * discipline as `../jvm/mask.mjs` and `../go.mjs`: the result is byte-for-byte
 * the same length with every line break in place, so an offset into the mask
 * is the same offset into the original, and a regex over the mask cannot see
 * a comment's or a literal's contents — a commented-out or quoted `using` is
 * text, not a written directive.
 *
 * Why a separate scanner rather than another row in the JVM dialect table:
 * that table parameterizes exactly two facts ({nests}, {tripleEscapes}) and
 * C# differs beyond both knobs. Its literal grammar adds verbatim strings,
 * interpolated strings, and raw strings with variable-length quote delimiters,
 * and folding those into a table wide enough to serve Java and Kotlin too
 * would misread one of them — the reason the JVM module argues its own
 * parameterization is "the honesty". Mirroring the module, not importing it,
 * keeps each family's scanner readable against its own language's spec.
 *
 * Per construct, what this scanner knows and why:
 *
 * | Construct            | Rule here                                             |
 * |----------------------|-------------------------------------------------------|
 * | line comment         | `//` to end of line                                    |
 * | block comment        | `/* .. *`+`/`, does NOT nest                           |
 * | string               | `"…"` with `\` escapes, one line                       |
 * | char                 | `'…'` with `\` escapes                                 |
 * | verbatim string      | `@"…"` / `$@"…"` / `@$"…`: `""` doubles a quote,
 * |                      | no `\` escape, spans lines                             |
 * | interpolated string  | `$"…"`: escapes like `"…"`; HOLES NOT MODELED (below)  |
 * | raw string           | `"""…"""` and wider: opener is the maximal quote run,
 * |                      | closer is the first run at least as long, no escapes   |
 *
 * Block comments do not nest in C# — the same load-bearing fact the JVM
 * scanner pins for Java: a doc comment quoting a snippet must not swallow the
 * real code below its first closer.
 *
 * Interpolation holes are deliberately not modeled. A hole holds an
 * expression, and an expression cannot contain a directive, so treating the
 * hole's quotes as ordinary string delimiters is safe in the direction that
 * matters: the quotes pair off around short fragments of expression text, and
 * no fragment can spell `using X.Y;`. The worst case is a spurious record
 * naming text the file really contains — reachable only by quoting the words
 * of a directive inside a hole, which valid C# cannot execute into existence.
 * What the naive pairing must never do is overshoot a true terminator and
 * swallow REAL code below, and it cannot: an overshoot requires an unpaired
 * quote, which valid C# does not contain.
 *
 * Raw strings take the maximal quote run as their opener and end at the first
 * later run at least as long — the spec's own termination rule. An
 * unterminated raw string masks to end of file, which is the same declared
 * posture the JVM scanner takes for an unterminated text block: the file does
 * not compile, and degrading a malformed input by masking its remainder is
 * named here rather than discovered by whoever meets it.
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

/** Length of the non-nesting block comment (or unterminated run) at `start`. */
const blockCommentLength = (text, start) => {
  // A second `/*` inside the open comment is prose; skip it without counting,
  // so the first `*/` still ends the comment — the Java rule, for the same
  // reason: XML-doc comments quote snippets, and nesting would eat the code
  // below them.
  let at = start + 2;
  while (at < text.length && !text.startsWith("*/", at)) at++;
  return Math.min(at + 2, text.length) - start;
};

/** Length of the `@"…"` verbatim body opened at `start` (`openPrefix` = `@"`, `$@"`, `@$"`). */
const verbatimStringLength = (text, start, openLength) => {
  let at = start + openLength;
  while (at < text.length) {
    if (text[at] === '"') {
      if (text[at + 1] === '"') {
        at += 2;
        continue;
      }
      return at + 1 - start;
    }
    at++;
  }
  return text.length - start;
};

/** Number of consecutive quotes at `start` (at least one — the caller matched one). */
const quoteRunLength = (text, start) => {
  let at = start;
  while (text[at] === '"') at++;
  return at - start;
};

/** Length of the raw string opened at `start` by an `openerRun`-wide quote run. */
const rawStringLength = (text, start, openerRun) => {
  let at = start + openerRun;
  while (at < text.length) {
    if (text[at] === '"') {
      const run = quoteRunLength(text, at);
      if (run >= openerRun) return at + run - start;
      at += run;
      continue;
    }
    at++;
  }
  return text.length - start;
};

/**
 * Lexical starts, in the order the alternation settles them: comments first,
 * then the `@`-marked verbatim spellings (which may carry `$` on either side),
 * then a `$"` whose next char is not a quote — the guard keeps the `$` of a
 * `$$"""…"""` raw-interpolated opener from matching as an ordinary
 * interpolated string — and finally either quote character, which the
 * dispatcher classifies by counting the run behind it.
 */
const LEXICAL_START = /\/\/|\/\*|\$?@"|@\$"|\$"(?!")|["']/g;

/**
 * `sourceText` with every comment AND literal blanked out, same length, line
 * breaks in place. See the module header for each construct's rule.
 *
 * Literals are blanked here where Go's mask keeps its raw strings intact —
 * the opposite choice on purpose, for the same reason the JVM scanner gives:
 * a C# directive is bare words after its keyword, so every literal body can
 * only plant spurious declarations into text that scans like code, while a
 * directive never lives inside one.
 *
 * @param {string} sourceText
 * @returns {string} Same length as `sourceText`.
 */
export function maskCSharpComments(sourceText) {
  const scan = new RegExp(LEXICAL_START.source, "g");
  let masked = "";
  let copied = 0;
  let match;
  while ((match = scan.exec(sourceText)) !== null) {
    const start = match.index;
    const token = match[0];
    let end;
    if (token === "//") {
      const newline = sourceText.indexOf("\n", start);
      end = newline === -1 ? sourceText.length : newline;
    } else if (token === "/*") {
      end = start + blockCommentLength(sourceText, start);
    } else if (token.endsWith('@"')) {
      // `@"` and `$@"` — the `$` changes interpolation, not termination.
      end = start + verbatimStringLength(sourceText, start, token.length);
    } else if (token === '@$"') {
      end = start + verbatimStringLength(sourceText, start, token.length);
    } else {
      // A quote: the run behind it decides raw versus ordinary; a char
      // literal takes the escaped walk with its own quote, so a `'"'` cannot
      // open a phantom string that swallows the code below it.
      const quote = token;
      const run = quote === '"' ? quoteRunLength(sourceText, start) : 1;
      end =
        run >= 3
          ? start + rawStringLength(sourceText, start, run)
          : start + escapedStringLength(sourceText, start, quote);
    }
    // Newlines survive everywhere; every other byte of the span goes.
    masked += sourceText.slice(copied, start) + blankOut(sourceText.slice(start, end));
    copied = end;
    scan.lastIndex = end;
  }
  return masked + sourceText.slice(copied);
}
