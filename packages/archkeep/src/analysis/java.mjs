/**
 * Java analyzer — header-region extraction over comment-and-literal-masked
 * text, in the shape `./go.mjs` established: one shared parse feeding both
 * layers, so the graph edge and the import-site record can never disagree
 * about what a file imports.
 *
 * Static analysis only, no JDK required (`../../../../docs/reference/languages.md`
 * owns
 * why graphs compute on machines with no toolchain). JLS §7.3 confines the
 * compilation unit to `[PackageDecl] {ImportDecl} {TypeDecls}`, and §7.5.1–4
 * fixes exactly four import forms:
 *
 *     import a.b.C;                    single type
 *     import a.b.*;                    on-demand (wildcard)
 *     import static a.b.C.member;      static single member
 *     import static a.b.C.*;           static on-demand
 *
 * No dynamic import, no type-only form, no re-export syntax, no aliasing:
 * `kind` is always `"static"` here, and `spelling.path` is always `false`
 * because no Java import is spelled as a filesystem path — `spelling.namesOnly`
 * is always `true`, a package name being a name and never a path (#376).
 * `spelling.relative`
 * takes Go's argued answer — true exactly when the import resolved into its
 * own project — because Java offers no relative spelling either, so the bit
 * reads what an import REACHED rather than how it was written.
 *
 * The specifier is the trimmed text between the keyword and the semicolon —
 * `com.acme.Foo`, `com.acme.*`, `static com.acme.Util.FOO` — the same choice
 * Python makes of keeping what is imported rather than the statement around
 * it, minus the keyword itself.
 *
 * Known parse limits, deliberate and pinned by tests, each erring toward a
 * record naming text the file really contains or toward a documented silence,
 * never toward a wrong project:
 *
 * - A **multi-line import statement** (`import a.b.\n    C;`) is not read:
 *   the name must sit on the declaration's own line. Every formatter formats
 *   imports onto one line, so this is the one limit a formatted tree never
 *   meets; the miss is silent for that import and compensated by the manifest
 *   resolvers' independent edges.
 * - **Fully-qualified names used WITHOUT an import** are invisible by design
 *   — same-package references and inline FQNs need no import statement, so
 *   import-only extraction cannot see them. Documented for Kotlin too, where
 *   the identical gap exists.
 * - A **raw identifier segment with Unicode letters** resolves like any
 *   other; backtick-quoted segments are not Java and are not read.
 */
import { maskJavaComments } from "./jvm/mask.mjs";
import { jvmPackageIndex } from "./jvm/packages.mjs";
import { resolveJvmSpecifier } from "./jvm/resolve.mjs";
import {
  emptyResult,
  fileFailure,
  positionAt,
  projectOwning,
  refuseUnreadTree,
} from "./source-util.mjs";

/**
 * Every import in a `.java` file, in source order and WITHOUT deduplication —
 * one entry per written import, which is what an import-site record is.
 *
 * Offsets index the ORIGINAL text: the mask preserves length, so the two are
 * the same coordinate system. The name anchor is found by locating the
 * captured name inside the matched span rather than by assuming where the
 * regex left it.
 *
 * @param {string} javaText Raw file contents.
 * @returns {{ specifier: string, importableName: string, offset: number }[]}
 */
export function parseJavaImportSites(javaText) {
  // used by its own test
  const source = maskJavaComments(javaText);
  // Anchored to a line head — through a leading UTF-8 BOM, matched rather than
  // stripped so offsets keep indexing the bytes on disk, the same anchor
  // `./jvm/packages.mjs`'s package declaration and `./csharp.mjs` hold
  // (#221's lesson) — OR behind a semicolon (`package p; import q.R;` is legal
  // Java), with the name required to start on the same line, which pins the
  // multi-line limit above instead of silently mis-reading one. Name grammar:
  // dot-joined identifier segments with ONE optional trailing `.*` (the
  // on-demand form); nothing else matches, so `a.*.b` and friends are text,
  // not imports. The terminator is a lookahead, never a consumed `;` (#407):
  // consuming it left the scan past the anchor of a second import on the same
  // line, so `import a.B; import c.D;` read only the first — un-consumed, the
  // `;` anchors the next import exactly as a line head does.
  const SEG = String.raw`[\p{L}_$][\p{L}\p{Nd}_$]*`;
  const JAVA_IMPORT = new RegExp(
    `(?:^\\uFEFF?|[\\n;])[ \\t]*(?:import[ \\t]+)(static[ \\t]+)?(${SEG}(?:\\.${SEG})*(?:\\.\\*)?)[ \\t]*(?=;)`,
    "gu",
  );
  const sites = [];
  for (const match of source.matchAll(JAVA_IMPORT)) {
    const staticKeyword = match[1] ?? "";
    const name = match[2];
    const specifier = `${staticKeyword}${name}`;
    const nameOffsetInMatch = match[0].indexOf(name);
    sites.push({
      specifier,
      importableName: importableNameOf(staticKeyword, name),
      offset: match.index + nameOffsetInMatch,
    });
  }
  return sites.sort((a, b) => a.offset - b.offset);
}

