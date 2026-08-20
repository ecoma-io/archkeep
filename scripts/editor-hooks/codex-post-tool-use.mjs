#!/usr/bin/env node
// Codex PostToolUse hook: feed every file an apply_patch touched through the
// same editor-time gates Claude Code and opencode run, so the checks have
// exactly one implementation across every agent.
//
// Codex delivers one JSON object on stdin. Unlike Claude Code's shape
// (`tool_input.file_path`), the edited file is not named directly: an
// apply_patch `tool_input.command` carries the patch text, and the touched
// files appear as `*** Update File: <path> ***` (and `*** Add File:` /
// `*** Delete File:`) markers. The path is workspace-relative, so it is
// joined to the session cwd before being handed to the shared hooks.
//
// The shared scripts expect Claude Code's stdin shape and exit 0 when they
// intentionally do nothing (a `.mjs` edit triggers no doc gate), so this
// adapter restates that shape per file and treats any non-zero exit as a
// finding. Exit code 2 with the findings on stderr is the convention Codex
// itself documents for blocking hook feedback.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The files an apply_patch command touches, in order: every
 * `*** (Update|Add|Delete) File: <path> ***` marker's path, trimmed.
 * Pure, so the adapter's parsing is testable without a Codex session.
 *
 * @param {string} command the patch text Codex delivers as `tool_input.command`
 * @returns {string[]} workspace-relative file paths
 */
export function parseTouchedFiles(command) {
  return [...command.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+?) \*\*\*$/gm)]
    .map((m) => m[1].trim())
    .filter((path) => path !== "");
}

if (isProgramEntry(import.meta.url)) main();

function main() {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const cwd = input.cwd ?? process.cwd();
  const command = input.tool_input?.command ?? "";
  if (typeof command !== "string" || command === "") process.exit(0);

  const touched = parseTouchedFiles(command);
  if (touched.length === 0) process.exit(0);

  const gates = [
    "format-edited-file.mjs",
    "lint-edited-file.mjs",
    "check-docs-links-edited-file.mjs",
  ];
  const findings = [];
  for (const file of touched) {
    // A `*** Delete File:` marker (or any touched path the patch left
    // absent) has nothing left to gate: `lint-edited-file.mjs` would run
    // ESLint against a path that no longer exists, and ESLint exits 2 ("No
    // files matching the pattern") on a missing path the same way it does on
    // a real lint violation — indistinguishable from this adapter's own
    // "findings" convention, so every JS/TS deletion was reported as a false
    // finding. Format and doc-link gates have the same problem for their own
    // extensions, so the skip applies before any gate runs, not only before
    // `lint-edited-file.mjs`.
    if (!existsSync(join(cwd, file))) continue;
    for (const gate of gates) {
      const r = spawnSync(process.execPath, [`scripts/editor-hooks/${gate}`], {
        cwd,
        input: JSON.stringify({ tool_input: { file_path: join(cwd, file) } }),
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
      });
      if (r.status === 0) continue;
      findings.push(`[${gate}] ${file}:\n${r.stdout ?? ""}${r.stderr ?? ""}`);
    }
  }
  if (findings.length > 0) {
    process.stderr.write(findings.join("\n"));
    process.exit(2);
  }
}

/**
 * Whether this file was RUN rather than imported, compared on real paths.
 * See `check-packages.mjs` for the reason this exists and why it is not shared.
 */
function isProgramEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}
