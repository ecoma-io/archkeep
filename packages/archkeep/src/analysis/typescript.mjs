/**
 * TypeScript/JavaScript analyzer — TypeScript's own parser and TypeScript's
 * own resolver, wired to the injected workspace. Nothing here reimplements
 * either.
 *
 * `ts.resolveModuleName` is a public API and already answers this question
 * correctly for an Nx workspace: `tsconfig.base.json` `paths`, secondary
 * entries, `exports` conditions, extension probing, and the
 * `isExternalLibraryImport` flag all come out of one call. Reimplementing any
 * of it would be a second answer to a question TypeScript already answers, and
 * the two would disagree exactly where a boundary rule needs them not to
 * (`contract.md`, "Resolution is delegated, never reimplemented").
 *
 * Known limits, deliberate and pinned by tests:
 *
 * - **`fileExists` is `readFile() !== null`.** `Workspace` exposes exactly one
 *   filesystem verb, and inventing a second would break the injected shape a
 *   test drives from memory, so an existence probe reads the file. Every read
 *   is memoised per workspace, which matters because TypeScript probes many
 *   candidate paths per specifier and hits the same ones over and over.
 * - **No `realpath`.** A package linked into `node_modules` — pnpm's workspace
 *   protocol — resolves to its link path, so it reports `external` instead of
 *   naming the project behind the link. This workspace wires its libs through
 *   `tsconfig.base.json` `paths` rather than workspace links, so the case does
 *   not arise here; a consumer workspace that used links would see the missing
 *   edge as an unattributed external, never as a wrong project.
 * - **`require(x)` and `require.resolve(x)` are read as imports** even when
 *   `require` is a local function of that name. Worst case is a spurious
 *   record naming a specifier the file really does contain — never a missed
 *   one. Those two callee forms are exactly the ones upstream's
 *   `getImportFromRequireCall` admits, and `isRequireCallee` below matches its
 *   shape node kind for node kind rather than widening it.
 * - **`import("typescript")` in a type position (`ImportTypeNode`) is read as a
 *   `type-only` import.** The form `type X = import("typescript").Foo` and
 *   `const x: typeof import("typescript") = ...` both introduce a dependency on
 *   `typescript` that is erased at runtime, so they carry `kind: "type-only"` —
 *   the same classification `import type { X } from "typescript"` receives. The
 *   argument is the `LiteralType` child of the `ImportTypeNode`; a
 *   non-string-literal argument (a type reference, a template type) is
 *   recorded as unresolvable rather than dropped, following the same loud/skip
 *   discipline dynamic `import()` already applies. `typeof import("typescript")`
 *   wraps the same `ImportTypeNode` inside a `TypeQueryNode`; the walk visits
 *   the `ImportTypeNode` once and produces exactly one site, not a duplicate.
 *
 * - **A LITERAL specifier that names a DECLARED project and fails to resolve
 *   is a whole-file failure.** `import { x } from "@acme/ui"` where the native
 *   workspace declares a project named `@acme/ui` asks the resolver a concrete
 *   question about a workspace-internal dependency and the resolver answers
 *   "no such module" — the edge that import would have carried (or the
 *   violation it would have avoided) is simply missing, so the file could not
 *   be fully judged. That is the same "could not look" shape an unreadable
 *   file produces (`fileFailure`, `line: null`), and it rides `check`'s
 *   `unchecked` count to exit 3 (`cli.mjs`) rather than a silent pass.
 * - **A literal package import that names NO declared project** (`vitest`,
 *   `@nx/eslint-plugin`, an uninstalled third-party package) is NOT a hole: a
 *   workspace with packages is a normal state, and failing the whole run on
 *   every unresolved package import would block merges over dependencies
 *   nobody crossed. Those stay positioned site failures — the "blind spot"
 *   the contract documents as legitimately permanent.
 * - **A NON-LITERAL argument** — `import(url)` with a computed argument, a
 *   brace-group `use` the Rust analyzer records the same way — is genuinely
 *   not statically knowable and stays a positioned site failure, because the
 *   rest of the file's imports WERE judged. The two classes are deliberately
 *   different directions of the same "did not resolve" fact (`contract.md`).
 *
 * ## One `kind` per import site, and how a mixed statement is judged
 *
 * The record carries one `kind` (`contract.md`), so a statement that is two
 * things at once has to be judged. Two rulings, both because `type-only` is a
 * statement about **runtime erasure** and rules turn constraints off on it:
 *
 * - `import { type A, B } from "x"` is `static`, not `type-only`. `B` survives
 *   to runtime, so the dependency is real. Only a statement where nothing
 *   survives — `import type`, or a named list whose every element carries
 *   `type` — is erased, and only then is it `type-only`.
 * - `export type { A } from "x"` is `type-only`, not `re-export`. It is both,
 *   and erasure is the property that decides which constraints apply at all; a
 *   barrel of types creates no runtime edge. Calling it `re-export` would
 *   apply runtime constraints to a statement that leaves no runtime behind.
 */
import { isBuiltin } from "node:module";

import ts from "typescript";

import { DEFAULT_OPTIONS } from "../options.mjs";
import { stripTrailingSlashes } from "../path-util.mjs";
import { normalizePath } from "./manifest-util.mjs";
import { emptyResult, fileFailure, perWorkspace, projectOwning } from "./source-util.mjs";

