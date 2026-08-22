#!/usr/bin/env node
// PostToolUse(Write|Edit) hook, shared by Claude Code, opencode, and Codex:
// lint the file that was just written, after `format-edited-file.mjs` has
// already normalised it. Exit code 2 surfaces the violations to the agent
// immediately, while the edit is still in context — which is the whole point
// of linting here rather than at commit time.
//
// The stdin contract is Claude Code's (`tool_input.file_path`); the opencode
// plugin and the Codex adapter restate it per file so every agent reaches
// this one implementation.
//
// Runs ESLint's own bin through Node directly (not `pnpm exec`) so the hook
// works wherever Node works.
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
  process.exit(0); // no project directory — nothing to lint
}

const input = JSON.parse(readFileSync(0, "utf8"));
const file = input.tool_input?.file_path ?? "";
if (!file) process.exit(0);

// A scratch file outside the project is not covered by this repository's
// ESLint config, so linting it would report rules that do not apply to it.
// Resolved on REAL paths, not just `resolve()`: Node resolves symlinks when
// `chdir`ing, so `process.cwd()` above is already symlink-free, but the
// naive `resolve(file)` is not — a project checked out through a symlinked
// parent directory made every edited file compare as "outside the project"
// and this hook silently exited 0 for the whole session. Same class of bug
// as `isProgramEntry` in `scripts/check-packages.mjs`.
if (!realPath(file).startsWith(realPath(process.cwd()) + sep)) process.exit(0);

if (!/\.(vue|js|ts|mts|cts|mjs|cjs)$/.test(file)) process.exit(0);

const eslint = "node_modules/eslint/bin/eslint.js";
if (!existsSync(eslint)) {
  // Linting is a finding, not a fix — the inverse of this file's format twin,
  // whose header owns why IT may exit 0 quietly. A missing dependency tree
  // must not read as a file with no violations: exit 2 with the reason, the
  // same convention a real violation takes below.
  process.stderr.write(
    `lint-edited-file.mjs: ${eslint} was not found from ${process.cwd()} — dependencies are ` +
      `not installed, so the edit was NOT linted. Run \`pnpm install\`, then re-edit the file.\n`,
  );
  process.exit(2);
}

const r = spawnSync(process.execPath, [eslint, "--no-warn-ignored", "--max-warnings", "0", file], {
  encoding: "utf8",
});
if (r.status !== 0) {
  if (r.error) process.stderr.write(`${r.error}\n`);
  process.stderr.write((r.stdout ?? "") + (r.stderr ?? ""));
  process.exit(2);
}
