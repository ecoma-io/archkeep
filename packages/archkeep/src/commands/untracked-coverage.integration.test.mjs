/**
 * The tracked-universe boundary (#675): `check`'s analysis universe is
 * `git ls-files` verbatim, so a file a project owns that was never `git
 * add`-ed never enters it — and before this contract existed, a run over such
 * a tree printed the same clean verdict as a run over the whole tree, with
 * nothing anywhere naming what the universe had left out. The loud-coverage
 * contract (`./coverage-loudness.integration.test.mjs`) holds for files the
 * universe CONTAINS; this file holds it for the universe's own boundary.
 *
 * The verdict posture follows the `unowned-files` bargain: the run judged
 * every file in its universe and the verdict over that universe stands —
 * exit 0, `coverage.complete` true over the judged surface — but the run
 * names every project-owned, analyzable file it never read, as an
 * `"untracked-files"` coverage-gap row in the JSON envelope and as a section
 * in the text report, so a clean verdict over a partial universe is
 * distinguishable from a clean verdict over the whole one. What is forbidden
 * is not exit 0; it is silence.
 *
 * Every fixture below is a REAL git repository driven by the real spawned
 * CLI, because the boundary under test IS git's index: an injected
 * `listFiles` seam would decide the universe by fiat and never exercise the
 * listing the gap is about. The intent-to-add case (`git add -N`) is pinned
 * green on purpose: an intent-to-add file IS listed by `git ls-files`, so it
 * already enters the universe and its violation already fires — this file
 * exists to keep that true, not to introduce it.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { EXIT } from "../verdict.mjs";
import { SPAWN_BUDGET_MS, SPAWN_TEST_BUDGET_MS } from "../../spawn-budget.mjs";
import { environmentForTree } from "../workspace.mjs";

vi.setConfig({ testTimeout: SPAWN_TEST_BUDGET_MS });

const CLI = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

const LAW = `export const depConstraints = [
  { sourceTag: "layer:a", onlyDependOnLibsWithTags: ["layer:a"] },
  { sourceTag: "layer:b", onlyDependOnLibsWithTags: ["layer:b"] },
];
export const moduleBoundaryOptions = {
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

const MODEL = () =>
  `${JSON.stringify(
    {
      projects: {
        declared: [
          { root: "libs/alpha", name: "alpha", tags: ["layer:a"] },
          { root: "libs/beta", name: "beta", tags: ["layer:b"] },
          { root: "libs/gamma", name: "gamma", tags: ["layer:a"] },
        ],
      },
      coverage: {
        exempt: [{ path: "module-boundaries.config.mjs", reason: "the workspace's own law" }],
      },
    },
    null,
    2,
  )}\n`;

const GO_MOD = (name) => `module example.com/${name}\n\ngo 1.22\n`;
/** beta and gamma are clean and committed. */
const BETA = `package beta

func Name() string { return "beta" }
`;
const GAMMA = `package gamma

import "example.com/alpha"

func Name() string { return alpha.Name() }
`;
/** alpha clean, committed. */
const ALPHA_CLEAN = `package alpha

func Name() string { return "alpha" }
`;
/** The planted violation: alpha reaches into beta across the layer axis. */
const ALPHA_REACHING = `package alpha

import "example.com/beta"

func Name() string { return "alpha" + beta.Name() }
`;
/** An untracked file that carries no boundary crossing at all. */
const ALPHA_NEW_CLEAN = `package alpha

func Next() string { return "alpha" }
`;

/** Identity flags keeping the fixture's commit independent of the machine. */
const GIT_IDENTITY = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];

/**
 * Builds a native-provider workspace: three Go projects committed, with the
 * files of `untracked` written but never `git add`-ed — the never-added
 * population the gap is about. Every untracked path is real on disk, inside a
 * project root, and absent from the index the universe is built from.
 */
function makeWorkspace(untracked) {
  const root = mkdtempSync(join(tmpdir(), "archkeep-untracked-coverage-"));
  const write = (relativePath, text) => {
    mkdirSync(join(root, relativePath, ".."), { recursive: true });
    writeFileSync(join(root, relativePath), text);
  };
  write("archkeep.json", MODEL());
  write("module-boundaries.config.mjs", LAW);
  write("libs/alpha/go.mod", GO_MOD("alpha"));
  write("libs/alpha/alpha.go", ALPHA_CLEAN);
  write("libs/beta/go.mod", GO_MOD("beta"));
  write("libs/beta/beta.go", BETA);
  write("libs/gamma/go.mod", GO_MOD("gamma"));
  write("libs/gamma/gamma.go", GAMMA);
  const git = (args) =>
    spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: SPAWN_BUDGET_MS,
      killSignal: "SIGKILL",
      env: environmentForTree(),
    });
  for (const args of [
    ["init", "-q", "-b", "main"],
    GIT_IDENTITY.concat(["add", "-A"]),
    GIT_IDENTITY.concat(["commit", "-q", "-m", "fixture"]),
  ]) {
    const run = git(args);
    expect(run.status).toBe(0);
  }
  // Written only AFTER the commit, so these are the never-added population:
  // real on disk, owned by a project, and absent from the index the universe
  // is built from. Written before it, `git add -A` would have tracked them.
  for (const [relativePath, text] of untracked) write(relativePath, text);
  return { root, git };
}

