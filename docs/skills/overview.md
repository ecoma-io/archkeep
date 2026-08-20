# Agent architecture skills

The `arch-*` skills teach an AI agent the architecture governance workflow in a
Lattice-governed repository: establish the architectural facts, make an
architecture-aware change, get an authoritative verdict, review changes by
evidence, and bring a repository that has no declared model under governance in
the first place. They are the agent-facing layer of a three-part architecture:

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
  plugin discovers skills through its `skills` field; `npx skills add`
  discovers them from the repository-root `skills/` directory.

## The governance lifecycle in five skills

The skills implement one conceptual lifecycle:

```
OBSERVE → CONTEXT → CHANGE → CHECK → EVIDENCE → REVIEW
       ↳ MIGRATE when there is no declared model yet
                ↘                     ↳ EVOLVE when necessary
```

None of the five skills is a single command. Each teaches the agent _when_ to
run the minimum sufficient set of `lattice` operations — `context`, `check`,
`diff`, `drift`, `discover`, `reconcile`, `waivers`, `fitness`, `history`,
`health`, `debt`, `impact`, `explain`, `graph`, `provenance`, `adr` — and never
requires every command for every change.

`check` is the only command that exits 1 on boundary findings — with one
companion: `fitness` also exits 1 when a declared function `fail`s, because a
failing fitness function is a finding. Every other command is descriptive or
proposal-only: `graph`, `diff`, `drift`, `discover`, `reconcile`, `impact`,
`explain`, `context`, `history`, `waivers`, `health`, `debt`, `provenance`,
and `adr` never exit 1 on their own, and both `--propose` surfaces mark their
output as proposals that are never written — no command writes to the Intent.
Reconciling a stale declared architecture with the observed one is a human
decision the CLI can only shape, never make.

| Skill                         | When                                                                |
| ----------------------------- | ------------------------------------------------------------------- |
| [arch-context](#arch-context) | Before modifying code — establish the facts and constraints         |
| [arch-change](#arch-change)   | Making a change — architecture-aware edit, verifiable evidence      |
| [arch-check](#arch-check)     | After a change — the authoritative fail-closed gate                 |
| [arch-review](#arch-review)   | Reviewing a change, PR, or diff — evidence-backed governance review |
| [arch-migrate](#arch-migrate) | No declared model yet — derive one, review it, adopt it by hand     |

### arch-context

Establishes the architectural facts and governance constraints relevant to a
change before code is modified: what architecture exists, what Intent applies,
which law is in effect (a policy file or a named profile), what the plan
context exposes, and what supporting evidence (impact, drift, history, ADR
bindings) matters. The agent runs `lattice context <project>` (with `--plan` for
a code change), reads `lattice drift --format json` when the declared Intent is
at stake, resolves a rule's `decisionRef` through `lattice adr` when one is
present, and proceeds only within the boundaries those facts establish.

### arch-change

Makes an architecture-aware change. The agent reads the constraints and the
declared Intent (arch-context) under the law in effect — a policy file or the
profile `boundaryConfig` selects — makes the smallest coherent change, inspects
the architectural `diff` when the change is architectural, runs `lattice check`
to verify, checks `drift` when the architecture changed, verifies impacted
projects with `impact`, and reports what changed — never by modifying the
boundary policy, the profile registry, or the Intent to make a check pass.

### arch-check

Runs the authoritative deterministic gate. `lattice check` is the verdict —
boundary rules and the declared Intent in one run, against the law in effect
(the profile `boundaryConfig`/`--config` selects when a `profiles` registry is
active). Exit 0 means compliant and fully analyzed; exit 1 means findings; exit
3 means **no verdict** — an unanalyzable file, an unverifiable intent, or a
profile that could not be resolved — and that is not the same as clean. Unknown
or incomplete never silently becomes PASS.

### arch-review

An evidence-backed governance review. The agent establishes context (naming the
law in effect), decides whether the change is architectural, evaluates impact,
runs the authoritative check, evaluates drift when Intent or architecture
differs, verifies a reviewed rule's `decisionRef` through `lattice adr` when one
is present, explains non-obvious findings, and — when the architecture model
itself looks stale — reports the discrepancy rather than silently rewriting the
Intent. Uses a decision tree so a trivial change gets the minimum set and a
governance change gets the full one.

### arch-migrate

Brings a repository that has no declared model — or one nobody trusts — under
governance, without hand-writing the Intent up front. The agent observes with
`lattice discover`, clears the coverage gaps that would make any derived model
incomplete, derives candidates with `lattice discover --propose`, reviews them
against what the repository is _for_ (a proposal describes what the code does,
including what it does wrong), drafts `architecture-intent.json` and the
boundary config as an explicit diff a human can refuse, converges with the
`lattice reconcile --propose` loop, and only then hands the gate to `check`.
The separation it teaches is the point: Lattice derives, a human adopts, and no
command writes the Intent. The end-to-end path is
[usage/migration.md](../usage/migration.md).

## Host independence

Canonical skills live in `skills/` at the repository root. They use only the
Agent Skills open standard frontmatter (`name`, `description`,
`compatibility`) — no host-specific fields, and no `metadata` block: the
skills carry no version by decision ([versioning.md](versioning.md)). The `scripts/check-skills.mjs` gate
enforces this in CI.

Host-specific configuration belongs in the plugin or agent settings, not in the
skill. This separation means the same `SKILL.md` files work across Claude Code,
Codex, Cursor, and any agent that reads the Agent Skills standard.

## How agents discover skills

### npx skills add

```bash
npx skills add ecoma-io/lattice
```

Walks `skills/` at the repository root, discovers all five `SKILL.md` files, and
installs them to each agent platform's native directory. This is the primary
distribution channel for consumers.

### Claude Code plugin

When the `@ecoma-io/lattice` plugin is enabled, its `plugin.json` declares a
`skills` field pointing to the canonical `skills/` directory. Skills appear as
project-local slash commands (`/arch-context`, `/arch-change`, etc.).

See [claude-code.md](claude-code.md) for setup details.

## Relationship to agentic development

[concepts/agentic-development.md](../concepts/agentic-development.md) documents
the questions an agent asks and the commands that answer them, and
[concepts/governance-lifecycle.md](../concepts/governance-lifecycle.md) documents
why the commands form a system. The skills layer wraps those commands in
behavioral protocol — teaching an agent _when_ to ask, _why_ it matters, and
_what to do_ when the answer is not clean.

The commands are the authority. The skills are the teacher.
