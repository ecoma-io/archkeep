#!/usr/bin/env node
// Proves the packed MCP server works for someone who is not this workspace —
// the `verify-package.mjs` discipline, applied to the third package this
// repository publishes to npm.
//
// WHY it needs its own script rather than an argument to that one: the
// questions there are an Nx workspace's questions (the plugin loads inside a
// real `nx graph`, the checker's exit contract, the language server). This
// package's consumer question is a different one — an agent host starts the
// bin over stdio and speaks MCP — and only one thing can answer it: a real
// initialize/tools/call conversation against the installed tarball.
//
// The first check is not hypothetical, and it is the reason this script exists
// rather than a test in the package's own suite. The manifest declares
// `"@ecoma-io/archkeep": "workspace:*"`, and `pnpm pack` rewrites that to the
// concrete version while `npm pack` — which is what `npm publish` runs —
// leaves it verbatim, because the repository root has no npm `workspaces`
// field for npm to read (measured here: `npm pack` shipped
// `"workspace:*"` byte for byte). A lane that verified a pnpm tarball and then
// ran bare `npm publish` would ship a dependency no registry consumer can
// install — the exact "a manifest that resolves nothing" defect
// `verify-package.mjs`'s header records from the engine's own history. The
// release lane therefore publishes THE TARBALL pnpm packed, and this script
// holds the property that makes that safe.
//
// The MCP conversation below is spoken as lines of JSON-RPC over the child's
// real stdio, with no SDK client anywhere — deliberately: the probe stays
// independent of the very code it verifies, the same reason
// `packages/archkeep/src/lsp.integration.test.mjs` drives bytes rather than a
// client library.
//
// Unix-only by design, like its siblings: it shells out to `npm`, `pnpm` and
// `git` by PATH, and every job in the release lane runs `ubuntu-latest`.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_DIR = "packages/archkeep-mcp";
const ENGINE_DIR = "packages/archkeep";

/** @type {string[]} */
const failures = [];

/** @param {string} text */
const note = (text) => console.log(text);

/**
 * @param {string} label
 * @param {boolean} ok
 * @param {string} [detail]
 */
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) failures.push(label);
};

/**
 * One command run to completion, its stdout captured — the only way this
 * script touches the outside world.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function run(command, args, cwd, env = process.env) {
  return spawnSync(command, args, { cwd, encoding: "utf8", env });
}

/**
 * The `dependencies["@ecoma-io/archkeep"]` value inside a packed tarball's
 * manifest, read without extracting anything.
 *
 * @param {string} tgzPath
 * @returns {string} the dependency string, or "?" when the manifest cannot be
 *   read — which fails every comparison loudly rather than skipping.
 */
function packedDependency(tgzPath) {
  const tar = run("tar", ["-xOf", tgzPath, "package/package.json"], root);
  if (tar.status !== 0) return "?";
  try {
    const manifest = JSON.parse(tar.stdout);
    return manifest.dependencies?.["@ecoma-io/archkeep"] ?? "?";
  } catch {
    return "?";
  }
}

/**
 * Drives one MCP conversation with a spawned `mcp.mjs`: initialize, then
 * `tools/list`, then one `tools/call` of `archkeep_check`, returning the
 * parsed results. The protocol on stdio is newline-delimited JSON-RPC 2.0 —
 * written here by hand, ~the forty lines an independent probe costs.
 *
 * @param {string} binPath absolute path to the installed `mcp.mjs`
 * @param {string} cwd the workspace the server answers for
 * @returns {{serverInfo: {name?: string, version?: string}, toolNames: string[],
 *   checkVerdict: string|null, checkText: string}} or throws on a protocol
 *   failure — a server that cannot hold a conversation is a failed check, not
 *   a skipped one.
 */
function converse(binPath, cwd) {
  // The bin path travels by environment rather than argv: under `-e`, the
  // argument vector belongs to the inline program, and an env var cannot be
  // mis-parsed into a module path.
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", CONVERSATION_DRIVER], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, VERIFY_MCP_BIN: binPath },
  });
  if (child.status !== 0) {
    throw new Error(`the conversation driver exited ${child.status}: ${child.stderr}`);
  }
  return JSON.parse(child.stdout);
}

