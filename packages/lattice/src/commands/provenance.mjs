/**
 * Optional repository provenance: git commit, remote, and dirty state.
 *
 * Provenance is captured when git is available (it is a hard dependency for
 * the CLI's `git ls-files` file-list, but the LSP and test paths may not
 * have it). When it cannot be read, provenance is `null` — the envelope
 * carries no origin claim it cannot verify. A `null` provenance is explicit,
 * not implicit: a consumer reading a baseline with `provenance: null` knows
 * the snapshot's origin is unverified, rather than guessing from
 * `workspace.root` (a local path that varies by machine and cannot serve as
 * repository identity).
 *
 * Git is NOT made a new core dependency by this module. The CLI already
 * requires it for `listTrackedFiles` (`../../workspace.mjs`); this module
 * reuses that availability. Test harnesses and the LSP continue to work
 * without git, producing `provenance: null`.
 *
 * ## Why not timestamps
 *
 * No timestamp in the provenance. The envelope's determinism guarantee
 * (`../../../../AGENTS.md`: "two runs over an unchanged tree produce
 * byte-identical JSON") would break if the output varied by wall-clock time.
 * A git commit hash is a stable identity for the same tree state; a
 * timestamp is not.
 */

import { execFileSync } from "node:child_process";

import { environmentForTree } from "../process.mjs";

/**
 * Resolves repository provenance from the workspace root.
 *
 * Returns `null` when git is not available or the directory is not a git
 * repository — the snapshot carries no origin claim rather than a false one.
 *
 * @param {string} root The workspace root directory.
 * @returns {{ commit: string, remote: string | null, dirty: boolean } | null}
 */
export function resolveProvenance(root) {
  // G-09: every git spawn routes through the shared environment guard, so an
  // ambient GIT_DIR/GIT_WORK_TREE from a wrapping tool (the editor hooks, an
  // outer `git` call) can never make these spawns read a repository other
  // than the tree at `root`.
  const env = environmentForTree();
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      env,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    // `git remote` may return empty for a repo with no remotes (e.g. a local
    // test fixture). That is a legitimate state — the commit still identifies
    // the tree.
    let remote = null;
    try {
      const remotes = execFileSync("git", ["remote"], {
        cwd: root,
        env,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (remotes) {
        // Use the first remote's URL — typically "origin".
        const firstRemote = remotes.split("\n")[0].trim();
        remote = execFileSync("git", ["remote", "get-url", firstRemote], {
          cwd: root,
          env,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
      }
    } catch {
      // No remotes configured — `remote` stays null.
    }

    // Dirty: any uncommitted change to tracked files means the working tree
    // does not match the commit. A baseline from a dirty tree is not a
    // reproducible claim about that commit.
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      env,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const dirty = status.length > 0;

    return { commit, remote, dirty };
  } catch {
    // git not available, or not a git repository. Return null — the envelope
    // carries no origin claim rather than a false one.
    return null;
  }
}