/** The directory a workspace-relative path sits in; `""` at the root. */
const directoryOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/**
 * The Nx workspace's shared compiler options live in a file whose name is an Nx
 * CONVENTION, not a contract — `tsconfig.base.json` in nearly every workspace,
 * and whatever the plugin's `tsConfig` option names in the rest. So the name
 * arrives on the `workspace` rather than as a constant here (`../options.mjs`
 * says why the two conventions are options and the language manifests are not):
 * a workspace that renamed it would otherwise silently resolve no path alias at
 * all, and every aliased import would read as external.
 *
 * It travels on the workspace and not as a fourth analyzer argument for a
 * reason `perWorkspace` makes concrete: that cache is a `WeakMap` keyed on the
 * workspace object's identity, so a filename passed alongside it could differ
 * between two calls sharing one key and the second call would silently get the
 * first one's parsed context. Carried ON the key, the two cannot come apart.
 * The default below is the same one `../options.mjs` states, imported from
 * there rather than respelled, and exists for the callers that build a
 * workspace by hand — the resolvers next door and the analyzer tests — rather
 * than as a second declaration of the convention.
 */
const tsConfigOf = (workspace) => workspace.tsConfig ?? DEFAULT_OPTIONS.tsConfig;

/**
 * TypeScript's "No inputs were found in config file" diagnostic.
 *
 * The one hardcoded literal in this module, and the justification is the
 * rubric's: it is a fixed external contract (a TypeScript diagnostic code),
 * there is no source to derive it from, and it appears exactly once. It is
 * ignored because this module deliberately does not expand `include`/`files`
 * globs — it wants `compilerOptions` and nothing else, so the config host's
 * `readDirectory` returns nothing and TypeScript correctly observes that the
 * config matched no inputs. Every OTHER config diagnostic is reported.
 */
const NO_INPUTS_FOUND = 18003;

/**
 * The TypeScript API this module delegates to, and the reason the manifest's
 * peer range has an upper bound rather than the open `>=5` it carried first.
 *
 * TypeScript 7 is the native port, and its entry point exports `version` and
 * `versionMajorMinor` and nothing else — `createSourceFile`, `resolveModuleName`
 * and `sys` all moved behind `typescript/unstable/*` subpaths with a different
 * shape. `>=5` was therefore a promise this package could not keep, and npm's
 * `latest` tag now points at 7, so a consumer running `pnpm add typescript`
 * today gets the version that breaks it. `<7` is measured: every name below
 * resolves on 6.0.3 and none of them on 7.0.2.
 *
 * The check runs at module load because the alternative is what it replaces —
 * a `TypeError: Cannot read properties of undefined (reading 'TS')` pointing at
 * a frozen object literal, which names a property rather than a cause and sends
 * the reader into this file instead of into their own manifest. A peer range is
 * only advisory (npm warns, pnpm warns, neither refuses), so the range alone
 * would let an unusable install reach exactly this crash.
 */
const REQUIRED_TS_API = Object.freeze([
  "createSourceFile",
  "resolveModuleName",
  "createModuleResolutionCache",
  "parseJsonConfigFileContent",
  "forEachChild",
  "Extension",
  "ScriptKind",
  "ScriptTarget",
  "SyntaxKind",
]);

const missingTsApi = REQUIRED_TS_API.filter((name) => ts[name] === undefined);
if (missingTsApi.length > 0) {
  throw new Error(
    `archkeep needs the TypeScript compiler API, and the installed ` +
      `typescript@${ts.version ?? "unknown"} does not expose ${missingTsApi.join(", ")}. ` +
      `TypeScript 7 is the native port and moved that API behind typescript/unstable/*, ` +
      `so this package declares typescript ">=5 <7". Install a 5.x or 6.x in the workspace ` +
      `this plugin runs in.`,
  );
}

/**
 * Every extension TypeScript's own module resolver may load a module from,
 * read off `ts.Extension` rather than kept by hand here. `.tsbuildinfo` is
 * dropped because it is an output artefact and never a resolution target.
 *
 * The list is a fact about the installed compiler, so deriving it is what keeps
 * `declinedSiblingOf` below honest across TypeScript versions — a hand-kept
 * copy would be wrong the release a new extension lands, and wrong silently.
 *
 * MAY, not will: membership here is necessary and not sufficient, because one
 * member is switched by a compiler option — see `ordinaryPassLoadsJson`.
 */
const TS_RESOLVABLE_EXTENSIONS = Object.freeze(
  Object.values(ts.Extension).filter((extension) => extension !== ts.Extension.TsBuildInfo),
);

/**
 * Whether the ORDINARY resolution pass would itself load a `.json` target under
 * these compiler options — asked of TypeScript rather than modelled here.
 *
 * `.json` is the one member of `TS_RESOLVABLE_EXTENSIONS` that an option turns
 * off, and it is also the only member a probe remainder can carry in practice:
 * for an extension it does not recognise TypeScript APPENDS (`data.json` is
 * probed as `data.json.ts`), while for one it does it SUBSTITUTES (`legacy.js`
 * is probed as `legacy.ts`), and a substitution leaves a remainder with no
 * extension at all. So this predicate decides the whole of the guard below.
 *
 * Measured on typescript 5.9.3, where the `.json` is supplied by the SPECIFIER
 * — a wildcard alias `@ui/*` → `pkg/src/*` reached by `@ui/data.json`, or a
 * bare `baseUrl` mapping — with `module` written beside `moduleResolution` the
 * way a real `tsconfig` writes them:
 *
 * | `resolveJsonModule` | Classic | Node10 | Node16 | NodeNext | Bundler |
 * | ------------------- | ------- | ------ | ------ | -------- | ------- |
 * | `true`              | loads   | loads  | loads  | loads    | loads   |
 * | `false`             | null    | null   | null   | null     | null    |
 * | unset               | null    | null   | null   | loads    | loads   |
 *
 * The prose this replaces claimed the ordinary pass loads `.json` "even with
 * `resolveJsonModule` off", which is true in NONE of those five cells. In every
 * "null" cell a project's `.json` source reached by an alias resolved to
 * nothing, and the guard built on that claim then refused the
 * declined-extension pass its answer too — a boundary crossing invisible from
 * both passes, in exactly the workspaces that pass exists to serve.
 *
 * The SHAPE matters, and is why the probe below is a relative specifier. A
 * `paths` TARGET that itself names the `.json` — `{"@ui/data":
 * ["pkg/src/data.json"]}`, or a `*.json` target template — loads in all fifteen
 * cells, because TypeScript takes a mapped target carrying an extension as the
 * file to load. That case never reaches the widened pass at all, the ordinary
 * one having already resolved it, so this returning `false` there costs
 * nothing. The relationship that must hold does hold, in every one of the sixty
 * combinations measured: wherever this returns `true` the ordinary pass really
 * does load, so the guard can never refuse the widened pass a question the
 * ordinary pass had abandoned.
 *
 * The answer is measured rather than derived because every derivation tried was
 * wrong. `resolveJsonModule ?? moduleResolution === Bundler` reads like the
 * table and contradicts the compiler in three measured places: `module:
 * "preserve"` and `module: "nodenext"` with `moduleResolution` UNSET both load
 * while naming no Bundler, and the unset row above moves under NodeNext
 * depending on whether `module` was written beside `moduleResolution` — one
 * `moduleResolution`, two answers. A `ts.resolveModuleName` against a two-entry
 * host cannot drift from the resolver the rest of this module drives, and costs
 * one call per workspace: `contextFor` is memoised per workspace and asks once.
 *
 * @param {import("typescript").CompilerOptions} options
 * @returns {boolean}
 */
