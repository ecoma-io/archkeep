# Archkeep documentation

Two doors. Take the one that matches what you are here to do.

- **I want to use it** → [getting-started/installation.md](getting-started/installation.md)
- **I want to change it** → [development/architecture.md](development/architecture.md)

And four documents that are neither, but decide what the rest say — all four
live in [doctrine/](doctrine/):
[why.md](doctrine/why.md) — the problem this exists for, with the measurement behind it —
[north-star.md](doctrine/north-star.md) — where it is going and what it will refuse on
the way — [architecture-authority.md](doctrine/architecture-authority.md) — what Archkeep
is, what it is not, and the line its neighbours may not cross — and
[roadmap.md](doctrine/roadmap.md) — the staged path there, by major version.

---

## By intent

**I want to use Archkeep**

- [Install](getting-started/installation.md) — install, quick start, first project
- [First policy](getting-started/first-policy.md) — write constraints, see a violation
- [Checking in CI](usage/ci.md) — automated enforcement with SARIF
- [Agent skills](skills/overview.md) — coding agent protocol

**I want to understand Archkeep**

- [Why it exists](doctrine/why.md) — the problem and evidence
- [Architecture model](concepts/architecture.md) — engine, faces, layers
- [Graph](concepts/graph.md) — projects, edges, deterministic snapshots
- [Boundaries](concepts/boundaries.md) — layers, scopes, constraints, violations
- [Drift](concepts/drift.md) — intent vs observed architecture
- [Governance lifecycle](concepts/governance-lifecycle.md) — intent → check → evidence
- [Agentic development](concepts/agentic-development.md) — agents as consumers

**I want to integrate Archkeep**

- [Nx](integrations/nx.md) — registration, graph edges, affected, workspaceLayout
- [Moon](integrations/moon.md) — tags, providers, conventions
- [VS Code](integrations/vscode.md) — language server, settings
- [MCP](integrations/mcp.md) — eight tools for coding agents
- [Agent skills](skills/overview.md) — when agents ask before changing code

**I want to extend Archkeep**

- [Custom rules](concepts/custom-rules.md) — WASM rules in your language
- [Add a language](development/adding-a-language.md) — analyzer contract
- [Add integration](development/adding-integration.md) — extension points
- [Development architecture](development/architecture.md) — internals and testing
- [Testing](development/testing.md) — suites, coverage, differential

**I need exact reference**

- [CLI reference](reference/cli.md) — commands, flags, exit codes
- [Configuration](reference/configuration.md) — plugins, native, profiles
- [Policy schema](reference/policy-schema.md) — every table key
- [Exit codes](reference/exit-codes.md) — 0/1/2/3 contract
- [JSON output](reference/json-output.md) — schemaVersion 2 envelope
- [Gate attestation](reference/gate-attestation.md) — the external blocking-gate evidence shape
- [Languages](reference/languages.md) — parse limits per language
- [Violations](reference/violations.md) — fifteen violation types

---## Getting started

| page                                                                   | what it answers                                                 |
| ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| [installation.md](getting-started/installation.md)                     | Prerequisites, install, and what each entry point provides      |
| [first-project.md](getting-started/first-project.md)                   | Create a `archkeep.json` workspace, add a project, tag it       |
| [first-policy.md](getting-started/first-policy.md)                     | Write and run your first constraint table, read a violation     |
| [upgrading-from-lattice.md](getting-started/upgrading-from-lattice.md) | Moving a workspace off the old name: what breaks, what does not |

## Concepts

