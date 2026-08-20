# Supported agent platforms

The `arch-*` skills use the Agent Skills open standard, so they work with any
agent that reads `SKILL.md` files. The table below describes what each platform
supports today.

| Platform       | Project discovery                        | Global discovery              | Invocation          | `--format json` consumption | Skill install              |
| -------------- | ---------------------------------------- | ----------------------------- | ------------------- | --------------------------- | -------------------------- |
| Claude Code    | Plugin `skills` field, `.claude/skills/` | `~/.claude/skills/`           | `/arch-*`           | Full                        | Plugin or `npx skills add` |
| Codex          | `.agents/skills/`                        | `~/.codex/skills/`            | `$arch-*` (mention) | Full                        | `npx skills add`           |
| opencode       | `.agents/skills/`                        | `~/.config/opencode/skills/`  | Via agent           | Full                        | `npx skills add`           |
| Cursor         | `.agents/skills/` or `.cursor/skills/`   | `~/.cursor/skills/`           | `/` in Agent chat   | Full                        | `npx skills add`           |
| GitHub Copilot | `.agents/skills/` or `.github/skills/`   | `~/.copilot/skills/`          | Via agent           | Full                        | `npx skills add`           |
| Windsurf       | `.windsurf/skills/`                      | `~/.codeium/windsurf/skills/` | Via agent           | Full                        | `npx skills add`           |

All platforms consume the same canonical `SKILL.md` files. The skill content is
identical regardless of how the agent discovers it. `.agents/skills/` is the
Agent Skills standard's shared project-level directory: one installed copy
serves every agent that reads it. The project and global columns are the
directories `npx skills add` targets per platform (its `-g` flag selects the
global column); a platform that additionally documents its own native
directory (Cursor's `.cursor/skills/`, Copilot's `.github/skills/`) is listed
with both.

## What "full consumption" means

Every `arch-*` skill directs the agent to run `lattice` commands with
`--format json`. The JSON envelope is versioned and machine-readable; any agent
that can execute shell commands and parse JSON can follow the protocol in full.

Agents that cannot run shell commands can still read the skill content for
context, but they cannot act on the `HOW` steps.

## Platform-specific notes

### Claude Code

Full integration: skills appear as slash commands, the plugin provides the LSP
server for real-time diagnostics, and the agent can run `lattice` commands
directly. See [claude-code.md](claude-code.md).

### Codex

Reads AGENTS.md natively, so the skill names and purposes are surfaced through
that file. Install via `npx skills add ecoma-io/lattice -a codex` for full
skill discovery.

### opencode

Runs the same editor-time gates as Claude Code and Codex: the PostToolUse
format, lint and doc-reference checks run after every file edit through this
repository's opencode plugin (`.opencode/plugins/editor-gates.js`). Install the
skills via `npx skills add ecoma-io/lattice -a opencode`.

### Other platforms

`npx skills add ecoma-io/lattice` detects the agent platform and installs to
the correct directory. If your platform is not detected, use manual installation
(see [installation.md](installation.md)).
