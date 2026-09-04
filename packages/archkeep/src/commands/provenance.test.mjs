/**
 * Tests for optional repository provenance resolution.
 *
 * Provenance is `null` when git is unavailable — the envelope carries no origin
 * claim it cannot verify. When git IS available (the normal CLI path), the
 * commit, remote, and dirty state are captured.
 *
 * These tests run against real git repositories — the one this package lives
 * in where only "git is available and honest about this tree" is the question,
 * frozen temp fixtures everywhere the test asserts on a specific answer —
 * because `resolveProvenance` is a thin wrapper over `git` commands and the
 * meaningful test is whether it correctly reads what git reports. A mocked git
 * would prove the mock, not the code.
 */
import { describe, it, expect, vi } from "vitest";
import { resolveFileAttribution, resolveProvenance } from "./provenance.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("resolveProvenance", () => {
  it("returns an object with commit, remote, and dirty when git is available", () => {
    // This test runs inside the real repo, so git is available.
    const provenance = resolveProvenance(process.cwd());
    expect(provenance).not.toBeNull();
    expect(typeof provenance.commit).toBe("string");
    expect(provenance.commit.length).toBe(40); // SHA-1 hex
    // remote may be null (no remotes) or a URL string.
    if (provenance.remote !== null) {
      expect(typeof provenance.remote).toBe("string");
      expect(provenance.remote.length).toBeGreaterThan(0);
    }
    expect(typeof provenance.dirty).toBe("boolean");
  });

  it("ignores an ambient GIT_DIR — the spawns route through environmentForTree (G-09)", () => {
    // A wrapping tool (an editor hook, an outer `git` call) can leak a
    // GIT_DIR/GIT_WORK_TREE into this process. Without the guard, the spawn
    // would read THAT repository instead of the tree at `root` — provenance
    // attributed to the wrong bytes. `environmentForTree` strips the redirects,
    // so the porcelain reflects the tree under test, never the ambient one.
    const repo = mkdtempSync(join(tmpdir(), "archkeep-git-env-guard-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "base"],
        {
          cwd: repo,
          env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
        },
      );
      const provenance = resolveProvenance(repo);
      expect(provenance).not.toBeNull();
      expect(provenance.commit).toMatch(/^[0-9a-f]{40}$/u);
      // Poison the environment and re-resolve: the guard must strip it, so the
      // answer is byte-identical instead of pointing at GIT_DIR.
      const gitEnvBackup = {
        GIT_DIR: process.env.GIT_DIR,
        GIT_WORK_TREE: process.env.GIT_WORK_TREE,
        GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
      };
      try {
        vi.stubEnv("GIT_DIR", "/somewhere/else");
        vi.stubEnv("GIT_WORK_TREE", "/somewhere/else");
        vi.stubEnv("GIT_INDEX_FILE", "/somewhere/else");
        const poisoned = resolveProvenance(repo);
        expect(poisoned.commit).toBe(provenance.commit);
        expect(poisoned.dirty).toBe(provenance.dirty);
      } finally {
        vi.unstubAllEnvs();
        for (const [key, value] of Object.entries(gitEnvBackup)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns null when the directory is not a git repository", () => {
    // Create a temp directory with no .git — resolveProvenance must return null.
    const tmp = mkdtempSync(join(tmpdir(), "archkeep-provenance-test-"));
    try {
      const provenance = resolveProvenance(tmp);
      expect(provenance).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("throws loudly on a git repository with NO commits — an unborn HEAD is not 'no origin claim'", () => {
    // The silent direction this case exists to end: `git init` with nothing
    // committed. `git ls-files` answers an empty list, so a run over this tree
    // would otherwise report a clean workspace over zero files; resolving
    // provenance as `null` would read as "no origin claim", which is a
    // different fact from "the tree's own git cannot name its state". The
    // throw makes a commitless tree a loud could-not-look (exit 3) at every
    // call site instead.
    const repo = mkdtempSync(join(tmpdir(), "archkeep-provenance-commitless-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
      expect(() => resolveProvenance(repo)).toThrow(/no commits/);
      // The near miss in the loud direction: the very same directory, one
      // commit later, is no longer a throw — the error is about the unborn
      // HEAD specifically, not about the directory being a repo.
      execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "base"],
        { cwd: repo },
      );
      expect(resolveProvenance(repo)).not.toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does NOT call a broken-HEAD committed repository 'commitless'", () => {
    // The too-broad reading of the throw above: any `--verify HEAD` failure is
    // not an unborn HEAD. A repo that HAS commits but whose HEAD points at a
    // nonexistent ref (a broken `git symbolic-ref HEAD refs/heads/nonexistent`)
    // must not be told to "commit at least once" — the tree has identity, only
    // the ref is corrupt. The message must name the broken HEAD instead.
    const repo = mkdtempSync(join(tmpdir(), "archkeep-provenance-broken-head-"));
    try {
      const ident = ["-c", "user.name=t", "-c", "user.email=t@t"];
      execFileSync("git", ["init", "-q", "-b", "main"], {
        cwd: repo,
      });
      execFileSync("git", ident.concat(["commit", "--allow-empty", "-m", "base"]), { cwd: repo });
      execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/nonexistent"], { cwd: repo });
      expect(() => resolveProvenance(repo)).toThrow(/HEAD cannot be resolved/);
      // The positive twin, so the error is about the broken ref specifically:
      // restoring HEAD to a real ref resolves normally.
      execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: repo });
      expect(resolveProvenance(repo)).not.toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports dirty=true when working tree has changes", () => {
    // This test is probabilistic (the working tree may or may not be dirty), so
    // verify the field exists and matches what git status actually reports.
    // The comparator asks the same question the bit asks — tracked files only
    // (#683) — so an untracked scratch file in whichever checkout runs the
    // suite does not read as a disagreement.
    const provenance = resolveProvenance(process.cwd());
    expect(provenance).not.toBeNull();
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      encoding: "utf-8",
    }).trim();
    const expectedDirty = status.length > 0;
    expect(provenance.dirty).toBe(expectedDirty);
  });

  it("does NOT flip dirty for an untracked file the analysis never reads (#683)", () => {
    // The bit's own comment says it tracks "any uncommitted change to tracked
    // files", and the analysis reads `git ls-files`-tracked files only — an
    // editor swap file, a scratch file, an unignored build output is none of
    // those. Bare `git status --porcelain` includes untracked paths anyway,
    // which made the envelope's `provenance.dirty` (and with it the whole
    // envelope hash) flip on trees whose analyzed inputs never changed. The
    // fixture is a frozen committed tree (#631's reasoning), so the only
    // variable between the two calls is the probe file itself.
    const repo = makeFrozenRepoWithTrackedFile();
    try {
      expect(resolveProvenance(repo).dirty).toBe(false);
      writeFileSync(join(repo, "untracked-probe.txt"), "scratch\n");
      expect(resolveProvenance(repo).dirty).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("still flips dirty on a tracked-file modification — the bit must not go blind", () => {
    // The too-broad reading of #683: if the fix above is ever "simplified" by
    // ignoring the worktree entirely, a real uncommitted edit to a tracked
    // file would report dirty=false — byte-identical to a clean tree, the
    // silent direction this repository refuses. A tracked edit MUST flip the
    // bit, and restoring the file must flip it back (the bit is the tracked
    // diff, not a latch).
    const repo = makeFrozenRepoWithTrackedFile();
    try {
      expect(resolveProvenance(repo).dirty).toBe(false);
      writeFileSync(join(repo, "src/alpha.txt"), "changed\n");
      expect(resolveProvenance(repo).dirty).toBe(true);
      execFileSync("git", ["checkout", "-q", "--", "."], { cwd: repo });
      expect(resolveProvenance(repo).dirty).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports commit matching git rev-parse HEAD", () => {
    const provenance = resolveProvenance(process.cwd());
    expect(provenance).not.toBeNull();
    const expected = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    expect(provenance.commit).toBe(expected);
  });

  it("reports remote matching the first remote URL", () => {
    const provenance = resolveProvenance(process.cwd());
    expect(provenance).not.toBeNull();
    let expectedRemote = null;
    try {
      const remotes = execFileSync("git", ["remote"], { encoding: "utf-8" }).trim();
      if (remotes) {
        const firstRemote = remotes.split("\n")[0].trim();
        expectedRemote = execFileSync("git", ["remote", "get-url", firstRemote], {
          encoding: "utf-8",
        }).trim();
      }
    } catch {
      // no remotes
    }
    expect(provenance.remote).toBe(expectedRemote);
  });
});

describe("resolveProvenance — 10-run determinism", () => {
  it("produces byte-identical output across 10 consecutive calls over the same repo", () => {
    // The loop reads a FROZEN fixture repository, not the live worktree
    // (#631): between two calls of one loop, a concurrent writer to the
    // checkout (another test, an editor, a git operation in another session)
    // can flip the live `dirty` flag, and an assertion about determinism
    // then reports a changed input as a changed answer. The fixture freezes
    // the input; the calls still drive the real `resolveProvenance` over a
    // real git repository — real child processes, only the location frozen.
    const repo = makeFrozenRepo();
    try {
      const results = Array.from({ length: 10 }, () => resolveProvenance(repo));
      // The fixture is what the loop needs it to be: a committed, clean,
      // remote-less tree whose HEAD git can name — pinned, not assumed, so a
      // fixture that stopped being frozen fails here rather than pinning a
      // determinism it does not have.
      const expectedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo,
        encoding: "utf8",
      }).trim();
      expect(results[0]).toEqual({ commit: expectedCommit, remote: null, dirty: false });
      const first = JSON.stringify(results[0]);
      for (let i = 1; i < results.length; i++) {
        expect(JSON.stringify(results[i])).toBe(first);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("the 10 results share the same object shape — commit string, remote string|null, dirty boolean", () => {
    const repo = makeFrozenRepo();
    try {
      const results = Array.from({ length: 10 }, () => resolveProvenance(repo));
      for (const result of results) {
        expect(result).not.toBeNull();
        expect(typeof result.commit).toBe("string");
        expect(result.remote === null || typeof result.remote === "string").toBe(true);
        expect(typeof result.dirty).toBe("boolean");
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

/** Creates a temp git repo with one commit and a clean tree — a frozen input. */
function makeFrozenRepo() {
  const repo = mkdtempSync(join(tmpdir(), "archkeep-provenance-frozen-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-m",
        "base",
      ],
      { cwd: repo, env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } },
    );
    return repo;
  } catch (err) {
    rmSync(repo, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Creates a temp git repo with one committed file and a clean tree — the
 * frozen input the #683 dirty-bit tests need: a tree that HAS a tracked file,
 * so the too-broad direction (the bit going blind to all worktree state) has
 * something real to flip on.
 */
function makeFrozenRepoWithTrackedFile() {
  const repo = mkdtempSync(join(tmpdir(), "archkeep-provenance-tracked-"));
  const stripEnv = () => ({
    cwd: repo,
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
  });
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/alpha.txt"), "committed\n");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."], stripEnv());
    execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "base",
      ],
      stripEnv(),
    );
    return repo;
  } catch (err) {
    rmSync(repo, { recursive: true, force: true });
    throw err;
  }
}

/** Creates a frozen repo with a remote and a second, linked worktree at the same commit — the main checkout on `main`, the linked one detached. */
function makeFrozenRepoWithWorktree() {
  const repo = mkdtempSync(join(tmpdir(), "archkeep-provenance-worktree-main-"));
  const linked = `${repo}-linked`;
  /** @returns {import("node:child_process").ExecFileSyncOptionsWithStringEncoding} The spawn options every setup call shares: the fixture's cwd, utf8 out, ambient git redirects stripped, identity and dates frozen. */
  const env = () => ({
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00.000Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00.000Z",
    },
  });
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], env());
    writeFileSync(join(repo, "tracked.txt"), "committed\n");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."], env());
    execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "base",
      ],
      env(),
    );
    execFileSync("git", ["remote", "add", "origin", "https://acme.example/invented.git"], env());
    execFileSync("git", ["worktree", "add", "-q", "--detach", linked, "HEAD"], env());
    return { repo, linked };
  } catch (err) {
    removeWorktreeFixture({ repo, linked });
    throw err;
  }
}

/** Removes the fixture: the registration first, then both directories. */
function removeWorktreeFixture({ repo, linked }) {
  try {
    execFileSync("git", ["worktree", "remove", "--force", linked], { cwd: repo });
  } catch {
    // The registration may already be gone (the repo removed under it) —
    // the rmSync calls below are the cleanup that must hold either way.
  }
  rmSync(repo, { recursive: true, force: true });
  rmSync(linked, { recursive: true, force: true });
}

/** Creates a temp git repo with two committers for attribution tests. */
function makeRepoWithTwoCommitters() {
  const repo = mkdtempSync(join(tmpdir(), "archkeep-file-attribution-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    const stripEnv = () => ({
      cwd: repo,
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
    });
    mkdirSync(join(repo, "docs/adr"), { recursive: true });
    const file = "docs/adr/0001-boundary-levels.md";
    writeFileSync(join(repo, file), "---\nstatus: proposed\n---\n");
    execFileSync(
      "git",
      ["-c", "user.name=Tess", "-c", "user.email=tess@example.com", "add", "."],
      stripEnv(),
    );
    execFileSync(
      "git",
      ["-c", "user.name=Tess", "-c", "user.email=tess@example.com", "commit", "-m", "propose"],
      stripEnv(),
    );
    // A second, later commit by a different author records the last change.
    writeFileSync(join(repo, file), "---\nstatus: accepted\n---\n");
    execFileSync(
      "git",
      ["-c", "user.name=Rex", "-c", "user.email=rex@example.com", "add", "."],
      stripEnv(),
    );
    execFileSync(
      "git",
      ["-c", "user.name=Rex", "-c", "user.email=rex@example.com", "commit", "-m", "accept"],
      stripEnv(),
    );
    return { repo, file };
  } catch (err) {
    rmSync(repo, { recursive: true, force: true });
    throw err;
  }
}

describe("resolveProvenance — what the record says about the checkout that produced it", () => {
  // The record has three fields, and every one is a fact about the
  // REPOSITORY STATE a checkout sits at — `commit` the tree bytes name,
  // `remote` the URL the repository's config shares with every clone and
  // every linked worktree, `dirty` whether that checkout's tracked files
  // still match the commit (#683: the bit is tracked-files-only). No field
  // names the checkout itself: not its path, not the ref its HEAD pointed
  // at, not which of two worktrees wrote a snapshot. Pinned here over real
  // linked worktrees, because that is the reading a snapshot consumer
  // needs: two baselines whose records are deep-equal are the same
  // repository state, and nothing in the record claims they came from the
  // same directory.

  it("cannot tell two worktrees of one repository apart — one commit, one record", () => {
    const { repo, linked } = makeFrozenRepoWithWorktree();
    try {
      const main = resolveProvenance(repo);
      const second = resolveProvenance(linked);
      // Non-vacuous first: the record carries all three fields, the remote
      // is the repository-level URL both checkouts read from the shared
      // config, and the commit is a full object id — so the equality below
      // is not two empty answers agreeing.
      expect(main).toEqual({
        commit: expect.stringMatching(/^[0-9a-f]{40,64}$/u),
        remote: "https://acme.example/invented.git",
        dirty: false,
      });
      // The main worktree's HEAD is on `main`; the linked one is detached at
      // the same commit. The records are deep-equal anyway — the ref each
      // HEAD named is exactly the kind of checkout fact the record does not
      // carry.
      expect(second).toEqual(main);
    } finally {
      removeWorktreeFixture({ repo, linked });
    }
  });

  it("the one checkout fact it does carry is an uncommitted tracked edit — `dirty` flips only in the worktree holding it", () => {
    const { repo, linked } = makeFrozenRepoWithWorktree();
    try {
      // A TRACKED file edited in the linked worktree only: `git status
      // --porcelain --untracked-files=no` is asked per root, so the answer
      // is about THAT checkout's tree, never the sibling's.
      writeFileSync(join(linked, "tracked.txt"), "edited\n");
      const main = resolveProvenance(repo);
      const second = resolveProvenance(linked);
      expect(main.dirty).toBe(false);
      expect(second.dirty).toBe(true);
      // Same commit on both sides — the flip is the working tree, not the
      // history. And `dirty` is the ONLY field that moved: `dirty` is the
      // single checkout-level signal a consumer of two same-commit records
      // can read, which is why the field's presence is pinned rather than
      // assumed.
      expect(second.commit).toBe(main.commit);
      expect({ ...second, dirty: main.dirty }).toEqual(main);
      // The inverse beat: reverting the edit re-equalizes the records — the
      // bit is the tracked diff, not a property of the checkout, so a
      // clean linked worktree is provably the same repository state again.
      execFileSync("git", ["checkout", "-q", "--", "tracked.txt"], { cwd: linked });
      expect(resolveProvenance(linked)).toEqual(resolveProvenance(repo));
    } finally {
      removeWorktreeFixture({ repo, linked });
    }
  });

  it("an untracked file in one worktree moves NO field — two same-commit records stay deep-equal (#683)", () => {
    // The #683 fix in its worktree dimension: the bit reads tracked files
    // only, so a scratch file an editor left in ONE checkout is invisible
    // to the record — the consumer comparing two baselines that name the
    // same commit sees one repository state, not a phantom dirty flag.
    // Before that fix the second record flipped to dirty=true here, and
    // the equality below read a difference the analysis never opened.
    const { repo, linked } = makeFrozenRepoWithWorktree();
    try {
      const before = resolveProvenance(repo);
      expect(before.dirty).toBe(false);
      writeFileSync(join(linked, "stray.txt"), "scratch\n");
      const main = resolveProvenance(repo);
      const second = resolveProvenance(linked);
      expect(second.dirty).toBe(false);
      expect(second).toEqual(main);
      expect(second).toEqual(before);
    } finally {
      removeWorktreeFixture({ repo, linked });
    }
  });
});

describe("resolveFileAttribution", () => {
  it("attributes the first and last commits of a file as committed static facts", () => {
    const { repo, file } = makeRepoWithTwoCommitters();
    try {
      const attribution = resolveFileAttribution(repo, file);
      expect(attribution).not.toBeNull();
      expect(attribution.createdBy.by).toBe("Tess <tess@example.com>");
      expect(attribution.lastChangedBy.by).toBe("Rex <rex@example.com>");
      // `tool` names git, and `on` is the committed author date — read, not
      // produced, so it is a stable ISO string rather than the wall clock.
      expect(attribution.createdBy.tool).toBe("git");
      expect(attribution.lastChangedBy.tool).toBe("git");
      expect(attribution.createdBy.on).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
      expect(attribution.lastChangedBy.on).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("is byte-identical across calls over the same tree — committed facts do not move", () => {
    const { repo, file } = makeRepoWithTwoCommitters();
    try {
      const first = JSON.stringify(resolveFileAttribution(repo, file));
      const second = JSON.stringify(resolveFileAttribution(repo, file));
      expect(first).toBe(second);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("ignores an ambient GIT_DIR — the spawns route through environmentForTree (G-09)", () => {
    const { repo, file } = makeRepoWithTwoCommitters();
    try {
      const baseline = JSON.stringify(resolveFileAttribution(repo, file));
      const gitEnvBackup = {
        GIT_DIR: process.env.GIT_DIR,
        GIT_WORK_TREE: process.env.GIT_WORK_TREE,
        GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
      };
      try {
        vi.stubEnv("GIT_DIR", "/somewhere/else");
        vi.stubEnv("GIT_WORK_TREE", "/somewhere/else");
        vi.stubEnv("GIT_INDEX_FILE", "/somewhere/else");
        expect(JSON.stringify(resolveFileAttribution(repo, file))).toBe(baseline);
      } finally {
        vi.unstubAllEnvs();
        for (const [key, value] of Object.entries(gitEnvBackup)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns null when the directory is not a git repository — no claim, not a throw", () => {
    const tmp = mkdtempSync(join(tmpdir(), "archkeep-file-attribution-nogit-"));
    try {
      expect(resolveFileAttribution(tmp, "docs/adr/0001-x.md")).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns null when the file was never committed — an untracked author is a lie", () => {
    const repo = mkdtempSync(join(tmpdir(), "archkeep-file-attribution-uncommitted-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Tess",
          "-c",
          "user.email=tess@example.com",
          "commit",
          "--allow-empty",
          "-m",
          "base",
        ],
        { cwd: repo, env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } },
      );
      mkdirSync(join(repo, "docs/adr"), { recursive: true });
      writeFileSync(join(repo, "docs/adr/0001-x.md"), "---\nstatus: proposed\n---\n");
      expect(resolveFileAttribution(repo, "docs/adr/0001-x.md")).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
describe("resolveFileAttribution — 10-run determinism", () => {
  it("produces byte-identical output across 10 consecutive calls over the same tree", () => {
    const { repo, file } = makeRepoWithTwoCommitters();
    try {
      const results = Array.from({ length: 10 }, () => resolveFileAttribution(repo, file));
      const first = JSON.stringify(results[0]);
      for (let i = 1; i < results.length; i++) {
        expect(JSON.stringify(results[i])).toBe(first);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("the 10 results share the same attribution shape — createdBy and lastChangedBy", () => {
    const { repo, file } = makeRepoWithTwoCommitters();
    try {
      const results = Array.from({ length: 10 }, () => resolveFileAttribution(repo, file));
      for (const result of results) {
        expect(result).not.toBeNull();
        expect(result.createdBy).toBeDefined();
        expect(result.lastChangedBy).toBeDefined();
        expect(typeof result.createdBy.by).toBe("string");
        expect(result.createdBy.tool).toBe("git");
        expect(typeof result.createdBy.on).toBe("string");
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
