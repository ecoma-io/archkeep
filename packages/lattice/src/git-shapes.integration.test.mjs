/**
 * Git edge shapes beyond the plain full checkout: a LINKED WORKTREE (`.git`
 * is a file pointing at a gitdir, not a directory), a DETACHED HEAD, and
 * SUBMODULE CONTENTS (a gitlink where a subtree used to be).
 *
 * Every answer this engine gives starts from two questions asked of git —
 * which commit is this (`./commands/provenance.mjs`) and which files are
 * tracked (`./workspace.mjs`, "Files come from git") — and both were tested
 * only against unborn and broken-HEAD repositories
 * (`./commands/provenance.test.mjs`, `./cli.integration.test.mjs`). This
 * repository is itself developed in linked worktrees, so those shapes are
 * not hypothetical: a file-list or provenance bug there reports one tree
 * while reading another, and nothing else in the pipeline can notice.
 *
 * Real git, real checkouts, no stubs — the mechanism under test is entirely
 * inside git's own discovery, and a stub would pin the intent while missing
 * it (`./workspace.integration.test.mjs`, the GIT_DIR guard, made the same
 * argument).
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { EXIT, runCli } from "../cli.mjs";
import { resolveProvenance } from "./commands/provenance.mjs";
import { createWorkspace, environmentForTree, listTrackedFiles } from "./workspace.mjs";

/**
 * Runs git in `cwd` through the same environment guard production uses, so
 * the fixtures cannot be redirected by ambient variables either.
 */
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: environmentForTree(), encoding: "utf8" });

/** Identity flags for every fixture command that can create a commit. */
const IDENTITY = ["-c", "user.name=t", "-c", "user.email=t@t"];

/** Writes `text` to `root/relativePath`, creating parent directories. */
const writeIn = (root, relativePath, text) => {
  mkdirSync(join(root, relativePath, ".."), { recursive: true });
  writeFileSync(join(root, relativePath), text);
};

