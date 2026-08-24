// Tests for codex-post-tool-use.mjs.
//
// `parseTouchedFiles` is the pure half of the Codex hook — it reads the file
// names out of an apply_patch command text — so it is the half worth pinning.
// The rest of the adapter spawns the shared editor-hook scripts with that
// list; a test that stubbed those spawns would only pin the stub, and the
// real thing is exercised by a Codex session. Each case below goes red in the
// SILENT direction: an unparsed file name means the gates never run on that
// file, which is exactly the quiet gap the hook exists to close.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseTouchedFiles } from "./codex-post-tool-use.mjs";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HOOKS_DIR, "..", "..");

test("parses Update, Add, and Delete File markers", () => {
  const command = `*** Begin Patch ***
*** Update File: docs/usage/ci.md ***
@@ -1,1 +1,2 @@
- old
+ new
*** Add File: packages/archkeep/src/editor-gates.js ***
@@ -0,0 +1,1 @@
+ new file
*** Delete File: docs/usage/troubleshooting.md ***
@@ -1,1 +0,0 @@
- gone
*** End Patch ***
`;
  assert.deepEqual(parseTouchedFiles(command), [
    "docs/usage/ci.md",
    "packages/archkeep/src/editor-gates.js",
    "docs/usage/troubleshooting.md",
  ]);
});

test("returns an empty list for a command with no File markers — nothing to gate", () => {
  assert.deepEqual(parseTouchedFiles("*** Begin Patch ***\n*** End Patch ***\n"), []);
});

test("trims surrounding whitespace off a marker path", () => {
  const command = "*** Update File:   docs/usage/ci.md   ***\n";
  assert.deepEqual(parseTouchedFiles(command), ["docs/usage/ci.md"]);
});

test("keeps every marker, not just the first", () => {
  const command = `*** Update File: a.md ***
*** Update File: b.md ***
*** Update File: c.md ***
`;
  assert.deepEqual(parseTouchedFiles(command), ["a.md", "b.md", "c.md"]);
});

test("ignores marker-like lines that are not at the start of the line", () => {
  const command = "some context *** Update File: not-a-file.md ***\n";
  assert.deepEqual(parseTouchedFiles(command), []);
});

// The adapter used to feed every touched path — deletions included — through
// `lint-edited-file.mjs`. ESLint exits non-zero ("No files matching the
// pattern") on a path that no longer exists, exactly the way it exits
// non-zero on a real lint violation, so this adapter's "any non-zero exit is
// a finding" convention turned every JS/TS deletion into a false finding.
// Silent-direction risk here is inverted from most of this repository's
// gates: the false signal is LOUD (a finding that is not real), but it is
// still the failure this hook exists to avoid — a `*** Delete File:` patch
// has nothing left on disk to gate.
test("a Delete-File-only patch produces no finding — there is nothing left on disk to gate", () => {
  const result = spawnSync(process.execPath, [join(HOOKS_DIR, "codex-post-tool-use.mjs")], {
    cwd: REPO_ROOT,
    input: JSON.stringify({
      cwd: REPO_ROOT,
      tool_input: {
        command:
          "*** Begin Patch ***\n" +
          "*** Delete File: scripts/editor-hooks/does-not-exist-test-fixture.mjs ***\n" +
          "*** End Patch ***\n",
      },
    }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `expected no finding, got:\n${result.stderr}`);
  assert.equal(result.stderr, "");
});

// A synthetic project reached through a symlinked root, reproducing the
// shape a symlinked checkout gives every editor hook: `format-, lint-, and
// check-docs-links-edited-file.mjs` each filtered with
// `!resolve(file).startsWith(process.cwd() + sep)`. `resolve()` does not
// follow symlinks, but `process.cwd()` — read after `process.chdir()` — is
// already symlink-resolved (Node resolves symlinks on chdir), so every
// edited file compared as "outside the project" and each hook silently
// exited 0 for the whole session, never running. The three tests below
// build a minimal real project, alias it behind a symlink, and drive each
// hook exactly as Claude Code / the Codex adapter would: `CLAUDE_PROJECT_DIR`
// set to the SYMLINKED root, and `file_path` spelled through that same root
// — and assert an effect only a hook that actually ran could produce.
function buildSymlinkedProject() {
  const real = mkdtempSync(join(tmpdir(), "editor-hook-symlink-"));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(real, "node_modules"));
  const link = `${real}-link`;
  symlinkSync(real, link);
  return { real, link };
}

/**
 * `process.env` with every `GIT_*` variable stripped. When this test file
 * itself runs from a git hook (`pre-commit`/`pre-push`, via lefthook), git
 * sets `GIT_DIR` (and friends) in the hook's own environment so the hook's
 * git commands operate on the SAME repository git is currently processing.
 * `spawnSync` inherits `process.env` by default, so without this a spawned
 * `git init`/`git ls-files` in a synthetic project directory silently
 * reinitializes and reads THIS repository instead — measured directly:
 * `GIT_DIR=<this repo>/.git git init /tmp/x` reports "Reinitialized
 * existing Git repository" at this repo's path, and `git ls-files` there
 * then lists this repository's real tracked files. Every synthetic project
 * below needs true isolation from whatever git context invoked the test.
 *
 * @returns {NodeJS.ProcessEnv}
 */
function gitIsolatedEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return env;
}

