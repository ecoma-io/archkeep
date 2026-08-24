# Claude Code integration

Two things the Archkeep plugin provides to a Claude Code session:

1. **The LSP server** — real-time boundary diagnostics in the editor, via the
   plugin's language server.
2. **The `arch-*` skills** — behavioral protocol for architecture-aware coding,
   discovered through the plugin's `skills` field.

They are separate artifacts with separate jobs. The LSP server flags violations
as you type; the skills teach the agent what to do before and after changes.

## Setup

### Enable the plugin

`.claude/settings.json` needs two keys, not one — `archkeep@archkeep` names a
plugin AND the marketplace it comes from, and the marketplace has to be
registered before the name resolves:

```json
{
  "extraKnownMarketplaces": {
    "archkeep": {
      "source": { "source": "github", "repo": "ecoma-io/archkeep" }
    }
  },
  "enabledPlugins": {
    "archkeep@archkeep": true
  }
}
```

Publishing a catalogue is not registering one: `.claude-plugin/marketplace.json`
states what a repository offers, and nothing reads it on a session's behalf.
With `enabledPlugins` alone the session starts with no skills and no language
server, and no line says so — run `claude plugin marketplace list` to tell that
state apart from a working one.

Once both keys are in place, the LSP server starts automatically when you open a
file in a Archkeep-governed project.

This repository configures itself the same way, with one difference: its own
`.claude/settings.json` uses a `directory` source at `.` rather than the
`github` source above, so a session here runs the plugin from the working tree
under review instead of from the default branch. See
[installation.md](installation.md) for the per-user CLI route and for Codex.

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
modify. It runs `archkeep context <project>` and interprets the constraints
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
  `allowed-tools` field. The agent must request permission to run `archkeep`
  commands — this is intentional friction.
- **They do not modify boundary policy.** A skill that told the agent to edit
  `module-boundaries.config.*` to make a check pass would be a skill that
  subverts the architecture it is supposed to enforce.
- **They do not replace the CLI.** The skills teach; the CLI decides. An agent
  following `arch-check` gets the same exit codes and the same JSON envelope a
  human running `archkeep check` would get.

## Alternative: npx skills add

If you prefer not to use the plugin, skills can be installed independently:

```bash
npx skills add ecoma-io/archkeep -a claude-code
```

This installs the `SKILL.md` files to `.claude/skills/` in your project. The
skills are identical; the difference is that the plugin also provides the LSP
server for real-time diagnostics.
