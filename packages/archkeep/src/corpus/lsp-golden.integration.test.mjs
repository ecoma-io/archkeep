/**
 * LSP golden-response corpus — the language server's differential against
 * what an editor actually receives.
 *
 * The CLI corpus beside this file records what the CLI prints; this one
 * records what the server puts on the wire, captured from a REAL spawned
 * `lsp.mjs` process over real `Content-Length` frames — the same machinery
 * `../lsp.integration.test.mjs` drives, at a fixed fixture path so every
 * `uri` byte is identical across machines and runs. The recorded responses
 * are re-played byte-for-byte by every later run, so a server refactor that
 * changes what an editor would see cannot land silently: it lands as a
 * golden diff that has to be re-blessed on the pull request.
 *
 * The fixture is an Nx-shaped tree, so the corpus exercises the index's
 * static acquisition path (`../lsp/workspace-index.mjs` composing
 * `../providers/nx-static.mjs`) end to end, and its load-bearing case is the
 * invariant's silent direction: a refactor that starts publishing `[]` where
 * findings exist — or anything at all where `[]` is the claim — differs from
 * these bytes. Byte-for-byte identical to a clean workspace is exactly what
 * an empty result must never be mistaken for.
 *
 * ## Validation levels
 *
 * | Recorded artifact                          | Gate  | Reason                                                |
 * |--------------------------------------------|-------|-------------------------------------------------------|
 * | `initialize` capabilities                  | L2    | frozen object, `SERVER_CAPABILITIES`                  |
 * | `client/registerCapability` watcher list   | L2    | derived from resolved options; spelled in tests twice  |
 * | every `publishDiagnostics` record          | L2    | codes, severities, ranges, messages over this fixture  |
 * | the two empty `publishDiagnostics` records | L2    | the INV-1 empty claim, pinned as bytes                 |
 * | shutdown → process exit code               | L1    | the lifecycle contract, asserted not recorded          |
 * | `serverInfo.version`                       | L3    | release-coupled (`package.json`); pinned as a semver   |
 * |                                            |       | regex by `../lsp/protocol.test.mjs`, normalized here   |
 *
 * Normalization is the debt precedent: `sampleTime` is normalized in the CLI
 * corpus because it is wall-clock; `version` is normalized here because it
 * moves with every release. Everything else is compared as recorded.
 *
 * ## Canonical form
 *
 * A golden holds the response's `params` (or `result`) as `JSON.stringify` of
 * the deep-sorted object, two-space indented — values exact, key order
 * canonical. JSON key order is not part of any contract, so a refactor that
 * merely constructs the same object in a different order is not a finding;
 * a refactor that changes any value is.
 *
 * Regenerate with:
 *
 *   ARCHKEEP_UPDATE_GOLDENS=1 npx vitest run src/corpus/lsp-golden.integration.test.mjs
 *
 * Then review every golden diff before committing.
 */

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encodeMessage, frameMessages } from "../lsp/protocol.mjs";
import { environmentForTree } from "../workspace.mjs";
import { SPAWN_BUDGET_MS, SPAWN_TEST_BUDGET_MS } from "../../spawn-budget.mjs";

const SERVER = fileURLToPath(new URL("../../lsp.mjs", import.meta.url));
const GOLDEN_DIR = fileURLToPath(new URL("./goldens-lsp/", import.meta.url));
const UPDATING = process.env.ARCHKEEP_UPDATE_GOLDENS === "1";

// ---------------------------------------------------------------------------
// Fixture — an Nx-shaped tree, the shape whose static acquisition path the
// index composes (`../providers/nx-static.mjs`). The vocabulary is invented
// here for the same reason it is invented in every suite: this tool runs in
// workspaces it has never seen (`../../AGENTS.md`).
// ---------------------------------------------------------------------------

