#!/usr/bin/env node
// PostToolUse(Write|Edit) hook: lint the file that was just written, after
// `format-edited-file.mjs` has already normalised it. Exit code 2 surfaces the
// violations to the agent immediately, while the edit is still in context —
// which is the whole point of linting here rather than at commit time.
//
// Runs ESLint's own bin through Node directly (not `pnpm exec`) so the hook
// works wherever Node works.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

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
if (!resolve(file).startsWith(process.cwd() + sep)) process.exit(0);

if (!/\.(vue|js|ts|mts|cts|mjs|cjs)$/.test(file)) process.exit(0);

const eslint = "node_modules/eslint/bin/eslint.js";
if (!existsSync(eslint)) process.exit(0); // dependencies not installed yet

const r = spawnSync(process.execPath, [eslint, "--no-warn-ignored", "--max-warnings", "0", file], {
  encoding: "utf8",
});
if (r.status !== 0) {
  if (r.error) process.stderr.write(`${r.error}\n`);
  process.stderr.write((r.stdout ?? "") + (r.stderr ?? ""));
  process.exit(2);
}