| page                                                        | what it answers                                                                        |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [architecture.md](concepts/architecture.md)                 | The engine, three faces, layer split — technology-neutral                              |
| [graph.md](concepts/graph.md)                               | Project graph, edge identity, deterministic snapshots                                  |
| [boundaries.md](concepts/boundaries.md)                     | Layer/scope/license axes, constraint model, tag semantics, what "violation" is         |
| [policies.md](concepts/policies.md)                         | Three dialects, one table, stability contract                                          |
| [profiles.md](concepts/profiles.md)                         | Named law profiles: why they exist, precedence, and what is loud                       |
| [projects.md](concepts/projects.md)                         | What a project is, discovery, naming                                                   |
| [drift.md](concepts/drift.md)                               | The four drift signals Archkeep detects, and which command surfaces each               |
| [governance-lifecycle.md](concepts/governance-lifecycle.md) | Why the commands exist as a system: intent → check → evidence → evolution → agent      |
| [discovery.md](concepts/discovery.md)                       | The proposal-only line, the observed side, the four candidate classes                  |
| [health.md](concepts/health.md)                             | What "architecture health" means, and the invariant behind every metric                |
| [evidence.md](concepts/evidence.md)                         | The one verdict vocabulary every judgment speaks, and the evidence each state requires |
| [provenance.md](concepts/provenance.md)                     | The origin record, why `on` is optional, and why provenance never rules                |
| [adr.md](concepts/adr.md)                                   | Architecture decision records: the filename identity, the strict dialect, the refusals |
| [waivers.md](concepts/waivers.md)                           | Temporary acceptance of a boundary breach, the lifecycle, and the deadline             |
| [fitness-functions.md](concepts/fitness-functions.md)       | Named quality gates — the verdict contract and what each condition judges              |
| [custom-rules.md](concepts/custom-rules.md)                 | A workspace's own wasm rules: one seam, evidence in, verdict out, and the refusals     |
| [reconciliation.md](concepts/reconciliation.md)             | The inverse of drift: the model scored element by element, and proposed repairs        |
| [agentic-development.md](concepts/agentic-development.md)   | The three questions an agent asks, and the commands that answer them                   |
| [integrations.md](concepts/integrations.md)                 | How integrations extend the core                                                       |

## Usage

| page                                           | what it answers                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [configuration.md](usage/configuration.md)     | Every surface Archkeep reads, and where each option lives                                  |
| [checking.md](usage/checking.md)               | Running the check, scoped runs, formats, exit codes                                        |
| [profiles.md](usage/profiles.md)               | Enforcing a named profile: the option, `--config`, loud failures                           |
| [presets.md](usage/presets.md)                 | The six shipped policy packs, the tags each expects, and how to adopt one                  |
| [provenance.md](usage/provenance.md)           | The `provenance` command: governance row schema and run origin                             |
| [graph.md](usage/graph.md)                     | The `graph` command: deterministic snapshot of the project graph                           |
| [diff.md](usage/diff.md)                       | The `diff` command: two graph snapshots compared, with rule-impact analysis                |
| [delta.md](usage/delta.md)                     | The `delta` command: violations classified between a captured baseline and head            |
| [change.md](usage/change.md)                   | The `change` command: a declared change intent reconciled against the actual delta         |
| [drift.md](usage/drift.md)                     | The `drift` command: observed architecture against the declared intent                     |
| [fitness.md](usage/fitness.md)                 | The `fitness` command: every declared quality gate judged, as a verdict table              |
| [history.md](usage/history.md)                 | The `history` command: the architecture's evolution across snapshots                       |
| [trajectory.md](usage/trajectory.md)           | The `trajectory` command: signals, churn and persistence aggregated across snapshots       |
| [evolution.md](usage/evolution.md)             | The `evolution` command: the architecture's evolution across a selected Git revision range |
| [health.md](usage/health.md)                   | The `health` command: per-metric verdicts, trends, and the status contract                 |
| [report.md](usage/report.md)                   | The `report` command: one governance document — how healthy the architecture is, and why   |
| [debt.md](usage/debt.md)                       | The `debt` command: the architecture-debt ledger across snapshots                          |
| [discover.md](usage/discover.md)               | The `discover` command: observed architecture and candidate proposals                      |
| [reconcile.md](usage/reconcile.md)             | The `reconcile` command: the model scored element by element, with proposed edits          |
| [impact.md](usage/impact.md)                   | The `impact` command: dependents and their constraint context                              |
| [explain.md](usage/explain.md)                 | The `explain` command: the judgment for one import site, explained                         |
| [context.md](usage/context.md)                 | The `context` command: architecture constraints for one project                            |
| [adr.md](usage/adr.md)                         | The `adr` command: recorded decisions, what each binds, and the reverse lookup             |
| [custom-rules.md](usage/custom-rules.md)       | Writing, building, declaring, running and debugging a rule of your own                     |
| [migration.md](usage/migration.md)             | Bringing an existing repository under governance, step by step                             |
| [ci.md](usage/ci.md)                           | The exit codes in a pipeline, SARIF into GitHub code scanning                              |
| [troubleshooting.md](usage/troubleshooting.md) | It found nothing · it found too much · it could not look                                   |
| [waivers.md](usage/waivers.md)                 | The `waivers` command: term-bound suppressions and permanent suppressions                  |

