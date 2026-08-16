# Lattice documentation

Two doors. Take the one that matches what you are here to do.

- **I want to use it** → [getting-started/installation.md](getting-started/installation.md)
- **I want to change it** → [development/architecture.md](development/architecture.md)

And four documents that are neither, but decide what the rest say:
[why.md](why.md) — the problem this exists for, with the measurement behind it —
[north-star.md](doctrine/north-star.md) — where it is going and what it will refuse on
the way — [architecture-authority.md](doctrine/architecture-authority.md) — what Lattice
is, what it is not, and the line its neighbours may not cross — and
[roadmap.md](roadmap.md) — the staged path there, by major version.

## Getting started

| page                                                 | what it answers                                             |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| [installation.md](getting-started/installation.md)   | Prerequisites, install, and what each entry point provides  |
| [first-project.md](getting-started/first-project.md) | Create a `lattice.json` workspace, add a project, tag it    |
| [first-policy.md](getting-started/first-policy.md)   | Write and run your first constraint table, read a violation |

## Concepts

| page                                                      | what it answers                                                                        |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [architecture.md](concepts/architecture.md)               | The engine, three faces, layer split — technology-neutral                              |
| [graph.md](concepts/graph.md)                             | Project graph, edge identity, deterministic snapshots                                  |
| [boundaries.md](concepts/boundaries.md)                   | Layer/scope/license axes, constraint model, tag semantics, what "violation" is         |
| [policies.md](concepts/policies.md)                       | Three dialects, one table, stability contract                                          |
| [projects.md](concepts/projects.md)                       | What a project is, discovery, naming                                                   |
| [drift.md](concepts/drift.md)                             | The four drift signals Lattice detects, and which command surfaces each                |
| [health.md](concepts/health.md)                           | What "architecture health" means, and the invariant behind every metric                |
| [evidence.md](concepts/evidence.md)                       | The one verdict vocabulary every judgment speaks, and the evidence each state requires |
| [provenance.md](concepts/provenance.md)                   | The origin record, why `on` is optional, and why provenance never rules                |
| [waivers.md](concepts/waivers.md)                         | Temporary acceptance of a boundary breach, the lifecycle, and the deadline             |
| [fitness-functions.md](concepts/fitness-functions.md)     | Named quality gates — the verdict contract and what each condition judges              |
| [agentic-development.md](concepts/agentic-development.md) | The three questions an agent asks, and the commands that answer them                   |
| [integrations.md](concepts/integrations.md)               | How integrations extend the core                                                       |

## Usage

| page                                           | what it answers                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| [configuration.md](usage/configuration.md)     | Every surface Lattice reads, and where each option lives                    |
| [checking.md](usage/checking.md)               | Running the check, scoped runs, formats, exit codes                         |
| [graph.md](usage/graph.md)                     | The `graph` command: deterministic snapshot of the project graph            |
| [diff.md](usage/diff.md)                       | The `diff` command: two graph snapshots compared, with rule-impact analysis |
| [drift.md](usage/drift.md)                     | The `drift` command: observed architecture against the declared intent      |
| [fitness.md](usage/fitness.md)                 | The `fitness` command: every declared quality gate judged, as a verdict table |
| [history.md](usage/history.md)                 | The `history` command: the architecture's evolution across snapshots        |
| [health.md](usage/health.md)                   | The `health` command: per-metric verdicts, trends, and the status contract  |
| [impact.md](usage/impact.md)                   | The `impact` command: dependents and their constraint context               |
| [explain.md](usage/explain.md)                 | The `explain` command: the judgment for one import site, explained          |
| [context.md](usage/context.md)                 | The `context` command: architecture constraints for one project             |
| [ci.md](usage/ci.md)                           | The exit codes in a pipeline, SARIF into GitHub code scanning               |
| [troubleshooting.md](usage/troubleshooting.md) | It found nothing · it found too much · it could not look                    |

## Integrations

| page                                | what it answers                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| [nx.md](integrations/nx.md)         | Nx integration registration, options, graph edges, affected, workspaceLayout |
| [moon.md](integrations/moon.md)     | Moon integration: workspace detection, graph reading, tag format             |
| [vscode.md](integrations/vscode.md) | VS Code extension: settings, routing, installation                           |

## Agent skills

| page                                            | what it answers                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| [overview.md](skills/overview.md)               | The three-layer architecture, the four skills, host independence |
| [installation.md](skills/installation.md)       | npx skills add, Claude Code plugin, manual installation          |
| [supported-hosts.md](skills/supported-hosts.md) | Feature matrix across agent platforms                            |
| [claude-code.md](skills/claude-code.md)         | Claude Code specific setup and invocation                        |
| [versioning.md](skills/versioning.md)           | Version sync with Lattice, CI enforcement, release-please        |
| [authoring.md](skills/authoring.md)             | Conventions for writing new arch-* skills                        |

## Reference

