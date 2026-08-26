/**
 * The `evolution` command: the architecture's evolution across a bounded,
 * explicit range of Git revisions, read with everything `history` reads it
 * from — the same engine, the same snapshot identity, the same transition
 * classification — with Git answering one question and only one question:
 * which trees to read.
 *
 * `archkeep evolution --base <rev> [--head <rev>]` resolves both revisions in
 * the workspace's own repository, materializes each selected commit into a
 * temporary detached worktree (`git worktree add --detach` — the caller's
 * working tree is never touched), analyzes every materialized tree through
 * `./context.mjs`'s ordinary pipeline, and classifies the transition between
 * each consecutive pair with `./history.mjs`'s `computeEvolution`. Git names
 * WHERE a change is first observed between two analyzed revisions; Archkeep
 * owns every architecture judgment over those revisions. Nothing here parses
 * diffs, blames lines, or infers intent — a commit message carries no
 * evidence this command can verify, so none is reported.
 *
 * ## What Git is asked, and what it is never asked
 *
 * Asked: which commit a revision names (`rev-parse --verify`), whether base
 * precedes head (`merge-base --is-ancestor`), which single-parent commits lie
 * between them oldest-first (`rev-list --reverse --parents`), and where a
 * disposable copy of each tree can live (`worktree add` / `worktree remove`).
 * Never asked: what a change MEANS. Classification is `computeEvolution`'s —
 * architecture, policy, provider, code drift — decided exactly as
 * `history` decides it, from evidence each revision's own analysis produced.
 *
 * ## The MVP's deliberate narrowness, stated rather than hidden
 *
 * - **Linear ranges only.** Every selected commit must have exactly one
 *   parent; a merge commit inside `base..head` refuses the run loudly, because
 *   flattening a merge would attribute a whole branch's architectural changes
 *   to one commit the reader cannot see behind. There is no `--first-parent`
 *   mode yet: a range ending at a merge, or spanning one, fails rather than
 *   pretending merges are modeled.
 * - **Committed state only.** Every analyzed revision is materialized from a
 *   commit object, so the working tree's uncommitted changes belong to no
 *   analyzed revision — by construction, not by neglect. When the working
 *   tree is dirty, `coverage.notes` says so rather than letting a reader
 *   assume the tip analysis saw their desk.
 * - **Bounded selection.** The command analyzes exactly the commits named by
 *   the range — never a whole repository. Cost is O(selected revisions)
 *   worktrees × one full analysis each; a wide range is slow by construction,
 *   and the merge refusal keeps most branched histories from being selected
 *   accidentally wide.
 *
 * ## What refuses, and why that is the quiet-direction answer
 *
 * Every condition below throws (exit 3 through `../../cli.mjs`) instead of
 * degrading into a shorter or emptier record, because each one would
 * otherwise read as "fewer changes happened":
 *
 * - an unresolved revision, a base that is not head's ancestor, a range whose
 *   ends coincide, a merge inside the range — the selection itself is
 *   unusable, and guessing a smaller one would fabricate history;
 * - a revision that is not a readable workspace, or whose analysis leaves
 *   whole-file failures — the same bar `history --capture` holds (`./history.mjs`),
 *   because an under-represented revision would manufacture architecture
 *   changes out of unread files;
 * - a boundary law a revision NAMES but that will not load — an absent law
 *   and a broken one must not report alike (`./policy.mjs`);
 * - a failed worktree add/remove or any git failure.
 *
 * It is descriptive: it never exits 1. Where the architecture changed is a
 * fact about history, not a finding about the tree.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isWholeFileFailure } from "../analysis/source-util.mjs";
import { runProcess } from "../process.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { formatEvolutionReport } from "../report/evolution-text.mjs";
import { buildDependencies, buildProjects, computePolicyFingerprint } from "./graph.mjs";
import { computeEvolution, snapshotIdentity } from "./history.mjs";
import { resolveProvenance } from "./provenance.mjs";
import { resolveDescribedPolicy } from "./policy.mjs";
import { resolveCommandContext, describeWorkspaceRoot } from "./context.mjs";

/** A full SHA-1 object name, as `git rev-parse` answers it. */
const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * The short form used inside error messages — long enough to stay unambiguous
 * in every repository a human will type into, never part of the JSON output
 * (which carries full SHAs).
 *
 * @param {string} sha
 * @returns {string}
 */
function shortSha(sha) {
  return sha.slice(0, 12);
}