## Integrations

| page                                | what it answers                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| [nx.md](integrations/nx.md)         | Nx integration registration, options, graph edges, affected, workspaceLayout |
| [moon.md](integrations/moon.md)     | Moon integration: workspace detection, graph reading, tag format             |
| [vscode.md](integrations/vscode.md) | VS Code extension: settings, routing, installation                           |
| [mcp.md](integrations/mcp.md)       | MCP server: the eight agent tools, the three-state verdict, authority bounds |

## Agent skills

| page                                            | what it answers                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| [overview.md](skills/overview.md)               | The three-layer architecture, the five skills, host independence |
| [installation.md](skills/installation.md)       | npx skills add, Claude Code plugin, manual installation          |
| [supported-hosts.md](skills/supported-hosts.md) | Feature matrix across agent platforms                            |
| [claude-code.md](skills/claude-code.md)         | Claude Code specific setup and invocation                        |
| [versioning.md](skills/versioning.md)           | Version sync with Archkeep, CI enforcement, release-please       |
| [authoring.md](skills/authoring.md)             | Conventions for writing new arch-* skills                        |

## Reference

| page                                                       | what it answers                                                                                                                               |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [configuration.md](reference/configuration.md)             | `archkeep.json` fields, `nx.json` options, Moon options, inline boundary config                                                               |
| [policy-schema.md](reference/policy-schema.md)             | Constraint table schema: every key of `depConstraints`, `moduleBoundaryOptions`, `boundarySuppressions`, `fitness`, `customRules`, `coverage` |
| [custom-rules.md](reference/custom-rules.md)               | The custom-rule contract: the artifact's exports, the evidence bundle, the verdict, every failure                                             |
| [profiles.md](reference/profiles.md)                       | The profile registry schema, the `profiles` option, and the four loud conditions                                                              |
| [cli.md](reference/cli.md)                                 | All commands, all flags, all exit codes                                                                                                       |
| [discovery.md](reference/discovery.md)                     | The `discover` command: flags, exit codes, the additive JSON envelope                                                                         |
| [exit-codes.md](reference/exit-codes.md)                   | The four exit codes with exact meaning                                                                                                        |
| [json-output.md](reference/json-output.md)                 | `--format json`'s versioned envelope: every field, and the stability promise                                                                  |
| [gate-attestation.md](reference/gate-attestation.md)       | The external blocking-gate attestation: the schema, what the verifier refuses, and what only a reviewer can decide                            |
| [evidence.md](reference/evidence.md)                       | The four-state verdict vocabulary, the five invariants, and the `decision` shape                                                              |
| [architecture-intent.md](reference/architecture-intent.md) | The `architecture-intent.json` schema, the five sections, and the four verdict states                                                         |
| [debt.md](reference/debt.md)                               | The architecture-debt ledger: entry kinds, age model, severity, and the refusals                                                              |
| [provenance.md](reference/provenance.md)                   | The `provenance` command: report shapes, the JSON envelope, exit codes                                                                        |
| [adr.md](reference/adr.md)                                 | The `adr` command: report shapes, the JSON envelope, exit codes, the id name space                                                            |
| [reconciliation.md](reference/reconciliation.md)           | The scored element and candidate shapes behind `archkeep reconcile`                                                                           |
| [languages.md](reference/languages.md)                     | What each analyzer reads, the shapes it cannot, and the two workspace checks                                                                  |
| [violations.md](reference/violations.md)                   | Each of the fifteen violations: what it means, and what fixes it                                                                              |

## Decision records

