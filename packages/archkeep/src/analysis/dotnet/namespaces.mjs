/**
 * The dotnet namespace index — the content-derived `namespace → project` map
 * every C# resolution reads through.
 *
 * C#, like Java, does not enforce directory = namespace: the compiler accepts
 * any type in any file regardless of folder layout, and only conventions
 * suggest otherwise. A resolver that derived importable names from directory
 * layout would answer confidently about a tree it had misread — the failure
 * mode `../jvm/packages.mjs` avoids by reading the declaration in the file,
 * and this index reads it the same way.
 *
 * One structural difference is deliberate. A JVM package split across two
 * projects is pathological; a C# namespace spanning assemblies is ordinary —
 * partial ownership is how layered solutions grow. The index therefore
 * supports MULTIPLE owners per declared name without treating the second one
 * as a defect, and resolution (`./resolve.mjs`) decides what several owners at
 * the deepest matched prefix mean: an ambiguity failure naming every claimant,
 * never a guess. The index stays a fact-record; the judgment lives one module
 * over.
 *
 * Unlike the JVM package declaration — one per compilation unit, confined to
 * the header — C# allows MANY namespace blocks per file (including reopening
 * the same name), so the parser returns every declaration, and the builder
 * deduplicates per file rather than taking the first match.
 *
 * Reads are injected (`workspace.filesOf` / `workspace.readFile`) and memoized
 * per workspace object through `perWorkspace`, so a whole-tree run builds the
 * index once no matter how many files ask.
 */
import { fileFailure, perWorkspace } from "../source-util.mjs";
import { maskCSharpComments } from "./mask.mjs";

/**
 * Every `namespace` declaration of an already-masked C# source, with the
 * offset of each name itself.
 *
 * Both written forms match:
 *
 *     namespace X.Y.Z { … }    block form — anything may follow the brace
 *     namespace X.Y.Z;         file-scoped form (C# 10+)
 *
 * The name must start on the declaration's own line (anchored behind a line
 * head, optionally after a UTF-8 BOM, which would otherwise hide a first-line
 * declaration and drop the whole file out of the index — the silent direction
 * `../jvm/packages.mjs` refuses for the same byte). Spaces around dots are
 * tolerated the way the JVM declaration tolerates them, because `namespace X
 * . Y` compiles. The terminator is `;`, or a lookahead over whitespace and
 * newlines for `{` — a brace on its own line below the declaration still
 * opens a block form.
 *
 * A UTF-8 BOM is matched, not stripped, so every offset returned indexes the
 * original text directly.
 *
 * `namespace` is a reserved word, so in masked code the keyword only ever
 * introduces a declaration; a verbatim identifier (`var @namespace = 1;`)
 * keeps the `@` between the line head and the keyword and cannot match.
 *
 * @param {string} maskedText Comment-and-literal-blanked source (same length
 *   as the original), so offsets index the original text.
 * @returns {{ name: string, offset: number }[]} Every declaration, in source
 *   order; empty for a file outside any namespace (the global namespace),
 *   which declares no name the index can carry.
 */
