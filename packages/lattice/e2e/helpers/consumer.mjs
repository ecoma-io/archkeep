// Creates, installs, and tears down consumer workspaces for E2E tests.
//
// Each consumer is an independent git repository in an OS temp directory,
// outside this workspace, with the packed artifact installed through pnpm.
// This is the same contract `scripts/verify-package.mjs` proves — a real
// `pnpm pack` tarball installed into a tree this repository never built —
// but structured for Vitest lifecycle management rather than inline checks.
//
// Every consumer is `git init`-ed and committed before any command runs,
// because Lattice discovers files via `git ls-files` and a workspace with
// nothing committed is an empty workspace — the exact silent failure the
// E2E suite exists to catch.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { driftConsumerFiles } from "../fixtures/drift-consumer.mjs";
import { nxConsumerFiles } from "../fixtures/nx-consumer.mjs";
import { nativeConsumerFiles } from "../fixtures/native-consumer.mjs";
import { nativeMonorepoFiles } from "../fixtures/native-monorepo.mjs";
import { moonConsumerFiles } from "../fixtures/moon-consumer.mjs";
import { goLanguageFiles } from "../fixtures/languages/go.mjs";
import { typescriptLanguageFiles } from "../fixtures/languages/typescript.mjs";
import { javascriptLanguageFiles } from "../fixtures/languages/javascript.mjs";
import { vueLanguageFiles } from "../fixtures/languages/vue.mjs";
import { rustLanguageFiles } from "../fixtures/languages/rust.mjs";
import { pythonLanguageFiles } from "../fixtures/languages/python.mjs";

/**
 * Writes a file map into a base directory, creating intermediate directories.
 *
 * @param {string} base Absolute path to the consumer root.
 * @param {Record<string, string>} files Relative path → contents.
 */
const write = (base, files) => {
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(base, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, "utf8");
  }
};

/**
 * `git add -A` + commit. Uses `-c` for identity since CI runners have no
 * `user.email` set, and disables GPG signing for throwaway trees.
 *
 * @param {string} consumer Absolute path to the consumer workspace.
 * @param {string} message Commit message.
 * @param {boolean} fresh Run `git init` first.
 */
function commitTree(consumer, message, fresh) {
  if (fresh) run("git", ["init", "-q"], consumer);
  run("git", ["add", "-A"], consumer);
  run(
    "git",
    [
      "-c",
      "user.name=lattice-e2e",
      "-c",
      "user.email=lattice-e2e@invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      message,
    ],
    consumer,
  );
}

/**
 * Writes additional files into an existing consumer and commits them.
 * Used by violation scenarios that mutate a clean tree.
 *
 * @param {string} consumer Absolute path to the consumer workspace.
 * @param {Record<string, string>} files Relative path → contents.
 * @param {string} message Commit message.
 */
export function commitFiles(consumer, files, message) {
  write(consumer, files);
  commitTree(consumer, message, false);
}

/** Runs a command, capturing everything. Argument array — never a shell string. */
function run(command, args, cwd, extraEnv = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NX_DAEMON: "false", ...extraEnv },
  });
}

/**
 * @typedef {object} ConsumerWorkspace
 * @property {string} root Absolute path to the consumer workspace root.
 * @property {() => void} cleanup Removes the consumer directory.
 */

/**
 * Creates an Nx consumer workspace: two Go projects, `nx.json` with the
 * plugin registered, `pnpm install` with the packed tarball.
 *
 * @param {{ tarballPath: string, peers: Record<string, string>, packageName: string, packageManager: string }} artifact
 * @returns {ConsumerWorkspace}
 */
