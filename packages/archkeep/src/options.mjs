/**
 * The plugin's options: what a workspace may tell this tool about itself.
 *
 * Two filenames, and one optional third, and nothing else. All three are Nx
 * CONVENTIONS rather than fixed contracts — a workspace is free to name them
 * otherwise, and when it does, every answer this tool gives about that workspace
 * is silently wrong: a `tsconfig.base.json` under another name means no path
 * alias resolves, a boundary config under another name means the enforcer
 * cannot find the law and says so at best, reads a stale one at worst, and a
 * profiles registry under another name means the `check` command cannot find
 * the named laws it was asked to enforce. That is the difference between this
 * triple and the manifests next door: `go.mod`, `Cargo.toml`,
 * `pyproject.toml`, `nx.json` and `project.json` are named by their own
 * toolchains and cannot be renamed by a workspace decision, so they stay
 * hardcoded at their single use site: a literal belongs inline only where it is
 * intrinsic to a fixed external contract and appears in exactly one place.
 *
 * ## Where the options come from, and why there is no config file for them
 *
 * `nx.json → plugins` already carries a per-plugin `options` object, and Nx
 * threads it into every hook (`CreateDependencies<T> = (options, context) =>`).
 * A workspace that registers this plugin has already written the entry; adding
 * two keys to it costs nothing and adds no file. Inventing an
 * `archkeep.config.mjs` instead would add a file when the workspace
 * already carries the same options in `nx.json` — and it would need its own
 * filename option to find itself, which is the joke that gives the game away.
 *
 * ```json
 * "plugins": [
 *   {
 *     "plugin": "@ecoma-io/archkeep/nx",
 *     "options": { "boundaryConfig": "module-boundaries.config.mjs", "tsConfig": "tsconfig.base.json" }
 *   }
 * ]
 * ```
 *
 * A Moon workspace can write neither key: Moon's own configuration carries no
 * plugin-options table, and the `archkeep.json` that would state them is
 * refused beside `.moon/`. What it gets instead is convention — and the one
 * name whose convention is an ordered CHAIN rather than a single default is
 * argued at `MOON_TSCONFIG_CHAIN` below, with `readMoonOptions` as the reader.
 *
 * ## What is deliberately NOT an option: the language list
 *
 * The obvious next key is `languages: ["go", "rust"]`, and it must not exist.
 * Switching a language off there is indistinguishable, in every report this
 * tool prints, from that language having no violations — which is the exact
 * silence the whole project exists to end (`AGENTS.md`: an empty result is a
 * claim, not a shrug). A workspace with no Go pays nothing for Go support
 * already: each resolver keys off the manifests that exist, so it finds none
 * and does nothing. There is no cost to buy off, and the option would only sell
 * a way to turn enforcement off where nobody would see it happen.
 *
 * ## Why an unknown key throws
 *
 * `./config.mjs` takes the same posture with `depConstraints`, for the same
 * reason. A `tsconfigBase` typed for `tsConfig` that quietly fell back to the
 * default would produce a full green run against a rule nobody wrote. The
 * failure has to arrive at the first `nx` invocation, naming the key.
 *
 * ## The one field here that no workspace writes: `boundaryConfigDeclared`
 *
 * Merging the declaration over the default is what makes every reader
 * downstream simple — one string, always present, never a fallback to
 * re-derive. It also destroys the only fact that separates two workspaces
 * whose resolved options are byte-identical: one that never named a boundary
 * law and takes `DEFAULT_OPTIONS.boundaryConfig` by Nx convention, and one
 * that named `policy-we-declared.mjs` and then renamed or deleted it. A
 * command that may tolerate the first must not tolerate the second, and with
 * the provenance merged away it cannot tell them apart — measured on `graph`,
 * which answered exit 0 with no `policy` field on a native tree declaring a
 * `boundaryConfig` that was not there, byte-identical to a tree that never
 * had a law.
 *
 * So the bit rides out alongside the two names: `true` when the caller's own
 * object carried a `boundaryConfig` key, `false` when the value came from
 * `DEFAULT_OPTIONS`. It is deliberately NOT a member of `DEFAULT_OPTIONS`,
 * because that object is also the known-key roster the unknown-key check
 * above reads: adding it there would make `boundaryConfigDeclared: true` a
 * spelling a consumer could write into `nx.json`, which is a workspace
 * asserting its own provenance — the one claim this field exists to compute
 * rather than accept. Written into a `plugins[].options` table it throws like
 * any other unknown key.
 *
 * `./providers/native/model.mjs` computes the same bit for `archkeep.json`'s
 * own `boundaryConfig` field (including the inline-policy spelling, which
 * never reaches `resolveOptions` at all) and `./commands/context.mjs` is what
 * carries it onto `CommandContext.options` for all three providers — each
 * argued where it is written, not restated here.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { languageOf } from "./analysis/registry.mjs";

import { containmentViolation } from "./containment.mjs";
import { parseNxJson } from "./nx-json.mjs";

/**
 * The Nx conventions, so a workspace that follows them writes no options at
 * all. Frozen: a caller that mutated this would move the default for every
 * later reader in the process.
 */