/**
 * Why a `.java` file's imports cannot be fully read, as a reason for
 * `analyzeJava` to record as a whole-file failure (`contract.md`): an
 * `import` that never reaches its `;`.
 *
 * The detection mirrors the import regex's own failure conditions, so a file
 * it reads fully is never flagged. The opener is the import regex's own head
 * — line head through a BOM, or behind a `;`, then `import` and whitespace —
 * which is also what keeps the header's documented single-line limit a LIMIT:
 * a line-wrapped import (`import` then `\n`) matches neither this scan nor
 * the site regex, so it stays a missed record, never a refusal. And the `;`
 * is required to arrive before the next `{`: the brace a type body opens with
 * is what separates a line-wrapped import (whose `;` precedes any body) from
 * a truncated one (whose body opens first), so an `import` cut off before its
 * `;` — a failed write, a merge marker left mid-import — no longer parses as
 * zero import sites with no failure, byte-for-byte identical to a file that
 * imports nothing (#419). The Go posture `goImportMalformations` set: shapes
 * the regex answers are the documented parse limits; the shape it cannot
 * answer is the failure.
 *
 * Comments, strings and text blocks are masked first — the same
 * `maskJavaComments` the site parser runs — so import-shaped text a code
 * generator's template or a comment holds is never read as import syntax and
 * a compiling file is never reported as broken.
 *
 * @param {string} javaText Raw file contents.
 * @returns {string[]} One reason naming its line, or empty when the imports
 *   read fully.
 */
