#!/usr/bin/env node
// PostToolUse(Write|Edit) hook, shared by Claude Code, opencode, and Codex:
// run the doc-reference gate after a markdown file is written, so a broken or
// out-of-docs link is reported while the edit is still in context. Exit code
// 2 surfaces the findings to the agent immediately, the same convention
// `lint-edited-file.mjs` uses.
//
// The stdin contract is Claude Code's (`tool_input.file_path`); the opencode
// plugin and the Codex adapter restate it per file so every agent reaches
// this one implementation.
//
// Runs the gate script through Node directly (not `pnpm exec`) so the hook
// works wherever Node works. The gate scans the whole tracked tree rather
// than just the edited file on purpose: a link's target usually lives in
// another file, and the gate's job is to resolve every reference, not to
// lint one edit in isolation.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/**
 * Resolves to the real (symlink-free) absolute path, falling back to a plain
 * `resolve()` when the path does not exist (e.g. `realpathSync` throws) —
 * the fallback keeps this usable on a path this hook is about to reject
 * anyway, without itself throwing on a since-deleted file.
 *
 * @param {string} path
 * @returns {string}
 */
export function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

try {
  if (process.env.CLAUDE_PROJECT_DIR) process.chdir(process.env.CLAUDE_PROJECT_DIR);
} catch {
  process.exit(0); // no project directory — nothing to check
}

const input = JSON.parse(readFileSync(0, "utf8"));
const file = input.tool_input?.file_path ?? "";
if (!file) process.exit(0);

// A scratch file outside the project is not covered by this repository's
// doc-reference gate, so checking it would report rules that do not apply.
// Resolved on REAL paths, not just `resolve()`: Node resolves symlinks when
// `chdir`ing, so `process.cwd()` above is already symlink-free, but the
// naive `resolve(file)` is not — a project checked out through a symlinked
// parent directory made every edited file compare as "outside the project"
// and this hook silently exited 0 for the whole session. Same class of bug
// as `isProgramEntry` in `scripts/check-packages.mjs`.
if (!realPath(file).startsWith(realPath(process.cwd()) + sep)) process.exit(0);

// Only markdown files carry doc links; an edit that touches no markdown
// cannot have broken one.
if (!/\.md$/.test(file)) process.exit(0);

const gate = "scripts/check-docs-links.mjs";
if (!existsSync(gate)) process.exit(0); // not at the repository root

const r = spawnSync(process.execPath, [gate], { encoding: "utf8" });
if (r.status !== 0) {
  if (r.error) process.stderr.write(`${r.error}\n`);
  process.stderr.write((r.stdout ?? "") + (r.stderr ?? ""));
  process.exit(2);
}
