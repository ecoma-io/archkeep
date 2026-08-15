import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_OPTIONS } from "../options.mjs";

import { createServer, SERVER_CAPABILITIES, watchedFilesFor } from "./server.mjs";

// The diagnosis is mocked, and that is the point of this tier: what is under
// test here is the lifecycle and the publish rule, and the one case that
// matters most — a diagnosis that says it did not complete and hands back
// nothing — cannot be produced by the real one on purpose.
vi.mock("./diagnose.mjs", () => ({ diagnoseDocument: vi.fn() }));

const diagnoseDocument = vi.mocked((await import("./diagnose.mjs")).diagnoseDocument);

const ROOT = "/fixture";
const URI = "file:///fixture/libs/inner/main.go";

/**
 * A server plus everything it said and did, for assertions.
 *
 * @param {{ buildIndex?: (options: any) => any,
 *   readConfig?: (root: string, revision: number, boundaryConfig: string) => Promise<any>,
 *   readOptions?: (root: string) => any }} [overrides]
 */
function session({ buildIndex, readConfig, readOptions } = {}) {
  const sent = [];
  const exits = [];
  const logs = [];
  const server = createServer({
    send: (message) => sent.push(message),
    exit: (code) => exits.push(code),
    log: (text) => logs.push(text),
    buildIndex: buildIndex ?? (() => ({ workspace: {}, graph: { nodes: {} } })),
    readConfig: readConfig ?? (async () => ({ depConstraints: [], options: {} })),
    // Injected so no test reads the real tree's `nx.json` — which would make
    // every assertion below depend on how THIS repository is configured.
    readOptions: readOptions ?? (() => ({ ...DEFAULT_OPTIONS })),
  });
  return { server, sent, exits, logs };
}

/** The watched list a session built from the defaults derives. */
const DEFAULT_WATCHED = watchedFilesFor(DEFAULT_OPTIONS);

const initialize = (params = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { rootUri: `file://${ROOT}`, capabilities: {}, ...params },
});

const didOpen = (text = "package inner\n", uri = URI) => ({
  jsonrpc: "2.0",
  method: "textDocument/didOpen",
  params: { textDocument: { uri, languageId: "go", version: 1, text } },
});

/** Every `publishDiagnostics` notification, in order. */
const published = (sent) =>
  sent.filter((m) => m.method === "textDocument/publishDiagnostics").map((m) => m.params);

beforeEach(() => {
  vi.resetAllMocks();
  diagnoseDocument.mockReturnValue({ analyzed: true, diagnostics: [] });
});

