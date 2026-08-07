/**
 * Reading a JSON config the way Nx reads it, which is NOT `JSON.parse`.
 *
 * Nx goes `readJsonFile` → `parseJson` → jsonc-parser with
 * `allowTrailingComma: true`, so a config carrying a trailing comma, a `//`
 * line comment or a block comment is a config Nx HAS. Measured against the
 * installed nx: all three forms parse there and all three throw from
 * `JSON.parse`.
 *
 * Losing such a file is the worst failure this tool can have, in both of the
 * places that read one. A `project.json` lost this way takes its project out of
 * the graph, an import into it then resolves as external rather than
 * cross-project, and the editor paints a real violation clean. An `nx.json`
 * lost this way takes the plugin's own options with it — the tool would then
 * read the boundary law from a filename the workspace stopped using.
 *
 * So the parser is REACHED rather than reproduced. A second JSONC
 * implementation would be a second answer to a question Nx already answers, and
 * it would drift first on exactly the inputs that motivate it.
 *
 * This module holds nothing but that, and imports nothing but `node:module`,
 * because both of its consumers are cost-sensitive in different ways:
 * `./lsp/workspace-index.mjs` runs in a server that must start in an editor,
 * and `./options.mjs` is reached from `../index.mjs`, the entry Nx loads on
 * EVERY graph computation. A shared module is also the only way the two can
 * stay one answer — the same reader in two files was an unsynced copy of one
 * fact the day the second one was written.
 */
import { createRequire } from "node:module";

/**
 * Where Nx keeps the parser behind `readJsonFile`. Pinned with `nx` itself,
 * which the workspace root declares at an exact version.
 */
const NX_JSON_PARSER = "nx/src/utils/json.js";

/** Resolved once, success or failure, and remembered either way. */
let nxParserLoad = null;

/** Nx's `parseJson`, or the reason it could not be reached. */
function nxParseJson() {
  if (nxParserLoad === null) {
    try {
      nxParserLoad = {
        parse: createRequire(import.meta.url)(NX_JSON_PARSER).parseJson,
        error: null,
      };
    } catch (cause) {
      nxParserLoad = { parse: null, error: cause?.message ?? String(cause) };
    }
  }
  return nxParserLoad;
}

/**
 * Parses one JSON config the way Nx parses it.
 *
 * Two shapes are deliberate:
 *
 * - **`JSON.parse` runs first**, exactly as `parseJson` itself runs it first.
 *   A tree of plain JSON — nearly every tree, nearly always — loads no module
 *   at all, and the whole cost of this arrives only on a file that needed it.
 * - **`nx` is loaded on first need through `createRequire`**, the arrangement
 *   `./analysis/vue.mjs` uses and for the same reason: this tool runs over
 *   trees that do not depend on Nx, and a top-level import would take Go, Rust
 *   and Python analysis down in a workspace that has no Nx to disagree with.
 *   When the parser cannot be reached the reader gets the original
 *   `JSON.parse` failure with the absent parser named in it — raising rather
 *   than falling back to the `JSON.parse` result, which would quietly restore
 *   the blind spot this exists to end.
 *
 * @param {string} text
 * @returns {object} Whatever the JSON describes.
 * @throws {Error} when neither parser can read it.
 */
export function parseNxJson(text) {
  try {
    return JSON.parse(text);
  } catch (plain) {
    const nx = nxParseJson();
    if (nx.parse === null) {
      throw new Error(
        `${plain.message}. The JSONC forms Nx accepts — a trailing comma, a line or block ` +
          `comment — could not be tried, because '${NX_JSON_PARSER}' is not resolvable from ` +
          `here: ${nx.error}`,
        { cause: plain },
      );
    }
    // `expectComments` only tells `parseJson` to skip the `JSON.parse` attempt
    // that already failed above; the jsonc options it applies are the same
    // ones `readJsonFile` gets.
    return nx.parse(text, { expectComments: true });
  }
}
