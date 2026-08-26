// Integration tests for the `evolution` command over REAL Git repositories:
// multiple commits with controlled content, materialized through real
// `git worktree add`, analyzed by the real native-provider pipeline.
//
// What is under contract here is the half a stubbed spawner cannot prove
// (`./evolution.test.mjs` owns orchestration): that committed state actually
// reaches the analyzer, that the user's working tree is left untouched, that
// merges/shallow clones/unusable ranges fail loudly instead of reporting a
// shorter history, and that the JSON envelope carries the resolved SHAs a
// consumer branches on. No stub anywhere — the mechanism under test IS git's
// own behavior (`./git-shapes.integration.test.mjs` made the same argument
// for checkout shapes).
//
// The fixture workspace is NATIVE on purpose: `archkeep.json` plus Go sources,
// no Nx and no toolchain needed, so these tests run anywhere the suite runs.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { EXIT, runCli } from "../../cli.mjs";
import { environmentForTree } from "../workspace.mjs";
import { SPAWN_BUDGET_MS, SPAWN_TEST_BUDGET_MS } from "../../spawn-budget.mjs";

vi.setConfig({ testTimeout: SPAWN_TEST_BUDGET_MS });

/**
 * Runs git in `cwd` through the same environment guard production uses, with
 * the single-spawn budget on EVERY child: a wedged git (an editor a machine
 * config opens where this fixture expects none) must fail the test rather
 * than block the worker thread forever — an unbounded synchronous spawn is a
 * hang no vitest timeout can interrupt (`../../spawn-budget.mjs` owns the pair).
 */
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    env: environmentForTree(),
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS,
    killSignal: "SIGKILL",
  });

/** Identity flags keeping every fixture commit independent of the machine. */
const GIT_IDENTITY = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];

/** The workspace model: two Go projects, and the law file exempted. */
const MODEL = () =>
  JSON.stringify(
    {
      projects: {
        declared: [
          { root: "libs/alpha", name: "alpha", tags: ["layer:a"] },
          { root: "libs/beta", name: "beta", tags: ["layer:b"] },
        ],
      },
      coverage: {
        exempt: [{ path: "module-boundaries.config.mjs", reason: "the workspace's own law" }],
      },
    },
    null,
    2,
  );

const ONE_ROW = '  { sourceTag: "layer:a", onlyDependOnLibsWithTags: ["layer:b"] },';
const TWO_ROWS = `${ONE_ROW}
  { sourceTag: "layer:b", onlyDependOnLibsWithTags: ["layer:b"] },`;
/** The eight options a valid boundary law must carry, per `policyFrom`. */
const OPTIONS = `export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`;
const law = (rows) => `export const depConstraints = [\n${rows}\n];\n${OPTIONS}`;

const ALPHA_CLEAN = `package alpha

func Name() string { return "alpha" }
`;
const ALPHA_REACHING = `package alpha

import "example.com/beta"

func Name() string { return "alpha" + beta.Suffix() }
`;
const BETA = `package beta

func Suffix() string { return "-beta" }
`;

let root;
let timeline = null;

/** Writes `text` to `relativePath` under the fixture root. */
const write = (relativePath, text) => {
  mkdirSync(join(root, relativePath, ".."), { recursive: true });
  writeFileSync(join(root, relativePath), text);
};

