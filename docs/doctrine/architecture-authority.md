# Architecture authority

What Archkeep is, what surrounds it, and the line every one of those neighbours
may not cross. This document owns the system boundary, the contract everything
built on top of it answers to, and the non-goals that follow from both. It
states the boundary once; every other page that touches the question links
here rather than restating it.

## The system

Archkeep is an **architecture governance system for human and agentic software
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

`check` is the gate, and `fitness` is its one companion: they are the only
commands that exit with a finding, and each earns that role by reporting a
verdict on every reachable path or refusing to look silently
([exit-codes.md](../reference/exit-codes.md)). Every other command produces
evidence a human or an agent can act on — context before an edit, impact during
planning, diff across time, explain after a finding. None of the others judges.

## Intent, reality, and architecture state

The question this document opens with — does the code that exists agree with
the architecture that was declared — names two sides everything below depends
on, so the vocabulary is locked here once:

- **Architectural intent** is the architecture a workspace declares: the
  constraint table, the named profiles, the recorded decisions, the waivers
  and exceptions it accepts. It lives in files, is reviewed like code, in the
  repository it governs — and nothing infers it. Declaring intent is a human
  act.
- **Architectural reality** is the architecture the repository actually has:
  the projects, the import sites and the edges, read statically from source,
  with no toolchain and no assumption about any workspace's names.
- **Evidence** is what ties a claim to its source: a graph edge, a snapshot,
  a diff hunk, a drift signal, a decision citation — reproducible facts the
  core computes and everything else reads
  ([concepts/evidence.md](../concepts/evidence.md) owns the vocabulary). A
  verdict cites evidence; a claim that cannot name its evidence is not about
  the architecture this system governs.
- **Reconciliation** is the loop that keeps the two sides honest: the gap
  between intent and reality identified and classified element by element —
  violated, satisfied, waived, unknown — so that every difference becomes a
  decision (a fix, a waiver, a re-declared intent) rather than an accident
  that compounds
  ([concepts/reconciliation.md](../concepts/reconciliation.md)).

Under both sits **architecture state**: one workspace's intent, its observed
reality, the constraints binding them, the decisions and exceptions modifying
them, and the evidence tying every claim to where it came from. Architecture
changes through state transitions, and the commands are those transitions'
mechanisms: `graph` captures the state, `diff` compares two, `history` and
`evolution` replay the sequence, `provenance` attributes each to its origin,
and `drift` and `reconcile` measure where reality has left its intent. They
are mechanisms serving one state and its lifecycle — not separate products,
and not generations of this system.

## What is not Archkeep

Five things sit around the core, and each has a boundary it must not cross.
They are named so that "replace the authority with the provider" is recognised
as a direction change rather than an implementation detail.

### Nx and Moon are providers, not the foundation

Archkeep reads a project graph from a provider — Nx, Moon, or the native
discovery that needs neither. That seam exists precisely so the authority does
not depend on any of them. A workspace with Nx keeps `affected` and the project
graph; a Moonrepo workspace reads its own graph back; a repository that has
neither still gets the full verdict. The core model, the constraint table and
the rule engine are provider-independent — intent contract **A** in
`packages/archkeep/src/intent/intent-manifest.json` states it, and the line
under "How the boundary is enforced" names the mechanism that holds it.

What an integration may and must not do is owned by
[concepts/integrations.md](../concepts/integrations.md).

### Agent skills are a protocol, not the engine

The `arch-*` skills teach an agent when to ask the authority and how to read its
answers. They contain no enforcement logic; every `HOW` step is a `archkeep`
command. The authority stays in the core: the skills are the teacher, the CLI is
the judge ([skills/overview.md](../skills/overview.md)).

### The agent is a consumer, not an authority

The agent reasons, plans and modifies code. It does not decide whether the
architecture is valid. When an agent needs to know whether an edge is allowed,
it asks `archkeep context` / `impact` / `diff` / `check` and reads the machine
verdict. When its code violates a boundary, the violation comes back the same
way a human's does — from the authority, never from the agent's own judgment.

The commands an agent consumes are read-only. Nothing an agent can run changes
the constraint table to make its own import pass.

### CI is a venue, not a jurisdiction

CI runs `archkeep check` and gates on its exit code. Governance is defined by the
constraint table in the workspace and the verdict the authority computes; CI is
where that verdict is acted on, and it is as replaceable as the provider it
runs against.

### Orchestration and platform clients are consumers, not territory

A fifth neighbour: the orchestration systems, action bots and UI platforms
that schedule work around Archkeep — Reeve, the `action-agents` workflows, a
product surface such as Loom, or any other client. They integrate through the
same documented surfaces every consumer uses — the exit codes, the versioned
JSON envelopes, the MCP tools, the language server's diagnostics — and they
may not pull Archkeep across its own boundary: it does not become an
orchestration engine, a task runner, a code executor, or a UI platform, and
no client is handed the authority to decide whether an architecture is valid.
The verdict travels to them; it never travels from them.

## The boundary, stated once

