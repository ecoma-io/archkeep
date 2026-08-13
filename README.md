<p align="center">
  <a href="https://github.com/ecoma-io/lattice/actions/workflows/ci.yml"><img src="https://github.com/ecoma-io/lattice/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/ecoma-io/lattice/actions/workflows/analysis.yml"><img src="https://github.com/ecoma-io/lattice/actions/workflows/analysis.yml/badge.svg" alt="Analysis" /></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/ecoma-io/lattice"><img src="https://api.scorecard.dev/projects/github.com/ecoma-io/lattice/badge" alt="OpenSSF Scorecard" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache 2.0" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg" alt="Node >= 24" />
  <img src="https://img.shields.io/badge/languages-Go%20%C2%B7%20Rust%20%C2%B7%20Python%20%C2%B7%20TypeScript%20%C2%B7%20Vue-335170.svg" alt="Go, Rust, Python, TypeScript, Vue" />
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-9B4D2C.svg" alt="Pull requests welcome" /></a>
</p>

<p align="center">
  <img src=".github/assets/banner.png" alt="Lattice — executable architecture for software projects" width="100%" />
</p>

<h1 align="center">Lattice</h1>

<p align="center">
  <strong>Executable architecture for software projects.</strong><br />
  Keeping architecture enforceable when software is produced faster
  than humans can review it.<br />
  <em>A rule that reports nothing looks exactly like a rule with nothing to report.</em>
</p>

<p align="center">
  <a href="docs/getting-started/installation.md"><strong>Get&nbsp;started&nbsp;→</strong></a> ·
  <a href="docs/why.md">Why&nbsp;it&nbsp;exists</a> ·
  <a href="docs/doctrine/north-star.md">Where&nbsp;it&nbsp;is&nbsp;going</a> ·
  <a href="docs/roadmap.md">Roadmap</a> ·
  <a href="https://ecoma.io">About&nbsp;Ecoma</a>
</p>

---

## What it is

A boundary checker for the languages ESLint cannot parse. Five languages
(Go, Rust, Python, TypeScript, Vue), one constraint table, fifteen
violation types, and the same `messageId`s the ESLint rule reports —
so the two enforcers can be compared rather than merely both being red.

The engine ships three surfaces against one analysis: a CLI, a language
server, and a build-system integration. Every surface reads the same
boundary config; no surface holds a copy.

## Why it exists

`nx affected` under-selects and `@nx/enforce-module-boundaries` never sees
the file — so a Go project's `layer:` and `scope:` tags are a declaration
with no mechanism behind them. Neither failure announces itself.

That claim was measured rather than assumed, and the measurement is in
[docs/why.md](docs/why.md), along with why an ESLint parser and an
inferred-target plugin were both the wrong answer.

## How it works

Static analysis — no `go`, no `cargo`, no `uv`, no `python` process.
Manifests are parsed as data; sources are read as text. That is what lets
the graph compute on a lint-only CI runner that has none of the four
toolchains installed.

Five commands, each honest about what it could and could not reach:

| command   | what it does                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------ |
| `check`   | Judge every tracked source file against the boundary law. Only command that exits 1 on findings. |
| `graph`   | Print the project graph as a deterministic snapshot.                                             |
| `diff`    | Compare two graph snapshots edge by edge.                                                        |
| `impact`  | List every project that transitively depends on the named one.                                   |
| `explain` | Explain the judgment for one import site.                                                        |

## What it enforces

The constraint table is the whole configuration surface. Everything else is
mechanism. The table says: a project carrying _this_ tag may depend on
projects carrying _those_ tags, and/or may not import _these_ external
packages.

Five semantics that surprise people — each one ported literally from the
upstream ESLint rule, because this tool and that rule must keep agreeing
about which imports escape:

1. **A project matching no row is a violation**, not unrestricted.
2. **Several matching rows are AND, not OR.** Adding a row can only make
   the workspace stricter.
3. **`notDependOnLibsWithTags` is transitive.** It looks at everything
   the target can reach.
4. **`onlyDependOnLibsWithTags: []` means "may depend on nothing".** It
   is not "no restriction".
