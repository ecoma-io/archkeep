/**
 * Vue SFC analyzer — the official SFC parser finds the `<script>` blocks, the
 * TypeScript analyzer next door reads the imports inside them.
 *
 * ## Positions are mapped by blanking, not by arithmetic
 *
 * A diagnostic that names the wrong line is worse than no diagnostic: it sends
 * a reader to code that is not the problem, and it does it silently. The
 * obvious implementation — analyze `block.content`, then add the block's start
 * line to every result — has an off-by-one at the first line of the block
 * (whose column is offset too, not just its line), and it needs a second,
 * different correction for a second `<script>` block.
 *
 * So no arithmetic happens at all. Each block is analyzed in a copy of the
 * WHOLE file with every character outside that block replaced by a space,
 * newlines kept. The text handed to TypeScript therefore has the block's code
 * at exactly the offsets, lines, and columns it occupies in the `.vue` file,
 * and every position TypeScript reports is already a `.vue` position. There is
 * nothing left to get wrong, and `@vue/compiler-sfc` guarantees the one fact
 * it relies on: `text.slice(block.loc.start.offset, block.loc.end.offset)` is
 * exactly `block.content`.
 *
 * The cost is one string copy per script block, which is bounded by the file.
 *
 * ## Why the parser is loaded lazily
 *
 * `vue/compiler-sfc` is a public entry point of `vue`, a workspace dependency,
 * and the SFC format is Vue's own — a hand-rolled `<script>` extractor would
 * be a second answer to a question its author already answers, and would be
 * wrong first on the cases that motivate a real parser (a `</script>` inside a
 * string, `<script>` and `<script setup>` together, a custom block).
 *
 * It is still loaded on first use rather than at import time, through
 * `createRequire`, for two reasons. This tool runs over trees that have no Vue
 * at all — a pure Go or Rust workspace does not depend on it — and a
 * top-level import would make a missing `vue` break Go, Rust, and Python
 * analysis in a workspace that has no `.vue` file to analyze. And the contract
 * says an analyzer never throws: a missing parser becomes a failure record
 * naming what is absent, like any other thing this layer could not do.
 */
import { createRequire } from "node:module";

import { emptyResult, fileFailure } from "./source-util.mjs";
import { analyzeTypeScript } from "./typescript.mjs";

/** The SFC parser's specifier, named once — the failure message quotes it. */
const COMPILER_SFC = "vue/compiler-sfc";

/** Resolved once, success or failure, and remembered either way. */
let parserLoad = null;

function sfcParse() {
  if (parserLoad === null) {
    try {
      parserLoad = { parse: createRequire(import.meta.url)(COMPILER_SFC).parse, error: null };
    } catch (cause) {
      parserLoad = { parse: null, error: cause?.message ?? String(cause) };
    }
  }
  if (parserLoad.parse === null) {
    throw new Error(
      `'${COMPILER_SFC}' is not installed, so no .vue file can be analyzed: ${parserLoad.error}`,
    );
  }
  return parserLoad.parse;
}

/** `text` with everything outside `[start, end)` replaced by spaces. */
function isolate(text, start, end) {
  const blank = (part) => part.replace(/[^\n]/g, " ");
  return blank(text.slice(0, start)) + text.slice(start, end) + blank(text.slice(end));
}

/**
 * A compiler-sfc error as a failure record. Its `loc` is already 1-based in
 * the `.vue` file's own coordinates; a plain `SyntaxError` carries none, and
 * becomes a file-level failure.
 */
function sfcFailure(sourceFile, error) {
  const start = error?.loc?.start;
  return {
    sourceFile,
    line: start?.line ?? null,
    column: start?.column ?? null,
    reason: `Vue SFC parse error: ${error?.message ?? error}`,
  };
}

/**
 * Analyzes one `.vue` file.
 *
 * Both script blocks are analyzed when both exist — `<script>` and
 * `<script setup>` legitimately coexist, and an import in either is an import
 * of the component. A file with no script block yields the empty envelope and
 * no failure: a template-only SFC imports nothing, which is not an error.
 *
 * @param {{ sourceFile: string, text: string, workspace: object }} request
 * @returns {{ imports: object[], failures: object[] }}
 */
export function analyzeVue({ sourceFile, text, workspace }) {
  const result = emptyResult();
  try {
    const parse = sfcParse();
    const { descriptor, errors } = parse(text, { filename: sourceFile });
    for (const error of errors) result.failures.push(sfcFailure(sourceFile, error));

    for (const block of [descriptor.script, descriptor.scriptSetup]) {
      if (!block) continue;
      const isolated = isolate(text, block.loc.start.offset, block.loc.end.offset);
      const analyzed = analyzeTypeScript({
        sourceFile,
        text: isolated,
        workspace,
        // No `lang` means plain JavaScript, which is Vue's own default.
        lang: block.lang ?? "js",
      });
      result.imports.push(...analyzed.imports);
      result.failures.push(...analyzed.failures);
    }
  } catch (cause) {
    result.failures.push(
      fileFailure(sourceFile, `Vue analysis failed: ${cause?.message ?? cause}`),
    );
  }
  // Two blocks are analyzed in sequence, so their records arrive block by
  // block; `contract.md` promises source order over the file.
  result.imports.sort((a, b) => a.line - b.line || a.column - b.column);
  return result;
}