describe("the lifecycle an editor drives", () => {
  it("advertises full text synchronisation, which is the sync it actually implements", async () => {
    // A server that advertised incremental sync and then mis-applied one ranged
    // edit would put every later diagnostic on the wrong line. The capability
    // set is a promise, and this one is kept.
    const { server, sent } = session();
    await server.handle(initialize());

    expect(sent[0].result.capabilities).toEqual(SERVER_CAPABILITIES);
    expect(sent[0].result.capabilities.textDocumentSync.change).toBe(1);
    expect(sent[0].result.serverInfo.name).toBe("lattice");
  });

  it("refuses a request that arrives before initialize", async () => {
    const { server, sent } = session();
    await server.handle({ jsonrpc: "2.0", id: 5, method: "textDocument/didOpen" });

    expect(sent[0].error.code).toBe(-32002);
    expect(sent[0].error.message).toContain("before 'initialize'");
  });

  it("refuses a second initialize instead of silently re-rooting itself", async () => {
    const { server, sent } = session();
    await server.handle(initialize());
    await server.handle({ ...initialize(), id: 2 });

    expect(sent[1].error.code).toBe(-32600);
  });

  it("errors on a request that arrives after shutdown", async () => {
    // The specification is explicit, and the reason is practical: after
    // shutdown the server has released its index and its config, so any answer
    // it gave would be computed from state it no longer has.
    const { server, sent } = session();
    await server.handle(initialize());
    await server.handle({ jsonrpc: "2.0", id: 2, method: "shutdown" });
    await server.handle({ jsonrpc: "2.0", id: 3, method: "textDocument/documentSymbol" });

    expect(sent[1]).toEqual({ jsonrpc: "2.0", id: 2, result: null });
    expect(sent[2].error.code).toBe(-32600);
    expect(sent[2].error.message).toContain("after shutdown");
  });

  it("exits 0 after a shutdown and 1 without one", async () => {
    // Reporting both as 0 would hide a client that killed the session
    // mid-conversation, which is the only signal a supervisor gets.
    const clean = session();
    await clean.server.handle(initialize());
    await clean.server.handle({ jsonrpc: "2.0", id: 2, method: "shutdown" });
    await clean.server.handle({ jsonrpc: "2.0", method: "exit" });

    expect(clean.exits).toEqual([0]);

    const abrupt = session();
    await abrupt.server.handle(initialize());
    await abrupt.server.handle({ jsonrpc: "2.0", method: "exit" });

    expect(abrupt.exits).toEqual([1]);
  });

  it("answers an unknown request with MethodNotFound and no notification at all", async () => {
    const { server, sent } = session();
    await server.handle(initialize());
    await server.handle({ jsonrpc: "2.0", id: 7, method: "textDocument/hover", params: {} });
    await server.handle({ jsonrpc: "2.0", method: "$/setTrace", params: {} });

    expect(sent).toHaveLength(2);
    expect(sent[1].error.code).toBe(-32601);
  });

  it("survives a failure while handling one message, so the next message still gets served", async () => {
    // Messages are handled one at a time on a promise chain. An unhandled
    // rejection there would break the chain, and every later notification —
    // including every `didChange` — would be dropped in silence.
    let firstSend = true;
    const sent = [];
    const logs = [];
    const server = createServer({
      send: (message) => {
        if (firstSend) {
          firstSend = false;
          throw new Error("the client's pipe went away");
        }
        sent.push(message);
      },
      exit: () => {},
      log: (text) => logs.push(text),
      buildIndex: () => ({ workspace: {}, graph: { nodes: {} } }),
      readConfig: async () => ({ depConstraints: [], options: {} }),
    });

    await server.handle(initialize());
    await server.handle({ jsonrpc: "2.0", id: 2, method: "shutdown" });

    expect(logs.join("\n")).toContain("the client's pipe went away");
    expect(sent).toEqual([{ jsonrpc: "2.0", id: 2, result: null }]);
  });

  it("ignores the client's reply to its own request instead of replying to a reply", async () => {
    const { server, sent } = session();
    await server.handle(initialize());
    await server.handle({ jsonrpc: "2.0", id: "lattice/1", result: null });

    expect(sent).toHaveLength(1);
  });
});

describe("which directory the server judges", () => {
  it("prefers an explicit workspaceRoot over the folder the editor opened", async () => {
    // An editor rooted at a subdirectory would find no boundary config and no
    // projects, and report every file clean for the best of reasons. The
    // override is the escape hatch, and it has to outrank the editor's answer.
    const roots = [];
    const { server } = session({
      buildIndex: ({ root }) => {
        roots.push(root);
        return { workspace: {}, graph: { nodes: {} } };
      },
    });
    await server.handle(
      initialize({
        initializationOptions: { workspaceRoot: "/elsewhere" },
        rootUri: `file://${ROOT}`,
      }),
    );
    await server.handle(didOpen("package inner\n", "file:///elsewhere/libs/inner/main.go"));

    expect(roots).toEqual(["/elsewhere"]);
  });

  it("prefers workspaceFolders over rootUri, as the protocol says to", async () => {
    const roots = [];
    const { server } = session({
      buildIndex: ({ root }) => {
        roots.push(root);
        return { workspace: {}, graph: { nodes: {} } };
      },
    });
    await server.handle(
      initialize({ workspaceFolders: [{ uri: "file:///folder", name: "folder" }] }),
    );
    await server.handle(didOpen("package inner\n", "file:///folder/libs/inner/main.go"));

    expect(roots).toEqual(["/folder"]);
  });
});

