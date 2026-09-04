/**
 * The JVM package index — the content-derived `package → project` map every
 * JVM resolution reads through.
 *
 * Java and Kotlin do not require directory = package. javac enforces nothing
 * about where a `.java` file sits relative to its `package` line, and Kotlin's
 * coding conventions state the layout is "recommended", unenforced. A resolver
 * that derived importable names from directory layout would therefore answer
 * confidently about a tree it had misread — the failure mode Python's reader
 * avoids by reading its declared backend layout, and which has no manifest
 * equivalent here to read instead. The declaration lives in the file, so the
 * index reads the file.
 *
 * The index spans BOTH extensions from its first commit. A mixed Java/Kotlin
 * module compiles jointly into one package namespace (one classpath, sources
 * from `src/main/java` and `src/main/kotlin` together), so a `.java` import
 * may reach a package only a `.kt` file declares and the other way round.
 * Two per-extension indexes would disagree exactly there; one index over both
 * is the model the compilers actually implement.
 *
 * One dotted name may be claimed by more than one project — a split package,
 * or two projects that genuinely declare the same package. Like Python's PEP
 * 420 namespace packages (`../python.mjs`'s `resolveModuleName`), ambiguity is
 * not resolved by picking: the deepest matched prefix carries the owner set it
 * was found with, and a caller turns a multi-owner answer into `resolved: null`
 * plus a positioned failure naming the projects. Silence would be the worse
 * direction: an unresolved first-party name classified external is a missed
 * boundary crossing wearing an honest face.
 *
 * Reads are injected (`workspace.filesOf` / `workspace.readFile`) and memoized
 * per workspace object through `perWorkspace`, so a whole-tree run builds the
 * index once no matter how many files ask.
 *
 * An unreadable `.java`/`.kt` source is recorded as a whole-file failure
 * rather than dropped: a file that silently left the index would make every
 * import of a package only it declares classify external — a first-party
 * crossing wearing an external face, with nothing anywhere naming why (the
 * `../dotnet/namespaces.mjs` precedent one family over). The failure list is
 * what the graph resolvers refuse the tree on (#364's posture,
 * `../source-util.mjs`'s `refuseUnreadTree`) and what the CLI funnel merges
 * beside the analyzers' own read failures.
 */
import { fileFailure, perWorkspace } from "../source-util.mjs";
import { maskJavaComments, maskKotlinComments } from "./mask.mjs";

/**
 * The `package` declaration of an already-masked JVM source, with the offset
 * of the name itself.
 *
 * Only the FIRST match counts. JLS §7.3 and the Kotlin grammar both confine
 * the declaration to the compilation unit's header — before imports, before
 * types — so any later `package` line in masked text is text the file holds
 * but not a declaration, and honoring it could only move ownership to a lie.
 * The worst case this parse allows is a spurious record naming text the file
 * really contains, never a missed declaration.
 *
 * A UTF-8 BOM is tolerated the way `parseGoModulePath` tolerates one (#221):
 * an anchored `^package` never matches through a leading `\uFEFF`, and a
 * declaration lost to one byte drops the whole file out of the index — no
 * owners for its package, every import reaching it classified external, a
 * silent hole. The BOM is matched, not stripped, so every offset this parse
 * returns is already an offset into the original text.
 *
 * Semicolon handling: Java requires the `;`; Kotlin ends the header at the
 * newline instead. The declaration therefore terminates EITHER at a
 * semicolon — anything may follow one on the same line (`package p; import
 * q.R;` is legal Java) — OR at end of line. The keyword must be followed by
 * same-line whitespace before the name, which is what keeps a Kotlin file
 * with no package at all from reading its first `import` line as a package
 * named "import".
 *
 * Kotlin backtick-quoted package segments (``package `odd name`.``) are a
 * pinned limit: they do not match, the file contributes no index entry, and
 * imports of its package resolve as external rather than to their project.
 * Documented beside the other unread shapes when the language sections land;
 * prevalence in real trees is negligible.
 *
 * @param {string} maskedText Comment-and-literal-blanked source (same length
 *   as the original), so offsets index the original text.
 * @returns {{ name: string, offset: number }|null} `null` for a default-
 *   package file, which declares no name the index can carry.
 */
