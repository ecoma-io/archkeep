/**
 * The language server driven the way an editor drives it: a real process, real
 * `Content-Length` frames over real pipes, a real workspace on disk.
 *
 * Everything below could be asserted more cheaply in-process, and each cheaper
 * version would stop proving something. A handler called directly never proves
 * the framing survives a chunk boundary, that stdout carries only protocol,
 * that `exit` reaches the operating system with the right code, or that the
 * config file is re-read after it changes — that last one is a property of the
 * ESM module cache and only exists in a process that outlives the edit.
 *
 * The fixture invents its own project names and its own tag vocabulary. That is
 * deliberate: this tool is installed into workspaces it knows nothing about, so
 * a test that leaned on this repository's names would pass here and prove
 * nothing about the tree a consumer points it at (`../AGENTS.md`).
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encodeMessage, frameMessages, MAX_CONTENT_LENGTH } from "./lsp/protocol.mjs";
import { environmentForTree } from "./workspace.mjs";

const SERVER = fileURLToPath(new URL("../lsp.mjs", import.meta.url));

/** The boundary law the fixture is judged by, as a source file. */
const boundaryConfig = (innerMayReachOuter) => `
export const depConstraints = [
  { sourceTag: "zone:inner", onlyDependOnLibsWithTags: ${
    innerMayReachOuter ? '["zone:inner", "zone:outer"]' : '["zone:inner"]'
  } },
  { sourceTag: "zone:outer", onlyDependOnLibsWithTags: ["zone:outer"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`;

/** A Go file in `inner` that imports across the boundary into `outer`. */
const GO_WITH_VIOLATION = [
  "package inner",
  "",
  "import (",
  '\t"example.test/outer/thing"',
  ")",
  "",
  "func Use() string { return thing.Name }",
  "",
].join("\n");

/** The same file with the crossing removed — the edit that fixes it. */
const GO_WITHOUT_VIOLATION = ["package inner", "", 'func Use() string { return "local" }', ""].join(
  "\n",
);

/** A `.vue` SFC reaching another project by relative path — the SPELLING is the violation. */
const VUE_WITH_VIOLATION = [
  "<template>",
  "  <p>{{ label }}</p>",
  "</template>",
  "",
  '<script setup lang="ts">',
  'import { label } from "../outer/src/thing";',
  "</scr" + "ipt>",
  "",
].join("\n");

/** TypeScript the compiler cannot parse — an import clause that never closes. */
const UNPARSEABLE_TS = 'import { thing from "./thing";\nexport const value = ;\n';

/**
 * `outer`'s configuration in the JSONC Nx accepts and `JSON.parse` refuses: a
 * line comment, a block comment and a trailing comma, all in one file.
 *
 * Nx reads `project.json` through `readJsonFile` → `parseJson` → jsonc-parser
 * with `allowTrailingComma: true`, so this file names a project that really
 * exists — `nx graph` has it and `../cli.mjs` has it.
 */
const OUTER_PROJECT_JSON_C = [
  "{",
  "  // the far side of the boundary",
  '  "name": "outer",',
  "  /* a library, like everything in this fixture */",
  '  "projectType": "library",',
  '  "tags": ["zone:outer"],',
  "}",
  "",
].join("\n");

/** The same treatment applied to the project the open document belongs to. */
const INNER_PROJECT_JSON_C = [
  "{",
  "  // the near side",
  '  "name": "inner",',
  '  "projectType": "library",',
  '  "tags": ["zone:inner"],',
  "}",
  "",
].join("\n");

/** A `project.json` neither parser can read. */
const UNREADABLE_PROJECT_JSON = "{ this is not a project configuration";

let root;
const files = {
  "module-boundaries.config.mjs": boundaryConfig(false),
  "libs/inner/project.json": JSON.stringify({
    name: "inner",
    projectType: "library",
    tags: ["zone:inner"],
  }),
  "libs/inner/go.mod": "module example.test/inner\n\ngo 1.23\n",
  "libs/inner/main.go": GO_WITH_VIOLATION,
  "libs/inner/Panel.vue": VUE_WITH_VIOLATION,
  "libs/inner/broken.ts": UNPARSEABLE_TS,
  "libs/outer/project.json": JSON.stringify({
    name: "outer",
    projectType: "library",
    tags: ["zone:outer"],
  }),
  "libs/outer/go.mod": "module example.test/outer\n\ngo 1.23\n",
  "libs/outer/thing/thing.go": 'package thing\n\nconst Name = "thing"\n',
  "libs/outer/src/thing.ts": 'export const label = "thing";\n',
};

const write = (relativePath, text) => {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text, "utf8");
};

const uriOf = (relativePath) => pathToFileURL(join(root, relativePath)).href;