| role                        | decides                                                        | supplies                                    |
| --------------------------- | -------------------------------------------------------------- | ------------------------------------------- |
| **Archkeep**                | is this edge valid? (deterministic, inspectable, reproducible) | verdict, context, impact, diff, evidence    |
| **Provider** (Nx/Moon)      | how is the project graph shaped?                               | graph edges, project discovery              |
| **Native discovery**        | how is the graph read with no tool?                            | graph edges, project discovery              |
| **Agent**                   | what code to write, and whether to follow the verdict          | reasoning, planning, code modification      |
| **CI / PR**                 | does this change block, and when?                              | a gate on the verdict                       |
| **Orchestrator / platform** | when the authority is asked, and where the answer surfaces     | automation and rendering around the verdict |

The two columns restated as the model the thesis gives:

```
Archkeep = architecture truth + constraints + evidence
Agent   = reasoning + action
```

Each side holds its half. An agent that is handed "the architecture is fine"
without a `archkeep` verdict behind it is being handed a claim with no
authority — the exact silence this project exists to end.

## Non-goals

Archkeep is not any of these. The list is defensive positioning, not a rule
change: each item is a direction the project will not take even when it is
convenient, because taking it would move the boundary above.

- **A build system.** It declares no targets, runs nothing, and never replaces
  what a workspace builds.
- **A package manager.** It reads manifests as data and installs nothing; the
  resolution it performs is what the boundary rules need — transitive and
  banned-import checks — never dependency management.
- **An Nx replacement or a Moon replacement.** Both remain first-class
  integrations; Archkeep is the layer above them.
- **An LLM.** It computes verdicts from source; it does not reason about them.
- **An autonomous architect.** It proposes no redesign and prescribes no
  architecture; it reports whether code agrees with the one that was declared.
- **A code generator.** It writes no code.
- **An AI code reviewer.** Review remains a human or agent judgment; Archkeep
  supplies the evidence that judgment is anchored to.
- **A replacement for CI.** It produces an exit code; a pipeline decides what to
  do with it.

## How the boundary is enforced

The line above is not prose. Each piece of it is held by a mechanism:

- **Provider independence** — the core layers (`rules`, `analysis`, `report`)
  never import a provider; only the orchestration that composes a graph reads
  one. That separation is stated in the intent contract **A**
  (`packages/archkeep/src/intent/intent-manifest.json`); the mechanism that
  holds the dependency allow-list is
  `src/conformance/boundary.test.mjs`.
- **The core does not depend on a build system** — principle 5,
  [principles.md](principles.md); no provider shells out to a language toolchain.
- **Skills never duplicate enforcement** — host-independent `SKILL.md` files,
  gated by `scripts/check-skills.mjs`; every `HOW` step is a `archkeep` command.
- **The agent cannot edit the law** — the constraint table is a file in the
  workspace, and the commands an agent consumes are read-only
  ([agentic-development.md](../concepts/agentic-development.md)).
- **Determinism** — the same tree and configuration produce the same verdict,
  proven byte-for-byte by the determinism suite (intent contract **K**).

## The intelligence layer

The deterministic core answers one question completely: does the code that
exists agree with the architecture that was declared. What it does not answer
is the set of questions one step away from the verdict: why the drift
happened, what a change is likely to break before it is made, what a path
from the observed structure to the declared one would cost. Those questions
need reading, predicting and recommending — and each of them, done badly, can
destroy the property that makes the core worth having. The resolution is a
layer: architecture intelligence reads and predicts on top of the
deterministic authority, never in place of it. The layer split is the thesis,
stated as three mechanical rules:

- **The core's outputs are the layer's input facts.** Verdicts, graphs,
  diffs, snapshots, drift signals — everything the deterministic engine
  reports is the evidence an intelligence capability reads. It invents no
  evidence of its own: a claim about the architecture traces to an output
  the core can reproduce.
- **Every intelligence output surfaces beside a verdict, never inside one.**
  A prediction, an explanation or a recommendation appears labelled as what
  it is, from a command or a field a consumer asks for. `check`'s exit code,
  the verdict fields of its JSON envelope, and the language server's
  diagnostics never depend on a model, a network call, or any other
  nondeterministic component.
- **The asymmetry is the design.** A prediction is allowed to be wrong; a
  verdict is not. A wrong recommendation costs a discarded suggestion; a
  wrong verdict costs a consumer's trust in every green build. So the two
  live in different commands, different output fields, different failure
  stories — and a proposal that blurs them is a change of direction,
  recognised and argued as such, not a feature.

"Potentially AI-assisted reasoning" in the roadmap's intelligence
capabilities means exactly this: judgment may enter the system, and where it
does it is labelled, bounded, and expendable — never load-bearing for what a
workspace is told its architecture is.

The layer's proposals use five words, and they are not interchangeable:

- **Verdict** — the deterministic core's answer. Reproducible, exit-coded,
  load-bearing. Only the core produces one.
- **Evidence** — a reproducible fact about the architecture: a graph edge, a
  diff hunk, a drift signal, a snapshot. What verdicts and intelligence both
  read.
- **Prediction** — a statement about what has not happened yet: likely
  breakage, likely drift. Allowed to be wrong; always labelled; never folded
  into a verdict.
