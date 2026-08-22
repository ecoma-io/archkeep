# Roadmap

Where Lattice is going, in stages. This document owns the staged direction —
which capabilities belong to which major version, and in what order the project
earns them. It deliberately owns nothing finer than that: individual features,
their design and their sequencing live in GitHub issues and milestones, because
a roadmap that lists fifty features is a backlog wearing a roadmap's name, and
it is stale the day the first one ships. [north-star.md](north-star.md)
owns what "finished" means for the capabilities named here and the refusals
that hold on the way; [architecture-authority.md](architecture-authority.md)
owns the system boundary every capability stays inside. When a claim in this
file needs a finish line, that file is the one that binds.

## The thesis

Lattice is an **architecture governance system for human and agentic software
development** — a deterministic authority that keeps the intended architecture
aligned with the observed architecture while humans and agents continuously
change the codebase. [north-star.md](north-star.md) owns the
full sentence and the argument behind it; this document owns the staged path.

Architecture today lives in documents — READMEs, ADRs, diagrams — that nothing
executes and nothing checks. The code drifts from them silently, and the drift
compounds fastest exactly where review is thinnest: in codebases where agents
produce most of the diffs. Lattice's answer is to make the architecture itself
machine-readable and its enforcement deterministic, so that "the boundary
holds" is a verdict a pipeline computes rather than a belief a reviewer holds.

## Current / implemented

Everything in this section ships today and is not future work.
A new reader should find these capabilities described as present, not promised.

- **A core independent of Nx, of Moon, and of monorepos.** The engine discovers
  projects, builds the dependency graph and judges boundaries from its own
  model; Nx and Moon are providers of that model rather than its foundation.
  Single-repo, monorepo and polyrepo layouts are first-class.
  ([concepts/integrations.md](../concepts/integrations.md))
- **A multi-language dependency graph read from source.** Go, Rust, Python,
  TypeScript, JavaScript and Vue imports and manifests, statically — nothing
  invokes a toolchain to answer a question about imports.
  ([reference/languages.md](../reference/languages.md))
- **Architecture as code.** Layers, boundaries, dependency constraints and
  ownership declared in a machine-readable model that is reviewed like code, in
  the repository it governs. ([concepts/boundaries.md](../concepts/boundaries.md))
- **Named law profiles.** A workspace may keep several boundary laws in a
  `profiles` registry and select one by name at check time, stacked on a shared
  `base` — resolved loudly, with no silent fallback to a quieter law.
  ([concepts/profiles.md](../concepts/profiles.md))
- **Six architecture styles shipped as policy packs.** Clean Architecture,
  hexagonal, traditional layering (strict and relaxed), layered modular
  monolith, vertical slices and DDD bounded contexts ride inside the package as
  profile registries, read by the same loader, validated by the same validator
  and enforced by the same path a registry a workspace wrote itself takes. A
  pack saves the blank page, not a mechanism.
  ([usage/presets.md](../usage/presets.md))
- **ADR / decision registry.** `docs/adr/` records name the recorded
  architecture decision a rule, fitness gate, or intent row leans on through a
  `decisionRef`, read with `lattice adr`; a reference that resolves to nothing
  is `unknown`, never a pass. ([concepts/adr.md](../concepts/adr.md))
- **Deterministic enforcement in CLI and CI.** The verdict is an exit code and
  a machine-readable report; the same tree and the same model always produce
  the same answer. ([reference/exit-codes.md](../reference/exit-codes.md))
- **Seventeen commands — `check`, `graph`, `diff`, `discover`, `drift`,
  `reconcile`, `waivers`, `fitness`, `history`, `health`, `report`, `debt`,
  `impact`, `explain`, `context`, `provenance`, `adr`** — each with output a
  script or an agent can consume without parsing prose. `history` records the
  architecture's evolution across captured snapshots — the deterministic half
  of "how it got here" — `debt` ages the workspace's waivers, gaps and
  drift across that same record, and `report` composes health, waivers,
  fitness, the decision registry and provenance into one governance document
  under a single resolved law, so no two sections can answer from two.
  ([reference/cli.md](../reference/cli.md), [usage/history.md](../usage/history.md),
  [usage/debt.md](../usage/debt.md), [usage/report.md](../usage/report.md))
- **Nx and Moon as first-class integrations, not dependencies.** A workspace
  that has Nx or Moon gets graph reuse and `affected` integration; a repository
  that has neither loses nothing.
  ([integrations/nx.md](../integrations/nx.md),
  [integrations/moon.md](../integrations/moon.md))
- **Architecture snapshots with provenance.** `graph` produces a deterministic
  snapshot carrying the git origin of the run; `diff` warns when a baseline
  cannot be attributed to the same repository.
  ([usage/graph.md](../usage/graph.md), [reference/json-output.md](../reference/json-output.md))
