/**
 * C# analyzer — directive extraction over comment-and-literal-masked text,
 * sharing the dotnet core with the namespace index exactly the way
 * `./java.mjs` shares the JVM one (`docs/adr/0006-dotnet-language-integration.md`).
 *
 * Static analysis only, no .NET SDK required (`docs/reference/languages.md`
 * owns why graphs compute on machines with no toolchain). C# fixes five
 * written directive forms plus one alias-adjacent spelling:
 *
 *     using X.Y.Z;                          namespace (whole-namespace import)
 *     using static X.Y.Z.Type;              static members of a type
 *     using Alias = X.Y.Z;                  namespace/type alias
 *     using Alias = X.Y.Z.Type;             type alias — resolves by its base
 *     global using X.Y.Z;                   file-set-wide (C# 10+)
 *     extern alias X;                       externally supplied root alias
 *
 * Every dotted subject may carry the `global::` qualifier — `using
 * global::X.Y;`, `using static global::X.Y.T;`, `using A = global::X.Y;` —
 * legal wherever a local name shadows a namespace, and common in generated
 * code. The qualifier is syntax around the subject, so it is stripped before
 * classification and stays out of the specifier, the same way an alias's own
 * name does: `imp` must equal `packageName` for an external ban to fire.
 *
 * A UTF-8 BOM is matched, never stripped — the same byte
 * `./dotnet/namespaces.mjs` and the JVM package declaration tolerate (#221's
 * lesson, `../jvm/packages.mjs`): a first-line directive behind one is read,
 * and every offset this parse returns stays an offset into the bytes on disk
 * (`../contract.md`'s byte-tolerance law). A directive may sit wherever a
 * fresh declaration may — after `;`, `{` or `}` on the same line, so
 * `namespace N { using A.B; }` is read — besides the line head.
 *
 * There is no wildcard form (a plain `using` already imports a whole
 * namespace), no dynamic form, no re-export syntax: `kind` is always
 * `"static"`, and `spelling.path` is always `false` because no C# directive is
 * spelled as a filesystem path — `spelling.namesOnly` is always `true`, so a
 * namespace whose root is literally named `libs` is a name, not a path into a
 * project (#376). `spelling.relative` takes Go's argued answer —
 * true exactly when the directive resolved into its own project — because no
 * C# spelling is relative either, so the bit reads what a directive REACHED
 * rather than how it was written.
 *
 * Using STATEMENTS share their first word with directives and are excluded by
 * shape, not by guesswork: `using var s = …;`, `using (r) { … }` and
 * `using StreamReader r = …;` all fail the body grammars below, which accept
 * exactly a dotted name, `static` plus a dotted name, or ONE identifier, an
 * equals sign, and a right-hand side. Anything else is a statement and stays
 * unread — a resource variable's type would otherwise read as an import of
 * itself.
 *
 * Alias right-hand sides resolve by their generic-free base: `using Grid =
 * Corp.Domain.Grid<int>;` reaches `Corp.Domain.Grid`'s project through the
 * base name, because the constructed type lives where its definition lives.
 * A right-hand side that never reduces to a dotted name — a tuple alias,
 * `using Pair = (int, string);` — introduces no cross-project name at all and
 * classifies external with the written right-hand side standing in as
 * `packageName`.
 *
 * Known parse limits, deliberate and pinned by tests, each erring toward a
 * record naming text the file really contains or toward a documented silence,
 * never toward a wrong project:
 *
 * - A **multi-line directive** (`using A.B.\n    C;`) is not read: the body
 *   must sit on its own line, terminated by `;`. Every formatter writes one
 *   line; the miss is compensated by the manifest resolver's independent
 *   edges (`./dotnet/csproj.mjs`).
 * - **Attribute references, inline fully-qualified names and reflection**
 *   reach types without any directive; extraction cannot see them. Documented
 *   limits whose compensation is the manifest track and tag law.
 * - **Verbatim identifiers** (`@class`) inside a directive are not read — the
 *   same class of limit Kotlin's backtick segments pin.
 * - An **unterminated directive** (no `;` before end of line) is not a
 *   complete directive and is not read.
 * - A **statement whose initializer opens but never closes** (`using var x =
 *   new F {`, the `;` never arriving) is neither read nor flagged — the `{`
 *   behind the resource's `=` is the statement's own (#469), the same
 *   silence a `using (r) {` block has always held. The malformation scan
 *   judges directives only.
 */
import { csharpNamespaceIndex } from "./dotnet/namespaces.mjs";
import { maskCSharpComments } from "./dotnet/mask.mjs";
import { resolveCsharpSpecifier } from "./dotnet/resolve.mjs";
import {
  emptyResult,
  fileFailure,
  perWorkspace,
  positionAt,
  projectOwning,
  refuseUnreadTree,
} from "./source-util.mjs";

