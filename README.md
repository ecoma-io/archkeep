<p align="center">
  <img src=".github/assets/banner.png" alt="Lattice — architecture governance for human and agentic software development: a deterministic authority that keeps the architecture your team declared aligned with the code your team keeps changing" width="100%" />
</p>

<h1 align="center">Lattice</h1>

<p align="center">
  <strong>An architecture governance system for human and agentic software development.</strong><br />
  A deterministic authority that keeps the architecture your team declared aligned with the code
  your team — human and agent — keeps changing. Polyglot module boundaries, architecture evidence,
  drift detection and agent skills, in any repository, with or without Nx or Moon.<br />
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
  <a href="docs/doctrine/north-star.md">North&nbsp;star</a> ·
  <a href="docs/doctrine/architecture-authority.md">What&nbsp;it&nbsp;governs</a> ·
  <a href="docs/roadmap.md">Roadmap</a> ·
  <a href="https://ecoma.io">About&nbsp;Ecoma</a>
</p>

---

## Why Lattice

Agentic coding increases the rate at which architectural decisions are made. Humans cannot
manually review every architectural decision. So the architecture has to become explicit,
machine-readable, continuously checked, available to agents, and enforceable.

Lattice is the authority a repository consults for the question _does the code that exists
agree with the architecture that was declared_ — answered deterministically, by a pipeline,
not by a reviewer's belief. It is not a dependency graph, not an architecture linter, not an
Nx or Moon plugin, though it produces all of those. It is the governance layer above the
project tooling.

The gap it closes first is the one ESLint leaves open: in a polyglot repository, the languages
ESLint cannot parse have `layer:`, `scope:` and `license:` tags with no mechanism behind them —
a Go import that crosses a boundary passes lint because ESLint answers "File ignored because no
matching configuration was supplied" for `.go`. The measurement that established this is in
[**docs/why.md**](docs/why.md).

## How it works

```
Repository
    ↓
Architecture model          projects, edges, tags — from a provider (Nx, Moon, or native)
    ↓
Policy / intent             the constraint table in your workspace
    ↓
Deterministic evidence      graph · check · diff · impact · explain · context · snapshots
    ↓
Governance                  the verdict, as an exit code and a machine-readable report
    ↓
Human + coding agent        a developer in CI, an agent reading the JSON envelope
```

One analysis, three faces: the CLI, the language server, and the integrations. The verdict is
the same everywhere; only the delivery changes. Six commands —
`check`, `graph`, `diff`, `impact`, `explain`, `context` — with versioned machine-readable
output, four exit codes, and a snapshot/diff pair that records the architecture over time
with provenance. The full pipeline is in [**docs/concepts/architecture.md**](docs/concepts/architecture.md).

## What Lattice governs

- **Module boundaries for every language** — the same fifteen violation types and the same
  constraint table TypeScript and JavaScript already have, extended to Go, Rust, Python and
  Vue. The boundary is judged from source, never from a build.
- **Architecture as code** — layers, scopes and dependencies declared in a machine-readable
  model in your repository, reviewed like code.
- **Architecture evidence** — `context` before an edit, `impact` during planning, `explain`
  after a finding, `diff` across time, snapshots with provenance.
- **Drift** — structural change, configuration drift and boundary violations, surfaced
  deterministically by `check` and `diff`.
- **Agentic governance** — the same authority, read machine-readably by coding agents through
  the `arch-*` skills.

The boundary between Lattice and everything around it — providers, skills, agents, CI — is
owned by [**docs/doctrine/architecture-authority.md**](docs/doctrine/architecture-authority.md).
Lattice decides _is this edge valid_; the agent decides _what code to write_; the agent is a
consumer of the verdict, never its authority.

## Agentic development

Coding agents cross boundaries as easily as humans do, and faster. Lattice answers the
questions an agent asks at the moments it asks them, with machine-readable output a model can
consume without parsing prose:

- **Before the edit** — `lattice context <project>`: what is this project allowed to reach?
- **During planning** — `lattice impact <project>`: what depends on this?
- **After the change** — `lattice check` / `lattice explain`: does the change hold, and why?

Four `arch-*` skills teach any Agent Skills–compatible agent _when_ to ask, _why_ it matters,
and _what to do_ when the answer is not clean:

- **`arch-context`** — understand constraints before editing
- **`arch-change`** — architecture-aware coding workflow
- **`arch-check`** — validate after changes
- **`arch-review`** — architecture impact for code review

