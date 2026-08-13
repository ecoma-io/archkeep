# Lattice documentation

Two flows, never mixed.

## The user journey

Read in order the first time; return to a page when you need it.

| step | page                                                 | what it answers                                           |
| ---- | ---------------------------------------------------- | --------------------------------------------------------- |
| 1    | [installation.md](getting-started/installation.md)   | Install the package and confirm it runs                   |
| 2    | [first-project.md](getting-started/first-project.md) | Declare projects in a workspace that has no Nx            |
| 3    | [first-policy.md](getting-started/first-policy.md)   | Tag projects, write the constraint table, see a violation |

Then the concepts — technology-neutral, and Nx is never named:

| page                                        | what it answers                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| [architecture.md](concepts/architecture.md) | One check, end to end, and why the layers are cut where they are             |
| [graph.md](concepts/graph.md)               | What the graph contains and where edges come from                            |
| [boundaries.md](concepts/boundaries.md)     | The constraint table, the five surprising semantics, and how to pick tags    |
| [policies.md](concepts/policies.md)         | The three dialects a boundary file may take                                  |
| [projects.md](concepts/projects.md)         | How projects are discovered, and what a project is                           |
| [integrations.md](concepts/integrations.md) | How the core engine meets the tools a workspace already uses                 |
| [languages.md](concepts/languages.md)       | What each analyzer reads, the shapes it cannot, and the two workspace checks |

Then usage — commands, CI, and troubleshooting:

| page                                           | what it answers                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| [ci.md](usage/ci.md)                           | The exit codes in a pipeline, and SARIF into GitHub code scanning |
| [graph.md](usage/graph.md)                     | The `graph` command: deterministic snapshot of the project graph  |
| [diff.md](usage/diff.md)                       | The `diff` command: two graph snapshots compared edge by edge     |
| [impact.md](usage/impact.md)                   | The `impact` command: projects that depend on the named one       |
| [explain.md](usage/explain.md)                 | The `explain` command: the judgment for one import, explained     |
| [troubleshooting.md](usage/troubleshooting.md) | It found nothing · it found too much · it could not look          |

Then reference — field-by-field, not tutorial:

| page                                           | what it answers                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| [configuration.md](reference/configuration.md) | `lattice.json` field by field, for a workspace with no Nx                    |
| [policy-schema.md](reference/policy-schema.md) | Boundary policy file reference, in every dialect                             |
| [cli.md](reference/cli.md)                     | All five commands: syntax, flags, shared behaviour                           |
| [exit-codes.md](reference/exit-codes.md)       | What each code means and why 3 must not collapse into 0                      |
| [violations.md](reference/violations.md)       | Each of the fifteen violations: what it means, and what fixes it             |
| [json-output.md](reference/json-output.md)     | `--format json`'s versioned envelope: every field, and the stability promise |

## Integrations

The core engine's verdict is the same regardless of which integration asked
for it. Each integration decides how and when it reaches the reader, never what
the verdict is.

| page                                | what it answers                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| [nx.md](integrations/nx.md)         | Polyglot edges in the project graph, `affected`, workspace layout                        |
| [vscode.md](integrations/vscode.md) | Diagnostics at the edit, language status item, resolved from the workspace's own install |

## The project identity

These are not how-to pages. They state what the project is, what it refuses,
and how it stays honest — the direction and the guardrails, not the steps.

| page                                                              | what it answers                                                              |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [north-star.md](doctrine/north-star.md)                           | Where it is going and what it will refuse on the way                         |
| [principles.md](doctrine/principles.md)                           | The seven commitments that govern every decision                             |
| [architecture-governance.md](doctrine/architecture-governance.md) | How architecture stays enforced, who decides what changes, and when to widen |
| [roadmap.md](roadmap.md)                                          | The staged path: which capabilities belong to which phase                    |
| [why.md](why.md)                                                  | The gap this exists to close, with the measurement behind it                 |

## Development

For someone changing the engine, not using it.

| page                                                     | what it answers                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| [architecture.md](development/architecture.md)           | One check, end to end, and why the layers are cut where they are    |
| [adding-a-language.md](development/adding-a-language.md) | The full path for a new language, in the order that keeps it honest |
| [testing.md](development/testing.md)                     | Which suite proves what, and which failure each tier is for         |

Those assume you can already build and run the repository. The setup, the
command list, the commit format and how a pull request lands are
[CONTRIBUTING.md](../CONTRIBUTING.md)'s, and none of it is repeated here.

## Who owns what

This repository states a rule once and links to it from everywhere else, so the
useful question is usually not "where is this documented" but "which file is
allowed to say it". That table:

| file                                                                              | owns                                                                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [`README.md`](../README.md)                                                       | The landing page: what Lattice is, why it exists, where to go next                    |
| [`docs/why.md`](why.md)                                                           | The gap, and the evidence that it is real                                             |
| [`docs/doctrine/north-star.md`](doctrine/north-star.md)                           | The direction, what "finished" means per language, and the refusals                   |
| [`docs/roadmap.md`](roadmap.md)                                                   | The staged path: which capabilities belong to which phase                             |
| [`docs/doctrine/principles.md`](doctrine/principles.md)                           | The seven commitments that govern every decision                                      |
| [`docs/doctrine/architecture-governance.md`](doctrine/architecture-governance.md) | How architecture stays enforced and who decides what changes                          |
| `docs/getting-started/`                                                           | First contact: install, declare, constrain                                            |
| `docs/concepts/`                                                                  | Technology-neutral model: graph, boundaries, projects, policies, languages            |
| `docs/usage/`                                                                     | How a consumer runs commands and reads answers                                        |
| `docs/integrations/`                                                              | How the core engine meets Nx and VS Code                                              |
| `docs/reference/`                                                                 | Field-by-field reference separate from tutorial                                       |
| `docs/development/`                                                               | How it works inside, and how to extend it                                             |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md)                                           | The contribution bar, the commands, hooks, commits, review, release                   |
| [`SECURITY.md`](../SECURITY.md)                                                   | The threat model — and here a silent gate is a security defect                        |
| [`AGENTS.md`](../AGENTS.md)                                                       | The rules a diff is rejected for violating, for humans and agents alike               |
| [`packages/lattice/README.md`](../packages/lattice/README.md)                     | The package's own reference — it is the npm landing page and must stand alone         |
| [`packages/lattice-vscode/README.md`](../packages/lattice-vscode/README.md)       | The VS Code client: what it requires, the two settings it has, and the two it refuses |
| `packages/lattice/CLAUDE.md`                                                      | Layer mechanics: what each layer may know                                             |
| `packages/lattice/src/*/README.md`                                                | Each layer's own semantics — rules, report, conformance                               |
| `packages/lattice/src/analysis/contract.md`                                       | The frozen record every analyzer returns                                              |

Two of those rows overlap on purpose, and it is worth knowing which way:

**The package README repeats things `docs/` also covers.** It is published
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
