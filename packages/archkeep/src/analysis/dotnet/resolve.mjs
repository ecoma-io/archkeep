/**
 * C# specifier resolution — turning an imported dotted name into the record
 * the analysis contract carries (`../contract.md`): a project target, or an
 * ambiguity the caller reports rather than guesses past, or an external
 * classification.
 *
 * The classification order is shorter than the JVM's, on purpose:
 *
 * 1. **Workspace namespaces first.** A name (or a prefix of it) some tracked
 *    project declares resolves through `resolveDottedNamespacePrefix`'s
 *    longest-prefix walk. First-party beats every later answer: misreading
 *    first-party as external is the silent direction, and no rule can see a
 *    crossing the resolver called a library.
 * 2. **Everything else is external**, with the whole written name standing in
 *    as `packageName` — where `Serilog.Configuration` ends and its assembly
 *    begins is not statically knowable, so the full name stands in exactly as
 *    the JVM resolver lets the whole dotted path stand in. A
 *    `bannedExternalImports` glob matches it the same way.
 *
 * There is no default-import table here because C# has no language-level one.
 * Java's `java.lang` and Kotlin's stdlib roots are language constants; C#'s
 * equivalent — implicit usings and `<Using Include>` items — is per-project
 * MSBuild data (`docs/adr/0006-dotnet-language-integration.md`, Decision 4),
 * and every namespace in the SDK-fixed set classifies external through step 2
 * anyway. The one case where that data would change an ANSWER does not exist:
 * an explicit `using X.Y;` resolves to a tracked owner or classifies external
 * identically whether or not some project also auto-imported it.
 *
 * What this module deliberately does NOT do: read files, hold caches, or know
 * which extension wrote the specifier. The index comes in as an argument.
 */

import { resolveDottedNamespacePrefix } from "./namespaces.mjs";

/**
 * Classify one imported dotted name.
 *
 * @param {string} importableName Everything the resolution can see: for
 *   `using a.b.c` the name `a.b.c`; for `using static a.b.Type` still
 *   `a.b.Type` (the walk stops at the deepest DECLARED namespace naturally,
 *   because types are not index keys); for `using alias = a.b.c` the
 *   right-hand side `a.b.c`, with the alias stripped by the caller.
 * @param {Map<string, { project: string, file: string }[]>} index As built by
 *   `./namespaces.mjs`'s `csharpNamespaceIndex`.
 * @returns {CsharpResolution} A project target; or an ambiguity the caller
 *   turns into `resolved: null` + a positioned failure naming the projects;
 *   or an external classification with `packageName` = the full written name.
 */

/**
 * @typedef {object} CsharpResolution
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
 */
export function resolveCsharpSpecifier(importableName, index) {
  const matched = resolveDottedNamespacePrefix(importableName, index);
  if (matched) {
    const projects = [...new Set(matched.owners.map((owner) => owner.project))];
    if (projects.length === 1) {
      return { target: projects[0], external: false, packageName: null };
    }
    // Several projects declare the same deepest matched namespace — ordinary
    // C# (a namespace spanning assemblies), unresolvable by static reading.
    // Like the JVM split-package answer this mirrors, picking either side
    // would report violations against a guess, so the caller reports the tie
    // instead. The compiler picks by reference order; this reader does not
    // model references' contents.
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
  };
}