beforeAll(() => {
  // `realpathSync` because macOS hands out a symlinked temp directory, and the
  // server compares the document's real path against the root it was given.
  root = realpathSync(mkdtempSync(join(tmpdir(), "lattice-lsp-")));
  for (const [path, text] of Object.entries(files)) write(path, text);
  // The index reads its file list from git, so the fixture has to be a tree git
  // can answer for. The files are staged because the list is TRACKED files only
  // — the same set `lattice check` judges (`../workspace.mjs`'s
  // `listTrackedFiles`) — and an untracked fixture file is invisible to both.
  //
  // `environmentForTree` for the same reason the server itself uses it:
  // `GIT_DIR` beats `cwd`, and this suite runs from a git hook on every push.
  // Inheriting it would re-initialise the ambient repository and leave this
  // fixture with no `.git` of its own.
  execFileSync("git", ["init", "-q"], { cwd: root, env: environmentForTree() });
  execFileSync("git", ["add", "-A"], { cwd: root, env: environmentForTree() });
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/**
 * A client speaking the base protocol to a spawned server.
 *
 * `waitFor` is what makes an interleaved conversation testable: diagnostics
 * arrive as notifications whenever the server is ready, not as replies, so a
 * test that only counted messages would race the server rather than observe it.
 */
function connect(server = SERVER) {
  const child = spawn(process.execPath, [server], { stdio: ["pipe", "pipe", "pipe"] });
  const received = [];
  const watchers = new Set();
  let stderr = "";
  /** @type {Buffer} */
  let buffer = Buffer.alloc(0);
  let exitCode = null;

  child.stdout.on("data", (chunk) => {
    const framed = frameMessages(Buffer.concat([buffer, chunk]));
    buffer = framed.rest;
    for (const message of framed.messages) {
      received.push(message);
      for (const watcher of [...watchers]) watcher(message);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const closed = new Promise((resolve) => {
    child.on("close", (code) => {
      exitCode = code;
      resolve(code);
    });
  });

  return {
    send(message) {
      child.stdin.write(encodeMessage(message));
    },
    /** Write a raw byte buffer to stdin, for frames `send` cannot build. */
    sendRaw(bytes) {
      child.stdin.write(bytes);
    },
    /** The first message — already received or yet to arrive — that matches. */
    waitFor(predicate, description) {
      const existing = received.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          watchers.delete(watcher);
          reject(
            new Error(
              `timed out waiting for ${description}. Received:\n` +
                `${received.map((m) => JSON.stringify(m).slice(0, 220)).join("\n")}\n` +
                `stderr:\n${stderr}`,
            ),
          );
        }, 20_000);
        const watcher = (message) => {
          if (!predicate(message)) return;
          clearTimeout(timer);
          watchers.delete(watcher);
          resolve(message);
        };
        watchers.add(watcher);
      });
    },
    /** The diagnostics published for one document, once they arrive. */
    async diagnosticsFor(uri, after = 0) {
      let seen = 0;
      const message = await this.waitFor(
        (m) => {
          if (m.method !== "textDocument/publishDiagnostics" || m.params.uri !== uri) return false;
          return seen++ >= after;
        },
        `publishDiagnostics #${after + 1} for ${uri}`,
      );
      return message.params.diagnostics;
    },
    get stderr() {
      return stderr;
    },
    get exitCode() {
      return exitCode;
    },
    closed,
    kill: () => child.kill(),
  };
}

/**
 * A connected, initialized client rooted at the fixture — or at
 * `atRoot`, for a suite driving a second, unrelated tree through the same
 * spawned-process machinery (the native `lattice.json` suite below).
 */
async function connected(server = SERVER, atRoot = root) {
  const client = connect(server);
  client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      processId: process.pid,
      rootUri: pathToFileURL(atRoot).href,
      workspaceFolders: [{ uri: pathToFileURL(atRoot).href, name: "fixture" }],
      capabilities: { workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } },
    },
  });
  const initialized = await client.waitFor((m) => m.id === 1, "the initialize response");
  client.send({ jsonrpc: "2.0", method: "initialized", params: {} });
  return { client, initialized };
}

/** Where a substring sits in a text, 0-based, computed rather than written down. */
function locate(text, needle) {
  const offset = text.indexOf(needle);
  const before = text.slice(0, offset);
  return {
    line: before.split("\n").length - 1,
    character: offset - (before.lastIndexOf("\n") + 1),
  };
}

