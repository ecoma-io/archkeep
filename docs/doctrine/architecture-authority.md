# Architecture authority

What Lattice is, what surrounds it, and the line every one of those neighbours
may not cross. This document owns the system boundary and the non-goals that
follow from it. It states the boundary once; every other page that touches the
question links here rather than restating it.

## The system

Lattice is an **architecture governance system for human and agentic software
development**: a deterministic authority that sits above a repository's
project tooling and answers one question with a machine-computed verdict —
_does the code that exists agree with the architecture that was declared_?

The thesis is one sentence, owned by [north-star.md](north-star.md):

> Agentic coding increases the rate at which architectural decisions are made.
> Humans cannot manually review every architectural decision. Therefore
> architecture must become explicit, machine-readable, continuously checked,
> available to agents, and enforceable.

The conceptual model, from the repository up:

```
Repository
    ↓
Architecture model
    ↓
Policy / intent
    ↓
Deterministic evidence
    ↓
Governance
    ↓
Human + coding agent
```

`check` is the only command that exits with a finding, and it earns that role by
reporting a verdict on every reachable path or refusing to look silently
([exit-codes.md](../reference/exit-codes.md)). Every other command produces
evidence a human or an agent can act on — context before an edit, impact during
planning, diff across time, explain after a finding. None of them judges.

## What is not Lattice

Four things sit around the core, and each has a boundary it must not cross.
They are named so that "replace the authority with the provider" is recognised
as a direction change rather than an implementation detail.

### Nx and Moon are providers, not the foundation

Lattice reads a project graph from a provider — Nx, Moon, or the native
discovery that needs neither. That seam exists precisely so the authority does
not depend on any of them. A workspace with Nx keeps `affected` and the project
graph; a Moonrepo workspace reads its own graph back; a repository that has
neither still gets the full verdict. The core model, the constraint table and
the rule engine are provider-independent — the intent contract `Provider
independence` is proven by an architecture test in
`packages/lattice/src/intent/intent-manifest.json`.

What an integration may and must not do is owned by
[concepts/integrations.md](../concepts/integrations.md).

### Agent skills are a protocol, not the engine

The `arch-*` skills teach an agent when to ask the authority and how to read its
answers. They contain no enforcement logic; every `HOW` step is a `lattice`
command. The authority stays in the core: the skills are the teacher, the CLI is
the judge ([skills/overview.md](../skills/overview.md)).

### The agent is a consumer, not an authority

The agent reasons, plans and modifies code. It does not decide whether the
architecture is valid. When an agent needs to know whether an edge is allowed,
it asks `lattice context` / `impact` / `diff` / `check` and reads the machine
verdict. When its code violates a boundary, the violation comes back the same
way a human's does — from the authority, never from the agent's own judgment.

The commands an agent consumes are read-only. Nothing an agent can run changes
the constraint table to make its own import pass.

### CI is a venue, not a jurisdiction

CI runs `lattice check` and gates on its exit code. Governance is defined by the
constraint table in the workspace and the verdict the authority computes; CI is
where that verdict is acted on, and it is as replaceable as the provider it
runs against.

## The boundary, stated once

| role                   | decides                                                        | supplies                                 |
| ---------------------- | -------------------------------------------------------------- | ---------------------------------------- |
| **Lattice**            | is this edge valid? (deterministic, inspectable, reproducible) | verdict, context, impact, diff, evidence |
| **Provider** (Nx/Moon) | how is the project graph shaped?                               | graph edges, project discovery           |
| **Native discovery**   | how is the graph read with no tool?                            | graph edges, project discovery           |
| **Agent**              | what code to write, and whether to follow the verdict          | reasoning, planning, code modification   |
| **CI / PR**            | does this change block, and when?                              | a gate on the verdict                    |

The two columns restated as the model the thesis gives:

```
Lattice = architecture truth + constraints + evidence
Agent   = reasoning + action
```

Each side holds its half. An agent that is handed "the architecture is fine"
without a `lattice` verdict behind it is being handed a claim with no
authority — the exact silence this project exists to end.

## Non-goals

Lattice is not any of these. The list is defensive positioning, not a rule
change: each item is a direction the project will not take even when it is
convenient, because taking it would move the boundary above.

- **A build system.** It declares no targets, runs nothing, and never replaces
  what a workspace builds.
- **A package manager.** It reads manifests as data and resolves nothing.
- **An Nx replacement or a Moon replacement.** Both remain first-class
  integrations; Lattice is the layer above them.
- **An LLM.** It computes verdicts from source; it does not reason about them.
- **An autonomous architect.** It proposes no redesign and prescribes no
  architecture; it reports whether code agrees with the one that was declared.
- **A code generator.** It writes no code.
- **An AI code reviewer.** Review remains a human or agent judgment; Lattice
  supplies the evidence that judgment is anchored to.
- **A replacement for CI.** It produces an exit code; a pipeline decides what to
  do with it.

## How the boundary is enforced

The line above is not prose. Each piece of it is held by a mechanism:

- **Provider independence** — an architecture test refuses provider imports in
  the core layers (`src/conformance/boundary.test.mjs`, intent contract **A**).
- **The core does not depend on a build system** — principle 5,
  [principles.md](principles.md); no provider shells out to a language toolchain.
- **Skills never duplicate enforcement** — host-independent `SKILL.md` files,
  gated by `scripts/check-skills.mjs`; every `HOW` step is a `lattice` command.
- **The agent cannot edit the law** — the constraint table is a file in the
  workspace, and the commands an agent consumes are read-only
  ([agentic-development.md](../concepts/agentic-development.md)).
- **Determinism** — the same tree and configuration produce the same verdict,
  proven byte-for-byte by the determinism suite (intent contract **K**).

## Where this leaves the roadmap

Because the boundary is stable, the roadmap is about breadth and reading, not
about the boundary itself: which languages a workspace may govern (owned by
[north-star.md](north-star.md)), which capabilities are in 1.x, and what 2.x
extends on top of the deterministic core. [roadmap.md](../roadmap.md) owns the
staged path; this document owns the line that path stays inside.