- **Meaningful architecture diff.** `diff` separates structural change from
  policy mismatch from rule impact, and refuses an incomplete baseline.
  ([usage/diff.md](../usage/diff.md))
- **Basic drift detection.** Four drift signals, with no predictive component:
  boundary violations and configuration drift surface through `check`;
  structural drift and its rule impact surface through `diff`; and
  architecture-intent drift has a descriptive face of its own (`drift`) that
  `check` also folds in by presence.
  ([concepts/drift.md](../concepts/drift.md))
- **Fitness functions.** Named, declared quality gates — "the graph stays
  cycle-free", "at least 90% of files are analyzed", "no slice reaches another
  slice" — judged deterministically against the same observed facts `check`
  reads, and folded into `check` by presence so a declared function is enforced
  on every run. `tag-axis-isolation` makes a partition — a module, a bounded
  context, a slice, a service — enforceable without one constraint row per
  partition.
  ([concepts/fitness-functions.md](../concepts/fitness-functions.md),
  [usage/fitness.md](../usage/fitness.md))
- **Custom rules under one contract.** A workspace declares its own rules as
  committed WebAssembly artifacts in the policy's `customRules` list — written
  in any language whose toolchain emits a no-import core-wasm module, judged
  by the same deterministic engine over the same observed facts, folded into
  `check` by presence with verdicts in the same four-state vocabulary, and
  loud on every failure path. Four SDKs ship from this repository on the same
  version chain — Rust, Go (TinyGo's freestanding target), TypeScript-syntax
  AssemblyScript, and Python (a RustPython carrier) — each proven by a
  committed reference artifact whose verdicts are byte-identical across all
  four, with each build story's measured limits declared in its package
  ([adr/0002](../adr/0002-custom-rules-one-contract.md) records the staging).
  ([concepts/custom-rules.md](../concepts/custom-rules.md),
  [reference/custom-rules.md](../reference/custom-rules.md))
- **Architecture planning facts for agents.** `context` and `impact` answer the
  questions an agent asks before and during a change, in machine-readable form;
  `explain` explains a finding after it is reported.
  ([concepts/agentic-development.md](../concepts/agentic-development.md))
- **Architecture intent as a machine-readable contract.** The boundary config
  is the declared intent: boundaries, allowed and forbidden relationships, and
  the constraints a workspace states about its own structure. Intent is
  validated against the observed architecture with no AI-generated intent and
  no semantic inference.
  ([concepts/boundaries.md](../concepts/boundaries.md))
- **A stated and gated `schemaVersion` promise.** The JSON envelope's field
  names and its version are a public contract said out loud where consumers
  read it, and held by a gate rather than by discipline: every command's
  envelope is reduced to a field roster and compared against a recorded
  snapshot in both directions, over a command list taken from the CLI's own
  table so a command added later cannot ship an unmeasured shape.
  ([reference/json-output.md](../reference/json-output.md))
- **Agentic governance.** The five `arch-*` skills teach agents when to ask the
  authority and how to read its answers; Claude Code, Codex and opencode run
  the same editor gates; the repository dogfoods its own enforcer in CI.
  ([skills/overview.md](../skills/overview.md),
  [architecture-authority.md](architecture-authority.md))

## 1.x — Universal Agentic Architecture Governance

The goal of 1.x: the system above, complete and stable — the deterministic
authority, its evidence commands, the machine-readable intent it enforces, the
evolution safety that keeps change honest, and the agent protocol that makes
agents consumers rather than authorities.

Most of 1.x is already implemented and listed above. What remains before a
**stable 1.0** is hardening of the proof, not a new feature list — one item,
and it is evidence rather than code:

- **Breadth of conformance evidence.** The differential against
  `@nx/enforce-module-boundaries` runs over real public workspaces, weekly and
  on demand, as a non-required check that is still treated as a regression when
  it goes red; more real trees is the remaining gap, not a missing feature.
  ([development/testing.md](../development/testing.md))

The VS Code marketplace listing is deliberately **not** on that list. The
client exists, the `.vsix` attaches to every release, and the release lane
publishes to the marketplace the moment a publisher account exists
([integrations/vscode.md](../integrations/vscode.md)) — so the listing lands
whenever that account does, independent of what version the package carries,
and 1.0 does not wait for it.

### What 1.0 waits for, and how each condition is read

The item above is the remaining work. These four are how the project knows it
is done — conditions rather than a date, in keeping with this document's
refusals, and each read off something that already runs rather than off
anyone's judgement of readiness. A fifth stood here until the `schemaVersion`
promise was both stated and gated; it is listed among the shipped capabilities
above rather than deleted, because a condition that was met is part of how the
project got here.

The first three exist because the ways this project can be wrong are not
symmetric. A feature list can be finished by writing code; a claim that the
engine is stable can only be finished by the engine failing to surprise anyone
over a stretch of time in which it had the chance to.

1. **The real-tree differential green, run after run.** Not one green run — a
   run of them, on the weekly schedule, with no red in between that was not a
   genuine conformance finding. One green run says the lane works; a series says
   the engine and upstream have stopped disagreeing in ways nobody predicted.
2. **A workspace outside this repository running `check` as a blocking gate.**
   Self-enforcement (`AGENTS.md`, "The repository's own module boundaries")
   proves the tool runs on a tree whose vocabulary it does not know. It cannot
   prove what a tree nobody here designed does to it. Until some other
   repository has failed a build on a Lattice verdict and been right to, the
   parse limits are a list of shapes that were imagined rather than met.
3. **A quiet stretch in what an unchanged workspace is told.** `AGENTS.md`
   makes a change to what is reported on an unchanged workspace a breaking
   change; 1.0 is the version where that promise starts costing something. So
   the last condition before it is a stretch of commits during which no fix
   changed a verdict on a tree that did not change — measured from the log,
   which names each such fix, not from memory.
4. **Releases that land without a hand on them.** Tag, npm, and the attached
   `.vsix` agreeing, more than once in a row. The 0.5.0 tag that npm never
   received is the failure this condition exists to have stopped happening.

`scripts/check-readiness.mjs` is what reads these four rather than anyone
remembering them — `pnpm readiness` prints one row each, and says `unmeasured`
for the two whose evidence lives outside this repository rather than guessing.
The fifth condition sitting here for six releases after it was met is the
failure that script exists to have stopped happening.

None of the four is a feature, and that is the point: what separates 0.x from
1.0 here is evidence, and evidence is something the project accumulates rather
than something it implements.

### Capabilities pulled forward from 2.x

Four capabilities moved from the 2.x direction into the 1.x scope, each in a
deliberately deterministic form. They are listed here so the adjusted roadmap is
explicit, not silent:

1. **Architecture Intent** — the boundary config as a machine-readable
   contract: boundaries, allowed and forbidden dependencies, constraints and
   intended structure. It includes no AI-generated intent, no semantic
   architecture inference, and no automatic redesign.
2. **Basic Drift Detection** — the difference between intended architecture and
   observed architecture, computed from graph, policy, snapshot, diff and
   intent. Deterministic only; no predictive drift intelligence.
3. **Lightweight Architecture Evolution / History** — deterministic historical
   evidence: a `graph` snapshot → a change → a `diff` between the two, each
   carrying provenance. No recommendation engine.
4. **Architecture Planning Facts for Agents** — context, affected projects,
   dependency impact, constraints, allowed boundaries and violations, provided
   to an agent as facts. The agent reasons, plans and decides how to modify
   code; Lattice does not become an LLM.
   ([architecture-authority.md](architecture-authority.md))

Each of these four is deterministic and inspectable: the verdict is reproducible
from source, and the authority never reasons about the architecture it reports.

## 2.x — Architecture Intelligence

The goal of 2.x: the layer that reads and predicts, sitting on top of — never
in place of — the deterministic 1.x core. It is not "more rules"; it is a
different relationship to the architecture the core already governs.

- **Deeper architecture intent** — richer, machine-readable intent beyond the
  dependency constraint table.
- **Semantic architecture understanding** — the architecture as a meaning to be
  read, not only a graph to be checked.
- **Advanced drift detection** — drift that is anticipated or explained, on top
  of the deterministic drift 1.x already reports.
- **Architecture evolution intelligence** — how the architecture changed and
  why, on top of the deterministic snapshot-and-diff history 1.x already keeps.
- **Change risk analysis and architectural impact prediction** — what a change
  is _likely_ to break, not only what it _demonstrably_ breaks.
- **Migration planning and architecture recommendations** — proposed paths,
  offered to a human to accept or refuse.
- **Cross-repository architecture intelligence** — reasoning across more than
  one repository at a time.
- **Agent-assisted architecture planning** — planning help that extends the
  facts 1.x provides, while the agent remains the decision-maker.
- **Potentially AI-assisted reasoning** — where intelligence is not a verdict.

2.x is a **direction, not a commitment to implementation details**. The list
above names the headroom; nothing in it is a dated promise, and a prediction is
allowed to be wrong where a verdict is not. Nothing in 2.x weakens the 1.x
contract: every intelligence feature sits on top of the deterministic core,
never in place of it.

## What this roadmap refuses

- **Dates.** A date on an open-source roadmap is a promise nobody is paid to
  keep. Order is the commitment; time is not.
- **A feature list.** Features live in issues, where they can be discussed,
  rejected and closed without this document lying in the meantime.
- **A phase 3.** When 2.x is real, what comes after it will be visible from
  there, and not before.
- **Moving the authority.** Any capability that would let an agent, a provider,
  a skill or CI decide whether an architecture is valid — rather than report
  whether it holds — is refused by the boundary in
  [architecture-authority.md](architecture-authority.md). The
  roadmap stages breadth and reading; it never stages that line.