/** The boundary law the fixture is judged by, as a source file. */
const boundaryConfig = `
export const depConstraints = [
  { sourceTag: "zone:inner", onlyDependOnLibsWithTags: ["zone:inner"] },
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

/** TypeScript the compiler cannot parse — a verdict the server must refuse to fake. */
const UNPARSEABLE_TS = 'import { thing from "./thing";\nexport const value = ;\n';

/**
 * The fixed fixture root. Not `mkdtemp`: the path is part of the recorded
 * bytes (`params.uri`), so it is the same on every machine, the way the CLI
 * corpus fixes its own root. Removed and rebuilt on every run.
 */
const FIXTURE_ROOT = join(tmpdir(), "archkeep-lsp-golden-fixture");

const files = {
  "module-boundaries.config.mjs": boundaryConfig,
  "libs/inner/project.json": JSON.stringify({
    name: "inner",
    projectType: "library",
    tags: ["zone:inner"],
  }),
  "libs/inner/go.mod": "module example.test/inner\n\ngo 1.23\n",
  "libs/inner/main.go": GO_WITH_VIOLATION,
  "libs/inner/broken.ts": UNPARSEABLE_TS,
  "libs/outer/project.json": JSON.stringify({
    name: "outer",
    projectType: "library",
    tags: ["zone:outer"],
  }),
  "libs/outer/go.mod": "module example.test/outer\n\ngo 1.23\n",
  "libs/outer/thing/thing.go": 'package thing\n\nconst Name = "thing"\n',
};

const uriOf = (relativePath) => pathToFileURL(join(FIXTURE_ROOT, relativePath)).href;

beforeAll(() => {
  if (existsSync(FIXTURE_ROOT)) rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  mkdirSync(FIXTURE_ROOT, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    const absolute = join(FIXTURE_ROOT, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text, "utf8");
  }
  // The index reads its file list from git's TRACKED files, so the fixture is
  // staged into a repository of its own. `environmentForTree` because GIT_DIR
  // beats cwd, and this suite runs from a git hook on every push.
  execFileSync("git", ["init", "-q"], { cwd: FIXTURE_ROOT, env: environmentForTree() });
  execFileSync("git", ["add", "-A"], { cwd: FIXTURE_ROOT, env: environmentForTree() });
}, SPAWN_TEST_BUDGET_MS);

afterAll(() => {
  if (existsSync(FIXTURE_ROOT)) rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The recorder
// ---------------------------------------------------------------------------

/**
 * Canonical form: the deep-sorted, two-space-indented JSON of a response
 * payload. `version` is normalized before this runs (the level-3 field).
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonical(value) {
  return JSON.stringify(sortDeep(value), null, 2);
}

/**
 * Keys sorted recursively, values untouched — the transformation canonical
 * applies before its one stringify. Returning the value (not a string of it)
 * is what keeps nested objects from being double-encoded.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortDeep(value[key]);
    return sorted;
  }
  return value;
}

/** The one release-coupled field, replaced before any comparison (see header). */
function normalizeVersion(payload) {
  if (payload?.serverInfo && typeof payload.serverInfo.version === "string") {
    return { ...payload, serverInfo: { ...payload.serverInfo, version: "<version>" } };
  }
  return payload;
}

/**
 * Compare — or, in update mode, write — one golden.
 *
 * @param {string} name
 * @param {unknown} payload
 */
function golden(name, payload) {
  const goldenFile = join(GOLDEN_DIR, name);
  const recorded = `${canonical(payload)}\n`;

  if (UPDATING) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(goldenFile, recorded);
    return;
  }

  let expected;
  try {
    expected = readFileSync(goldenFile, "utf8");
  } catch {
    throw new Error(
      `Golden file missing: ${goldenFile}\n` +
        `Regenerate with: ARCHKEEP_UPDATE_GOLDENS=1 npx vitest run src/corpus/lsp-golden.integration.test.mjs`,
    );
  }
  expect(recorded).toBe(expected);
}

/**
 * A client speaking the base protocol to a spawned server — the same shape
 * as `../lsp.integration.test.mjs`'s `connect`, minus the affordances this
 * corpus does not use (raw frames, stderr assertions, a second tree).
 */
function connect() {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    timeout: SPAWN_BUDGET_MS,
    killSignal: "SIGKILL",
  });
  const received = [];
  const watchers = new Set();
  let stderr = "";
  /** @type {Buffer} */
  let buffer = Buffer.alloc(0);

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

  return {
    send(message) {
      child.stdin.write(encodeMessage(message));
    },
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
    async diagnosticsFor(uri, after = 0) {
      let seen = 0;
      const message = await this.waitFor(
        (m) => {
          if (m.method !== "textDocument/publishDiagnostics" || m.params.uri !== uri) return false;
          return seen++ >= after;
        },
        `publishDiagnostics #${after + 1} for ${uri}`,
      );
      return message.params;
    },
    kill: () => child.kill(),
  };
}