/**
 * The driver, as source: spawns the bin, writes the three requests as JSON
 * lines, reads one line per response, prints the distilled answers as JSON.
 * Kept as a string so it runs in a clean child process with no imports from
 * this script's context.
 */
const CONVERSATION_DRIVER = `
import { spawn } from "node:child_process";
const bin = process.env.VERIFY_MCP_BIN;
const child = spawn(process.execPath, [bin], { stdio: ["pipe", "pipe", "inherit"] });
let buffer = "";
const pending = new Map();
let nextId = 1;
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const lines = buffer.split("\\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});
const request = (method, params) =>
  new Promise((resolveCall, rejectCall) => {
    const id = nextId++;
    pending.set(id, (message) => {
      if (message.error) rejectCall(new Error(method + ": " + JSON.stringify(message.error)));
      else resolveCall(message.result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
  });
const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\\n");
const initialize = await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "verify-mcp-package", version: "0.0.0" },
});
notify("notifications/initialized");
const tools = await request("tools/list", {});
const check = await request("tools/call", {
  name: "archkeep_check",
  arguments: {},
});
const structured = check.structuredContent ?? {};
console.log(
  JSON.stringify({
    serverInfo: initialize.serverInfo,
    toolNames: tools.tools.map((tool) => tool.name),
    checkVerdict: structured.verdict ?? null,
    checkText: (check.content ?? []).map((block) => block.text ?? "").join(""),
  }),
);
child.stdin.end();
`;

/**
 * A native fixture workspace: `archkeep.json` with declared projects, the
 * boundary law beside it, Go sources, and a git history so the engine's own
 * tracked-file read answers. `violating` writes the one import that crosses
 * the law.
 *
 * @param {string} parent
 * @param {{violating: boolean}} options
 * @returns {string} the fixture root
 */