export const DEFAULT_OPTIONS = Object.freeze({
  /** The workspace's module-boundary law — the table ESLint reads too. */
  boundaryConfig: "module-boundaries.config.mjs",
  /** Where the workspace's shared `compilerOptions` and `paths` live. */
  tsConfig: "tsconfig.base.json",
  /**
   * The workspace's named-profile registry, when it uses one — see
   * `./governance/profile-registry.mjs`. Absent (`undefined`) means the
   * workspace enforces by file, exactly as before; present, the value of
   * `boundaryConfig` becomes a profile NAME selected from this registry (the
   * check command's "select by name instead of by file" — documented in
   * `../../../docs/concepts/profiles.md`).
   */
  profiles: undefined,
});

/** The file Nx reads to learn a workspace exists — and where the options live. */
export const NX_CONFIG_FILE = "nx.json";

/**
 * Merges a raw options object over the defaults, refusing anything it does not
 * recognise.
 *
 * Pure, and takes the object rather than a path, for the reason every gate in
 * this repository takes its facts as arguments: a function that reads a file
 * AND decides something has to be split before it can be tested, and the split
 * is the improvement. `readPluginOptions` below is the only half that touches
 * a filesystem.
 *
 * @param {object|undefined|null} rawOptions Whatever `nx.json` carried, or
 *   whatever Nx handed the hook. Absent is legal and means "all defaults".
 * @returns {{boundaryConfig: string, tsConfig: string, profiles?: string,
 *   boundaryConfigDeclared: boolean}} `boundaryConfigDeclared` is the
 *   provenance of `boundaryConfig` and nothing else — `true` only when
 *   `rawOptions` carried the key itself. See the module header, "The one
 *   field here that no workspace writes".
 * @throws {Error} on an unknown key, a non-object, or a value that is not a
 *   non-empty string. An empty string would build `<root>/` and read a
 *   directory as a config, which fails somewhere far from the typo.
 */
export function resolveOptions(rawOptions) {
  if (rawOptions === undefined || rawOptions === null) {
    return { ...DEFAULT_OPTIONS, boundaryConfigDeclared: false };
  }
  if (typeof rawOptions !== "object" || Array.isArray(rawOptions)) {
    throw new Error(
      `archkeep: plugin options must be an object, got ${Array.isArray(rawOptions) ? "an array" : typeof rawOptions}`,
    );
  }

  // `known` stays exactly `DEFAULT_OPTIONS`' keys, which is what keeps
  // `boundaryConfigDeclared` an OUTPUT: it is not in that object, so a
  // `plugins[].options` table naming it hits the unknown-key throw below.
  const known = Object.keys(DEFAULT_OPTIONS);
  const resolved = {
    ...DEFAULT_OPTIONS,
    boundaryConfigDeclared: Object.hasOwn(rawOptions, "boundaryConfig"),
  };
  for (const [key, value] of Object.entries(rawOptions)) {
    if (!known.includes(key)) {
      throw new Error(
        `archkeep: unknown plugin option '${key}' — expected one of ${known.join(", ")}. ` +
          `Refused rather than ignored: an option that falls back to its default in silence is a ` +
          `green run against a rule nobody wrote.`,
      );
    }
    if (typeof value !== "string" || value === "") {
      throw new Error(
        `archkeep: plugin option '${key}' must be a non-empty string, got ` +
          `${value === "" ? "an empty string" : typeof value}`,
      );
    }
    resolved[key] = value;
  }
  return resolved;
}