/** Stages everything and commits with the fixture identity; returns the SHA. */
const commit = (message) => {
  git(root, ...GIT_IDENTITY, "add", "-A");
  git(root, ...GIT_IDENTITY, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD").trim();
};

/**
 * Builds the five-commit architectural timeline once and returns the resolved
 * SHAs. Commit shape, in order:
 *   C1 introduces the two-project architecture and the law
 *   C2 adds the alpha→beta edge (architecture change)
 *   C3 edits a source line without architectural effect (code drift)
 *   C4 reverts the edge (architecture change back)
 *   C5 tightens the law (policy change, graph unchanged)
 *
 * A pre-workspace commit sits below C1 — the repo's first — so a range
 * starting there exercises the not-a-readable-workspace refusal.
 */
function ensureTimeline() {
  if (timeline !== null) return timeline;
  write("README.md", "# fixture\n");
  const pre = commit("pre-workspace");

  write("archkeep.json", `${MODEL()}\n`);
  write("module-boundaries.config.mjs", law(ONE_ROW));
  write("libs/alpha/go.mod", "module example.com/alpha\n\ngo 1.22\n");
  write("libs/alpha/alpha.go", ALPHA_CLEAN);
  write("libs/beta/go.mod", "module example.com/beta\n\ngo 1.22\n");
  write("libs/beta/beta.go", BETA);
  const c1 = commit("introduce the two-project architecture");

  write("libs/alpha/alpha.go", ALPHA_REACHING);
  const c2 = commit("alpha reaches beta");

  appendFileSync(join(root, "libs/alpha/alpha.go"), "// touched without architectural effect\n");
  const c3 = commit("edit a comment");

  write("libs/alpha/alpha.go", ALPHA_CLEAN);
  const c4 = commit("revert the crossing import");

  write("module-boundaries.config.mjs", law(TWO_ROWS));
  const c5 = commit("tighten the law");

  timeline = { pre, c1, c2, c3, c4, c5 };
  return timeline;
}

/** Drives the CLI in-process over the fixture (or any cwd), capturing streams. */
async function evolve(argv, cwd = root) {
  const out = [];
  const err = [];
  const exitCode = await runCli(argv, {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    cwd,
  });
  return { exitCode, out: out.join("\n"), err: err.join("\n") };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "archkeep-evolution-cli-"));
  git(root, "init", "-q", "-b", "main");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("evolution across selected revisions", () => {
  let envelope;

  beforeAll(async () => {
    const shas = ensureTimeline();
    const run = await evolve(["evolution", "--base", shas.c1, "--format", "json"]);
    expect(run.exitCode).toBe(EXIT.ok);
    envelope = JSON.parse(run.out);
  });

  it("names the resolved range explicitly", () => {
    const shas = ensureTimeline();
    expect(envelope.result.base).toBe(shas.c1);
    expect(envelope.result.head).toBe(git(root, "rev-parse", "HEAD").trim());
    expect(envelope.result.revisions.map((r) => r.commit)).toEqual([
      shas.c1,
      shas.c2,
      shas.c3,
      shas.c4,
      shas.c5,
    ]);
    // Every revision carries its architecture identity, as history does.
    for (const revision of envelope.result.revisions) {
      expect(revision.id).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("attributes each change to the revision where it is first observed", () => {
    const shas = ensureTimeline();
    const [toEdge, drift, revert, tightened] = envelope.result.transitions;
    expect(toEdge.from).toBe(shas.c1);
    expect(toEdge.to).toBe(shas.c2);
    expect(toEdge.architectureChanged).toBe(true);
    expect(toEdge.changes.addedEdges).toEqual([
      { source: "alpha", target: "beta", type: "static" },
    ]);
    // Code moved; architecture and law did not: drift, never change.
    expect(drift.to).toBe(shas.c3);
    expect(drift.architectureChanged).toBe(false);
    expect(drift.codeDrift).toBe(true);
    expect(drift.changes).toBeNull();
    // The revert stays visible as its own transition, not collapsed away.
    expect(revert.to).toBe(shas.c4);
    expect(revert.architectureChanged).toBe(true);
    expect(revert.changes.removedEdges.length).toBe(1);
    // Same graph, different fingerprint: policy, never architecture.
    expect(tightened.to).toBe(shas.c5);
    expect(tightened.architectureChanged).toBe(false);
    expect(tightened.policyChanged).toBe(true);
    expect(tightened.codeDrift).toBe(false);
    expect(tightened.notes.join("\n")).toContain("policy");
  });

  it("keeps every analyzed origin inside this one repository", () => {
    // All revisions are worktrees of ONE repository, so cross-repository
    // provenance is structurally impossible here — asserted, not assumed:
    // no transition may carry the unrelated-repositories disclosure.
    for (const transition of envelope.result.transitions) {
      expect(transition.notes.join("\n")).not.toContain("unrelated repositories");
    }
    expect(envelope.workspace.provenance.commit).toBe(ensureTimeline().c5);
    expect(envelope.workspace.provider).toBe("native");
    expect(envelope.coverage.complete).toBe(true);
    expect(envelope.coverage.notes.join("\n")).toContain("first analyzed revision");
  });

  it("renders the same record as text, counts included", async () => {
    const run = await evolve(["evolution", "--base", timeline.c1]);
    expect(run.exitCode).toBe(EXIT.ok);
    expect(run.out).toContain("5 revisions, 4 transitions");
    expect(run.out).toMatch(/2 transitions recorded an architectural change/u);
    expect(run.out).toContain("(code drift)");
    expect(run.out).toContain("(policy)");
  });

  it("accepts peelable spellings — a tag for base, HEAD for head", async () => {
    // update-ref, never `git tag`: a machine's tag policy can open an editor
    // for an annotated tag, and a fixture must not depend on any of that.
    git(root, "update-ref", "refs/tags/v1", timeline.c1);
    const run = await evolve(["evolution", "--base", "v1", "--head", "HEAD", "--format", "json"]);
    expect(run.exitCode).toBe(EXIT.ok);
    const parsed = JSON.parse(run.out);
    expect(parsed.result.base).toBe(timeline.c1);
    expect(parsed.result.head).toBe(timeline.c5);
    expect(parsed.result.transitions.length).toBe(4);
  });
});

describe("unusable selections refuse loudly", () => {
  it("refuses a merge commit inside the range, naming it", async () => {
    const shas = ensureTimeline();
    const savedHead = git(root, "rev-parse", "HEAD").trim();
    git(root, "checkout", "-q", "-b", "side", shas.c3);
    write("libs/beta/extra.go", `${"package beta\n\nvar Extra = 1\n".trim()}\n`);
    commitFrom("side change");
    git(root, "checkout", "-q", "main");
    git(root, ...GIT_IDENTITY, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    try {
      const mergeSha = git(root, "rev-parse", "HEAD").trim();
      const run = await evolve(["evolution", "--base", shas.c1, "--format", "json"]);
      expect(run.exitCode).toBe(EXIT.error);
      expect(run.err).toContain(mergeSha.slice(0, 12));
      expect(run.err).toMatch(/is a merge commit/u);
      expect(run.out).toBe("");
    } finally {
      git(root, "reset", "-q", "--hard", savedHead);
      git(root, "branch", "-q", "-D", "side");
    }
  });

  it("refuses a range whose base predates the workspace, rather than skipping it", async () => {
    const shas = ensureTimeline();
    const run = await evolve(["evolution", "--base", shas.pre, "--format", "json"]);
    expect(run.exitCode).toBe(EXIT.error);
    expect(run.err).toContain(shas.pre.slice(0, 12));
    expect(run.err).toMatch(/could not be read as a workspace/u);
    expect(run.out).toBe("");
  });

  it("refuses an unknown revision", async () => {
    const run = await evolve(["evolution", "--base", "no-such-branch-or-tag"]);
    expect(run.exitCode).toBe(EXIT.error);
    expect(run.err).toMatch(/does not name a commit/u);
    expect(run.out).toBe("");
  });

  it("refuses coincident endpoints", async () => {
    const sha = git(root, "rev-parse", "HEAD").trim();
    const run = await evolve(["evolution", "--base", sha, "--head", sha]);
    expect(run.exitCode).toBe(EXIT.error);
    expect(run.err).toMatch(/selects nothing/u);
  });

  it("refuses a base off head's ancestry", async () => {
    // An orphan branch: its tip EXISTS in this repository but shares no
    // history with main, which is exactly the diverged-base shape.
    const savedHead = git(root, "rev-parse", "HEAD").trim();
    git(root, "checkout", "-q", "--orphan", "stray");
    // An orphan checkout inherits the old index; drop it so the stray root
    // really is a root.
    git(root, "rm", "-rqf", "--ignore-unmatch", ".");
    writeFileSync(join(root, "orphan.txt"), "# stray root\n");
    git(root, ...GIT_IDENTITY, "add", "-A");
    git(root, ...GIT_IDENTITY, "commit", "-q", "-m", "stray root");
    const strayTip = git(root, "rev-parse", "HEAD").trim();
    // Back on main's tree before driving the CLI — the run needs a workspace
    // at cwd, and the stray root deliberately has none.
    git(root, "checkout", "-q", savedHead);
    try {
      const run = await evolve(["evolution", "--base", strayTip, "--head", savedHead]);
      expect(run.exitCode).toBe(EXIT.error);
      expect(run.err).toMatch(/not an ancestor/u);
      expect(run.out).toBe("");
    } finally {
      git(root, "checkout", "-q", "main");
      git(root, "reset", "-q", "--hard", savedHead);
      git(root, "branch", "-q", "-D", "stray");
    }
  });

  it("refuses a shallow clone whose history stops short of the base", async () => {
    const shas = ensureTimeline();
    const parent = mkdtempSync(join(tmpdir(), "archkeep-evolution-shallow-"));
    const cloneRoot = join(parent, "repo");
    try {
      execFileSync("git", ["clone", "-q", "--depth", "2", `file://${root}`, cloneRoot], {
        cwd: parent,
        env: environmentForTree(),
        encoding: "utf8",
      });
      const run = await evolve(["evolution", "--base", shas.c1, "--format", "json"], cloneRoot);
      expect(run.exitCode).toBe(EXIT.error);
      expect(run.err).toMatch(/does not name a commit/u);
      expect(run.out).toBe("");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("is a usage error without --base, and with stray positionals", async () => {
    const noFlag = await evolve(["evolution"]);
    expect(noFlag.exitCode).toBe(EXIT.usage);
    const positional = await evolve(["evolution", "some/dir", "--base", "main"]);
    expect(positional.exitCode).toBe(EXIT.usage);
    const unknownFlag = await evolve(["evolution", "--base", "main", "--frobnicate"]);
    expect(unknownFlag.exitCode).toBe(EXIT.usage);
  });
});

describe("the caller's working tree", () => {
  it("stays untouched, and its dirtiness is disclosed without touching the record", async () => {
    const shas = ensureTimeline();
    const cleanRun = await evolve(["evolution", "--base", shas.c1, "--format", "json"]);
    expect(cleanRun.exitCode).toBe(EXIT.ok);
    const clean = JSON.parse(cleanRun.out);

    appendFileSync(join(root, "libs/alpha/alpha.go"), "// uncommitted desk state\n");
    try {
      const dirtyRun = await evolve(["evolution", "--base", shas.c1, "--format", "json"]);
      expect(dirtyRun.exitCode).toBe(EXIT.ok);
      const dirty = JSON.parse(dirtyRun.out);

      // Disclosed, never hidden…
      expect(dirty.workspace.provenance.dirty).toBe(true);
      expect(dirty.coverage.notes.join("\n")).toContain("uncommitted changes");
      // …and provably inert: identical transitions and revisions to the clean
      // run — the desk state reached no analyzed revision.
      expect(dirty.result.transitions).toEqual(clean.result.transitions);
      expect(dirty.result.revisions).toEqual(clean.result.revisions);

      // The user's own tree really was left holding the uncommitted edit.
      const status = git(root, "status", "--porcelain").trim();
      expect(status).toContain("libs/alpha/alpha.go");
    } finally {
      git(root, "checkout", "-q", "--", "libs/alpha/alpha.go");
    }
  });
});

/** Commits using whatever branch is currently checked out. */
function commitFrom(_branch) {
  void _branch;
  git(root, ...GIT_IDENTITY, "add", "-A");
  git(root, ...GIT_IDENTITY, "commit", "-q", "-m", "side change");
}
