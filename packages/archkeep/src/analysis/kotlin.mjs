/**
 * Kotlin analyzer — header-region extraction over comment-and-literal-masked
 * text, sharing the JVM core with `./java.mjs` and owning only what Kotlin's
 * grammar makes different (`docs/adr/0005-jvm-language-integration.md`).
 *
 * The Kotlin grammar fixes an equivalent header:
 * `shebang? NL* fileAnnotation* packageHeader importList`, so extraction stays
 * line-anchored over masked text exactly as Java's is. What differs:
 *
 * - **Three import forms**: single (`import a.b.C`), on-demand
 *   (`import a.b.*`), and aliased (`import a.b.C as D`) — the alias is local
 *   syntax and resolves nothing differently.
 * - **No statement terminator to rely on.** A newline ends the import (a
 *   semicolon may, but Kotlin omits it), so the match ends at the line break;
   a name must still start on the import's own line, which pins the multi-line
 *   limit the same way Java's does.
 * - **Backtick-quoted segments are identifiers** (``import a.`when`.B``) and
 *   are read as such; the PACKAGE index does not carry backticked segments
 *   (see `./jvm/packages.mjs`'s pinned limit), so an import THROUGH one
 *   resolves by its plain prefix or classifies external.
 * - **Shebang** lines (`.kts` scripts) and `@file:` annotations precede the
 *   header; neither matches the anchored forms.
 *
 * Everything downstream is the shared answer: `kind` always `"static"`,
 * `spelling.path` always false and `spelling.namesOnly` always true (a package
 * name is a name, never a path — #376), `spelling.relative` true exactly when the
 * import resolved into its own project, resolution through
 * `./jvm/resolve.mjs` with Kotlin's default-import table, and graph edges via
 * the same contract as every other language. There is no dynamic import, no
 * type-only form, and no re-export syntax to model.
 */
import { maskKotlinComments } from "./jvm/mask.mjs";
import { jvmPackageIndex } from "./jvm/packages.mjs";
import { resolveJvmSpecifier } from "./jvm/resolve.mjs";
import { emptyResult, fileFailure, positionAt, projectOwning } from "./source-util.mjs";

/** One identifier segment: backtick-quoted (any non-backtick content) or a plain identifier. */
const KOTLIN_SEGMENT = String.raw`(?:` + "`[^`\\n]*`" + String.raw`|[\p{L}_$][\p{L}\p{Nd}_$]*)`;

// Anchored to a line head (or behind a semicolon); the name must start on the
// import's own line; the optional alias is captured only to keep it out of
// the specifier.
const KOTLIN_IMPORT = new RegExp(
  String.raw`(?:^|[\n;])[ \t]*(?:import[ \t]+)(` +
    KOTLIN_SEGMENT +
    String.raw`(?:\.` +
    KOTLIN_SEGMENT +
    String.raw`)*(?:\.\*)?)` +
    String.raw`(?:[ \t]+as[ \t]+[\p{L}_$][\p{L}\p{Nd}_$]*)?[ \t]*(?=[\n;}]|$)`,
  "gu",
);

/**
 * Every import in a `.kt`/`.kts` file, in source order and WITHOUT
 * deduplication. Offsets index the ORIGINAL text; the mask preserved length.
 *
 * @param {string} kotlinText Raw file contents.
 * @returns {{ specifier: string, importableName: string, offset: number }[]}
 */
export function parseKotlinImportSites(kotlinText) {
  // A shebang needs no handling of its own: `#!…` cannot anchor an import
  // match (`import` must follow a line head, `;`, or newline), and masking
  // runs before anything reads the text anyway.
  const source = maskKotlinComments(kotlinText);
  const sites = [];
  for (const match of source.matchAll(KOTLIN_IMPORT)) {
    const name = match[1];
    sites.push({
      specifier: name,
      importableName: importableNameOf(name),
      offset: match.index + match[0].indexOf(name),
    });
  }
  return sites.sort((a, b) => a.offset - b.offset);
}

