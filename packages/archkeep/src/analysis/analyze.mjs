/**
 * Import-site analysis: the dispatcher, and the types every language analyzer
 * in this directory returns.
 *
 * The reasoning behind each field — why a record is a superset of a graph
 * edge, why an intra-project import is still emitted, why a non-literal
 * `import()` resolves to null instead of being dropped — is in `contract.md`
 * beside this file. The types below are that document's machine-readable half;
 * neither is edited without the other.
 *
 * Two tables decide everything here and nothing else does: an extension names
 * a language (`LANGUAGE_BY_EXTENSION`), a language names an analyzer
 * (`ANALYZER_BY_LANGUAGE`). A language registered in the first table with no
 * entry in the second **throws**, and that is the scaffold staying loud for
 * whichever language arrives next: an empty result would read as "this file
 * imports nothing", which is indistinguishable from "clean" and is the exact
 * fake-green this repository refuses (an empty result is a claim, not a shrug). An extension in neither table is a different case and returns
 * the empty envelope.
 *
 * `LANGUAGE_BY_EXTENSION` and `languageOf` are defined in `./registry.mjs`,
 * not here, and re-exported below — that module's header says why the split
 * exists. Every other import site keeps naming them from this module.
 */

import { analyzeCSharp } from "./csharp.mjs";
import { analyzeGo } from "./go.mjs";
import { analyzeJava } from "./java.mjs";
import { analyzeKotlin } from "./kotlin.mjs";
import { analyzePython } from "./python.mjs";
import { LANGUAGE_BY_EXTENSION, languageOf } from "./registry.mjs";
import { analyzeRust } from "./rust.mjs";
import { emptyResult } from "./source-util.mjs";
import { analyzeTypeScript } from "./typescript.mjs";
import { analyzeVue } from "./vue.mjs";

export { LANGUAGE_BY_EXTENSION, languageOf };

/**
 * Where a specifier points. `null` on the record itself when the specifier
 * cannot be resolved at all — never a guess, never a dropped record.
 *
 * @typedef {object} ResolvedImport
 * @property {string|null} target Nx project name the specifier resolves into,
 *   or `null` when it resolves outside every project.
 * @property {string|null} file Workspace-relative path of the resolved file,
 *   or `null` when the resolution stops at a package rather than a file.
 * @property {boolean} external `true` when the specifier resolves outside
 *   every project — an npm package, a crate, a Go module, a stdlib module.
 * @property {string|null} packageName The package's own name when `external`
 *   (`@tauri-apps/api` for `@tauri-apps/api/window`, not the deep path, so a
 *   `bannedExternalImports` glob matches without re-parsing); `null` otherwise.
 */

/**
 * How the import was written. A dependency that is one edge to the graph is
 * several different rules here, which is why the form is kept.
 *
 * - `static` — a top-level `import`/`require`/`use`/Go import declaration.
 * - `dynamic` — `import()` and its per-language equivalents. Same edge as a
 *   static import, different rule (`checkDynamicDependenciesExceptions`).
 * - `type-only` — erased before runtime (`import type`), so it creates no
 *   runtime dependency and several constraints do not apply to it.
 * - `re-export` — `export … from`, which imports and re-publishes in one
 *   statement; a barrel is built out of these.
 *
 * @typedef {"static" | "dynamic" | "type-only" | "re-export"} ImportKind
 */

/**
 * How the specifier is SPELLED, in the two terms the rules ask about — and the
 * analyzer answers, because the answer is per-LANGUAGE and only the analyzer
 * knows which language it read. `contract.md` carries the reasoning.
 *
 * @typedef {object} SpecifierSpelling
 * @property {boolean} path The specifier is a filesystem path — resolvable by
 *   path arithmetic against the importing file, and naming no package. True
 *   only for the JavaScript family (`.`, `..`, `./x`, `../x`, `/x`); a Go
 *   import path, a Rust `use` path and a Python dotted module are names.
 * @property {boolean} relative The specifier reaches inside the importing
 *   file's own project without going out through the project's public name —
 *   `./x` and `../x` in JavaScript, `crate::`/`self::`/`super::` and a sibling
 *   crate target of the same Cargo package in Rust, a leading-dot import in
 *   Python. It is the counter-evidence `noSelfCircularDependencies` looks for.
 */

/**
 * One import site — one import as WRITTEN, not one resolved dependency. The
 * same target imported three times in a file yields three of these.
 *
 * @typedef {object} ImportSite
 * @property {string} sourceFile Workspace-relative path of the importing file.
 * @property {number} line 1-based line of the specifier.
 * @property {number} column 1-based column of the specifier.
 * @property {string} specifier The raw string as written — never normalised,
 *   never resolved in place. Five of the rules are decided on this text.
 * @property {ImportKind} kind
 * @property {SpecifierSpelling} spelling Mandatory. The rule engine refuses a
 *   record without it rather than reading the specifier itself, which is how it
 *   used to answer and how it got two languages wrong.
 * @property {ResolvedImport|null} resolved `null` when unresolvable; the
 *   reason then appears in the run's `failures`.
 */