export function parseCSharpNamespaceDeclarations(maskedText) {
  const CS_NAMESPACE_DECLARATION =
    /(?:^\uFEFF?|\n)[ \t]*namespace[ \t]+([\p{L}_][\p{L}\p{Nd}_]*(?:[ \t]*\.[ \t]*[\p{L}_][\p{L}\p{Nd}_]*)*)[ \t]*(?:;|(?=[{;\r\n]|$))/gu;
  const declarations = [];
  for (const match of maskedText.matchAll(CS_NAMESPACE_DECLARATION)) {
    const name = match[1].replace(/[ \t]*\.[ \t]*/g, ".");
    declarations.push({
      name,
      offset: match.index + match[0].indexOf(match[1]),
    });
  }
  return declarations;
}

const MASK_BY_EXTENSION = { ".cs": maskCSharpComments };

/** The mask for a dotnet source file's extension, or `undefined` elsewhere. */
const maskFor = (file) => MASK_BY_EXTENSION[file.slice(file.lastIndexOf("."))];

/**
 * Build the index: every tracked `.cs` source's namespaces, attributed by
 * longest project root. Returns the map keyed by exact declared dotted name,
 * each entry listing `{ project, file }` pairs in project order — one pair
 * per FILE even when a file declares the same namespace twice, because a
 * reopened block is one declaration's worth of ownership, not two — beside
 * one whole-file failure per `.cs` source that could not be read: a file
 * dropped from the index silently would make every import of its namespaces
 * classify external, a first-party crossing wearing an external face, with
 * nothing anywhere naming why (`../contract.md`'s I/O law).
 *
 * @param {object} workspace `{ projects, filesOf(name), readFile(path) }`
 * @returns {{ byName: Map<string, { project: string, file: string }[]>,
 *            failures: { sourceFile: string, line: null, column: null, reason: string }[] }}
 */
function buildCsharpNamespaceIndex(workspace) {
  const byName = new Map();
  const failures = [];
  for (const project of workspace.projects) {
    for (const file of workspace.filesOf(project.name)) {
      if (!maskFor(file)) continue;
      const text = workspace.readFile(file);
      if (text === null || text === undefined) {
        failures.push(fileFailure(file, "C# source could not be read for the namespace index"));
        continue;
      }
      for (const declared of parseCSharpNamespaceDeclarations(maskCSharpComments(text))) {
        const owners = byName.get(declared.name) ?? [];
        if (!owners.some((owner) => owner.file === file)) {
          owners.push({ project: project.name, file });
          byName.set(declared.name, owners);
        }
      }
    }
  }
  return { byName, failures };
}

/**
 * The workspace's namespace index, built once per workspace object. Every
 * consumer — the analyzer and the graph resolver — reads resolution through
 * this one map, so the layers can never disagree about who owns a name.
 */
export const csharpNamespaceIndex = perWorkspace(buildCsharpNamespaceIndex);

/**
 * Whole-file failures for every `.cs` source the index could not read — the
 * funnel `../../commands/context.mjs` merges beside the manifest failures, so
 * an unreadable source refuses the verdict (exit 3) instead of quietly
 * degrading every importer of its namespaces to external.
 *
 * @param {object} workspace
 * @returns {{ sourceFile: string, line: null, column: null, reason: string }[]}
 */
export function dotnetIndexFailures(workspace) {
  return csharpNamespaceIndex(workspace).failures;
}

/**
 * Longest-prefix resolution over the index — the single answer both layers
 * read a specifier with, matching the discipline `../jvm/packages.mjs`'s
 * `resolveJvmPackagePrefix` states: walk from the full name toward its head,
 * stop at the first (deepest) prefix the index knows, and report the owner
 * set found there. A shallower match under a deeper hit is invisible by
 * construction; a nested-namespace project is a different project, and a
 * first-shallow-match answer would name its parent.
 *
 * Mirrored here rather than imported across family directories: the walk is
 * eight lines, and a cross-family import would couple `dotnet/`'s resolution
 * to a module whose headers argue Java and Kotlin. The DISCIPLINE is shared
 * and cited; the spelling stays local.
 *
 * @param {string} specifier Dotted name as written after `using` (aliases
 *   already stripped by the caller).
 * @param {Map<string, { project: string, file: string }[]>} index As built
 *   by `csharpNamespaceIndex`.
 * @returns {{ owners: { project: string, file: string }[], prefix: string }}
 *   | null `null` names no known prefix — the specifier is outside every
 *   tracked project (a framework namespace, a NuGet package's namespace, or
 *   first-party code this run cannot see).
 */
export function resolveDottedNamespacePrefix(specifier, index) {
  const parts = specifier.split(".");
  for (let depth = parts.length; depth >= 1; depth--) {
    const prefix = parts.slice(0, depth).join(".");
    const owners = index.get(prefix);
    if (owners) return { owners, prefix };
  }
  return null;
}
