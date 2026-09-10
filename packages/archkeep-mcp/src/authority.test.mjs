// Adversarial authority tests: every test defends an invariant whose
// violation would be a silent or catastrophic failure in the MCP surface.
// Unlike the tool-by-tool behavioural tests in engine.test.mjs and
// server.test.mjs, these stress the authority contract itself — what the
// server MUST NOT do — rather than what each tool answers.
//
// The invariant doctrine (from AGENTS.md): "An empty result is a claim,
// not a shrug." Every test here has a plausible bug that would make it
// go red in the silent direction.
//
// Hermeticity rule this file follows: every call that can reach the engine
// names an explicit `workspaceRoot` the test built (or a value the engine's
// own gates refuse before any filesystem walk). Omitting the field would let
// the marker walk adopt the real repository (`moon.yml` is a marker) and run
// the engine over this checkout — slow, and outside the test's control.
//
// Covers: (a) propose never writes, (b) requiresApproval respected,
// (c) hostile arguments fail loud, (d) read-only under hostile sequences.
// See: packages/archkeep-mcp/src/engine.mjs for the adapter contracts,
// packages/archkeep-mcp/src/server.mjs for the schema surface.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  checkTool,
  contextTool,
  driftTool,
  explainTool,
  graphTool,
  historyTool,
  impactTool,
  proposeTool,
  scenarioTool,
} from "./engine.mjs";
import { createServer } from "./server.mjs";

/** Every fixture root, removed once at the end. */
const created = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * A fixture workspace on disk, with a real boundary law and three Go
 * projects. The graph and file-list seams are injectable per call — the same
 * pattern engine.test.mjs uses — real files on disk, only Nx and git injected.
 */
function workspace({ violating = true, intent = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "archkeep-mcp-auth-"));
  created.push(root);
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
  writeAt("libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
  writeAt("libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
  writeAt("libs/adapter/adapter.go", "package adapter\n");
  writeAt("libs/app/go.mod", "module example.com/app\n\ngo 1.24\n");
  writeAt("libs/app/app.go", "package app\n");
  writeAt(
    "libs/domain/doc.go",
    violating
      ? `// Package domain is the layer everything else points at.
package domain

import (
	"example.com/adapter"
)

var _ = adapter.Name
`
      : `// Package domain is the layer everything else points at.
package domain
`,
  );
  if (intent !== null) {
    writeAt("architecture-intent.json", `${JSON.stringify(intent, null, 2)}\n`);
  }

  const graph = {
    nodes: {
      domain: {
        name: "domain",
        type: "lib",
        data: { root: "libs/domain", tags: ["type-package"] },
      },
      adapter: {
        name: "adapter",
        type: "lib",
        data: { root: "libs/adapter", tags: ["type-extension"] },
      },
      app: {
        name: "app",
        type: "lib",
        data: { root: "libs/app", tags: ["type-application"] },
      },
    },
    dependencies: {
      app: [{ source: "app", target: "domain", type: "static" }],
    },
  };
  if (violating) {
    graph.dependencies.domain = [{ source: "domain", target: "adapter", type: "static" }];
  }
  // `listFiles` is the engine's view of what is TRACKED: an intent file
  // written to disk but absent here is invisible to reconcile/drift, the
  // same way an untracked file is invisible to git.
  const files = [
    "nx.json",
    "module-boundaries.config.mjs",
    "libs/domain/go.mod",
    "libs/domain/doc.go",
    "libs/adapter/go.mod",
    "libs/adapter/adapter.go",
    "libs/app/go.mod",
    "libs/app/app.go",
    ...(intent !== null ? ["architecture-intent.json"] : []),
  ];
  const io = { readGraph: () => graph, listFiles: () => files };
  return { root, graph, io, writeAt };
}

/**
 * A directory with no workspace marker above it — the deterministic
 * "the engine must refuse, not wander" root, the same pattern the
 * `nowhere` fixtures in engine.test.mjs and server.test.mjs use.
 */
function nowhere() {
  const root = mkdtempSync(join(tmpdir(), "archkeep-mcp-auth-nowhere-"));
  created.push(root);
  return root;
}

/** The declared intent used by the reconcile/propose fixtures. */
const INTENT = {
  version: "1",
  boundaries: [
    { name: "packages", match: ["tag:type-package"] },
    { name: "extensions", match: ["tag:type-extension"] },
  ],
  dependencies: {
    forbidden: [{ source: "domain", target: "adapter" }],
  },
};

// ---------------------------------------------------------------------------
// Tree snapshot utility — recursive, hash-per-file
// ---------------------------------------------------------------------------

/**
 * Recursive snapshot: every file under root, keyed by relative path with its
 * content hashed. Hidden files and nested directories included. A write
 * anywhere in the tree — even a newly planted hidden file — is detected.
 *
 * @param {string} root
 * @returns {Map<string, string>}
 */
function treeSnapshot(root) {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        files.set(
          relative(root, full),
          createHash("sha256").update(readFileSync(full)).digest("hex"),
        );
      } else {
        files.set(relative(root, full), `other:${entry.name}`);
      }
    }
  };
  walk(root);
  return files;
}

