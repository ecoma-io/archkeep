/**
 * The language server itself: lifecycle, document store, and the one place
 * diagnostics are allowed to leave the process.
 *
 * Transport-free on purpose. It is handed a `send` and an `exit` and never
 * touches a stream, so the whole protocol conversation can be driven in a test
 * without a subprocess — while `../../lsp.mjs`, which owns the stdio wiring,
 * stays small enough to read in one screen.
 *
 * ## Why a language server and not an ESLint plugin
 *
 * An ESLint plugin reaches what ESLint can parse, and in this workspace that is
 * JS, TS and `.vue` — the root `eslint.config.mjs` hands the last one
 * `vue-eslint-parser` and states the boundary rule in a block with no `files`
 * filter, so `@nx/enforce-module-boundaries` judges a single-file component
 * too. Measured: both engines report the same crossing for the same `.vue`
 * import, differing only in the column they point at.
 *
 * Go, Rust and Python have no ESLint parser at all — `eslint` answers "File
 * ignored because no matching configuration was supplied" and the project's
 * `lint` target exits 0 over a violating import (`../../AGENTS.md`). So this
 * server is the ONLY enforcement those three have, and for JS, TS and Vue it
 * is a second opinion that `../conformance/` holds to the same verdict. One
 * protocol every editor speaks serves all of them at once.
 *
 * ## The rule that governs every path through this file
 *
 * A published empty diagnostic list is a statement: "this file is clean". It is
 * made in exactly two places, and both are named — `publishDiagnostics` after
 * `diagnoseDocument` reported `analyzed: true`, and `clearDiagnostics` when a
 * document closes and its markers must go. Nothing else may publish an empty
 * list, and `publishDiagnostics` re-checks the invariant rather than trusting
 * the caller of `diagnoseDocument` to have honoured it.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, posix, relative, sep } from "node:path";

import { DEFAULT_OPTIONS, NX_CONFIG_FILE, readPluginOptions } from "../options.mjs";
import { LATTICE_MODEL_FILE, loadNativeModel } from "../providers/native/model.mjs";

import { readBoundaryConfig } from "./boundary-config.mjs";
import { analysisFailedDiagnostic, documentLines } from "./diagnostics.mjs";
import { diagnoseDocument } from "./diagnose.mjs";
import {
  ERROR_CODES,
  MESSAGE_TYPE,
  SERVER_INFO,
  TEXT_DOCUMENT_SYNC_KIND,
  uriToPath,
} from "./protocol.mjs";
import { buildWorkspaceIndex, PROJECT_CONFIG_FILE, readWorkspaceFile } from "./workspace-index.mjs";

/**
 * A project's own `package.json`, and the two spellings of its Module
 * Federation config — the per-project files `../workspace.mjs` reads for the
 * three graph fields that WAIVE a violation.
 *
 * The names are that module's, not new ones: `annotatePackageFacts` reads the
 * first, and `projectIsMFERemote` reads `module-federation.config.js` with the
 * `.ts` spelling as its fallback, in that order and with upstream's own
 * precedence. They are written out here because `watchedFilesFor` below needs
 * the NAMES rather than the readings, and `../workspace.mjs` exports no
 * constant for either — a reader changing one of those filenames has to change
 * this list too, or the file stops being watched while it keeps being read.
 */
const PACKAGE_MANIFEST_FILE = "package.json";
const MFE_CONFIG_FILES = Object.freeze([
  "module-federation.config.js",
  "module-federation.config.ts",
]);