/**
 * This plugin's own entry in an `nx.json` `plugins` array, in either form Nx
 * accepts: a bare string, or `{plugin, options}`.
 *
 * Matched on the specifier's TAIL rather than by equality, because the same
 * plugin is named three legitimate ways — `@ecoma-io/archkeep/nx` once it
 * resolves from the registry, `./packages/archkeep/nx.mjs` inside this
 * repository, and a path with or without the `.mjs` in a workspace that
 * vendored it. Requiring one spelling would make the options invisible in the
 * other two, and invisible options mean the defaults — silently.
 *
 * The bare package specifier (`@ecoma-io/archkeep`, with no `/nx`) does NOT
 * match: that resolves to the engine entry, which exports neither `name` nor
 * `createDependencies`, so Nx would not have loaded a plugin at all — an entry
 * this function accepted there would claim options for a plugin Nx never ran.
 *
 * @param {unknown} entry One element of `nx.json`'s `plugins`.
 * @returns {boolean}
 */
function namesThisPlugin(entry) {
  const specifier =
    typeof entry === "string" ? entry : /** @type {{ plugin?: unknown }} */ (entry)?.plugin;
  if (typeof specifier !== "string") return false;
  const withoutExt = specifier.replace(/\.mjs$/u, "");
  return withoutExt === "archkeep/nx" || withoutExt.endsWith("/archkeep/nx");
}

/**
 * `nx.json`'s parsed contents, or `null` when the workspace has none.
 *
 * The one place this file spawns a read and a parse, so `readPluginOptions`
 * and `readWorkspaceLayout` below — two independent readers of the same file
 * — cannot disagree about whether it is readable: both go through here, and
 * both therefore throw the identical `cannot read <path>` message on the same
 * malformed input rather than each carrying its own copy that could drift.
 *
 * @param {string} workspaceRoot
 * @param {(path: string) => string|null} readFile
 * @returns {object|null}
 * @throws {Error} when the file exists but `parseNxJson` cannot read it.
 */
function readNxJsonOrNull(workspaceRoot, readFile) {
  const path = `${String(workspaceRoot).replace(/\/$/u, "")}/${NX_CONFIG_FILE}`;
  // A tracked symlink at `nx.json` whose realpath leaves the workspace would
  // hand outside bytes in as the workspace's own registration — a whole
  // options read, and every verdict downstream of it, built on
  // attacker-controlled input and reported clean. Refusing turns that silent
  // read into a loud "cannot read" throw (`../containment.mjs`'s
  // `containmentViolation`, the read-side G-10 closure). The check applies to
  // every read of a real root: an injected in-memory reader a test drives is
  // keyed by a fixture path (`/w`, `/fixture`) that does not exist on disk, so
  // `existsSync(workspaceRoot)` is what keeps that seam untrodden, not a sentinel
  // on the reader — `pluginIsRegistered`'s real-fs `readFileAbsolute` is a
  // different function from `readFileOrNull` and must be contained too.
  const violation = existsSync(workspaceRoot) ? containmentViolation(workspaceRoot, path) : null;
  if (violation !== null) throw new Error(`archkeep: cannot read ${path}: ${violation}`);
  const text = readFile(path);
  if (text === null) return null;
  try {
    return parseNxJson(text);
  } catch (cause) {
    throw new Error(`archkeep: cannot read ${path}: ${cause?.message ?? cause}`, {
      cause,
    });
  }
}

