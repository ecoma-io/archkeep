/**
 * Go resolver — static analysis only, no `go` binary required (the same
 * property gonx gets from tree-sitter, achieved here with a comment mask and
 * two regexes over a format that `gofmt` keeps canonical for the whole
 * ecosystem).
 *
 * Model: one Go module per Nx project (`<projectRoot>/go.mod`); the module
 * path is the project's identity. An import of another project's module path
 * (exact or `<modulePath>/...`) is a static edge.
 *
 * **Comments are blanked before either regex runs** (`maskGoComments`). A
 * regex that cannot see a comment misreads ordinary, `gofmt`-clean Go in both
 * directions, and only one of those directions is survivable. A `)` written
 * inside a comment — `// TODO(alice): drop this once the port lands`, or the
 * note a blank import is expected to carry, `_ "github.com/lib/pq" // register
 * the driver (postgres)` — closes the `import (…)` block early, and every
 * import below it disappears: no graph edge, so `nx affected` stops rebuilding
 * dependents, and no import record, so the boundary check calls the file clean
 * while a violation sits in it. A checker that reports "clean" about a file it
 * failed to read is worse than no checker. The opposite direction — an import
 * written inside a block comment counted as one that is written — costs a
 * spurious edge, and the same mask removes it.
 *
 * Known parse limit, deliberate and pinned by tests, and it errs toward a
 * record naming text the file really contains, never toward a missed import:
 *
 * - A **raw string literal** holding what looks like an import declaration at
 *   the start of one of its lines is read as that declaration. `gofmt` leaves
 *   such a file alone, so this is the one limit a formatted tree still meets.
 *   The mask keeps raw strings intact on purpose: an import path is itself a
 *   string literal, and a mask that ate string literals would have nothing
 *   left to read.
 *
 * `import` opens its line, after indentation only, OR follows a `;` on the
 * same line — the same statement separator `gofmt` inserts automatically at
 * a newline, so an explicit one reopens an import exactly the way a fresh
 * line does: `import "a"; import "b"` and, inside a block, `import ("a";
 * "b")` both read as two imports, not one followed by inert text. The path
 * itself may be a quoted string or, since Go treats a raw string as an
 * equally legal string literal, backtick-delimited — both spellings are read
 * the same way, though only the quoted form is what `gofmt` ever writes.
 *
 * Two layers read those regexes. `resolveGoDependencies` reduces them to Nx
 * graph edges; `analyzeGo` returns the fuller import-site record
 * `analysis/contract.md` fixes — same parse, same limits, more of the answer
 * kept. `parseGoImportSites` is the single parse both go through, so the two
 * layers can never disagree about what a file imports.
 *
 * What the richer record adds, and what it deliberately leaves null:
 *
 * - `file` is always `null`. A Go import names a **package directory**, not a
 *   file, and which files that directory contributes is a build-constraint
 *   question needing the toolchain this resolver exists to avoid. That is the
 *   "resolution stops at a package rather than a file" case the contract
 *   allows, not a gap.
 * - `packageName` for an external import is the whole import path. Where a
 *   module path ends and a package path begins inside `example.com/a/b/c` is
 *   not statically knowable — only the module proxy knows — so the full path
 *   stands in, and a `bannedExternalImports` glob matches it the same way it
 *   would match a module prefix.
 * - `kind` is always `static`. Go has no dynamic import, no type-only import,
 *   and no re-export form; a blank (`_`) or dot (`.`) import is still an
 *   ordinary compile-time dependency.
 * - `spelling.path` is always `false`; `spelling.relative` is true exactly when
 *   the import resolved to the source file's own project. Go has no relative
 *   import form, so the second bit reads what an import REACHED rather than
 *   how it was written — `isOwnProjectImport` states why that is the honest
 *   answer for a language whose package graph cannot cycle.
 */
import { normalizePath } from "./manifest-util.mjs";
import {
  emptyResult,
  fileFailure,
  perWorkspace,
  positionAt,
  projectOwning,
  trackedManifests,
} from "./source-util.mjs";

