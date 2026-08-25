// The MCP protocol conversation, driven in-process: a real SDK `Client`
// connected to the real server over the SDK's linked in-memory transport
// pair. Nothing here mocks the protocol — `initialize`, `tools/list` and
// `tools/call` are the same requests a host sends, and the assertions read
// what a host reads. The workspace fixture is the same shape
// `./engine.test.mjs` argues for: real files on disk, real analyzer, only Nx
// and git injected.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer, SERVER_NAME } from "./server.mjs";

const require2 = createRequire(import.meta.url);
const VERSION = require2("../package.json").version;

/** The eight tools, in the order the server registers them. */
const TOOL_NAMES = [
  "archkeep_context",
  "archkeep_check",
  "archkeep_impact",
  "archkeep_drift",
  "archkeep_explain",
  "archkeep_graph",
  "archkeep_history",
  "archkeep_propose",
];

/** One connected client–server pair; `io` is the injectable engine seams. */
async function connectedSession(io = {}) {
  const server = createServer(io);
  const client = new Client({ name: "server-test", version: "0.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

/** A clean two-project workspace, plus its injectable graph/files. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "archkeep-mcp-server-"));
  const writeAt = (relativePath, text) => {
    mkdirSync(dirname(join(root, relativePath)), { recursive: true });
    writeFileSync(join(root, relativePath), text);
  };
  writeAt(
    "nx.json",
    `${JSON.stringify({
      plugins: [
        {
          plugin: "@ecoma-io/archkeep/nx",
          options: { boundaryConfig: "module-boundaries.config.mjs" },
        },
      ],
    })}\n`,
  );
  writeAt(
    "module-boundaries.config.mjs",
    `export const depConstraints = [
  { sourceTag: "type-package", onlyDependOnLibsWithTags: ["type-package"] },
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
`,
  );
  writeAt("libs/core/go.mod", "module example.com/core\n\ngo 1.24\n");
  writeAt("libs/core/core.go", "package core\n");
  writeAt("libs/ui/go.mod", "module example.com/ui\n\ngo 1.24\n");
  writeAt("libs/ui/ui.go", "package ui\n");
  const graph = {
    nodes: {
      core: { name: "core", type: "lib", data: { root: "libs/core", tags: ["type-package"] } },
      ui: { name: "ui", type: "lib", data: { root: "libs/ui", tags: ["type-extension"] } },
    },
    dependencies: { ui: [{ source: "ui", target: "core", type: "static" }] },
  };
  const files = [
    "nx.json",
    "module-boundaries.config.mjs",
    "libs/core/go.mod",
    "libs/core/core.go",
    "libs/ui/go.mod",
    "libs/ui/ui.go",
  ];
  return { root, io: { readGraph: () => graph, listFiles: () => files } };
}

const created = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

describe("initialization", () => {
  it("announces the server's name and this package's version", async () => {
    const { server, client } = await connectedSession();
    expect(client.getServerVersion()).toEqual({ name: SERVER_NAME, version: VERSION });
    await client.close();
    await server.close();
  });
});

describe("tools/list — the whole surface, exactly", () => {
  it("registers the eight tools and nothing else", async () => {
    const { server, client } = await connectedSession();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    for (const tool of tools) {
      // What a host needs to decide whether to call: a description, and an
      // input schema the SDK derives from the zod shape.
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe("object");
    }
    await client.close();
    await server.close();
  });
});

describe("input schema validation", () => {
  // The SDK answers a schema-invalid call with a tool result carrying
  // `isError` and the validation message — the same shape a host branches on —
  // and the engine is never reached, which is what makes the schema the first
  // gate.
  it("rejects a call missing a required field, before the engine is reached", async () => {
    const { server, client } = await connectedSession();
    const missing = await client.callTool({ name: "archkeep_context", arguments: {} });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("Input validation error");
    expect(missing.content[0].text).toContain("project");
    const short = await client.callTool({
      name: "archkeep_explain",
      arguments: { file: "a.go", line: 1 },
    });
    expect(short.isError).toBe(true);
    expect(short.content[0].text).toContain("column");
    await client.close();
    await server.close();
  });

  it("rejects an enum outside the declared values", async () => {
    const { server, client } = await connectedSession();
    const result = await client.callTool({
      name: "archkeep_propose",
      arguments: { mode: "adopt" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("discover");
    await client.close();
    await server.close();
  });

  it("rejects an unknown key rather than stripping it — a typo'd argument is loud", async () => {
    // zod's default strips unknown keys, so `path` for `paths` would run an
    // UNscoped check under the caller's belief that they had scoped it — and
    // on `archkeep_context`, a dropped narrowing leaves no trace at all. The
    // strict schemas turn the typo into a validation error naming the key.
    const { server, client } = await connectedSession();
    const result = await client.callTool({
      name: "archkeep_check",
      arguments: { path: ["libs/ui/ui.go"] },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("path");
    // The field this surface no longer declares is the same class of mistake.
    const retired = await client.callTool({
      name: "archkeep_history",
      arguments: { evidence: "decisions", decisionId: "0001" },
    });
    expect(retired.isError).toBe(true);
    expect(retired.content[0].text).toContain("decisionId");
    await client.close();
    await server.close();
  });

  it("announces every tool as read-only", async () => {
    // The authority boundary the surface argues, as a fact a host can branch
    // on: no tool writes, so a host need not prompt for one.
    const { server, client } = await connectedSession();
    const { tools } = await client.listTools();
    expect(tools.length).toBe(8);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
    await client.close();
    await server.close();
  });
});

describe("tools/call over the in-memory pair", () => {
  it("answers check with the structured three-state verdict", async () => {
    const w = fixture();
    created.push(w.root);
    const { server, client } = await connectedSession(w.io);
    const result = await client.callTool({
      name: "archkeep_check",
      arguments: { workspaceRoot: w.root },
    });
    expect(result.isError).toBeFalsy();
    // The same payload twice: structuredContent for a client that reads it,
    // one JSON text block for one that reads text.
    expect(result.structuredContent).toMatchObject({
      runCompleted: true,
      verdict: "pass",
    });
    expect(JSON.parse(result.content[0].text).verdict).toBe("pass");
    await client.close();
    await server.close();
  });

  it("answers graph through the text content block too", async () => {
    const w = fixture();
    created.push(w.root);
    const { server, client } = await connectedSession(w.io);
    const result = await client.callTool({
      name: "archkeep_graph",
      arguments: { workspaceRoot: w.root },
    });
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.command).toBe("graph");
    expect(envelope.result.projects.map((project) => project.name)).toEqual(["core", "ui"]);
    await client.close();
    await server.close();
  });

  it("carries an engine refusal as a tool error with the message verbatim", async () => {
    const w = fixture();
    created.push(w.root);
    const { server, client } = await connectedSession(w.io);
    const result = await client.callTool({
      name: "archkeep_drift",
      arguments: { workspaceRoot: w.root },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("drift requires a tracked architecture-intent.json");
    await client.close();
    await server.close();
  });

  it("frames a UsageError as an input mistake", async () => {
    const w = fixture();
    created.push(w.root);
    const { server, client } = await connectedSession(w.io);
    const result = await client.callTool({
      name: "archkeep_impact",
      arguments: { workspaceRoot: w.root, project: "nope" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^Invalid input: /);
    expect(result.content[0].text).toContain("no project named 'nope'");
    await client.close();
    await server.close();
  });

  it("refuses a relative workspaceRoot as an input mistake, through the protocol", async () => {
    // The schema documents the field as an absolute path and the adapter
    // holds it; this pins the mapping a host sees — the input-mistake lane,
    // not a workspace refusal, because the fix is to retype the argument.
    const w = fixture();
    created.push(w.root);
    const { server, client } = await connectedSession(w.io);
    const result = await client.callTool({
      name: "archkeep_graph",
      arguments: { workspaceRoot: "libs" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^Invalid input: /);
    expect(result.content[0].text).toContain("workspaceRoot must be an absolute path");
    await client.close();
    await server.close();
  });

  it("carries the scope of a check beside its verdict, for the host that reads structure", async () => {
    const w = fixture();
    created.push(w.root);
    const { server, client } = await connectedSession(w.io);
    const scoped = await client.callTool({
      name: "archkeep_check",
      arguments: { workspaceRoot: w.root, paths: ["libs/ui/ui.go"] },
    });
    expect(/** @type {any} */ (scoped.structuredContent).scope).toEqual({
      kind: "paths",
      paths: ["libs/ui/ui.go"],
    });
    const unscoped = await client.callTool({
      name: "archkeep_check",
      arguments: { workspaceRoot: w.root },
    });
    expect(/** @type {any} */ (unscoped.structuredContent).scope).toEqual({ kind: "workspace" });
    await client.close();
    await server.close();
  });

  it("answers a failed check run as unknown, never as fail", async () => {
    // The one mapping this server exists to get right: a run that could not
    // start is a structured 'unknown', not an error result and not 'fail'.
    const nowhere = mkdtempSync(join(tmpdir(), "archkeep-mcp-server-nowhere-"));
    created.push(nowhere);
    const { server, client } = await connectedSession();
    const result = await client.callTool({
      name: "archkeep_check",
      arguments: { workspaceRoot: nowhere },
    });
    expect(result.isError).toBeFalsy();
    const payload = /** @type {any} */ (result.structuredContent);
    expect(payload).toMatchObject({
      runCompleted: false,
      verdict: "unknown",
    });
    expect(payload.reason).toContain("no workspace root");
    await client.close();
    await server.close();
  });

  it("returns a proposal that requires approval and writes nothing", async () => {
    const w = fixture();
    created.push(w.root);
    const { server, client } = await connectedSession(w.io);
    const before = readdirSync(w.root).sort();
    const result = await client.callTool({
      name: "archkeep_propose",
      arguments: { workspaceRoot: w.root, mode: "discover" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      mode: "discover",
      requiresApproval: true,
      authoritative: false,
      written: false,
    });
    expect(/** @type {any} */ (result.structuredContent).result.proposal.notAuthoritative).toBe(
      true,
    );
    // Authority stays where it was: the workspace holds exactly the files it
    // held before the proposal.
    expect(readdirSync(w.root).sort()).toEqual(before);
    await client.close();
    await server.close();
  });
});