function ordinaryPassLoadsJson(options) {
  // A directory the workspace host never sees, so the probe cannot be answered
  // by a real file and cannot answer for one: this asks about the OPTIONS.
  const directory = "/__archkeep_json_probe__";
  const probe = `${directory}/probe.json`;
  const host = {
    fileExists: (path) => path === probe,
    readFile: (path) => (path === probe ? "{}" : undefined),
  };
  const resolution = ts.resolveModuleName("./probe.json", `${directory}/index.ts`, options, host);
  return resolution.resolvedModule?.resolvedFileName === probe;
}

/**
 * Whether `path` ends in an extension the ordinary pass would load it from.
 *
 * `jsonIsResolvable` is `ordinaryPassLoadsJson`'s answer for the workspace's
 * own compiler options; every other member of the list is unconditional.
 */
const ordinaryPassLoads = (path, jsonIsResolvable) =>
  TS_RESOLVABLE_EXTENSIONS.some(
    (extension) =>
      (jsonIsResolvable || extension !== ts.Extension.Json) && path.endsWith(extension),
  );

/** Whether `path`'s own basename names an extension at all. */
const namesAnExtension = (path) => path.slice(path.lastIndexOf("/") + 1).includes(".");

/** Which TypeScript dialect a file extension is written in. */
const SCRIPT_KIND_BY_EXTENSION = Object.freeze({
  ".ts": ts.ScriptKind.TS,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
});

/**
 * Which dialect a `lang` attribute names. The Vue analyzer hands a `<script>`
 * block's `lang` here because a `.vue` file's extension cannot say which of
 * the four its script is written in.
 */
const SCRIPT_KIND_BY_LANG = Object.freeze({
  ts: ts.ScriptKind.TS,
  tsx: ts.ScriptKind.TSX,
  js: ts.ScriptKind.JS,
  jsx: ts.ScriptKind.JSX,
});

/**
 * How a JavaScript-family specifier is SPELLED — the per-language half of the
 * analysis record (`contract.md`, "How the specifier is spelled").
 *
 * This is the family where the two bits coincide, which is exactly why the rule
 * engine used to derive them itself and got Rust and Python wrong: here a
 * relative reference IS a filesystem path, so one predicate answered both
 * questions and looked general. It is not — a Rust `super::x` and a Python
 * `..pkg` are relative and are not paths.
 *
 * `relative` is upstream's `isRelativePath` (nx `fileutils`), which accepts a
 * bare `.` and `..` where its two-character neighbour `isRelative`
 * (`../rules/specifiers.mjs`, still used for upstream's path arithmetic) does
 * not. The two must keep disagreeing about those two inputs, so they are stated
 * once each rather than derived from one another.
 *
 * A non-literal `import()` argument arrives here as its own source text
 * (`` `./${dir}/x` ``), which starts with a backtick or a quote and so is
 * neither — the honest answer for a specifier nobody can read.
 *
 * `namesOnly` is per-LANGUAGE, so constant on every record this family
 * produces: `false`, because this family can spell a filesystem path at all.
 * That is the bit `isAbsoluteImportIntoAnotherProject` is gated on — a bare
 * `libs/x` here is a deep import and a `/libs/x` an absolute path, while the
 * same text in a language whose only spelling is the name is just a name
 * whose first segments are those words (#376).
 *
 * @param {string} specifier The raw string as written.
 * @returns {{ path: boolean, relative: boolean, namesOnly: boolean }}
 */
export function specifierSpelling(specifier) {
  const relative =
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../");
  return { path: relative || specifier.startsWith("/"), relative, namesOnly: false };
}

/**
 * The package a bare specifier names, or `null` when the specifier is a path
 * rather than a package.
 *
 * A scoped package keeps both segments (`@tauri-apps/api` for
 * `@tauri-apps/api/window`) and never the deep path, because that is what a
 * `bannedExternalImports` glob is written against (`contract.md`). The deep
 * path stays in the record's `specifier`, so a rule can match either without
 * re-parsing.
 *
 * @param {string} specifier
 * @returns {string|null}
 */
export function packageNameOf(specifier) {
  if (specifier === "" || specifier.startsWith(".") || specifier.startsWith("/")) return null;
  const segments = specifier.split("/");
  if (specifier.startsWith("@"))
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : null;
  return segments[0];
}