5. **Patterns are not globs.** Three different dialects, each inherited
   from the ESLint rule, each with its own surprises.

Full detail in [docs/concepts/boundaries.md](docs/concepts/boundaries.md).

## Try it

```shell
pnpm add -D @ecoma-io/lattice
pnpm exec lattice --help
```

Then continue by workspace type:

- **Nx workspace** — register the plugin in `nx.json`, write the boundary
  table, see a violation.
  [Getting started →](docs/getting-started/installation.md)
- **No Nx** — declare projects in `lattice.json`, write the boundary
  table, see a violation.
  [First project →](docs/getting-started/first-project.md)

## Next

|                                                         |                                                                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [Getting started](docs/getting-started/installation.md) | Install, configure, first violation                                                                   |
| [Concepts](docs/concepts/architecture.md)               | Architecture, graph, boundaries, policies, projects, languages — technology-neutral                   |
| [Integrations](docs/integrations/nx.md)                 | Nx (project graph, affected, workspace layout) · VS Code (diagnostics at the edit)                    |
| [Reference](docs/reference/cli.md)                      | CLI commands · `lattice.json` · Policy schema · Exit codes · Violations · JSON envelope               |
| [Doctrine](docs/doctrine/principles.md)                 | The seven commitments, architecture governance, north star, roadmap — doctrine is part of the product |
| [Development](docs/development/architecture.md)         | For contributors                                                                                      |

Full index: [docs/](docs/README.md). The package's own reference, which
stands alone as the npm landing page, is
[here](packages/lattice/README.md).

## The one commitment behind all of it

**An empty result is a claim, not a shrug.**

An empty diagnostic list means "no violation" and nothing else. Every path
that cannot reach a verdict says so instead of returning quietly — which is
why the CLI has an exit code for _could not look_ that is distinct from
_looked and found nothing_, and why the issue tracker has a
[dedicated form for a missed violation](.github/ISSUE_TEMPLATE/missed_violation.yml)
separate from the ordinary bug form.

A tool that replaced a known gap with an unknown one, wearing a green
checkmark, would be worse than the silence it replaced. The reasoning, and
the refusals that follow from it, are in
[docs/doctrine/north-star.md](docs/doctrine/north-star.md).

## Built for Ecoma — a labor operating system for humans and AI agents

Lattice was extracted from the working practice of [**Ecoma**](https://ecoma.io),
the self-hostable, fair-code **labor operating system** where people, AI agents
and rules are the same kind of resource: a role, and whoever fills it.

That premise puts unusual weight on a dependency graph. When an agent proposes
a change, the question "what does this reach?" is asked by a machine, at a
rate no reviewer can match — and an architectural boundary that only exists
inside one language's linter is a boundary the agent will cross without ever
seeing a warning. The rules here are the ones that survived contact with that
problem.

You do not need Ecoma to use them. Nothing in this repository depends on it.

## Contributing

The most valuable contribution here is a **missed violation** — an import that
crosses a boundary in a real workspace and produced no output. That is a bug of
the worst kind this project has, and it earns a permanent regression fixture,
not just a fix.

Setup, commands, commit format and how a pull request lands:
[CONTRIBUTING.md](CONTRIBUTING.md). How the thing works inside:
[docs/development/](docs/development/architecture.md). By participating you
agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security reports go through
[SECURITY.md](SECURITY.md), never a public issue.

## License

[Apache License 2.0](LICENSE) — © Mai Ngọc Hóa (John Martin) and the Lattice
contributors.

Apache-2.0 rather than MIT because it carries an explicit patent grant. For
tooling that ends up embedded in commercial build pipelines, that is the
difference between "probably fine" and "written down".

---

<p align="center">
  <img src=".github/assets/logo.png" alt="" width="56" /><br />
  <sub>
    Part of the <a href="https://ecoma.io">Ecoma</a> ecosystem ·
    <a href="https://ecoma.io">Website</a> ·
    <a href="https://github.com/ecoma-io">Organisation</a>
  </sub>
</p>