describe("publishing, where silence has to mean clean", () => {
  it("publishes for the document that was opened, with its diagnostics", async () => {
    diagnoseDocument.mockReturnValue({
      analyzed: true,
      diagnostics: [{ code: "onlyTagsConstraintViolation", message: "nope" }],
    });
    const { server, sent } = session();
    await server.handle(initialize());
    await server.handle(didOpen());

    expect(published(sent)).toEqual([
      {
        uri: URI,
        version: 1,
        diagnostics: [{ code: "onlyTagsConstraintViolation", message: "nope" }],
      },
    ]);
  });

  it("substitutes a diagnostic when a diagnosis reports it did not complete and shows nothing", async () => {
    // The second of the two guards. `diagnoseDocument` promises never to do
    // this; the server verifies it anyway, because the cost of the promise
    // being broken is a file the editor paints clean.
    diagnoseDocument.mockReturnValue({ analyzed: false, diagnostics: [] });
    const { server, sent } = session();
    await server.handle(initialize());
    await server.handle(didOpen());

    const [publish] = published(sent);
    expect(publish.diagnostics).toHaveLength(1);
    expect(publish.diagnostics[0].message).toContain("would read as a clean file");
  });

  it("publishes a failure rather than an empty list when the config will not load", async () => {
    const { server, sent } = session({
      readConfig: async () => {
        throw new Error("module-boundaries.config.mjs is malformed: depConstraints[0].sourceTags");
      },
    });
    await server.handle(initialize());
    await server.handle(didOpen());

    const [publish] = published(sent);
    expect(publish.diagnostics).toHaveLength(1);
    expect(publish.diagnostics[0].message).toContain("depConstraints[0].sourceTags");
    expect(diagnoseDocument).not.toHaveBeenCalled();
  });

  it("publishes a failure rather than an empty list when a native root's boundaryConfig is inline", async () => {
    // `readWorkspaceOptions` (`./server.mjs`) refuses this shape by throwing,
    // rather than reading `model.boundaryConfig` as though it were a filename —
    // the loud alternative to the two silent ones it replaced: a
    // `**/[object Object]` watch glob nothing ever matches, and a
    // "cannot load .../[object Object]" message from `./boundary-config.mjs`
    // that reads like a missing file rather than an unsupported form. This
    // pins the loud failure actually reaching the editor, not just the message
    // text: if `refreshOptions` ever went back to swallowing the throw and
    // falling back to `DEFAULT_OPTIONS`, `currentResources` would stop seeing
    // `optionsFailure` and `diagnoseDocument` would run against a config the
    // workspace never declared — the silent direction this test goes red for.
    const { server, sent } = session({
      readOptions: () => {
        throw new Error(
          "lattice: lattice.json at /fixture holds its boundaryConfig inline, as a policy object " +
            "rather than a filename",
        );
      },
    });
    await server.handle(initialize());
    await server.handle(didOpen());

    const [publish] = published(sent);
    expect(publish.diagnostics).toHaveLength(1);
    expect(publish.diagnostics[0].message).toContain("holds its boundaryConfig inline");
    expect(diagnoseDocument).not.toHaveBeenCalled();
  });

  it("publishes a failure rather than an empty list when the index cannot be built", async () => {
    const { server, sent } = session({
      buildIndex: () => {
        throw new Error("cannot list the files of /fixture: not a git repository");
      },
    });
    await server.handle(initialize());
    await server.handle(didOpen());

    expect(published(sent)[0].diagnostics[0].message).toContain("not a git repository");
  });

  it("reports a document outside the workspace root instead of calling it clean", async () => {
    // A file no project can own has no boundary to cross, which is a real
    // verdict — but arriving at it because the server was rooted somewhere else
    // is a misconfiguration, and the developer is the only one who can fix it.
    const { server, sent } = session();
    await server.handle(initialize());
    await server.handle(didOpen("package x\n", "file:///somewhere/else/main.go"));

    expect(published(sent)[0].diagnostics[0].message).toContain("outside the workspace root");
    expect(diagnoseDocument).not.toHaveBeenCalled();
  });

  it("reports an untitled buffer, which names no file to analyze", async () => {
    const { server, sent } = session();
    await server.handle(initialize());
    await server.handle(didOpen("package x\n", "untitled:Untitled-1"));

    expect(published(sent)[0].diagnostics).toHaveLength(1);
    expect(published(sent)[0].diagnostics[0].message).toContain("names no file on disk");
  });
});

