<p align="center">
  <img src=".github/assets/banner.png" alt="Lattice — architecture enforcement for polyglot repositories: dependency graphs and module boundaries for the languages ESLint cannot read" width="100%" />
</p>

<h1 align="center">Lattice</h1>

<p align="center">
  <strong>Module boundaries for the languages ESLint cannot read.</strong><br />
  Architecture enforcement that works in any repository, deterministically, with no
  build system as a precondition. Go, Rust, Python — the languages where
  <code>layer:</code> and <code>scope:</code> tags have no mechanism behind them —
  get the same fifteen violation types and the same constraint table that TypeScript
  already has. Nx and Moon are first-class integrations, not dependencies.<br />
  <em>A rule that reports nothing looks exactly like a rule with nothing to report.</em>
</p>

<p align="center">
  <a href="https://github.com/ecoma-io/lattice/actions/workflows/ci.yml"><img src="https://github.com/ecoma-io/lattice/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/ecoma-io/lattice/actions/workflows/analysis.yml"><img src="https://github.com/ecoma-io/lattice/actions/workflows/analysis.yml/badge.svg" alt="Analysis" /></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/ecoma-io/lattice"><img src="https://api.scorecard.dev/projects/github.com/ecoma-io/lattice/badge" alt="OpenSSF Scorecard" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache 2.0" /></a>
</p>

<p align="center">
  <a href="docs/getting-started/installation.md"><strong>Get&nbsp;started&nbsp;→</strong></a> ·
  <a href="docs/why.md">Why&nbsp;it&nbsp;exists</a> ·
  <a href="docs/doctrine/north-star.md">Where&nbsp;it&nbsp;is&nbsp;going</a> ·
  <a href="docs/roadmap.md">Roadmap</a> ·
  <a href="https://ecoma.io">About&nbsp;Ecoma</a>
</p>

---

## Install

```bash
npm install -D @ecoma-io/lattice
pnpm add -D @ecoma-io/lattice
yarn add -D @ecoma-io/lattice
bun add -D @ecoma-io/lattice
```

Create a `lattice.json` at the repository root and it starts discovering projects
and their dependencies:

```json
{
  "projects": {
    "declared": [
      { "name": "billing-core", "root": "libs/billing/core" },
      { "name": "billing-api", "root": "libs/billing/api" }
    ]
  }
}
```

Then check the boundaries:

```bash
pnpm exec lattice check
```

A workspace that already has Nx can register the integration instead and reuse
the project graph Nx already computes:

```json
{
  "plugins": ["@ecoma-io/lattice/nx"]
}
```

A Moonrepo workspace uses `lattice.json` at the root and the Moon provider reads
the project graph from `moon project-graph`:

```json
{
  "boundaryConfig": "module-boundaries.config.mjs"
}
```

Ten minutes end to end, most of it spent deciding what your tags mean:
[**Getting started →**](docs/getting-started/installation.md)

## The idea in one picture

The name is the architecture. A lattice's bars do two things at once, and which
one you see depends on what you are: **structure** if you are being held,
**barrier** if you are trying to cross.

- **The bars are the dependency edges.** Real ones, read out of each language's
  own manifests — `go.mod`, `Cargo.toml`, `pyproject.toml` — so the graph
  matches what the compiler will actually do.
- **The crossings are where two projects meet.** Most should connect. That is
  what a shared library is for.
- **One crossing is refused.** The mark's red X is a boundary violation: an edge
  the tags say must not exist. Finding those, in files no ESLint rule can parse,
  is the whole job.

## Why it exists

In a polyglot repository, the languages ESLint cannot parse have `layer:`,
`scope:` and `license:` tags with no mechanism behind them — a Go import that
crosses a boundary passes lint because ESLint answers "File ignored because no
matching configuration was supplied" for `.go`. The boundary is a declaration
with no enforcer, and the declaration drifts in silence.

That was the gap Lattice was extracted from, measured rather than assumed. The
measurement is in [**docs/why.md**](docs/why.md), along with why an ESLint parser
and an inferred-target plugin were both the wrong answer. Lattice now serves any
repository — Nx and Moon are providers of the project graph, not the only ones.

## What is here