export function javaImportMalformations(javaText) {
  // used by its own test
  const source = maskJavaComments(javaText);
  const JAVA_IMPORT_HEAD = /(?:^\uFEFF?|[\n;])[ \t]*(?:import[ \t]+)/gu;
  /** @type {string[]} */
  const reasons = [];
  // `;` and `{` ascend with the text, and so do the openers, so one shared
  // cursor walks both lists in a single pass — the same shape the Rust scan's
  // non-overlapping windows hold, instead of an `indexOf` per opener that
  // rescans the tail (`.rs` content is attacker-supplied per SECURITY.md).
  const terminators = [...source.matchAll(/[;{]/g)];
  let cursor = 0;
  for (const m of source.matchAll(JAVA_IMPORT_HEAD)) {
    const at = m.index + m[0].length;
    while (cursor < terminators.length && terminators[cursor].index < at) cursor += 1;
    const next = terminators[cursor];
    if (next === undefined || next[0] === "{") {
      // The matched span starts at its ANCHOR (a `\n` or `;`), so the
      // reason must locate the keyword inside the span rather than point at
      // m.index — the anchor is the PREVIOUS line when it is a `\n`, and a
      // diagnostic naming the wrong line sends every reader to the wrong
      // import. The same locate-it move `parseJavaImportSites` makes for
      // the name.
      const importOffset = m.index + m[0].indexOf("import");
      reasons.push(
        "an `import` never reaches its `;` — the file is truncated or malformed, " +
          `so its imports cannot be read (line ${positionAt(javaText, importOffset).line})`,
      );
      break;
    }
  }
  return reasons;
}

/**
 * The dotted name resolution walks for an import, stripped of the parts that
 * name members rather than packages:
 *
 * - the on-demand form drops its trailing `.*` (for `import a.b.*` the
 *   importable is the package `a.b`; for `import static a.b.C.*` it is the
 *   package-plus-type `a.b.C`, whose longest DECLARED prefix still resolves
 *   to `a`'s owner);
 * - static single forms drop their last segment (the member — field, method,
 *   or static nested type), leaving package-plus-type whose longest declared
 *   prefix resolves the same way any import does;
 * - everything else resolves whole: a nested-type import (`a.b.Outer.Inner`)
 *   stops at the deepest DECLARED package naturally, because types are not
 *   index keys.
 *
 * @param {string} staticKeyword The captured `static ` keyword or "".
 * @param {string} name The dotted name as written.
 * @returns {string}
 */
function importableNameOf(staticKeyword, name) {
  if (name.endsWith(".*")) return name.slice(0, -2);
  if (staticKeyword !== "") {
    const lastDot = name.lastIndexOf(".");
    return lastDot === -1 ? name : name.slice(0, lastDot);
  }
  return name;
}

/**
 * Analyzes one `.java` file.
 *
 * An ambiguous package (two tracked projects declaring the same deepest
 * prefix) resolves to `resolved: null` WITH a positioned failure naming both
 * projects — the split-package case, where picking either side would report
 * violations against a guess. Intra-project imports are emitted as records
 * (`contract.md`), with `spelling.relative` true exactly there.
 *
 * The package index arrives through `jvmPackageIndex` — already memoized per
 * workspace object — so one whole-tree run builds it once however many files
 * ask, and the graph resolver below reads the same map through the same memo.
 *
 * @param {{ sourceFile: string, text: string, workspace: object }} request
 * @returns {{ imports: object[], failures: object[] }}
 */
export function analyzeJava({ sourceFile, text, workspace }) {
  const result = emptyResult();
  try {
    const { byName: index } = jvmPackageIndex(workspace);
    const owner = projectOwning(workspace.projects, sourceFile);
    // A file truncated inside an import used to parse as importing nothing,
    // with no failure beside the empty result — the clean verdict over it was
    // the bug (#419). The whole-file shape is what turns the verdict loud:
    // `check` counts the file toward `unchecked` and refuses to call the run
    // complete, instead of reporting a hole as a clean file.
    for (const reason of javaImportMalformations(text)) {
      result.failures.push(fileFailure(sourceFile, reason));
    }
    for (const site of parseJavaImportSites(text)) {
      const { line, column } = positionAt(text, site.offset);
      const resolved = resolveJvmSpecifier(site.importableName, { language: "java" }, index);
      let resolution;
      if (resolved.external) {
        // A name no tracked project claims: classified, never dropped, and
        // deliberately NOT added as an externalNodes entry here — only
        // project↔project edges matter to the graph (`AGENTS.md`).
        resolution = {
          target: null,
          file: null,
          external: true,
          packageName: site.importableName,
        };
        // The bare-coordinate class the contract discloses without withholding
        // (#603): the dotted name names the external dependency universe, not
        // the governed graph, so the site is DISCLOSED — a positioned row
        // carrying `external: true` (`isExternalSiteFailure`), the run's
        // verdict untouched — rather than swallowed, the same classification
        // the TypeScript analyzer already emits. A name a tracked package
        // prefix claims resolved through the index above and never reaches
        // this branch; the split-package branch below keeps withholding.
        result.failures.push({
          sourceFile,
          line,
          column,
          reason: `Java cannot resolve '${site.importableName}' from '${sourceFile}'`,
          external: true,
        });
      } else if (resolved.ambiguous) {
        // Split package: unresolvable by static reading, so `resolved` is
        // null WITH a positioned failure naming every claimant — the Python
        // PEP 420 precedent, and never an edge against a guess.
        resolution = null;
        result.failures.push({
          sourceFile,
          line,
          column,
          reason:
            `'${resolved.matchedPrefix}' is declared by more than one project ` +
            `(${resolved.ambiguous.join(", ")}) — Java would pick by classpath order, ` +
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
      fileFailure(sourceFile, `Java analysis failed: ${cause?.message ?? cause}`),
    );
  }
  return result;
}

/**
 * Static edges between JVM projects derived from written imports — the
 * source-truth half of the two-track principle. `resolveMavenDependencies`
 * owns the manifest half; neither replaces the other.
 *
 * Takes ONE workspace-shaped object (`{ projects, filesOf, readFile }`) rather
 * than the positional triple: the package index is memoized on that object,
 * so the caller's one object — shared with `analyzeJava`, the Kotlin resolver
 * and the manifest resolvers — is what makes the index build once per run
 * instead of once per call site (#363). Returns raw Nx dependencies
 * ({ source, target, sourceFile, type: "static" }). Ambiguous names draw no
 * edge — analysis reports them loudly instead, and an edge against a guess
 * would be worse than the missing one. An unreadable `.java`/`.kt` source
 * refuses the whole graph (#364's posture — the index state corrupts every
 * importer of its packages, so the failure cannot be attributed to the
 * file's own edges), through the same `refuseUnreadTree` the manifest
 * resolvers hold.
 *
 * @param {object} workspace `{ projects, filesOf(name), readFile(path) }`
 * @returns {{ source: string, target: string, sourceFile: string, type: string }[]}
 * @throws {Error} when `jvmPackageIndex` recorded any failure, naming each
 *   unreadable JVM source.
 */
export function resolveJavaDependencies(workspace) {
  const { projects, filesOf, readFile } = workspace;
  // #364's posture closes the gap #397's comment below named: the hook DOES
  // have a loud channel — a throw, which Nx turns into a failed graph
  // computation — so the index's read failures are consumed here after all,
  // through the same `refuseUnreadTree` the manifest readers hold.
  const { byName: index, failures: indexFailures } = jvmPackageIndex(workspace);
  refuseUnreadTree("the JVM package index", indexFailures);
  const dependencies = [];
  for (const project of projects) {
    for (const file of filesOf(project.name)) {
      if (!file.endsWith(".java")) continue;
      const text = readFile(file);
      if (text === null) continue;
      for (const site of parseJavaImportSites(text)) {
        const resolved = resolveJvmSpecifier(site.importableName, { language: "java" }, index);
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
