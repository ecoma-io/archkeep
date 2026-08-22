#!/usr/bin/env node
// Pushes a set of files to a GitHub branch as ONE commit created through the
// git-database API — the mechanism that makes the commit's signature the web
// flow's rather than the runner's.
//
// WHY this exists instead of the obvious `git commit` + `git push`: the
// repository's `main` ruleset requires a signature on every commit
// (`required_signatures`, verified via `gh api rulesets/...`), and a commit a
// workflow creates with `git config user.name ...` + `git commit` is unsigned —
// the state release PR #75 was in: all checks green, `mergeable_state:
// BLOCKED`, nothing naming the cause. A commit created through the REST
// git-database API (POST /git/trees → POST /git/commits → PATCH
// /git/refs) with NO author or committer is signed automatically by GitHub's
// web-flow key (committer `GitHub <noreply@github.com>`) — the same signature
// release-please's own push carries. Measured empirically against this
// repository on 2026-08-18, both directions:
//
//   - POST /git/commits with explicit author/committer  → committer is that
//     identity, `verification.reason: "unsigned"`.
//   - POST /git/commits with neither (the default)      → author
//     `github-actions[bot]`, committer `GitHub`, `reason: "valid"`, verified.
//
// A GitHub App token's API commits carry the app's signature (verified too),
// so the `token` this script is called with may be either `github.token` or an
// App token. What must NOT be used is a personal access token: PAT-created
// API commits come back unsigned, also measured.
//
// The tree entries are built with inline `content` (the same encoding
// release-please uses) rather than pre-created blobs, so the bytes pushed are
// byte-for-byte what was written by Prettier. A trailing newline is added to
// every file, matching what `prettier --write` produces and what git records.
//
// The commit message, tree, and parents arrive as arguments — this script
// never decides anything, only executes, so it needs no mocking layer and the
// one external call (`requestGit`) is deliberately untested, the same boundary
// `check-docs-links.mjs` draws around `readFacts`.
//
// Environment: GH_TOKEN (the workflow's `${{ github.token }}` or App token),
// GITHUB_REPOSITORY (`owner/repo`).

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The files the release lane repairs on release-please's own branch, and then
 * pushes as one commit.
 *
 * The six JSON manifests are there because release-please bumps them and
 * re-serializes them in a layout Prettier will not accept; the reformat step
 * runs Prettier over exactly these. The TS SDK's manifest is named for that
 * same reason rather than because it has been observed to break — it is one of
 * the JSON `extra-files` in `../release-please-config.json`, and a list that
 * covers all but one of them is the drift that only shows up as a red
 * `format:check` on a release pull request nobody expected to be red.
 *
 * The Rust SDK's Cargo.lock is the odd one and is not a formatting fix at all:
 * release-please writes that package's Cargo.toml and no lockfile, so the two
 * disagree from the moment the release branch opens, and `cargo publish
 * --locked` refuses to publish through the disagreement. `sync-cargo-lock.mjs`
 * is what repairs it and argues the whole case; this list is what carries the
 * repair back to the branch.
 */
export const REFORMAT_FILES = [
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".codex-plugin/plugin.json",
  "packages/lattice/package.json",
  "packages/lattice-vscode/package.json",
  "packages/lattice-rule-sdk-ts/package.json",
  "packages/lattice-rule-sdk-rust/Cargo.lock",
];

/**
 * The message the repair commit carries. The title is deliberate: this commit
 * exists so the release pull request passes the checks release-please's own
 * output would fail — `format:check` on the JSON manifests it re-serialized,
 * and `check-skills` on the lockfile it does not write — and the message says
 * what it did. "repair" rather than "reformat" because the lockfile half is
 * not a formatting change. It is `chore:`-scoped (no package) and is the
 * literal subject CI's commitlint would see only on `main`; on the release
 * branch no hook runs.
 */
export const REFORMAT_MESSAGE = "chore: repair release-please extra-files";

/**
 * One authenticated request to the GitHub REST API.
 *
 * The full `repos/{owner}/{repo}{path}` path is built here rather than given
 * to `gh` as a relative path: `gh api /git/refs/...` resolves against the
 * default repository's root the same way for `--repo` but NOT from a bare
 * `GH_TOKEN`, and a two-segment path like `git/ref/...` is treated as a bare
 * endpoint instead of being prefixed — measured in a workflow run and
 * locally: the relative spelling 404'd while the full spelling succeeded
 * against the same branch.
 *
 * @param {string} owner repository owner
 * @param {string} repo repository name
 * @param {string} method HTTP verb (`GET`/`POST`/`PATCH`)
 * @param {string} path API path after `/repos/{owner}/{repo}`
 * @param {string} token the `GH_TOKEN` value
 * @param {object} [body] JSON payload
 * @returns {object} parsed JSON response; throws with the status and body on a
 *   non-2xx so a failed push is loud, never a silent success.
 */