/**
 * The resolved options a workspace root declares.
 *
 * The read is injectable, which is what keeps the one filesystem-touching
 * function here testable without a tree on disk: `readFile` takes an absolute
 * path and answers `null` for a file that is not there, so a test states an
 * `nx.json` as a string and every branch below is exercised over it. The
 * default reader is the only code in this module that reaches outside the
 * process.
 *
 * A workspace with no `nx.json`, no `plugins` array, or no entry for this
 * plugin gets the defaults. That is not the silent fallback the unknown-key
 * check refuses: the CLI and the language server are both usable in a tree that
 * never registered the plugin at all, and defaulting there is the Nx convention
 * being what it is. A `plugins` entry that IS present and carries a bad option
 * still throws.
 *
 * @param {string} workspaceRoot Absolute path of the tree being judged — never
 *   derived from this file's own location, for the reason `./config.mjs` gives.
 * @param {{readFile?: (path: string) => string|null}} [io] Injectable read, so
 *   `resolveOptions`'s callers can be driven over a tree that is not on disk.
 * @returns {{boundaryConfig: string, tsConfig: string, profiles?: string,
 *   boundaryConfigDeclared: boolean}} The three no-registration states below
 *   all answer `boundaryConfigDeclared: false`, because none of them is a
 *   workspace naming a law — see the module header.
 * @throws {Error} when `nx.json` is unparseable, or its options are malformed.
 *   Loud on purpose, and the same posture as everywhere else here: a tool that
 *   could not read its own configuration must not answer as though it had.
 */
export function readPluginOptions(workspaceRoot, { readFile = readFileOrNull } = {}) {
  const nxJson = readNxJsonOrNull(workspaceRoot, readFile);
  // The three "nothing registered here" exits go through `resolveOptions`
  // rather than spreading `DEFAULT_OPTIONS` directly, so the shape this
  // function returns is produced in exactly one place. A spread would have to
  // remember `boundaryConfigDeclared: false` three separate times, and the
  // one that forgot it would answer `undefined` — a provenance nobody wrote,
  // read downstream as whichever direction that caller's `??`/`!==` happened
  // to fall.
  if (nxJson === null) return resolveOptions(undefined);

  const plugins = Array.isArray(nxJson?.plugins) ? nxJson.plugins : [];
  const entry = plugins.find(namesThisPlugin);
  if (entry === undefined) return resolveOptions(undefined);
  return resolveOptions(typeof entry === "string" ? undefined : entry.options);
}

/**
 * The tsconfig filenames a Moon workspace is read against, in the order they
 * are tried — first one that exists wins.
 *
 * Moon is the one provider with nowhere to state the name. Nx states it in
 * `nx.json` → `plugins[].options.tsConfig` and a native root states it on
 * `archkeep.json`'s own `tsConfig` field; Moon's own configuration carries no
 * plugin-options table, and a `archkeep.json` beside `.moon/` is refused
 * outright (`./commands/context.mjs`'s `requireSingleProjectModel`), so every
 * door to a stated name is shut. What is left is convention, and one name is
 * not enough of it: measured on a 94-project Vue Moon workspace whose `paths`
 * table lives in `tsconfig.json` with no `tsconfig.base.json` beside it, a
 * provider fixed at the first name alone read the absent file, fell back to
 * `ts.resolveModuleName`'s compiler defaults, resolved every internal
 * specifier to nothing, and reported several hundred findings on a tree with
 * no architecture violation in it.
 *
 * The order is the point, not the membership: `tsconfig.base.json` is the Nx
 * convention this tool's default already names, and a workspace carrying both
 * files means the base one — `tsconfig.json` there is the editor's own
 * per-root config, which typically `extends` it. "Whichever we find" would
 * make the answer depend on the order two names happen to be written in.
 *
 * Extending the chain is a compatibility decision, not a lookup detail: a
 * third name added here changes the verdict of an unchanged workspace that
 * carries it. `../../../docs/integrations/moon.md`'s Configuration section
 * owns the consumer-facing statement of both the chain and what it does not
 * solve.
 *
 * The first entry is `DEFAULT_OPTIONS.tsConfig` itself rather than a second
 * spelling of the same string: the two must never disagree about which name
 * the convention starts at.
 */