/**
 * Module path declared in a go.mod, or null.
 *
 * The token may be `"`-quoted — `module "example.com/beta"` is legal,
 * gofmt-clean go.mod syntax, the same string-literal spelling an import path
 * uses. The quotes are not part of the path: kept, they would silently break
 * every comparison against an (unquoted) import path, dropping the edge in
 * both directions for a module declared this way. A backquoted module path is
 * NOT stripped here because it is not legal go.mod syntax to begin with — the
 * real toolchain rejects it, so there is nothing gofmt-clean to preserve.
 */
export function parseGoModulePath(goModText) {
  const match = goModText.match(/^module\s+(\S+)/m);
  if (!match) return null;
  const token = match[1];
  return token.length >= 2 && token.startsWith('"') && token.endsWith('"')
    ? token.slice(1, -1)
    : token;
}

/** Every character of `text` except its line breaks, replaced by a space. */
const blankOut = (text) => text.replace(/[^\n]/g, " ");

/** Where the scan has to stop and decide: a comment opener or a literal. */
const LEXICAL_START = /\/\/|\/\*|["'`]/g;

/**
 * `goText` with every comment blanked out, byte-for-byte the same length and
 * with its line breaks in place, so an offset into the result is the same
 * offset into the original.
 *
 * A regex that cannot see a comment reads Go wrong in both directions, and
 * this is the single pass that makes both go away — see the header for what
 * each direction costs. Blanking rather than deleting is what keeps
 * `positionAt` honest: the import-site record is read as `file:line:column`,
 * and a mask that shortened the text would report every position after the
 * first comment somewhere it is not.
 *
 * The scan has to know Go's literals to know where a comment is NOT: `//`
 * inside a string is text, and so is the `*` + `/` that would otherwise close
 * a block comment. Three literal forms carry that risk — an interpreted string
 * and a rune literal, both escaped with `\` and neither able to span a line,
 * and a raw string, which takes no escapes and may span as many lines as it
 * likes. Go's block comments do not nest, so the first terminator closes one
 * however many openers precede it.
 *
 * @param {string} goText
 * @returns {string} Same length as `goText`.
 */
export function maskGoComments(goText) {
  const scan = new RegExp(LEXICAL_START.source, "g");
  let masked = "";
  let copied = 0;
  let match;
  while ((match = scan.exec(goText)) !== null) {
    const start = match.index;
    let end;
    let isComment = false;
    if (match[0] === "//") {
      // A line comment runs to the newline, which is not part of it.
      const newline = goText.indexOf("\n", start);
      end = newline === -1 ? goText.length : newline;
      isComment = true;
    } else if (match[0] === "/*") {
      const terminator = goText.indexOf("*/", start + 2);
      end = terminator === -1 ? goText.length : terminator + 2;
      isComment = true;
    } else if (match[0] === "`") {
      const close = goText.indexOf("`", start + 1);
      end = close === -1 ? goText.length : close + 1;
    } else {
      // Interpreted string or rune literal: `\` escapes the next character,
      // except at a line break, where the literal is unterminated instead.
      let at = start + 1;
      while (at < goText.length && goText[at] !== match[0] && goText[at] !== "\n") {
        at += goText[at] === "\\" && goText[at + 1] !== "\n" ? 2 : 1;
      }
      end = Math.min(goText[at] === match[0] ? at + 1 : at, goText.length);
    }
    const span = goText.slice(start, end);
    masked += goText.slice(copied, start) + (isComment ? blankOut(span) : span);
    copied = end;
    scan.lastIndex = end;
  }
  return masked + goText.slice(copied);
}

// An import alias is a Go identifier: `\p{L}` is what `unicode.IsLetter`
// accepts as a starting rune (gofmt permits `import π "…"`), and the ASCII
// `[A-Za-z_.]` this used to be silently dropped every non-ASCII one — a
// silent missed edge/import, not a rejection. The `u` flag both regexes below
// are built with is what makes `\p{...}` a Unicode class rather than a
// literal `p`.
const GO_IMPORT_ALIAS = "[\\p{L}_.][\\p{L}\\p{Nd}_.]*";

/**
 * Every import in a .go file with the offset of its quoted path, in source
 * order and WITHOUT deduplication — one entry per written import, which is
 * what an import-site record is (`analysis/contract.md`).
 *
 * Offsets index the ORIGINAL text, not the mask: `maskGoComments` preserves
 * length, so the two are the same coordinate system.
 *
 * @param {string} goText
 * @returns {{ specifier: string, offset: number }[]}
 */
export function parseGoImportSites(goText) {
  const source = maskGoComments(goText);
  const sites = [];
  // import "p" | import alias "p" | import _ "p" | import . "p" — the path
  // quoted or backtick-delimited, and the whole spec opening either a line or
  // (see the header) a `;`-separated continuation of one.
  const singleForm = new RegExp(
    `(?:^|;)\\s*import\\s+(?:${GO_IMPORT_ALIAS}\\s+)?(?:"([^"]+)"|\`([^\`]+)\`)`,
    "gmu",
  );
  for (const m of source.matchAll(singleForm)) {
    const quote = m[1] !== undefined ? '"' : "`";
    sites.push({ specifier: m[1] ?? m[2], offset: m.index + m[0].indexOf(quote) });
  }
  const blockForm = new RegExp(
    `(?:^|;)\\s*(?:${GO_IMPORT_ALIAS}\\s+)?(?:"([^"]+)"|\`([^\`]+)\`)`,
    "gmu",
  );
  for (const block of source.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)) {
    const contentOffset = block.index + block[0].indexOf("(") + 1;
    for (const m of block[1].matchAll(blockForm)) {
      const quote = m[1] !== undefined ? '"' : "`";
      sites.push({
        specifier: m[1] ?? m[2],
        offset: contentOffset + m.index + m[0].indexOf(quote),
      });
    }
  }
  return sites.sort((a, b) => a.offset - b.offset);
}