/**
 * One identifier segment. Verbatim identifiers (`@class`) are deliberately
 * outside this grammar — see the limits above.
 */
const SEG = String.raw`[\p{L}_][\p{L}\p{Nd}_]*`;
const DOTTED_NAME = `${SEG}(?:\\.${SEG})*`;

/**
 * The body of a using directive, captured up to its terminating semicolon.
 * The anchor accepts a fresh declaration's every legal predecessor — line
 * head (through a UTF-8 BOM), `;`, `{`, `}` — so `namespace N { using A.B; }`
 * on one line is read like any formatted tree. The semicolon is a lookahead,
 * never part of the match (#407): consumed, the scan resumed PAST it, and the
 * `;` before a second same-line directive — its only legal anchor — was
 * already behind it, so `using A.B; using C.D;` read only `A.B`.
 */
const CS_USING_BODY = new RegExp(
  String.raw`(?:^\uFEFF?|[\n;{}])[ \t]*(?:global[ \t]+)?using[ \t]+([^;\n]+?)[ \t]*(?=;)`,
  "gu",
);

/**
 * The directive openers without their bodies — the heads the malformation
 * scan (`csharpDirectiveMalformations`) anchors on. They live beside the
 * regexes they mirror rather than inside the scan, because the two must
 * agree about where a directive opens: a head that matched MORE than the
 * body regex would flag a file the body regexes read fully.
 */
const CS_USING_BODY_HEAD = new RegExp(
  String.raw`(?:^\uFEFF?|[\n;{}])[ \t]*(?:global[ \t]+)?using[ \t]+`,
  "gu",
);

/** The extern-alias opener, for the same scan. */
const CS_EXTERN_ALIAS_HEAD = new RegExp(
  String.raw`(?:^\uFEFF?|[\n;{}])[ \t]*extern[ \t]+alias[ \t]+`,
  "gu",
);
/** The extern-alias directive: `extern alias X;` — recorded, resolved as external. */
const CS_EXTERN_ALIAS = new RegExp(
  String.raw`(?:^\uFEFF?|[\n;{}])[ \t]*extern[ \t]+alias[ \t]+(${SEG})[ \t]*(?=;)`,
  "gu",
);

/** Exactly one identifier followed by `=`: the alias form. */
const ALIAS_FORM = new RegExp(String.raw`^(${SEG})[ \t]*=[ \t]*(.+)$`, "su");

/**
 * One bare identifier, optionally verbatim (`@class`): an alias's own name.
 * The malformation scan reads it backwards — the text before an initializer
 * `=` is an alias's name only when it is NOT this shape.
 */
const ALIAS_NAME = new RegExp(String.raw`^@?${SEG}$`, "u");

/** A dotted name, optionally behind the `global::` qualifier: the plain form. */
const PLAIN_FORM = new RegExp(String.raw`^(?:global::)?(${DOTTED_NAME})$`, "u");

/** `static` plus an optionally qualified dotted name: the static-members form. */
const STATIC_FORM = new RegExp(String.raw`^static[ \t]+(?:global::)?(${DOTTED_NAME})$`, "u");

/**
 * Strips one balanced trailing generic argument list from an alias's
 * right-hand side: `Corp.Domain.Grid<int>` becomes `Corp.Domain.Grid`.
 * Unbalanced brackets are left alone — the caller then classifies the raw
 * text external rather than guessing where the type began.
 *
 * @param {string} rhs
 * @returns {string}
 */
function withoutGenericArguments(rhs) {
  const open = rhs.indexOf("<");
  if (open === -1 || !rhs.endsWith(">")) return rhs;
  let depth = 0;
  for (let at = open; at < rhs.length; at++) {
    if (rhs[at] === "<") depth++;
    else if (rhs[at] === ">") {
      depth--;
      if (depth === 0) return at === rhs.length - 1 ? rhs.slice(0, open) : rhs;
    }
  }
  return rhs;
}

/**
 * Classifies one directive body into what resolution may see.
 *
 * The SPECIFIER is the directive's SUBJECT — the dotted name a plain/static
 * directive imports, or an alias's right-hand side — never the statement's
 * form words. That is not style: the `bannedExternalImports` family matches
 * its globs against the specifier and requires it to equal the resolved
 * package name (or a `/`-beneath path of it), so a specifier carrying
 * `static ` or `Alias = ` would silently exempt every static and aliased
 * crossing from every external ban — the exact direction this repository
 * exists to close. Form information lives in the directive's shape, which any
 * reader of the line sees anyway.
 *
 * @param {string} body The trimmed text between `using` and `;`.
 * @returns {{ specifier: string, importableName: string|null, specifierStartInBody: number }|null} `null`
 *   when the body is a using STATEMENT's shape, not a directive's.
 */