/**
 * Resolves one revision to the full SHA of the commit it names.
 *
 * `^{commit}` peels tags and rejects trees and blobs, so `v1.2.0`, `main`,
 * `HEAD~3`, and a raw SHA all land on the same answer: a commit object. An
 * input beginning with `-` is refused before git sees it — git would read it
 * as its own option, and an option spelled by a caller is an injection seam,
 * not a revision.
 *
 * @param {string} root Absolute path inside the repository (the workspace
 *   root; git resolves the repository upward from there).
 * @param {string} rev The revision the caller asked for.
 * @param {"--base"|"--head"} flag Which flag named it, so the error points at
 *   the spelling that was wrong.
 * @param {{run?: Function}} [io] Injectable spawner (`../process.mjs`).
 * @returns {string} Full hex SHA-1 of the named commit.
 * @throws {Error} when the revision does not name a commit reachable in this
 *   repository — including a repository that is not a git repository at all,
 *   and a shallow clone whose cut-off sits below the requested revision.
 */
export function resolveRevision(root, rev, flag, { run = runProcess } = {}) {
  if (typeof rev !== "string" || rev.length === 0) {
    throw new Error(`archkeep: ${flag} needs a revision — a commit, branch, tag, or HEAD~n.`);
  }
  if (rev.startsWith("-")) {
    throw new Error(
      `archkeep: ${flag} '${rev}' starts with '-' and would be read by git as an option, ` +
        `not a revision. Give a commit, branch, or tag name.`,
    );
  }
  let out;
  try {
    // Everything after `--end-of-options` is a revision, whatever it starts
    // with — belt to the braces above.
    out = run("git", ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`], root);
  } catch (cause) {
    throw new Error(
      `archkeep: ${flag} '${rev}' does not name a commit reachable in this repository ` +
        `(resolved from '${root}'). Give a branch, tag, or commit SHA that exists — ` +
        `in a shallow clone, one fetched deep enough to reach it.`,
      { cause },
    );
  }
  const sha = out.trim();
  if (!FULL_SHA.test(sha)) {
    throw new Error(
      `archkeep: ${flag} '${rev}' resolved to '${sha}', which is not a commit SHA — ` +
        `refusing rather than analyze something this tool cannot name.`,
    );
  }
  return sha;
}

/**
 * Resolves and validates the selected range: both endpoints as commits, base
 * an ancestor of head, and every commit between them single-parent.
 *
 * The ordering is `git rev-list --reverse`'s — oldest first, parents before
 * children — with `base` prepended as the first ANALYZED revision, so the
 * first transition is base → the commit that follows it. `--parents` is what
 * makes the merge refusal cheap: the same walk that selects the commits
 * already carries each one's parent count, so no second traversal is needed
 * to refuse a merge.
 *
 * @param {string} root Absolute path inside the repository.
 * @param {{base: string, head: string}} range The raw revisions from the CLI.
 * @param {{run?: Function}} [io] Injectable spawner.
 * @returns {{base: string, head: string, commits: string[]}} Resolved full
 *   SHAs, and every analyzed revision oldest-first — `base` first, `head` last.
 * @throws {Error} on an unresolved revision, coincident endpoints, a base off
 *   head's ancestry, or a merge commit inside the range.
 */
export function selectLinearRange(root, { base, head }, { run = runProcess } = {}) {
  const baseSha = resolveRevision(root, base, "--base", { run });
  const headSha = resolveRevision(root, head ?? "HEAD", "--head", { run });

  if (baseSha === headSha) {
    throw new Error(
      `archkeep: --base and --head both resolve to ${baseSha} — the range selects nothing to ` +
        `compare. Give a --base earlier in history than --head.`,
    );
  }

  try {
    run("git", ["merge-base", "--is-ancestor", baseSha, headSha], root);
  } catch {
    throw new Error(
      `archkeep: --base ${shortSha(baseSha)} is not an ancestor of --head ${shortSha(headSha)} — ` +
        `'evolution' describes one linear descent, so the base must lie on head's own history. ` +
        `Choose a --base that --head descends from.`,
    );
  }

  const lines = run("git", ["rev-list", "--reverse", "--parents", `${baseSha}..${headSha}`], root)
    .split("\n")
    .filter((line) => line !== "");
  const commits = [baseSha];
  for (const line of lines) {
    const [sha, ...parents] = line.split(" ");
    if (parents.length > 1) {
      throw new Error(
        `archkeep: ${sha} is a merge commit inside the selected range — this view describes ` +
          `linear history only, and flattening a merge would pin a whole branch's ` +
          `architectural changes on one commit. Select a range whose commits each have ` +
          `one parent.`,
      );
    }
    commits.push(sha);
  }
  return { base: baseSha, head: headSha, commits };
}

