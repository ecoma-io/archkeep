# Installing architecture skills

Three ways to install the `arch-*` skills, depending on how your agent discovers
them.

## npx skills add (recommended)

```bash
npx skills add ecoma-io/archkeep
```

This walks the `skills/` directory in the Archkeep repository, discovers all five
`SKILL.md` files, and installs them to each detected agent platform's native
directory. It is the primary distribution channel and requires no repository
configuration.

### Options

```bash
# Install specific skills only (`-s` takes space-separated names)
npx skills add ecoma-io/archkeep -s arch-context arch-check

# Install for a specific agent platform
npx skills add ecoma-io/archkeep -a claude-code

# List available skills without installing
npx skills add ecoma-io/archkeep -l

# Update previously installed skills to the latest version
npx skills update
```

## Claude Code plugin

When the plugin is enabled, skills are discovered through its `skills` field in
`plugin.json` — but enabling names a marketplace, and a marketplace has to be
registered before that name resolves. Both halves, or neither works.

Per user, with the CLI:

```bash
claude plugin marketplace add ecoma-io/archkeep
claude plugin install archkeep@archkeep
```

Per repository, so everyone who clones it gets the same thing, in a checked-in
`.claude/settings.json`:

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

`enabledPlugins` alone is the failure worth naming, because it does not look
like one: `archkeep@archkeep` names a marketplace nothing registered, so the
session starts with no skills and no language server, and says nothing about it.
`claude plugin marketplace list` answering `No marketplaces configured` is how
you tell that state from a working one.

Skills then appear as project-local slash commands: `/arch-context`,
`/arch-change`, `/arch-check`, `/arch-review`, `/arch-migrate`.

See [claude-code.md](claude-code.md) for full details.

## Codex plugin

The same plugin reaches Codex through its own catalogue,
`.agents/plugins/marketplace.json` — the one path Codex reads for a
repository's own — and its own manifest, `.codex-plugin/plugin.json`. From a
clone of a repository that ships those two files:

```bash
codex plugin marketplace add .          # or: codex plugin marketplace add ecoma-io/archkeep
codex plugin add archkeep@archkeep
```

Both commands are per user, and this is the part that does not carry over from
Claude Code: **a repository cannot enable a Codex plugin for everyone who clones
it.** Measured with codex-cli 0.149.0:

- The two commands write `[marketplaces.archkeep]` and
  `[plugins."archkeep@archkeep"] enabled = true` into `~/.codex/config.toml`.
  Those tables are what enables the plugin for every session that user starts —
  the per-user equivalent of `enabledPlugins`.
- The same tables in a repository's own `.codex/config.toml` do nothing:
  `codex plugin marketplace list` stays empty even with the project trusted.
  The project layer is read — a top-level `model` key in that file takes
  effect — so this is scoping, not a broken file.
- Only the **personal** catalogue at `~/.agents/plugins/marketplace.json` is
  discovered with no command at all. A repository-root
  `.agents/plugins/marketplace.json` is not; it is a catalogue offered, waiting
  to be added.

So Claude Code's `extraKnownMarketplaces` has no Codex counterpart **for the
plugin mechanism**. What a repository CAN do for Codex is ship the skills in the
Agent Skills shared project directory: a checked-in `.agents/skills/` holding
the same content as the canonical `skills/` directory is discovered by every
Codex session in that repository with no command at all — measured with
codex-cli 0.149.0 via `codex debug prompt-input`, which lists all five
`arch-*` skills from it, plugin or no plugin, trusted or not. This repository
ships exactly that: `.agents/skills/` is a checked-in copy of `skills/`, and
`check-skills` fails on any byte of difference between the two trees — the
same copies-held-by-a-gate arrangement the version chain uses
([versioning.md](versioning.md)). A copy rather than a symlink deliberately:
git on Windows without symlink support checks a symlink out as a plain text
file, which is a Codex session that silently lost every skill; a copy checks
out as files everywhere. After editing a skill, re-copy
(`cp -r skills/* .agents/skills/`) — forgetting is a red `check-skills`, not a
drift. Since the Codex plugin's payload for this repository is only the skills
(`.codex-plugin/plugin.json` declares nothing else), the copy gives a Codex
session everything the plugin would.

The two commands above remain the route for installing the skills by name into
sessions **outside** a repository that ships them. A user who has done both —
plugin installed, and working inside this repository — sees each skill listed
twice, which is noisy but harmless (measured: the prompt carries two entries per
skill, one from each route).

Codex will also read `.claude-plugin/marketplace.json` if a repository has no
Codex catalogue — measured, but undocumented by either vendor, so a repository
that wants Codex support should ship the Codex catalogue rather than rely on one
vendor's parser continuing to accept another's manifest.

`codex plugin add` then **copies** the plugin into
`~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/` rather than following
a live path, so a snapshot is what a session reads. After editing a skill, re-run
`codex plugin add archkeep@archkeep` to refresh that copy. Claude Code's directory
source behaves the opposite way — it reads the tree in place — which is why the
two hosts need different advice about the same edit.

## Manual installation

Copy the `skills/` directory from the repository into your agent's native
discovery path:

| Agent                  | Directory           |
| ---------------------- | ------------------- |
| Claude Code            | `.claude/skills/`   |
| Codex, Cursor, Copilot | `.agents/skills/`   |
| Cursor (also)          | `.cursor/skills/`   |
| Windsurf               | `.windsurf/skills/` |

`.agents/skills/` is the shared project-level directory of the Agent Skills
standard; agents that read it discover the same installed copy. The
per-platform matrix — including global (per-user) directories — is in
[supported-hosts.md](supported-hosts.md).

Each `SKILL.md` file must be inside a subdirectory named after the skill:
`.claude/skills/arch-context/SKILL.md`, not `.claude/skills/arch-context.md`.

Manual installations do not receive version updates automatically. Use `npx
skills add` or the plugin mechanism when possible.

## Pinning a vendored copy to the version you run

The skills are deliberately not shipped in the npm tarball — the four routes
above are the distribution channels, and the Claude Code plugin already pairs
skill content with a version through the plugin manifest
([versioning.md](versioning.md)). What a workspace vendoring the skills by
hand actually needs is not a fifth channel but a single fact answering "which
version am I vendoring": derive it from the package your lockfile already
resolves, and fetch the matching tag —

```bash
TAG="v$(node -p "require('@ecoma-io/archkeep/package.json').version")"
gh api "repos/ecoma-io/archkeep/contents/skills?ref=$TAG" --jq '.[].name'
```

release-please cuts that tag from the same release as the published tarball,
so the tag is the installed version's own fact, derived — not a second source
of truth to keep in sync. The cost that remains is a network fetch at sync
time, not at build time.

For the `npx skills add` route, the CLI keeps its own pin: installs are
recorded in `skills-lock.json`, and `npx skills experimental_install` restores
the recorded versions from it (measured against `skills` CLI help; the
subcommand is marked experimental by its authors). `skills add` itself has no
`@tag` form — the `@` in `skills use <package>@<skill>` selects a skill, not a
ref.
