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
 * Two markers are recognised: `nx.json` (an Nx workspace) and `lattice.json`
 * (a native Lattice workspace). Both activate the server; which provider it uses
 * is the server's own decision, not the client's.
 */

import { dirname, join, resolve } from "node:path";

/** The files whose presence defines a workspace root. */
export const WORKSPACE_MARKERS = Object.freeze(["nx.json", "lattice.json"]);

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
