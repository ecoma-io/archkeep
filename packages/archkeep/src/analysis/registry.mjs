/**
 * The extension → language table, held apart from `./analyze.mjs` so that
 * asking "what language is this file" never pays for loading every language's
 * analyzer.
 *
 * `analyze.mjs` imports every `ANALYZER_BY_LANGUAGE` entry eagerly, and one of
 * those — `analyzeTypeScript` — imports the `typescript` npm package at module
 * scope. A caller that only wants `languageOf`/`LANGUAGE_BY_EXTENSION` (the
 * native provider's coverage judgment, `../providers/native/coverage.mjs`, is
 * exactly this: it classifies files to decide which are "analyzable" without
 * ever calling an analyzer) has no reason to load a compiler it may not even
 * have installed for. `../process.mjs` is the same split for the same reason,
 * one layer over: module-scope imports are a cost every importer pays whether
 * or not it uses what they load.
 *
 * `analyze.mjs` re-exports both names from here, so nothing that already
 * imports them from `analyze.mjs` has to change, and the rule — an extension
 * names a language — is still stated in exactly one place.
 */

/**
 * File extension → the language whose analyzer owns it. The one place an
 * extension is mapped: a language whose analyzer arrives registers here and
 * nowhere else.
 *
 * Dispatch is on the extension alone. Not on content — sniffing would be a
 * second, weaker answer to a question the filename already settles — and not
 * on the owning project's tags, because a tag describes a project's boundary,
 * not the syntax of the files inside it.
 *
 * `.mjs`/`.cjs` are listed beside `.js` rather than folded into it: this
 * workspace's own tools are `.mjs`, so leaving them out would exempt the
 * enforcer from itself.
 *
 * `.vue` names its own language rather than folding into `typescript`. A `.vue`
 * file is not TypeScript — its imports live inside `<script>` blocks that have
 * to be located before anything can read them, and the block's `lang` decides
 * which of TypeScript's four dialects applies. The Vue analyzer does that and
 * then hands the block to the TypeScript one; the sharing belongs there, not
 * in this table.
 */
export const LANGUAGE_BY_EXTENSION = Object.freeze({
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "typescript",
  ".jsx": "typescript",
  ".mjs": "typescript",
  ".cjs": "typescript",
  ".vue": "vue",
  ".go": "go",
  ".rs": "rust",
  ".py": "python",
  // Java only: Kotlin's `.kt`/`.kts` register when the Kotlin analyzer lands
  // (ADR 0005, `docs/adr/`, owns the sequencing). The shared JVM core under
  // `src/analysis/jvm/` already reads both extensions, but a language key is
  // claimed here exactly when its analyzer ships.
  ".java": "java",
});

/**
 * The language owning `sourceFile`, or `null` when no analyzer claims its
 * extension. Exported because a caller that walks a project's tracked files
 * wants to skip the ones nothing can read before paying to read them.
 *
 * Matched on the last dot of the basename, so a dotted filename
 * (`foo.config.mjs`) resolves by its real extension and a dotfile with no
 * extension (`.gitignore`) resolves to `null` rather than to itself.
 *
 * @param {string} sourceFile Workspace-relative path.
 * @returns {string|null}
 */
export function languageOf(sourceFile) {
  const base = sourceFile.slice(sourceFile.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null; // no extension, or a dotfile that is all extension
  return LANGUAGE_BY_EXTENSION[base.slice(dot)] ?? null;
}