describe("keeping up with the buffer and with the tree", () => {
  it("re-diagnoses the full text a change carries, not the text it was opened with", async () => {
    const seen = [];
    diagnoseDocument.mockImplementation(({ text }) => {
      seen.push(text);
      return { analyzed: true, diagnostics: [] };
    });
    const { server } = session();
    await server.handle(initialize());
    await server.handle(didOpen("package inner\n"));
    await server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri: URI, version: 2 },
        contentChanges: [{ text: 'package inner\nimport "example.test/outer"\n' }],
      },
    });

    expect(seen).toEqual(["package inner\n", 'package inner\nimport "example.test/outer"\n']);
  });

  it("marks the document unanalyzable when a client sends a ranged change to a full-sync server", async () => {
    // The stored text would be a fiction from that point on, and every position
    // computed from it would be wrong. Saying so beats reporting confidently
    // about a buffer the server does not actually have.
    const { server, sent, logs } = session();
    await server.handle(initialize());
    await server.handle(didOpen());
    await server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri: URI, version: 2 },
        contentChanges: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            text: "P",
          },
        ],
      },
    });

    expect(published(sent).at(-1).diagnostics[0].message).toContain(
      "its contents are unknown here",
    );
    expect(logs.join("\n")).toContain("full text synchronisation");
  });

  it("clears the markers for a document that closed, which is not the same as calling it clean", async () => {
    const { server, sent } = session();
    await server.handle(initialize());
    await server.handle(didOpen());
    await server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didClose",
      params: { textDocument: { uri: URI } },
    });

    expect(published(sent).at(-1)).toEqual({ uri: URI, diagnostics: [] });

    // And it stops speaking for that document: a later save publishes nothing.
    await server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didSave",
      params: { textDocument: { uri: URI } },
    });
    expect(published(sent)).toHaveLength(2);
  });

  it("re-diagnoses every open document when a watched file changes", async () => {
    // The constraint table moved, so every open file's verdict was computed
    // against a tree that no longer exists. Leaving them up would show a
    // verdict from a config that has been deleted.
    let build = 0;
    const { server, sent } = session({
      buildIndex: () => {
        build += 1;
        return { workspace: {}, graph: { nodes: {} }, build };
      },
    });
    await server.handle(initialize());
    await server.handle(didOpen());
    await server.handle({
      jsonrpc: "2.0",
      method: "workspace/didChangeWatchedFiles",
      params: { changes: [{ uri: `file://${ROOT}/${DEFAULT_WATCHED[0]}`, type: 2 }] },
    });

    expect(published(sent)).toHaveLength(2);
    expect(build).toBe(2);
  });

  it("re-diagnoses everything when the boundary config is saved from the editor itself", async () => {
    // The reload a client with no file watching would otherwise never get. It
    // only covers a change made in the editor — a `git checkout` beside it
    // still needs a watcher, which is why the log says so at startup.
    let build = 0;
    const { server, sent } = session({
      buildIndex: () => {
        build += 1;
        return { workspace: {}, graph: { nodes: {} } };
      },
    });
    await server.handle(initialize());
    await server.handle(didOpen());
    await server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didSave",
      params: { textDocument: { uri: `file://${ROOT}/${DEFAULT_WATCHED[0]}` } },
    });

    expect(build).toBe(2);
    expect(published(sent)).toHaveLength(2);
  });

  it("ignores a watched-files notification about a file no verdict depends on", async () => {
    let build = 0;
    const { server, sent } = session({
      buildIndex: () => {
        build += 1;
        return { workspace: {}, graph: { nodes: {} } };
      },
    });
    await server.handle(initialize());
    await server.handle(didOpen());
    await server.handle({
      jsonrpc: "2.0",
      method: "workspace/didChangeWatchedFiles",
      params: { changes: [{ uri: `file://${ROOT}/README.md`, type: 2 }] },
    });

    expect(published(sent)).toHaveLength(1);
    expect(build).toBe(1);
  });

  it("caches the index across documents until something it depends on moves", async () => {
    let build = 0;
    const { server } = session({
      buildIndex: () => {
        build += 1;
        return { workspace: {}, graph: { nodes: {} } };
      },
    });
    await server.handle(initialize());
    await server.handle(didOpen("package inner\n", URI));
    await server.handle(didOpen("package other\n", "file:///fixture/libs/outer/main.go"));

    expect(build).toBe(1);
  });
});

