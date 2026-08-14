# Agent architecture skills

The `arch-*` skills teach an AI agent how to discover, understand, and respect
architecture boundaries in a Lattice-governed repository. They are the
agent-facing layer of a three-part architecture:

```
Lattice CLI (deterministic authority)
        ↓
arch-* skills (behavioral protocol)
        ↓
Host integrations (npx skills, Claude Code plugin)
        ↓
Agent
```

- **Core** = deterministic authority. Skills call `lattice` CLI commands; they
  never duplicate enforcement logic.
- **Skills** = behavioral protocol. Host-independent `SKILL.md` files at the
  repository root `skills/` directory, teaching WHEN/WHY/HOW/FAILURE.
- **Host integrations** = packaging for each agent platform. The Claude Code
  plugin discovers skills through its `skills` field; `npx skills add` discovers
  them from `skills/` at depth 1.

## The four skills

| Skill                         | When                                                       |
| ----------------------------- | ---------------------------------------------------------- |
| [arch-context](#arch-context) | Before modifying code — understand the boundary landscape  |
| [arch-change](#arch-change)   | Before and after modifying code — architecture-aware edits |
| [arch-check](#arch-check)     | After changes — validate boundary compliance               |
| [arch-review](#arch-review)   | Reviewing a change, PR, or diff — architecture impact      |

### arch-context

Understand architecture boundaries before changing code. The agent runs
`lattice context <project>` to learn which constraints apply, then proceeds only
within those boundaries.

### arch-change

Architecture-aware coding workflow. The agent inspects constraints (arch-context),
makes the change, runs `lattice check`, and fixes any violations — never by
modifying the boundary policy.

### arch-check

Validate after changes. `lattice check` is the authoritative verdict. Exit 0
means compliant; exit 1 means violations; exit 3 means the check could not
complete — and that is not the same as clean.

### arch-review

Orchestration for code review. The agent gathers context, checks for violations,
computes downstream impact, and summarizes architecture implications. Trivial
edits may only need arch-check; cross-project changes warrant the full workflow.

## Host independence

Canonical skills live in `skills/` at the repository root. They use only the
Agent Skills open standard frontmatter (`name`, `description`, `metadata`,
`compatibility`) — no host-specific fields. The `scripts/check-skills.mjs` gate
enforces this in CI.

Host-specific configuration belongs in the plugin or agent settings, not in the
skill. This separation means the same `SKILL.md` files work across Claude Code,
Codex, Cursor, and any agent that reads the Agent Skills standard.

## How agents discover skills

### npx skills add

```bash
npx skills add ecoma-io/lattice
```

Walks `skills/` at the repository root, discovers all four `SKILL.md` files, and
installs them to each agent platform's native directory. This is the primary
distribution channel for consumers.

### Claude Code plugin

When the `@ecoma-io/lattice` plugin is enabled, its `plugin.json` declares a
`skills` field pointing to the canonical `skills/` directory. Skills appear as
project-local slash commands (`/arch-context`, `/arch-change`, etc.).

See [claude-code.md](claude-code.md) for setup details.

## Relationship to agentic development

[concepts/agentic-development.md](../concepts/agentic-development.md) documents
the three questions an agent asks and the commands that answer them. The skills
layer wraps those commands in behavioral protocol — teaching an agent _when_ to
ask, _why_ it matters, and _what to do_ when the answer is not clean.

The commands are the authority. The skills are the teacher.