describe("a linked worktree checkout", () => {
  // The law the worktree must obey, stated once and reused by every
  // assertion below: a native workspace whose adapter may not be reached,
  // with one import crossing it — so the e2e has a violation to find and a
  // file list with a known shape.
  const LATTICE_MODEL = JSON.stringify({
    projects: {
      declared: [
        { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
        { root: "libs/adapter", name: "adapter", tags: ["layer:adapter"] },
      ],
    },
    // The law file is analyzable JavaScript on the native branch, so it must
    // say why no project owns it — otherwise the e2e below measures a
    // coverage hole instead of the git shape under test.
    coverage: {
      exempt: [
        {
          path: "module-boundaries.config.mjs",
          reason: "the workspace's own boundary law",
        },
      ],
    },
  });
  const LAW = `export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: [],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`;
  const TRACKED = [
    "lattice.json",
    "libs/adapter/adapter.go",
    "libs/adapter/go.mod",
    "libs/domain/doc.go",
    "libs/domain/go.mod",
    "module-boundaries.config.mjs",
  ];

  const mainRoot = mkdtempSync(join(tmpdir(), "lattice-worktree-main-"));
  const linkedRoot = mkdtempSync(join(tmpdir(), "lattice-worktree-linked-"));
  afterAll(() => {
    rmSync(linkedRoot, { recursive: true, force: true });
    rmSync(mainRoot, { recursive: true, force: true });
  });

  const head = (() => {
    writeIn(mainRoot, "lattice.json", LATTICE_MODEL);
    writeIn(mainRoot, "module-boundaries.config.mjs", LAW);
    writeIn(mainRoot, "libs/domain/go.mod", "module example.com/domain\n\ngo 1.24\n");
    writeIn(
      mainRoot,
      "libs/domain/doc.go",
      'package domain\n\nimport "example.com/adapter"\n\nvar _ = adapter.Name\n',
    );
    writeIn(mainRoot, "libs/adapter/go.mod", "module example.com/adapter\n\ngo 1.24\n");
    writeIn(mainRoot, "libs/adapter/adapter.go", 'package adapter\n\nconst Name = "adapter"\n');
    git(mainRoot, "init", "-q", "-b", "main");
    git(mainRoot, ...IDENTITY, "add", "-A");
    git(mainRoot, ...IDENTITY, "commit", "-q", "-m", "fixture");
    // The shape under test: `.git` in the linked checkout is a FILE naming
    // the shared gitdir — every mechanism below must see through it.
    git(mainRoot, "worktree", "add", "-q", "-b", "side", linkedRoot, "HEAD");
    return git(mainRoot, "rev-parse", "HEAD").trim();
  })();

  it("lists exactly the tracked files of the worktree, through the .git file", () => {
    expect(listTrackedFiles(linkedRoot)).toEqual(TRACKED);
  });

  it("resolves provenance to the shared commit, with the worktree's own dirty flag", () => {
    expect(resolveProvenance(linkedRoot)).toEqual({
      commit: head,
      remote: null,
      dirty: false,
    });
  });

  it("runs check end to end over the linked checkout — provenance stamped, files really read", async () => {
    // No seams injected: the file list comes from real `git ls-files` in the
    // worktree and the graph from the native provider over the tracked tree.
    // The assertions refuse BOTH silent directions — an implementation whose
    // discovery could not see through the `.git` file answers either a crash
    // or a clean run over zero files, and a clean run over zero files is
    // byte-for-byte identical to a clean workspace unless the counts are held.
    const lines = { out: [], err: [] };
    const exit = await runCli(["check", "--format", "json"], {
      out: (t) => lines.out.push(t),
      err: (t) => lines.err.push(t),
      cwd: linkedRoot,
    });
    expect(exit, lines.err.join("\n")).toBe(EXIT.violations);
    const envelope = JSON.parse(lines.out.join("\n"));
    expect(envelope.workspace.provenance).toEqual({ commit: head, remote: null, dirty: false });
    expect(envelope.coverage.complete).toBe(true);
    expect(envelope.coverage.imports).toBeGreaterThan(0);
    expect(envelope.result.violations).toHaveLength(1);
    expect(envelope.result.violations[0]).toMatchObject({
      sourceFile: "libs/domain/doc.go",
      messageId: "onlyTagsConstraintViolation",
    });
  });

  it("reads the dirty flag from THIS worktree, not from the shared checkout", () => {
    // Editing a tracked file in the linked checkout must not flip any other
    // worktree's flag: `git status --porcelain` runs in the named directory
    // (`./commands/provenance.mjs`), and a provenance pair that disagreed
    // with that would stamp baselines with the wrong tree's state.
    appendFileSync(join(linkedRoot, "libs/domain/go.mod"), "// touched in the worktree\n");
    expect(resolveProvenance(linkedRoot).dirty).toBe(true);
    expect(resolveProvenance(mainRoot).dirty).toBe(false);
    expect(readFileSync(join(mainRoot, "libs/domain/go.mod"), "utf8")).not.toContain("touched");
  });
});

describe("a detached HEAD", () => {
  const repo = mkdtempSync(join(tmpdir(), "lattice-detached-head-"));
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  writeIn(repo, "first.txt", "one\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, ...IDENTITY, "add", "-A");
  git(repo, ...IDENTITY, "commit", "-q", "-m", "first");
  writeIn(repo, "second.txt", "two\n");
  git(repo, ...IDENTITY, "add", "-A");
  git(repo, ...IDENTITY, "commit", "-q", "-m", "second");
  // Detach one commit back: the checked-out TREE is the first commit's, the
  // index follows it, and HEAD names a commit instead of a branch.
  git(repo, "checkout", "-q", "--detach", "HEAD~1");

  it("resolves provenance to the detached commit itself", () => {
    const detachedHead = git(repo, "rev-parse", "HEAD").trim();
    expect(resolveProvenance(repo)).toEqual({ commit: detachedHead, remote: null, dirty: false });
  });

  it("lists the checked-out tree's files — the index follows the detachment", () => {
    expect(listTrackedFiles(repo)).toEqual(["first.txt"]);
  });

  it("still measures dirtiness against the detached commit", () => {
    appendFileSync(join(repo, "first.txt"), "edited while detached\n");
    expect(resolveProvenance(repo).dirty).toBe(true);
  });
});

describe("a submodule under the superproject", () => {
  // The pinned submodule: its own repository, committed independently, then
  // attached to the superproject at `vendors/ext`.
  const extRepo = mkdtempSync(join(tmpdir(), "lattice-submodule-ext-"));
  const superRoot = mkdtempSync(join(tmpdir(), "lattice-submodule-super-"));
  afterAll(() => {
    rmSync(superRoot, { recursive: true, force: true });
    rmSync(extRepo, { recursive: true, force: true });
  });

  writeIn(extRepo, "pkg.go", "package ext\n\nconst Value = 1\n");
  git(extRepo, "init", "-q", "-b", "main");
  git(extRepo, ...IDENTITY, "add", "-A");
  git(extRepo, ...IDENTITY, "commit", "-q", "-m", "ext");

  writeIn(
    superRoot,
    "lattice.json",
    JSON.stringify({
      projects: {
        declared: [{ root: "libs/core", name: "core", tags: ["layer:domain"] }],
      },
    }),
  );
  writeIn(superRoot, "libs/core/go.mod", "module example.com/core\n\ngo 1.24\n");
  writeIn(superRoot, "libs/core/core.go", 'package core\n\nconst Name = "core"\n');
  git(superRoot, "init", "-q", "-b", "main");
  git(superRoot, ...IDENTITY, "add", "-A");
  git(superRoot, ...IDENTITY, "commit", "-q", "-m", "super");
  git(
    superRoot,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-q",
    extRepo,
    "vendors/ext",
  );
  git(superRoot, ...IDENTITY, "commit", "-q", "-m", "vendor ext");

  it("ends the tracked-file set at the gitlink — contents are another repository's tree", () => {
    // `git ls-files` lists the GITLINK itself (`vendors/ext`, mode 160000)
    // and nothing beneath it, plus the `.gitmodules` file the attachment
    // wrote. That is the named outcome, not an accident to repair: the
    // pinned contents belong to the submodule repository's own law, and
    // recursing into them here would judge bytes this tree never reviewed —
    // the same reason resolvers read tracked files only (`./workspace.mjs`,
    // "Files come from git").
    expect(listTrackedFiles(superRoot)).toEqual([
      ".gitmodules",
      "lattice.json",
      "libs/core/core.go",
      "libs/core/go.mod",
      "vendors/ext",
    ]);
  });

  it("attributes the gitlink path, and no source file under it, to a project rooted there", () => {
    // A workspace that declares a project INSIDE the submodule directory
    // owns exactly one tracked path — the gitlink — which no analyzer claims
    // (`languageOf` answers null for it). So the project's Go sources are
    // neither read nor judged, visibly: they appear in no file list this
    // tool builds, rather than silently inside some other project's count.
    const { workspace, owned } = createWorkspace({
      root: superRoot,
      graph: { nodes: { ext: { name: "ext", data: { root: "vendors/ext" } } }, dependencies: {} },
      files: listTrackedFiles(superRoot),
    });
    expect(workspace.filesOf("ext")).toEqual(["vendors/ext"]);
    expect(owned.map(({ file }) => file)).toEqual(["vendors/ext"]);
  });

  it("resolves provenance over the superproject without disturbance", () => {
    const head = git(superRoot, "rev-parse", "HEAD").trim();
    expect(resolveProvenance(superRoot)).toEqual({ commit: head, remote: null, dirty: false });
  });
});