export function classifyUsingBody(body) {
  const trimmed = body.trim();
  if (trimmed === "") return null;
  const staticForm = STATIC_FORM.exec(trimmed);
  if (staticForm) {
    return {
      specifier: staticForm[1],
      importableName: staticForm[1],
      specifierStartInBody: trimmed.indexOf(staticForm[1]),
    };
  }
  const plainForm = PLAIN_FORM.exec(trimmed);
  if (plainForm) {
    return {
      specifier: plainForm[1],
      importableName: plainForm[1],
      specifierStartInBody: trimmed.indexOf(plainForm[1]),
    };
  }
  const aliasForm = ALIAS_FORM.exec(trimmed);
  if (aliasForm) {
    // The alias name is local syntax; only the right-hand side can cross a
    // boundary, so the right-hand side IS the specifier. A constructed
    // generic keeps its generic-free base as both specifier and importable,
    // because `imp` (the specifier the rule matches against globs) must
    // equal `packageName` for `isConstraintBanningProject` to fire. The
    // `global::` qualifier is stripped with the alias name for the same
    // reason — it is syntax around the subject, not part of it.
    const rhs = aliasForm[2].trim().replace(/^global::/, "");
    const base = withoutGenericArguments(rhs);
    const importableName = new RegExp(`^${DOTTED_NAME}$`, "u").test(base) ? base : null;
    const specifier = importableName ?? rhs;
    return { specifier, importableName, specifierStartInBody: trimmed.indexOf(specifier) };
  }
  // `var s = …`, `Type r = …`, `(expr)` — statement shapes stay unread.
  return null;
}

/**
 * Every directive in a `.cs` file, in source order and WITHOUT deduplication —
 * one entry per written directive, which is what an import-site record is.
 * Offsets index the ORIGINAL text and point at the specifier's own start, so
 * the reported column is where the written name begins.
 *
 * @param {string} csharpText Raw file contents.
 * @returns {{ specifier: string, importableName: string|null, offset: number }[]}
 */
export function parseCSharpDirectiveSites(csharpText) {
  const source = maskCSharpComments(csharpText);
  const sites = [];
  for (const match of source.matchAll(CS_USING_BODY)) {
    const classified = classifyUsingBody(match[1]);
    if (!classified) continue;
    sites.push({
      specifier: classified.specifier,
      importableName: classified.importableName,
      offset: match.index + match[0].indexOf(match[1]) + classified.specifierStartInBody,
    });
  }
  for (const match of source.matchAll(CS_EXTERN_ALIAS)) {
    sites.push({
      specifier: match[1],
      // Extern aliases supply a ROOT name from outside the compilation's
      // sources — resolution against the tracked tree cannot mean anything,
      // so the site records the alias's own name and classifies external
      // (documented limit). The name, not `extern alias X`, is the specifier:
      // form words would silently exempt the site from every external ban.
      importableName: null,
      offset: match.index + match[0].indexOf(match[1]),
    });
  }
  return sites.sort((a, b) => a.offset - b.offset);
}

/**
 * Why a `.cs` file's directives cannot be fully read, as reasons for
 * `analyzeCSharp` to record as whole-file failures (`contract.md`): a `using`
 * or `extern alias` directive that never reaches its `;`.
 *
 * The detection mirrors the directive regexes' own failure conditions, so a
 * file they read fully is never flagged. The openers are the body regexes'
 * own heads, and the `;` is required to arrive before the next `{`: the brace
 * a type body opens with separates a directive that terminated (`;` first)
 * from one the file truncates — a failed write, a merge marker left
 * mid-directive — which used to parse as zero directive sites with no
 * failure, byte-for-byte identical to a file that imports nothing (#419).
 * Statement shapes hold no opinion at all, by two markers the text shows
 * before any terminator arrives: a `(` right after the keyword is the
 * parenthesized family — `using (var s = f()) { … }`, `using (x);` — and an
 * `=` between the keyword and the walk's first `{` is the declaration family
 * (#469) whenever MORE than one bare identifier precedes it — `var writer`,
 * `Dictionary<string, int> map`, every declaration spelling — because a
 * brace behind a resource's own `=` is that statement's initializer, while
 * the first `{` behind a directive can only be the file's truncation. One
 * bare identifier before the `=` is an ALIAS's own name (`using Pair = …`),
 * the brace then belongs to whatever follows, and the truncated alias stays
 * loud. A statement's `;` may arrive inside its own
 * block, so the scan has no opinion there. One silence the rule keeps: a
 * missing `;` that a LATER declaration supplies its own (`extern alias X`
 * then `namespace Shop.App;`) is not seen — the walk reads the next
 * terminator, and attributing a `;` to its declaration is parser work the
 * head regexes do not carry. The same mask the Java scan's terminator walk
 * keeps.
 *
 * The mask runs first (the same `maskCSharpComments` the site parser runs),
 * so directive-shaped text inside strings, raw strings and comments is never
 * read as directive syntax and a compiling file is never reported as broken.
 *
 * The Go posture `goImportMalformations` set (#419's sibling audit): shapes
 * the regexes answer are the documented parse limits; the shape they cannot
 * answer is the failure.
 *
 * @param {string} csharpText Raw file contents.
 * @returns {string[]} At most one reason per kind — `using`, `extern alias` —
 *   each naming its line. Empty when the directives read fully.
 */