/**
 * A connected, initialized client rooted at the golden fixture, declaring the
 * watcher dynamic-registration capability a real editor declares — the
 * registration list below is part of what the server does with the options.
 */
async function connected() {
  const client = connect();
  client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      processId: process.pid,
      rootUri: pathToFileURL(FIXTURE_ROOT).href,
      workspaceFolders: [{ uri: pathToFileURL(FIXTURE_ROOT).href, name: "fixture" }],
      capabilities: { workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } },
    },
  });
  const initialized = await client.waitFor((m) => m.id === 1, "the initialize response");
  client.send({ jsonrpc: "2.0", method: "initialized", params: {} });
  return { client, initialized };
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

describe("the LSP golden conversation — initialize and registration", () => {
  it(
    "answers initialize with the promised capabilities (level 2)",
    async () => {
      const { client, initialized } = await connected();

      golden("initialize.result.json", normalizeVersion(initialized.result));

      client.kill();
    },
    SPAWN_TEST_BUDGET_MS,
  );

  it(
    "registers exactly the watcher set its options derive (level 2)",
    async () => {
      const { client } = await connected();

      const registration = await client.waitFor(
        (m) => m.method === "client/registerCapability",
        "the watcher registration request",
      );

      golden("register-watched-files.json", registration.params);

      client.kill();
    },
    SPAWN_TEST_BUDGET_MS,
  );
});

describe("the LSP golden conversation — the violation, the fix, the close", () => {
  it(
    "publishes the boundary violation byte-for-byte (level 2)",
    async () => {
      const { client } = await connected();
      const uri = uriOf("libs/inner/main.go");

      client.send({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "go", version: 1, text: GO_WITH_VIOLATION },
        },
      });

      const params = await client.diagnosticsFor(uri);

      // The corpus's own teeth, stated apart from the bytes: a refactor that
      // regenerates this golden with an empty array is the silent direction,
      // not a formatting change.
      expect(params.diagnostics.length).toBeGreaterThan(0);

      golden("publish-violation.json", params);

      client.send({
        jsonrpc: "2.0",
        method: "textDocument/didChange",
        params: {
          textDocument: { uri, version: 2 },
          contentChanges: [{ text: GO_WITHOUT_VIOLATION }],
        },
      });

      // The other half of the invariant: after the fix, the claim is `[]` —
      // and only `[]`. A refactor that publishes findings here, or an
      // analysis-failure marker where the empty claim belongs, differs from
      // the recorded bytes.
      const fixed = await client.diagnosticsFor(uri, 1);
      golden("publish-fixed-empty.json", fixed);

      client.send({
        jsonrpc: "2.0",
        method: "textDocument/didClose",
        params: { textDocument: { uri } },
      });

      // The second of the exactly-two empty-publish sites: the close clears.
      const cleared = await client.diagnosticsFor(uri, 2);
      golden("publish-cleared-empty.json", cleared);

      client.kill();
    },
    SPAWN_TEST_BUDGET_MS,
  );
});

describe("the LSP golden conversation — a file with no verdict", () => {
  it(
    "publishes a not-checked diagnostic for the unparseable file, never an empty list (level 2)",
    async () => {
      const { client } = await connected();
      const uri = uriOf("libs/inner/broken.ts");

      client.send({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "typescript", version: 1, text: UNPARSEABLE_TS },
        },
      });

      const params = await client.diagnosticsFor(uri);

      expect(params.diagnostics.length).toBeGreaterThan(0);

      golden("publish-unparseable.json", params);

      client.kill();
    },
    SPAWN_TEST_BUDGET_MS,
  );
});