Numbered, immutable once accepted, and cited by the pages whose behaviour they
decided rather than summarized into them.

| record                                                                                               | what it decided                                                                  |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [0001-boundary-levels.md](adr/0001-boundary-levels.md)                                               | The engine and its extension enforce their boundary levels                       |
| [0002-custom-rules-one-contract.md](adr/0002-custom-rules-one-contract.md)                           | Custom rules are one contract, not one system per language — and four SDKs       |
| [0003-rename-lattice-to-archkeep.md](adr/0003-rename-lattice-to-archkeep.md)                         | Archkeep replaces Lattice as the project's public identity, and what that costs  |
| [0004-correct-old-name-deprecation-mechanics.md](adr/0004-correct-old-name-deprecation-mechanics.md) | Corrects ADR 0003's crates.io and Go deprecation mechanics, and records what ran |
| [0005-jvm-language-integration.md](adr/0005-jvm-language-integration.md)                             | Java and Kotlin enter through the existing seams, behind one shared JVM core     |

## Doctrine

| page                                                              | what it answers                                                                         |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [why.md](doctrine/why.md)                                         | The gap this exists to close, and the measurement that proves it is real                |
| [north-star.md](doctrine/north-star.md)                           | The direction, what "finished" means per language, and the refusals                     |
| [architecture-authority.md](doctrine/architecture-authority.md)   | What Archkeep is, what it is not, and the line providers/skills/agents/CI may not cross |
| [principles.md](doctrine/principles.md)                           | The seven binding principles                                                            |
| [architecture-governance.md](doctrine/architecture-governance.md) | How Archkeep practices what it enforces                                                 |
| [roadmap.md](doctrine/roadmap.md)                                 | The staged path: what ships today, and which capabilities belong to which major version |

## Development

| page                                                       | what it answers                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------- |
| [architecture.md](development/architecture.md)             | One check, end to end, and why the layers are cut where they are    |
| [adding-a-language.md](development/adding-a-language.md)   | The full path for a new language, in the order that keeps it honest |
| [adding-integration.md](development/adding-integration.md) | How a new integration extends the core, and the contract it holds   |
| [repository.md](development/repository.md)                 | The seven packages, plain ESM, gate scripts, CI                     |
| [release.md](development/release.md)                       | How a version reaches the people who use it                         |
| [testing.md](development/testing.md)                       | Which suite proves what, and which failure each tier is for         |

Those pages assume you can already build and run the repository. The setup, the
command list, the commit format and how a pull request lands are
CONTRIBUTING.md's, and none of it is repeated here.

## Who owns what

This repository states a rule once and links to it from everywhere else, so the
useful question is usually not "where is this documented" but "which file is
allowed to say it". That table:

