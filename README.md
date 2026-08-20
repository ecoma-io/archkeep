<p align="center">
  <img src=".github/assets/banner.png" alt="Lattice — architecture governance for human and agentic software development: a deterministic authority that keeps the architecture your team declared aligned with the code your team keeps changing" width="100%" />
</p>

<h1 align="center">Lattice</h1>

<p align="center">
  <strong>A deterministic architecture governance system for humans and coding agents.</strong><br />
  Observed architecture is compared against declared intent and enforced as a verdict —
  not a reviewer's belief. Polyglot module boundaries, deterministic evidence,
  drift detection, evolution history and agent planning context, in any repository,
  with or without Nx or Moon.<br />
  <em>A rule that reports nothing looks exactly like a rule with nothing to report.</em>
</p>

<p align="center">
  <a href="https://github.com/ecoma-io/lattice/actions/workflows/ci.yml"><img src="https://github.com/ecoma-io/lattice/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/ecoma-io/lattice/actions/workflows/analysis.yml"><img src="https://github.com/ecoma-io/lattice/actions/workflows/analysis.yml/badge.svg" alt="Analysis" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache 2.0" /></a>
</p>

<p align="center">
  <a href="docs/getting-started/installation.md"><strong>Quick&nbsp;start&nbsp;→</strong></a> ·
  <a href="docs/doctrine/why.md">Why&nbsp;it&nbsp;exists</a> ·
  <a href="docs/doctrine/architecture-authority.md">What&nbsp;it&nbsp;governs</a> ·
  <a href="docs/doctrine/north-star.md">North&nbsp;star</a> ·
  <a href="docs/doctrine/roadmap.md">Roadmap</a> ·
  <a href="https://ecoma.io">About&nbsp;Ecoma</a>
</p>

---

## What Lattice is

Lattice makes your architecture a **verdict instead of a document**. You declare
the boundaries — layers, scopes, allowed dependencies — as code, and Lattice
deterministically compares them against what the source actually does: every
import, every project, every edge, across Go, Rust, Python, TypeScript,
JavaScript and Vue. Same tree, same config, same answer, everywhere it runs —
CI, editor, or an agent reading JSON.

It is built for two consumers at once: a human team reviewing its architecture
like code, and a coding agent that needs the same facts, machine-readably, at
the moment it touches a boundary. The agent is a consumer of the verdict, never
its authority.

## Why it exists

Agentic coding raises the rate of architectural decisions past what human
review can hold. And in a polyglot repository the existing toolchain goes
quiet exactly where you need it: ESLint cannot parse Go, Rust or Python, so
boundary tags on those projects have no mechanism behind them, and
`nx affected` cannot see their edges. The failure is silent — an unenforced
boundary looks identical to a clean workspace. Lattice exists to end that
silence, and [docs/doctrine/why.md](docs/doctrine/why.md) holds the measurement
that proves the gap is real.

## What you get

- **A polyglot architecture graph** — projects, edges and tags read from
  source, never from a build, in any repository: plain, Nx or Moon.
- **Boundaries enforced as law** — the `@nx/enforce-module-boundaries`
  constraint model, extended to every supported language, judged with four
  exit codes where _could not look_ is never _clean_.
- **Deterministic evidence** — sixteen commands (`check`, `graph`, `diff`,
  `drift`, `explain`, `impact`, `context`, and more) with versioned,
  byte-stable JSON output a script or an agent consumes without parsing prose.
- **Drift, history and debt** — what diverged from the declared intent, how
  the architecture evolved across snapshots, and how long each accepted
  violation has been waiting.
- **An agent protocol** — four `arch-*` skills that teach a coding agent to
  read the constraints before editing and get verified by the same gate as CI.

The model behind all of it is in
[docs/concepts/](docs/concepts/architecture.md); every command, flag and exit
code is in [docs/reference/cli.md](docs/reference/cli.md).

## The one commitment behind all of it

**An empty result is a claim, not a shrug.** Every path that cannot reach a
verdict says so instead of returning quietly — a tool that replaced a known gap
with an unknown one, wearing a green checkmark, would be worse than the silence
it replaced. The reasoning, and the refusals that follow from it, are in
[docs/doctrine/north-star.md](docs/doctrine/north-star.md).

## Get started

```bash
npm install -D @ecoma-io/lattice   # or pnpm / yarn / bun
```

Ten minutes end to end, most of it spent deciding what your tags mean:

- [**Installation**](docs/getting-started/installation.md) — prerequisites and
  what the package provides
- [**Your first project**](docs/getting-started/first-project.md) — a
  `lattice.json` workspace, no Nx required
- [**Your first policy**](docs/getting-started/first-policy.md) — write a
  constraint table, see a violation, read the verdict

## Documentation

|                                                                                                                                                        |                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| [**Getting started**](docs/getting-started/installation.md)                                                                                            | Install, configure, first violation                                    |
| [**Doctrine**](docs/doctrine/north-star.md) · [**Roadmap**](docs/doctrine/roadmap.md)                                                                  | The direction, and the staged path (1.x governance → 2.x intelligence) |
| [Designing boundaries](docs/concepts/boundaries.md)                                                                                                    | The constraint table, and the five semantics that surprise people      |
| [The fifteen violations](docs/reference/violations.md)                                                                                                 | What each `messageId` means, and what fixes it                         |
| [What each language sees](docs/reference/languages.md)                                                                                                 | Per-language coverage and every declared parse limit                   |
| [Commands](docs/reference/cli.md)                                                                                                                      | All sixteen, with every flag and exit code                             |
| [Nx](docs/integrations/nx.md) · [Moon](docs/integrations/moon.md) · [VS Code](docs/integrations/vscode.md)                                             | The integrations at the edge                                           |
| [CI](docs/usage/ci.md) · [Troubleshooting](docs/usage/troubleshooting.md)                                                                              | Exit codes in a pipeline, and what to check when it reported nothing   |
| [Agent skills](docs/skills/overview.md)                                                                                                                | Architecture-aware agent protocol: four `arch-*` skills                |
| [Architecture](docs/development/architecture.md) · [Adding a language](docs/development/adding-a-language.md) · [Testing](docs/development/testing.md) | For contributors                                                       |

Full index: [**docs/**](docs/README.md). The package's own reference, which
stands alone as the npm landing page, is
[here](packages/lattice/README.md).

## Contributing

The most valuable contribution here is a **missed violation** — an import that
crosses a boundary in a real workspace and produced no output. That is a bug of
the worst kind this project has, and it has a
[dedicated issue form](.github/ISSUE_TEMPLATE/missed_violation.yml).

Setup, commands, commit format and how a pull request lands:
[CONTRIBUTING.md](CONTRIBUTING.md). By participating you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md). Security reports go through
[SECURITY.md](SECURITY.md), never a public issue.

## License

[Apache License 2.0](LICENSE) — © Mai Ngọc Hóa (John Martin) and the Lattice
contributors. Apache-2.0 rather than MIT because it carries an explicit patent
grant: for tooling embedded in commercial build pipelines, that is the
difference between "probably fine" and "written down".

---

<p align="center">
  <sub>
    Maintained by <a href="https://ecoma.io">Ecoma</a> ·
    <a href="https://ecoma.io">Website</a> ·
    <a href="https://github.com/ecoma-io">Github</a>
  </sub>
</p>
