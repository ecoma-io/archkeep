// opencode plugin: run the same editor-time gates Claude Code runs, after every
// edit or write. The plugin is a thin adapter — it reads the edited file path
// off the tool call and hands it to the shared hook scripts in
// scripts/editor-hooks/ through the same stdin JSON shape Claude Code's hooks
// consume, so the checks have exactly one implementation across every agent.
//
// Matches Claude Code's PostToolUse(Write|Edit) matcher: the "edit" and
// "write" tools of this repository's opencode config, which both carry the
// edited file as `args.filePath` (measured from the edit and write tool
// implementations in the opencode source this repository runs against).
//
// The shared scripts chdir to `CLAUDE_PROJECT_DIR` when it is set — the name
// is Claude Code's, but the variable is the mechanism the scripts use to find
// the repository root, and it is documented in their headers. Setting it to
// the opencode project directory makes the same scripts work unmodified.
//
// The plugin runs inside the opencode process (Bun), so it delegates through
// `node:child_process` — Node's spawn API, polyfilled by Bun — rather than
// assuming a `node` binary exists on PATH. process.execPath is the runtime
// that launched opencode, which runs plain `.mjs` either way.
import { spawnSync } from "node:child_process";

export const EditorGates = async ({ directory, worktree }) => {
  const root = worktree || directory;
  return {
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "edit" && input.tool !== "write") return;
      const file = input.args?.filePath;
      if (typeof file !== "string" || file === "") return;

      // The three gates, in the same order Claude Code's settings.json runs
      // them: format first (so the linter and doc gate read normalised
      // bytes), then lint, then the doc-reference gate for markdown.
      const gates = [
        "format-edited-file.mjs",
        "lint-edited-file.mjs",
        "check-docs-links-edited-file.mjs",
      ];
      for (const gate of gates) {
        const r = spawnSync(process.execPath, [`scripts/editor-hooks/${gate}`], {
          cwd: root,
          input: JSON.stringify({ tool_input: { file_path: file } }),
          encoding: "utf8",
          env: { ...process.env, CLAUDE_PROJECT_DIR: root },
        });
        if (r.status === 0) continue;
        // Surface the findings in the tool result the model sees next, the
        // same way Claude Code's exit code 2 does — the edit stays in
        // context and the agent is told exactly what to fix.
        output.output =
          `${output.output}\n\n[editor-gates] ${gate} exited ${r.status} for ${file}:\n` +
          `${r.stdout ?? ""}${r.stderr ?? ""}`;
      }
    },
  };
};
