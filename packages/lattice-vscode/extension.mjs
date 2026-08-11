/**
 * The activation entry — the VS Code wiring, and nothing else.
 *
 * This file is the only one in the package allowed to import `vscode` or the
 * language client. It is the same split `lsp.mjs` makes in the server package,
 * for the same reason and with the same consequence: everything with a decision
 * in it lives under `src/`, where a test can drive it without an editor, and
 * what is left here is wiring that in-process coverage could never see anyway.
 * `vitest.config.mjs` excludes this file on exactly that ground.
 *
 * It is `.mjs` because the whole repository is, and because the Node extension
 * host has loaded ESM extensions since VS Code 1.100 — a module is treated as
 * ESM when it carries the `.mjs` suffix or its package declares
 * `"type": "module"`. Both are true here. That is also why `engines.vscode` is
 * `^1.100.0` and cannot be lowered: on an older host this file does not load at
 * all.
 */

import {
  commands,
  languages,
  LanguageStatusSeverity,
  RelativePattern,
  window,
  workspace,
} from "vscode";
// A default import, destructured, rather than named imports. The language
// client is published as CommonJS; a default import of a CommonJS module is
// `module.exports` under every Node version, whereas named imports depend on
// Node's static analysis of the compiled file finding re-exported bindings. One
// of those two is a guarantee and the other is an inference.
import languageClient from "vscode-languageclient/node";

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { documentSelector, ROUTED_EXTENSIONS } from "./src/languages.mjs";
import { findNxRoot } from "./src/workspace-root.mjs";
import { locateServer, SERVER_PACKAGE } from "./src/server-module.mjs";
import { planSession } from "./src/session.mjs";
import { describeStatus } from "./src/status.mjs";

const { LanguageClient, RevealOutputChannelOn, State, TransportKind } = languageClient;

const SEVERITY = {
  information: LanguageStatusSeverity.Information,
  warning: LanguageStatusSeverity.Warning,
  error: LanguageStatusSeverity.Error,
};

/** Write one description onto a status item, mapping the severity string last. */
function applyStatus(item, description) {
  item.text = description.text;
  item.detail = description.detail;
  item.severity = SEVERITY[description.severity];
}

/** One entry per open workspace folder, keyed by folder URI. */
const sessions = new Map();

/** @type {import("vscode").OutputChannel | null} */
let output = null;

/**
 * Resolve `<SERVER_PACKAGE>/package.json` the way Node would, starting from a
 * directory in the workspace rather than from this extension.
 *
 * `createRequire` is given a path inside `nxRoot` so resolution begins there:
 * the package must be the workspace's own installation, because the diagnostics
 * a developer sees have to come from the same version their pipeline will run.
 * `./package.json` is a published subpath export of that package, which is what
 * makes this resolvable at all — `lsp.mjs` is not.
 */
function resolveServerManifest(nxRoot) {
  try {
    return createRequire(join(nxRoot, "noop.js")).resolve(`${SERVER_PACKAGE}/package.json`);
  } catch {
    // Not installed here, which is a state and not an error. The caller turns it
    // into a sentence naming every place it looked.
    return null;
  }
}

/** The `lattice.server.path` setting for one folder, or "". */
function configuredServerPath(folder) {
  return workspace.getConfiguration("lattice", folder).get("server.path", "").trim();
}

/**
 * Start, or refuse to start, one workspace folder.
 *
 * @param {import("vscode").WorkspaceFolder} folder
 */