/**
 * Analyzes ONE materialized revision through the ordinary pipeline — the same
 * `resolveCommandContext`, the same policy ladder, the same builders, the
 * same identity every captured snapshot carries — and returns the record
 * `computeEvolution` reads.
 *
 * Nothing here knows the record came from Git. Given a directory, it answers
 * exactly what `graph` would answer about that directory; the caller owns
 * which directories exist and what they are named.
 *
 * @param {object} input
 * @param {string} input.sha The commit the worktree was materialized from —
 *   carried into error messages and the returned record, never derived here.
 * @param {string} input.dir Absolute path of the temporary worktree.
 * @param {object} input.seams The `readGraph`/`listFiles` seams threaded from
 *   the CLI env, honored for EVERY analyzed tree a run reads — in production
 *   they are undefined and every tree is read for real.
 * @param {{resolveContext?: Function, resolveProvenance?: Function}} [io]
 * @returns {Promise<{sha: string, id: string, provider: string, provenance: object|null,
 *   projects: object[], dependencies: object[], fingerprint: string|null,
 *   coverage: {projects: number, analyzedFiles: number, imports: number}}>}
 * @throws {Error} when the revision is not a readable workspace, when whole-file
 *   analysis failures leave the record under-represented, or when the law the
 *   revision names will not load.
 */
async function analyzeRevision(input, io = {}) {
  const { sha, dir, seams } = input;
  const resolveContext = io.resolveContext ?? ((cwd) => resolveCommandContext({ cwd }, seams));
  const provenanceResolver = io.resolveProvenance ?? resolveProvenance;

  let context;
  try {
    context = await resolveContext(dir);
  } catch (cause) {
    // The raw refusal names the directory it probed — a temporary worktree
    // path that exists only for this run. Wrap it so the error names the
    // REVISION instead: "some revision was skipped" is the silent direction;
    // "revision X could not be read" is an actionable fact.
    throw new Error(
      `archkeep: revision ${shortSha(sha)} could not be read as a workspace — ` +
        `${cause?.message ?? cause}`,
      { cause },
    );
  }
  const notAnalyzed = context.analysis.failures.filter(isWholeFileFailure);
  if (notAnalyzed.length > 0) {
    const sample = notAnalyzed
      .slice(0, 3)
      .map(({ sourceFile }) => sourceFile)
      .join(", ");
    throw new Error(
      `archkeep: revision ${shortSha(sha)} cannot be analyzed completely — ` +
        `${notAnalyzed.length} file${notAnalyzed.length === 1 ? "" : "s"} produced no verdict ` +
        `(${sample}${notAnalyzed.length > 3 ? ", …" : ""}). Its architecture record would ` +
        `under-represent the real graph, and a transition classified against a partial ` +
        `picture would report changes the unread files may explain. Fix the unanalyzed ` +
        `files at that revision, or select a range that excludes it.`,
    );
  }

  const { config } = await resolveDescribedPolicy({ config: null }, context, dir);
  const fingerprint = config ? computePolicyFingerprint(config) : null;
  const projects = buildProjects(context.graph.nodes);
  const dependencies = buildDependencies(context.graph.dependencies);

  return {
    sha,
    id: snapshotIdentity({
      projects,
      dependencies,
      policy: fingerprint === null ? null : { fingerprint },
    }),
    provider: context.provider,
    provenance: provenanceResolver(dir),
    projects,
    dependencies,
    fingerprint,
    coverage: {
      projects: projects.length,
      analyzedFiles: context.analysis.analyzed,
      imports: context.analysis.imports.length,
    },
  };
}

/**
 * Removes one worktree: git's own unregister first (so the repository's
 * worktree metadata stays truthful), then the bytes. Both are needed — git's
 * remove alone leaves nothing behind but fails if the directory already went,
 * and deleting the directory alone would strand `.git/worktrees` entries.
 *
 * @param {string} root Repository-scoped directory the git calls run in.
 * @param {string} dir The worktree to release.
 * @param {{run?: Function}} [io]
 */
function releaseWorktree(root, dir, { run = runProcess } = {}) {
  let removeError = null;
  try {
    run("git", ["worktree", "remove", "--force", dir], root);
  } catch (cause) {
    removeError = cause;
  }
  rmSync(dir, { recursive: true, force: true });
  if (removeError !== null) {
    throw new Error(
      `archkeep: releasing the temporary worktree '${dir}' failed — ` +
        `${removeError?.message ?? removeError}`,
      { cause: removeError },
    );
  }
}

/**
 * Runs the `evolution` command.
 *
 * @param {string} root Absolute path to the workspace root the command was
 *   invoked from — the envelope header describes THIS tree, and every git
 *   question is answered in it; the analyzed revisions are materialized
 *   elsewhere.
 * @param {{base: string, head?: string|null}} range The raw revisions.
 * @param {{run?: Function, makeTempRoot?: Function, resolveContext?: Function,
 *   resolveProvenance?: Function, readGraph?: Function, listFiles?: Function}} [io]
 *   Injectable seams. `makeTempRoot` defaults to a fresh `mkdtemp` directory
 *   under the OS temp dir; `readGraph`/`listFiles` thread into every analyzed
 *   revision's context the way `../../cli.mjs` threads them into one.
 * @returns {Promise<{status: "ok", result: object, coverage: object,
 *   report: {text: string, json: string}}>}
 * @throws {Error} on every condition listed in this module's header — an
 *   unusable selection, an unanalyzable revision, a failed worktree, a git
 *   failure — never a shorter record for any of them.
 */