/**
 * The dotted name resolution walks: the on-demand form drops its trailing
 * `.*`; everything else resolves whole, longest declared prefix winning.
 * Aliases never reach this function — they are stripped by the match itself.
 *
 * @param {string} name The dotted name as written.
 * @returns {string}
 */
const importableNameOf = (name) => (name.endsWith(".*") ? name.slice(0, -2) : name);

/**
 * Analyzes one `.kt`/`.kts` file. Ambiguity resolves to null WITH a
 * positioned failure naming every claimant, exactly as Java's does — the
 * split-package rule cannot know which compiler unit order would win, and
 * neither will this reader pretend to.
 *
 * The package index arrives through `jvmPackageIndex` — already memoized per
 * workspace object — so one whole-tree run builds it once however many files
 * ask, and the graph resolver below reads the same map through the same memo.
 *
 * @param {{ sourceFile: string, text: string, workspace: object }} request
 * @returns {{ imports: object[], failures: object[] }}
 */
export function analyzeKotlin({ sourceFile, text, workspace }) {
  const result = emptyResult();
  try {
    const index = jvmPackageIndex(workspace);
    const owner = projectOwning(workspace.projects, sourceFile);
    for (const site of parseKotlinImportSites(text)) {
      const { line, column } = positionAt(text, site.offset);
      const resolved = resolveJvmSpecifier(site.importableName, { language: "kotlin" }, index);
      let resolution;
      if (resolved.external) {
        resolution = {
          target: null,
          file: null,
          external: true,
          packageName: site.importableName,
        };
      } else if (resolved.ambiguous) {
        resolution = null;
        result.failures.push({
          sourceFile,
          line,
          column,
          reason:
            `'${resolved.matchedPrefix}' is declared by more than one project ` +
            `(${resolved.ambiguous.join(", ")}) — the compilers pick by classpath order, ` +
            `which this static reader does not model`,
        });
      } else {
        resolution = { target: resolved.target, file: null, external: false, packageName: null };
      }
      const target = resolution?.target ?? null;
      result.imports.push({
        sourceFile,
        line,
        column,
        specifier: site.specifier,
        kind: "static",
        spelling: {
          path: false,
          relative: target !== null && owner !== null && target === owner.name,
          namesOnly: true,
        },
        resolved: resolution,
      });
    }
  } catch (cause) {
    result.failures.push(
      fileFailure(sourceFile, `Kotlin analysis failed: ${cause?.message ?? cause}`),
    );
  }
  return result;
}

/**
 * Static edges between JVM projects derived from written Kotlin imports —
 * the same source-truth track `resolveJavaDependencies` runs, one namespace
 * over. Takes ONE workspace-shaped object for the same reason it does: the
 * package index is memoized on that object, so the caller's one object —
 * shared with `analyzeKotlin`, the Java resolver and the manifest resolvers —
 * is what makes the index build once per run (#363).
 *
 * @param {object} workspace `{ projects, filesOf(name), readFile(path) }`
 * @returns {{ source: string, target: string, sourceFile: string, type: string }[]}
 */
export function resolveKotlinDependencies(workspace) {
  const { projects, filesOf, readFile } = workspace;
  const index = jvmPackageIndex(workspace);
  const dependencies = [];
  for (const project of projects) {
    for (const file of filesOf(project.name)) {
      if (!file.endsWith(".kt") && !file.endsWith(".kts")) continue;
      const text = readFile(file);
      if (text === null) continue;
      for (const site of parseKotlinImportSites(text)) {
        const resolved = resolveJvmSpecifier(site.importableName, { language: "kotlin" }, index);
        if (resolved.external || resolved.ambiguous) continue;
        if (resolved.target === project.name) continue;
        dependencies.push({
          source: project.name,
          target: resolved.target,
          sourceFile: file,
          type: "static",
        });
      }
    }
  }
  return dependencies;
}