/**
 * The files whose content changes the verdict for files that did not change,
 * given the options this session resolved.
 *
 * Derived rather than constant, and that is the whole point of the function: the
 * boundary config's filename is a per-workspace option now, and a watcher list
 * fixed at module load would keep watching `module-boundaries.config.mjs` in a
 * workspace that renamed it. Editing the real config would then change nothing
 * on screen — every open file would keep showing a verdict from the config as it
 * was when the editor opened, which is the silent-stale failure this server's
 * whole revision mechanism exists to prevent.
 *
 * `nx.json` is here for the same reason one step further out: it is where the
 * options themselves live, so a change to it can rename the config file. A
 * server watching only the file the OLD options named would go on watching a
 * filename the workspace stopped using. `lattice.json` is watched for the
 * same reason on the native side: `readWorkspaceOptions` below reads its
 * `boundaryConfig`/`tsConfig` fields directly (`../providers/native/model.mjs`
 * — a native root has no `nx.json` `plugins` table to nest them under), so an
 * edit to either can rename the config the same way an `nx.json` edit can.
 *
 * `options.tsConfig` is here for the same argument one step further in: every
 * TypeScript verdict is resolved against the compiler options that file names,
 * so a `paths` edit there changes verdicts for files that did not change — and
 * a server not watching it keeps showing the old verdict until an unrelated
 * invalidation happens to re-read it. Same derivation seam as `boundaryConfig`:
 * the name is an option, so the watched set is derived from the resolved
 * options rather than fixed at module load.
 *
 * `package.json` and the two `module-federation.config` spellings are here for
 * that same argument one step further in again, and in the direction that
 * matters most: each of them decides a verdict for files that did not change,
 * and each decides it by WAIVING. `../workspace.mjs`'s `annotatePackageFacts`
 * reads a project's `package.json` for `data.entryPoints` (the secondary
 * entry-point exemption) and `data.declaredPackages` (what waives
 * `noTransitiveDependencies`), and its `projectIsMFERemote` reads the Module
 * Federation config for `data.mfeRemote` (the `noImportsOfApps` exemption —
 * `../rules/index.mjs`). Delete that config, or drop a dependency from a
 * `package.json`, and the violation those facts were waiving is real now —
 * while a server not watching either file has no way to learn it: only a
 * watched-file change bumps the revision, and every publish until then reads
 * the annotations cached against the old one. The stale waiver then publishes
 * `[]` for a real violation for the rest of the session, which is the silent
 * direction exactly (`../../../../AGENTS.md`). `package.json` earns the entry a
 * second way as well: it is where `./workspace-index.mjs`'s `discoverProjects`
 * takes a project's NAME when its `project.json` states none, so an edit to it
 * can move a project in the graph and not only waive something in it.
 *
 * Those three are PER-PROJECT paths rather than workspace-root singletons, and
 * they need no new mechanism for it: `registerFileWatchers` gives every entry
 * the glob `**\/<entry>` and `touchesWatchedFile` matches the same reach — an
 * exact workspace-relative match, or a path ending in `/<entry>` — which is
 * what already lets a `project.json` at any depth invalidate. That reach is
 * also the cost, and it is not free: `**\/package.json` matches every manifest
 * under `node_modules` too, so on a large workspace an install can fire a burst
 * of notifications, each one dropping the index and re-analyzing the tree.
 * That cost is LOUD — a slow editor, for as long as the install runs — and the
 * failure it buys out is silent, which is the trade the two unequal error
 * directions settle. Narrowing the glob to the project roots the index happens
 * to know would trade it straight back: the project added after that
 * registration is then the one nothing watches.
 *
 * An INLINE policy contributes no entry of its own, and needs none: the law is
 * then a field on `lattice.json`, which the list already carries
 * unconditionally, so an edit to it invalidates through that entry. Spreading
 * the object in instead would produce the glob `**\/[object Object]` — one
 * that matches no file ever, while reading in the registration like a watched
 * law. The file carrying the law would look covered and no notification would
 * arrive: the silent direction, in the one list whose whole job is noticing
 * that the law moved.
 *
 * @param {{boundaryConfig: string|object, tsConfig: string}} options The session's resolved options.
 * @returns {readonly string[]}
 */
export function watchedFilesFor(options) {
  return Object.freeze([
    ...(typeof options.boundaryConfig === "string" ? [options.boundaryConfig] : []),
    options.tsConfig,
    PROJECT_CONFIG_FILE,
    NX_CONFIG_FILE,
    LATTICE_MODEL_FILE,
    PACKAGE_MANIFEST_FILE,
    ...MFE_CONFIG_FILES,
  ]);
}

/**
 * The two facts that decide which project-model provider a workspace root's
 * options are read from: does it carry `nx.json`, `lattice.json`, or — a
 * state `readWorkspaceOptions` below refuses — both.
 *
 * Mirrors `../../cli.mjs`'s own `markersAt`, not imported from it: that
 * module is an executable entry point, not a library this one may depend on,
 * and the check itself is two `existsSync` calls — cheap enough that a
 * second, independent copy costs less than a new coupling between the two
 * faces would.
 *
 * @param {string} root
 * @returns {{hasNx: boolean, hasNative: boolean}}
 */