/**
 * Whether an unresolvable literal specifier names a project this workspace
 * DECLARES — the discriminator between a missing workspace edge and a
 * legitimate (perhaps uninstalled) package dependency.
 *
 * Both the full specifier and its package name (`packageNameOf`) are matched
 * against the declared project names. A project is imported by its own name in
 * a native `archkeep.json` workspace; a scoped specifier `@billing/api` names a
 * project whose declared name IS `@billing/api` (names are non-empty strings,
 * and the model performs no normalisation — `providers/native/model.mjs`
 * accepts the scope verbatim), and a deep path into such a project
 * (`@billing/api/models`) still matches its package name. A specifier that
 * reduces to no package name — a relative path, an empty string — is a path
 * spelling judged by the path rules, never a workspace-internal package
 * dependency, so it stays a blind spot.
 *
 * @param {string} specifier The raw specifier as written.
 * @param {{projects: {name: string}[]}} workspace
 * @returns {boolean}
 */
function namesDeclaredProject(specifier, workspace) {
  const name = packageNameOf(specifier);
  if (name === null) return false;
  return workspace.projects.some((project) => project.name === name || project.name === specifier);
}

/** The dialect to parse `sourceFile` as; `lang` wins when the caller knows it. */
function scriptKindFor(sourceFile, lang) {
  if (lang) return SCRIPT_KIND_BY_LANG[lang] ?? ts.ScriptKind.TS;
  const dot = sourceFile.lastIndexOf(".");
  return SCRIPT_KIND_BY_EXTENSION[sourceFile.slice(dot)] ?? ts.ScriptKind.TS;
}

/**
 * A `ts.ModuleResolutionHost` over the injected workspace, plus the memo that
 * makes it affordable. Every path TypeScript hands back is absolute, so the
 * translation to the workspace-relative reader happens here and once.
 */
function resolutionHostFor(workspace) {
  const root = stripTrailingSlashes(workspace.root);
  const prefix = `${root}/`;
  const contents = new Map();
  const read = (absolute) => {
    if (contents.has(absolute)) return contents.get(absolute);
    const text = absolute.startsWith(prefix)
      ? workspace.readFile(absolute.slice(prefix.length))
      : null;
    contents.set(absolute, text ?? null);
    return text ?? null;
  };
  return {
    root,
    fileExists: (path) => read(path) !== null,
    readFile: (path) => read(path) ?? undefined,
  };
}

/**
 * The real file a probe path is the TypeScript sibling of, or `null`.
 *
 * TypeScript resolves a module by forming candidate paths and asking the host
 * whether each exists — for the candidate `…/PageHeader.vue` it probes
 * `…/PageHeader.vue.ts`, `…/PageHeader.vue.tsx`, `…/PageHeader.vue.d.ts` and so
 * on (measured on typescript 5.9.3, in every `moduleResolution` mode). This
 * reverses one of those probes: strip a TypeScript extension off the end and
 * see whether what remains is a file the workspace really has.
 *
 * Two guards keep it to the case it exists for, and both are scope statements
 * rather than repairs of an observed failure — they are what says in code, not
 * in prose, that this pass answers exactly one question. The remainder must
 * itself name an extension (`namesAnExtension`), so an `index` or
 * extension-substitution probe for a specifier that named no file at all can
 * never be answered here: `./widgets` reaching `./widgets/index.vue`, and
 * `../Button` reaching `../Button.vue`, both stay refused, which is the
 * narrowness the relative branch in `resolveSpecifier` states outright. And
 * the remainder must not be one the ordinary pass would itself have loaded
 * (`ordinaryPassLoads`) — a remainder that pass can load is one it already had
 * its chance at, so answering for it would let a widened `fileExists` decide a
 * question that pass owns. Measured on typescript 5.9.3: a `.js` alias target
 * resolves in the ordinary pass with `allowJs` on AND off, a `.d.ts` one always
 * does, and a `.json` one does only under the options `ordinaryPassLoadsJson`
 * measures — which is why that half of the guard is an argument rather than a
 * constant.
 *
 * The extensions are tested in `ts.Extension` order and the first one whose
 * remainder EXISTS wins, not the first one that merely matches: `…/x.vue.d.ts`
 * ends in both `.ts` and `.d.ts`, and stopping at `.ts` would test `…/x.vue.d`
 * and answer no.
 *
 * @param {string} probe An absolute path TypeScript asked about.
 * @param {(path: string) => boolean} exists
 * @param {boolean} jsonIsResolvable `ordinaryPassLoadsJson` for these options.
 * @returns {string|null}
 */