| Package                                                   |                                                                                                                                                                                                                         |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**`@ecoma-io/lattice`**](packages/lattice/README.md)     | Architecture enforcement for polyglot repositories — dependency graphs and module boundaries for Go, Rust, Python, TypeScript and Vue, with Nx and Moon as first-class integrations.                                    |
| [**`lattice-vscode`**](packages/lattice-vscode/README.md) | The VS Code client for that server: the same verdicts, at the edit. It runs the server your workspace installed rather than one of its own, so the buffer and the pipeline cannot disagree. Not on the marketplace yet. |

Fifteen violation types, eight options, and the same `messageId`s ESLint reports
— so the two enforcers can be compared rather than merely both being red. Five
languages today; six commands — `check`, `graph`, `diff`, `impact`, `explain`,
`context`; [more is the direction](docs/doctrine/north-star.md).

## Agent skills

Four `arch-*` skills teach any Agent Skills–compatible coding agent how to
discover, understand, and respect architecture boundaries before making changes:

- **`arch-context`** — understand constraints before editing
- **`arch-change`** — architecture-aware coding workflow
- **`arch-check`** — validate after changes
- **`arch-review`** — architecture impact for code review

```bash
npx skills add ecoma-io/lattice
```

Skills call `lattice` CLI commands — they never duplicate enforcement logic. The
CLI is the authority; the skills are the teacher.
See [**docs/skills/**](docs/skills/overview.md).

## The one commitment behind all of it

**An empty result is a claim, not a shrug.**

An empty diagnostic list means "no violation" and nothing else. Every path that
cannot reach a verdict says so instead of returning quietly — which is why the
CLI has an exit code for _could not look_ that is distinct from _looked and found
nothing_, and why the issue tracker has a
[dedicated form for a missed violation](.github/ISSUE_TEMPLATE/missed_violation.yml)
separate from the ordinary bug form.

A tool that replaced a known gap with an unknown one, wearing a green checkmark,
would be worse than the silence it replaced. The rest of the reasoning, and the
refusals that follow from it, are in [**docs/doctrine/north-star.md**](docs/doctrine/north-star.md).

## Documentation

|                                                                                                                                                        |                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| [**Getting started**](docs/getting-started/installation.md)                                                                                            | Install, configure, first violation                                      |
| [Designing boundaries](docs/concepts/boundaries.md)                                                                                                    | The constraint table, and the five semantics that surprise people        |
| [The fifteen violations](docs/reference/violations.md)                                                                                                 | What each `messageId` means, and what fixes it                           |
| [What each language sees](docs/reference/languages.md)                                                                                                 | Per-language coverage and every declared parse limit                     |
| [Commands](docs/reference/cli.md)                                                                                                                      | `check` · `graph` · `diff` · `impact` · `explain` · `context`            |
| [CI](docs/usage/ci.md) · [VS Code](docs/integrations/vscode.md) · [Troubleshooting](docs/usage/troubleshooting.md)                                     | Exit codes, SARIF, LSP setup, and what to check when it reported nothing |
| [Agent skills](docs/skills/overview.md)                                                                                                                | Architecture-aware agent protocol: four `arch-*` skills                  |
| [Architecture](docs/development/architecture.md) · [Adding a language](docs/development/adding-a-language.md) · [Testing](docs/development/testing.md) | For contributors                                                         |

Full index: [**docs/**](docs/README.md). The package's own reference, which
stands alone as the npm landing page, is
[here](packages/lattice/README.md).

## Contributing

The most valuable contribution here is a **missed violation** — an import that
crosses a boundary in a real workspace and produced no output. That is a bug of
the worst kind this project has, and it earns a permanent regression fixture,
not just a fix.

Setup, commands, commit format and how a pull request lands:
[CONTRIBUTING.md](CONTRIBUTING.md). How the thing works inside:
[docs/development/](docs/development/architecture.md). By participating you agree
to the [Code of Conduct](CODE_OF_CONDUCT.md). Security reports go through
[SECURITY.md](SECURITY.md), never a public issue.

## License

[Apache License 2.0](LICENSE) — © Mai Ngọc Hóa (John Martin) and the Lattice
contributors.

Apache-2.0 rather than MIT because it carries an explicit patent grant. For
tooling that ends up embedded in commercial build pipelines, that is the
difference between "probably fine" and "written down".

---

<p align="center">
  <sub>
    Maintain by <a href="https://ecoma.io">Ecoma</a> ·
    <a href="https://ecoma.io">Website</a> ·
    <a href="https://github.com/ecoma-io">Github</a>
  </sub>
</p>