function markersAt(root) {
  return {
    hasNx: existsSync(join(root, NX_CONFIG_FILE)),
    hasNative: existsSync(join(root, LATTICE_MODEL_FILE)),
  };
}

/**
 * The resolved options for a workspace root, read from whichever marker file
 * it actually carries — the same choice `../../cli.mjs`'s `check` makes, so
 * the CLI and the editor never disagree about which config filenames a given
 * workspace uses.
 *
 * A native root's `boundaryConfig`/`tsConfig` live on `lattice.json` itself
 * (`../providers/native/model.mjs`'s `loadNativeModel`) rather than under an
 * `nx.json` `plugins` table it does not have, so `readPluginOptions` — which
 * only ever reads `nx.json` — would silently return the defaults for a
 * native workspace that renamed either file. A root carrying both markers is
 * refused outright, the same refusal `check` makes: which project model to
 * judge against is a decision nobody made, not one this server can make for
 * them by picking a provider.
 *
 * `boundaryConfig` can also be an inline policy OBJECT rather than a filename
 * (`../providers/native/model.mjs`'s doc comment on `findNativeModelViolations`,
 * "boundaryConfig"; `../../../../docs/reference/policy-schema.md`, "An inline policy, for
 * lattice.json"), and that object is returned as-is for the two places
 * downstream that know what to do with it: `watchedFilesFor` omits it and
 * leans on the `lattice.json` entry it already has, and
 * `./boundary-config.mjs` validates it instead of reading a file. Both are
 * argued where they are implemented. What makes the pair sound is that this
 * function is called again on every invalidation: the object it returns is
 * whatever `lattice.json` says NOW, so an edit to an inline law re-diagnoses
 * exactly like an edit to a law in its own file.
 *
 * @param {string} root
 * @returns {{boundaryConfig: string|object, tsConfig: string}}
 * @throws {Error} when both markers are present, the marker present is
 *   unreadable or malformed, or an Nx root's options name a `profiles`
 *   registry — a profile NAME is not a file this server could watch or parse.
 */
export function readWorkspaceOptions(root) {
  const { hasNx, hasNative } = markersAt(root);
  if (hasNx && hasNative) {
    throw new Error(
      `lattice: ${root} declares both nx.json and lattice.json — this server judges a ` +
        `workspace against exactly one project model, the same refusal ../../cli.mjs's check ` +
        `makes, and a tree carrying both is a decision nobody made rather than one this tool ` +
        `can make for them. Remove whichever one is not the workspace's real source of truth ` +
        `for projects and tags.`,
    );
  }
  if (hasNative) {
    const model = loadNativeModel(root, { readFile: (path) => readWorkspaceFile(root, path) });
    return { boundaryConfig: model.boundaryConfig, tsConfig: model.tsConfig };
  }
  const options = readPluginOptions(root);
  if (typeof options.profiles === "string") {
    throw new Error(
      `lattice: ${root}'s nx.json options name a profiles registry (${options.profiles}) — a ` +
        `valid form (../../cli.mjs's check resolves a policy by profile name from it), but not ` +
        `one this language server can load yet: it only ever reads a policy FILE, and a profile ` +
        `name is a selector, not a path it could watch or parse. Enforce by file instead — ` +
        `remove the profiles option, or point boundaryConfig at an .mjs or .json file — see ` +
        `../../../../docs/concepts/profiles.md.`,
    );
  }
  return options;
}

/**
 * The id both `client/registerCapability` and its matching unregister use. One
 * constant because they have to be the same string: an unregister naming
 * anything else leaves the old watcher in place, and the client then watches two
 * sets at once.
 */
const WATCHER_REGISTRATION_ID = "lattice/watched-files";

/**
 * What `initialize` promises. Every entry is something the server answers.
 *
 * `change` is `full`: the client re-sends the whole document and the server
 * re-analyzes it. Incremental sync is not advertised because it is not
 * implemented, and a server that advertised it and then mis-applied one ranged
 * edit would put every later diagnostic on the wrong line — see
 * `./protocol.mjs`.
 *
 * `save.includeText` is `false`: the server already holds the buffer the editor
 * is showing, and re-reading the saved bytes would answer about a different
 * text than the one on screen.
 */