- **Proposal** — a statement about what could change: a migration path, a
  boundary adjustment, a plan. Offered to a human or an agent to accept or
  refuse; never applied by the thing that offered it.
- **Judgment** — model or heuristic output that is neither evidence nor
  verdict. Always labelled as such, always expendable: removing it must
  never change what the workspace is told its architecture is.

[roadmap.md](roadmap.md) owns the capability list and its maturity stages;
any entry on this layer answers five questions before it is built. A
capability on the intelligence layer:

- **reads the core as its evidence.** Name the deterministic outputs it
  consumes. An advanced-drift proposal leans on the drift the core already
  reports; a change-risk proposal leans on `impact` and the graph. A
  capability whose evidence cannot be named is not reading the architecture
  this system governs.
- **proposes, explains or predicts — it never decides.** The agent-skill
  protocol ([principles.md](principles.md) § 7) holds at every layer: the
  read-only commands stay read-only, the workspace edits its own law, the
  checker judges. No intelligence output carries the authority of a verdict.
- **is reproducible at its own boundary.** Its deterministic components
  produce the same result from the same inputs; wherever a model
  contributes, the contribution is labelled, its inputs are recorded, and
  removing it degrades the answer rather than invalidating it.
- **fails loudly, by the invariant this repository is judged against.** The
  empty-result invariant — AGENTS.md's "The invariant everything is judged
  against" section — extends here: a capability that cannot reach an answer
  says so, in its output, rather than printing a plausible one. A confident
  guess is the silent direction wearing a richer format.
- **ships complete or not at all.** The bar [north-star.md](north-star.md)
  holds for languages holds here: a half-shipped intelligence feature —
  predictions without a stated error story, recommendations without a
  refuse path — implies more than it delivers, and implying is the one thing
  an enforcement tool may not do.

A capability arrives through the same door everything else here does:

1. **A decision, in the open.** An issue names the capability, the
   deterministic evidence it reads, the surface its output appears on, and
   its failure story. An ADR is added when architecture moves
   ([ADR 0002](../adr/0002-custom-rules-one-contract.md) is the model for
   what belongs there).
2. **A deterministic substrate, named.** Every intelligence feature leans on
   a deterministic half the core already ships or ships with it —
   anticipated drift needs the deterministic drift first, risk needs
   `impact`, evolution intelligence needs the snapshot-and-diff history. The
   substrate is testable without the intelligence on top, by the same
   standards every analyzer here is held to.
3. **Implementation behind the existing seams.** The layer boundaries of
   [principles.md](principles.md) § 6 hold: intelligence composes the core's
   command layer at the edge, like every other client, and adds no layer
   that reaches across one.
4. **Conformance, the way everything else here earned it.** Fixtures first,
   then real trees; a differential where one exists; and for every labelled
   output, a test that goes red when the label is missing — the silent
   direction for an intelligence feature is output that reads authoritative
   and is not.

On top of the system's own non-goals above, the layer adds the ones specific
to it:

- **Not a second engine.** Intelligence is composed from the core's command
  layer, the way the MCP server and the VS Code client are — never a
  parallel implementation of analysis that could disagree with the first.
- **Not intelligence in the verdict path.** No capability may make a green
  result mean "probably fine", shorten a check, or substitute a summary for
  a verdict an unchanged workspace would have received.
- **Not a prerequisite of the core.** The deterministic authority's readiness —
  for a consumer, and for stable 1.0 — is judged without waiting on any
  intelligence capability: the layer extends the core and never gates it.
  [roadmap.md](roadmap.md) owns that ordering.
- **Not a capability before its decision.** Nothing ships because the
  roadmap names it: a capability arrives through a recorded decision — an
  issue, an ADR where architecture moves — that names its evidence, its
  output surface, and its failure story. "Proposals are never decisions"
  applies to this repository's own roadmap as much as to an agent's.
- **Not a product surface that edits the law.** Whatever reads or suggests,
  the constraint table stays code in the workspace, reviewed like code.

## How the intelligence layer erodes the authority

Five signals, in the order they would probably appear:

1. A verdict, an exit code, or a diagnostic starts depending on a
   nondeterministic component — "the check passed faster because the model
   pre-screened it".
2. Intelligence output appears in a core envelope without its label — a
   field a consumer cannot tell from evidence.
3. A capability ships whose evidence cannot be named — no command, no
   graph, no diff it reads.
4. A proposal applies itself — a migration or boundary change written
   without a human or workspace owner accepting it.
5. The core's own suite starts tolerating a plausible-but-unreproducible
   answer to keep an intelligence test green.

Each is individually reasonable. Together they are how a tool whose verdicts
prove something becomes a tool whose outputs merely suggest it.

## Where this leaves the roadmap

Because the boundary is stable, the roadmap is about breadth and maturity,
not about the boundary itself: which languages a workspace may govern (owned
by [north-star.md](north-star.md)), and the maturity ladder that orders the
deterministic capabilities already shipping from the intelligence ones still
ahead. [roadmap.md](roadmap.md) owns that ladder; this document owns the
line it stays inside.