export function parseJvmPackageDeclaration(maskedText) {
  // used by its own test
  // An identifier segment starts with a letter (Unicode, via \p{L}), `_`, or
  // `$`, continues with those plus digits; segments join on optional spaces
  // around the dot, because `com . example` is legal if absurd. The match is
  // anchored to a line start (or behind an optional BOM at position 0) so a
  // mid-line `package` token never reads as the declaration.
  const JVM_PACKAGE_DECLARATION =
    /(?:^\uFEFF?|\n)[ \t]*package[ \t]+([\p{L}_$][\p{L}\p{Nd}_$]*(?:[ \t]*\.[ \t]*[\p{L}_$][\p{L}\p{Nd}_$]*)*)[ \t]*(?:;|(?=[\r\n]|$))/u;
  const match = JVM_PACKAGE_DECLARATION.exec(maskedText);
  if (!match) return null;
  // The mask preserved every byte's place, so the name's offset inside the
  // match, plus where the match starts, is its offset in the original text.
  return {
    name: match[1].replace(/[ \t]*\.[ \t]*/g, "."),
    offset: match.index + match[0].indexOf(match[1]),
  };
}

const MASK_BY_EXTENSION = {
  ".java": maskJavaComments,
  ".kts": maskKotlinComments,
  ".kt": maskKotlinComments,
};

/** The mask for a JVM source file's extension, or `undefined` elsewhere. */
const maskFor = (file) => MASK_BY_EXTENSION[file.slice(file.lastIndexOf("."))];

/**
 * Build the index: every tracked JVM source's package, attributed by longest
 * project root. Returns the map keyed by exact declared dotted name, each
 * entry listing `{ project, file }` pairs in project order — beside one
 * whole-file failure per JVM source that could not be read: a file dropped
 * from the index silently would make every import of its package classify
 * external, a first-party crossing wearing an external face, with nothing
 * anywhere naming why (`../contract.md`'s I/O law). The same discipline the
 * .NET twin holds for its namespace index (`../dotnet/namespaces.mjs`).
 *
 * @param {object} workspace `{ projects, filesOf(name), readFile(path) }`
 * @returns {{ byName: Map<string, { project: string, file: string }[]>,
 *            failures: { sourceFile: string, line: null, column: null, reason: string }[] }}
 */
function buildJvmPackageIndex(workspace) {
  const byName = new Map();
  const failures = [];
  for (const project of workspace.projects) {
    for (const file of workspace.filesOf(project.name)) {
      const mask = maskFor(file);
      if (!mask) continue;
      const text = workspace.readFile(file);
      if (text === null || text === undefined) {
        failures.push(fileFailure(file, "JVM source could not be read for the package index"));
        continue;
      }
      const declared = parseJvmPackageDeclaration(mask(text));
      if (!declared) continue;
      const owners = byName.get(declared.name) ?? [];
      owners.push({ project: project.name, file });
      byName.set(declared.name, owners);
    }
  }
  return { byName, failures };
}

/**
 * The workspace's package index, built once per workspace object. Every JVM
 * consumer — the analyzers, the graph resolvers — reads resolution through
 * this one map, so the layers can never disagree about who owns a name.
 */
export const jvmPackageIndex = perWorkspace(buildJvmPackageIndex);

/**
 * Whole-file failures for every JVM source the index could not read — the
 * funnel `../../commands/context.mjs` merges beside the manifest failures, so
 * an unreadable source refuses the verdict (exit 3) instead of quietly
 * degrading every importer of its packages to external — and the graph
 * resolvers' refusal input (#364's posture, `refuseUnreadTree`).
 *
 * @param {object} workspace
 * @returns {{ sourceFile: string, line: null, column: null, reason: string }[]}
 */
export function jvmIndexFailures(workspace) {
  return jvmPackageIndex(workspace).failures;
}

/**
 * Longest-prefix resolution over the index — the single answer both layers
 * read a specifier with, matching Go's `resolveGoModule` discipline: walk
 * from the full name toward its head, stop at the first (deepest) prefix the
 * index knows, and report the owner set found there. A shallower match under
 * a deeper hit is invisible by construction; a nested-package project is a
 * different project, and a first-shallow-match answer would name its parent.
 *
 * @param {string} specifier Dotted name as written after the `import`
 *   keyword — the importable name, which for a single-type or member import
 *   is everything before the imported member (stripped by the caller).
 * @param {Map<string, { project: string, file: string }[]>} index As built
 *   by `jvmPackageIndex`.
 * @returns {{ owners: { project: string, file: string }[], prefix: string }}
 *   | null `null` names no known prefix — the specifier is outside every
 *   tracked project (external, or first-party code this run cannot see).
 */
export function resolveJvmPackagePrefix(specifier, index) {
  const parts = specifier.split(".");
  for (let depth = parts.length; depth >= 1; depth--) {
    const prefix = parts.slice(0, depth).join(".");
    const owners = index.get(prefix);
    if (owners) return { owners, prefix };
  }
  return null;
}
