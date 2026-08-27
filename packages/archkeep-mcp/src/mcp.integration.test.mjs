// The shipped entry, driven as a host drives it: `node mcp.mjs` spawned over
// real pipes, spoken to through the SDK's own stdio client transport. The
// in-process suites (`./engine.test.mjs`, `./server.test.mjs`) prove the
// adapters and the registration; only a real process proves the bin wires
// stdio correctly — the same reason `../../archkeep/src/cli.integration.test.mjs`
// spawns the real executable rather than calling `runCli` alone.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** This package's root — the bin sits beside `src/`. */
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
/** This repository's root — a real Moon workspace, the second workspace below. */
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** A connected client over a spawned `mcp.mjs`, started in `cwd`. */
async function spawnServer(cwd) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(packageRoot, "mcp.mjs")],
    cwd,
    stderr: "pipe",
  });
  const client = new Client({ name: "integration", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}

const spawned = [];
afterAll(async () => {
  for (const { client } of spawned) await client.close();
});

describe("the shipped stdio entry", () => {
  it("completes the initialize handshake and lists the eight tools", async () => {
    const session = await spawnServer(packageRoot);
    spawned.push(session);
    const { client } = session;
    expect(client.getServerVersion()?.name).toBe("archkeep-mcp");
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(8);
    expect(tools.map((tool) => tool.name)).toContain("archkeep_check");
  });

  // A real process over real pipes: the server boots, loads the engine, and
  // runs a check on a throwaway tree before this answers. Vitest's 5 s
  // default is a coin flip on that under parallel load — measured twice,
  // 8 Moon tasks running concurrently, this exact test timing out at 5 s and
  // then passing alone — so the budget names what the test costs instead of
  // hoping for an idle machine.
  it(
    "answers a check on a markerless tree as unknown, not fail, over real pipes",
    { timeout: 30_000 },
    async () => {
      const nowhere = mkdtempSync(join(tmpdir(), "archkeep-mcp-int-nowhere-"));
      try {
        const session = await spawnServer(packageRoot);
        spawned.push(session);
        const result = await session.client.callTool({
          name: "archkeep_check",
          arguments: { workspaceRoot: nowhere },
        });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          runCompleted: false,
          verdict: "unknown",
        });
      } finally {
        rmSync(nowhere, { recursive: true, force: true });
      }
    },
  );

  it("checks this repository's own workspace end to end", { timeout: 60_000 }, async () => {
    // The full stack over the real provider: this repository is a Moon
    // workspace, so the spawned server spawns `moon project-graph` for real.
    // The verdict itself is whatever this tree deserves on the day — asserted
    // only to be one of the three states, never pinned to "pass", so this
    // test proves the pipe works without becoming a second gate on the
    // repository's own boundaries.
    //
    // The explicit timeout is the same sentence the engine's own suite
    // writes for its ESLint-config case: this test does REAL work whose cost
    // vitest's 5s default was never sized for — two process spawns and a
    // `moon project-graph` computation — and under `moon run`'s parallel
    // task load it measured past 5s while running green alone. A timeout
    // that fires here reads like a protocol failure, which it is not.
    const session = await spawnServer(repoRoot);
    spawned.push(session);
    const result = await session.client.callTool({
      name: "archkeep_check",
      arguments: { workspaceRoot: repoRoot },
    });
    expect(result.isError).toBeFalsy();
    const payload = /** @type {any} */ (result.structuredContent);
    expect(payload.runCompleted).toBe(true);
    expect(["pass", "fail", "unknown"]).toContain(payload.verdict);
    expect(payload.envelope.workspace.provider).toBe("moon");
  });
});

describe("the packed artifact", () => {
  it("selects the files an install needs and no test file", { timeout: 60_000 }, () => {
    // `npm pack --dry-run --json` names every file the registry tarball
    // would carry, without writing one — the same question
    // `scripts/verify-vsix.mjs` asks of the extension's artifact. A
    // `files` entry that stopped matching reality (a renamed module, a
    // forgotten `!` negation) installs cleanly and dies at the first
    // `import`, which no in-source test sees; this is the one that does.
    // The engine package ships beside it in the same release, so the
    // `@ecoma-io/archkeep` dependency is not proven here — its own lane
    // proves it.
    const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: 50_000,
    });
    expect(result.status).toBe(0);
    const files = JSON.parse(result.stdout).flatMap((entry) => entry.files.map(({ path }) => path));
    for (const required of [
      "index.mjs",
      "mcp.mjs",
      "src/engine.mjs",
      "src/server.mjs",
      "package.json",
      "README.md",
      "LICENSE",
    ]) {
      expect(files).toContain(required);
    }
    expect(files.some((path) => path.endsWith(".test.mjs"))).toBe(false);
  });
});