export function requestGit(owner, repo, method, path, token, body) {
  const { error, status, stdout, stderr } = spawnSync(
    "gh",
    ["api", `repos/${owner}/${repo}${path}`, "-X", method, "--input", "-"],
    {
      env: {
        ...process.env,
        GH_TOKEN: token,
      },
      input: JSON.stringify(body ?? {}),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );
  // The process never started — `gh` is not on PATH, or the spawn itself
  // failed. Handled before the status check because `spawnSync` then reports
  // `status: null` and NO streams, and reaching for `stderr.trim()` turns a
  // one-line "gh is not installed" into a TypeError from inside this helper:
  // the caller's failure, reported as a bug in the reporter.
  if (error || status === null) {
    throw new Error(
      `GitHub API ${method} ${path} could not run \`gh\`: ${error?.message ?? "the process did not start"}. ` +
        `This helper shells out to the GitHub CLI, which every runner in this lane has and a ` +
        `local checkout may not.`,
    );
  }
  if (status !== 0) {
    const detail = (stderr ?? "").trim() || (stdout ?? "").trim();
    throw new Error(`GitHub API ${method} ${path} failed (exit ${status}): ${detail}`);
  }
  return JSON.parse(stdout);
}

/**
 * The JSON payload for a `POST /git/trees` call: the base tree plus one
 * blob-entry per file, each carrying its Prettier-written bytes as inline
 * `content`. A file that disappeared after the last git-database call would
 * 404 in `readFileSync` with a message naming the path — loud, never a
 * silent omission.
 *
 * @param {string} baseTreeSha the tree of the branch head commit
 * @param {string[]} files paths (relative to the repository root)
 * @param {string} root filesystem path of the checked-out repository
 * @returns {{base_tree: string, tree: {path: string, mode: string, type: string, content: string}[]}}
 */
export function treePayload(baseTreeSha, files, root) {
  const tree = files.map((path) => ({
    path,
    mode: "100644",
    type: "blob",
    content: readFileSync(join(root, path), "utf8").replace(/\n?$/, "\n"),
  }));
  return { base_tree: baseTreeSha, tree };
}

/**
 * Creates one commit on a branch via the git-database API and moves the
 * branch ref to it. Called with no author/committer so GitHub signs it with
 * the web-flow key (see the file header for the measurement).
 *
 * @param {string} owner repository owner
 * @param {string} repo repository name
 * @param {string} branch branch name to update
 * @param {string} message the commit message
 * @param {string[]} files paths whose current on-disk content becomes the commit
 * @param {string} root filesystem path of the checked-out repository
 * @param {string} token the workflow token (never a PAT)
 * @returns {{sha: string, verification: string}} the new head commit's SHA and
 *   GitHub's own verdict on its signature — a push whose commit did not come
 *   back verified is a loud failure, because an unverified commit is exactly
 *   the state this script exists to prevent.
 */
export function pushReformattedFiles(owner, repo, branch, message, files, root, token) {
  const head = requestGit(owner, repo, "GET", `/git/ref/heads/${branch}`, token).object.sha;
  const baseTree = requestGit(owner, repo, "GET", `/git/commits/${head}`, token).tree.sha;
  const treeSha = requestGit(
    owner,
    repo,
    "POST",
    "/git/trees",
    token,
    treePayload(baseTree, files, root),
  ).sha;
  const commit = requestGit(owner, repo, "POST", "/git/commits", token, {
    message,
    tree: treeSha,
    parents: [head],
  });
  requestGit(owner, repo, "PATCH", `/git/refs/heads/${branch}`, token, {
    sha: commit.sha,
    force: false,
  });
  const verification = requestGit(owner, repo, "GET", `/commits/${commit.sha}`, token).commit
    .verification;
  return { sha: commit.sha, verification: verification?.reason ?? "unknown" };
}

/**
 * CLI entry. `--root` defaults to the repository the script ships in, but the
 * release lane passes `${{ github.workspace }}` explicitly so a future move of
 * the script cannot silently reformat the wrong checkout.
 */
export function main() {
  const args = process.argv.slice(2);
  const root =
    args.find((a, i) => args[i - 1] === "--root") ?? new URL("..", import.meta.url).pathname;
  const repoRaw = process.env.GITHUB_REPOSITORY;
  if (!repoRaw) {
    throw new Error("GITHUB_REPOSITORY is required (owner/repo)");
  }
  const [owner, repo] = repoRaw.split("/");
  const branch = args[args.indexOf("--branch") + 1];
  if (!branch) {
    throw new Error("--branch <name> is required");
  }
  const token = process.env.GH_TOKEN;
  if (!token) {
    throw new Error("GH_TOKEN is required (use the workflow token, never a personal access token)");
  }
  const { sha, verification } = pushReformattedFiles(
    owner,
    repo,
    branch,
    REFORMAT_MESSAGE,
    REFORMAT_FILES,
    root,
    token,
  );
  if (verification !== "valid") {
    throw new Error(
      `reformat commit ${sha} came back ${verification} — a release branch holding an ` +
        "unverified commit is exactly the BLOCKED state this lane refuses to recreate",
    );
  }
  console.log(`pushed reformat commit ${sha} (verification: ${verification})`);
}

/**
 * Whether this file was RUN rather than imported, compared on real paths —
 * the naive spelling this replaces (`process.argv[1] ===
 * fileURLToPath(import.meta.url)`) is false whenever the invoking path
 * contains a symlink anywhere in it, the same class of bug
 * `scripts/check-packages.mjs` documents on its own copy of this guard:
 * Node resolves symlinks before recording a module's URL, but records
 * `argv[1]` exactly as the caller spelled it, so a workflow checkout reached
 * through a symlinked path made `main()` never run — the release lane's
 * reformat push silently no-opped while the step still exited 0.
 *
 * @param {string} moduleUrl `import.meta.url` of this module
 * @param {string | undefined} [argv1] `process.argv[1]`
 * @returns {boolean}
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

if (isProgramEntry(import.meta.url)) {
  main();
}