export async function evolutionCommand(root, { base, head = null }, io = {}) {
  const run = io.run ?? runProcess;
  const identity = describeWorkspaceRoot(root);
  const provenanceResolver = io.resolveProvenance ?? resolveProvenance;

  const selection = selectLinearRange(root, { base, head }, { run });

  const makeTempRoot =
    io.makeTempRoot ?? (() => mkdtempSync(join(tmpdir(), "archkeep-evolution-")));
  const parent = makeTempRoot();
  const seams = {};
  if (io.readGraph !== undefined) seams.readGraph = io.readGraph;
  if (io.listFiles !== undefined) seams.listFiles = io.listFiles;

  const snapshots = [];
  /** Worktrees still standing — emptied as each is released successfully. */
  const standing = [];
  try {
    for (const [index, sha] of selection.commits.entries()) {
      const dir = join(parent, `${index}-${sha.slice(0, 12)}`);
      run("git", ["worktree", "add", "--quiet", "--detach", dir, sha], root);
      standing.push(dir);
      const snapshot = await analyzeRevision({ sha, dir, seams }, io);
      releaseWorktree(root, dir, { run });
      standing.pop();
      snapshots.push(snapshot);
    }
  } finally {
    // A revision whose analysis threw leaves its worktree here; release it
    // WITHOUT letting a cleanup failure mask the original error — the bytes go
    // either way when the parent directory goes, and the original failure is
    // the one that explains the exit. On the success path this list is empty.
    for (const dir of standing) {
      try {
        releaseWorktree(root, dir, { run });
      } catch {
        // The parent-directory removal below still removes the bytes; a stale
        // worktree-admin entry is pruned next line, and masking the error that
        // is already propagating would hide why the run failed.
      }
    }
    rmSync(parent, { recursive: true, force: true });
    try {
      run("git", ["worktree", "prune"], root);
    } catch {
      // Cosmetic-only after the bytes are gone: prune clears leftover admin
      // entries. Failing here must not overwrite a real verdict.
    }
  }

  const evolution = computeEvolution(
    snapshots.map((snapshot) => ({
      // The record's "name" is the full commit SHA: the transition's from/to
      // identity IS the revision, and a full SHA never abbreviates differently
      // as the repository grows.
      name: snapshot.sha,
      path: null,
      envelope: {
        coverage: {
          complete: true,
          projects: snapshot.coverage.projects,
          analyzedFiles: snapshot.coverage.analyzedFiles,
          imports: snapshot.coverage.imports,
        },
        result: {
          projects: snapshot.projects,
          dependencies: snapshot.dependencies,
          ...(snapshot.fingerprint === null
            ? {}
            : { policy: { fingerprint: snapshot.fingerprint } }),
        },
        workspace: { provider: snapshot.provider, provenance: snapshot.provenance },
      },
      id: snapshot.id,
    })),
  );

  const headSnapshot = snapshots[snapshots.length - 1];
  const userProvenance = provenanceResolver(root);
  const notes = [
    "each change is attributed to the first analyzed revision where it is observed — a fact " +
      "about where history shows it, not about why it was made",
    "rule-impact cannot be recomputed across revisions — each analyzed revision carries its " +
      "graph and policy fingerprint, not import sites judged under a law. Run 'check' at a " +
      "revision for its boundary verdict.",
  ];
  if (userProvenance?.dirty === true) {
    notes.push(
      "the working tree has uncommitted changes; they belong to no analyzed revision — every " +
        "analyzed revision was materialized from committed state",
    );
  }
  const coverage = {
    complete: true,
    projects: headSnapshot.coverage.projects,
    analyzedFiles: headSnapshot.coverage.analyzedFiles,
    imports: headSnapshot.coverage.imports,
    notAnalyzed: [],
    blindSpots: [],
    notes,
  };

  const result = {
    base: selection.base,
    head: selection.head,
    revisions: snapshots.map(({ sha, id }) => ({ commit: sha, id })),
    transitions: evolution.transitions,
  };

  const envelope = jsonEnvelope({
    command: "evolution",
    context: {
      root,
      provider: identity.provider,
      marker: identity.marker,
      provenance: userProvenance,
    },
    status: "ok",
    exitCode: 0,
    coverage,
    result,
  });

  return {
    status: "ok",
    result,
    coverage,
    report: {
      text: formatEvolutionReport({ result, coverage }),
      json: renderJson(envelope),
    },
  };
}
