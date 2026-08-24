# Authoring arch-* skills

Conventions for writing new skills in the `arch-*` namespace. The gate —
`scripts/check-skills.mjs` in CI — validates `name`, `description`, and the
host-independence contract below, and holds the version chain
([versioning.md](versioning.md)); these conventions are the part of that gate
the authoring side must meet.

## Frontmatter rules

Every `SKILL.md` must begin with YAML frontmatter containing at minimum:

```yaml
---
name: arch-skill-name
description: One-line description of what the skill teaches
compatibility: Requires @ecoma-io/archkeep CLI
---
```

### Required fields

- **`name`** — must match the parent directory name. If the skill lives in
  `skills/arch-review/`, the name must be `arch-review`.
- **`description`** — one line, human-readable, describing what the skill teaches
  (not what the agent does).

### Optional fields

- **`compatibility`** — describes what the skill requires. Should mention
  `archkeep` or `@ecoma-io/archkeep` so consumers know the dependency.

### Forbidden fields

The canonical skills carry **no `metadata` block — and no `metadata.version` —
by decision** ([versioning.md](versioning.md)): a per-skill version would have
to be bumped by hand on every release, and a version that drifts is worse than
none because it reads as current. The version that matters is the plugin
manifest's, and the chain (not any per-skill field) is what keeps it in
lockstep. Do not add a version field.

The following fields are **host-specific** and must not appear in canonical
skills:

- `context` — Claude Code extension
- `model` — Claude Code extension
- `effort` — Claude Code extension
- `agent` — Claude Code extension
- `paths` — Claude Code extension

These belong in the plugin or agent settings, not in the skill. The gate script
detects them and fails the build.

## Content conventions

### Structure: WHEN / WHY / HOW / FAILURE

Every skill should teach four things:

1. **WHEN** — the situation where the agent should invoke this skill. Be
   specific: "before modifying code in a Archkeep-governed project" is better
   than "when you need architecture help."

2. **WHY** — the reason the skill exists. What goes wrong when the agent does
   not follow it? "An agent that does not understand boundary constraints will
   create violations by default" is the kind of reasoning that helps the agent
   decide whether to invoke the skill in an edge case.

3. **HOW** — the steps the agent should follow. Each step names a `archkeep`
   command and explains what to do with the output. Use `--format json` for
   machine-readable output.

4. **FAILURE** — what to do when things go wrong. Exit code 3 is not clean.
   A project not found is not a green light. An empty scoped check does not
   mean the workspace is safe globally. These are the failure modes that look
   like success if the agent does not think about them.

### No `allowed-tools`

Do not add `allowed-tools` to the frontmatter. The agent must request permission
to run `archkeep` commands — this is a safety feature, not a friction. A skill
that auto-bypasses permission checks is a skill that could silently modify
boundary policy.

### Skills teach; the CLI decides

Never duplicate enforcement logic in skill content. The skill describes the
protocol ("run `archkeep check` and interpret the exit code"); the CLI provides
the verdict. If the skill says "check if an import crosses a boundary," it has
taken a decision away from the engine.

### Links are absolute

Every markdown link in a `SKILL.md` is an absolute `https://` URL, with one
exemption: a `#anchor` into the skill's own body, which travels with the file
and so cannot be the defect below. A skill is
vendored — copied into a consumer's own skills directory, installed by
`npx skills add`, read from `.agents/skills/` one directory deeper than the
canonical tree — and a repo-relative target survives every one of those moves
as valid markdown. It does not 404 there; it resolves against a tree this
repository does not control and lands on some other page, or on nothing. A link
that points at the wrong page reads as authoritative while being wrong.

Links into this repository take the form
`https://github.com/ecoma-io/archkeep/blob/main/<path>`. `scripts/check-skills.mjs`
refuses any other shape and resolves `<path>` against the tracked tree, so a doc
renamed on `main` turns the gate red instead of leaving a dead URL in a shipped
skill. Note the exemption is a PREFIX test: `../../elsewhere/page.md#status` is
repo-relative first and anchored second, and is refused like any other relative
target.

### Name all exit codes

The CLI has four exit codes. A skill that only mentions exit 0 and exit 1 has
left out the one that matters most: exit 3 means the check could not complete,
and that is not the same as "clean."

| Exit code | Meaning            | Skill should say                                   |
| --------- | ------------------ | -------------------------------------------------- |
| 0         | No violations      | The workspace is compliant.                        |
| 1         | Violations found   | Read each violation; fix the code, not the policy. |
| 2         | Usage error        | Check command syntax.                              |
| 3         | Could not complete | Do NOT assume clean. Investigate the blind spot.   |

## Adding a new skill

1. Create `skills/arch-name/SKILL.md` with valid frontmatter
2. Add the directory name to `EXPECTED_SKILLS` in `scripts/check-skills.mjs`
3. Write the content following WHEN/WHY/HOW/FAILURE
4. Run `node scripts/check-skills.mjs` to validate
5. Run `node --test scripts/check-skills.test.mjs` and update tests if needed
6. Update `docs/skills/overview.md` to list the new skill

## Naming

Skills in the `arch-*` namespace deal with architecture boundaries. A skill that
does not relate to boundary enforcement does not belong in this namespace —
it belongs in a different namespace or a different repository.