function fixtureWorkspace(parent, { violating }) {
  const dir = join(parent, violating ? "violating-fixture" : "clean-fixture");
  mkdirSync(join(dir, "libs/core"), { recursive: true });
  mkdirSync(join(dir, "libs/ui"), { recursive: true });
  const write = (relativePath, text) => writeFileSync(join(dir, relativePath), text);
  write(
    "archkeep.json",
    `${JSON.stringify(
      {
        projects: {
          declared: [
            { root: "libs/core", name: "core", type: "lib", tags: ["type-package"] },
            { root: "libs/ui", name: "ui", type: "lib", tags: ["type-extension"] },
          ],
        },
        coverage: {
          exempt: [{ path: "*.mjs", reason: "root tool configuration, owned by no project" }],
        },
        boundaryConfig: "module-boundaries.config.mjs",
      },
      null,
      2,
    )}\n`,
  );
  write(
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
  write("libs/core/go.mod", "module example.com/core\n\ngo 1.24\n");
  write("libs/ui/go.mod", "module example.com/ui\n\ngo 1.24\n");
  write("libs/ui/ui.go", "package ui\n");
  write(
    "libs/core/core.go",
    violating
      ? `package core

import (
	"example.com/ui"
)

var _ = ui.Name
`
      : "package core\n",
  );
  const git = run("git", ["init", "-q"], dir);
  if (git.status !== 0) throw new Error(`git init failed in ${dir}`);
  run("git", ["add", "-A"], dir);
  const commit = run(
    "git",
    [
      "-c",
      "user.name=verify",
      "-c",
      "user.email=verify@invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    ],
    dir,
  );
  if (commit.status !== 0) throw new Error(`git commit failed in ${dir}`);
  return dir;
}

// The version both tarballs are expected to carry — read from the manifest
// release-please bumps, never restated here.
const ownVersion = JSON.parse(
  readFileSync(join(root, PACKAGE_DIR, "package.json"), "utf8"),
).version;

/** The checks, in the order a consumer meets them. Exits non-zero on any failure. */
function main() {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "verify-mcp-")));

  try {
    note(`verifying ${PACKAGE_DIR} for a consumer who is not this workspace\n`);

    // 1. The pairing the release promises: pnpm's packed manifest names the
    //    engine by the version it ships with — a concrete number, never the
    //    workspace protocol npm cannot install. The pack directory lives
    //    inside the throwaway workspace so the `finally` below removes it
    //    with everything else.
    const packDir = join(workspace, "pack");
    mkdirSync(packDir);
    const enginePack = run("pnpm", ["pack", "--pack-destination", packDir], join(root, ENGINE_DIR));
    const mcpPack = run("pnpm", ["pack", "--pack-destination", packDir], join(root, PACKAGE_DIR));
    if (enginePack.status !== 0 || mcpPack.status !== 0) {
      console.error("`pnpm pack` failed, so there is no artifact to verify.");
      process.exit(1);
    }
    const engineTgz = join(packDir, `ecoma-io-archkeep-${ownVersion}.tgz`);
    const mcpTgz = join(packDir, `ecoma-io-archkeep-mcp-${ownVersion}.tgz`);
    const dependency = packedDependency(mcpTgz);
    check(
      "the pnpm tarball depends on the engine by its shipped version",
      dependency === ownVersion,
      `dependencies["@ecoma-io/archkeep"] = "${dependency}", package version = ${ownVersion}`,
    );

    // 2. Both tarballs install into a throwaway consumer workspace — the pair
    //    one release ships, resolved the way a consumer resolves them.
    const consumer = join(workspace, "consumer");
    mkdirSync(consumer, { recursive: true });
    writeFileSync(join(consumer, "package.json"), '{"name":"throwaway","private":true}\n');
    const install = run("npm", ["install", "--no-audit", "--no-fund", engineTgz, mcpTgz], consumer);
    check(
      "the packed pair installs into a throwaway workspace",
      install.status === 0,
      install.status === 0 ? "" : (install.stderr ?? "").split("\n").slice(-3).join(" "),
    );

    const installedBin = join(consumer, "node_modules", "@ecoma-io", "archkeep-mcp", "mcp.mjs");

    // 3. The installed bin answers initialize and lists the nine tools.
    const clean = fixtureWorkspace(workspace, { violating: false });
    const conversation = converse(installedBin, clean);
    check(
      "the installed bin announces itself",
      conversation.serverInfo?.name === "archkeep-mcp" &&
        conversation.serverInfo?.version === ownVersion,
      `serverInfo = ${JSON.stringify(conversation.serverInfo)}`,
    );
    check(
      "the installed bin lists the nine tools",
      conversation.toolNames.length === 9,
      conversation.toolNames.join(", "),
    );

    // 4. The verdict, both directions. A verifier only proves a server runs
    //    when it can go red: the clean fixture must answer `pass` and the
    //    violating one `fail`, read off the structured result — the same
    //    three-state contract the CLI's exit codes carry.
    check(
      "check answers pass on a clean workspace",
      conversation.checkVerdict === "pass",
      `verdict = ${conversation.checkVerdict}; text: ${conversation.checkText.slice(0, 200)}`,
    );
    const violating = fixtureWorkspace(workspace, { violating: true });
    const red = converse(installedBin, violating);
    check(
      "check answers fail on a violating workspace",
      red.checkVerdict === "fail",
      `verdict = ${red.checkVerdict}`,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }

  note("");
  if (failures.length > 0) {
    console.error(
      `${failures.length} check${failures.length === 1 ? "" : "s"} failed, so this tarball is not fit to publish. ` +
        `An npm version cannot be unpublished away.`,
    );
    process.exit(1);
  }
  note("every check passed.");
}

/**
 * Whether this file was RUN rather than imported, compared on real paths.
 * See `check-packages.mjs` for the reason this exists and why it is not shared.
 */
function isProgramEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}

if (isProgramEntry(import.meta.url)) main();
