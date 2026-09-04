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

import { runProcess } from "../process.mjs";

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
  // First, the "is this even a git repository at all" question, asked before
  // `rev-parse HEAD` so an unborn HEAD (a commitless repo) is distinguishable
  // from "not a repo" — the two must not share the `null` answer, because
  // only the first is a legitimate "no origin claim".
  try {
    runProcess("git", ["rev-parse", "--is-inside-work-tree"], root);
  } catch {
    // git not available, or not a git repository. Return null — the envelope
    // carries no origin claim rather than a false one.
    return null;
  }
  let commit;
  try {
    commit = runProcess("git", ["rev-parse", "--verify", "HEAD"], root).trim();
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
      reachable = runProcess("git", ["rev-list", "--count", "--all"], root).trim();
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
    const remotes = runProcess("git", ["remote"], root).trim();
    if (remotes) {
      // Use the first remote's URL — typically "origin".
      const firstRemote = remotes.split("\n")[0].trim();
      remote = runProcess("git", ["remote", "get-url", firstRemote], root).trim();
    }
  } catch {
    // No remotes configured — `remote` stays null.
  }

  // Dirty: any uncommitted change to tracked files means the working tree
  // does not match the commit. A baseline from a dirty tree is not a
  // reproducible claim about that commit. `--untracked-files=no` is what
  // makes the code agree with that sentence: bare `--porcelain` includes
  // untracked paths, and an untracked file is not an uncommitted change to a
  // tracked file — the analysis reads `git ls-files`-tracked files only, so a
  // tree whose only dirt is an editor swap, a scratch file, or an unignored
  // build output has an unchanged analyzed input and must produce an
  // unchanged envelope (#683).
  const status = runProcess("git", ["status", "--porcelain", "--untracked-files=no"], root).trim();
  const dirty = status.length > 0;

  return { commit, remote, dirty };
}
/**
 * Resolves the git attribution of ONE file under `root`: the origin that
 * CREATED it and the origin that LAST CHANGED it, read from commit metadata.
 *
 * Both are committed static facts — an author name, email, and author date
 * frozen in the repository's history — so the answer is byte-identical across
 * every run over the same tree, and no wall-clock time and no injected clock
 * ever enter (the determinism rule `resolveProvenance` states above). The
 * origin shape is the same one a governance row carries: `by` names the
 * author, `tool` is `"git"` (the commit records the change; the tool behind
 * the commit is unknowable from the bytes), and `on` is the commit's author
 * date — READ, not produced, which is exactly the read surface
 * `../governance/provenance-record.mjs` already documents: an `on` is only
 * ever written by `recordOrigin`, and a committed `on` is its own read fact.
 *
 * Returns `null` when git cannot answer (not a repository) or the file has
 * never been committed — the reader then renders
 * `no origin recorded — cannot attest` rather than pretending an author.
 * A file whose history is missing is a legitimate "no claim" state, not the
 * loud could-not-look a commitless repository is: `resolveProvenance` owns
 * that refusal, and this reads only after a repository is established.
 *
 * @param {string} root The workspace root directory.
 * @param {string} file The tracked file whose history is attributed, relative
 *   to `root` (e.g. `docs/adr/0001-boundary-levels.md`).
 * @returns {{createdBy: import("../governance/provenance-record.mjs").OriginRecord,
 *   lastChangedBy: import("../governance/provenance-record.mjs").OriginRecord} | null}
 */
export function resolveFileAttribution(root, file) {
  // First, the "is this even a git repository at all" question — the same
  // probe `resolveProvenance` runs, so a non-repository is a clean `null`
  // (no claim) rather than a thrown error here.
  try {
    runProcess("git", ["rev-parse", "--is-inside-work-tree"], root);
  } catch {
    return null;
  }
  let log;
  try {
    // Oldest-first (`--reverse`), so the first line is the creator. `%aI` is
    // the strict ISO-8601 author date (no locale-dependent formatting), and
    // NUL separators keep a name containing spaces or a newline parseable.
    // `--` ends option parsing so a file name beginning with `-` is safe.
    log = runProcess("git", ["log", "--reverse", "--format=%an%x00%ae%x00%aI", "--", file], root);
  } catch {
    // Not a repository, or the file path is unreadable — either way, no
    // attributable history to claim. Null, not a thrown error.
    return null;
  }
  const lines = log.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) return null; // the file was never committed
  const parse = (line) => {
    const [name, email, on] = line.split("\u0000");
    return { by: `${name} <${email}>`, tool: "git", on };
  };
  return {
    createdBy: parse(lines[0]),
    lastChangedBy: parse(lines[lines.length - 1]),
  };
}
