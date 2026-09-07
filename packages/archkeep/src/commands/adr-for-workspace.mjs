/**
 * The `adr` preamble, composed once: the workspace root walked up from a
 * working directory, the tracked file list, then `./adr.mjs`'s `adrCommand`.
 * `../../cli.mjs`'s `runAdr` and the MCP history adapter
 * (`../../../archkeep-mcp/src/engine.mjs`) each inlined these three steps,
 * and the adapter's copy reached past the `./commands` subpath into the
 * engine's root entry for `findWorkspaceRoot` and `listTrackedFiles` — the
 * one import in that package that made it something other than a client of
 * the command layer. The composition lives here, beside the command it
 * feeds, so both faces run one path and neither needs the root entry for it.
 *
 * It holds no policy of its own. The two preamble decisions move verbatim,
 * because inventing either here would be a second opinion about what a
 * workspace is:
 *
 * - the root is `findWorkspaceRoot(cwd, WORKSPACE_MARKERS)` — the same
 *   marker list `./context.mjs`'s `resolveCommandContext` walks, whose own
 *   header owns why callers of a workspace root may not differ in what a
 *   workspace root IS;
 * - the files are `(io.listFiles ?? listTrackedFiles)(root)` — the injectable
 *   default every command reads through, so a test drives the read over a
 *   fixture tree with no git.
 *
 * Everything a caller might decide stays with the caller. The `null` — no
 * ancestor of `cwd` is a workspace root — is the caller's refusal to render,
 * never an answer: the CLI words its own refusal and picks its own exit
 * code, the adapter throws its own, and a caller that ignored the null
 * crashes one line later instead of reading a clean result. The throws
 * (`adrCommand`'s unreadable registry, `listTrackedFiles`' failed
 * `git ls-files`) propagate unchanged for the same reason. And it prints no
 * byte and decides no exit code, so it is not one of the `run*` drivers
 * `../../commands.mjs` leaves to `../../cli.mjs` — it returns exactly what
 * the command returns.
 */
import { findWorkspaceRoot, listTrackedFiles } from "../workspace.mjs";

import { adrCommand } from "./adr.mjs";
import { WORKSPACE_MARKERS } from "./context.mjs";

/**
 * Runs the `adr` command for the workspace `cwd` falls in.
 *
 * @param {{cwd: string}} request The working directory the root is walked up
 *   from — the same walk `resolveCommandContext` makes, without the project
 *   graph it builds.
 * @param {{id?: string}} [options] Forwarded to `adrCommand` unchanged.
 * @param {{listFiles?: Function}} [io] The tracked-file seam, typed like
 *   every command's (`Function`, the shape `./check.mjs` and
 *   `./context.mjs` declare), defaulted to `git ls-files`
 *   (`../workspace.mjs`) — injected where a test answers for git.
 * @returns {object|null} What `adrCommand` returns, verbatim; `null` when no
 *   ancestor of `cwd` is a workspace root — the caller's refusal to render,
 *   never a clean answer (the module header owns why the message is not
 *   worded here).
 * @throws {Error} on an unreadable registry or a failed `git ls-files`,
 *   exactly as `adrCommand` and `listTrackedFiles` throw — each caller maps
 *   that the way it already did.
 */
export function adrForWorkspace({ cwd }, options = {}, io = {}) {
  const root = findWorkspaceRoot(cwd, WORKSPACE_MARKERS);
  if (root === null) return null;
  return adrCommand(root, options, { tracked: (io.listFiles ?? listTrackedFiles)(root) });
}