export const MOON_TSCONFIG_CHAIN = Object.freeze([DEFAULT_OPTIONS.tsConfig, "tsconfig.json"]);

/**
 * The `tsConfigSource` a Moon workspace's options carry — the provenance
 * field beside `tsConfig`, the same shape `./commands/graph.mjs`'s
 * `workspaceLayoutSource` is to `workspaceLayout`.
 *
 * It exists because the name alone is not the whole fact. Two machines
 * checking out the same Moon workspace, one of them with an untracked
 * `tsconfig.json` in it, resolve different `paths` tables and report
 * different verdicts; with only the resolved name carried, a reader cannot
 * tell a name the workspace stated from a name this tool picked off a chain.
 * Nx and native options carry no such field — there the name IS stated — so
 * its presence is itself the "this was convention, not a declaration" fact.
 *
 * `./lsp/server.mjs`'s `watchedFilesFor` reads it for a second reason argued
 * there: the chain is ordered, so the file that would WIN can change without
 * the file that is currently chosen ever being touched.
 */
export const MOON_TSCONFIG_SOURCE = "moon-convention";

/**
 * The extensions whose absence of a tsconfig is genuinely ambiguous — the
 * only files that make `readMoonOptions` refuse.
 *
 * Two exclusions, both deliberate, and the second is the reason this is a
 * list of EXTENSIONS rather than the obvious list of languages:
 *
 * - Go, Rust and Python resolve through their own manifests and never read a
 *   tsconfig at all, so a Moon workspace of those three alone must not be
 *   refused for lacking a file nothing in it would have read.
 * - **`.js`, `.jsx`, `.mjs` and `.cjs` are absent even though
 *   `LANGUAGE_BY_EXTENSION` calls all four `typescript`**, because that table
 *   answers "which analyzer reads this" and the question here is a different
 *   one: "does a missing tsconfig mean we failed to find the paths table, or
 *   that there is no paths table?" For a `.ts` file the answer is ambiguous —
 *   `tsc` cannot run without a config, so one almost certainly exists
 *   somewhere and not finding it is evidence of a miss. For a plain-JS
 *   workspace it is not ambiguous at all: JavaScript needs no tsconfig, most
 *   such trees have never had one, and every relative and package specifier
 *   in them resolves correctly against the compiler defaults today. Refusing
 *   those would turn a run that is currently CORRECT into exit 3 — a
 *   regression wearing a hardening's clothes, which is the one thing this
 *   guard must not be.
 *
 * `.vue` is included because the Vue analyzer hands its `<script>` block to
 * the TypeScript one (`./analysis/vue.mjs`), which resolves it against the
 * same table.
 *
 * This is a second copy of extension knowledge that `./analysis/registry.mjs`
 * otherwise owns, so the filter below runs `languageOf` FIRST and this list
 * only ever narrows what the registry already claimed. An entry naming an
 * extension the registry does not claim therefore cannot widen the refusal —
 * it simply never matches — and `./options.test.mjs` pins that, probing
 * extensions from outside the registry as well as inside it, because a probe
 * set drawn only from the registry's own keys could not tell the two cases
 * apart.
 */
const TSCONFIG_RESOLVED_EXTENSIONS = Object.freeze([".ts", ".tsx", ".mts", ".cts", ".vue"]);

