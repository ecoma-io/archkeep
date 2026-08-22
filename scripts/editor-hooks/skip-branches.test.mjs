// The skip branches of format-edited-file.mjs and lint-edited-file.mjs (#237).
//
// The symlink tests in codex-post-tool-use.test.mjs prove the hooks RUN when
// they should; nothing there proves what each hook does when it must decline.
// A decline that exits 0 with no output is the dangerous shape: a hook that
// exits 0 on missing prettier is byte-for-byte identical to one that formatted
// successfully, so each branch below is pinned against its documented contract
// rather than against whatever silence happens to occur. The contracts live in
// the hooks' own headers — formatting is a fix and always exits 0; linting is
// a finding and reports through exit 2 — and where a branch violated its own
// contract (lint's missing-bin used to exit 0, reading as "linted, clean") the
// hook was fixed, not the expectation bent to match.
//
// Every case spawns the real hook over a synthetic project, the way Claude
// Code and the Codex adapter invoke them: the stdin contract plus
// CLAUDE_PROJECT_DIR. No git context is inherited — see gitIsolatedEnv() in
// codex-post-tool-use.test.mjs for why a spawned hook must never see this
// repository's GIT_* variables.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HOOKS_DIR, "..", "..");

/**
 * A minimal project the hooks will treat as their own workspace.
 *
 * `withToolBins` links the repository's real node_modules in, which brings
 * both prettier's and eslint's bins into reach from the project root. That is
 * the control that makes the extension-allowlist case mean what it says:
 * eslint IS available and the hook still declines a `.md` edit on purpose,
 * rather than declining because nothing was installed.
 *
 * @param {{withToolBins?: boolean}} [options]
 * @returns {string} the project directory
 */
function buildProject({ withToolBins = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hook-skip-branch-"));
  writeFileSync(join(dir, "eslint.config.mjs"), "export default [{}];\n");
  if (withToolBins) symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
  return dir;
}

/**
 * Runs a hook with the Claude Code stdin contract against `projectDir`.
 *
 * @param {string} hook file name in this directory
 * @param {string} projectDir value for CLAUDE_PROJECT_DIR
 * @param {object} toolInput the payload's `tool_input`
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function runHook(hook, projectDir, toolInput) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return spawnSync(process.execPath, [join(HOOKS_DIR, hook)], {
    input: JSON.stringify({ tool_input: toolInput }),
    encoding: "utf8",
    env,
  });
}

test("#237 — format-edited-file.mjs exits 0 quietly when the event names no file", () => {
  const dir = buildProject({ withToolBins: true });
  const result = runHook("format-edited-file.mjs", dir, {});
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "", "nothing to act on must not be reported as a failure");
});

test("#237 — lint-edited-file.mjs exits 0 quietly when the event names no file", () => {
  const dir = buildProject({ withToolBins: true });
  const result = runHook("lint-edited-file.mjs", dir, {});
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("#237 — lint-edited-file.mjs declines a .md edit by allowlist even with eslint available", () => {
  // Bins present is the load-bearing half: without it, exit 0 could come from
  // the missing-bin branch instead of the allowlist, and removing the
  // allowlist would change nothing this test could see.
  const dir = buildProject({ withToolBins: true });
  const doc = join(dir, "notes.md");
  writeFileSync(doc, "# notes\n");
  const result = runHook("lint-edited-file.mjs", dir, { file_path: doc });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("#237 — format-edited-file.mjs exits 0 quietly by design when prettier is absent", () => {
  // The header owns this contract: formatting is a fix, not a finding, so the
  // hook always exits 0 and leaves the bytes for the pre-commit hook to catch.
  // Pinned here so "always exits 0" stays a decision rather than an accident;
  // the unformatted bytes are asserted too, because a hook that crashed would
  // also exit non-zero but might still have rewritten the file first.
  const dir = buildProject({ withToolBins: false });
  const messy = join(dir, "messy.js");
  writeFileSync(messy, "const   x=1\n");
  const result = runHook("format-edited-file.mjs", dir, { file_path: messy });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "", "the quiet-by-design contract forbids output here too");
  assert.equal(readFileSync(messy, "utf8"), "const   x=1\n");
});

test("#237 — lint-edited-file.mjs refuses loudly when eslint is absent, instead of reading as clean", () => {
  // This was a real defect, now fixed in the hook: the missing-bin branch
  // used to process.exit(0), which is byte-for-byte identical to "linted and
  // found nothing" — the silent direction this repository judges diffs by.
  // Exit 2 with the named reason is the same convention a real violation
  // takes, and the message says what to do about it.
  const dir = buildProject({ withToolBins: false });
  const broken = join(dir, "broken.js");
  writeFileSync(broken, "const x = ;\n");
  const result = runHook("lint-edited-file.mjs", dir, { file_path: broken });
  assert.equal(result.status, 2, "a missing linter must block, not pass as clean");
  assert.match(result.stderr, /NOT linted/);
  assert.match(result.stderr, /pnpm install/);
});