describe("asking the client to watch the files a verdict depends on", () => {
  it("registers a watcher for the boundary config and every project.json", async () => {
    const { server, sent } = session();
    await server.handle(
      initialize({
        capabilities: { workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } },
      }),
    );
    await server.handle({ jsonrpc: "2.0", method: "initialized", params: {} });

    const registration = sent.find((m) => m.method === "client/registerCapability");
    expect(registration.params.registrations[0].method).toBe("workspace/didChangeWatchedFiles");
    expect(registration.params.registrations[0].registerOptions.watchers).toEqual(
      DEFAULT_WATCHED.map((file) => ({ globPattern: `**/${file}` })),
    );
  });

  it("says so in the log when the client cannot be asked, rather than pretending it was", async () => {
    // A client that watches nothing simply never sends the notification. That
    // is a real limitation of such a client, and a server that logged nothing
    // would leave a stale verdict looking like a fresh one.
    const { server, sent, logs } = session();
    await server.handle(initialize());
    await server.handle({ jsonrpc: "2.0", method: "initialized", params: {} });

    expect(sent.find((m) => m.method === "client/registerCapability")).toBeUndefined();
    expect(logs.join("\n")).toContain("does not support dynamic file watching");
  });

  it("does not re-register the same watch list it already holds", async () => {
    // Re-sending a registration the client already holds would leave two
    // watchers for every glob and two notifications per edit.
    const { server, sent } = session();
    await server.handle(
      initialize({
        capabilities: { workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } },
      }),
    );
    await server.handle({ jsonrpc: "2.0", method: "initialized", params: {} });
    await server.handle({
      jsonrpc: "2.0",
      method: "workspace/didChangeWatchedFiles",
      params: { changes: [{ uri: `file://${ROOT}/${DEFAULT_WATCHED[0]}`, type: 2 }] },
    });

    const registrations = sent.filter((m) => m.method === "client/registerCapability");
    expect(registrations).toHaveLength(1);
    expect(sent.filter((m) => m.method === "client/unregisterCapability")).toHaveLength(0);
  });

  it("unregisters the old list before registering the new one when the watched set moved", async () => {
    // `nx.json`'s `boundaryConfig` names one of these files, so editing it
    // retires one glob and adds another. A client left holding both would
    // report the old filename forever and the new one nowhere.
    let call = 0;
    const { server, sent } = session({
      readOptions: () => {
        call += 1;
        return {
          ...DEFAULT_OPTIONS,
          boundaryConfig: call === 1 ? "first.config.mjs" : "second.config.mjs",
        };
      },
    });
    await server.handle(
      initialize({
        capabilities: { workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } },
      }),
    );
    await server.handle({ jsonrpc: "2.0", method: "initialized", params: {} });
    await server.handle({
      jsonrpc: "2.0",
      method: "workspace/didChangeWatchedFiles",
      params: { changes: [{ uri: `file://${ROOT}/nx.json`, type: 2 }] },
    });

    const unregister = sent.find((m) => m.method === "client/unregisterCapability");
    expect(unregister.params.unregisterations[0].id).toBe("lattice/watched-files");
    const registrations = sent.filter((m) => m.method === "client/registerCapability");
    expect(registrations).toHaveLength(2);
  });

  it("re-registers when the watched set changed but kept its size", async () => {
    // Same list length, different members — the equality check must compare
    // contents, not only the count.
    let call = 0;
    const { server, sent } = session({
      readOptions: () => {
        call += 1;
        return {
          ...DEFAULT_OPTIONS,
          boundaryConfig: call === 1 ? "first.config.mjs" : "second.config.mjs",
        };
      },
    });
    await server.handle(
      initialize({
        capabilities: { workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } },
      }),
    );
    await server.handle({ jsonrpc: "2.0", method: "initialized", params: {} });
    await server.handle({
      jsonrpc: "2.0",
      method: "workspace/didChangeWatchedFiles",
      params: { changes: [{ uri: `file://${ROOT}/nx.json`, type: 2 }] },
    });

    expect(sent.filter((m) => m.method === "client/registerCapability")).toHaveLength(2);
  });

  it("ignores a watched-files notification that carries no changes at all", async () => {
    let build = 0;
    const { server } = session({
      buildIndex: () => {
        build += 1;
        return { workspace: {}, graph: { nodes: {} } };
      },
    });
    await server.handle(initialize());
    await server.handle(didOpen());
    await server.handle({ jsonrpc: "2.0", method: "workspace/didChangeWatchedFiles" });

    expect(build).toBe(1);
  });

  it("ignores a watched-files change that names no file on disk", async () => {
    let build = 0;
    const { server } = session({
      buildIndex: () => {
        build += 1;
        return { workspace: {}, graph: { nodes: {} } };
      },
    });
    await server.handle(initialize());
    await server.handle(didOpen());
    await server.handle({
      jsonrpc: "2.0",
      method: "workspace/didChangeWatchedFiles",
      params: { changes: [{ uri: "untitled:Untitled-1", type: 2 }] },
    });

    expect(build).toBe(1);
  });
});