export const SERVER_CAPABILITIES = Object.freeze({
  textDocumentSync: Object.freeze({
    openClose: true,
    change: TEXT_DOCUMENT_SYNC_KIND.full,
    save: Object.freeze({ includeText: false }),
  }),
});

/** POSIX-relative path of `absolutePath` inside `root`, or `null` when outside. */
function workspaceRelative(root, absolutePath) {
  const rel = relative(root, absolutePath).split(sep).join(posix.sep);
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return null;
  return rel;
}

/**
 * Creates a server instance.
 *
 * @param {object} options
 * @param {(message: object) => void} options.send Writes one JSON-RPC message
 *   to the client.
 * @param {(code: number) => void} options.exit Ends the process. Injected so a
 *   test can observe the exit code instead of losing its own runner to it.
 * @param {(text: string) => void} [options.log] Diagnostics about the server
 *   itself. Never stdout: stdout carries the protocol, and one stray line there
 *   desynchronises the stream for the rest of the session.
 * @param {(options: object) => object} [options.buildIndex] Injected for tests.
 * @param {(root: string, revision: number, boundaryConfig: string) => Promise<object>} [options.readConfig] Injected for tests.
 * @param {(root: string) => object} [options.readOptions] Injected for tests.
 * @returns {{handle: (message: object) => Promise<void>}}
 */