async function openSession(folder) {
  const key = folder.uri.toString();
  if (sessions.has(key)) return;

  const plan = planSession({
    folderPath: folder.uri.fsPath,
    configuredServerPath: configuredServerPath(folder),
    findRoot: (from) => findNxRoot(from, existsSync),
    locateServer: ({ nxRoot, configuredPath }) =>
      locateServer({
        nxRoot,
        configuredPath,
        exists: existsSync,
        resolvePackageJson: resolveServerManifest,
      }),
  });

  const status = describeStatus(plan);
  // The status item is scoped to the files this extension claims, so it appears
  // in the language status popover of a `.go` or `.rs` buffer and nowhere else.
  const item = languages.createLanguageStatusItem(
    `lattice.${key}`,
    ROUTED_EXTENSIONS.map((extension) => ({
      scheme: "file",
      pattern: new RelativePattern(folder, `**/*${extension}`),
    })),
  );
  item.name = "Lattice";
  applyStatus(item, status);
  item.command = { command: "lattice.showLog", title: "Show log" };

  const session = { plan, item, client: null, stateListener: null };
  sessions.set(key, session);

  if (plan.state !== "start") {
    // Both non-start states are written to the log as well as the status item.
    // The popover holds one sentence; the log holds every path that was tried,
    // which is what turns "it is not working" into a fixable report.
    output?.appendLine(`[${folder.name}] ${plan.reason}`);
    for (const candidate of plan.searched ?? []) {
      output?.appendLine(`[${folder.name}]   looked at ${candidate}`);
    }
    return;
  }

  const server = { module: plan.serverPath, transport: TransportKind.stdio };
  const client = new LanguageClient(
    "lattice",
    "Lattice",
    { run: server, debug: server },
    {
      documentSelector: documentSelector(),
      workspaceFolder: folder,
      // The server takes its root from here first and never walks upward to
      // find one, so this is the whole reason the client resolved `nx.json`
      // before starting: a folder opened below the workspace root would
      // otherwise be analyzed as if it were the root, and find nothing.
      initializationOptions: { workspaceRoot: plan.root },
      outputChannel: output ?? undefined,
      diagnosticCollectionName: "lattice",
      // Never steal focus. A boundary violation is reported as a diagnostic at
      // the import; an output panel that jumped to the front on every server
      // message would be noise attached to the wrong event.
      revealOutputChannelOn: RevealOutputChannelOn.Never,
    },
  );

  session.client = client;

  // A server can die after `start()` resolves, and a client that noticed would
  // otherwise keep the healthy label while publishing nothing — the exact
  // window this status item exists to close. Only the Running → Stopped
  // transition is a death (a failed start is Starting → Stopped, and the catch
  // below already owns it), and a deliberate stop never gets here because
  // `closeSession` removes the session from the map before stopping, so the
  // identity check fails.
  session.stateListener = client.onDidChangeState((event) => {
    if (event.oldState !== State.Running || event.newState !== State.Stopped) return;
    if (sessions.get(key) !== session) return;
    applyStatus(
      item,
      describeStatus({
        state: "blocked",
        reason: `The boundary server at ${plan.serverPath} stopped after starting. Nothing in this workspace is being checked; the log has the server's last output.`,
      }),
    );
    output?.appendLine(`[${folder.name}] server stopped after starting; nothing is being checked`);
  });

  try {
    await client.start();
  } catch (error) {
    // Re-read rather than close over `session`: the folder may have been
    // removed while `start()` was pending, and its session replaced.
    const current = sessions.get(key);
    if (current?.client === client) current.client = null;
    const reason = error instanceof Error ? error.message : String(error);
    applyStatus(
      item,
      describeStatus({
        state: "blocked",
        reason: `The boundary server at ${plan.serverPath} failed to start: ${reason}`,
      }),
    );
    output?.appendLine(`[${folder.name}] server failed to start: ${reason}`);
  }
}

/** Stop one folder's client and drop its status item. */
async function closeSession(key) {
  const session = sessions.get(key);
  if (!session) return;

  sessions.delete(key);
  session.stateListener?.dispose();
  session.item.dispose();
  if (session.client) {
    await session.client.stop();
  }
}

/** Open a session for every folder that has none, in parallel. */
async function syncFolders() {
  const folders = workspace.workspaceFolders ?? [];
  const open = new Set(folders.map((folder) => folder.uri.toString()));

  await Promise.all([...sessions.keys()].filter((key) => !open.has(key)).map(closeSession));
  await Promise.all(folders.map(openSession));
}

/** Tear every session down and build them again from current settings. */
async function restart() {
  await Promise.all([...sessions.keys()].map(closeSession));
  await syncFolders();
}

/** @param {import("vscode").ExtensionContext} context */
export async function activate(context) {
  output = window.createOutputChannel("Lattice");

  context.subscriptions.push(
    output,
    commands.registerCommand("lattice.restart", restart),
    commands.registerCommand("lattice.showLog", () => output?.show(true)),
    workspace.onDidChangeWorkspaceFolders(syncFolders),
    workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("lattice.server.path")) {
        return restart();
      }
    }),
  );

  await syncFolders();
}

export async function deactivate() {
  await Promise.all([...sessions.keys()].map(closeSession));
  output = null;
}