```bash
npx skills add ecoma-io/lattice
```

Skills call `lattice` CLI commands — they never duplicate enforcement logic. The CLI is the
authority; the skills are the teacher. See [**docs/skills/**](docs/skills/overview.md).

## Supported repositories

Lattice works in any repository. Nx and Moon are first-class providers, not dependencies:

- **Any repository** — create a `lattice.json` at the root and the native provider discovers
  projects from the tracked tree. No `nx`, no `moon`, no build system required.
- **An Nx workspace** — register the integration in `nx.json` and it reuses the project graph
  Nx already computes, drawing the Go/Rust/Python edges `nx affected` was missing.
- **A Moonrepo workspace** — read the project graph back from `moon project-graph`, with the
  same verdict.

## Quick start

```bash
npm install -D @ecoma-io/lattice   # or pnpm / yarn / bun
```

Create a `lattice.json` at the repository root:

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

Ten minutes end to end, most of it spent deciding what your tags mean:
[**Getting started →**](docs/getting-started/installation.md)

## The one commitment behind all of it

**An empty result is a claim, not a shrug.**

An empty diagnostic list means "no violation" and nothing else. Every path that cannot reach
a verdict says so instead of returning quietly — which is why the CLI has an exit code for
_could not look_ that is distinct from _looked and found nothing_, and why the issue tracker
has a [dedicated form for a missed violation](.github/ISSUE_TEMPLATE/missed_violation.yml)
separate from the ordinary bug form. A tool that replaced a known gap with an unknown one,
wearing a green checkmark, would be worse than the silence it replaced. The rest of the
reasoning, and the refusals that follow from it, are in
[**docs/doctrine/north-star.md**](docs/doctrine/north-star.md).

## Documentation

|                                                                                                                                                        |                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| [**Getting started**](docs/getting-started/installation.md)                                                                                            | Install, configure, first violation                                      |
| [**North star**](docs/doctrine/north-star.md) · [**Roadmap**](docs/roadmap.md)                                                                         | The direction, and the staged path (1.x governance → 2.x intelligence)   |
| [Designing boundaries](docs/concepts/boundaries.md)                                                                                                    | The constraint table, and the five semantics that surprise people        |
| [The fifteen violations](docs/reference/violations.md)                                                                                                 | What each `messageId` means, and what fixes it                           |
| [What each language sees](docs/reference/languages.md)                                                                                                 | Per-language coverage and every declared parse limit                     |
| [Commands](docs/reference/cli.md)                                                                                                                      | `check` · `graph` · `diff` · `impact` · `explain` · `context`            |
| [CI](docs/usage/ci.md) · [VS Code](docs/integrations/vscode.md) · [Troubleshooting](docs/usage/troubleshooting.md)                                     | Exit codes, SARIF, LSP setup, and what to check when it reported nothing |
| [Agent skills](docs/skills/overview.md)                                                                                                                | Architecture-aware agent protocol: four `arch-*` skills                  |
| [Architecture](docs/development/architecture.md) · [Adding a language](docs/development/adding-a-language.md) · [Testing](docs/development/testing.md) | For contributors                                                         |

Full index: [**docs/**](docs/README.md). The package's own reference, which stands alone as the
npm landing page, is [here](packages/lattice/README.md).

## Contributing

The most valuable contribution here is a **missed violation** — an import that crosses a
boundary in a real workspace and produced no output. That is a bug of the worst kind this
project has, and it earns a permanent regression fixture, not just a fix.

Setup, commands, commit format and how a pull request lands:
[CONTRIBUTING.md](CONTRIBUTING.md). How the thing works inside:
[docs/development/](docs/development/architecture.md). By participating you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md). Security reports go through [SECURITY.md](SECURITY.md),
never a public issue.

## License

[Apache License 2.0](LICENSE) — © Mai Ngọc Hóa (John Martin) and the Lattice contributors.

Apache-2.0 rather than MIT because it carries an explicit patent grant. For tooling that ends
up embedded in commercial build pipelines, that is the difference between "probably fine" and
"written down".

---

<p align="center">
  <sub>
    Maintain by <a href="https://ecoma.io">Ecoma</a> ·
    <a href="https://ecoma.io">Website</a> ·
    <a href="https://github.com/ecoma-io">Github</a>
  </sub>
</p>