describe("a real editor session against a real workspace", () => {
  it("publishes the boundary violation a Go file crosses, at the import that crosses it", async () => {
    // Go is the reason this is a language server and not an ESLint plugin: no
    // ESLint-based server can read this file at all, and `nx lint` exits 0 over
    // it today (`../AGENTS.md`).
    const { client, initialized } = await connected();
    const uri = uriOf("libs/inner/main.go");

    expect(initialized.result.capabilities.textDocumentSync.change).toBe(1);

    client.send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: { uri, languageId: "go", version: 1, text: GO_WITH_VIOLATION },
      },
    });

    const diagnostics = await client.diagnosticsFor(uri);
    const violation = diagnostics.find((d) => d.code === "onlyTagsConstraintViolation");

    expect(violation, `no tag violation among ${JSON.stringify(diagnostics)}`).toBeDefined();
    expect(violation.source).toBe("lattice");
    expect(violation.severity).toBe(1);
    // The exact sentence `@nx/enforce-module-boundaries` prints for the same
    // import, with this fixture's own tags in it — a message a reader can act
    // on, not merely a red mark.
    expect(violation.message).toBe(
      'A project tagged with "zone:inner" can only depend on libs tagged with "zone:inner"',
    );

    // The range is checked against the fixture rather than against a literal:
    // an off-by-one on either axis points every developer at the wrong line.
    const at = locate(GO_WITH_VIOLATION, '"example.test/outer/thing"');
    expect(violation.range).toEqual({
      start: at,
      end: { line: at.line, character: at.character + '"example.test/outer/thing"'.length },
    });

    client.kill();
  }, 30_000);

  it("republishes an empty list once the edit that removes the violation arrives", async () => {
    // The other half of the contract. A server that only ever added markers
    // would leave a fixed file red, and the developer would learn to ignore it.
    const { client } = await connected();
    const uri = uriOf("libs/inner/main.go");

    client.send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId: "go", version: 1, text: GO_WITH_VIOLATION } },
    });
    expect(await client.diagnosticsFor(uri)).not.toHaveLength(0);

    client.send({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version: 2 },
        // Full synchronisation: the whole document, which is what this server
        // advertised and what its `didChange` handler reads.
        contentChanges: [{ text: GO_WITHOUT_VIOLATION }],
      },
    });

    expect(await client.diagnosticsFor(uri, 1)).toEqual([]);

    client.kill();
  }, 30_000);

  it("publishes a diagnostic for a file it cannot parse, never an empty list", async () => {
    // The failure mode this whole server is written around: an editor draws
    // nothing for `[]`, and a developer reads nothing as "checked, clean". A
    // file whose imports could not be read has no verdict, and it has to say so.
    const { client } = await connected();
    const uri = uriOf("libs/inner/broken.ts");

    client.send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: { uri, languageId: "typescript", version: 1, text: UNPARSEABLE_TS },
      },
    });

    const diagnostics = await client.diagnosticsFor(uri);

    expect(diagnostics).not.toHaveLength(0);
    expect(diagnostics.every((d) => d.code === "analysisFailure")).toBe(true);
    expect(diagnostics[0].message).toContain("not fully checked");
    expect(diagnostics[0].message).toMatch(/parse error/u);

    client.kill();
  }, 30_000);

  it("reads the imports inside a .vue script block and points at the line they are on", async () => {
    // ESLint reaches `.vue` here too, so this is the one language where the
    // two engines answer the same file — and the one whose positions are
    // computed twice, once inside the script block and once mapped back to the
    // file. A diagnostic naming the wrong line is worse than none, so the line
    // is checked against the SFC itself.
    const { client } = await connected();
    const uri = uriOf("libs/inner/Panel.vue");

    client.send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId: "vue", version: 1, text: VUE_WITH_VIOLATION } },
    });

    const diagnostics = await client.diagnosticsFor(uri);
    const violation = diagnostics.find(
      (d) => d.code === "noRelativeOrAbsoluteImportsAcrossLibraries",
    );

    expect(violation, `no crossing violation among ${JSON.stringify(diagnostics)}`).toBeDefined();
    expect(violation.message).toBe(
      "Projects cannot be imported by a relative or absolute path, and must begin with a npm scope",
    );
    expect(violation.range.start).toEqual(locate(VUE_WITH_VIOLATION, '"../outer/src/thing"'));

    client.kill();
  }, 30_000);

  it("re-diagnoses open documents against the new law when the boundary config changes", async () => {
    // Without this the editor keeps showing a verdict from a config that no
    // longer exists — and because `import()` memoises a module URL for the life
    // of the process, "just read it again" is exactly what does not work.
    const { client } = await connected();
    const uri = uriOf("libs/inner/main.go");

    client.send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId: "go", version: 1, text: GO_WITH_VIOLATION } },
    });
    expect(await client.diagnosticsFor(uri)).not.toHaveLength(0);

    try {
      write("module-boundaries.config.mjs", boundaryConfig(true));
      client.send({
        jsonrpc: "2.0",
        method: "workspace/didChangeWatchedFiles",
        params: { changes: [{ uri: uriOf("module-boundaries.config.mjs"), type: 2 }] },
      });

      expect(await client.diagnosticsFor(uri, 1)).toEqual([]);
    } finally {
      write("module-boundaries.config.mjs", boundaryConfig(false));
    }

    client.kill();
  }, 30_000);

  it("keeps the verdict when a project.json is written in the JSONC Nx accepts", async () => {
    // The form Nx accepts and `JSON.parse` refuses. A server that reads the
    // file with `JSON.parse` loses the project from its graph; the Go import
    // then resolves as an external package, the rule engine's npm branch
    // returns before any tag check runs, and the marker that was on screen a
    // moment ago disappears. Nothing tells the developer their editor stopped
    // enforcing — `nx graph`, ESLint and the CLI all still see the project.
    //
    // Both sides are exercised, because they fail differently: the IMPORTED
    // project's config erases a marker that was already up, and the open file's
    // OWN config puts the document in no project at all, which crosses no
    // boundary and so reads clean from the first publish. Each re-index builds
    // the index from scratch, so the last assertion is over a tree where both
    // files are JSONC.
    const { client } = await connected();
    const uri = uriOf("libs/inner/main.go");

    client.send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId: "go", version: 1, text: GO_WITH_VIOLATION } },
    });
    expect(await client.diagnosticsFor(uri)).not.toHaveLength(0);

    try {
      write("libs/outer/project.json", OUTER_PROJECT_JSON_C);
      client.send({
        jsonrpc: "2.0",
        method: "workspace/didChangeWatchedFiles",
        params: { changes: [{ uri: uriOf("libs/outer/project.json"), type: 2 }] },
      });
      expect((await client.diagnosticsFor(uri, 1)).map((d) => d.code)).toContain(
        "onlyTagsConstraintViolation",
      );

      write("libs/inner/project.json", INNER_PROJECT_JSON_C);
      client.send({
        jsonrpc: "2.0",
        method: "workspace/didChangeWatchedFiles",
        params: { changes: [{ uri: uriOf("libs/inner/project.json"), type: 2 }] },
      });
      expect((await client.diagnosticsFor(uri, 2)).map((d) => d.code)).toContain(
        "onlyTagsConstraintViolation",
      );
    } finally {
      write("libs/outer/project.json", files["libs/outer/project.json"]);
      write("libs/inner/project.json", files["libs/inner/project.json"]);
    }

    client.kill();
  }, 30_000);

  it("says what it could not read instead of reporting a tree it never saw whole", async () => {
    // The two things the index records and nothing used to read, together
    // because a reader gets them together: a `project.json` no parser can read
    // takes its project out of the graph, and a symlink pointing outside the
    // checkout is listed by git and cannot be opened, so whatever it imports
    // contributes no edge. Both are dropped on purpose — one broken file must
    // not blank the graph for every other project — and both change the
    // transitive closure two of the fifteen rules are decided on.
    //
    // What must not follow is silence. Without the imported project the tag
    // check never runs at all, so the honest answer is a report naming every
    // file to fix, in ONE diagnostic rather than one per gap. Fixing them
    // brings the real verdict straight back.
    const dangling = join(root, "libs/inner/generated.go");
    write("libs/outer/project.json", UNREADABLE_PROJECT_JSON);
    symlinkSync("./nowhere.go", dangling);
    // The file list is tracked-only (`../workspace.mjs`'s `listTrackedFiles`),
    // and git records a symlink as a mode-120000 index entry even when it
    // dangles — so the symlink has to be staged to reach the index at all.
    // Staging just this path keeps the project.json's index entry holding its
    // good content; `write` above only changed the working-tree copy.
    execFileSync("git", ["add", "--", "libs/inner/generated.go"], {
      cwd: root,
      env: environmentForTree(),
    });
    try {
      const { client } = await connected();
      const uri = uriOf("libs/inner/main.go");

      client.send({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: { textDocument: { uri, languageId: "go", version: 1, text: GO_WITH_VIOLATION } },
      });

      const diagnostics = await client.diagnosticsFor(uri);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].code).toBe("analysisFailure");
      expect(diagnostics[0].message).toContain("INCOMPLETE");
      expect(diagnostics[0].message).toContain("libs/outer/project.json");
      expect(diagnostics[0].message).toContain("libs/inner/generated.go");

      write("libs/outer/project.json", files["libs/outer/project.json"]);
      rmSync(dangling, { force: true });
      // The index rebuild below reads TRACKED files, and a deleted file that is
      // still staged would keep being listed — as an unreadable one, which is
      // exactly the gap this test is clearing. Drop the index entry first, so
      // the rebuilt index describes the fixed tree.
      execFileSync("git", ["reset", "-q", "--", "libs/inner/generated.go"], {
        cwd: root,
        env: environmentForTree(),
      });
      client.send({
        jsonrpc: "2.0",
        method: "workspace/didChangeWatchedFiles",
        params: { changes: [{ uri: uriOf("libs/outer/project.json"), type: 2 }] },
      });

      expect((await client.diagnosticsFor(uri, 1)).map((d) => d.code)).toEqual([
        "onlyTagsConstraintViolation",
      ]);
      client.kill();
    } finally {
      // Drop the symlink's index entry before it is removed, so the fixture's
      // tracked set returns to what beforeAll staged.
      execFileSync("git", ["reset", "-q", "--", "libs/inner/generated.go"], {
        cwd: root,
        env: environmentForTree(),
      });
      write("libs/outer/project.json", files["libs/outer/project.json"]);
      rmSync(dangling, { force: true });
    }
  }, 30_000);

  it("registers a file watcher for every file a verdict depends on", async () => {
    // Five, and the ones worth naming go beyond the boundary table and every
    // `project.json`, which are the inputs to a verdict. `nx.json` is where the
    // options live for an Nx-shaped root, and `lattice.json` is both the marker
    // AND the options for a native one — this fixture is Nx-shaped, so it
    // carries no `lattice.json` of its own, but the glob is still registered so
    // a workspace that adds one later does not need the server restarted before
    // the watcher notices it. `tsconfig.base.json` is the fifth: every
    // TypeScript verdict is resolved against the compiler options that file
    // names (`./src/lsp/server.mjs`'s `watchedFilesFor`), so a `paths` edit
    // there changes verdicts for files that did not change, and a server not
    // watching it keeps showing the old verdict until an unrelated
    // invalidation happens to re-read it. A server watching only the files the
    // options currently name would keep watching a filename the workspace had
    // renamed — the editor would go on painting verdicts from a config it no
    // longer reads, which looks exactly like a clean tree.
    const { client } = await connected();

    const registration = await client.waitFor(
      (m) => m.method === "client/registerCapability",
      "the file-watcher registration",
    );

    expect(registration.params.registrations[0].method).toBe("workspace/didChangeWatchedFiles");
    expect(
      registration.params.registrations[0].registerOptions.watchers
        .map((w) => w.globPattern)
        .sort(),
    ).toEqual([
      "**/lattice.json",
      "**/module-boundaries.config.mjs",
      "**/nx.json",
      "**/project.json",
      "**/tsconfig.base.json",
    ]);

    client.kill();
  }, 30_000);

  it("completes the shutdown handshake and exits 0, having answered the request first", async () => {
    // `process.exit` discards whatever is still queued on a pipe, and the reply
    // to `shutdown` is usually the last thing in it. Asserting the reply and
    // the exit code together is what catches a flush that was skipped.
    const { client } = await connected();

    client.send({ jsonrpc: "2.0", id: 2, method: "shutdown" });
    const reply = await client.waitFor((m) => m.id === 2, "the shutdown reply");
    expect(reply.result).toBeNull();

    client.send({ jsonrpc: "2.0", method: "exit" });

    expect(await client.closed).toBe(0);
  }, 30_000);

  it("exits 1 when a client leaves without shutting the server down", async () => {
    // The only signal a supervisor gets that an editor died mid-conversation.
    const { client } = await connected();

    client.send({ jsonrpc: "2.0", method: "exit" });

    expect(await client.closed).toBe(1);
  }, 30_000);

  it("serves a session when launched through a symlink, the way an installed copy is", async () => {
    // How a consumer actually reaches this file. pnpm's `node_modules/@scope/pkg`
    // is a symlink into `node_modules/.pnpm/…`, and the Claude Code plugin
    // manifest launches `${CLAUDE_PLUGIN_ROOT}/lsp.mjs` by path with no bin shim
    // in between to resolve it.
    //
    // Measured before `src/entry-point.mjs` existed: this exact spelling made
    // the server define everything, run nothing, and exit 0 with no bytes on
    // either stream — a language server that publishes nothing reads to a
    // developer as "checked, clean", which is the one outcome this project is
    // built to refuse. Every other test here spawns the real path, so none of
    // them could go red; this one is the direction that can.
    const linked = join(root, "lsp-through-a-link.mjs");
    symlinkSync(SERVER, linked);

    const { client, initialized } = await connected(linked);

    expect(initialized.result.serverInfo.name).toBe("lattice");

    const uri = uriOf("libs/inner/main.go");
    client.send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId: "go", version: 1, text: GO_WITH_VIOLATION } },
    });
    const diagnostics = await client.diagnosticsFor(uri);

    expect(diagnostics.map((d) => d.code)).toContain("onlyTagsConstraintViolation");

    client.kill();
  }, 30_000);

  it("keeps stdout free of everything that is not protocol", async () => {
    // One stray log line on stdout is read by the client as a malformed frame
    // and desynchronises the stream for the rest of the session.
    const { client } = await connected();
    const uri = uriOf("libs/inner/main.go");

    client.send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId: "go", version: 1, text: GO_WITH_VIOLATION } },
    });
    await client.diagnosticsFor(uri);
    client.send({ jsonrpc: "2.0", id: 2, method: "shutdown" });
    await client.waitFor((m) => m.id === 2, "the shutdown reply");
    client.send({ jsonrpc: "2.0", method: "exit" });
    await client.closed;

    // The server does log — it says which root it took — and every line of it
    // went to stderr, which is the half of the contract worth pinning.
    expect(client.stderr).toContain("language server initialized for");
  }, 30_000);
});