/**
 * Asserts two snapshots are byte-identical, naming every changed file
 * instead of a count — the failure message tells a reviewer exactly what
 * moved.
 *
 * @param {Map<string, string>} before
 * @param {Map<string, string>} after
 */
function expectTreeUnchanged(before, after) {
  const createdPaths = [...after.keys()].filter((path) => !before.has(path));
  const deleted = [...before.keys()].filter((path) => !after.has(path));
  const modified = [...before.keys()].filter(
    (path) => after.has(path) && before.get(path) !== after.get(path),
  );
  expect(
    `created=${JSON.stringify(createdPaths)} deleted=${JSON.stringify(deleted)} ` +
      `modified=${JSON.stringify(modified)}`,
  ).toBe("created=[] deleted=[] modified=[]");
}

// ---------------------------------------------------------------------------
// MCP protocol helpers (for server-level tests)
// ---------------------------------------------------------------------------

/** One connected client–server pair; `io` is the injectable engine seams. */
async function connectedSession(io = {}) {
  const server = createServer(io);
  const client = new Client({ name: "authority-test", version: "0.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

// ===========================================================================
// a. propose NEVER writes
// ===========================================================================

describe("a. propose NEVER writes — every code path, the whole tree", () => {
  /**
   * INVARIANT: no tool in the MCP surface may create, modify, or delete a
   * file. `archkeep_propose` drafts candidates and returns them as data; it
   * never writes them to disk. A violation looks like: a proposal that
   * silently plants `architecture-intent.json`, rewrites an ADR two levels
   * down, or drops a scratch file in a hidden directory — authority wearing
   * a suggestion's name. The deep hash snapshot is the comparison that
   * catches it; a flat `readdirSync` of the root would not.
   */

  it("discover on a clean workspace writes nothing, detected by deep tree snapshot", async () => {
    // Seed hidden and nested files so the snapshot is non-trivial: a flat
    // readdirSync comparison would miss a write two levels deep.
    const w = workspace({ violating: false });
    w.writeAt(".archkeep/seed", "already here");
    w.writeAt("docs/adr/0001-existing.md", "---\nid: 0001\nstatus: accepted\n---\n\n# One\n");
    const io = {
      ...w.io,
      listFiles: () => [...w.io.listFiles(), ".archkeep/seed", "docs/adr/0001-existing.md"],
    };
    const before = treeSnapshot(w.root);
    const result = await proposeTool({ workspaceRoot: w.root, mode: "discover" }, io);
    expect(result.requiresApproval).toBe(true);
    expect(result.written).toBe(false);
    expectTreeUnchanged(before, treeSnapshot(w.root));
    // The intent file must not exist — a proposal that creates it has
    // crossed the authority boundary.
    expect(() => readFileSync(join(w.root, "architecture-intent.json"))).toThrow();
  });

  it("reconcile with a tracked intent writes nothing — not even a scratch file", async () => {
    const w = workspace({ violating: true, intent: INTENT });
    const before = treeSnapshot(w.root);
    const result = await proposeTool({ workspaceRoot: w.root, mode: "reconcile" }, w.io);
    expect(result.requiresApproval).toBe(true);
    expect(result.written).toBe(false);
    expect(result.result.proposed).toBe(true);
    expect(result.result.notAuthoritative).toBe(true);
    expectTreeUnchanged(before, treeSnapshot(w.root));
  });

  it("reconcile WITHOUT a tracked intent fails, writing nothing (the refusal path)", async () => {
    // The engine refuses reconcile on a workspace without a tracked intent
    // — but the refusal must not create one as a side effect. A "helpful"
    // auto-draft on refusal would be the silent direction of this invariant.
    const w = workspace({ violating: false });
    const before = treeSnapshot(w.root);
    await expect(proposeTool({ workspaceRoot: w.root, mode: "reconcile" }, w.io)).rejects.toThrow(
      /reconcile requires a tracked architecture-intent\.json/,
    );
    expectTreeUnchanged(before, treeSnapshot(w.root));
  });

  it("propose after other tool calls still writes nothing — cross-call state pollution", async () => {
    // A plausible bug: module-level state from a prior check or context
    // call leaks into propose and causes a side effect. Every call is
    // independent; no tool may dirty the tree for the next one.
    const w = workspace({ violating: false });
    const before = treeSnapshot(w.root);
    await checkTool({ workspaceRoot: w.root }, w.io);
    await contextTool({ workspaceRoot: w.root, project: "domain" }, w.io);
    await graphTool({ workspaceRoot: w.root }, w.io);
    const result = await proposeTool({ workspaceRoot: w.root, mode: "discover" }, w.io);
    expect(result.written).toBe(false);
    expectTreeUnchanged(before, treeSnapshot(w.root));
  });

  it("every tool preserves the filesystem — the nine-tool authority floor", async () => {
    // The invariant: ALL nine tools are read-only, not just propose. A
    // stray write in check, context, impact, or any other tool would
    // violate the surface the host trusts (`readOnlyHint` is what a host
    // uses to skip permission prompts). Each tool runs over the same
    // violating workspace, and the whole tree must be byte-identical
    // afterwards.
    const w = workspace({ violating: true, intent: INTENT });
    w.writeAt("docs/adr/0001-adr.md", "---\nid: 0001-adr\nstatus: accepted\n---\n\n# One\n");
    const io = {
      ...w.io,
      listFiles: () => [...w.io.listFiles(), "docs/adr/0001-adr.md"],
    };
    // The explain coordinates come from the run's own finding, the way
    // engine.test.mjs argues it: a fixture edit moves both sides together.
    const checkResult = await checkTool({ workspaceRoot: w.root }, io);
    const violation = checkResult.envelope.result.violations[0];

    const before = treeSnapshot(w.root);
    await contextTool({ workspaceRoot: w.root, project: "domain" }, io);
    await impactTool({ workspaceRoot: w.root, project: "domain" }, io);
    await driftTool({ workspaceRoot: w.root }, io);
    await explainTool(
      {
        workspaceRoot: w.root,
        file: violation.sourceFile,
        line: violation.line,
        column: violation.column,
      },
      io,
    );
    await graphTool({ workspaceRoot: w.root }, io);
    await historyTool({ workspaceRoot: w.root, evidence: "decisions" }, io);
    await proposeTool({ workspaceRoot: w.root, mode: "discover" }, io);
    await proposeTool({ workspaceRoot: w.root, mode: "reconcile" }, io);
    await scenarioTool(
      {
        workspaceRoot: w.root,
        projectName: "domain",
        scenarioJson: JSON.stringify({
          changes: [
            {
              type: "dependency_added",
              source: "adapter",
              target: "domain",
              edgeType: "static",
            },
          ],
        }),
      },
      io,
    );

    // The entire tree, every file, is byte-identical to before — nine
    // tools, zero writes.
    expectTreeUnchanged(before, treeSnapshot(w.root));
  });

  it("propose through the MCP protocol writes nothing — the surface a host sees", async () => {
    // The adapter-level tests prove the engine doesn't write; this proves
    // the protocol layer doesn't either — a host that connects over stdio
    // gets the same guarantee the in-process caller gets.
    const w = workspace({ violating: false });
    const before = treeSnapshot(w.root);
    const { server, client } = await connectedSession(w.io);
    const result = await client.callTool({
      name: "archkeep_propose",
      arguments: { workspaceRoot: w.root, mode: "discover" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      requiresApproval: true,
      authoritative: false,
      written: false,
    });
    expectTreeUnchanged(before, treeSnapshot(w.root));
    await client.close();
    await server.close();
  });
});

// ===========================================================================
// b. requiresApproval: true is respected
// ===========================================================================

describe("b. requiresApproval: true — the authority boundary markers", () => {
  /**
   * INVARIANT: every propose response carries `requiresApproval: true`,
   * `authoritative: false`, and `written: false`. Together they state the
   * contract: a suggestion, not a decision, and nothing was modified. A
   * violation looks like: a response missing the markers (a host that
   * branches on their presence silently adopts), or `requiresApproval:
   * false` (the approval gate appears already passed). `readOnlyHint` is
   * the same boundary announced to the host's permission layer.
   */

  it("discover always marks the proposal as non-authoritative and requiring approval", async () => {
    const w = workspace({ violating: false });
    const result = await proposeTool({ workspaceRoot: w.root, mode: "discover" }, w.io);
    expect(result.requiresApproval).toBe(true);
    expect(result.authoritative).toBe(false);
    expect(result.written).toBe(false);
    expect(result.mode).toBe("discover");
    expect(result.result.proposal.notAuthoritative).toBe(true);
  });

  it("reconcile always marks the proposal as non-authoritative and requiring approval", async () => {
    const w = workspace({ violating: true, intent: INTENT });
    const result = await proposeTool({ workspaceRoot: w.root, mode: "reconcile" }, w.io);
    expect(result.requiresApproval).toBe(true);
    expect(result.authoritative).toBe(false);
    expect(result.written).toBe(false);
    expect(result.mode).toBe("reconcile");
    expect(result.result.notAuthoritative).toBe(true);
  });

  it("propose through the MCP protocol always carries the three authority markers", async () => {
    // A host reads these fields to decide whether to prompt for approval;
    // a code path that dropped them would let the host skip the gate.
    for (const mode of ["discover", "reconcile"]) {
      const w = workspace({
        violating: mode === "reconcile",
        intent: mode === "reconcile" ? INTENT : null,
      });
      const { server, client } = await connectedSession(w.io);
      const result = await client.callTool({
        name: "archkeep_propose",
        arguments: { workspaceRoot: w.root, mode },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        requiresApproval: true,
        authoritative: false,
        written: false,
      });
      await client.close();
      await server.close();
    }
  });

  it("every tool announces readOnlyHint — no write capability on the surface", async () => {
    // The floor of the same boundary: if a tool shipped without the hint,
    // a host that trims permission prompts on `readOnlyHint` would allow
    // an unreviewed write.
    const { server, client } = await connectedSession();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
    await client.close();
    await server.close();
  });
});

// ===========================================================================
// c. Hostile arguments fail loud
// ===========================================================================

describe("c. hostile arguments fail loud — never silent, never destructive", () => {
  /**
   * INVARIANT: every malformed or adversarial argument produces a structured
   * error — `isError: true` with a non-empty message through the protocol,
   * a throw at the adapter level — never a silent empty result a host reads
   * as "nothing to report", and never a filesystem effect. A violation
   * looks like: an error swallowed into a clean empty envelope; a
   * traversal argument answering for a tree outside the workspace; a
   * crashed server; a null-byte path reaching fs mid-analysis.
   */

  it("path traversal in workspaceRoot is refused at the adapter's absolute-path gate", async () => {
    // A host that passes user input as workspaceRoot could be pointed at
    // any tree. Relative forms are refused outright — a relative path
    // would resolve against the server's own start directory, an anchor
    // the caller cannot see.
    for (const bad of ["../../etc/passwd", "../..", "libs", ".", ""]) {
      await expect(
        checkTool({ workspaceRoot: bad }, { readGraph: () => ({}), listFiles: () => [] }),
      ).rejects.toThrow(/workspaceRoot must be an absolute path/);
    }
  });

  it("path traversal in workspaceRoot is refused through the MCP protocol", async () => {
    // Through the protocol the same refusal is the input-mistake lane
    // (`Invalid input:` framing), and the response must never carry
    // content read from the traversal target.
    const { server, client } = await connectedSession();
    const result = await client.callTool({
      name: "archkeep_context",
      arguments: { workspaceRoot: "../../etc/passwd", project: "x" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("workspaceRoot must be an absolute path");
    // The response must NOT contain passwd file content — a leak here
    // would mean the engine answered for the traversal target.
    expect(result.content[0].text).not.toContain("root:");
    await client.close();
    await server.close();
  });

  it("an absolute out-of-workspace root is refused with no filesystem effect", async () => {
    // The absolute form is not refused by the gate (it IS absolute) — the
    // marker walk must refuse it because no workspace lives there, and
    // the fixture tree must be untouched by the attempt.
    const w = workspace({ violating: false });
    const before = treeSnapshot(w.root);
    const { server, client } = await connectedSession(w.io);
    const result = await client.callTool({
      name: "archkeep_context",
      arguments: { workspaceRoot: "/etc/passwd", project: "domain" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("root:");
    expectTreeUnchanged(before, treeSnapshot(w.root));
    await client.close();
    await server.close();
  });

  it("null byte in workspaceRoot is answered loud, never a silent empty", async () => {
    // check is the one tool whose contract for an unresolvable workspace
    // is the structured `unknown` verdict — fs.existsSync swallows the
    // null byte, the marker walk finds nothing, and the engine refuses to
    // guess. The loud direction here is NOT isError (that would pin the
    // wrong contract): it is runCompleted:false with a non-empty reason,
    // so a hostile path can never flatten into a clean "no findings".
    const { server, client } = await connectedSession();
    const result = await client.callTool({
      name: "archkeep_check",
      arguments: { workspaceRoot: "/tmp/test\0traversal" },
    });
    expect(result.isError).toBeFalsy();
    const payload = /** @type {any} */ (result.structuredContent);
    expect(payload.runCompleted).toBe(false);
    expect(payload.verdict).toBe("unknown");
    expect(payload.reason.length).toBeGreaterThan(0);
    await client.close();
    await server.close();
  });

  it("null byte in a file-path argument is refused", async () => {
    // Same class, different field: a \0 inside `file` must fail loudly at
    // the boundary, not be carried into the analyzer mid-run.
    const { server, client } = await connectedSession();
    const result = await client.callTool({
      name: "archkeep_explain",
      arguments: {
        workspaceRoot: "/tmp/valid\0path",
        file: "a.go\0b.go",
        line: 1,
        column: 1,
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text.length).toBeGreaterThan(0);
    await client.close();
    await server.close();
  });

  it("a 1 MiB argument does not crash the server — error or answer, never silence", async () => {
    // A hostile host may send absurdly long strings. The contract: the
    // server survives, the response is either an error with a message or
    // a genuine structured answer, and a follow-up call proves the
    // session is still alive. A regression that crashed the server would
    // fail the follow-up call.
    const nowhereRoot = nowhere();
    const longString = "x".repeat(1024 * 1024);
    const { server, client } = await connectedSession();
    const result = await client.callTool({
      name: "archkeep_context",
      arguments: { workspaceRoot: nowhereRoot, project: longString },
    });
    if (result.isError) {
      expect(result.content[0].text.length).toBeGreaterThan(0);
    } else {
      // Even a success must be the engine's structured answer, non-empty.
      expect(result.structuredContent).toBeDefined();
    }
    const alive = await client.callTool({
      name: "archkeep_graph",
      arguments: { workspaceRoot: nowhereRoot },
    });
    expect(alive).toBeDefined();
    await client.close();
    await server.close();
  });

  it("wrong type where a number is required is refused at the schema", async () => {
    // explain's line/column are ints; a string must fail schema
    // validation naming the field, before the engine is reached.
    const { server, client } = await connectedSession();
    const result = await client.callTool({
      name: "archkeep_explain",
      arguments: { file: "a.go", line: "not-a-number", column: 1 },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Input validation error");
    await client.close();
    await server.close();
  });

  it("wrong type where a string is required is refused at the schema", async () => {
    const { server, client } = await connectedSession();
    const result = await client.callTool({
      name: "archkeep_impact",
      arguments: { project: ["not", "a", "string"] },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Input validation error");
    await client.close();
    await server.close();
  });

  it("wrong type where an enum is required is refused at the schema", async () => {
    const { server, client } = await connectedSession();
    const result = await client.callTool({
      name: "archkeep_propose",
      arguments: { mode: { nested: "discover" } },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Input validation error");
    await client.close();
    await server.close();
  });

  it("completely empty arguments fail loud on every tool that declares a required field", async () => {
    // Six of the nine tools name a required field; for each, `{}` must be
    // a schema validation error before the engine runs. The other three
    // (check, drift, graph) declare every field optional — `{}` is
    // legitimate usage there ("answer for where the server was started"),
    // so the loud direction for them is the engine's own refusals, which
    // server.test.mjs's `nowhere` and missing-intent tests already pin.
    const requiredFieldTools = [
      "archkeep_context",
      "archkeep_impact",
      "archkeep_explain",
      "archkeep_history",
      "archkeep_propose",
      "archkeep_scenario",
    ];
    const { server, client } = await connectedSession();
    for (const name of requiredFieldTools) {
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.content[0].text.length).toBeGreaterThan(0);
    }
    await client.close();
    await server.close();
  });

  it("a malformed scenarioJson is refused with a parse error, through the protocol", async () => {
    // engine.test.mjs pins the adapter-level parse refusal; this pins the
    // protocol lane for the same hostile argument: an error result, not a
    // partial evaluation over corrupted input.
    const w = workspace({ violating: false });
    const { server, client } = await connectedSession(w.io);
    const result = await client.callTool({
      name: "archkeep_scenario",
      arguments: {
        workspaceRoot: w.root,
        projectName: "domain",
        scenarioJson: "{ not valid json {{{",
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/invalid JSON|JSON/i);
    await client.close();
    await server.close();
  });
});

// ===========================================================================
// d. Read-only tools under hostile sequences
// ===========================================================================

describe("d. read-only tools under hostile sequences — no state corruption", () => {
  /**
   * INVARIANT: the server holds no per-call mutable state that a failed or
   * hostile call can corrupt. Every violation shape below has a plausible
   * bug behind it: a failure cache that a later call reads; response
   * cross-contamination under concurrency; residue from a rejected
   * argument leaking into the next call; a refused call leaving the
   * server unable to answer.
   */

  it("a failed call does not corrupt the next calls on the same session", async () => {
    // Fail → succeed → fail → succeed on ONE session. A plausible bug:
    // the first failure leaves state that makes the next call fail or
    // answer stale data.
    const w = workspace({ violating: false });
    const { server, client } = await connectedSession(w.io);

    const fail1 = await client.callTool({
      name: "archkeep_propose",
      arguments: { workspaceRoot: w.root, mode: "reconcile" }, // no intent → refused
    });
    expect(fail1.isError).toBe(true);

    const ok1 = await client.callTool({
      name: "archkeep_graph",
      arguments: { workspaceRoot: w.root },
    });
    expect(ok1.isError).toBeFalsy();
    expect(/** @type {any} */ (ok1.structuredContent).command).toBe("graph");

    const fail2 = await client.callTool({
      name: "archkeep_context",
      arguments: { workspaceRoot: w.root, project: "no-such-project" },
    });
    expect(fail2.isError).toBe(true);

    const ok2 = await client.callTool({
      name: "archkeep_check",
      arguments: { workspaceRoot: w.root },
    });
    expect(ok2.isError).toBeFalsy();
    expect(/** @type {any} */ (ok2.structuredContent).verdict).toBe("pass");

    await client.close();
    await server.close();
  });

  it("interleaved propose + check + graph return independent, correct answers", async () => {
    // Three calls issued concurrently on one session: each must answer
    // its own question. Cross-contamination (propose's envelope arriving
    // as check's verdict) is the silent direction here.
    const w = workspace({ violating: true });
    const { server, client } = await connectedSession(w.io);

    const [proposeResult, checkResult, graphResult] = await Promise.all([
      client.callTool({
        name: "archkeep_propose",
        arguments: { workspaceRoot: w.root, mode: "discover" },
      }),
      client.callTool({
        name: "archkeep_check",
        arguments: { workspaceRoot: w.root },
      }),
      client.callTool({
        name: "archkeep_graph",
        arguments: { workspaceRoot: w.root },
      }),
    ]);

    expect(proposeResult.isError).toBeFalsy();
    expect(proposeResult.structuredContent).toMatchObject({
      command: "discover",
      requiresApproval: true,
      written: false,
    });

    expect(checkResult.isError).toBeFalsy();
    expect(/** @type {any} */ (checkResult.structuredContent).verdict).toBe("fail");

    expect(graphResult.isError).toBeFalsy();
    expect(/** @type {any} */ (graphResult.structuredContent).command).toBe("graph");

    await client.close();
    await server.close();
  });

  it("repeated propose calls are stable and never write", async () => {
    // Five sequential proposes: every response carries the same authority
    // markers. A plausible bug: an internal proposal cache or counter
    // that degrades across calls.
    const w = workspace({ violating: false });
    const before = treeSnapshot(w.root);
    const { server, client } = await connectedSession(w.io);
    for (let i = 0; i < 5; i++) {
      const result = await client.callTool({
        name: "archkeep_propose",
        arguments: { workspaceRoot: w.root, mode: "discover" },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        requiresApproval: true,
        authoritative: false,
        written: false,
      });
    }
    expectTreeUnchanged(before, treeSnapshot(w.root));
    await client.close();
    await server.close();
  });

  it("a rejected call with injected fields leaves no residue for the next call", async () => {
    // The strict schema refuses the unknown keys; the next call must work
    // normally — validation residue would be state corruption in the
    // silent direction.
    const w = workspace({ violating: false });
    const { server, client } = await connectedSession(w.io);

    const bad = await client.callTool({
      name: "archkeep_graph",
      arguments: { workspaceRoot: w.root, extraField: "hello", another: 42 },
    });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain("Input validation error");

    const ok = await client.callTool({
      name: "archkeep_graph",
      arguments: { workspaceRoot: w.root },
    });
    expect(ok.isError).toBeFalsy();
    expect(/** @type {any} */ (ok.structuredContent).command).toBe("graph");

    await client.close();
    await server.close();
  });

  it("an unknown tool name is refused without breaking the session", async () => {
    const w = workspace({ violating: false });
    const { server, client } = await connectedSession(w.io);

    const bad = await client.callTool({
      name: "archkeep_evil_tool",
      arguments: { workspaceRoot: w.root },
    });
    expect(bad.isError).toBe(true);

    const ok = await client.callTool({
      name: "archkeep_graph",
      arguments: { workspaceRoot: w.root },
    });
    expect(ok.isError).toBeFalsy();
    expect(/** @type {any} */ (ok.structuredContent).command).toBe("graph");

    await client.close();
    await server.close();
  });

  it("concurrent hostile calls error independently and write nothing", async () => {
    // Two hostile calls and one valid call, all concurrent: the errors
    // must land on the hostile calls only, the valid call must answer,
    // and no filesystem effect may occur from any of them.
    const w = workspace({ violating: false });
    const before = treeSnapshot(w.root);
    const { server, client } = await connectedSession(w.io);

    const [hostile1, hostile2, valid] = await Promise.all([
      client.callTool({
        name: "archkeep_context",
        arguments: { workspaceRoot: "../../etc/passwd", project: "x" },
      }),
      client.callTool({
        name: "archkeep_explain",
        arguments: { file: "a\0.go", line: 1, column: 1 },
      }),
      client.callTool({
        name: "archkeep_graph",
        arguments: { workspaceRoot: w.root },
      }),
    ]);

    expect(hostile1.isError).toBe(true);
    expect(hostile2.isError).toBe(true);
    expect(valid.isError).toBeFalsy();

    expectTreeUnchanged(before, treeSnapshot(w.root));
    await client.close();
    await server.close();
  });
});
