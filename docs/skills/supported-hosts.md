# Supported agent platforms

The `arch-*` skills use the Agent Skills open standard, so they work with any
agent that reads `SKILL.md` files. The table below describes what each platform
supports today.

| Platform       | Discovery method                      | Slash command | `--format json` consumption | Skill install              |
| -------------- | ------------------------------------- | ------------- | --------------------------- | -------------------------- |
| Claude Code    | Plugin `skills` field or `npx skills` | `/arch-*`     | Full                        | Plugin or `npx skills add` |
| Codex          | `.agents/skills/` or `npx skills`     | `$arch-*`     | Full                        | `npx skills add`           |
| Cursor         | `.cursor/skills/` or `npx skills`     | Via agent     | Full                        | `npx skills add`           |
| GitHub Copilot | `.github/skills/` or `npx skills`     | Via agent     | Full                        | `npx skills add`           |
| Windsurf       | `.codeium/skills/` or `npx skills`    | Via agent     | Full                        | `npx skills add`           |

All platforms consume the same canonical `SKILL.md` files. The skill content is
identical regardless of how the agent discovers it.

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

### Other platforms

`npx skills add ecoma-io/lattice` detects the agent platform and installs to
the correct directory. If your platform is not detected, use manual installation
(see [installation.md](installation.md)).