/** Spawns the real CLI over `root` and parses the JSON envelope. */
const runCheckJson = (root, args = []) => {
  const run = spawnSync(process.execPath, [CLI, "check", "--format", "json", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS,
    killSignal: "SIGKILL",
    env: environmentForTree(),
  });
  return { status: run.status, envelope: JSON.parse(run.stdout), stderr: run.stderr };
};

/** Spawns the real CLI in its default text format. */
const runCheckText = (root) =>
  spawnSync(process.execPath, [CLI, "check"], {
    cwd: root,
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS,
    killSignal: "SIGKILL",
    env: environmentForTree(),
  });

/** The one untracked-files row of an envelope, or `undefined`. */
const untrackedGap = (envelope) =>
  (envelope.coverage.coverageGaps ?? []).find((gap) => gap.kind === "untracked-files");

describe("#675 — a project-owned file the universe never read is named, never silent", () => {
  const violating = makeWorkspace([["libs/alpha/alpha-reach.go", ALPHA_REACHING]]);
  afterAll(() => rmSync(violating.root, { recursive: true, force: true }));

  it("the never-added violating file does not leave the clean verdict bare", () => {
    const { status, envelope } = runCheckJson(violating.root);
    // The verdict over the tracked universe still stands: every tracked file
    // was read and none crosses. What must change is that the run names the
    // file it never read — before the fix this envelope was byte-for-byte the
    // clean workspace's, with no trace of libs/alpha/alpha-reach.go anywhere.
    expect(status).toBe(EXIT.ok);
    expect(envelope.status).toBe("ok");
    expect(envelope.result.violations).toEqual([]);
    const gap = untrackedGap(envelope);
    expect(gap).toBeDefined();
    expect(gap.files).toEqual(["libs/alpha/alpha-reach.go"]);
  });

  it("the text report names the file the run never read", () => {
    const run = runCheckText(violating.root);
    expect(run.status).toBe(EXIT.ok);
    expect(run.stdout).toContain("libs/alpha/alpha-reach.go");
    expect(run.stdout).toMatch(/never read|untracked/u);
  });
});

describe("#675 — the population the gap names, and the ones it does not", () => {
  // Two untracked Go files written so their creation order is the reverse of
  // the order the row must report; an untracked Markdown file and an ignored
  // file, which the row must NOT name.
  const mixed = makeWorkspace([
    ["libs/gamma/second.go", ALPHA_NEW_CLEAN],
    ["libs/gamma/first.go", ALPHA_NEW_CLEAN],
    ["libs/alpha/notes.md", "# notes\n"],
    ["libs/beta/generated.go", BETA],
  ]);
  afterAll(() => rmSync(mixed.root, { recursive: true, force: true }));
  beforeAll(() => {
    writeFileSync(join(mixed.root, ".gitignore"), "libs/beta/generated.go\n");
  });

  it("names the analyzable owned files in sorted order, and nothing else", () => {
    const { status, envelope } = runCheckJson(mixed.root);
    expect(status).toBe(EXIT.ok);
    const gap = untrackedGap(envelope);
    expect(gap).toBeDefined();
    // Sorted by plain string comparison — the row's bytes must not vary with
    // the order the files were created or git happens to answer (E-F10).
    expect(gap.files).toEqual(["libs/gamma/first.go", "libs/gamma/second.go"]);
  });

  it("does not name a gitignored file — the universe's ignore rules stay git's", () => {
    const { envelope } = runCheckJson(mixed.root);
    const gap = untrackedGap(envelope);
    expect(gap?.files ?? []).not.toContain("libs/beta/generated.go");
  });

  it("does not name a file no analyzer could judge — a gap that always fires is skipped", () => {
    const { envelope } = runCheckJson(mixed.root);
    const gap = untrackedGap(envelope);
    expect(gap?.files ?? []).not.toContain("libs/alpha/notes.md");
  });

  it("leaves coverage.complete true over the judged surface — the gap is beside it", () => {
    const { envelope } = runCheckJson(mixed.root);
    expect(envelope.coverage.complete).toBe(true);
    expect(envelope.coverage.notAnalyzed).toEqual([]);
  });

  it("reports the same row bytes across repeated runs", () => {
    const first = runCheckJson(mixed.root);
    const second = runCheckJson(mixed.root);
    expect(JSON.stringify(first.envelope.coverage.coverageGaps)).toBe(
      JSON.stringify(second.envelope.coverage.coverageGaps),
    );
  });
});

describe("#675 — intent-to-add files are inside the universe (pinned)", () => {
  const intent = makeWorkspace([["libs/alpha/alpha-reach.go", ALPHA_REACHING]]);
  afterAll(() => rmSync(intent.root, { recursive: true, force: true }));

  it("a `git add -N` file is listed by ls-files, so its violation fires", () => {
    const add = intent.git(["add", "-N", "libs/alpha/alpha-reach.go"]);
    expect(add.status).toBe(0);
    const { status, envelope } = runCheckJson(intent.root);
    expect(status).toBe(EXIT.violations);
    expect(envelope.status).toBe("findings");
    expect(envelope.result.violations.length).toBe(1);
    // And the file is no longer a gap — it was read and judged.
    expect(untrackedGap(envelope)?.files ?? []).not.toContain("libs/alpha/alpha-reach.go");
  });
});