/** Every import path in a .go file (single-form and block-form), deduped. */
export function parseGoImports(goText) {
  return [...new Set(parseGoImportSites(goText).map((site) => site.specifier))];
}

/**
 * Static edges between Go projects.
 *
 * `projects`: [{ name, root }]; `filesOf(name)`: workspace-relative paths of
 * a project's tracked files; `readFile(path)`: contents or null. Returns raw
 * Nx dependencies ({ source, target, sourceFile, type: "static" }).
 */
export function resolveGoDependencies(projects, filesOf, readFile) {
  const moduleOf = new Map(); // module path -> project name
  const goProjects = [];
  for (const project of projects) {
    const goModPath = normalizePath(project.root, "go.mod");
    if (!filesOf(project.name).includes(goModPath)) continue;
    const modulePath = parseGoModulePath(readFile(goModPath) ?? "");
    if (!modulePath) continue;
    moduleOf.set(modulePath, project.name);
    goProjects.push(project);
  }

  const dependencies = [];
  for (const project of goProjects) {
    for (const file of filesOf(project.name)) {
      if (!file.endsWith(".go")) continue;
      const text = readFile(file);
      if (text === null) continue;
      for (const importPath of parseGoImports(text)) {
        // The same longest-module-path resolution `analyzeGo` applies, so the
        // graph edge names the same project the import-site record resolves to
        // (WSX-D02): a nested module is its own project, not its parent.
        const resolved = resolveGoModule(
          importPath,
          [...moduleOf].map(([modulePath, target]) => ({ modulePath, project: target })),
        );
        if (resolved !== null && resolved.project !== project.name && resolved.project !== null) {
          dependencies.push({
            source: project.name,
            target: resolved.project,
            sourceFile: file,
            type: "static",
          });
        }
      }
    }
  }
  return dependencies;
}

/**
 * Every project's Go module paths, read once per workspace rather than once
 * per `.go` file. Every tracked `go.mod` in a project counts, not only the one
 * at its root — see `trackedManifests` for why analysis is broader here than
 * the edge resolver above.
 */
const goModulesOf = perWorkspace((workspace) => {
  const byModulePath = new Map(); // module path -> project name
  const byProject = new Map(); // project name -> [module path]
  for (const project of workspace.projects) {
    for (const goModPath of trackedManifests(workspace, project.name, "go.mod")) {
      const modulePath = parseGoModulePath(workspace.readFile(goModPath) ?? "");
      if (!modulePath) continue;
      byModulePath.set(modulePath, project.name);
      byProject.set(project.name, [...(byProject.get(project.name) ?? []), modulePath]);
    }
  }
  return { byModulePath, byProject };
});