/**
 * Something the analyzer could not do, recorded rather than thrown. One bad
 * file must not blank a whole run — a report that is empty because the tool
 * crashed and a report that is empty because the tree is clean print the same.
 *
 * @typedef {object} AnalysisFailure
 * @property {string} sourceFile Workspace-relative path of the file involved.
 * @property {number|null} line 1-based, or `null` when the failure is about
 *   the file as a whole rather than one position.
 * @property {number|null} column 1-based, or `null`.
 * @property {string} reason Human-readable; written to be read in a report.
 */

/**
 * What an analyzer returns. Both arrays are always present and always arrays,
 * so no consumer has to check before iterating.
 *
 * @typedef {object} AnalysisResult
 * @property {ImportSite[]} imports Every import site, in source order.
 * @property {AnalysisFailure[]} failures What could not be parsed, read, or
 *   resolved.
 */

/**
 * Everything an analyzer may consult beyond the file it was handed. A superset
 * of the `(projects, filesOf, readFile)` triple the graph resolvers next door
 * take, plus the absolute `root` TypeScript's resolver needs.
 *
 * @typedef {object} Workspace
 * @property {string} root Absolute path of the workspace root.
 * @property {{ name: string, root: string }[]} projects Every project, with a
 *   workspace-relative root.
 * @property {(projectName: string) => string[]} filesOf A project's tracked
 *   files, workspace-relative.
 * @property {(path: string) => string|null} readFile Workspace-relative read;
 *   `null` for a file that does not exist or cannot be read.
 * @property {string} [tsConfig] The workspace's shared TypeScript config
 *   filename — an Nx convention the plugin's `tsConfig` option can rename.
 *   Consulted only by the TypeScript analyzer, and carried here rather than
 *   passed beside the workspace because that analyzer caches its parsed
 *   compiler options against this object's identity. Omitted, the convention
 *   applies.
 */

/**
 * The call every language analyzer answers. `text` arrives already read so the
 * caller owns the read strategy and a test can drive an analyzer from a string.
 *
 * @typedef {object} AnalysisRequest
 * @property {string} sourceFile Workspace-relative path of the file to analyze.
 * @property {string} text Its contents.
 * @property {Workspace} workspace Resolution context.
 */

/**
 * @callback Analyzer
 * @param {AnalysisRequest} request
 * @returns {AnalysisResult}
 */

/**
 * Language → the analyzer that owns it. The second of the dispatcher's two
 * tables, kept separate from the extension registry because the two answer
 * different questions: which language a filename is written in, and whether
 * this tool can read that language yet.
 */
const ANALYZER_BY_LANGUAGE = Object.freeze({
  typescript: analyzeTypeScript,
  vue: analyzeVue,
  go: analyzeGo,
  rust: analyzeRust,
  python: analyzePython,
  java: analyzeJava,
  kotlin: analyzeKotlin,
  csharp: analyzeCSharp,
});

/**
 * The analyzer owning `language`.
 *
 * Throws for a language `LANGUAGE_BY_EXTENSION` claims but no analyzer
 * implements. That is the one legitimate throw in this layer (`contract.md`):
 * a malformed file is data and becomes a `failure`, but a missing
 * implementation is not an input problem, and reporting an empty result for it
 * would say "this file imports nothing" about every file of that language.
 *
 * @param {string} language
 * @returns {Analyzer}
 * @throws {Error} when no analyzer is registered for `language`.
 */
export function analyzerFor(language) {
  const analyzer = ANALYZER_BY_LANGUAGE[language];
  if (analyzer) return analyzer;
  throw new Error(
    `archkeep: no ${language} import analyzer is implemented yet. This is a stub, ` +
      `not a clean result — see src/analysis/contract.md for the record shape an analyzer must return.`,
  );
}

/**
 * Analyzes one file by dispatching on its extension.
 *
 * An extension no language claims is a NO-OP returning the empty envelope, not
 * an error: this is pointed at whatever files a project owns, and those include
 * `README.md`, `project.json`, and a lockfile. Failing on them would make every
 * run red for reasons no rule cares about, and the fix would be an ignore list
 * someone has to keep in sync with the tree.
 *
 * Every analyzer catches its own errors, so a malformed or unreadable file
 * comes back as records plus failures. The only throw that escapes here is
 * `analyzerFor`'s, for a language with no implementation.
 *
 * @param {AnalysisRequest} request
 * @returns {AnalysisResult}
 * @throws {Error} when the file's language has no analyzer implemented yet.
 */
export function analyzeFile(request) {
  const language = languageOf(request.sourceFile);
  if (language === null) return emptyResult();
  return analyzerFor(language)(request);
}
