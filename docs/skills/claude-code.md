# Claude Code integration

Two things the Lattice plugin provides to a Claude Code session:

1. **The LSP server** — real-time boundary diagnostics in the editor, via the
   plugin's language server.
2. **The `arch-*` skills** — behavioral protocol for architecture-aware coding,
   discovered through the plugin's `skills` field.

They are separate artifacts with separate jobs. The LSP server flags violations
as you type; the skills teach the agent what to do before and after changes.

## Setup

### Enable the plugin

In `.claude/settings.json`, add the plugin to the enabled list:

```json
{
  "enabledPlugins": {
    "lattice@lattice": true
  }
}
```

The plugin is discovered from the marketplace catalogue this repository
publishes. Once enabled, the LSP server starts automatically when you open a
file in a Lattice-governed project.

### Verify skills are available

In a Claude Code session, type `/arch` — the five skills should appear as
completions:

- `/arch-context` — understand boundaries before changing
- `/arch-change` — architecture-aware coding workflow
- `/arch-check` — validate after changes
- `/arch-review` — architecture impact for reviews
- `/arch-migrate` — bring an ungoverned repository under a declared model

## Using the skills

### Before changing code

```
/arch-context
```

The agent reads the boundary constraints for the project you are about to
modify. It runs `lattice context <project>` and interprets the constraints
before proposing any code change.

### After changing code

```
/arch-check
```

The agent validates that the change respects boundaries. If violations exist, it
reads them, fixes the code (not the policy), and re-checks.

### For a full architecture-aware workflow

```
/arch-change
```

This combines context and check: inspect → modify → validate → fix.

### When reviewing a PR

```
/arch-review
```

The agent gathers context, checks violations, computes downstream impact, and
summarizes architecture implications.

## What the skills do not do

- **They do not auto-bypass permission checks.** The skills contain no
  `allowed-tools` field. The agent must request permission to run `lattice`
  commands — this is intentional friction.
- **They do not modify boundary policy.** A skill that told the agent to edit
  `module-boundaries.config.*` to make a check pass would be a skill that
  subverts the architecture it is supposed to enforce.
- **They do not replace the CLI.** The skills teach; the CLI decides. An agent
  following `arch-check` gets the same exit codes and the same JSON envelope a
  human running `lattice check` would get.

## Alternative: npx skills add

If you prefer not to use the plugin, skills can be installed independently:

```bash
npx skills add ecoma-io/lattice -a claude-code
```

This installs the `SKILL.md` files to `.claude/skills/` in your project. The
skills are identical; the difference is that the plugin also provides the LSP
server for real-time diagnostics.