export function createServer({
  send,
  exit,
  log = () => {},
  buildIndex = buildWorkspaceIndex,
  readConfig = readBoundaryConfig,
  readOptions = readWorkspaceOptions,
}) {
  /** `starting` → `running` → `shuttingDown`. `exit` ends it from any of them. */
  let phase = "starting";
  let root = null;
  /**
   * The session's resolved plugin options, and — when `nx.json` could not be
   * read or declared a bad one — the reason, published to every open document.
   *
   * The fallback is the DEFAULTS rather than nothing, and only for deciding what
   * to WATCH: a session that watched no files could never notice the `nx.json`
   * fix that would end the failure, so it would stay broken until the editor
   * restarted. Nothing is ever diagnosed from these defaults — `currentResources`
   * refuses while `optionsFailure` is set.
   */
  let options = { ...DEFAULT_OPTIONS };
  let optionsFailure = null;
  let shutdownRequested = false;
  /** Bumped whenever something the verdict depends on changed on disk. */
  let revision = 0;
  /** `{revision, promise}`; the promise always RESOLVES, to an ok/error record. */
  let resources = null;
  /** Outgoing request ids, kept apart from the client's id space. */
  let outgoingId = 0;
  /** Whether the client can be asked to watch files, learned at `initialize`. */
  let clientSupportsFileWatching = false;
  /** The globs the client is currently registered for; `null` before the first. */
  let registeredGlobs = null;
  const documents = new Map();

  const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
  const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

  /**
   * The index and config for the current revision, as an ok/error record rather
   * than a rejected promise: a rejection cached across every open document
   * would surface as an unhandled rejection long after the message that caused
   * it, and the reason would be published to the developer anyway.
   */
  function currentResources() {
    if (resources?.revision === revision) return resources.promise;
    const at = revision;
    const promise = (async () => {
      // An unreadable `nx.json` is refused here rather than absorbed, because
      // the options decide which file the law is read FROM: continuing on the
      // defaults would diagnose every open document against a config the
      // workspace may not use, and publish those verdicts as though they were
      // the workspace's own.
      if (optionsFailure !== null) throw new Error(optionsFailure);
      const [index, config] = await Promise.all([
        // `tsConfig` goes into the index because the index owns the workspace
        // object the analyzer caches against; a rename therefore arrives with
        // the rebuilt index rather than needing a second invalidation path.
        Promise.resolve().then(() => buildIndex({ root, tsConfig: options.tsConfig })),
        readConfig(root, at, options.boundaryConfig),
      ]);
      return { ok: true, index, config };
    })().catch((cause) => ({ ok: false, reason: cause?.message ?? String(cause) }));
    resources = { revision: at, promise };
    return promise;
  }

  /**
   * Re-reads the plugin options for the current root.
   *
   * Called at `initialize` and again whenever `nx.json` changes, because a
   * change there can rename the config file — and a server still watching the
   * old name would never see the next edit to the new one.
   */
  function refreshOptions() {
    try {
      options = readOptions(root);
      optionsFailure = null;
    } catch (cause) {
      // The defaults are restored so the watcher list stays well-formed and
      // `nx.json` keeps being watched; `optionsFailure` is what stops anything
      // being diagnosed from them.
      options = { ...DEFAULT_OPTIONS };
      optionsFailure = cause?.message ?? String(cause);
      log(`lattice: ${optionsFailure}`);
    }
  }

  /**
   * Publishes the verdict for one open document.
   *
   * The invariant check below is not defensive programming for its own sake. It
   * is the second of the two guards described in this file's header: if any
   * future edit to `diagnoseDocument` ever returns `analyzed: false` with
   * nothing to show, this turns that bug into a visible diagnostic instead of
   * into a file the editor paints clean.
   */
  async function publishDiagnostics(uri) {
    const document = documents.get(uri);
    if (!document) return;
    const lines = documentLines(document.text);

    const outcome = await diagnoseFor(document, lines);
    let diagnostics = outcome.diagnostics;
    if (!outcome.analyzed && diagnostics.length === 0) {
      diagnostics = [
        analysisFailedDiagnostic(
          "the analysis reported that it did not complete, but produced nothing to show. " +
            "Publishing this rather than an empty list, which would read as a clean file",
          lines,
        ),
      ];
    }
    notify("textDocument/publishDiagnostics", { uri, diagnostics, version: document.version });
  }

  /** The diagnosis for one document, with every failure turned into something to show. */
  async function diagnoseFor(document, lines) {
    if (document.unavailable !== null) {
      return {
        analyzed: false,
        diagnostics: [analysisFailedDiagnostic(document.unavailable, lines)],
      };
    }
    const loaded = await currentResources();
    if (!loaded.ok) {
      return { analyzed: false, diagnostics: [analysisFailedDiagnostic(loaded.reason, lines)] };
    }
    return diagnoseDocument({
      sourceFile: document.sourceFile,
      text: document.text,
      index: loaded.index,
      config: loaded.config,
    });
  }

  /**
   * Removes the markers for a document that is no longer open.
   *
   * The one deliberate empty publish. It is a different statement from "this
   * file is clean" — it says "I no longer speak for this file" — and it is
   * spelled as its own function so it can never be reached by falling through
   * the diagnosis path.
   */
  function clearDiagnostics(uri) {
    notify("textDocument/publishDiagnostics", { uri, diagnostics: [] });
  }

  /**
   * Drops the cached index and config and re-diagnoses every open document.
   *
   * Reached whenever the constraint table or the project list moved: every open
   * file's verdict was computed against a tree that no longer exists, and
   * leaving those markers up shows a verdict from a config that has been
   * deleted — which is the same lie as showing no marker at all, told the other
   * way round.
   */
  async function invalidateAndRepublish() {
    revision += 1;
    resources = null;
    // Re-read before re-diagnosing: the change may have BEEN the options, and
    // diagnosing first would answer one more time from the config the old
    // options named.
    refreshOptions();
    log(`lattice: ${watchedFilesFor(options).join("/")} changed; re-diagnosing open documents`);
    // The watched set is derived from the options that may just have changed, so
    // the client's registration is re-checked before anything is re-diagnosed.
    // Cheap when nothing moved: `registerFileWatchers` compares the globs and
    // returns.
    registerFileWatchers();
    for (const uri of documents.keys()) await publishDiagnostics(uri);
  }

  /**
   * Records an open document, and — where it cannot be judged at all — WHY.
   *
   * `unavailable` is a sentence rather than a flag because it is published
   * verbatim. A URI naming no file on disk and a file outside the workspace are
   * different mistakes with different fixes, and telling a developer only that
   * "something is wrong" costs them the diagnosis this server just made.
   */
  function openDocument({ uri, text, version }) {
    const path = uriToPath(uri);
    const sourceFile = path === null ? null : workspaceRelative(root, path);
    const textMissing = typeof text !== "string";
    documents.set(uri, {
      uri,
      text: textMissing ? "" : text,
      version: version ?? null,
      sourceFile,
      unavailable: textMissing
        ? `'${uri}' opened without any text, so its contents are unknown here — ` +
          `analyzing the empty string this buffer would otherwise stand in for would ` +
          `report a verdict about a file the server never saw`
        : path === null
          ? `'${uri}' names no file on disk — an untitled buffer or a virtual document — ` +
            `so no project owns it and no boundary rule can be applied to it`
          : sourceFile === null
            ? `this file is outside the workspace root the server was initialized with (${root}), ` +
              `so no project owns it and no constraint applies to it`
            : null,
    });
  }

  async function handleInitialize(id, params) {
    if (phase !== "starting") {
      return fail(id, ERROR_CODES.invalidRequest, "lattice: already initialized");
    }
    // Precedence is the protocol's own, newest field first, with an explicit
    // override ahead of all of them: an editor rooted at a subdirectory of the
    // workspace would otherwise find no `module-boundaries.config.mjs` and no
    // projects, and report every file clean for the best of reasons.
    const optionRoot = params?.initializationOptions?.workspaceRoot;
    root =
      (typeof optionRoot === "string" && optionRoot !== "" ? optionRoot : null) ??
      uriToPath(params?.workspaceFolders?.[0]?.uri) ??
      uriToPath(params?.rootUri) ??
      (typeof params?.rootPath === "string" ? params.rootPath : null) ??
      process.cwd();
    phase = "running";
    refreshOptions();
    // The always-on marker for an unreadable options state. Every open document
    // gets the reason on its diagnostics, but a session with no document open
    // yet — the editor pane on first launch — would otherwise show nothing at
    // all, and a session that quietly stays empty is indistinguishable from one
    // that is healthy. One `window/showMessage`, at the moment the failure is
    // known, marks the session for the whole of its life; the per-document
    // diagnostics then keep the marker in front of every open file.
    if (optionsFailure !== null) {
      notify("window/showMessage", { type: MESSAGE_TYPE.error, message: optionsFailure });
    }
    clientSupportsFileWatching =
      params?.capabilities?.workspace?.didChangeWatchedFiles?.dynamicRegistration === true;
    log(`lattice: language server initialized for ${root}`);
    reply(id, { capabilities: SERVER_CAPABILITIES, serverInfo: SERVER_INFO });
  }

  /**
   * Asks the client to watch the files a verdict depends on.
   *
   * Only sent when the client said it supports dynamic registration, because
   * that is the only way to ask: a client that watches nothing simply never
   * sends `workspace/didChangeWatchedFiles`, and the server keeps answering
   * from the config it read at startup until a document is saved. That is a
   * real limitation of such a client, not a fallback this server can implement.
   *
   * Re-sent when the watched set changes, which it can: `nx.json`'s
   * `boundaryConfig` names one of these files, so editing it retires one glob
   * and adds another. The stale registration is unregistered first, under the
   * fixed id both calls use — a client left holding both would go on reporting
   * a filename this workspace no longer reads, and would report the new one
   * nowhere at all.
   */
  function registerFileWatchers() {
    const globs = watchedFilesFor(options).map((file) => `**/${file}`);
    if (!clientSupportsFileWatching) {
      log(
        "lattice: the client does not support dynamic file watching, so a change to " +
          `${watchedFilesFor(options).join(" or ")} will not re-diagnose open files on its own`,
      );
      return;
    }
    if (registeredGlobs !== null) {
      // Same list, same registration — re-sending it would leave the client with
      // two watchers for every glob and this server with two notifications per
      // edit.
      if (
        registeredGlobs.length === globs.length &&
        registeredGlobs.every((glob, index) => glob === globs[index])
      ) {
        return;
      }
      send({
        jsonrpc: "2.0",
        id: `lattice/${++outgoingId}`,
        method: "client/unregisterCapability",
        params: {
          unregisterations: [
            { id: WATCHER_REGISTRATION_ID, method: "workspace/didChangeWatchedFiles" },
          ],
        },
      });
    }
    registeredGlobs = globs;
    send({
      jsonrpc: "2.0",
      id: `lattice/${++outgoingId}`,
      method: "client/registerCapability",
      params: {
        registrations: [
          {
            id: WATCHER_REGISTRATION_ID,
            method: "workspace/didChangeWatchedFiles",
            registerOptions: {
              watchers: globs.map((globPattern) => ({ globPattern })),
            },
          },
        ],
      },
    });
  }

  /**
   * Did any of these changes touch a file the verdict depends on?
   *
   * Matched against the workspace-relative path, not the basename: a watched
   * entry can legitimately carry directory components of its own (a
   * `boundaryConfig` of `configs/boundaries.mjs`, `registerFileWatchers`
   * turning it into the glob `**\/configs/boundaries.mjs`), and a bare
   * basename comparison never equals that entry no matter how the real file
   * changes — the watcher registration would look correct while an edit to
   * that exact file silently never re-diagnosed anything. The comparison
   * below mirrors the glob it registered: an exact match on the
   * workspace-relative path, or that path ending with `/` + the watched
   * entry, which is what `**\/entry` means for a path at any depth — the
   * same reach a flat entry (`project.json`, `nx.json`) needs to keep, since
   * those legitimately live at any depth in the tree.
   */
  function touchesWatchedFile(changes) {
    const watched = watchedFilesFor(options);
    return (changes ?? []).some((change) => {
      const path = uriToPath(change?.uri);
      if (path === null) return false;
      const rel = workspaceRelative(root, path);
      if (rel === null) return false;
      return watched.some((entry) => rel === entry || rel.endsWith(`/${entry}`));
    });
  }

  async function dispatch(message) {
    const { id, method, params } = message ?? {};
    const isRequest = id !== undefined && id !== null;

    // A response to one of this server's own requests — `client/registerCapability`
    // is the only one it sends. Nothing is owed, and answering it would put a
    // reply to a reply on the wire.
    if (method === undefined && isRequest) return;

    if (method === "exit") {
      exit(shutdownRequested ? 0 : 1);
      return;
    }

    if (phase === "shuttingDown") {
      // The specification is explicit: after `shutdown`, a request errors and a
      // notification is ignored. Answering normally would let a client keep
      // using a server that has already released its state.
      if (isRequest) {
        fail(
          id,
          ERROR_CODES.invalidRequest,
          `lattice: '${method}' arrived after shutdown; the server is no longer serving requests`,
        );
      }
      return;
    }

    if (method === "initialize") {
      if (isRequest) await handleInitialize(id, params);
      return;
    }

    if (phase === "starting") {
      if (isRequest) {
        fail(
          id,
          ERROR_CODES.serverNotInitialized,
          `lattice: '${method}' arrived before 'initialize'`,
        );
      }
      return;
    }

    switch (method) {
      case "initialized":
        registerFileWatchers();
        return;

      case "shutdown":
        phase = "shuttingDown";
        shutdownRequested = true;
        documents.clear();
        resources = null;
        if (isRequest) reply(id, null);
        return;

      case "textDocument/didOpen": {
        const doc = params?.textDocument;
        openDocument({ uri: doc?.uri, text: doc?.text, version: doc?.version });
        await publishDiagnostics(doc?.uri);
        return;
      }

      case "textDocument/didChange": {
        const uri = params?.textDocument?.uri;
        const document = documents.get(uri);
        if (!document) return;
        const changes = params?.contentChanges ?? [];
        // Full sync is what this server advertised, so the last change with no
        // `range` is meant to be the whole document. A ranged change means the
        // client ignored the advertised sync kind; the stored text would then
        // be a fiction and every position computed from it would be wrong, so
        // the document is marked unanalyzable rather than analyzed from a text
        // the server only thinks it has.
        //
        // The search for that "last full change" has to keep looking past it
        // for anything ranged that follows: LSP applies `contentChanges`
        // sequentially, so a ranged edit ordered AFTER the last full change is
        // still part of the true final text, and treating the full change as
        // the whole document would silently drop it — analyzing text this
        // server does not actually have and publishing a verdict about it, the
        // third, unnamed place an empty list would otherwise leave the
        // workspace. A mixed batch is the same misbehaving-client case as a
        // purely incremental one, not a third, quieter outcome.
        let lastFullIndex = -1;
        for (let i = changes.length - 1; i >= 0; i -= 1) {
          if (changes[i]?.range === undefined) {
            lastFullIndex = i;
            break;
          }
        }
        const full = lastFullIndex === -1 ? undefined : changes[lastFullIndex];
        const trailingRanged =
          lastFullIndex !== -1 &&
          changes.slice(lastFullIndex + 1).some((change) => change?.range !== undefined);
        if (full === undefined) {
          document.unavailable =
            `this buffer arrived as an incremental change, but the server advertised full ` +
            `text synchronisation — its contents are unknown here, so every position this ` +
            `server could report about it would be a guess`;
          log(
            `lattice: ${uri} arrived as an incremental change, but the server ` +
              `advertised full text synchronisation; its contents are now unknown`,
          );
        } else if (trailingRanged) {
          document.unavailable =
            `this buffer's change batch carried a full-document change followed by a ranged ` +
            `one — LSP applies contentChanges sequentially, so the true final text includes ` +
            `that trailing edit, and this server advertised full text synchronisation only, ` +
            `so its contents are unknown here rather than the pre-edit text the full change ` +
            `alone would produce`;
          log(
            `lattice: ${uri} arrived with a full change followed by a ranged one; ` +
              `its contents are now unknown`,
          );
        } else if (typeof full.text !== "string") {
          // `contentChanges: [{}]` — a full change carrying no text. The empty
          // string it would otherwise fall back to is not the file's contents
          // but the ABSENCE of a statement about them, and analyzing that as
          // the file would publish a verdict about text the buffer does not
          // have. Same class as the incremental branch above: mark it
          // unanalyzable, loudly, rather than analyze a fiction.
          document.unavailable =
            `this buffer's latest full change carried no text, so its contents are unknown ` +
            `here — a change that was meant to replace the whole document arrived empty, and ` +
            `every position this server could report about it would be a guess`;
          log(
            `lattice: ${uri} arrived with a full change carrying no text; ` +
              `its contents are now unknown`,
          );
        } else {
          // The one path that RESUMES a verdict: a real full change replaces the
          // text, which is exactly the situation an earlier `unavailable` reason
          // stopped applying to. Only a document whose file exists in the
          // workspace is resumable, though — the untitled-buffer and
          // outside-workspace reasons are structural, fixed by no text change,
          // and clearing them would let a `sourceFile === null` document reach
          // diagnosis and publish a verdict no project owns.
          document.text = full.text;
          if (document.sourceFile !== null) document.unavailable = null;
        }
        document.version = params?.textDocument?.version ?? document.version;
        await publishDiagnostics(uri);
        return;
      }

      case "textDocument/didSave":
        // Saving one of the two files a verdict depends on invalidates every
        // OTHER file's verdict too. A client that watches files reports the
        // same change through `didChangeWatchedFiles`, and re-diagnosing twice
        // costs one index build; a client that cannot watch gets the reload it
        // would otherwise never get, as long as the change was made in the
        // editor rather than beside it.
        if (touchesWatchedFile([{ uri: params?.textDocument?.uri }])) {
          await invalidateAndRepublish();
          return;
        }
        await publishDiagnostics(params?.textDocument?.uri);
        return;

      case "textDocument/didClose": {
        const uri = params?.textDocument?.uri;
        if (documents.delete(uri)) clearDiagnostics(uri);
        return;
      }

      case "workspace/didChangeWatchedFiles":
        if (!touchesWatchedFile(params?.changes)) return;
        await invalidateAndRepublish();
        return;

      default:
        if (isRequest) {
          fail(
            id,
            ERROR_CODES.methodNotFound,
            `lattice: '${method}' is not implemented. This server publishes boundary ` +
              `diagnostics over ${Object.keys(SERVER_CAPABILITIES).join(", ")} and answers nothing else.`,
          );
        }
    }
  }

  // One message at a time, in arrival order. Diagnosing is asynchronous, and
  // two overlapping runs would race to publish for the same URI — the editor
  // would then show whichever finished last, which is not necessarily the one
  // computed from the newest text.
  let queue = Promise.resolve();

  return {
    handle(message) {
      queue = queue
        .then(() => dispatch(message))
        .catch((cause) => {
          log(`lattice: ${cause?.stack ?? cause}`);
        });
      return queue;
    },
  };
}