export function createNxConsumer(artifact) {
  const { tarballPath, peers, packageName, packageManager } = artifact;
  const consumer = realpathSync(mkdtempSync(join(tmpdir(), "lattice-e2e-nx-")));

  const files = nxConsumerFiles(packageName, peers, packageManager);
  files["package.json"] = files["package.json"].replace(
    '"*"',
    JSON.stringify(`file:${tarballPath}`),
  );
  write(consumer, files);
  // `allowBuilds` blocks pnpm 11 lifecycle scripts until the workspace
  // decides — same reasoning as `scripts/verify-package.mjs`.
  writeFileSync(
    join(consumer, "pnpm-workspace.yaml"),
    "packages: []\nallowBuilds:\n  lefthook: false\n  nx: false\n",
    "utf8",
  );
  commitTree(consumer, "the clean tree", true);

  const installed = run("pnpm", ["install", "--no-frozen-lockfile"], consumer);
  if (installed.status !== 0) {
    rmSync(consumer, { recursive: true, force: true });
    throw new Error(
      `pnpm install failed (Nx consumer):\n${installed.stdout ?? ""}\n${installed.stderr ?? ""}`,
    );
  }

  return {
    root: consumer,
    cleanup() {
      rmSync(consumer, { recursive: true, force: true });
    },
  };
}

/**
 * Creates a native consumer workspace: two Go projects, `lattice.json`
 * at the root, no `nx` dependency, `pnpm install` with the packed tarball.
 *
 * @param {{ tarballPath: string, peers: Record<string, string>, packageName: string, packageManager: string }} artifact
 * @returns {ConsumerWorkspace}
 */
export function createNativeConsumer(artifact) {
  const { tarballPath, peers, packageName, packageManager } = artifact;
  const consumer = realpathSync(mkdtempSync(join(tmpdir(), "lattice-e2e-native-")));

  const files = nativeConsumerFiles(packageName, peers, packageManager);
  files["package.json"] = files["package.json"].replace(
    '"*"',
    JSON.stringify(`file:${tarballPath}`),
  );
  write(consumer, files);
  writeFileSync(
    join(consumer, "pnpm-workspace.yaml"),
    "packages: []\nallowBuilds:\n  lefthook: false\n",
    "utf8",
  );
  commitTree(consumer, "the clean tree", true);

  const installed = run("pnpm", ["install", "--no-frozen-lockfile"], consumer);
  if (installed.status !== 0) {
    rmSync(consumer, { recursive: true, force: true });
    throw new Error(
      `pnpm install failed (native consumer):\n${installed.stdout ?? ""}\n${installed.stderr ?? ""}`,
    );
  }

  // Assert `nx` does NOT resolve — the peer is optional in fact, not only
  // in `peerDependenciesMeta`. Same check as `scripts/verify-package.mjs`.
  const nativeModules = existsSync(join(consumer, "node_modules"))
    ? readdirSync(join(consumer, "node_modules"))
    : [];
  if (nativeModules.includes("nx")) {
    rmSync(consumer, { recursive: true, force: true });
    throw new Error(
      `nx package resolved in native consumer — peer is not optional in fact.\nnode_modules: ${nativeModules.join(", ")}`,
    );
  }

  return {
    root: consumer,
    cleanup() {
      rmSync(consumer, { recursive: true, force: true });
    },
  };
}

/**
 * Creates a native monorepo consumer: three Go projects (core, api, app)
 * with a dependency chain `app → api → core`, `lattice.json` at the root,
 * no `nx` dependency. Proves "monorepo ≠ Nx" — multiple internal projects
 * with real dependency chains, all native.
 *
 * @param {{ tarballPath: string, peers: Record<string, string>, packageName: string, packageManager: string }} artifact
 * @returns {ConsumerWorkspace}
 */
