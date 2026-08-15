# Roadmap

Where Lattice is going, in stages. This document owns the staged direction —
which capabilities belong to which major version, and in what order the project
earns them. It deliberately owns nothing finer than that: individual features,
their design and their sequencing live in GitHub issues and milestones, because
a roadmap that lists fifty features is a backlog wearing a roadmap's name, and
it is stale the day the first one ships. [north-star.md](doctrine/north-star.md) owns
what "finished" means for the capabilities named here and the refusals that
hold on the way; when a claim in this file needs a finish line, that file is
the one that binds.

## The thesis

**Executable architecture for software projects — keeping architecture
enforceable when software is produced faster than humans can review it.**

Architecture today lives in documents — READMEs, ADRs, diagrams — that nothing
executes and nothing checks. The code drifts from them silently, and the drift
compounds fastest exactly where review is thinnest: in codebases where agents
produce most of the diffs. Lattice's answer is to make the architecture itself
machine-readable and its enforcement deterministic, so that "the boundary
holds" is a verdict a pipeline computes rather than a belief a reviewer holds.

Lattice began as an Nx plugin closing one instance of that gap — module
boundaries for the languages ESLint cannot parse. The engine underneath was
always bigger than the integration around it, and the roadmap below is the path
from that plugin to the engine standing on its own.

## 1.x — Universal Architecture Enforcement

The goal of every 1.x release: architecture enforcement that works in any
repository, deterministically, with no build system as a precondition.

- **A core independent of Nx and of monorepos.** The engine discovers projects,
  builds the dependency graph and judges boundaries from its own model; Nx
  becomes one provider of that model rather than its foundation. Single-repo and
  monorepo layouts are first-class.
- **A multi-language dependency graph read from source.** Go, Rust, Python,
  TypeScript and JavaScript imports and manifests, statically — nothing invokes a
  toolchain to answer a question about imports.
- **Architecture as code.** Layers, boundaries, dependency constraints and
  ownership declared in a machine-readable model that is reviewed like code,
  in the repository it governs.
- **Deterministic enforcement in CLI and CI.** The verdict is an exit code and
  a machine-readable report; the same tree and the same model always produce
  the same answer.
- **`check`, `graph`, `impact`, `diff`, `explain` and `context`,** each with
  output a script or an agent can consume without parsing prose.
- **Nx as a first-class integration, not a dependency.** A workspace that has
  Nx gets graph reuse and `affected` integration; a repository that has never
  heard of Nx loses nothing.

1.0 is the release where all of that holds together and the conformance
oracles say the pivot changed no verdict it did not mean to change.

## 2.x — Agentic Architecture Platform

The goal of 2.x: Lattice as the architectural control plane for software that
is substantially produced by agents.

- **Drift and architectural-change intelligence** — not only "this import is
  illegal" but "this change alters the architecture, and here is how".
- **Fitness functions and richer policies** beyond dependency constraints.
- **An agent-native interface**: architectural context before a change,
  impact analysis during it, verification after it — machine-readable at
  every step, because the consumer is a model, not a reader. `context` and
  `impact` already answer the before-change and during-change questions; 2.x
  extends that reach.
- **Architecture-aware agent workflows and approval gates**, so an agent's
  diff meets the architecture before it meets a human.
- **Deeper editor, LSP and forge integrations** (GitHub, GitLab, CI
  platforms), and a plugin surface for third-party providers and analyzers.
- **Visualization and historical evolution** — the architecture as it is, as
  it was, and how it got here.

Nothing in 2.x weakens the 1.x contract: every intelligence feature sits on
top of the deterministic core, never in place of it. A prediction is allowed
to be wrong; a verdict is not.

## What this roadmap refuses

- **Dates.** A date on an open-source roadmap is a promise nobody is paid to
  keep. Order is the commitment; time is not.
- **A feature list.** Features live in issues, where they can be discussed,
  rejected and closed without this document lying in the meantime.
- **A phase 3.** When 2.x is real, what comes after it will be visible from
  there, and not before.