function declinedSiblingOf(probe, exists, jsonIsResolvable) {
  for (const extension of TS_RESOLVABLE_EXTENSIONS) {
    if (!probe.endsWith(extension)) continue;
    const candidate = probe.slice(0, -extension.length);
    if (!namesAnExtension(candidate) || ordinaryPassLoads(candidate, jsonIsResolvable)) continue;
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * The same `ts.ModuleResolutionHost`, plus one answer: a file whose extension
 * TypeScript declines is reported to exist under the name TypeScript is looking
 * for it by.
 *
 * This is what lets a `paths` alias pointing at `packages/blocks/page-header/src/PageHeader.vue`
 * be resolved by `ts.resolveModuleName` itself instead of by a table read here
 * — the fix for a `.vue` (or `.css`, or `.svg`) alias target resolving to
 * NOTHING, which skipped every `depConstraints` row for the edge. The mechanism
 * is traced at `resolveSpecifier`'s declined-extension branch, which is where
 * the record that carries it is built; the one-line version is that no target
 * was named at all, not that a wrong one was.
 *
 * **It is not the second resolver `AGENTS.md` forbids, and the distinction is
 * mechanical rather than a matter of degree.** Nothing here matches a `paths`
 * pattern, substitutes a `*`, applies `baseUrl`, or walks `node_modules`;
 * `ts.resolveModuleName` still does all of it, from the same parsed
 * `compilerOptions`. The only thing added is an answer to a `fileExists`
 * question TypeScript was already asking, and the answer is read off the
 * workspace rather than computed. A specifier TypeScript would decline for any
 * other reason — no matching alias, a target that is not there — is declined
 * here too, which is what the resolver's own negative answers below are pinned
 * on.
 *
 * The widened host gets its own resolution cache in `contextFor`, never the
 * ordinary one: a cache shared between the two would let a directory-level
 * entry recorded under the widened answers decide an ordinary resolution.
 *
 * @param {{ root: string, fileExists: (path: string) => boolean, readFile: (path: string) => string|undefined }} host
 * @param {boolean} jsonIsResolvable `ordinaryPassLoadsJson` for these options.
 */
function declinedExtensionHostFor(host, jsonIsResolvable) {
  return {
    root: host.root,
    fileExists: (path) =>
      host.fileExists(path) || declinedSiblingOf(path, host.fileExists, jsonIsResolvable) !== null,
    readFile: host.readFile,
  };
}

/**
 * Everything TypeScript needs that is per-workspace rather than per-file:
 * parsed compiler options, the resolution host, and TypeScript's own
 * directory-level resolution cache.
 *
 * A **missing** `tsconfig.base.json` is not a failure — a workspace need not
 * have one, and without `paths` an alias simply fails to resolve, which is
 * already reported at the import site that used it. A **malformed** one is a
 * failure, and a loud one: it silently drops every path alias, which would
 * turn a whole workspace's aliased imports into "unresolvable" with no
 * indication that the cause was one broken file.
 */
const contextFor = perWorkspace((workspace) => {
  const host = resolutionHostFor(workspace);
  const flatten = (message) => ts.flattenDiagnosticMessageText(message, " ");
  const tsConfig = tsConfigOf(workspace);

  // One shape for all three exits below, so the widened host and its OWN cache
  // (`declinedExtensionHostFor` says why they may not be shared with the
  // ordinary ones) cannot come to exist on some paths and not others — a
  // workspace with no tsconfig still resolves relative and `node_modules`
  // specifiers, and a `.vue` sibling of one of those is the same question.
  const context = (options, configFailure) => {
    // Asked once per workspace, and carried on the context so the widened
    // host's `fileExists` and the sibling lookup that reads its answer back
    // (`resolveSpecifier`) cannot come to hold different opinions of it: a host
    // that reported `…/data.json.ts` to exist while the lookup refused to map
    // it back would resolve the specifier and then discard the answer.
    const jsonIsResolvable = ordinaryPassLoadsJson(options);
    return {
      host,
      options,
      cache: ts.createModuleResolutionCache(host.root, (x) => x, options),
      declinedHost: declinedExtensionHostFor(host, jsonIsResolvable),
      declinedCache: ts.createModuleResolutionCache(host.root, (x) => x, options),
      jsonIsResolvable,
      configFailure,
    };
  };

  const text = workspace.readFile(tsConfig);
  if (text === null) {
    return context(/** @type {import("typescript").CompilerOptions} */ ({}), null);
  }

  const json = ts.parseConfigFileTextToJson(tsConfig, text);
  if (json.error) {
    return context(
      /** @type {import("typescript").CompilerOptions} */ ({}),
      `${tsConfig} is not valid JSON, so no path alias resolves: ${flatten(json.error.messageText)}`,
    );
  }
  const configHost = {
    useCaseSensitiveFileNames: true,
    readDirectory: () => [],
    fileExists: host.fileExists,
    readFile: host.readFile,
  };
  const parsed = ts.parseJsonConfigFileContent(
    json.config,
    configHost,
    host.root,
    undefined,
    `${host.root}/${tsConfig}`,
  );
  const errors = parsed.errors.filter((error) => error.code !== NO_INPUTS_FOUND);
  return context(
    parsed.options,
    errors.length === 0
      ? null
      : `${tsConfig} is malformed, so path aliases may not resolve: ${errors.map((e) => flatten(e.messageText)).join("; ")}`,
  );
});

/**
 * The alias table exactly as this analyzer's resolver will use it — for the
 * paths hygiene check in `../tsconfig-paths.mjs`. Reading `contextFor`'s own
 * memoised context (same file via `tsConfigOf`, same parse, same `extends`
 * handling) is what makes "the check judges the table the resolver reads" a
 * construction rather than a promise: there is no second load that could
 * disagree. `paths` is `undefined` when the workspace has no tsconfig or the
 * tsconfig declares none — the caller's silent case — while a config that
 * failed to load reports through `configFailure`, never as an absent table.
 * `base` is what `paths` targets resolve against: `baseUrl` when set, else
 * TypeScript's own `pathsBasePath` (the declaring config's directory), else
 * the workspace root — the same precedence `ts.resolveModuleName` applies.
 *
 * @param {import("./analyze.mjs").Workspace} workspace
 * @returns {{ tsConfig: string, configFailure: string|null,
 *   paths: Record<string, unknown>|undefined, base: string }}
 */
export function tsconfigPathsFacts(workspace) {
  const context = contextFor(workspace);
  return {
    tsConfig: tsConfigOf(workspace),
    configFailure: context.configFailure,
    paths: context.options.paths,
    base: context.options.baseUrl ?? context.options.pathsBasePath ?? context.host.root,
  };
}

/** `static` unless nothing in the import clause survives to runtime. */
function importDeclarationKind(node) {
  const clause = node.importClause;
  if (!clause) return "static"; // `import "./side-effect"`
  if (clause.isTypeOnly) return "type-only";
  if (clause.name) return "static"; // a default binding is a value
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0) {
    return bindings.elements.every((element) => element.isTypeOnly) ? "type-only" : "static";
  }
  return "static"; // namespace import, or an empty `{}`
}

/** `type-only` when the re-export is erased, `re-export` otherwise. */
function exportDeclarationKind(node) {
  if (node.isTypeOnly) return "type-only";
  const clause = node.exportClause;
  if (clause && ts.isNamedExports(clause) && clause.elements.length > 0) {
    return clause.elements.every((element) => element.isTypeOnly) ? "type-only" : "re-export";
  }
  return "re-export"; // `export * from`, or a namespace re-export
}

/**
 * Whether a call's callee names a CommonJS module lookup — upstream's
 * `getImportFromRequireCall` test, in TypeScript's AST instead of ESTree's.
 *
 * Upstream admits exactly two shapes and refuses everything else: a bare
 * `require` identifier, and a `MemberExpression` whose object is the identifier
 * `require` and whose property is the identifier `resolve`. Mapped node kind
 * for node kind, ESTree's non-computed `MemberExpression` is TypeScript's
 * `PropertyAccessExpression` — so `require["resolve"](x)` is refused by both,
 * upstream because its property is a `Literal` rather than an `Identifier` and
 * here because it parses as an `ElementAccessExpression`. A `PrivateIdentifier`
 * name keeps its `#` in `.text` and so can never equal `"resolve"`.
 *
 * Matching upstream's shape rather than a wider one is the point: a callee
 * upstream ignores would make this engine report where ESLint stays silent, and
 * every divergence in either direction has to be a decision someone wrote down
 * (`../conformance/README.md`).
 */
function isRequireCallee(callee) {
  if (ts.isIdentifier(callee)) return callee.text === "require";
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "require" &&
    callee.name.text === "resolve"
  );
}