/**
 * The resolved options for a Moon workspace root.
 *
 * Every field is convention: Moon has no place to state either name, so this
 * function is where both are decided rather than read. `boundaryConfig` is
 * the default outright and `boundaryConfigDeclared` is therefore `false` — a
 * fact about Moon, not a fallback — while `tsConfig` walks
 * `MOON_TSCONFIG_CHAIN` and reports which entry answered through
 * `tsConfigSource`.
 *
 * **Neither candidate present, in a workspace with files that resolve
 * through a `paths` table, THROWS.** That is a change of behaviour and the
 * point of this function: before it, such a tree was judged against
 * TypeScript's compiler defaults, where an aliased specifier resolves to
 * nothing, every internal import reads as a boundary crossing, and the report
 * is a wall of findings with no line anywhere saying the paths table was
 * never found. A tool that could not resolve the workspace's own imports must
 * not answer as though it had (`../../../AGENTS.md`, "The invariant everything
 * is judged against") — so the run stops, naming both candidate names and the
 * files that needed one.
 *
 * A Moon workspace with no such file is NOT refused: it would be refused for
 * lacking a config nothing in it reads. That covers Go, Rust and Python — and
 * also a plain-JavaScript tree, because `TSCONFIG_RESOLVED_EXTENSIONS` is
 * narrower than the language table on purpose; its own comment argues why.
 * There the chain's first entry is carried as the name, so the watcher list
 * `./lsp/server.mjs` derives still covers the file that would change the
 * answer if it arrived.
 *
 * @param {string} workspaceRoot Absolute path of the tree being judged.
 * @param {{exists?: (path: string) => boolean, listFiles: () => string[]}} io
 *   `exists` is plain filesystem existence, the same test every other marker
 *   is read by, injectable so a test drives the chain with no tree on disk.
 *   `listFiles` is REQUIRED and a thunk rather than an array: it is called
 *   only on the one branch that needs it — neither candidate present — so a
 *   workspace that carries one pays nothing for the question, and this module
 *   never grows an import of `./workspace.mjs`, which imports it back.
 * @returns {{boundaryConfig: string, tsConfig: string, tsConfigSource: string,
 *   boundaryConfigDeclared: boolean}}
 * @throws {Error} when no chain entry exists and the tracked files include a
 *   language that resolves through the `paths` table.
 */
export function readMoonOptions(workspaceRoot, { exists = existsSync, listFiles }) {
  const found = MOON_TSCONFIG_CHAIN.find((name) => exists(join(workspaceRoot, name)));
  if (found === undefined) {
    // Two conditions, and the first is what keeps this list strictly NARROWER
    // than the analyzer registry rather than merely different from it.
    // `languageOf` owns the matching rule — last dot of the basename — so a
    // path whose whole basename is `.ts` resolves to `null` there and is
    // skipped here too, instead of triggering a refusal for a file no
    // analyzer would ever read.
    const needing = listFiles().filter(
      (file) =>
        languageOf(file) !== null &&
        TSCONFIG_RESOLVED_EXTENSIONS.some((extension) => file.endsWith(extension)),
    );
    if (needing.length > 0) {
      throw new Error(
        `archkeep: ${workspaceRoot} is a Moon workspace carrying ${needing.length} file` +
          `${needing.length === 1 ? "" : "s"} that resolve` +
          `${needing.length === 1 ? "s" : ""} through a TypeScript paths table ` +
          `(${needing.slice(0, 3).join(", ")}${needing.length > 3 ? ", …" : ""}), and none of ` +
          `${MOON_TSCONFIG_CHAIN.join(" or ")} is there to read it from. Moon carries no ` +
          `plugin-options table to name one under and a archkeep.json beside .moon is refused, ` +
          `so those names are the whole convention. Refused rather than judged: read against ` +
          `the compiler defaults instead, every aliased import resolves to nothing and the run ` +
          `reports a boundary crossing for each one — a wall of findings on a workspace that ` +
          `may have no violation in it at all. Add ${MOON_TSCONFIG_CHAIN[0]} at the workspace ` +
          `root, or rename the config that already holds the paths table to one of those two ` +
          `names. The Moon integration guide in this tool's documentation ` +
          `covers both routes.`,
      );
    }
  }
  return {
    boundaryConfig: DEFAULT_OPTIONS.boundaryConfig,
    // No candidate and nothing that would have read one: the chain's first
    // entry is the name carried, so the file whose ARRIVAL would change the
    // answer is the file the watcher list already covers.
    tsConfig: found ?? MOON_TSCONFIG_CHAIN[0],
    tsConfigSource: MOON_TSCONFIG_SOURCE,
    boundaryConfigDeclared: false,
  };
}