export function createNativeMonorepoConsumer(artifact) {
  const { tarballPath, peers, packageName, packageManager } = artifact;
  const consumer = realpathSync(mkdtempSync(join(tmpdir(), "lattice-e2e-native-mono-")));

  const files = nativeMonorepoFiles(packageName, peers, packageManager);
  files["package.json"] = files["package.json"].replace(
    '"*"',
    JSON.stringify(`file:${tarballPath}`),
  );
  write(consumer, files);
  writeFileSync(
    join(consumer, "pnpm-workspace.yaml"),
    "packages: []\nallowBuilds:\n  lefthook: false\n",
    "utf8",
  );
  commitTree(consumer, "the clean tree", true);

  const installed = run("pnpm", ["install", "--no-frozen-lockfile"], consumer);
  if (installed.status !== 0) {
    rmSync(consumer, { recursive: true, force: true });
    throw new Error(
      `pnpm install failed (native monorepo):\n${installed.stdout ?? ""}\n${installed.stderr ?? ""}`,
    );
  }

  const nativeModules = existsSync(join(consumer, "node_modules"))
    ? readdirSync(join(consumer, "node_modules"))
    : [];
  if (nativeModules.includes("nx")) {
    rmSync(consumer, { recursive: true, force: true });
    throw new Error(`nx package resolved in native monorepo — peer is not optional in fact.`);
  }

  return {
    root: consumer,
    cleanup() {
      rmSync(consumer, { recursive: true, force: true });
    },
  };
}

/**
 * Creates a drift consumer workspace: the native monorepo (`app → api → core`)
 * plus an `architecture-intent.config.mjs` at the root declaring the intended
 * architecture. `intent` is default-exported by that module, the exact
 * contract `loadIntent` recovers. No `nx` dependency.
 *
 * @param {{ tarballPath: string, peers: Record<string, string>, packageName: string, packageManager: string }} artifact
 * @param {object} intent The intended-architecture object to default-export.
 * @returns {ConsumerWorkspace}
 */
export function createDriftConsumer(artifact, intent) {
  const { tarballPath, peers, packageName, packageManager } = artifact;
  const consumer = realpathSync(mkdtempSync(join(tmpdir(), "lattice-e2e-drift-")));

  const files = driftConsumerFiles(packageName, peers, packageManager, intent);
  files["package.json"] = files["package.json"].replace(
    '"*"',
    JSON.stringify(`file:${tarballPath}`),
  );
  write(consumer, files);
  writeFileSync(
    join(consumer, "pnpm-workspace.yaml"),
    "packages: []\nallowBuilds:\n  lefthook: false\n",
    "utf8",
  );
  commitTree(consumer, "the clean tree", true);

  const installed = run("pnpm", ["install", "--no-frozen-lockfile"], consumer);
  if (installed.status !== 0) {
    rmSync(consumer, { recursive: true, force: true });
    throw new Error(
      `pnpm install failed (drift consumer):\n${installed.stdout ?? ""}\n${installed.stderr ?? ""}`,
    );
  }

  return {
    root: consumer,
    cleanup() {
      rmSync(consumer, { recursive: true, force: true });
    },
  };
}

/**
 * Creates a Moonrepo consumer workspace: three projects (web, api, core)
 * with `.moon/workspace.yml`, per-project `moon.yml` files, TypeScript and
 * Go sources, no `nx` dependency. Proves Lattice's Moon provider works
 * against a real Moon workspace through the installed CLI.
 *
 * @param {{ tarballPath: string, peers: Record<string, string>, packageName: string, packageManager: string }} artifact
 * @returns {ConsumerWorkspace}
 */
export function createMoonConsumer(artifact) {
  const { tarballPath, peers, packageName, packageManager } = artifact;
  const consumer = realpathSync(mkdtempSync(join(tmpdir(), "lattice-e2e-moon-")));

  const files = moonConsumerFiles(packageName, peers, packageManager);
  files["package.json"] = files["package.json"].replace(
    '"*"',
    JSON.stringify(`file:${tarballPath}`),
  );
  write(consumer, files);
  // The Moon fixture provides its own `pnpm-workspace.yaml` with workspace
  // packages, so the default one is not written.
  commitTree(consumer, "the clean tree", true);

  const installed = run("pnpm", ["install", "--no-frozen-lockfile"], consumer);
  if (installed.status !== 0) {
    rmSync(consumer, { recursive: true, force: true });
    throw new Error(
      `pnpm install failed (Moon consumer):\n${installed.stdout ?? ""}\n${installed.stderr ?? ""}`,
    );
  }

  // Assert `nx` does NOT resolve — the peer is optional in fact, not only
  // in `peerDependenciesMeta`. Same check as `scripts/verify-package.mjs`.
  const consumerModules = existsSync(join(consumer, "node_modules"))
    ? readdirSync(join(consumer, "node_modules"))
    : [];
  if (consumerModules.includes("nx")) {
    rmSync(consumer, { recursive: true, force: true });
    throw new Error(
      `nx package resolved in Moon consumer — peer is not optional in fact.\nnode_modules: ${consumerModules.join(", ")}`,
    );
  }

  return {
    root: consumer,
    cleanup() {
      rmSync(consumer, { recursive: true, force: true });
    },
  };
}