describe("message shapes the protocol allows and the server must survive", () => {
  it("ignores an initialize notification, which has no id to answer", async () => {
    const { server, sent } = session();
    await server.handle({ jsonrpc: "2.0", method: "initialize", params: {} });
    await server.handle(initialize());

    expect(sent).toHaveLength(1);
    expect(sent[0].result.serverInfo.name).toBe("lattice");
  });

  it("ignores a notification that arrives before initialize, answering nothing", async () => {
    const { server, sent } = session();
    await server.handle({ jsonrpc: "2.0", method: "textDocument/didOpen", params: {} });

    expect(sent).toHaveLength(0);
  });

  it("answers a shutdown notification with nothing at all", async () => {
    const { server, sent } = session();
    await server.handle(initialize());
    await server.handle({ jsonrpc: "2.0", method: "shutdown" });

    expect(sent).toHaveLength(1);
  });

  it("ignores a notification that arrives after shutdown", async () => {
    // The specification: after shutdown a request errors and a notification is
    // ignored. Answering normally would let the client keep using a server
    // that has released its state.
    const { server, sent } = session();
    await server.handle(initialize());
    await server.handle({ jsonrpc: "2.0", id: 2, method: "shutdown" });
    await server.handle({ jsonrpc: "2.0", method: "textDocument/didOpen", params: {} });

    expect(sent).toHaveLength(2);
  });

  it("treats a message with no shape at all as a no-op", async () => {
    const { server, sent } = session();
    await server.handle(initialize());
    await server.handle(undefined);

    expect(sent).toHaveLength(1);
  });

  it("falls back to the current working directory when initialize names no root at all", async () => {
    const roots = [];
    const { server } = session({
      buildIndex: ({ root }) => {
        roots.push(root);
        return { workspace: {}, graph: { nodes: {} } };
      },
    });
    await server.handle(
      initialize({
        rootUri: undefined,
        workspaceFolders: undefined,
        rootPath: undefined,
      }),
    );
    await server.handle(didOpen("package inner\n", `file://${process.cwd()}/libs/inner/main.go`));

    expect(roots).toEqual([process.cwd()]);
  });

  it("stores an opened document's text and version defensively", async () => {
    diagnoseDocument.mockReturnValue({ analyzed: true, diagnostics: [] });
    const { server } = session();
    await server.handle(initialize());
    await server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri: URI, languageId: "go", text: 42 } },
    });

    // The document was stored with an empty text and no version; the next
    // didChange must not crash and must keep the stored version.
    await server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: { textDocument: { uri: URI } },
    });
    expect(diagnoseDocument).toHaveBeenCalled();
  });

  it("marks a document unanalyzable when a full change carries no text", async () => {
    const { server, sent } = session();
    await server.handle(initialize());
    await server.handle(didOpen());
    await server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: { textDocument: { uri: URI, version: 2 }, contentChanges: [{}] },
    });

    // A full change with no text spares the document the ranged-change death
    // sentence — it just replaces the buffer with the empty text.
    expect(published(sent).at(-1)).toBeDefined();
    expect(diagnoseDocument).toHaveBeenCalled();
  });

  it("ignores a change for a document it never opened", async () => {
    const { server, sent } = session();
    await server.handle(initialize());
    await server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: { textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: "x" }] },
    });

    expect(published(sent)).toHaveLength(0);
  });

  it("ignores a close for a document it never opened, publishing no empty list", async () => {
    const { server, sent } = session();
    await server.handle(initialize());
    await server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didClose",
      params: { textDocument: { uri: URI } },
    });

    expect(published(sent)).toHaveLength(0);
  });

  it("keeps its own failure text when a collaborator throws a plain string", async () => {
    const { server, sent } = session({
      readConfig: async () => {
        throw "config exploded";
      },
    });
    await server.handle(initialize());
    await server.handle(didOpen());

    expect(published(sent)[0].diagnostics[0].message).toContain("config exploded");
  });

  it("keeps the options failure when reading options throws a plain string", async () => {
    const { server, sent } = session({
      readOptions: () => {
        throw "options exploded";
      },
    });
    await server.handle(initialize());
    await server.handle(didOpen());

    expect(published(sent)[0].diagnostics[0].message).toContain("options exploded");
  });

  it("logs a plain-string throw from its own client without crashing the queue", async () => {
    const sent = [];
    const logs = [];
    let firstSend = true;
    const server = createServer({
      send: (message) => {
        if (firstSend) {
          firstSend = false;
          throw "the client's pipe went away";
        }
        sent.push(message);
      },
      exit: () => {},
      log: (text) => logs.push(text),
      buildIndex: () => ({ workspace: {}, graph: { nodes: {} } }),
      readConfig: async () => ({ depConstraints: [], options: {} }),
    });

    await server.handle(initialize());
    await server.handle({ jsonrpc: "2.0", id: 2, method: "shutdown" });

    expect(logs.join("\n")).toContain("the client's pipe went away");
    expect(sent).toEqual([{ jsonrpc: "2.0", id: 2, result: null }]);
  });
});
