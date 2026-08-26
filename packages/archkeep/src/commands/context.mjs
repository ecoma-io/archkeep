/**
 * The preamble every command shares: which workspace, which provider, which
 * files, and what a whole-tree read of them found. `../../cli.mjs`'s `check`
 * built exactly this before `--format json` existed; this module is that
 * preamble lifted out so a second command can reuse it rather than reimplement
 * it a rule at a time. What is deliberately NOT here: the boundary policy
 * (`../config.mjs`'s `loadBoundaryConfig`/`loadBoundaryConfigFile`), the
 * go.work drift check, and the tsconfig paths hygiene check — all three are
 * `check`'s own concerns, judged from what this module hands back, not part of
 * establishing "which tree, which files, what did reading them find" that a
 * later command (`graph`, `explain`, `impact`, `diff`) needs identically.
 *
 * Everything below is a straight extraction: no branch here changes what
 * `check` decided before this module existed, because the byte-for-byte
 * unchanged verdict on an unchanged tree is itself part of the contract
 * (`../../../../AGENTS.md`, "a change to what is reported on an unchanged
 * workspace is a breaking change").
 *
 * `../providers/native/index.mjs`'s header states that module imports nothing
 * from `../workspace.mjs`; this module is the one place both a provider and
 * `../workspace.mjs` are composed, which is why it lives beside the commands
 * that need the composition rather than inside either provider
 * (`./README.md`).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { containmentViolation } from "../containment.mjs";
import { dotnetIndexFailures } from "../analysis/dotnet/namespaces.mjs";
import { dotnetManifestFailures } from "../analysis/dotnet/csproj.mjs";
import { mavenManifestFailures } from "../analysis/jvm/maven.mjs";
import { gradleManifestFailures } from "../analysis/jvm/gradle.mjs";
import { languageOf } from "../analysis/registry.mjs";
import { pythonUnmodelledFailures } from "../analysis/python.mjs";
import { fileFailure } from "../analysis/source-util.mjs";
import {
  DEFAULT_OPTIONS,
  NX_CONFIG_FILE,
  pluginIsRegistered,
  readMoonOptions,
  readPluginOptions,
} from "../options.mjs";
import { readProjectGraph } from "../providers/nx.mjs";
import { ARCHKEEP_MODEL_FILE } from "../providers/native/model.mjs";
import {
  MOON_DIR,
  MOON_ALT_DIR,
  mergeImportEdges,
  moonMarkerAt,
  moonProvider,
} from "../providers/moon.mjs";
import { nativeProvider } from "../providers/native/index.mjs";
import {
  analyzeWorkspace,
  annotateMFERemotes,
  annotatePackageFacts,
  createWorkspace,
  findWorkspaceRoot,
  listTrackedFiles,
  polyglotManifests,
  selectFiles,
} from "../workspace.mjs";

/**
 * Workspace-relative read from `root` — the same default `createWorkspace`
 * builds when no reader is injected (`../workspace.mjs`), duplicated here
 * rather than imported because it is needed BEFORE a `Workspace` exists to
 * read from: `nativeProvider.discover` needs one to load `archkeep.json`
 * itself.
 *
 * Carries the same containment rule as that default reader: a tracked symlink
 * whose realpath leaves the workspace would hand the reader outside bytes as
 * the workspace's own declaration — a model file read that way is a whole
 * verdict built on attacker-controlled input, reported clean. Refusing (null)
 * makes the read a loud "cannot load" failure rather than a silent
 * read-and-judge (`../containment.mjs`, the G-10 closure).
 *
 * @param {string} root
 * @returns {(path: string) => string|null}
 */
