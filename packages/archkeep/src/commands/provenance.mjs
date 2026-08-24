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
 * Throws when the directory IS a git repository but has no commits. Git keeps
 * no identity for a tree whose HEAD is unborn: `git ls-files` answers an
 * empty list, so a run over a commitless tree would otherwise report a clean
 * workspace over zero files — the exact silent direction this repository
 * runs on ("an empty result is a claim, not a shrug", `../../../../AGENTS.md`).
 * Read as `null` it would look identical to "no origin claim", which is a
 * factually different statement from "the tree's own git cannot name its
 * state". The throw makes the commitless tree a loud could-not-look at every
 * call site (exit 3), instead of a clean-looking run over nothing.
 *
 * @param {string} root The workspace root directory.
 * @returns {{ commit: string, remote: string | null, dirty: boolean } | null}
 * @throws {Error} when `root` is a git repository with no commits.
 */
export function resolveProvenance(root) {
  // G-09: every git spawn routes through the shared environment guard, so an
  // ambient GIT_DIR/GIT_WORK_TREE from a wrapping tool (the editor hooks, an
  // outer `git` call) can never make these spawns read a repository other
  // than the tree at `root`.
  const env = environmentForTree();
  // First, the "is this even a git repository at all" question, asked before
  // `rev-parse HEAD` so an unborn HEAD (a commitless repo) is distinguishable
  // from "not a repo" — the two must not share the `null` answer, because
  // only the first is a legitimate "no origin claim".
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      env,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // git not available, or not a git repository. Return null — the envelope
    // carries no origin claim rather than a false one.
    return null;
  }
  let commit;
  try {
    commit = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: root,
      env,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    // `--is-inside-work-tree` passed above, so a repo EXISTS here, and
    // `--verify` (the two-argument form) failed to resolve HEAD. Two states
    // share that failure, and they need different messages:
    //   - an UNBORN HEAD (a commitless repo: `git init` with nothing ever
    //     committed). Git keeps no identity for it — `git ls-files` answers an
    //     empty list, so a run otherwise reports a clean workspace over zero
    //     files, the exact silent direction this repository refuses.
    //   - a BROKEN HEAD (a repo with commits whose HEAD points at a ref that
    //     no longer exists — `git symbolic-ref HEAD refs/heads/nonexistent`).
    //     The tree HAS identity; only the ref is corrupt, and telling the
    //     user to "commit at least once" would be factually false.
    // The count of commits reachable from any ref (`--all`, includes HEAD via
    // its reflog) distinguishes them: zero means genuinely unborn, nonzero
    // means the HEAD ref is broken.
    let reachable;
    try {
      reachable = execFileSync("git", ["rev-list", "--count", "--all"], {
        cwd: root,
        env,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch {
      // `rev-list --all` failing too is a degenerate repo; treat it as unborn
      // rather than inventing a third class.
    }
    if (reachable === undefined || reachable === "0") {
      throw new Error(
        `archkeep: ${root} is a git repository with no commits — no commit or tracked ` +
          `file exists to establish evidence, so there is nothing this run could look at. ` +
          `Commit at least once before running a Archkeep command.`,
      );
    }
    throw new Error(
      `archkeep: ${root} is a git repository whose HEAD cannot be resolved (the ` +
        `HEAD ref appears to point at a nonexistent branch), even though the repository ` +
        `has commits. Fix the broken HEAD before running a Archkeep command.`,
    );
  }

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
}
