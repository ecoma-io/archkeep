/**
 * Vue SFC analyzer — the official SFC parser finds the `<script>` blocks, the
 * TypeScript analyzer next door reads the imports inside them.
 *
 * ## Positions are mapped by blanking, not by arithmetic
 *
 * A diagnostic that names the wrong line is worse than no diagnostic: it sends
 * a reader to code that is not the problem, and it does it silently. The
 * obvious implementation — analyze `block.content`, then add the block's start
 * line to every result — has an off-by-one at the first line of the block
 * (whose column is offset too, not just its line), and it needs a second,
 * different correction for a second `<script>` block.
 *
 * So no arithmetic happens at all. Each block is analyzed in a copy of the
 * WHOLE file with every character outside that block replaced by a space,
 * newlines kept. The text handed to TypeScript therefore has the block's code
 * at exactly the offsets, lines, and columns it occupies in the `.vue` file,
 * and every position TypeScript reports is already a `.vue` position. There is
 * nothing left to get wrong, and `@vue/compiler-sfc` guarantees the one fact
 * it relies on: `text.slice(block.loc.start.offset, block.loc.end.offset)` is
 * exactly `block.content`.
 *
 * The cost is one string copy per script block, which is bounded by the file.
 *
 * ## Why the parser is loaded lazily
 *
 * `vue/compiler-sfc` is a public entry point of `vue`, a workspace dependency,
 * and the SFC format is Vue's own — a hand-rolled `<script>` extractor would
 * be a second answer to a question its author already answers, and would be
 * wrong first on the cases that motivate a real parser (a `</script>` inside a
 * string, `<script>` and `<script setup>` together, a custom block).
 *
 * It is still loaded on first use rather than at import time, through
 * `createRequire`, for two reasons. This tool runs over trees that have no Vue
 * at all — a pure Go or Rust workspace does not depend on it — and a
 * top-level import would make a missing `vue` break Go, Rust, and Python
 * analysis in a workspace that has no `.vue` file to analyze. And the contract
 * says an analyzer never throws: a missing parser becomes a failure record
 * naming what is absent, like any other thing this layer could not do.

 * ## Which Vue answers — the analyzed workspace's, not archkeep's
 *
 * The parser is resolved per workspace, not once for the process: the
 * analyzed workspace's own `vue/compiler-sfc` wins, because the Vue a `.vue`
 * file is compiled and type-checked against is the Vue that workspace
 * depends on — asking archkeep's tree for the parser would silently use a
 * different copy, or refuse in a workspace that does have Vue. `createRequire`
 * is anchored at the workspace's own `package.json` (the
 * `resolveEslintPluginDefaults` shape in `eslint-config.mjs`), and accepts a
 * base path that need not exist, so the workspace hop is one require with no
 * existence check. archkeep's own install is the fallback only for a
 * workspace that does not install Vue at all — a real require miss is told
 * apart from a broken copy by its `MODULE_NOT_FOUND` /
 * `ERR_MODULE_NOT_FOUND` code. A workspace whose own copy exists but fails
 * to load (permission, ESM-only entry, corrupt install) is refused loudly,
 * naming that copy's error: substituting archkeep's Vue there would silently
 * analyze against a different version, the very silence this resolution
 * exists to prevent. When neither has it, the refusal below names what is
 * absent. Resolution is remembered per workspace — a `WeakMap` keyed on
 * the workspace object, the `perWorkspace` pattern in `source-util.mjs` —
 * so a whole-tree run pays the two requires once, not once per `.vue` file.
 */
import { createRequire } from "node:module";
import { join } from "node:path";

import { emptyResult, fileFailure, perWorkspace } from "./source-util.mjs";
import { analyzeTypeScript } from "./typescript.mjs";

/** The SFC parser's specifier, named once — the failure message quotes it. */
const COMPILER_SFC = "vue/compiler-sfc";

/**
 * The archkeep-side requirer, created once. Building one loads nothing; it is
 * the fallback for a workspace that does not install Vue itself.
 */
const localRequire = createRequire(import.meta.url);

/**
 * Resolves `vue/compiler-sfc` for one workspace: the analyzed workspace's own
 * install first, archkeep's second, and `{ parse: null, error }` naming the
 * cause when neither has it — or when the workspace's own copy exists but
 * fails to load, a broken install never silently replaced by archkeep's Vue.
 *
 * `seam` is the tests' door: `createRequireForWorkspace` replaces the
 * workspace hop's requirer constructor, `localRequire` replaces the archkeep
 * hop's requirer, so each branch can be driven from in-memory fakes without
 * touching a real filesystem. Production passes no seam; `createRequire` and
 * the once-made requirer above stay the defaults.
 *
 * @param {string} workspaceRoot absolute workspace root, from `workspace.root`
 * @param {object} [seam]
 * @param {(base: string) => (specifier: string) => object} [seam.createRequireForWorkspace]
 * @param {(specifier: string) => object} [seam.localRequire]
 * @returns {{ parse: (text: string, options: object) => object, error: null } |
 *           { parse: null, error: string }}
 */