test("lint-edited-file.mjs still lints a file reached via a symlinked project root", () => {
  const { real, link } = buildSymlinkedProject();
  // A flat config with one entry is enough for ESLint to run; a parsing
  // error is reported regardless of which rules are configured, so this
  // needs no rule set of its own to stay in sync with the real one.
  writeFileSync(join(real, "eslint.config.mjs"), "export default [{}];\n");
  writeFileSync(join(real, "broken.js"), "const x = ;\n");

  const result = spawnSync(process.execPath, [join(HOOKS_DIR, "lint-edited-file.mjs")], {
    input: JSON.stringify({ tool_input: { file_path: join(link, "broken.js") } }),
    encoding: "utf8",
    env: { ...gitIsolatedEnv(), CLAUDE_PROJECT_DIR: link },
  });

  // Old code: the file compares as "outside the project" and the hook exits
  // 0 without ever invoking ESLint — the syntax error goes unreported.
  assert.equal(
    result.status,
    2,
    `expected the syntax error to be reported, got:\n${result.stderr}`,
  );
  assert.match(result.stderr, /Parsing error/u);
});

test("format-edited-file.mjs still formats a file reached via a symlinked project root", () => {
  const { real, link } = buildSymlinkedProject();
  writeFileSync(join(real, "messy.js"), "const   x=1\n");

  const result = spawnSync(process.execPath, [join(HOOKS_DIR, "format-edited-file.mjs")], {
    input: JSON.stringify({ tool_input: { file_path: join(link, "messy.js") } }),
    encoding: "utf8",
    env: { ...gitIsolatedEnv(), CLAUDE_PROJECT_DIR: link },
  });

  assert.equal(result.status, 0);
  // Old code: the file compares as "outside the project" and the hook exits
  // 0 having never run Prettier, leaving the messy bytes untouched.
  const written = readFileSync(join(real, "messy.js"), "utf8");
  assert.equal(written, "const x = 1;\n");
});

test("check-docs-links-edited-file.mjs still runs the gate for a file reached via a symlinked project root", () => {
  const { real, link } = buildSymlinkedProject();
  mkdirSync(join(real, "scripts"));
  // A real copy of the gate script, not a symlink: its own `root` is derived
  // from its own file location (`dirname(import.meta.url)/..`), and it must
  // land inside `real` regardless of how this test reaches it.
  writeFileSync(
    join(real, "scripts", "check-docs-links.mjs"),
    readFileSync(join(REPO_ROOT, "scripts", "check-docs-links.mjs"), "utf8"),
  );
  writeFileSync(join(real, "README.md"), "placeholder\n");
  // `git init`, with nothing added: `git ls-files` then succeeds but returns
  // an empty list, which is a deterministic, environment-independent signal
  // — unlike relying on `real` NOT being inside any git repository, which a
  // stray ancestor `.git` elsewhere on the machine could make true or false
  // depending on where the test happens to run. `gitIsolatedEnv()` is
  // required here too: without it, `git init` run from inside a git hook
  // reinitializes THIS repository instead of `real` (see its doc comment).
  spawnSync("git", ["init"], { cwd: real, encoding: "utf8", env: gitIsolatedEnv() });

  const result = spawnSync(
    process.execPath,
    [join(HOOKS_DIR, "check-docs-links-edited-file.mjs")],
    {
      input: JSON.stringify({ tool_input: { file_path: join(link, "README.md") } }),
      encoding: "utf8",
      env: { ...gitIsolatedEnv(), CLAUDE_PROJECT_DIR: link },
    },
  );

  // Old code: the file compares as "outside the project" and the hook exits
  // 0 without ever spawning the gate script. The fixed hook reaches the
  // gate, which then fails loudly for an unrelated reason — the gate's own
  // "no files were scanned" refusal, since nothing is tracked yet — proof
  // the gate actually ran, not a false pass.
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no files were scanned/u);
});