/**
 * The two keys `nx.json`'s `workspaceLayout` may carry — the same pair
 * `./providers/native/model.mjs`'s `WORKSPACE_LAYOUT_KEYS` validates for
 * `archkeep.json`'s identically-named field, kept as two separate constants
 * because the two files sit on opposite sides of the layer boundary
 * `packages/archkeep/AGENTS.md` draws (`src/options.mjs` owns what a workspace
 * may tell this tool about ITSELF via Nx's own config; `src/providers/native/`
 * owns the `archkeep.json` dialect) — a shared constant would import one layer
 * into the other for two frozen strings.
 */
const WORKSPACE_LAYOUT_KEYS = Object.freeze(["appsDir", "libsDir"]);

/**
 * `nx.json`'s `workspaceLayout`, exactly as declared — never merged with a
 * default and never required to be complete. A caller downstream has to be
 * able to tell "declared nothing" from "declared the default", which is why
 * this returns `null` for the former and the declared object verbatim
 * (partial or not) for the latter, rather than folding either case into
 * `./rules/specifiers.mjs`'s `DEFAULT_WORKSPACE_LAYOUT`. Whether a PARTIAL
 * declaration is usable is a different, narrower question — this reader only
 * answers "is what's here well-formed" — and `requireCompleteWorkspaceLayout`
 * below answers the narrower one for the two callers that need it.
 *
 * @param {string} workspaceRoot
 * @param {{readFile?: (path: string) => string|null}} [io]
 * @returns {{appsDir?: string, libsDir?: string}|null} `null` when the
 *   workspace has no `nx.json`, or its `nx.json` declares no `workspaceLayout`
 *   key.
 * @throws {Error} when `workspaceLayout` is present but is not a plain
 *   object, names a key other than `appsDir`/`libsDir`, or gives either key a
 *   non-string or empty-string value. Reading any of those as "no layout
 *   declared" would silence `noRelativeOrAbsoluteImportsAcrossLibraries` on
 *   exactly the workspace whose configuration is broken — the same reasoning
 *   `./providers/native/model.mjs`'s `workspaceLayoutViolations` already
 *   applies to `archkeep.json`'s identically-shaped field.
 */
export function readWorkspaceLayout(workspaceRoot, { readFile = readFileOrNull } = {}) {
  const nxJson = readNxJsonOrNull(workspaceRoot, readFile);
  if (nxJson === null) return null;
  const declared = /** @type {{workspaceLayout?: unknown}} */ (nxJson)?.workspaceLayout;
  if (declared === undefined) return null;
  if (typeof declared !== "object" || declared === null || Array.isArray(declared)) {
    throw new Error(
      `archkeep: nx.json's workspaceLayout must be an object, got ` +
        `${Array.isArray(declared) ? "an array" : typeof declared}`,
    );
  }
  for (const key of Object.keys(declared)) {
    if (!WORKSPACE_LAYOUT_KEYS.includes(key)) {
      throw new Error(
        `archkeep: nx.json's workspaceLayout.${key} is not a workspaceLayout field — expected ` +
          `one of ${WORKSPACE_LAYOUT_KEYS.join(", ")}`,
      );
    }
    const value = /** @type {Record<string, unknown>} */ (declared)[key];
    if (typeof value !== "string" || value === "") {
      throw new Error(
        `archkeep: nx.json's workspaceLayout.${key} must be a non-empty string, got ` +
          `${value === "" ? "an empty string" : typeof value}`,
      );
    }
  }
  return /** @type {{appsDir?: string, libsDir?: string}} */ (declared);
}