| page                                                       | what it answers                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [configuration.md](reference/configuration.md)             | `lattice.json` fields, `nx.json` options, Moon options, inline boundary config        |
| [policy-schema.md](reference/policy-schema.md)             | Constraint table schema: every key of `depConstraints`, `moduleBoundaryOptions`, `boundarySuppressions`, `fitness` |
| [cli.md](reference/cli.md)                                 | All commands, all flags, all exit codes                                               |
| [exit-codes.md](reference/exit-codes.md)                   | The four exit codes with exact meaning                                                |
| [json-output.md](reference/json-output.md)                 | `--format json`'s versioned envelope: every field, and the stability promise          |
| [evidence.md](reference/evidence.md)                       | The four-state verdict vocabulary, the five invariants, and the `decision` shape      |
| [architecture-intent.md](reference/architecture-intent.md) | The `architecture-intent.json` schema, the five sections, and the four verdict states |
| [provenance.md](reference/provenance.md)                   | The `provenance` command: report shapes, the JSON envelope, exit codes                |
| [languages.md](reference/languages.md)                     | What each analyzer reads, the shapes it cannot, and the two workspace checks          |
| [violations.md](reference/violations.md)                   | Each of the fifteen violations: what it means, and what fixes it                      |

## Doctrine

| page                                                              | what it answers                                                                        |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [north-star.md](doctrine/north-star.md)                           | The direction, what "finished" means per language, and the refusals                    |
| [architecture-authority.md](doctrine/architecture-authority.md)   | What Lattice is, what it is not, and the line providers/skills/agents/CI may not cross |
| [principles.md](doctrine/principles.md)                           | The seven binding principles                                                           |
| [architecture-governance.md](doctrine/architecture-governance.md) | How Lattice practices what it enforces                                                 |

## Development

| page                                                       | what it answers                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------- |
| [architecture.md](development/architecture.md)             | One check, end to end, and why the layers are cut where they are    |
| [adding-a-language.md](development/adding-a-language.md)   | The full path for a new language, in the order that keeps it honest |
| [adding-integration.md](development/adding-integration.md) | How a new integration extends the core, and the contract it holds   |
| [repository.md](development/repository.md)                 | The two packages, plain ESM, gate scripts, CI                       |
| [release.md](development/release.md)                       | How a version reaches the people who use it                         |
| [testing.md](development/testing.md)                       | Which suite proves what, and which failure each tier is for         |

Those pages assume you can already build and run the repository. The setup, the
command list, the commit format and how a pull request lands are
CONTRIBUTING.md's, and none of it is repeated here.

## Who owns what

This repository states a rule once and links to it from everywhere else, so the
useful question is usually not "where is this documented" but "which file is
allowed to say it". That table:

| file                                                                            | owns                                                                                                                                |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                                                                     | The pitch: what Lattice is in one breath, and the way in                                                                            |
| [`docs/why.md`](why.md)                                                         | The gap, and the evidence that it is real                                                                                           |
| [`docs/doctrine/north-star.md`](doctrine/north-star.md)                         | The direction, what "finished" means per language, and the refusals                                                                 |
| [`docs/doctrine/architecture-authority.md`](doctrine/architecture-authority.md) | What Lattice is, what it is not, and the boundary its neighbours may not cross                                                      |
| [`docs/doctrine/principles.md`](doctrine/principles.md)                         | The seven binding principles                                                                                                        |
| [`docs/roadmap.md`](roadmap.md)                                                 | The staged path: what ships today, which capabilities belong to which major version, and in what order                              |
| `docs/getting-started/`                                                         | Installation, first project, first policy                                                                                           |
| `docs/concepts/`                                                                | The model: architecture, graph, boundaries, policies, projects, drift, evidence, waivers, health, fitness functions, agentic development, integrations |
| `docs/usage/`                                                                   | How a consumer runs it and reads its answers                                                                                        |
| `docs/integrations/`                                                            | The provider and editor integrations at the edge — Nx, Moon, and the VS Code extension                                              |
| `docs/reference/`                                                               | Schemas, exit codes, command reference, language limits, violation catalogue                                                       |
| `docs/development/`                                                             | How it works inside, and how to extend it                                                                                           |
| `docs/skills/`                                                                  | Agent architecture skills: overview, installation, hosts, authoring, versioning                                                     |
| `CONTRIBUTING.md`                                                               | The contribution bar, the commands, hooks, commits, review, release                                                                 |
| `SECURITY.md`                                                                   | The threat model — and here a silent gate is a security defect, so read it before touching `scripts/`                               |
| `AGENTS.md`                                                                     | The rules a diff is rejected for violating, for humans and agents alike                                                             |
| `packages/lattice/README.md`                                                    | The package's own reference — it is the npm landing page and must stand alone                                                       |
| `packages/lattice-vscode/README.md`                                             | The VS Code client: what it requires, the two settings it has, and the two it refuses                                               |
| `packages/lattice/CLAUDE.md`                                                    | Layer mechanics: what each layer may know                                                                                           |
| `packages/lattice/src/*/README.md`                                              | Each layer's own semantics — rules, report, conformance                                                                             |
| `packages/lattice/src/analysis/contract.md`                                     | The frozen record every analyzer returns                                                                                            |
| `skills/`                                                                       | Canonical agent architecture skills — the `arch-*` behavioral protocol                                                              |

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