/** True when `importPath` is inside the module rooted at `modulePath`. */
const isUnderModule = (importPath, modulePath) =>
  importPath === modulePath || importPath.startsWith(`${modulePath}/`);

/**
 * The single longest-module-path resolution both layers read an import with,
 * so the graph and the verdict can never disagree about which project an
 * import belongs to (WSX-D02): a module nested under another module's path is
 * a different project, and a first-match answer names its parent.
 *
 * @param {string} importPath
 * @param {({ modulePath: string, project: string | null })[]} modules
 *   Longest-match candidates; `project` null marks an own-module candidate.
 * @returns {{ matched: string, project: string | null } | null} `null` when
 *   no module claims `importPath`.
 */
export function resolveGoModule(importPath, modules) {
  let matched = "";
  let project = null;
  for (const { modulePath, project: target } of modules) {
    if (!isUnderModule(importPath, modulePath)) continue;
    if (modulePath.length <= matched.length) continue;
    matched = modulePath;
    project = target;
  }
  return matched === "" ? null : { matched, project };
}

/**
 * Did this import land inside the file's own project — the `spelling.relative`
 * bit of the analysis record (`contract.md`)?
 *
 * Go has no relative import form: every import is the full module-qualified
 * package path, so a package reaching a sibling package of its own module must
 * spell the module path out. That is the same position Rust's
 * `isOwnProjectPath` answers for a binary naming its own package's library
 * crate — the language offers no other spelling, so the spelling is not
 * evidence of anything.
 *
 * The bit exists as counter-evidence for `noSelfCircularDependencies`, which
 * names a file leaving its project through the project's public alias and
 * coming back in. A Go import cannot be that: the compiler rejects an import
 * cycle outright, so an import resolving to the source's own project is
 * internal by construction, and reporting it would demand a form the language
 * does not have. Nx models one module as one project, so source and target
 * land on the same node whenever a real Go project has two packages.
 *
 * @param {string|null} target The project the import resolved to.
 * @param {{name: string}|null} owner The project owning the source file.
 * @returns {boolean}
 */
const isOwnProjectImport = (target, owner) => target !== null && target === owner?.name;

/**
 * Analyzes one `.go` file.
 *
 * An import of the file's own module resolves to its own project rather than
 * being dropped: `contract.md` keeps intra-project imports because a rule
 * about a project reaching itself through its public path cannot be written
 * without them.
 *
 * @param {{ sourceFile: string, text: string, workspace: object }} request
 * @returns {{ imports: object[], failures: object[] }}
 */
export function analyzeGo({ sourceFile, text, workspace }) {
  const result = emptyResult();
  try {
    const { byModulePath, byProject } = goModulesOf(workspace);
    const owner = projectOwning(workspace.projects, sourceFile);
    const ownModules = owner ? (byProject.get(owner.name) ?? []) : [];

    for (const site of parseGoImportSites(text)) {
      const { line, column } = positionAt(text, site.offset);
      // The one resolution both layers share (WSX-D02): longest module path
      // wins, for the reason `projectOwning` matches the longest project root —
      // a module nested under another module's path is a different project,
      // and a first-match answer would name its parent.
      const resolved = resolveGoModule(site.specifier, [
        ...ownModules.map((modulePath) => ({ modulePath, project: owner?.name ?? null })),
        ...[...byModulePath].map(([modulePath, project]) => ({ modulePath, project })),
      ]);
      const target = resolved?.project ?? null;
      result.imports.push({
        sourceFile,
        line,
        column,
        specifier: site.specifier,
        kind: "static",
        // Both answers are the language's rather than a default. `path` is
        // never true: a Go import path is a PACKAGE path resolved through the
        // module graph, never a filesystem path resolved against the importing
        // file — modules mode rejects `import "./sub"` outright.
        //
        // `relative` is true exactly when the import landed inside the file's
        // own project, which is `isOwnProjectImport` above and the same answer
        // Rust gives a binary that names its own package's library crate.
        spelling: { path: false, relative: isOwnProjectImport(target, owner) },
        resolved: {
          target,
          file: null,
          external: target === null,
          packageName: target === null ? site.specifier : null,
        },
      });
    }
  } catch (cause) {
    result.failures.push(fileFailure(sourceFile, `Go analysis failed: ${cause?.message ?? cause}`));
  }
  return result;
}
