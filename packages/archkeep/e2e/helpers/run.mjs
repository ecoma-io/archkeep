// Executes the real `archkeep` executable from an installed consumer workspace.
//
// E2E tests never import `../../src/` or any package export. They invoke the
// public bin shim written by pnpm (`pnpm exec archkeep`) and assert only on
// observable process behavior: exit code, stdout, stderr, and structured JSON.
import { spawnSync } from "node:child_process";

/**
 * @typedef {object} CliResult
 * @property {number | null} exitCode Process exit code; null if killed by signal.
 * @property {string} stdout Captured stdout.
 * @property {string} stderr Captured stderr.
 * @property {any | null} json Parsed stdout when valid JSON, otherwise null.
 * @property {NodeJS.Signals | null} signal Signal that killed the process, if any.
 */

/**
 * Runs the installed public `archkeep` CLI.
 *
 * @param {string} consumerRoot Absolute path to the installed consumer.
 * @param {string[]} args CLI arguments after `archkeep`.
 * @param {{ timeout?: number }} [options]
 * @returns {CliResult}
 */
export function archkeep(consumerRoot, args, options = {}) {
  const result = spawnSync("pnpm", ["exec", "archkeep", ...args], {
    cwd: consumerRoot,
    encoding: "utf8",
    env: { ...process.env, NX_DAEMON: "false" },
    timeout: options.timeout ?? 60_000,
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    // Non-JSON output is expected for text-format commands. Tests that require
    // JSON assert `json !== null`, making parse failures loud with stdout shown.
  }

  return {
    exitCode: result.status,
    stdout,
    stderr,
    json,
    signal: result.signal,
  };
}
