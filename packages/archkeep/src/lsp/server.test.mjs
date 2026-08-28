import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_OPTIONS, MOON_TSCONFIG_CHAIN, MOON_TSCONFIG_SOURCE } from "../options.mjs";
import { MOON_DIR } from "../providers/moon.mjs";

import {
  createServer,
  readWorkspaceOptions,
  SERVER_CAPABILITIES,
  watchedFilesFor,
} from "./server.mjs";

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
    expect(sent[0].result.serverInfo.name).toBe("archkeep");
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
    await server.handle({ jsonrpc: "2.0", id: "archkeep/1", result: null });

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

  it("diagnoses a native root whose boundaryConfig is an inline policy object", async () => {
    // This server used to REFUSE this shape, and the refusal was the honest
    // answer while `./boundary-config.mjs` could only read a file: an inline
    // law would have produced a `**/[object Object]` watch glob matching
    // nothing and a "cannot load .../[object Object]" message reading like a
    // missing file. Both halves are handled now, so the refusal would be the
    // wrong kind of loud — a valid workspace the CLI judges fine, told by its
    // editor that it cannot be looked at.
    //
    // What this pins is that the object reaches the reader intact rather than
    // being coerced to a filename somewhere in between. `readConfig` asserting
    // on what it was handed is the load-bearing half: a server that stringified
    // the policy would still "work" against a reader that then failed, and the
    // failure would surface as a load error nobody could trace back to here.
    const policy = {
      depConstraints: [{ sourceTag: "zone:a", onlyDependOnLibsWithTags: ["zone:b"] }],
      moduleBoundaryOptions: {},
    };
    const readConfig = vi.fn(async () => ({ depConstraints: policy.depConstraints, options: {} }));
    const { server, sent } = session({
      readConfig,
      readOptions: () => ({ boundaryConfig: policy, tsConfig: "tsconfig.base.json" }),
    });
    await server.handle(initialize());
    await server.handle(didOpen());

    expect(readConfig).toHaveBeenCalledWith(ROOT, expect.any(Number), policy);
    const [publish] = published(sent);
    expect(publish.diagnostics).toEqual([]);
    expect(diagnoseDocument).toHaveBeenCalled();
  });

  it("watches archkeep.json and no [object Object] glob when the policy is inline", async () => {
    // The silent direction for the watched set. An inline `boundaryConfig`
    // spread into the list becomes the glob `**/[object Object]`, which
    // matches no file that can exist — the registration would look like it
    // covered the law while no change notification ever arrived, and every
    // open file would keep showing a verdict from the policy as it was when
    // the editor opened. `archkeep.json` staying in the list is the other half:
    // it is where an inline law actually lives, so dropping it would lose the
    // only notification that can reach one.
    const watched = watchedFilesFor({
      boundaryConfig: { depConstraints: [], moduleBoundaryOptions: {} },
      tsConfig: "tsconfig.base.json",
    });

    // Asserted as "every entry is a string" rather than "no entry is the
    // object": `registerFileWatchers` interpolates each entry into a glob, so
    // a non-string entry is the defect itself, one template literal before it
    // becomes the unmatchable glob.
    expect(watched.every((file) => typeof file === "string")).toBe(true);
    expect(watched.some((file) => String(file).includes("object Object"))).toBe(false);
    expect(watched).toContain("archkeep.json");
    expect(watched).toContain("tsconfig.base.json");
  });

  it("keeps the whole Moon chain watched while the options themselves could not be read", () => {
    // The trap this closes, and it is the server answering its own remedy
    // with silence. `readMoonOptions` (`../options.mjs`) refuses a Moon root
    // that carries TypeScript and neither chain entry, and its message offers
    // two fixes: add `tsconfig.base.json`, or rename the config that already
    // holds the paths table to `tsconfig.json`. `refreshOptions` falls back to
    // `DEFAULT_OPTIONS` on a throw, and DEFAULT_OPTIONS carries no
    // `tsConfigSource` — so before `unresolved`, the watched set held
    // `tsconfig.base.json` alone. A developer taking the SECOND branch created
    // a file nothing watched: no notification, no re-read, and the same
    // refusal republished on every open document until the editor restarted.
    const failed = watchedFilesFor(DEFAULT_OPTIONS, { unresolved: true });
    for (const entry of MOON_TSCONFIG_CHAIN) expect(failed).toContain(entry);

    // The red twin, and the reason this test names the flag rather than the
    // count: without `unresolved` the same options watch only the one name,
    // which is what made the trap invisible.
    const resolved = watchedFilesFor(DEFAULT_OPTIONS);
    expect(resolved).toContain(MOON_TSCONFIG_CHAIN[0]);
    expect(resolved).not.toContain(MOON_TSCONFIG_CHAIN[1]);

    // No entry is duplicated: `DEFAULT_OPTIONS.tsConfig` IS the chain's first
    // name, and a repeated entry would register the same glob twice and log a
    // doubled name in the invalidation line a reader is meant to trust.
    expect(failed.length).toBe(new Set(failed).size);
  });

  it("publishes a failure, not an empty list, when an Nx workspace's options name a profiles registry", async () => {
    // `readWorkspaceOptions` (`./server.mjs`) refuses a `profiles` option by
    // throwing, rather than watching the profile NAME (`options.boundaryConfig`)
    // as though it were a policy file and loading it — the loud alternative to
    // a server that watched `[object Object]`-style nothing forever. A profile
    // name is a selector, not a path this server could watch or parse, so the
    // loud refusal is the only answer that does not read as a clean workspace.
    const { server, sent } = session({
      readOptions: () => {
        throw new Error(
          "archkeep: /fixture's nx.json options name a profiles registry (law-profiles.json) — a " +
            "valid form (../../cli.mjs's check resolves a policy by profile name from it), but not " +
            "one this language server can load yet",
        );
      },
    });
    await server.handle(initialize());
    await server.handle(didOpen());

    const [publish] = published(sent);
    expect(publish.diagnostics).toHaveLength(1);
    expect(publish.diagnostics[0].message).toContain("name a profiles registry");
    expect(diagnoseDocument).not.toHaveBeenCalled();
  });

  it("shows a window error at initialize when the options could not be read, even with no document open", async () => {
    // The always-on marker for a refused options state. Every open document gets
    // the reason on its diagnostics, but a session that has no documents open
    // yet — the editor pane on first launch — would otherwise show nothing at
    // all, and a session that quietly stays empty is indistinguishable from one
    // that is healthy. One `window/showMessage` at the moment the failure is
    // known marks the session for the whole of its life.
    const { server, sent } = session({
      readOptions: () => {
        throw new Error("archkeep: /fixture's nx.json options name a profiles registry");
      },
    });
    await server.handle(initialize());

    const show = sent.find((m) => m.method === "window/showMessage");
    expect(show).toBeDefined();
    expect(show.params.type).toBe(1); // MessageType.error
    expect(show.params.message).toContain("profiles registry");
  });

  it("keeps refusing every document for the whole session, marking it once", async () => {
    // Durability, in both directions: the refusal is not a one-shot at
    // initialize — a document opened later in the same session still gets the
    // reason on its diagnostics — and the marker is not repeated per document,
    // because a stream of identical error popups is noise that would get the
    // first one dismissed.
    const { server, sent } = session({
      readOptions: () => {
        throw new Error("archkeep: /fixture's nx.json options name a profiles registry");
      },
    });
    await server.handle(initialize());
    await server.handle(didOpen());
    await server.handle(didOpen("package inner\n", "file:///fixture/libs/outer/main.go"));

    expect(sent.filter((m) => m.method === "window/showMessage")).toHaveLength(1);
    const publishes = published(sent);
    expect(publishes).toHaveLength(2);
    for (const publish of publishes) {
      expect(publish.diagnostics).toHaveLength(1);
      expect(publish.diagnostics[0].code).toBe("analysisFailure");
      expect(publish.diagnostics[0].message).toContain("profiles registry");
    }
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

  it("keeps an untitled buffer unanalyzable even after a real full change", async () => {
    // The untitled reason is structural — the URI names no file on disk, so no
    // project can own it — and no text change fixes it. A didChange carrying
    // real text must not clear that reason: the document would otherwise reach
    // diagnosis with `sourceFile === null` and publish a verdict no project
    // owns. The red direction: before the guard, the change below cleared
    // `unavailable`, the assertion flipped, and the untitled buffer painted
    // clean.
    const { server, sent } = session();
    await server.handle(initialize());
    await server.handle(didOpen("package x\n", "untitled:Untitled-1"));
    await server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri: "untitled:Untitled-1", version: 2 },
        contentChanges: [{ text: "package y\n" }],
      },
    });

    expect(published(sent).at(-1).diagnostics).toHaveLength(1);
    expect(published(sent).at(-1).diagnostics[0].message).toContain("names no file on disk");
    expect(diagnoseDocument).not.toHaveBeenCalled();
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

  it("resumes the verdict when a real full change follows an unanalyzable one", async () => {
    // The unanalyzable marker must never be a one-way door: a document marked
    // "contents unknown" after an incremental (or empty) change is the same
    // buffer the moment a genuine full change lands, and a server that kept
    // refusing would paint a permanent failure over a file that has been
    // perfectly analyzable again since the edit. The recovery is the whole
    // point of storing the marker on the document rather than in a session
    // flag.
    const { server, sent } = session();
    await server.handle(initialize());
    await server.handle(didOpen());
    // The open itself was a normal analyzable document and legitimately ran a
    // diagnosis; the assertions below are about what the changes did.
    diagnoseDocument.mockClear();
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

    expect(published(sent).at(-1).diagnostics[0].code).toBe("analysisFailure");
    expect(diagnoseDocument).not.toHaveBeenCalled();

    diagnoseDocument.mockReturnValue({ analyzed: true, diagnostics: [] });
    await server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri: URI, version: 3 },
        contentChanges: [{ text: "package inner\n" }],
      },
    });

    expect(published(sent).at(-1).diagnostics).toEqual([]);
    expect(diagnoseDocument).toHaveBeenCalledTimes(1);
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

  it("re-diagnoses when a project's package.json changes, which is where a waiver lives", async () => {
    // The silent-stale direction this entry was added for. A project's
    // `package.json` is read for `data.declaredPackages` (what waives
    // `noTransitiveDependencies`) and `data.entryPoints` (the secondary
    // entry-point exemption) — `../workspace.mjs`'s `annotatePackageFacts` —
    // and the index reads them once per revision. Drop a dependency from it and
    // the violation those facts were waiving is real now, while only a watched
    // file bumps the revision: a server that did not watch this file would go
    // on publishing `[]` for that violation for the rest of the session. The
    // red direction: with `package.json` out of `watchedFilesFor`, `build`
    // stays 1 here and this test fails.
    //
    // The path is nested on purpose — a `package.json` is a per-project file,
    // not a workspace-root singleton, so the `**\/package.json` glob and
    // `touchesWatchedFile`'s path-aware match have to reach it at depth.
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
      params: { changes: [{ uri: `file://${ROOT}/libs/inner/package.json`, type: 2 }] },
    });

    expect(build).toBe(2);
    expect(published(sent)).toHaveLength(2);
  });

  it.each(["module-federation.config.js", "module-federation.config.ts"])(
    "re-diagnoses when a project's %s changes, which is where an exemption lives",
    async (name) => {
      // `data.mfeRemote` is the `noImportsOfApps` EXEMPTION (`../rules/index.mjs`),
      // read from `module-federation.config.js` with the `.ts` spelling as the
      // fallback (`../workspace.mjs`'s `projectIsMFERemote`). Delete the file
      // and every import of that app is a violation again — one this server
      // would keep waiving until the editor restarted. Both spellings are
      // driven because watching only one leaves the other silent, and which
      // spelling a workspace uses is its own choice.
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
        params: { changes: [{ uri: `file://${ROOT}/apps/widgets/${name}`, type: 3 }] },
      });

      expect(build).toBe(2);
      expect(published(sent)).toHaveLength(2);
    },
  );

  it.each([
    ["go.mod", "apps/api/go.mod"],
    ["go.work", "go.work"],
    ["Cargo.toml", "libs/ledger/Cargo.toml"],
    ["pyproject.toml", "packages/etl/pyproject.toml"],
    ["pom.xml", "services/billing/pom.xml"],
    ["settings.gradle", "settings.gradle"],
    ["settings.gradle.kts", "services/billing/settings.gradle.kts"],
    ["build.gradle", "apps/api/build.gradle"],
    ["build.gradle.kts", "apps/api/build.gradle.kts"],
    ["moon.yml", "apps/webapp/moon.yml"],
    [".moon/workspace.yml", ".moon/workspace.yml"],
    [".config/moon/workspace.yml", ".config/moon/workspace.yml"],
  ])(
    "re-diagnoses every open document when the graph manifest %s is saved from the editor",
    async (_name, relativePath) => {
      // The silent-stale direction #410 reports, driven through the door the
      // issue names. Saving a graph manifest used to republish the manifest
      // alone, because `touchesWatchedFile` matched a list that carried the
      // TypeScript-side configuration only: the project graph kept its
      // index-time shape, and every open verdict kept answering from it —
      // byte-for-byte identical to a checked tree. The red direction: with a
      // manifest out of `watchedFilesFor`, `build` stays 1 and the second
      // publish never happens. Both a root-level spelling (`go.work`, the two
      // `workspace.yml` markers) and a per-project depth are driven, since
      // `touchesWatchedFile`'s suffix reach has to cover where each file
      // actually lives.
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
        params: { textDocument: { uri: `file://${ROOT}/${relativePath}` } },
      });

      expect(build).toBe(2);
      expect(published(sent)).toHaveLength(2);
    },
  );

  it.each(["go.mod", ".moon/workspace.yml"])(
    "re-diagnoses when the file watcher reports a changed %s too, not only on a save",
    async (name) => {
      // The other door into the same predicate. The client-side watcher
      // reports a manifest change made beside the editor — `git checkout`, a
      // `go work use` — and it reaches the same `touchesWatchedFile`, so the
      // watched set has to cover the manifests there as well or the two doors
      // would disagree about what shapes the graph.
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
        params: {
          changes: [
            {
              uri:
                name === "go.mod" ? `file://${ROOT}/libs/ledger/go.mod` : `file://${ROOT}/${name}`,
              type: 2,
            },
          ],
        },
      });

      expect(build).toBe(2);
      expect(published(sent)).toHaveLength(2);
    },
  );

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

  it("re-diagnoses when a nested boundaryConfig path changes, not just its basename", async () => {
    // The silent-stale direction (S-bug A): `watchedFilesFor` registers a glob
    // of `**/configs/boundaries.mjs` for a nested `boundaryConfig`, but the old
    // match compared only the changed URI's BASENAME against the watched
    // entries — `"boundaries.mjs"` never equals the registered entry
    // `"configs/boundaries.mjs"`, so a workspace naming a nested config never
    // re-analyzed when that exact file changed. The red direction: with the
    // old basename-only match, `build` here stays `1` and this test fails.
    let build = 0;
    const { server, sent } = session({
      readOptions: () => ({ ...DEFAULT_OPTIONS, boundaryConfig: "configs/boundaries.mjs" }),
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
      params: { changes: [{ uri: `file://${ROOT}/configs/boundaries.mjs`, type: 2 }] },
    });

    expect(build).toBe(2);
    expect(published(sent)).toHaveLength(2);
  });

  it("still re-diagnoses a flat-filename boundaryConfig, unaffected by the path-aware match", async () => {
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
      params: { changes: [{ uri: `file://${ROOT}/${DEFAULT_OPTIONS.boundaryConfig}`, type: 2 }] },
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
  it("registers a watcher for the boundary config, the graph manifests, and every project.json", async () => {
    const { server, sent } = session();
    await server.handle(
      initialize({
        capabilities: { workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } },
      }),
    );
    await server.handle({ jsonrpc: "2.0", method: "initialized", params: {} });

    const registration = sent.find((m) => m.method === "client/registerCapability");
    expect(registration.params.registrations[0].method).toBe("workspace/didChangeWatchedFiles");
    // The exact set, spelled out rather than derived from
    // `watchedFilesFor(DEFAULT_OPTIONS)` — a self-deriving assertion cannot go
    // red when a dependency is dropped from the watched set (the tsConfig case
    // this test pins): `registerOptions.watchers` must name every file a
    // verdict depends on. The tsConfig entry is written literally rather than
    // read back off `DEFAULT_OPTIONS`, so a `watchedFilesFor` edit that drops
    // it turns this assertion red. The integration test
    // (`lsp.integration.test.mjs`) hardcodes the same glob.
    expect(registration.params.registrations[0].registerOptions.watchers).toEqual(
      [
        DEFAULT_OPTIONS.boundaryConfig,
        "tsconfig.base.json",
        "project.json",
        "nx.json",
        "archkeep.json",
        // The three per-project files that carry a WAIVER — `declaredPackages`
        // and `entryPoints` from a `package.json`, `mfeRemote` from either
        // Module Federation spelling (`../workspace.mjs`). Written literally
        // for the same reason the tsConfig entry above is: a `watchedFilesFor`
        // edit that drops one has to turn this assertion red, and an assertion
        // derived from that function could not.
        "package.json",
        "module-federation.config.js",
        "module-federation.config.ts",
        // The manifests the Go, Rust, Python, JVM and Moon providers read the
        // project graph itself from (`./server.mjs`'s
        // `POLYGLOT_GRAPH_MANIFESTS`, which owns the per-file why). Written
        // literally for the same reason as every entry above: #410 was this
        // list describing the TypeScript-side configuration only, and an
        // assertion derived from `watchedFilesFor` would have stayed green
        // through exactly that hole.
        "go.mod",
        "go.work",
        "Cargo.toml",
        "pyproject.toml",
        "pom.xml",
        "settings.gradle",
        "settings.gradle.kts",
        "build.gradle",
        "build.gradle.kts",
        "moon.yml",
        ".moon/workspace.yml",
        ".config/moon/workspace.yml",
      ].map((file) => ({ globPattern: `**/${file}` })),
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
    expect(unregister.params.unregisterations[0].id).toBe("archkeep/watched-files");
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
    expect(sent[0].result.serverInfo.name).toBe("archkeep");
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

  it("marks a document that opens without any text as unanalyzable, and resumes on a real change", async () => {
    // A didOpen whose `text` is not a string — a client that sends the metadata
    // half of the event and nothing else. The empty string this used to fall
    // back to is not the file's contents but the ABSENCE of a statement about
    // them, and analyzing it would publish a verdict about text the buffer does
    // not have — an empty list on an unanalyzed file, which is the one outcome
    // this server exists to prevent. The change that finally carries real text
    // is the one path that must resume the verdict.
    const { server, sent } = session();
    await server.handle(initialize());
    await server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri: URI, languageId: "go", text: 42 } },
    });

    const opened = published(sent).at(-1);
    expect(opened).toBeDefined();
    expect(opened.diagnostics).not.toHaveLength(0);
    expect(opened.diagnostics[0].code).toBe("analysisFailure");
    expect(opened.diagnostics[0].message).toContain("unknown");
    expect(diagnoseDocument).not.toHaveBeenCalled();

    diagnoseDocument.mockReturnValue({ analyzed: true, diagnostics: [] });
    await server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri: URI, version: 2 },
        contentChanges: [{ text: "package inner\n" }],
      },
    });

    expect(published(sent).at(-1).diagnostics).toEqual([]);
    expect(diagnoseDocument).toHaveBeenCalledTimes(1);
  });

  it("marks a document unanalyzable when a full change carries no text", async () => {
    // `contentChanges: [{}]` — a full change with no `text`. Same class as the
    // didOpen-without-text case: the empty string it would otherwise stand in
    // for is a fiction, and publishing `[]` over it would read as a clean file
    // that was never checked. The publish must be a loud failure instead.
    const { server, sent } = session();
    await server.handle(initialize());
    await server.handle(didOpen());
    // The open itself was a normal analyzable document and legitimately ran a
    // diagnosis; the assertion below is about the CHANGE.
    diagnoseDocument.mockClear();
    await server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: { textDocument: { uri: URI, version: 2 }, contentChanges: [{}] },
    });

    const changed = published(sent).at(-1);
    expect(changed).toBeDefined();
    expect(changed.diagnostics).not.toHaveLength(0);
    expect(changed.diagnostics[0].code).toBe("analysisFailure");
    expect(changed.diagnostics[0].message).toContain("unknown");
    expect(diagnoseDocument).not.toHaveBeenCalled();
  });

  it("marks a document unanalyzable when a full change is followed by a ranged one", async () => {
    // The silent direction (S-bug B): LSP applies `contentChanges` sequentially,
    // so a ranged edit ordered AFTER a full change is still part of the true
    // final text. The old code found the last change with no `range` by
    // searching from the END of the array and stopped there, so a full change
    // followed by a ranged one was treated as though the full change were the
    // whole story — the trailing ranged edit was silently dropped, the
    // document was analyzed from text this server does not actually have, and
    // a clean result published `analyzed: true` with `[]`. That is a THIRD,
    // unnamed place an empty list would leave the workspace; the design allows
    // exactly two (`./server.mjs`'s header). The red direction: with the old
    // code this test's diagnostics come back `[]` and `diagnoseDocument` is
    // called; the fix must publish the loud `analysisFailure` diagnostic
    // instead and never even reach `diagnoseDocument`.
    const { server, sent } = session();
    await server.handle(initialize());
    await server.handle(didOpen());
    diagnoseDocument.mockClear();
    await server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri: URI, version: 2 },
        contentChanges: [
          { text: "package inner\n" },
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            text: "P",
          },
        ],
      },
    });

    const changed = published(sent).at(-1);
    expect(changed.diagnostics).toHaveLength(1);
    expect(changed.diagnostics[0].code).toBe("analysisFailure");
    expect(diagnoseDocument).not.toHaveBeenCalled();
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
describe("the tsconfig a Moon root is read against, and the files that decide it", () => {
  // A real directory, because this is the one dispatch that cannot be driven
  // over an in-memory tree: the Moon marker is a DIRECTORY, and every face
  // that resolves it — `../providers/moon.mjs`'s `moonMarkerAt`, the CLI's own
  // gate, this server — asks plain filesystem existence rather than git's
  // tracked list, for the reason `./workspace-index.mjs` states.
  /** @type {string[]} */
  const roots = [];
  const moonRootWith = (...names) => {
    const root = mkdtempSync(join(tmpdir(), "archkeep-moon-"));
    roots.push(root);
    mkdirSync(join(root, MOON_DIR));
    for (const name of names) writeFileSync(join(root, name), "{}\n");
    return root;
  };
  afterEach(() => {
    while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
  });

  it("resolves tsconfig.json on a Moon root that has no tsconfig.base.json", () => {
    // Before this branch existed the server read `readPluginOptions` here,
    // which only ever reads `nx.json` — so a Moon workspace got the DEFAULTS,
    // and the editor resolved every TypeScript import against a
    // `tsconfig.base.json` the tree does not have. Every aliased specifier
    // then resolved to nothing and the editor drew a crossing on each one, in
    // a workspace whose paths table was sitting in the file next to it.
    const options = readWorkspaceOptions(moonRootWith("tsconfig.json"));
    expect(options.tsConfig).toBe("tsconfig.json");
    expect(options.tsConfigSource).toBe(MOON_TSCONFIG_SOURCE);
    expect(options.boundaryConfig).toBe(DEFAULT_OPTIONS.boundaryConfig);
  });

  it("keeps tsconfig.base.json ahead of tsconfig.json for the editor too", () => {
    // The CLI and the editor may not disagree about which paths table governs
    // one workspace, so the ordering is read from the same chain rather than
    // decided again here.
    const options = readWorkspaceOptions(moonRootWith("tsconfig.base.json", "tsconfig.json"));
    expect(options.tsConfig).toBe("tsconfig.base.json");
  });

  it("watches every candidate the chain could pick, not only the one it did", () => {
    // The silent-stale direction, and the same defect #276 closed for
    // `package.json` and the Module Federation configs: with `tsconfig.json`
    // chosen, a `tsconfig.base.json` appearing beside it takes the resolution
    // over WITHOUT the chosen file being touched. A server watching only the
    // winner gets no notification, never bumps its revision, and keeps
    // publishing verdicts resolved through a table it no longer reads for the
    // rest of the session.
    const options = readWorkspaceOptions(moonRootWith("tsconfig.json"));
    const watched = watchedFilesFor(options);
    for (const candidate of MOON_TSCONFIG_CHAIN) expect(watched).toContain(candidate);
    // Written literally rather than derived from `MOON_TSCONFIG_CHAIN`, so a
    // chain entry silently dropped from the watched set turns this red.
    expect(watched).toContain("tsconfig.json");
    expect(watched).toContain("tsconfig.base.json");
  });

  it("watches one tsconfig, not a chain, where the name was declared", () => {
    // The chain is Moon's convention alone. An Nx or native root STATED its
    // name, so watching a second file there would register a glob for a
    // filename the workspace never named — and an edit to it would drop the
    // index and re-analyze the tree for nothing.
    expect(watchedFilesFor(DEFAULT_OPTIONS)).not.toContain("tsconfig.json");
    expect(watchedFilesFor({ ...DEFAULT_OPTIONS, tsConfig: "tsconfig.json" })).not.toContain(
      "tsconfig.base.json",
    );
  });

  it("refuses a Moon root whose TypeScript has no tsconfig the chain can find", () => {
    // Requirement's third half, and the state that produced the measured
    // several-hundred-finding run. It arrives as a THROW so `refreshOptions`
    // catches it into `optionsFailure`, which publishes a diagnostic on every
    // open document — the loud alternative to diagnosing a whole workspace
    // against compiler defaults and calling the result a verdict.
    const root = moonRootWith();
    writeFileSync(join(root, "main.ts"), "export const a = 1;\n");
    // A real git tree, because "which files does this workspace have" is
    // git's answer here as everywhere else (`./workspace-index.mjs`'s
    // `listWorkspaceFiles`). Without one the refusal below would be the
    // "cannot list the files" throw wearing the same prefix — loud too, but
    // not the one under test, and the assertion could not tell them apart.
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "main.ts"], { cwd: root });
    expect(() => readWorkspaceOptions(root)).toThrow(/tsconfig\.base\.json or tsconfig\.json/u);
    expect(() => readWorkspaceOptions(root)).toThrow(/main\.ts/u);
  });
});
