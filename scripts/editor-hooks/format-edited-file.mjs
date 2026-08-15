#!/usr/bin/env node
// PostToolUse(Write|Edit) hook, shared by Claude Code, opencode, and Codex:
// format the file that was just written with Prettier, so the agent never
// hands back bytes the pre-commit hook would rewrite underneath it.
//
// The stdin contract is Claude Code's (`tool_input.file_path`); the opencode
// plugin and the Codex adapter restate it per file so every agent reaches
// this one implementation.
//
// Runs Prettier's own bin through Node directly rather than `pnpm exec`, so the
// hook works wherever Node works. Formatting is a fix, not a finding: this hook
// always exits 0 — a file Prettier cannot parse is left untouched for
// `lint-edited-file.mjs` to report.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

try {
  if (process.env.CLAUDE_PROJECT_DIR) process.chdir(process.env.CLAUDE_PROJECT_DIR);
} catch {
  process.exit(0); // no project directory — nothing to format
}

const input = JSON.parse(readFileSync(0, "utf8"));
const file = input.tool_input?.file_path ?? "";
if (!file) process.exit(0);

// A scratch file outside the project is not ours to rewrite.
if (!resolve(file).startsWith(process.cwd() + sep)) process.exit(0);

const prettier = "node_modules/prettier/bin/prettier.cjs";
if (!existsSync(prettier)) process.exit(0); // dependencies not installed yet

// `--ignore-unknown` makes an unsupported extension a no-op instead of an
// error, so the hook needs no extension list of its own to keep in sync.
spawnSync(process.execPath, [prettier, "--write", "--ignore-unknown", file], {
  encoding: "utf8",
});
