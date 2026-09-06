/**
 * Finding the workspace root above an open folder.
 *
 * This exists because **the server does not do it.** `src/lsp/server.mjs` takes
 * its root from `initializationOptions.workspaceRoot`, then the first workspace
 * folder, then `rootUri`, then `rootPath`, then the process working directory —
 * and it never walks upward from any of them. That is the right shape for a
 * server (a process that guesses where a workspace begins is a process that can
 * silently analyze the wrong tree), and it makes the walk the client's job.
 *
 * The case it is for is ordinary: someone opens `apps/api` rather than the
 * repository root. Without the walk the server would be handed `apps/api`, find
 * no workspace marker, and report nothing — for a directory whose files really
 * are under boundary rules.
 *
 * Three marker kinds are recognised: `nx.json` (an Nx workspace), `archkeep.json`
 * (a native Archkeep workspace), and Moon's `workspace.yml` — inside `.moon/` or
 * `.config/moon/`, the file rather than the directory alone, because `~/.moon`
 * is moonrepo's user-level state and directory presence is what once walked a
 * home directory into a "workspace" (#339). All three activate the server; which
 * provider it uses is the server's own decision, not the client's. The list is
 * the server-side walk's (`src/commands/context.mjs` in `packages/archkeep`)
 * entry for entry, so a client and a CLI on the same tree cannot disagree about
 * where the workspace begins.
 * One divergence is known: the server-side walk bounds itself by the enclosing
 * git repository (`src/workspace.mjs` — a marker above `git rev-parse
 * --show-toplevel`'s top level is tooling state, not the workspace's root),
 * while this client walk climbs to the filesystem root, being a pure function
 * of an editor-supplied folder that spawns no git to find a bound.
 */

import { dirname, join, resolve } from "node:path";

/** The files whose presence defines a workspace root. */
export const WORKSPACE_MARKERS = Object.freeze([
  "nx.json",
  "archkeep.json",
  ".moon/workspace.yml",
  ".config/moon/workspace.yml",
]);

/**
 * Walk up from a directory to the nearest workspace root.
 *
 * `exists` is injected rather than imported so this stays a pure function of its
 * inputs, and so a test drives it over a described tree instead of a temporary
 * one on disk.
 *
 * @param {string} startDirectory absolute path of the directory to start from
 * @param {(path: string) => boolean} exists filesystem predicate
 * @returns {string | null} the workspace root, or null if there is none above it
 */
export function findNxRoot(startDirectory, exists) {
  let current = resolve(startDirectory);

  for (;;) {
    if (WORKSPACE_MARKERS.some((marker) => exists(join(current, marker)))) {
      return current;
    }

    const parent = dirname(current);
    // `dirname` of a filesystem root returns the root itself; that fixed point
    // is the loop's only exit besides a hit, and it is why the walk cannot run
    // off the top on any platform.
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}
