# Installing architecture skills

Three ways to install the `arch-*` skills, depending on how your agent discovers
them.

## npx skills add (recommended)

```bash
npx skills add ecoma-io/lattice
```

This walks the `skills/` directory in the Lattice repository, discovers all four
`SKILL.md` files, and installs them to each detected agent platform's native
directory. It is the primary distribution channel and requires no repository
configuration.

### Options

```bash
# Install specific skills only
npx skills add ecoma-io/lattice -s arch-context,arch-check

# Install for a specific agent platform
npx skills add ecoma-io/lattice -a claude-code

# List available skills without installing
npx skills add ecoma-io/lattice -l

# Update to the latest version
npx skills add ecoma-io/lattice --force
```

## Claude Code plugin

When the `@ecoma-io/lattice` plugin is enabled in your project, skills are
automatically discovered through the plugin's `skills` field in `plugin.json`.
No additional installation step is needed.

Enable the plugin in `.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "lattice@lattice": true
  }
}
```

Skills then appear as project-local slash commands: `/arch-context`,
`/arch-change`, `/arch-check`, `/arch-review`.

See [claude-code.md](claude-code.md) for full details.

## Manual installation

Copy the `skills/` directory from the repository into your agent's native
discovery path:

| Agent       | Directory         |
| ----------- | ----------------- |
| Claude Code | `.claude/skills/` |
| Codex       | `.agents/skills/` |
| Cursor      | `.cursor/skills/` |

Each `SKILL.md` file must be inside a subdirectory named after the skill:
`.claude/skills/arch-context/SKILL.md`, not `.claude/skills/arch-context.md`.

Manual installations do not receive version updates automatically. Use `npx
skills add` or the plugin mechanism when possible.
