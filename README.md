<p align="center">
  <a href="https://github.com/ecoma-io/lattice/actions/workflows/ci.yml"><img src="https://github.com/ecoma-io/lattice/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/ecoma-io/lattice/actions/workflows/analysis.yml"><img src="https://github.com/ecoma-io/lattice/actions/workflows/analysis.yml/badge.svg" alt="Analysis" /></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/ecoma-io/lattice"><img src="https://api.scorecard.dev/projects/github.com/ecoma-io/lattice/badge" alt="OpenSSF Scorecard" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache 2.0" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg" alt="Node >= 24" />
  <img src="https://img.shields.io/badge/nx-23-143055.svg" alt="Nx 23" />
  <img src="https://img.shields.io/badge/languages-Go%20%C2%B7%20Rust%20%C2%B7%20Python%20%C2%B7%20TypeScript-335170.svg" alt="Go, Rust, Python, TypeScript" />
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-9B4D2C.svg" alt="Pull requests welcome" /></a>
</p>

<p align="center">
  <img src=".github/assets/banner.png" alt="Lattice — Nx tooling that makes a polyglot workspace's dependency graph and module boundaries real" width="100%" />
</p>

<h1 align="center">Lattice</h1>

<p align="center">
  <strong>Module boundaries for the languages ESLint cannot read.</strong><br />
  Nx sees the dependency graph of a TypeScript workspace and enforces its architecture.
  Add Go, Rust or Python and both halves go quiet — not wrong, quiet.
  Lattice is what makes them speak again.<br />
  <em>A rule that reports nothing looks exactly like a rule with nothing to report.</em>
</p>

<p align="center">
  <a href="https://ecoma.io"><strong>About&nbsp;Ecoma&nbsp;→</strong></a>
</p>

---

## Install

```bash
pnpm add -D @ecoma-io/nx-polyglot-graph
```

Register it in `nx.json` and it starts adding the missing edges:

```json
{
  "plugins": ["@ecoma-io/nx-polyglot-graph"]
}
```

Then check the boundaries those edges cross:

```bash
pnpm exec nx-polyglot-graph check
```

Full documentation — the options, the boundary config, the language server, the
exit codes — in [`packages/nx-polyglot-graph/`](packages/nx-polyglot-graph/README.md).

## The problem

Nx's project graph is what makes a monorepo tractable: `nx affected` runs only
what a change can reach, and `@nx/enforce-module-boundaries` refuses an import
that crosses a line the architecture drew. Both rest on one thing — Nx knowing
which project depends on which.

For TypeScript it does, because it reads the imports. For Go, Rust and Python it
does not, and the way it fails is the problem:

- **`nx affected` under-selects.** A Go library changes; the service importing
  it is not marked affected, so its tests never run. CI is green because nothing
  ran, which is indistinguishable on the dashboard from green because everything
  passed.
- **`@nx/enforce-module-boundaries` never sees the file.** It is an ESLint rule.
  ESLint does not parse `.go`, `.rs` or `.py`, so the architectural rule that
  every TypeScript library is held to simply does not exist for the rest of the
  workspace. Not weaker — absent.

Neither of these announces itself. You find out when a change ships broken, or
when someone notices a `go.mod` that has been importing across a boundary for
six months.

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

## What is here

| Package                                                                   |                                                                                                                                                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [**`@ecoma-io/nx-polyglot-graph`**](packages/nx-polyglot-graph/README.md) | Reads Go, Rust and Python manifests into the Nx project graph, then judges imports against tag-based boundary rules — the `@nx/enforce-module-boundaries` contract, for the languages it cannot reach. |
| _the editor extension_                                                    | Planned. The language server already ships in the package above and works in any LSP client, including Claude Code; a VS Code marketplace listing is what is missing.                                  |

The package was extracted from tooling that had been running in Ecoma's own
polyglot workspace rather than written speculatively, and CI here runs it against
this repository's source under a tag vocabulary it has never seen — which is the
only evidence that "works in your workspace too" is more than a claim.

## Design commitments

These are the things the implementation is held to:

**Static reading only.** Manifests are parsed as data. Nothing invokes `go`,
`cargo` or `uv` to answer a question about imports — a graph that needs four
toolchains installed to compute is a graph that fails on the machine that does
not have them, and Nx computes the graph on every single invocation.

**An empty result is a claim, not a shrug.** The central invariant: an empty
diagnostic list must mean "no violation", and nothing else. Every path that
cannot reach a verdict says so instead of returning quietly. This is why the
issue tracker has a
[dedicated form for a missed violation](.github/ISSUE_TEMPLATE/missed_violation.yml)
separate from the ordinary bug form — a false negative is a different class of
defect, and it is the dangerous one.

**TypeScript stays with `@nx/eslint-plugin`.** Lattice does not replace a rule
that already works. It covers the languages that have nothing.

## Built for Ecoma — a labor operating system for humans and AI agents

Lattice was extracted from the working practice of [**Ecoma**](https://ecoma.io),
the self-hostable, fair-code **labor operating system** where people, AI agents
and rules are the same kind of resource: a role, and whoever fills it.

That premise puts unusual weight on a dependency graph. When an agent proposes a
change, the question "what does this reach?" is asked by a machine, at a rate no
reviewer can match — and an architectural boundary that only exists inside one
language's linter is a boundary the agent will cross without ever seeing a
warning. The rules here are the ones that survived contact with that problem.

You do not need Ecoma to use them. Nothing in this repository depends on it.

## Working on this repository

Requirements: **Node ≥ 24** (`.node-version` pins the major) and **pnpm 11**
(pinned via `packageManager`, so Corepack fetches the right one).

```bash
git clone https://github.com/ecoma-io/lattice.git
cd lattice
pnpm install     # also installs the Git hooks
```

| Command                                              | What it does                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| `pnpm format:check`                                  | Prettier, read-only — what CI runs                           |
| `pnpm lint`                                          | ESLint, zero warnings tolerated                              |
| `pnpm test`                                          | `node --test` over the gate scripts' own tests               |
| `pnpm check-packages`                                | Asserts every `packages/*` directory is a project Nx can see |
| `pnpm exec nx run-many -t lint test build typecheck` | Every project's own targets                                  |
| `node packages/nx-polyglot-graph/cli.mjs check`      | The tool, on the tree that ships it                          |

Full contribution flow, commit format and review bar: [CONTRIBUTING.md](CONTRIBUTING.md).

## Contributing

The most valuable contribution here is a **missed violation** — an import that
crosses a boundary in a real workspace and produced no output. That is a bug of
the worst kind this project has, and it earns a permanent regression fixture,
not just a fix.

Start with [CONTRIBUTING.md](CONTRIBUTING.md). By participating you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md). Security reports go through
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