export function csharpDirectiveMalformations(csharpText) {
  const source = maskCSharpComments(csharpText);
  /** @type {string[]} */
  const reasons = [];
  const flagged = new Set();
  const flag = (offset, kind, reason) => {
    if (flagged.has(kind)) return;
    flagged.add(kind);
    reasons.push(`${reason} (line ${positionAt(csharpText, offset).line})`);
  };
  // `;` and `{` ascend with the text, and so do the openers, so each arm
  // walks the same terminator list with its own forward cursor — one pass per
  // arm, not an `indexOf` per opener that rescans the tail (`.cs` content is
  // attacker-supplied per SECURITY.md). Both arms hold ONE rule, the using
  // arm's: the directive's own `;` must arrive before the next `{`. An
  // `indexOf`-style "a `;` exists somewhere later" is what the alias arm
  // briefly held, and it is the weaker claim — a LATER declaration's `;`
  // (`extern alias X` then `namespace Shop.App;`) masked the truncation and
  // the silent direction survived it.
  const terminators = [...source.matchAll(/[;{]/g)];
  const terminatorAfter = () => {
    let cursor = 0;
    return (at) => {
      while (cursor < terminators.length && terminators[cursor].index < at) cursor += 1;
      return terminators[cursor];
    };
  };
  // The matched spans start at their ANCHORS (a `\n`, `;`, `{` or `}`), so
  // each reason locates the keyword inside the span rather than pointing at
  // m.index — the anchor names the PREVIOUS line when it is a `\n`, and a
  // diagnostic naming the wrong line sends every reader to the wrong
  // directive. The same locate-it move `parseCSharpDirectiveSites` makes for
  // the specifier.
  const usingTerminatorAfter = terminatorAfter();
  for (const m of source.matchAll(CS_USING_BODY_HEAD)) {
    const at = m.index + m[0].length;
    if (source[at] === "(") continue;
    const next = usingTerminatorAfter(at);
    if (next === undefined || next[0] === "{") {
      // The declaration family's initializer `=` (#469) — argued beside the
      // openers above: an `=` whose prefix is more than one bare identifier
      // is a resource's own, and the brace with it. One bare identifier is
      // an alias's own name, the brace belongs to whatever follows, and the
      // truncated alias stays loud.
      const eq = next !== undefined ? source.indexOf("=", at) : -1;
      const initializer =
        eq !== -1 && eq < next.index && !ALIAS_NAME.test(source.slice(at, eq).trim());
      if (next === undefined || !initializer) {
        flag(
          m.index + m[0].indexOf("using"),
          "using",
          "a `using` directive never reaches its `;` — the file is truncated or malformed, so its imports cannot be read",
        );
      }
    }
  }
  const externTerminatorAfter = terminatorAfter();
  for (const m of source.matchAll(CS_EXTERN_ALIAS_HEAD)) {
    const next = externTerminatorAfter(m.index + m[0].length);
    if (next === undefined || next[0] === "{") {
      flag(
        m.index + m[0].indexOf("extern"),
        "extern alias",
        "an `extern alias` never reaches its `;` — the file is truncated or malformed, so its imports cannot be read",
      );
    }
  }
  return reasons;
}

/**
 * The workspace's namespace index, built once per workspace object — the same
 * map the graph resolver below reads, both layers share one answer about
 * who owns a name.
 */
const csharpIndexOf = perWorkspace(csharpNamespaceIndex);

/**
 * Analyzes one `.cs` file.
 *
 * An ambiguous namespace (two tracked projects declaring the same deepest
 * matched prefix) resolves to `resolved: null` WITH a positioned failure
 * naming both projects — ordinary C#, unresolvable by static reading, where
 * picking either side would report violations against a guess. Intra-project
 * directives are emitted as records (`contract.md`), with
 * `spelling.relative` true exactly there.
 *
 * @param {{ sourceFile: string, text: string, workspace: object }} request
 * @returns {{ imports: object[], failures: object[] }}
 */
export function analyzeCSharp({ sourceFile, text, workspace }) {
  const result = emptyResult();
  try {
    const { byName: index } = csharpIndexOf(workspace);
    const owner = projectOwning(workspace.projects, sourceFile);
    // A file truncated inside a directive used to parse as importing nothing,
    // with no failure beside the empty result — the clean verdict over it was
    // the bug (#419). The whole-file shape is what turns the verdict loud:
    // `check` counts the file toward `unchecked` and refuses to call the run
    // complete, instead of reporting a hole as a clean file.
    for (const reason of csharpDirectiveMalformations(text)) {
      result.failures.push(fileFailure(sourceFile, reason));
    }
    for (const site of parseCSharpDirectiveSites(text)) {
      const { line, column } = positionAt(text, site.offset);
      let resolution;
      if (site.importableName === null) {
        resolution = {
          target: null,
          file: null,
          external: true,
          packageName: site.specifier,
        };
      } else {
        const resolved = resolveCsharpSpecifier(site.importableName, index);
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
          // The bare-coordinate class the contract discloses without
          // withholding (#603): the namespace names the external dependency
          // universe, not the governed graph, so the site is DISCLOSED — a
          // positioned row carrying `external: true`
          // (`isExternalSiteFailure`), the run's verdict untouched — rather
          // than swallowed, the same classification the TypeScript analyzer
          // already emits. A name a tracked namespace claims resolved through
          // the index above and never reaches this branch; the split-package
          // branch below keeps withholding. The `importableName === null`
          // arm above is the extern-alias construct, not an unresolvable
          // coordinate, and stays unfailed.
          result.failures.push({
            sourceFile,
            line,
            column,
            reason: `C# cannot resolve '${site.importableName}' from '${sourceFile}'`,
            external: true,
          });
        } else if (resolved.ambiguous) {
          resolution = null;
          result.failures.push({
            sourceFile,
            line,
            column,
            reason:
              `'${resolved.matchedPrefix}' is declared by more than one project ` +
              `(${resolved.ambiguous.join(", ")}) — the compiler picks by reference order, ` +
              `which this static reader does not model`,
          });
        } else {
          resolution = { target: resolved.target, file: null, external: false, packageName: null };
        }
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
    result.failures.push(fileFailure(sourceFile, `C# analysis failed: ${cause?.message ?? cause}`));
  }
  return result;
}

/**
 * Static edges between .NET projects derived from written directives — the
 * source-truth half of the two-track principle. `../dotnet/csproj.mjs`'s
 * ProjectReference resolver owns the manifest half; neither replaces the
 * other. Takes the SAME workspace-shaped object that resolver receives: the
 * namespace index both halves read is `perWorkspace`-cached on the object,
 * so a graph computation builds it once no matter which half runs first.
 *
 * Returns raw Nx dependencies ({ source, target, sourceFile, type: "static" }).
 * Ambiguous namespaces draw no edge — analysis reports them loudly instead,
 * and an edge against a guess would be worse than the missing one. An
 * unreadable `.cs` source refuses the whole graph (#364's posture — the
 * index state corrupts every importer of its namespaces, so the failure
 * cannot be attributed to the file's own edges), through the same
 * `refuseUnreadTree` the manifest resolvers hold.
 *
 * @param {{ projects: {name: string, root: string}[], filesOf: (name: string) => string[],
 *           readFile: (path: string) => string|null }} workspace
 * @returns {{ source: string, target: string, sourceFile: string, type: string }[]}
 * @throws {Error} when `csharpNamespaceIndex` recorded any failure, naming
 *   each unreadable `.cs` source.
 */
export function resolveCsharpDependencies(workspace) {
  const { byName: index, failures: indexFailures } = csharpNamespaceIndex(workspace);
  refuseUnreadTree("the C# namespace index", indexFailures);
  const dependencies = [];
  for (const project of workspace.projects) {
    for (const file of workspace.filesOf(project.name)) {
      if (!file.endsWith(".cs")) continue;
      const text = workspace.readFile(file);
      if (text === null) continue;
      for (const site of parseCSharpDirectiveSites(text)) {
        if (site.importableName === null) continue;
        const resolved = resolveCsharpSpecifier(site.importableName, index);
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