/**
 * Narrows a `readWorkspaceLayout` result to "usable by the rule engine":
 * either nothing declared (`null`, unchanged) or BOTH `appsDir` and `libsDir`
 * present. `./rules/specifiers.mjs`'s `isAbsoluteImportIntoAnotherProject`
 * reads both keys off one object with no per-key fallback — a workspace
 * declaring only `libsDir` would silently evaluate `appsDir` as `undefined`
 * and never match a real `apps/` import, the exact silent degradation
 * `AGENTS.md`'s invariant rules out.
 *
 * This is also the parity point between the two providers:
 * `./providers/native/model.mjs`'s `workspaceLayoutViolations` already
 * refuses an incomplete `workspaceLayout` for `archkeep.json` — it never
 * merges a partial declaration onto a default, it rejects the whole file — so
 * `./providers/nx.mjs` and `./lsp/workspace-index.mjs` both call this
 * function rather than each deciding independently, and the same declared
 * object is accepted or refused identically by both.
 *
 * @param {{appsDir?: string, libsDir?: string}|null} declared
 * @returns {{appsDir: string, libsDir: string}|null}
 * @throws {Error} when `declared` is non-null but missing `appsDir` or
 *   `libsDir`.
 */
export function requireCompleteWorkspaceLayout(declared) {
  if (declared === null) return null;
  const missing = WORKSPACE_LAYOUT_KEYS.filter((key) => !(key in declared));
  if (missing.length === 0) {
    return /** @type {{appsDir: string, libsDir: string}} */ (declared);
  }
  throw new Error(
    `archkeep: nx.json's workspaceLayout declares ${Object.keys(declared).join(", ") || "nothing"} ` +
      `but is missing ${missing.join(", ")} — declare both appsDir and libsDir, or neither.`,
  );
}

/**
 * Whether `workspaceRoot`'s `nx.json` registers THIS plugin — the other half
 * of the unregistered-plugin gap `./workspace.mjs`'s `polyglotManifests`
 * names the manifests for. A workspace can carry a tracked `go.mod` and never
 * have told Nx to look, and that tree's `nx affected` under-selects with no
 * warning at all — measured, the same silence `AGENTS.md`'s empty-result
 * invariant refuses. This function only answers the yes/no; it is exported
 * and tested on its own, and it is not currently consulted by `check`'s
 * refusal logic — a later caller wires the two facts together.
 *
 * Shares `readPluginOptions`'s reader convention deliberately: `readFile`
 * takes an absolute path and answers `null` for a file that is not there, the
 * same default as that function, so a caller that already has one reader for
 * this workspace's `nx.json` uses it for both calls.
 *
 * @param {string} workspaceRoot Absolute path of the tree being judged.
 * @param {{readFile?: (path: string) => string|null}} [io]
 * @returns {boolean} `false` for no `nx.json`, no `plugins` array, or no
 *   entry naming this plugin — the same three no-registration states
 *   `readPluginOptions` treats as "use the defaults". `true` for either form
 *   `namesThisPlugin` accepts: a bare string, or `{plugin, options}`.
 * @throws {Error} when `nx.json` exists but cannot be parsed — the same
 *   posture as `readPluginOptions`: a tool that could not read its own
 *   configuration must not answer as though it had.
 */
export function pluginIsRegistered(workspaceRoot, { readFile = readFileOrNull } = {}) {
  const nxJson = readNxJsonOrNull(workspaceRoot, readFile);
  if (nxJson === null) return false;

  const plugins = Array.isArray(nxJson?.plugins) ? nxJson.plugins : [];
  return plugins.some(namesThisPlugin);
}

/** A file's contents, or `null` when it does not exist or cannot be read. */
function readFileOrNull(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