export function resolveSfcParser(workspaceRoot, seam = {}) {
  const {
    createRequireForWorkspace = createRequire,
    localRequire: archkeepRequire = localRequire,
  } = seam;
  try {
    const fromWorkspace = createRequireForWorkspace(join(workspaceRoot, "package.json"));
    return { parse: fromWorkspace(COMPILER_SFC).parse, error: null };
  } catch (workspaceCause) {
    // The fallback exists for a workspace that does not install Vue at all;
    // a real require miss is told apart by its code. Anything else — a
    // permission error, an ESM-only entry, a corrupt install — is the
    // workspace's OWN copy breaking, and swapping in archkeep's Vue would
    // silently analyze the file against a different version than the
    // workspace compiles with. Name the copy's failure instead.
    if (
      workspaceCause?.code === "MODULE_NOT_FOUND" ||
      workspaceCause?.code === "ERR_MODULE_NOT_FOUND"
    ) {
      return archkeepFallback(archkeepRequire);
    }
    return {
      parse: null,
      error: `the workspace's '${COMPILER_SFC}' copy failed to load, so no .vue file can be analyzed: ${workspaceCause?.message ?? String(workspaceCause)}`,
    };
  }
}

/**
 * The archkeep-side hop, so named because the requirer it uses is a parameter
 * (`localRequire`): tests fail this hop in isolation, and production hands it
 * the module-level requirer. Its failure is the loud refusal — a missing
 * parser is a named failure, never a silent pass.
 */
function archkeepFallback(localRequire) {
  try {
    return { parse: localRequire(COMPILER_SFC).parse, error: null };
  } catch (fallbackCause) {
    return {
      parse: null,
      error: `'${COMPILER_SFC}' is not installed, so no .vue file can be analyzed: ${fallbackCause?.message ?? String(fallbackCause)}`,
    };
  }
}

/** Resolved once per workspace object, success or failure, and remembered either way. */
const sfcParserFor = perWorkspace((workspace) => resolveSfcParser(workspace.root));

function sfcParse(workspace, seam) {
  const { parse, error } = seam ? resolveSfcParser(workspace.root, seam) : sfcParserFor(workspace);
  if (parse === null) {
    throw new Error(error);
  }
  return parse;
}

/** `text` with everything outside `[start, end)` replaced by spaces. */
function isolate(text, start, end) {
  const blank = (part) => part.replace(/[^\n]/g, " ");
  return blank(text.slice(0, start)) + text.slice(start, end) + blank(text.slice(end));
}

/**
 * A compiler-sfc error as a failure record. Its `loc` is already 1-based in
 * the `.vue` file's own coordinates; a plain `SyntaxError` carries none, and
 * becomes a file-level failure.
 */
function sfcFailure(sourceFile, error) {
  const start = error?.loc?.start;
  return {
    sourceFile,
    line: start?.line ?? null,
    column: start?.column ?? null,
    reason: `Vue SFC parse error: ${error?.message ?? error}`,
  };
}

/**
 * Analyzes one `.vue` file.
 *
 * Both script blocks are analyzed when both exist — `<script>` and
 * `<script setup>` legitimately coexist, and an import in either is an import
 * of the component. A file with no script block yields the empty envelope and
 * `<script>`/`<script setup>` tag the SFC parser could not recover to EOF is
 * different — its content is unknown, not empty — and yields a whole-file
 *
 * @param {{ sourceFile: string, text: string, workspace: object }} request
 * @param {object} [seam] Resolution seam for tests — see `resolveSfcParser`;
 * production callers pass none.
 * @returns {{ imports: object[], failures: object[] }}
 */
export function analyzeVue({ sourceFile, text, workspace }, seam) {
  const result = emptyResult();
  try {
    const parse = sfcParse(workspace, seam);
    const { descriptor, errors } = parse(text, { filename: sourceFile });
    for (const error of errors) result.failures.push(sfcFailure(sourceFile, error));

    for (const block of [descriptor.script, descriptor.scriptSetup]) {
      if (!block) continue;
      // `ignoreEmpty` (compiler-sfc's own default) already drops a genuinely
      // empty, well-formed `<script>`/`<script setup>` to `null` before this
      // loop ever sees it — verified against the installed compiler-sfc's own
      // source. The only way a truthy block reaches here with a zero-width
      // span (`loc.start.offset === loc.end.offset`) and no `src` is the SFC
      // parser failing to find the block's end tag before EOF: it still
      // returns a block object, but one carrying none of the file's bytes,
      // which `isolate` below would otherwise blank to nothing and read as
      // "no imports" — indistinguishable from a legitimate template-only
      // component. `!block.src` is required because `<script src="./x.ts" />`
      // legitimately has an empty inline body and the SAME zero-width span —
      // its content lives in a file this analyzer does not read, an
      // already-accepted limit, not this failure.
      if (block.loc.start.offset === block.loc.end.offset && !block.src) {
        result.failures.push(
          fileFailure(
            sourceFile,
            `Vue SFC parse error: a <script${block === descriptor.scriptSetup ? " setup" : ""}> ` +
              `block could not be recovered (its end tag was not found), so any imports inside ` +
              `it are unknown`,
          ),
        );
        continue;
      }
      const isolated = isolate(text, block.loc.start.offset, block.loc.end.offset);
      const analyzed = analyzeTypeScript({
        sourceFile,
        text: isolated,
        workspace,
        // No `lang` means plain JavaScript, which is Vue's own default.
        lang: block.lang ?? "js",
      });
      result.imports.push(...analyzed.imports);
      result.failures.push(...analyzed.failures);
    }
  } catch (cause) {
    result.failures.push(
      fileFailure(sourceFile, `Vue analysis failed: ${cause?.message ?? cause}`),
    );
  }
  // Two blocks are analyzed in sequence, so their records arrive block by
  // block; `contract.md` promises source order over the file.
  result.imports.sort((a, b) => a.line - b.line || a.column - b.column);
  return result;
}
