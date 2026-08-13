# Lattice documentation

Two doors. Take the one that matches what you are here to do.

- **I want to use it** → [usage/getting-started.md](usage/getting-started.md)
- **I want to change it** → [development/architecture.md](development/architecture.md)

And three documents that are neither, but decide what the rest say:
[why.md](why.md) — the problem this exists for, with the measurement behind it —
[north-star.md](north-star.md) — where it is going and what it will refuse on
the way — and [roadmap.md](roadmap.md) — the staged path there, by major
version.

## Usage

| page                                                     | what it answers                                                               |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [getting-started.md](usage/getting-started.md)           | Install, register the plugin, write the first boundary table, see a violation |
| [lattice-json.md](usage/lattice-json.md)                 | `lattice.json`'s fields, for a workspace with no Nx at all                    |
| [policy-file.md](usage/policy-file.md)                   | What `boundaryConfig` may point at: the `.mjs`/`.js` and `.json` dialects     |
| [designing-boundaries.md](usage/designing-boundaries.md) | What to put in the constraint table, and how to pick tags that hold           |
| [violations.md](usage/violations.md)                     | Each of the fifteen violations: what it means, and what fixes it              |
| [languages.md](usage/languages.md)                       | What each analyzer reads, the shapes it cannot, and the two workspace checks  |
| [ci.md](usage/ci.md)                                     | The exit codes in a pipeline, and SARIF into GitHub code scanning             |
| [graph.md](usage/graph.md)                               | The `graph` command: deterministic snapshot of the project graph              |
| [diff.md](usage/diff.md)                                 | The `diff` command: two graph snapshots compared edge by edge                 |
| [impact.md](usage/impact.md)                             | The `impact` command: projects that depend on the named project               |
| [json-output.md](usage/json-output.md)                   | `--format json`'s versioned envelope: every field, and the stability promise  |
| [editors.md](usage/editors.md)                           | Diagnostics at the edit, per client                                           |
| [troubleshooting.md](usage/troubleshooting.md)           | It found nothing · it found too much · it could not look                      |

## Development

| page                                                     | what it answers                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| [architecture.md](development/architecture.md)           | One check, end to end, and why the layers are cut where they are    |
| [adding-a-language.md](development/adding-a-language.md) | The full path for a new language, in the order that keeps it honest |
| [testing.md](development/testing.md)                     | Which suite proves what, and which failure each tier is for         |

Those three assume you can already build and run the repository. The setup, the
command list, the commit format and how a pull request lands are
[CONTRIBUTING.md](../CONTRIBUTING.md)'s, and none of it is repeated here.

## Who owns what

This repository states a rule once and links to it from everywhere else, so the
useful question is usually not "where is this documented" but "which file is
allowed to say it". That table:

| file                                                                        | owns                                                                                                  |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [`README.md`](../README.md)                                                 | The pitch: what Lattice is in one breath, and the way in                                              |
| [`docs/why.md`](why.md)                                                     | The gap, and the evidence that it is real                                                             |
| [`docs/north-star.md`](north-star.md)                                       | The direction, what "finished" means per language, and the refusals                                   |
| [`docs/roadmap.md`](roadmap.md)                                             | The staged path: which capabilities belong to which major version, and in what order                  |
| `docs/usage/`                                                               | How a consumer runs it and reads its answers                                                          |
| `docs/development/`                                                         | How it works inside, and how to extend it                                                             |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md)                                     | The contribution bar, the commands, hooks, commits, review, release                                   |
| [`SECURITY.md`](../SECURITY.md)                                             | The threat model — and here a silent gate is a security defect, so read it before touching `scripts/` |
| [`AGENTS.md`](../AGENTS.md)                                                 | The rules a diff is rejected for violating, for humans and agents alike                               |
| [`packages/lattice/README.md`](../packages/lattice/README.md)               | The package's own reference — it is the npm landing page and must stand alone                         |
| [`packages/lattice-vscode/README.md`](../packages/lattice-vscode/README.md) | The VS Code client: what it requires, the two settings it has, and the two it refuses                 |
| `packages/lattice/CLAUDE.md`                                                | Layer mechanics: what each layer may know                                                             |
| `packages/lattice/src/*/README.md`                                          | Each layer's own semantics — rules, report, conformance                                               |
| `packages/lattice/src/analysis/contract.md`                                 | The frozen record every analyzer returns                                                              |

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