function readWorkspaceRoot(root) {
  return (path) => {
    const abs = join(root, path);
    if (containmentViolation(root, abs) !== null) return null;
    try {
      return readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  };
}

/**
 * The real-filesystem reader `pluginIsRegistered` (`../options.mjs`) gets
 * when no seam overrides it. Unlike `readWorkspaceRoot` above, this one takes
 * an ALREADY-ABSOLUTE path: `pluginIsRegistered` builds
 * `${workspaceRoot}/${NX_CONFIG_FILE}` itself before calling its reader, so a
 * `join(root, path)`-style reader would double the root onto an already-full
 * path.
 *
 * @param {string} path
 * @returns {string|null}
 */
function readFileAbsolute(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Which Moon directory marks `root` — or none. Presence facts only; see
 * `requireSingleProjectModel` below for the one-decision gate.
 *
 * @param {string} root
 * @returns {{hasNx: boolean, hasNative: boolean, hasMoon: boolean}}
 */
export function markersAt(root) {
  return {
    hasNx: existsSync(join(root, NX_CONFIG_FILE)),
    hasNative: existsSync(join(root, ARCHKEEP_MODEL_FILE)),
    hasMoon: moonMarkerAt(root) !== null,
  };
}

/**
 * The one gate deciding whether `root` may be judged at all: more than ONE
 * project-model marker present is refused, naming what conflicts.
 *
 * Every entry point that picks a provider must answer this identically —
 * `resolveCommandContext` below reads it before any command runs, and
 * `../lsp/workspace-index.mjs`'s index build reads it before choosing a
 * branch. A second copy of the condition was exactly how the faces drifted
 * apart once: the CLI refused a tree carrying a Moon directory beside
 * `nx.json`/`archkeep.json` while the editor indexed it anyway — a clean
 * diagnostic list over a tree nobody agreed could be judged (#223's silent
 * shape, one level up). Moon-versus-Moon coexistence (`.moon/` AND
 * `.config/moon/`) is refused inside `../providers/moon.mjs`'s
 * `moonMarkerAt`, which this gate calls first; the cross-family pairs are
 * refused here, all in the same terms: which model to judge against is a
 * decision nobody made, not one this tool can make for them.
 *
 * @param {string} root
 * @param {{exists?: (path: string) => boolean}} [io] Injectable existence
 *   test (absolute paths), so a test drives this without a filesystem.
 * @returns {{hasNx: boolean, hasNative: boolean, moonMarker: string|null}}
 *   The facts a provider choice needs; `moonMarker` names whichever Moon
 *   directory is present, `null` when neither spelling is.
 * @throws {Error} when more than one marker is present.
 */
export function requireSingleProjectModel(root, { exists = existsSync } = {}) {
  const moonMarker = moonMarkerAt(root, { exists });
  const hasNx = exists(join(root, NX_CONFIG_FILE));
  const hasNative = exists(join(root, ARCHKEEP_MODEL_FILE));
  const refusal = (a, b) =>
    new Error(
      `archkeep: ${root} declares both ${a} and ${b} — this tool judges a workspace ` +
        `against exactly one project model, and a tree carrying both is a decision nobody made ` +
        `rather than one this tool can make for them. Remove whichever one is not the ` +
        `workspace's real source of truth for projects and tags.`,
    );
  if (moonMarker !== null && hasNx) throw refusal(moonMarker, NX_CONFIG_FILE);
  if (moonMarker !== null && hasNative) throw refusal(moonMarker, ARCHKEEP_MODEL_FILE);
  if (hasNx && hasNative) throw refusal(NX_CONFIG_FILE, ARCHKEEP_MODEL_FILE);
  return { hasNx, hasNative, moonMarker };
}

/**
 * Every marker a workspace root may be recognised by, as one list.
 *
 * Exported because `cli.mjs` walks for a root a second time — `--help` and
 * `adr` need one before a `CommandContext` exists — and that walk kept its own
 * copy of this list. The copy went stale: it named `nx.json` and `archkeep.json`
 * only, so `adr` answered "no workspace root" on every Moon tree while naming
 * `.moon` in the very message, and `--help` fell back to defaults there. The
 * two callers still differ in posture — one throws where the other returns a
 * default — but they may not differ in what a workspace root IS.
 *
 * @type {string[]}
 */
export const WORKSPACE_MARKERS = [NX_CONFIG_FILE, ARCHKEEP_MODEL_FILE, MOON_DIR, MOON_ALT_DIR];

/**
 * @typedef {object} CommandContext
 * @property {string} root Absolute workspace root.
 * @property {"nx"|"native"|"moon"} provider Which project-model provider answered.
 * @property {string} marker `nx.json`, `archkeep.json`, `.moon`, or `.config/moon` — whichever
 *   `root` carries, and the one this run's provider came from.
 * @property {object} graph `{nodes, dependencies}`, from `readProjectGraph`
 *   or `nativeProvider.buildGraph`.
 * @property {object} workspace The `Workspace` `../workspace.mjs`'s
 *   `createWorkspace` returns.
 * @property {string[]} tracked Every tracked file, from `listFiles(root)`.
 * @property {{imports: object[], failures: object[], analyzed: number,
 *   analyzedFiles: string[], exemptedFiles: string[]}} analysis The
 *   whole-tree-then-scoped (native) or scoped-then-analyzed (nx/moon) result —
 *   see the branches below for why the order is not the same on all three.
 *   `exemptedFiles` is always `[]` on nx/moon: `coverage.exempt` is a
 *   native-only `archkeep.json` key.
 * @property {{boundaryConfig: string|object, tsConfig: object|undefined,
 *   boundaryConfigDeclared: boolean, profiles?: string, inline?: boolean}} options
 *   What this workspace names its boundary law, its shared tsconfig, and —
 *   when it uses one — its named profile registry. `check`'s `--config` flag,
 *   if given, still wins over `options.boundaryConfig`; that override is
 *   `check`'s decision, not this module's.
 *   `boundaryConfigDeclared` is not a name but the provenance of one: `true`
 *   when this workspace's own config named a boundary law (`nx.json`'s
 *   `plugins[].options.boundaryConfig`, or `archkeep.json`'s field in either
 *   its filename or its inline-policy spelling), `false` when the name above
 *   is `../options.mjs`'s `DEFAULT_OPTIONS` convention and nobody wrote one.
 *   Always present, on all three providers. A command that may tolerate a law
 *   file that is not there — `graph`, which describes the project graph and
 *   judges nothing against a constraint row — reads this to tell "no law was
 *   ever written" from "the law this workspace named has been renamed or
 *   deleted", which the merged `boundaryConfig` string alone cannot. That
 *   module's header owns the argument.
 * @property {{registered: boolean, manifests: string[]}} pluginGap Whether
 *   this workspace's own provider is the one Nx would actually run, and which
 *   tracked polyglot manifests sit under a project root either way. Always
 *   `{registered: true, manifests: []}` on a native or Moon workspace: there
 *   is no Nx plugin registration to be missing, because there is no `nx.json`.
 *   Computed and returned, but not consulted by `check`'s refusal logic —
 *   `../../../../docs/usage/` names the gap this fills and the issue tracking it
 *   wiring it in.
 * @property {{files: string[], languages: string[]}} unownedGap The tracked
 *   analyzable files no project owns that this run deliberately does NOT fail
 *   on — `unownedAnalyzableFiles` below owns the argument, and
 *   `./check.mjs` turns a non-empty `files` into the `"unowned-files"`
 *   `coverageGaps` entry. Always `{files: [], languages: []}` on a native
 *   workspace: there, every unclaimed analyzable file is already a whole-file
 *   failure (`../providers/native/coverage.mjs`'s `judgeCoverage`) and so
 *   already refuses the run with exit 3 — a gap beside it would be a second,
 *   quieter voice for a state that is answered loudly.
 * @property {{files: string[]}} unclaimedGap The tracked Go, Rust or Python
 *   files no project owns — the SAME files whose whole-file failures
 *   `unclaimedFileFailures` already put in `analysis.failures`, listed a
 *   second time as data so `./check.mjs` and `./waivers.mjs` can match the
 *   policy's `coverage.unowned` acceptance rows against them
 *   (`./coverage-acceptance.mjs`) without parsing a failure's sentence back
 *   into a file list. Always `{files: []}` on a native workspace, whose own
 *   `coverage.exempt` channel makes the policy key unreachable there
 *   (`./policy.mjs`'s `resolvePolicy`).
 * @property {{file: string, project: string}[]} owned Every tracked file that
 *   belongs to a project, paired with its owning project — the ownership map
 *   `createWorkspace` already built. A command that needs to know WHICH project
 *   owns a file (the planning context's path→project scoping, `./plan-context-command.mjs`)
 *   reads this rather than re-deriving ownership a second way.
 */

/**
 * The languages Nx cannot draw an edge for and ESLint cannot parse at all —
 * `../../../AGENTS.md`'s own opening line: "Nx reads TypeScript and
 * JavaScript imports and so `nx affected` and `@nx/enforce-module-boundaries`
 * work there; for the other three both go quiet." TypeScript, JavaScript
 * (and their `.mjs`/`.cjs`/`.jsx`/`.tsx` siblings) and Vue are deliberately
 * OUTSIDE this set: Nx's own graph already draws their edges from real
 * imports, and `@nx/enforce-module-boundaries` already lints them through
 * ESLint's normal file scoping, so a root-level tooling script in one of
 * those languages sitting outside every declared project is the ordinary,
 * unremarkable shape of an Nx or Moon workspace — this very repository's own
 * root carries a whole `scripts/` directory of them, plus `.opencode/plugins/`
 * and `commitlint.config.mjs`, inside neither of its two Moon projects — not
 * a gap this tool introduces. `../workspace.mjs`'s `polyglotManifests` already
 * draws this exact same line for the unregistered-plugin coverage gap, over
 * the three languages' manifests rather than their sources; this is that
 * same boundary restated for `unclaimedFileFailures` below, which has no
 * manifest to key off since an unclaimed file is, by definition, one with no
 * project (and so no `go.mod`/`Cargo.toml`/`pyproject.toml`) to belong to.
 *
 * Scoping to these three is not a smaller fix chosen for convenience — it is
 * the fix: widening this to every analyzable language turns `check` into a
 * breaking change for nearly every real Nx/Moon consumer, measured by running
 * it over this repository's own tree, whose tooling layer is exactly this
 * shape and whose own `check` must keep exiting 0.
 */
const UNCLAIMED_CHECK_LANGUAGES = new Set(["go", "rust", "python"]);

/**
 * Tracked Go, Rust or Python files that no project in `owned` claims — the
 * same "unclaimed file" question `../providers/native/coverage.mjs`'s
 * `judgeCoverage` answers for a native workspace (over every analyzable
 * language there, `UNCLAIMED_CHECK_LANGUAGES` above argues why this narrower
 * set is the right one here), asked for the Nx and Moon branches below,
 * neither of which has a discovery step of its own to answer it from: both
 * build their graph from `nx graph`/`moon project-graph` rather than from
 * `archkeep.json`, and `../providers/native/coverage.mjs`'s own header names
 * the gap this closes — "this package's Nx path ... has no unclaimed-file
 * check of its own: both compute imports and violations only for files a
 * project already claims."
 *
 * `owned` already IS the claimed half of this question: `createWorkspace`
 * (`../workspace.mjs`) computed it over the FULL tracked-file list by the
 * same longest-root-prefix match `../providers/native/coverage.mjs`'s
 * `projectOf` uses, silently dropping any file that matched no project
 * (`../workspace.mjs`'s own header — "A file no project owns ... is dropped
 * here rather than read and analyzed for a verdict that cannot exist").
 * Comparing against the set `createWorkspace` already produced, rather than
 * matching roots a second time, is what keeps this answer from being able to
 * disagree with what "owned" already means for this graph.
 *
 * A file this returns is exactly the silent hole `../../../../AGENTS.md`'s
 * invariant refuses: analyzed by nothing, judged by nothing, and an empty
 * violation list reading identically to a file that really was clean. It
 * ignores path scoping on purpose — `tracked`, not the caller's scoped
 * selection — the same workspace-wide posture native's own unclaimed check
 * already has (its failures ride in `discovered.failures` below, unfiltered
 * by `paths`), because a `check <path>` run must not be able to hide an
 * orphan file elsewhere in the tree by naming a path that excludes it.
 *
 * Returns the SAME whole-file `fileFailure` shape (`../analysis/source-util.mjs`)
 * a language analyzer produces for a file it could not read, so `../../cli.mjs`'s
 * existing `unchecked`/`coverage.complete` logic — already built to treat any
 * whole-file failure as a coverage hole — picks these up with no change of its
 * own, exactly as it already does for native's. The wording names
 * `providerLabel` rather than native's `archkeep.json`/`coverage.exempt`
 * vocabulary, because neither Nx nor Moon has an exemption mechanism this
 * tool reads — inventing one is out of scope here; this only detects and
 * reports.
 *
 * The file list and the failures it becomes are two exports on purpose:
 * `./check.mjs` and `./waivers.mjs` need the LIST a second time — the
 * `coverage.unowned` acceptance channel (`./coverage-acceptance.mjs`) matches
 * its rows against exactly this set, and deriving the set from the failures'
 * wording would bind an acceptance decision to a sentence.
 *
 * @param {{tracked: string[], owned: {file: string, project: string}[]}} args
 * @returns {string[]}
 */
function unclaimedAnalyzableFiles({ tracked, owned }) {
  const ownedFiles = new Set(owned.map(({ file }) => file));
  return tracked.filter(
    (file) => UNCLAIMED_CHECK_LANGUAGES.has(languageOf(file)) && !ownedFiles.has(file),
  );
}

/**
 * The whole-file failures for `unclaimedAnalyzableFiles`' list — the shape
 * argued in the comment above the two functions.
 *
 * @param {{files: string[], providerLabel: string}} args
 * @returns {object[]}
 */
function unclaimedFileFailures({ files, providerLabel }) {
  return files.map((file) =>
    fileFailure(
      file,
      `is not owned by any project in ${providerLabel} — every tracked Go, Rust or Python file ` +
        `must belong to exactly one declared project, so its cross-project imports can be checked`,
    ),
  );
}

/**
 * The OTHER half of the same question: tracked analyzable files no project
 * owns whose language `UNCLAIMED_CHECK_LANGUAGES` above deliberately leaves
 * out — TypeScript, JavaScript and Vue. That set's own argument stands
 * unchanged and is not widened here: those three keep producing no failure,
 * no `notAnalyzed` entry, no `coverage.complete: false` and no exit 3.
 *
 * What they were also producing was nothing at all. `createWorkspace`
 * (`../workspace.mjs`) drops a file no project owns, so such a file left no
 * trace on any surface: `coverage.analyzedFiles` counted only owned files,
 * `notAnalyzed`/`coverageGaps`/`notes` stayed empty, and a run over a tree
 * with fifty of them printed the same bytes as a run over a tree with none —
 * measured on this repository, where 50 of 425 tracked analyzable files sit
 * outside both Moon projects — 49 of them reported, once the run's own
 * boundary config is subtracted by `unownedGapWithoutRunConfiguration` below. Tolerated is a decision; invisible is the
 * silent direction `../../../../AGENTS.md`'s invariant refuses, and the two
 * are not the same thing.
 *
 * So this reports rather than judges: `./check.mjs` shapes what this returns
 * into a `coverageGaps` entry — the same degraded-coverage channel
 * `../workspace.mjs`'s `polyglotManifests` already feeds through
 * `pluginGap`, which likewise changes no exit code and no verdict. `files` is
 * the whole list rather than a count, so the JSON envelope carries something
 * a reader can act on and the text face can bound its own rendering
 * (`../report/text.mjs`) without either surface having to trust a number it
 * cannot check.
 *
 * Empty `files` is the answer for a workspace where every analyzable file is
 * owned, and `./check.mjs` contributes no gap entry at all then: a gap that
 * always fires teaches a reader to skip the line it is written on.
 *
 * Workspace-scoped like `unclaimedFileFailures` above, and for the same
 * reason — a `check <path>` must not be able to hide an orphan elsewhere in
 * the tree by naming a path that excludes it.
 *
 * **This list still holds the files the run reads as its own configuration**,
 * and `unownedGapWithoutRunConfiguration` below is what removes them. The
 * split is forced rather than stylistic: `resolvePolicy` needs a resolved
 * `CommandContext` to run, so it runs AFTER this does, and until it has run
 * nothing here knows which law actually governed the run. A `--config`
 * override, a profile name, or an inline policy object all decide that later.
 * Subtracting the DECLARED name here would exclude a file the run never read
 * while listing the one it did — worse than not filtering at all.
 *
 * @param {{tracked: string[], owned: {file: string, project: string}[]}} args
 * @returns {{files: string[], languages: string[]}} `languages` is the sorted
 *   distinct set of languages `files` spans — derived here, beside the filter
 *   that decided the list, so no face can name a language the list does not
 *   contain.
 */
function unownedAnalyzableFiles({ tracked, owned }) {
  const ownedFiles = new Set(owned.map(({ file }) => file));
  const files = tracked.filter((file) => {
    const language = languageOf(file);
    return language !== null && !UNCLAIMED_CHECK_LANGUAGES.has(language) && !ownedFiles.has(file);
  });
  return {
    files,
    languages: [...new Set(files.map((file) => languageOf(file)))].sort(),
  };
}

/**
 * The same gap with the files this run read as its own configuration removed,
 * and the languages recounted over what is left.
 *
 * A file the run read as configuration is not a file the run failed to cover:
 * it is not source judged by the boundary law, it IS the boundary law, and
 * "no verdict covers this file" is vacuous when said of it. The concrete
 * failure without this is worse than vacuous, and
 * `../config-spelling.integration.test.mjs` is what proved it: a law spelled
 * `module-boundaries.config.mjs` and one spelled `law/custom.mjs` produced
 * different reports, so RENAMING THE LAW CHANGED THE VERDICT.
 *
 * It takes the names as arguments rather than reading `CommandContext.options`
 * because the caller is the only layer that knows them. `options.boundaryConfig`
 * is what the workspace DECLARED; the law that actually ran may be a `--config`
 * override or a profile, which `./policy.mjs`'s `resolvePolicy` reports as its
 * workspace-relative `source` — and that resolution cannot happen before
 * `resolveCommandContext`, because it takes the context as an argument.
 *
 * Names are normalised toward the spelling `git ls-files` uses, because that
 * is what `tracked` holds: an `nx.json` may legitimately declare
 * `"./module-boundaries.config.mjs"` or a backslash-separated path, and an
 * unnormalised compare would silently fail to exclude it. An absolute path
 * matches nothing and is left alone — no tracked entry is absolute, so it
 * cannot collide with one.
 *
 * @param {{files: string[], languages: string[]}} gap
 * @param {(string|object|null|undefined)[]} configNames Every name this run
 *   read as configuration. Non-strings are ignored, which is how an inline
 *   policy object (`archkeep.json`'s object form) and an absent profile both
 *   pass through without naming a file.
 * @returns {{files: string[], languages: string[]}}
 */
export function unownedGapWithoutRunConfiguration(gap, configNames) {
  const excluded = new Set(
    configNames
      .filter((name) => typeof name === "string")
      .map((name) => name.replace(/\\/gu, "/").replace(/^\.\//u, "")),
  );
  if (excluded.size === 0) return gap;
  const files = gap.files.filter((file) => !excluded.has(file));
  if (files.length === gap.files.length) return gap;
  return {
    files,
    languages: [...new Set(files.map((file) => languageOf(file)))].sort(),
  };
}

/**
 * Resolves everything a command needs before it can ask its own question:
 * which workspace, which provider, which files, and what analyzing them
 * found.
 *
 * Throws rather than returning a partial context on every condition that
 * would otherwise leave a caller building a verdict over a tree it could not
 * fully read — no workspace root, both markers present, or a requested path
 * outside the workspace or matching no tracked file at all
 * (`../workspace.mjs`'s `selectFiles`). That is the empty-result invariant
 * (`../../../../AGENTS.md`) applied one layer before any command's own
 * report: a context half-built is exactly the silent direction the invariant
 * refuses.
 *
 * @param {{cwd: string, paths?: string[]}} request
 * @param {{readGraph?: Function, listFiles?: Function, readFile?: (path: string) => string|null}} [io]
 *   The seams that reach outside this process — Nx, git, and (on the Nx
 *   branch) the `nx.json` read behind `pluginGap.registered` — injectable for
 *   the same reason `check` always took the first two: a test drives the real
 *   analysis over a fixture tree with none of them touching a real
 *   filesystem or subprocess. `readFile` takes an ALREADY-ABSOLUTE path, the
 *   shape `pluginIsRegistered` (`../options.mjs`) calls its reader with.
 * @returns {CommandContext}
 */
export function resolveCommandContext(
  { cwd, paths = [] },
  { readGraph, listFiles = listTrackedFiles, readFile = readFileAbsolute } = {},
) {
  // All three markers in one walk (`../workspace.mjs`'s `findWorkspaceRoot`), so a
  // native root nested under an unrelated Nx tree — or vice versa — is found
  // from the working directory the same way either alone would be. Which
  // marker(s) the returned directory actually carries is then read back
  // below, because a walk that STOPPED at the first marker it saw could never
  // tell "only archkeep.json here" from "both, one level up".
  const root = findWorkspaceRoot(cwd, WORKSPACE_MARKERS);
  if (root === null) {
    throw new Error(
      `archkeep: no workspace root above ${cwd} — looked for an nx.json, a archkeep.json, or a ` +
        `.moon (or .config/moon) directory in every parent. The tree to judge is found from the working directory, ` +
        `never from this tool's own location: installed from the registry, this tool lives under ` +
        `the consumer's node_modules and the two are always different trees.`,
    );
  }
  // Which provider may judge at all — the one gate
  // (`requireSingleProjectModel` above) every entry point shares, CLI and
  // language server alike. Moon-versus-Moon rides it through `moonMarkerAt`.
  const { hasNative, moonMarker } = requireSingleProjectModel(root);
  const hasMoon = moonMarker !== null;

  // Resolve the default graph reader based on provider: Moon workspaces read
  // their graph from `moon project-graph --json`, Nx workspaces from
  // `nx graph --file=`. The native provider uses a two-call discover/buildGraph
  // contract instead, so it never goes through `readGraph` at all.
  const defaultReadGraph = hasMoon ? moonProvider.readProjectGraph : readProjectGraph;
  const effectiveReadGraph = readGraph ?? defaultReadGraph;

  const tracked = listFiles(root);
  let graph;
  let workspace;
  let owned;
  let options;
  let imports;
  let failures;
  let analyzed;
  let analyzedFiles;
  let pluginGap;
  let unownedGap;
  let unclaimedGap;
  let exemptedFiles;

  if (hasNative) {
    // No `nx graph`, no `nx.json`, and — verified by this branch existing at
    // all — no `nx` needing to be installed: `nativeProvider` is imported
    // from `../providers/native/index.mjs`, which imports nothing from
    // `../providers/nx.mjs` and nothing that resolves the `nx` package.
    const readFile = readWorkspaceRoot(root);
    const discovered = nativeProvider.discover({ root, files: tracked, readFile });
    // A graph with nodes but no dependencies yet — `createWorkspace` only
    // ever reads `data.root` off each node, and dependencies are not known
    // until the import sites below are analyzed against these same projects.
    const preGraph = {
      nodes: Object.fromEntries(
        discovered.projects.map((project) => [
          project.name,
          { name: project.name, data: { root: project.root } },
        ]),
      ),
    };
    ({ workspace, owned } = createWorkspace({
      root,
      graph: preGraph,
      files: tracked,
      tsConfig: discovered.model.tsConfig,
    }));

    // On the Nx path `graph.dependencies` comes from `nx graph`, computed
    // over the WHOLE workspace regardless of `paths`, so scoping only ever
    // narrows which import sites are handed back for reporting. The native
    // path has no such independent source — `nativeProvider.buildGraph`
    // DERIVES `dependencies` from import sites — so analyzing only the
    // requested scope first would drop every project outside it from the
    // dependency graph itself, and a cycle or a transitive violation that
    // only closes once the rest of the tree's imports are counted would go
    // unreported. Every owned file is analyzed here, unconditionally;
    // `selected` below only filters which of the resulting sites are handed
    // back.
    const wholeTreeAnalysis = analyzeWorkspace(
      workspace,
      owned.map(({ file }) => file),
    );
    graph = nativeProvider.buildGraph({
      discovered,
      importSites: wholeTreeAnalysis.imports,
    });
    annotateMFERemotes(graph.nodes, workspace.readFile);
    annotatePackageFacts(graph.nodes, workspace.readFile);

    // `boundaryConfigDeclared` is carried straight off the model rather than
    // re-derived here: `../providers/native/model.mjs`'s
    // `normalizeNativeModel` is the only code that still sees the raw
    // `archkeep.json`, so it is the only place that can answer whether the
    // file named a law. Re-deriving it from `options.boundaryConfig` at this
    // point is exactly the mistake this whole thread exists to undo — a
    // declared name and the convention default are the same string by then.
    options = {
      boundaryConfig: discovered.model.boundaryConfig,
      tsConfig: discovered.model.tsConfig,
      boundaryConfigDeclared: discovered.model.boundaryConfigDeclared,
      ...(typeof discovered.model.boundaryConfig === "string" ? {} : { inline: true }),
    };

    const selected = selectFiles(
      owned.map(({ file }) => file),
      paths,
      { root, cwd, tracked },
    );
    const selectedFiles = new Set(selected);
    imports = wholeTreeAnalysis.imports.filter((site) => selectedFiles.has(site.sourceFile));
    // Unclaimed analyzable files — this branch's own source is native
    // discovery's `discovered.failures` (`../providers/native/coverage.mjs`'s
    // `judgeCoverage`, reached through `nativeProvider.discover` above), which
    // already carries the unclaimed-file list alongside any unparseable-
    // manifest failure. The Nx and Moon branches below have no such discovery
    // step to answer the same question from, so they compute the equivalent
    // list themselves (`unclaimedFileFailures` above) — three different
    // sources feeding the SAME whole-file failure shape a language analyzer
    // produces for an unreadable file, so nothing downstream needs to know
    // which provider found the gap.
    failures = [
      ...wholeTreeAnalysis.failures.filter((failure) => selectedFiles.has(failure.sourceFile)),
      ...discovered.failures,
      // Workspace-scoped on purpose, the same posture the two unclaimed
      // equivalents above hold: a wildcard run must not be able to hide a
      // project whose manifest it cannot read by naming a path that excludes
      // it (`../analysis/python.mjs`'s `pythonUnmodelledFailures`).
      ...pythonUnmodelledFailures(workspace),
      ...mavenManifestFailures(workspace),
      ...gradleManifestFailures(workspace),
      ...dotnetManifestFailures(workspace),
      ...dotnetIndexFailures(workspace),
    ];
    analyzedFiles = wholeTreeAnalysis.analyzedFiles.filter((file) => selectedFiles.has(file));
    analyzed = analyzedFiles.length;
    // Unaffected by `paths`: an exempted file is by definition unowned by any
    // project, so it was never a candidate for `owned`/`selected` in the
    // first place — the same reason `pluginGap` below is a workspace-wide
    // fact rather than a scoped one.
    exemptedFiles = discovered.exempted;

    // There is no Nx plugin registration to be missing on a workspace that
    // has no `nx.json` at all.
    pluginGap = { registered: true, manifests: [] };
    // Nothing to report as a tolerated gap either: native's own coverage
    // judgment already fails on EVERY unclaimed analyzable file, in every
    // language, and those failures are in `discovered.failures` above — the
    // run refuses with exit 3 rather than tolerating them, which is the
    // deliberate difference between this provider and the two below
    // (`../providers/native/coverage.mjs`). Stated rather than left off, for
    // the reason `pluginGap` is: a reader must not have to tell "false" from
    // "this branch forgot".
    unownedGap = { files: [], languages: [] };
    // Same statement one list over: native's unclaimed files are already
    // whole-file failures in `discovered.failures` above, and the policy's
    // `coverage.unowned` channel is refused outright on this provider
    // (`./policy.mjs`'s `resolvePolicy`), so there is nothing here for that
    // channel to match against.
    unclaimedGap = { files: [] };
  } else if (hasMoon) {
    // Moon provider — reads graph from `moon project-graph --json`, the same
    // one-call contract as the Nx path: Moon already resolved projects, tags
    // and edges before this package ever asked. Both option names are
    // convention here, because Moon carries no `plugins[].options` table and
    // a `archkeep.json` beside `.moon/` is refused outright
    // (`../providers/moon.mjs`) — so there is nowhere in a Moon workspace to
    // name either file, and `readMoonOptions` is where they are decided
    // rather than read. `boundaryConfigDeclared: false` therefore states a
    // fact about Moon rather than a fallback, and it is written out rather
    // than left off so the key is present on all three providers: a reader
    // that had to tell "false" from "this branch forgot" would be back to
    // guessing provenance, which is the defect.
    //
    // The two names are NOT symmetrical, which is why this is a call and not
    // a literal. `boundaryConfig` is the default outright. `tsConfig` walks
    // the short ordered chain `MOON_TSCONFIG_CHAIN` — a workspace whose paths
    // table lives in `tsconfig.json` rather than `tsconfig.base.json` was
    // previously judged against a file it does not have, where every aliased
    // import resolves to nothing and the report is a wall of crossings with
    // no line saying the table was never found. `listFiles` is a thunk the
    // chain only calls on the branch that needs it (neither candidate
    // present), so a workspace carrying one pays nothing for the question.
    options = readMoonOptions(root, { listFiles: () => tracked });

    graph = effectiveReadGraph(root);
    ({ workspace, owned } = createWorkspace({
      root,
      graph,
      files: tracked,
      tsConfig: options.tsConfig,
    }));
    annotateMFERemotes(graph.nodes, workspace.readFile);
    annotatePackageFacts(graph.nodes, workspace.readFile);

    // Unlike the Nx path, Moon's own graph carries NO edge this package's own
    // analysis found: `moon project-graph --json` only knows a project
    // depends on another when `moon.yml` says `dependsOn`, because Moon has no
    // plugin hook this package can register the way `../nx.mjs`'s
    // `createDependencies` registers into Nx's own graph computation. A Go,
    // Rust or Python import crossing a project boundary with no hand-written
    // `dependsOn` entry is therefore invisible to `graph.dependencies` and to
    // every verdict computed from it — architecture-intent, drift, cycles,
    // `impact`, `diff` — while `check`'s own import-site rules judge it fine,
    // because those read analysis records directly rather than the graph.
    // Analyzing the whole tree first, before `paths` narrows anything, mirrors
    // the native branch above for the same reason it states there: an edge
    // from a project outside the scoped paths is still part of the graph a
    // cycle or a transitive violation is judged against.
    const wholeTreeAnalysis = analyzeWorkspace(
      workspace,
      owned.map(({ file }) => file),
    );
    const projectOfFile = new Map(owned.map(({ file, project }) => [file, project]));
    // Moon's own graph carries only edges Moon itself resolved (`dependsOn`);
    // the imports this tree writes are folded in here by the same merge the
    // language server's index runs — one implementation
    // (`../providers/moon.mjs`'s `mergeImportEdges`), so the two faces cannot
    // disagree about which edges exist.
    mergeImportEdges(graph, {
      importSites: wholeTreeAnalysis.imports,
      projectOf: (file) => projectOfFile.get(file),
    });

    const selected = selectFiles(
      owned.map(({ file }) => file),
      paths,
      { root, cwd, tracked },
    );
    const selectedFiles = new Set(selected);
    imports = wholeTreeAnalysis.imports.filter((site) => selectedFiles.has(site.sourceFile));
    // Unclaimed analyzable files — `unclaimedFileFailures` above — join the
    // scoped read failures unconditionally, the same workspace-wide posture
    // native's own `discovered.failures` has (this branch's header already
    // analyzes the whole tree before `paths` narrows anything, for the same
    // reason).
    const unclaimedFiles = unclaimedAnalyzableFiles({ tracked, owned });
    failures = [
      ...wholeTreeAnalysis.failures.filter((failure) => selectedFiles.has(failure.sourceFile)),
      ...unclaimedFileFailures({ files: unclaimedFiles, providerLabel: "the Moon project graph" }),
      ...pythonUnmodelledFailures(workspace),
      ...mavenManifestFailures(workspace),
      ...gradleManifestFailures(workspace),
      ...dotnetManifestFailures(workspace),
      ...dotnetIndexFailures(workspace),
    ];
    unclaimedGap = { files: unclaimedFiles };
    analyzedFiles = wholeTreeAnalysis.analyzedFiles.filter((file) => selectedFiles.has(file));
    analyzed = analyzedFiles.length;
    // `coverage.exempt` is a native-only key (`../providers/native/coverage.mjs`'s
    // header: "Nx has no equivalent question") — Moon carries no such list.
    exemptedFiles = [];

    // There is no Nx plugin registration to be missing on a workspace that
    // has no `nx.json` at all.
    pluginGap = { registered: true, manifests: [] };
    // The tolerated half of the same unclaimed-file question the failures
    // above answer for Go, Rust and Python — counted and reported rather than
    // judged (`unownedAnalyzableFiles`).
    unownedGap = unownedAnalyzableFiles({ tracked, owned });
  } else {
    // What this workspace calls the two files whose names are conventions
    // rather than contracts. Read before the graph, because it decides which
    // tsconfig `createWorkspace` resolves paths against.
    const pluginOptions = readPluginOptions(root);
    options = {
      boundaryConfig: pluginOptions.boundaryConfig,
      tsConfig: pluginOptions.tsConfig,
      // Straight off `readPluginOptions`, for the reason the native branch
      // above states: `nx.json`'s `plugins[].options` is the last place the
      // declaration is still distinguishable from `DEFAULT_OPTIONS`.
      boundaryConfigDeclared: pluginOptions.boundaryConfigDeclared,
      ...(pluginOptions.profiles === undefined ? {} : { profiles: pluginOptions.profiles }),
    };

    graph = effectiveReadGraph(root);
    ({ workspace, owned } = createWorkspace({
      root,
      graph,
      files: tracked,
      tsConfig: pluginOptions.tsConfig,
    }));
    // `nx graph --file=` does not carry the Module Federation fact — see
    // `annotateMFERemotes` — so it is computed here, before any rule runs, or
    // every import of a real remote app would be a false `noImportsOfApps`.
    annotateMFERemotes(graph.nodes, workspace.readFile);
    // Nor the two `package.json` facts — `data.entryPoints` and
    // `data.declaredPackages`, see `annotatePackageFacts` — which decide the
    // secondary-entry-point exemptions and `noTransitiveDependencies`.
    annotatePackageFacts(graph.nodes, workspace.readFile);

    const selected = selectFiles(
      owned.map(({ file }) => file),
      paths,
      { root, cwd, tracked },
    );
    ({ imports, failures, analyzed, analyzedFiles } = analyzeWorkspace(workspace, selected));
    // Unclaimed analyzable files — `unclaimedFileFailures` above — join
    // unconditionally, the same workspace-wide posture native's own
    // `discovered.failures` has, so a scoped `check <path>` cannot hide an
    // orphan file elsewhere in the tree by naming a path that excludes it.
    const unclaimedFiles = unclaimedAnalyzableFiles({ tracked, owned });
    failures = [
      ...failures,
      ...unclaimedFileFailures({ files: unclaimedFiles, providerLabel: "the Nx project graph" }),
      ...pythonUnmodelledFailures(workspace),
      ...mavenManifestFailures(workspace),
      ...gradleManifestFailures(workspace),
      ...dotnetManifestFailures(workspace),
      ...dotnetIndexFailures(workspace),
    ];
    unclaimedGap = { files: unclaimedFiles };
    // Same reason as the Moon branch above: `coverage.exempt` is a native-only
    // concept, so an Nx workspace has nothing to report here.
    exemptedFiles = [];

    pluginGap = {
      registered: pluginIsRegistered(root, { readFile }),
      manifests: polyglotManifests(tracked, workspace.projects),
    };
    // Same as the Moon branch above, and computed from `tracked` rather than
    // `selected` for the same reason `unclaimedFileFailures` is.
    unownedGap = unownedAnalyzableFiles({ tracked, owned });
  }

  // `moonMarker` — resolved once at the top, where coexistence was refused —
  // names whichever Moon directory this root actually carries, so diagnostics
  // can name it correctly.
  return {
    root,
    ...workspaceNames(hasMoon, hasNative, moonMarker),
    graph,
    workspace,
    tracked,
    analysis: { imports, failures, analyzed, analyzedFiles, exemptedFiles },
    options,
    pluginGap,
    unownedGap,
    unclaimedGap,
    // Every tracked file that belongs to a project, paired with its project —
    // the ownership map `createWorkspace` already built (`own ./workspace.mjs`).
    // A command that needs to know WHICH project owns a file (the planning
    // context's path→project scoping) reads this rather than re-deriving
    // ownership a second way. Not part of any existing command's consumption.
    owned,
  };
}

/**
 * The provider/marker pair a workspace root carries, derived from marker
 * presence through the one mapping every envelope header must agree on.
 * `resolveCommandContext` reads it for its own context; a caller that needs
 * the identity WITHOUT judging the tree — an envelope header over a run whose
 * analyzed revisions each carry their own contexts (`./evolution.mjs`) —
 * calls `describeWorkspaceRoot`, so the vocabulary ("nx"/"native"/"moon" and
 * the marker that decided it) has exactly one home.
 *
 * @param {boolean} hasMoon Whether a Moon directory marks the root.
 * @param {boolean} hasNative Whether `archkeep.json` marks the root.
 * @param {string|null} moonMarker Which Moon directory is present.
 * @returns {{provider: "nx" | "moon" | "native", marker: string}}
 */
function workspaceNames(hasMoon, hasNative, moonMarker) {
  return {
    provider: hasMoon ? "moon" : hasNative ? "native" : "nx",
    marker: hasMoon ? moonMarker : hasNative ? ARCHKEEP_MODEL_FILE : NX_CONFIG_FILE,
  };
}

/**
 * The workspace identity of `root` — which project model governs it and which
 * marker decided that — without reading one source file or building one graph.
 * The single-project-model gate runs here exactly as it does in
 * `resolveCommandContext`: both markers present is refused here for the same
 * reason it is refused there, because a caller about to describe this
 * workspace must not name a model the full read would have refused.
 *
 * @param {string} root Absolute path to the workspace root.
 * @returns {{provider: "nx" | "moon" | "native", marker: string}}
 * @throws {Error} when more than one project-model marker is present
 *   (`requireSingleProjectModel`).
 */
export function describeWorkspaceRoot(root) {
  const { hasNative, moonMarker } = requireSingleProjectModel(root);
  return workspaceNames(moonMarker !== null, hasNative, moonMarker);
}

// Re-exported so a caller that only needs "does this tree look like a
// workspace at all" (`../../cli.mjs`'s `optionsForUsage`) is not forced to
// duplicate the marker check a second time; `DEFAULT_OPTIONS` rides along for
// the same reason, since the two are always read together there.
export { DEFAULT_OPTIONS };
