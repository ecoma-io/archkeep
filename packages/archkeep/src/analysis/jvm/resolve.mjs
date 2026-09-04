/**
 * JVM specifier resolution — turning an imported dotted name into the record
 * the analysis contract carries (`../contract.md`): a project target, or an
 * external classification, or an ambiguity the caller reports rather than
 * guesses past.
 *
 * The classification order is the language's, not a preference:
 *
 * 1. **Workspace packages first.** A name (or a prefix of it) some tracked
 *    project declares resolves to that project through
 *    `resolveJvmPackagePrefix`'s longest-prefix walk. First-party beats every
 *    later answer: misreading first-party as external is the silent direction,
 *    and no rule can see a crossing the resolver called a library.
 * 2. **Default imports by table.** Each dialect auto-imports a fixed package
 *    set (Java: `java.lang.*`; Kotlin adds its nine stdlib packages plus the
 *    platform sets). An explicit import of one of these names is still legal
 *    and still external — the tables make that classification explicit and
 *    testable instead of incidental, and they change only across language
 *    releases. Cited per table below; never extended by guesswork.
 * 3. **Everything else is external**, with the whole written name standing in
 *    as `packageName` — where a group ends and an artifact begins inside
 *    `org.apache.commons.lang3` is not statically knowable (only the registry
 *    knows), so the full name stands in exactly as Go's resolver lets the
 *    whole module-prefixed path stand in. A `bannedExternalImports` glob
 *    matches it the same way.
 *
 * What this module deliberately does NOT do: read files, hold caches, or know
 * which extension wrote the specifier. The index comes in as an argument; the
 * only language-aware input is the defaults table's name. That keeps the
 * resolution rules identical for `.java`, `.kt`, and any future dotted-name
 * frontend, which is the property a second frontend proves rather than
 * promises.
 */
import { resolveJvmPackagePrefix } from "./packages.mjs";

/**
 * Java's single default-import package root (JLS §7.5.5: `java.lang` is
 * automatically imported "as if by an import declaration" in every
 * compilation unit). Sub-packages (`java.util`) are NOT included — they need
 * their own explicit imports, which is why an explicit `import java.util.List`
 * classifies as ordinary external rather than by this table.
 */
export const JAVA_DEFAULT_IMPORT_ROOTS = Object.freeze(["java.lang"]); // used by its own test

/**
 * Kotlin's default imports (kotlinlang.org, "Default imports", page dated
 * 2026-07): nine stdlib roots always, `java.lang` and `kotlin.jvm` on the JVM
 * target, `kotlin.js` on JS. The union is what an explicit import may legally
 * restate; the table exists for the same reason Java's does — explicit,
 * testable classification of names the compiler brings in unasked.
 */
export const KOTLIN_DEFAULT_IMPORT_ROOTS = Object.freeze([
  // used by its own test
  "kotlin",
  "kotlin.annotation",
  "kotlin.collections",
  "kotlin.comparisons",
  "kotlin.io",
  "kotlin.ranges",
  "kotlin.sequences",
  "kotlin.text",
  "kotlin.math",
  "java.lang",
  "kotlin.jvm",
  "kotlin.js",
]);

const DEFAULT_IMPORT_ROOTS_BY_LANGUAGE = {
  java: JAVA_DEFAULT_IMPORT_ROOTS,
  kotlin: KOTLIN_DEFAULT_IMPORT_ROOTS,
};

/** The default-import roots a language's files carry, or `[]` when unknown. */
export const defaultImportRootsFor = (language) => DEFAULT_IMPORT_ROOTS_BY_LANGUAGE[language] ?? []; // used by its own test

/**
 * True when `specifier` falls under one of `roots`: equal to a root or a dot-
 * delimited segment beneath it. Segment-delimited on purpose — `java.langx`
 * must not match the `java.lang` root, and a plain prefix test would say it
 * does.
 *
 * @param {string} specifier
 * @param {string[]} roots
 * @returns {boolean}
 */
export const underAnyRoot = (specifier, roots) =>
  // used by its own test
  roots.some((root) => specifier === root || specifier.startsWith(`${root}.`));

/**
 * Classify one imported dotted name.
 *
 * @param {string} importableName Everything the resolution can see: for
 *   `import a.b.C` the name `a.b.C`; for `import a.b.*` the package `a.b`;
 *   for `import a.b.C as D` still `a.b.C` (the alias is local syntax).
 * @param {{ language: string }} dialect Which defaults table applies.
 * @param {Map<string, { project: string, file: string }[]>} index As built
 *   by `./packages.mjs`'s `jvmPackageIndex`.
 * @returns {JvmResolution} A project target; or an ambiguity the caller turns
 *   into `resolved: null` + a positioned failure naming the projects; or an
 *   external classification with `packageName` = the full written name.
 */

/**
 * @typedef {object} JvmResolution
 * @property {string|null} target The owning project, null when external or
 *   ambiguous.
 * @property {boolean} external True when no tracked project claims any
 *   prefix of the name.
 * @property {string|null} packageName The full written name for externals;
 *   null otherwise.
 * @property {string[]} [ambiguous] Every distinct claimant of the deepest
 *   matched prefix, when several projects declare it.
 * @property {string} [matchedPrefix] The deepest prefix the ambiguity was
 *   found at.
 * @property {boolean} [byDefaultImport] Externals only: true when the name
 *   falls under the dialect's default-import roots rather than reaching a
 *   registry anyone depends on explicitly.
 */
export function resolveJvmSpecifier(importableName, dialect, index) {
  const matched = resolveJvmPackagePrefix(importableName, index);
  if (matched) {
    const projects = [...new Set(matched.owners.map((owner) => owner.project))];
    if (projects.length === 1) {
      return { target: projects[0], external: false, packageName: null };
    }
    return {
      target: null,
      external: false,
      packageName: null,
      ambiguous: projects,
      matchedPrefix: matched.prefix,
    };
  }
  return {
    target: null,
    external: true,
    packageName: importableName,
    byDefaultImport: underAnyRoot(importableName, defaultImportRootsFor(dialect.language)),
  };
}