/**
 * Every import site in a parsed source, in source order.
 *
 * Order is established by sorting on offset rather than by trusting the walk:
 * a depth-first walk happens to visit these node kinds in source order today,
 * and `contract.md` promises source order as a property of the output, not as
 * a side effect of the traversal.
 *
 * `callee` is the call form a site was written with (`import`, `require`,
 * `require.resolve`) and is absent for a declaration; it names the construct in
 * the failure a non-literal argument produces, so the report quotes what the
 * file actually says.
 *
 * @returns {{ offset: number, specifier: string, kind: string, literal: boolean, callee?: string }[]}
 */
function importSitesIn(sourceFile) {
  const sites = [];
  const at = (node) => node.getStart(sourceFile);

  const push = (node, kind, callee) => {
    if (ts.isStringLiteralLike(node)) {
      sites.push({ offset: at(node), specifier: node.text, kind, literal: true, callee });
      return;
    }
    // A non-literal argument: the site is real and the target is not knowable
    // statically. The record keeps the argument's source text as `specifier`
    // so a report can show what was written (`contract.md`).
    sites.push({
      offset: at(node),
      specifier: sourceFile.text.slice(at(node), node.end).trim(),
      kind,
      literal: false,
      callee,
    });
  };

  const pushCallArgument = (call, kind, callee) => {
    if (call.arguments.length === 0) {
      sites.push({ offset: at(call), specifier: "", kind, literal: false, callee });
      return;
    }
    push(call.arguments[0], kind, callee);
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      push(node.moduleSpecifier, importDeclarationKind(node));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      push(node.moduleSpecifier, exportDeclarationKind(node));
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      push(node.moduleReference.expression, node.isTypeOnly ? "type-only" : "static");
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        pushCallArgument(node, "dynamic", "import");
      } else if (isRequireCallee(node.expression)) {
        // `static` for `require(...)` and `require.resolve(...)` alike.
        // `contract.md`'s kinds separate sites by what survives to runtime and
        // by when the target is fetched — `type-only` is erased, `dynamic` is
        // deferred — and `require.resolve("x")` is neither: the specifier is
        // written literally, survives to runtime, and is read where the
        // statement stands. That the call yields a PATH rather than the
        // module's exports is a fact about its VALUE, and no rule reads the
        // value; all fifteen read the specifier, on which the two calls are the
        // same static declaration of a dependency on another project.
        //
        // Upstream agrees by construction — both forms enter its one
        // `run(imp, node)` with nothing distinguishing them — so any other kind
        // here would move a verdict away from ESLint on a site the two
        // otherwise agree about (`kind === "static"` is what gates the
        // lazy-loaded check).
        //
        // A non-literal argument is unresolvable, not dynamic, either way.
        pushCallArgument(
          node,
          "static",
          ts.isIdentifier(node.expression) ? "require" : "require.resolve",
        );
      }
    } else if (ts.isImportTypeNode(node)) {
      // ImportType is always type-only — it is a type query, erased at runtime.
      // `typeof import("typescript")` wraps the same ImportTypeNode inside a
      // TypeQueryNode; `ts.forEachChild` descends into the TypeQueryNode and
      // reaches this branch once, producing exactly one site, not a duplicate.
      // The argument is a LiteralType wrapping a StringLiteral for string-literal
      // arguments. Non-literal arguments (type references, template types) are
      // recorded as unresolvable following the same loud/skip discipline dynamic
      // import() already applies.
      const arg = node.argument;
      if (ts.isLiteralTypeNode(arg) && ts.isStringLiteralLike(arg.literal)) {
        push(arg.literal, "type-only");
      } else {
        // Non-literal argument: the site is real, the target is not knowable.
        push(arg, "type-only", "import");
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return sites.sort((a, b) => a.offset - b.offset);
}

/**
 * TypeScript's recorded syntax errors for a parsed file.
 *
 * `parseDiagnostics` is TypeScript's own field on a `SourceFile` and the only
 * way to see parse errors without building a `Program` — which would need the
 * whole compilation, on a machine that may have none of it. It is read
 * defensively: if a TypeScript upgrade ever removes it, this degrades to "no
 * parse failure reported" and never to a throw, because `createSourceFile`
 * itself recovers from malformed input and returns whatever it could parse.
 */
function parseFailures(sourceFile, workspaceRelativePath) {
  const diagnostics = sourceFile.parseDiagnostics;
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics.map((diagnostic) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    return {
      sourceFile: workspaceRelativePath,
      line: line + 1,
      column: character + 1,
      reason: `parse error: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
    };
  });
}

/**
 * Where a specifier points, through `ts.resolveModuleName`.
 *
 * `external` is decided by `isExternalLibraryImport` first and **project
 * ownership of the resolved file** second, rather than by ownership alone.
 * Ownership is `contract.md`'s definition ("resolves outside every project")
 * and gets a workspace file belonging to no project right — an alias pointed at
 * a loose root-level file is external, and `packageName` stays `null` because a
 * relative or aliased path names no package. But ownership alone is wrong for a
 * nested `node_modules/`, which every package that declares its own
 * `dependencies` has; the branch below says why, with the measurement.
 *
 * @returns {{ resolved: object|null, reason: string|null }}
 */
function resolveSpecifier(specifier, sourceFile, workspace) {
  const context = contextFor(workspace);
  const containingFile = `${context.host.root}/${sourceFile}`;
  const resolution = ts.resolveModuleName(
    specifier,
    containingFile,
    context.options,
    context.host,
    context.cache,
  );
  let resolvedFileName = resolution.resolvedModule?.resolvedFileName ?? null;
  let isExternalLibraryImport = resolution.resolvedModule?.isExternalLibraryImport ?? false;
  if (resolvedFileName === null) {
    // A Node built-in resolves for real at runtime, and TypeScript's resolver
    // structurally cannot say so: `node:fs` and `fs` have no package to find,
    // they are wired into the runtime, and a Program reaches them through
    // `types`/`lib` rather than through module resolution. Reporting them as
    // unresolvable would be a false statement about the world AND would bury
    // every genuine failure — measured on this workspace, 546 of 548 failures
    // were `node:*` and stdlib specifiers before this branch existed.
    //
    // The list comes from `node:module`'s own `isBuiltin`, never from a copy
    // of it here: the set changes with the Node version this runs on, and a
    // hand-kept list would be wrong the release after it was written.
    //
    // It is checked AFTER TypeScript, not before, so a workspace that really
    // does contain a package named `fs` still resolves to it.
    if (isBuiltin(specifier)) {
      return {
        resolved: {
          target: null,
          file: null,
          external: true,
          packageName: packageNameOf(specifier),
        },
        reason: null,
      };
    }
    // A relative specifier IS a path — there is no resolution left to
    // delegate, only a normalisation and an existence check. TypeScript
    // declines these because the extension is not one it compiles (`.vue`,
    // `.css`, `.svg`), and on this workspace that is a real hole rather than a
    // cosmetic one: `import Button from "../Button.vue"` can cross a project
    // boundary, and dropping it would make that crossing invisible.
    //
    // Deliberately narrow. No extension probing, no `index` lookup, no `paths`
    // mapping — the exact named file must exist. Anything more would be the
    // second resolver `AGENTS.md` forbids.
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      // Bundler query and fragment suffixes (`?raw`, `?url#hash`) name the
      // same file with a load-time transform; the raw form stays in the
      // record's `specifier`, so a rule that cares can still see it.
      const path = normalizePath(directoryOf(sourceFile), specifier.split(/[?#]/)[0]);
      if (workspace.readFile(path) !== null) {
        const owner = projectOwning(workspace.projects, path);
        return {
          resolved: {
            target: owner?.name ?? null,
            file: path,
            external: owner === null,
            packageName: null,
          },
          reason: null,
        };
      }
    }
    // The NON-relative half of the same hole, and the one that was silent.
    // A `paths` alias — or a `baseUrl` mapping, or a deep path into an
    // installed package — can land on a file whose extension TypeScript
    // declines just as a relative specifier can, and in a Vue workspace it
    // routinely does: `@acme/blocks/page-header` mapped to
    // `…/src/PageHeader.vue` is a project's SOURCE, not an asset.
    //
    // Declined, the site named NO target at all: this branch fell through to
    // the `resolved: null` return below, `../rules/index.mjs`'s
    // `resolveTargetNode` answers `undefined` for a record that did not
    // resolve, and the site landed in the `!targetProject` branch — which is
    // `../../../../docs/reference/violations.md`, "The order matters", step 4
    // (unresolvable target), not step 6. It never reached the external
    // classification at all, because `externalNodeFor` sits past a resolution
    // that never happened. The consequence is the same either way, since steps
    // 4 and 6 share rule 10: every `depConstraints` row was skipped, an
    // aliased specifier is no path so `noRelativeOrAbsoluteExternals` did not
    // apply, and under `banTransitiveDependencies: false` — the option's own
    // default — nothing was reported at all, so a primitive reaching into a
    // block's `.vue` source scored a clean run and exit 0.
    //
    // The answer still comes from `ts.resolveModuleName`. `declinedExtensionHostFor`
    // argues at length why widening one `fileExists` answer is not the second
    // resolver this package must not grow; the short version is that every
    // mapping rule stays TypeScript's, including the `*` substitution and the
    // `node_modules` walk, and a specifier TypeScript declines for any reason
    // other than the target's extension is still declined here.
    //
    // The relative branch above keeps its narrower rules and runs FIRST: it
    // strips bundler query suffixes and refuses extension probing outright,
    // which this pass has no way to offer, so a relative specifier it settles
    // never reaches here.
    const declined = ts.resolveModuleName(
      specifier,
      containingFile,
      context.options,
      context.declinedHost,
      context.declinedCache,
    );
    const sibling = declined.resolvedModule
      ? declinedSiblingOf(
          declined.resolvedModule.resolvedFileName,
          context.host.fileExists,
          context.jsonIsResolvable,
        )
      : null;
    // `sibling === null` when the widened pass resolved to a real file rather
    // than to a widened answer. That file was reachable by the ordinary pass
    // too, which declined it, so the widened pass has learned nothing and its
    // result is dropped rather than preferred.
    if (sibling === null) {
      return {
        resolved: null,
        reason: `TypeScript cannot resolve '${specifier}' from '${sourceFile}'`,
      };
    }
    resolvedFileName = sibling;
    isExternalLibraryImport = declined.resolvedModule.isExternalLibraryImport ?? false;
  }
  const prefix = `${context.host.root}/`;
  const file = resolvedFileName.startsWith(prefix) ? resolvedFileName.slice(prefix.length) : null;
  // An installed package resolving INSIDE a project's own directory is still an
  // installed package. `isExternalLibraryImport` is checked before ownership
  // because the two disagree in exactly one shape, and it is the shape every
  // publishable package in a workspace has: a package that declares its own
  // `dependencies` gets its own `node_modules/` — pnpm puts
  // `packages/<pkg>/node_modules/smol-toml` there — which sits under the
  // project root, so ownership by longest-root-prefix attributes a vendored
  // file to the project and the import reads as the project importing itself.
  //
  // Measured on this repository the day its own package declared `smol-toml`:
  // three `noSelfCircularDependencies` violations telling the tool to rewrite
  // `import "typescript"` as a relative path. The verdict was false, and worse
  // than false — the rule that fired is the one that cannot be switched off by
  // a `depConstraints` row, so a consumer hitting it would have no way to
  // configure their way out.
  //
  // Ownership still decides everything else, which is why this is a narrow
  // pre-empt rather than a replacement: an alias pointed at a loose root-level
  // file has no `isExternalLibraryImport` flag and must still read as external,
  // and a resolution into a sibling project must still name that project.
  //
  // The declined-extension pass above reaches here with the same two facts and
  // is judged by the same two branches, deliberately: `pkg/styles.css` inside
  // `node_modules` carries `isExternalLibraryImport` and stays an external
  // import of `pkg`, while an alias landing on a project's `.vue` source
  // carries neither and names the project that owns it.
  if (isExternalLibraryImport) {
    return {
      resolved: { target: null, file, external: true, packageName: packageNameOf(specifier) },
      reason: null,
    };
  }
  const owner = file === null ? null : projectOwning(workspace.projects, file);
  if (owner) {
    return {
      resolved: { target: owner.name, file, external: false, packageName: null },
      reason: null,
    };
  }
  return {
    resolved: { target: null, file, external: true, packageName: packageNameOf(specifier) },
    reason: null,
  };
}

/**
 * Analyzes one TypeScript/JavaScript source.
 *
 * Never throws: a malformed file yields what TypeScript could parse plus a
 * failure per syntax error, and an unexpected error anywhere yields a
 * file-level failure. One bad file must not blank a run (`contract.md`).
 *
 * @param {{ sourceFile: string, text: string, workspace: object, lang?: string }} request
 *   `lang` is the `<script lang>` of a Vue block; omitted for a real file,
 *   whose extension decides.
 * @returns {{ imports: object[], failures: object[] }}
 */
export function analyzeTypeScript({ sourceFile, text, workspace, lang }) {
  const result = emptyResult();
  try {
    const context = contextFor(workspace);
    if (context.configFailure) result.failures.push(fileFailure(sourceFile, context.configFailure));

    const parsed = ts.createSourceFile(
      `${workspace.root}/${sourceFile}`,
      text,
      ts.ScriptTarget.Latest,
      false,
      scriptKindFor(sourceFile, lang),
    );
    result.failures.push(...parseFailures(parsed, sourceFile));

    for (const site of importSitesIn(parsed)) {
      const { line, character } = parsed.getLineAndCharacterOfPosition(site.offset);
      // Every call site carries its own `callee`. A declaration reaches the
      // fallback only under parser recovery — a non-literal module specifier is
      // a grammar error there — and `import x = require(y)` is the form that
      // makes `require` the right word for it.
      const callee = site.callee ?? (site.kind === "dynamic" ? "import" : "require");
      const { resolved, reason } = site.literal
        ? resolveSpecifier(site.specifier, sourceFile, workspace)
        : {
            resolved: null,
            reason:
              `'${callee}(${site.specifier})' has a non-literal argument, ` +
              `so its target is not knowable statically`,
          };
      result.imports.push({
        sourceFile,
        line: line + 1,
        column: character + 1,
        specifier: site.specifier,
        kind: site.kind,
        spelling: specifierSpelling(site.specifier),
        resolved,
      });
      // A LITERAL specifier that failed to resolve is a hole — but only when it
      // names a project this workspace DECLARES. The resolver was asked a
      // concrete question about a workspace-internal dependency and could not
      // answer, so the edge that import would have carried (or the violation it
      // would have avoided) is missing and the file's boundary verdict is
      // incomplete — the same "could not look" shape an unreadable file takes
      // (`unchecked`, exit 3). A literal package import that names NO declared
      // project (`vitest`, `@nx/eslint-plugin`, an uninstalled third-party
      // package) is legitimate: a workspace with packages is a normal state,
      // and failing the whole run on every unresolved package import would
      // block merges over dependencies nobody crossed. Those stay positioned
      // site failures — the "blind spot" the contract documents as legitimately
      // permanent (`report/text.mjs`'s `formatFailures` is where the report
      // explains the two, and `cli.mjs` counts `unchecked` by
      // `failure.line === null`). A NON-LITERAL argument keeps its line/column
      // for the same reason: it is genuinely not statically knowable.
      if (reason) {
        result.failures.push(
          site.literal && namesDeclaredProject(site.specifier, workspace)
            ? fileFailure(sourceFile, reason)
            : { sourceFile, line: line + 1, column: character + 1, reason },
        );
      }
    }
  } catch (cause) {
    result.failures.push(
      fileFailure(sourceFile, `TypeScript analysis failed: ${cause?.message ?? cause}`),
    );
  }
  return result;
}