| file                                                                            | owns                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `README.md`                                                                     | The pitch: what Archkeep is in one breath, and the way in                                                                                                                                                                                        |
| [`docs/doctrine/why.md`](doctrine/why.md)                                       | The gap, and the evidence that it is real                                                                                                                                                                                                        |
| [`docs/doctrine/north-star.md`](doctrine/north-star.md)                         | The direction, what "finished" means per language, and the refusals                                                                                                                                                                              |
| [`docs/doctrine/architecture-authority.md`](doctrine/architecture-authority.md) | What Archkeep is, what it is not, and the boundary its neighbours may not cross                                                                                                                                                                  |
| [`docs/doctrine/principles.md`](doctrine/principles.md)                         | The seven binding principles                                                                                                                                                                                                                     |
| [`docs/doctrine/roadmap.md`](doctrine/roadmap.md)                               | The staged path: what ships today, which capabilities belong to which major version, and in what order                                                                                                                                           |
| `docs/getting-started/`                                                         | Installation, first project, first policy, and the upgrade off the Lattice name — which owns every consumer-facing consequence of the rename, so no other page restates one                                                                      |
| `docs/concepts/`                                                                | The model: architecture, graph, boundaries, policies, profiles, projects, drift, discovery, evidence, provenance, adr, waivers, health, fitness functions, custom rules, reconciliation, governance lifecycle, agentic development, integrations |
| `docs/concepts/discovery.md`                                                    | Discovery: the proposal-only line, what is observed, the four candidate classes, uncertainty markers                                                                                                                                             |
| `docs/usage/`                                                                   | How a consumer runs it and reads its answers                                                                                                                                                                                                     |
| [`docs/usage/migration.md`](usage/migration.md)                                 | The onboarding ORDER: observe → propose → review → write back → converge → enforce, and which step is allowed to decide what. Each step's detail stays with the page that owns the command                                                       |
| [`docs/usage/presets.md`](usage/presets.md)                                     | The shipped policy packs: what each style enforces, the tag vocabulary it expects, the two ways to consume one, and why changing a pack's rows is a breaking change                                                                              |
| `docs/integrations/`                                                            | The provider and editor integrations at the edge — Nx, Moon, the VS Code extension, and the MCP server                                                                                                                                           |
| `docs/reference/`                                                               | Schemas, exit codes, command reference, language limits, violation catalogue, the profile registry schema, the custom-rule contract                                                                                                              |
| `docs/reference/discovery.md`                                                   | The `discover` command: flags, exit codes, the additive JSON envelope, the proposal never written                                                                                                                                                |
| `docs/reference/gate-attestation.md`                                            | The external blocking-gate evidence: the schema an outside repository publishes, what `verify-gate-attestation.mjs` refuses, and why a fixture is not adoption                                                                                   |
| `docs/development/`                                                             | How it works inside, and how to extend it                                                                                                                                                                                                        |
| `docs/skills/`                                                                  | Agent architecture skills: overview, installation, hosts, the Claude Code and Codex plugins, authoring, versioning                                                                                                                               |
| `CONTRIBUTING.md`                                                               | The contribution bar, the commands, hooks, commits, review, release                                                                                                                                                                              |
| `SECURITY.md`                                                                   | The threat model — and here a silent gate is a security defect, so read it before touching `scripts/`                                                                                                                                            |
| `AGENTS.md`                                                                     | The rules a diff is rejected for violating, for humans and agents alike                                                                                                                                                                          |
| `packages/archkeep/README.md`                                                   | The package's own reference — it is the npm landing page and must stand alone                                                                                                                                                                    |
| `packages/archkeep-vscode/README.md`                                            | The VS Code client: what it requires, the two settings it has, and the two it refuses                                                                                                                                                            |
| `packages/archkeep-mcp/README.md`                                               | The MCP server: the eight tools, how they map to CLI commands, and the authority boundary                                                                                                                                                        |
| `packages/archkeep-rule-sdk-*/README.md`                                        | One per SDK: that language's build story for a custom rule, and its own MEASURED limits. The limits are why an SDK is chosen by reading these rather than from the table in [`docs/usage/custom-rules.md`](usage/custom-rules.md)                |
| `docs/adr/`                                                                     | The numbered decision records: what was decided, against which alternatives, and what it cost. Immutable once accepted — a decision that changed is a NEW record, never an edit to the old one                                                   |
| `packages/archkeep/AGENTS.md`                                                   | Layer mechanics: what each layer may know                                                                                                                                                                                                        |
| `packages/archkeep/src/*/README.md`                                             | Each layer's own semantics — rules, report, conformance, commands, the native provider                                                                                                                                                           |
| `packages/archkeep/src/analysis/contract.md`                                    | The frozen record every analyzer returns                                                                                                                                                                                                         |
| `skills/`                                                                       | Canonical agent architecture skills — the `arch-*` behavioral protocol                                                                                                                                                                           |

Two of those rows overlap on purpose, and it is worth knowing which way:

**The package README repeats things `docs/usage/` also covers.** It is published
to npm, where a reader has no `docs/` to click into, so it has to answer install,
configuration and exit codes on its own page. When the two disagree, the package
README is the one that binds for the published version — it ships inside the
tarball, so it describes the version you actually installed. `docs/` describes
`main`.

**`AGENTS.md` and `CONTRIBUTING.md` do not overlap.** The second is the process —
how to set up, what to run, how a change lands. The first is the judgement — the
invariant everything is measured against and the specific mistakes this codebase
has already paid for. A contributor benefits from both; only one of them is a
checklist.