/**
 * Lookup from a language name to its fixture function. Each fixture returns
 * a `Record<string, string>` file map with three projects (domain,
 * application, api) and language-specific source files.
 *
 * @type {Record<string, (packageName: string, peers: Record<string, string>, packageManager: string) => Record<string, string>>}
 */
const LANGUAGE_FIXTURES = {
  go: goLanguageFiles,
  typescript: typescriptLanguageFiles,
  javascript: javascriptLanguageFiles,
  vue: vueLanguageFiles,
  rust: rustLanguageFiles,
  python: pythonLanguageFiles,
};

/**
 * Creates a native language consumer workspace: three projects described in
 * `lattice.json`, with source files in the given language, no `nx`
 * dependency. Proves that Lattice's analysis, graph construction, and
 * boundary enforcement work for a specific language through the real
 * installed CLI.
 *
 * @param {{ tarballPath: string, peers: Record<string, string>, packageName: string, packageManager: string }} artifact
 * @param {string|((packageName: string, peers: Record<string, string>, packageManager: string) => Record<string, string>)} languageOrFn
 *   Either a language name (`"go"`, `"typescript"`, etc.) looked up in
 *   `LANGUAGE_FIXTURES`, or a fixture function passed directly.
 * @returns {ConsumerWorkspace}
 */
export function createNativeLanguageConsumer(artifact, languageOrFn) {
  const fixtureFn =
    typeof languageOrFn === "function" ? languageOrFn : LANGUAGE_FIXTURES[languageOrFn];
  if (!fixtureFn) {
    throw new Error(
      `Unknown language fixture '${languageOrFn}'. ` +
        `Available: ${Object.keys(LANGUAGE_FIXTURES).join(", ")}`,
    );
  }

  const { tarballPath, peers, packageName, packageManager } = artifact;
  const consumer = realpathSync(mkdtempSync(join(tmpdir(), "lattice-e2e-lang-")));

  const files = fixtureFn(packageName, peers, packageManager);
  files["package.json"] = files["package.json"].replace(
    '"*"',
    JSON.stringify(`file:${tarballPath}`),
  );
  write(consumer, files);
  // Write `pnpm-workspace.yaml` only if the fixture didn't provide one.
  // Fixtures with pnpm workspace packages (e.g. JavaScript) supply their
  // own with the correct `packages:` list and `allowBuilds` config.
  if (!files["pnpm-workspace.yaml"]) {
    writeFileSync(
      join(consumer, "pnpm-workspace.yaml"),
      "packages: []\nallowBuilds:\n  lefthook: false\n",
      "utf8",
    );
  }
  commitTree(consumer, "the clean tree", true);

  const installed = run("pnpm", ["install", "--no-frozen-lockfile"], consumer);
  if (installed.status !== 0) {
    rmSync(consumer, { recursive: true, force: true });
    throw new Error(
      `pnpm install failed (${typeof languageOrFn === "string" ? languageOrFn : "custom"} language consumer):\n${installed.stdout ?? ""}\n${installed.stderr ?? ""}`,
    );
  }

  const nativeModules = existsSync(join(consumer, "node_modules"))
    ? readdirSync(join(consumer, "node_modules"))
    : [];
  if (nativeModules.includes("nx")) {
    rmSync(consumer, { recursive: true, force: true });
    throw new Error(
      `nx package resolved in ${typeof languageOrFn === "string" ? languageOrFn : "custom"} language consumer — peer is not optional in fact.`,
    );
  }

  return {
    root: consumer,
    cleanup() {
      rmSync(consumer, { recursive: true, force: true });
    },
  };
}