// C1 (cubic): a `lattice.json` root, driven through the real subprocess. The
// unit and index-level tiers next door prove the graph and the diagnosis; what
// only a real process proves is `./src/lsp/server.mjs`'s `readWorkspaceOptions`
// — that `initialize` actually resolves `boundaryConfig`/`tsConfig` from
// `lattice.json` itself rather than from `nx.json` (which this root does not
// have) or from the hardcoded defaults, and that the SAME custom filename this
// fixture declares is the one `readBoundaryConfig` is asked to load.
describe("a real editor session against a native lattice.json workspace", () => {
  let nativeRoot;
  const INNER_GO = [
    "package inner",
    "",
    'import "native.test/outer"',
    "",
    'func Use() string { return "" }',
    "",
  ].join("\n");

  const nativeWrite = (relativePath, text) => {
    const absolute = join(nativeRoot, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text, "utf8");
  };

  beforeAll(() => {
    nativeRoot = realpathSync(mkdtempSync(join(tmpdir(), "lattice-lsp-native-")));
    // `boundaryConfig` names a file this fixture does NOT put at the Nx
    // convention's default path (`module-boundaries.config.mjs`) — the one
    // thing that can only be proven by actually reading it back through a
    // real `initialize`, since a hardcoded default would ALSO find a file
    // sitting at its own name by coincidence.
    nativeWrite(
      "lattice.json",
      JSON.stringify({
        projects: {
          declared: [
            { root: "apps/inner", tags: ["zone:inner"] },
            { root: "apps/outer", tags: ["zone:outer"] },
          ],
        },
        boundaryConfig: "native-boundary.config.mjs",
      }),
    );
    nativeWrite("native-boundary.config.mjs", boundaryConfig(false));
    // Neither declared project carries a `project.json` — the case that used
    // to be silently absent from the graph entirely (`./src/lsp/workspace-index.mjs`'s
    // header).
    nativeWrite("apps/inner/go.mod", "module native.test/inner\n\ngo 1.23\n");
    nativeWrite("apps/inner/main.go", INNER_GO);
    nativeWrite("apps/outer/go.mod", "module native.test/outer\n\ngo 1.23\n");
    nativeWrite("apps/outer/outer.go", "package outer\n");
    execFileSync("git", ["init", "-q"], { cwd: nativeRoot, env: environmentForTree() });
    execFileSync("git", ["add", "-A"], { cwd: nativeRoot, env: environmentForTree() });
  });

  afterAll(() => {
    if (nativeRoot) rmSync(nativeRoot, { recursive: true, force: true });
  });

  it("resolves boundaryConfig from lattice.json and diagnoses a real violation", async () => {
    const { client } = await connected(SERVER, nativeRoot);
    const uri = pathToFileURL(join(nativeRoot, "apps/inner/main.go")).href;

    client.send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId: "go", version: 1, text: INNER_GO } },
    });

    const diagnostics = await client.diagnosticsFor(uri);
    const violation = diagnostics.find((d) => d.code === "onlyTagsConstraintViolation");

    // The red-direction proof: before `readWorkspaceOptions` existed, the
    // default reader only ever looked at `nx.json` — absent here — so the
    // options stayed the DEFAULTS, `readConfig` looked for
    // `module-boundaries.config.mjs`, found nothing, and the whole session
    // failed closed onto `analysisFailure` rather than ever reaching this
    // violation.
    expect(violation, `no tag violation among ${JSON.stringify(diagnostics)}`).toBeDefined();

    client.kill();
  }, 30_000);

  // G-01: a project named `__proto__` must be a first-class node in the graph
  // and produce the SAME verdict the control-named project produces. Two trees
  // identical except for the shared project's declared name — same directory,
  // same files, same import — a real editor session diagnoses the crossing in
  // both. The fixture mirrors the finding's: a root `project.json` declaring
  // `{name, root: "src/shared"}`, source at `src/shared/s.ts`, sibling at
  // `src/child`, import `../shared/s`.
  //
  // The red-direction proof: with the old plain-`{}` nodes map, the `__proto__`
  // name vanished from `graph.nodes`, `filesOf` still attributed the shared
  // project its files, and the reachability walk over the poisoned prototype
  // published `analysisFailed: adjList[current].filter is not a function`
  // instead of the boundary violation the control tree published — a verdict
  // that was wrong from both directions at once.
  it("judges an import into a __proto__-named project exactly as into any other", async () => {
    const makeTree = (sharedName) => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "lattice-lsp-proto-")));
      const boundary = [
        "export const depConstraints = [",
        '  { sourceTag: "scope:child", onlyDependOnLibsWithTags: ["scope:child"] },',
        "];",
        'export const moduleBoundaryOptions = { allow: [], buildTargets: ["build"],',
        "  enforceBuildableLibDependency: false, allowCircularSelfDependency: false,",
        "  checkDynamicDependenciesExceptions: [], ignoredCircularDependencies: [],",
        "  banTransitiveDependencies: false, checkNestedExternalImports: false };",
      ].join("\n");
      const write = (relativePath, text) => {
        const absolute = join(dir, relativePath);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, text, "utf8");
      };
      write("module-boundaries.config.mjs", boundary);
      write("nx.json", '{"plugins":[{"plugin":"@ecoma-io/lattice/nx"}]}\n');
      // The shared project's config lives at the tree ROOT and names its own
      // root, exactly as the finding's fixture does — the `__proto__` project
      // is declared by name in a manifest, and that name is the whole point.
      write(
        "project.json",
        JSON.stringify({
          name: sharedName,
          root: "src/shared",
          projectType: "library",
          tags: ["scope:shared"],
        }),
      );
      write("src/shared/s.ts", "export const s = 1;\n");
      write(
        "src/child/project.json",
        JSON.stringify({ name: "child", projectType: "library", tags: ["scope:child"] }),
      );
      write("src/child/main.ts", 'import { s } from "../shared/s";\n');
      execFileSync("git", ["init", "-q"], { cwd: dir, env: environmentForTree() });
      // The file list is tracked-only (the same set `lattice check` judges), so
      // the fixture must be staged or the editor sees no files at all.
      execFileSync("git", ["add", "-A"], { cwd: dir, env: environmentForTree() });
      return dir;
    };
    const control = makeTree("shared");
    const proto = makeTree("__proto__");
    try {
      const diagnose = async (dir) => {
        const { client } = await connected(SERVER, dir);
        const uri = pathToFileURL(join(dir, "src/child/main.ts")).href;
        client.send({
          jsonrpc: "2.0",
          method: "textDocument/didOpen",
          params: {
            textDocument: {
              uri,
              languageId: "typescript",
              version: 1,
              text: "import { s } from '../shared/s';\n",
            },
          },
        });
        const diagnostics = await client.diagnosticsFor(uri);
        client.kill();
        return diagnostics;
      };
      const controlDiagnostics = await diagnose(control);
      const protoDiagnostics = await diagnose(proto);

      const controlViolation = controlDiagnostics.find(
        (d) => d.code === "noRelativeOrAbsoluteImportsAcrossLibraries",
      );
      expect(
        controlViolation,
        `control tree did not publish the crossing violation: ${JSON.stringify(controlDiagnostics)}`,
      ).toBeDefined();
      // The `__proto__` tree must publish the SAME boundary verdict with the
      // SAME message — never the `analysisFailed` "could not be checked" error
      // the poisoned prototype produced, and never an empty list that would
      // read as a clean bill of health.
      const protoViolation = protoDiagnostics.find(
        (d) => d.code === "noRelativeOrAbsoluteImportsAcrossLibraries",
      );
      expect(
        protoViolation,
        `__proto__ tree produced ${JSON.stringify(protoDiagnostics)}`,
      ).toBeDefined();
      expect(protoViolation.message).toBe(controlViolation.message);
      expect(
        protoDiagnostics.some((d) => String(d.message ?? "").includes("could not be checked")),
      ).toBe(false);
    } finally {
      rmSync(control, { recursive: true, force: true });
      rmSync(proto, { recursive: true, force: true });
    }
  }, 60_000);

  // G-08: the real process must close a session whose first frame declares an
  // implausible `Content-Length` — loudly, and fast — instead of holding the
  // pipe open forever waiting for bytes that will never arrive. The old
  // `frameMessages` returned `{messages: [], rest: <everything>}` for this
  // input and the server fed the rest back in forever: the editor saw a
  // permanently hanging language server, which reads identically to a clean
  // session that never starts. `connect` returns an `exitCode` (null until the
  // process actually closes) and the `closed` promise, so both halves are
  // observable.
  it("closes a session whose frame declares a Content-Length beyond the cap, loudly and fast", async () => {
    const client = connect(SERVER);
    // A legal Content-Length with a body that never completes is exactly the
    // finding's attack: `MAX_CONTENT_LENGTH + 1` declared, a short body
    // written. The session must refuse it outright, not wait forever.
    client.sendRaw(
      Buffer.concat([
        Buffer.from(`Content-Length: ${MAX_CONTENT_LENGTH + 1}\r\n\r\n`),
        Buffer.from('{"jsonrpc":"2.0"'),
      ]),
    );
    const exitCode = await client.closed;
    expect(exitCode).toBe(2);
    expect(client.stderr).toContain("Content-Length");
    expect(client.stderr).toContain("maximum");
  }, 30_000);

  it("refuses a root that declares both nx.json and lattice.json", async () => {
    // One project model per workspace — the same refusal the CLI makes. A
    // tree carrying both markers is a decision nobody made.
    const both = realpathSync(mkdtempSync(join(tmpdir(), "lattice-lsp-both-")));
    try {
      writeFileSync(join(both, "nx.json"), "{}\n", "utf8");
      writeFileSync(join(both, "lattice.json"), "{}\n", "utf8");
      const { readWorkspaceOptions } = await import("./lsp/server.mjs");
      expect(() => readWorkspaceOptions(both)).toThrow(/declares both nx\.json and lattice\.json/);
    } finally {
      rmSync(both, { recursive: true, force: true });
    }
  }, 30_000);

  it("diagnoses a native root whose boundaryConfig is the inline-object form", async () => {
    // This server used to REFUSE this shape, and the refusal was honest while
    // `./lsp/boundary-config.mjs` could only read a policy file. Both halves
    // are handled now — `watchedFilesFor` leans on the `lattice.json` entry it
    // already carries, and the reader validates the object instead of
    // resolving a path — so a workspace the CLI judges fine is one the editor
    // judges too.
    //
    // Driven end to end rather than through `readWorkspaceOptions` alone: a
    // unit assertion that the object rides through would pass against a
    // server that then failed to produce a single diagnostic from it, which is
    // the failure that would actually reach a developer. The tree is the same
    // fixture shape as the sibling test above, with the law moved off its file
    // and onto `lattice.json` — so what differs between the two is the dialect
    // and nothing else, and both must reach the identical violation.
    const inline = realpathSync(mkdtempSync(join(tmpdir(), "lattice-lsp-inline-")));
    const inlineWrite = (relativePath, text) => {
      const absolute = join(inline, relativePath);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, text, "utf8");
    };
    try {
      inlineWrite(
        "lattice.json",
        JSON.stringify({
          projects: {
            declared: [
              { root: "apps/inner", tags: ["zone:inner"] },
              { root: "apps/outer", tags: ["zone:outer"] },
            ],
          },
          boundaryConfig: {
            depConstraints: [
              { sourceTag: "zone:inner", onlyDependOnLibsWithTags: ["zone:inner"] },
              { sourceTag: "zone:outer", onlyDependOnLibsWithTags: ["zone:outer"] },
            ],
            moduleBoundaryOptions: {
              allow: [],
              buildTargets: ["build"],
              enforceBuildableLibDependency: false,
              allowCircularSelfDependency: false,
              checkDynamicDependenciesExceptions: [],
              ignoredCircularDependencies: [],
              banTransitiveDependencies: false,
              checkNestedExternalImports: false,
            },
          },
        }),
      );
      inlineWrite("apps/inner/go.mod", "module native.test/inner\n\ngo 1.23\n");
      inlineWrite("apps/inner/main.go", INNER_GO);
      inlineWrite("apps/outer/go.mod", "module native.test/outer\n\ngo 1.23\n");
      inlineWrite("apps/outer/outer.go", "package outer\n");
      execFileSync("git", ["init", "-q"], { cwd: inline, env: environmentForTree() });
      execFileSync("git", ["add", "-A"], { cwd: inline, env: environmentForTree() });

      const { client } = await connected(SERVER, inline);
      const uri = pathToFileURL(join(inline, "apps/inner/main.go")).href;

      client.send({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: { textDocument: { uri, languageId: "go", version: 1, text: INNER_GO } },
      });

      const diagnostics = await client.diagnosticsFor(uri);
      const violation = diagnostics.find((d) => d.code === "onlyTagsConstraintViolation");

      // Named rather than asserted by length: the silent direction here is an
      // EMPTY list (the law never loaded, and the editor paints the file
      // clean), and the loud-but-wrong one is a lone `analysisFailed` from a
      // reader that still treated the object as a path. Printing what actually
      // arrived tells those two apart on the first failing run.
      expect(violation, `no tag violation among ${JSON.stringify(diagnostics)}`).toBeDefined();

      client.kill();
    } finally {
      rmSync(inline, { recursive: true, force: true });
    }
  }, 30_000);
});
