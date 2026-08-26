<p align="center">
  <img src=".github/assets/banner.png" alt="Archkeep — architecture governance for human and agentic software development: a deterministic authority that keeps the architecture your team declared aligned with the code your team keeps changing" width="100%" />
</p>

<h1 align="center">Archkeep</h1>

<p align="center">
  <strong>A deterministic architecture governance system for humans and coding agents.</strong><br />
  Declare your architecture as code — layers, scopes, allowed dependencies — and Archkeep
  turns it into a verdict: every import in Go, Rust, Python, TypeScript, JavaScript and Vue,
  judged against your declared intent, in any repository, with or without Nx or Moon.<br />
  <em>A rule that reports nothing looks exactly like a rule with nothing to report.</em>
</p>

<p align="center">
  <a href="https://github.com/ecoma-io/archkeep/actions/workflows/ci.yml"><img src="https://github.com/ecoma-io/archkeep/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/ecoma-io/archkeep/actions/workflows/analysis.yml"><img src="https://github.com/ecoma-io/archkeep/actions/workflows/analysis.yml/badge.svg" alt="Analysis" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache 2.0" /></a>
  <a href="https://www.npmjs.com/package/@ecoma-io/archkeep"><img src="https://img.shields.io/npm/dm/@ecoma-io/archkeep.svg" alt="npm downloads per month" /></a>
</p>

<p align="center">
  <a href="docs/getting-started/installation.md"><strong>Quick&nbsp;start&nbsp;→</strong></a> ·
  <a href="docs/doctrine/why.md">Why&nbsp;it&nbsp;exists</a> ·
  <a href="docs/doctrine/north-star.md">North&nbsp;star</a> ·
  <a href="docs/doctrine/roadmap.md">Roadmap</a> ·
  <a href="docs/README.md">Docs</a> ·
  <a href="https://ecoma.io">About&nbsp;Ecoma</a>
</p>

---

Agentic coding creates architectural decisions faster than human review can
hold, and in a polyglot repository the existing tools go quiet exactly where
you need them: ESLint cannot parse Go, Rust or Python, and `nx affected`
cannot see their edges — an unenforced boundary looks identical to a clean
workspace. Archkeep ends that silence with one deterministic authority serving
both your CI and your coding agents: same tree, same config, same answer,
everywhere. The measurement behind the claim is in
[docs/doctrine/why.md](docs/doctrine/why.md).

- **Polyglot architecture graph** — projects, edges and tags read from source,
  never from a build, in any repository: plain, Nx or Moon.
- **Boundaries enforced as law** — the `@nx/enforce-module-boundaries` model,
  extended to every supported language, where _could not look_ is never _clean_.
- **Deterministic evidence** — twenty commands with versioned, byte-stable
  JSON an agent or a script consumes without parsing prose.
- **Drift, history and debt** — what diverged from intent, how the architecture
  evolved, and how long each accepted violation has been waiting.
- **Agent protocol** — five `arch-*` skills that make a coding agent a consumer
  of the verdict, never its authority.

## In action

**Your declared intent:**

```json
{
  "allowed": [
    { "from": "layer:domain", "to": "layer:application" },
    { "from": "layer:application", "to": "layer:domain" }
  ],
  "forbidden": [{ "from": "layer:domain", "to": "layer:infrastructure" }]
}
```

**The verdict:**

```bash
$ archkeep check
src/orders/api/order-service.ts:3:7 — error: forbidden dependency
  ❌ layer:domain → layer:infrastructure

  Dependency chain: order-service → infrastructure-client
  Intent: layer:domain may not depend on layer:infrastructure
```

One rule, enforced everywhere. The same command runs on your CI,
your agent invokes it before proposing changes, and `--format json`
feeds your governance dashboard. Architecture as code — enforced as law.

## Get started

```bash
npm install -D @ecoma-io/archkeep   # or pnpm / yarn / bun
```

Ten minutes end to end, most of it spent deciding what your tags mean:
[**Getting started →**](docs/getting-started/installation.md)

> **Coming from Lattice?** This is the same tool under a new name. Three things
> break until you change them — the workspace file, the binaries, and any
> compiled custom rule — and everything already published stays installable:
> [**Upgrading from Lattice →**](docs/getting-started/upgrading-from-lattice.md)

## Documentation

|                                                                                                                                              |                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [**Getting started**](docs/getting-started/installation.md)                                                                                  | Install, configure, first violation                                    |
| [**Doctrine**](docs/doctrine/north-star.md) · [**Roadmap**](docs/doctrine/roadmap.md)                                                        | The direction, and the staged path (1.x governance → 2.x intelligence) |
| [Concepts](docs/concepts/architecture.md)                                                                                                    | The model: graph, boundaries, drift, evidence, agents                  |
| [Usage](docs/usage/checking.md) · [CI](docs/usage/ci.md)                                                                                     | Running it, and reading its answers                                    |
| [Reference](docs/reference/cli.md)                                                                                                           | Every command, flag, exit code, schema and parse limit                 |
| [Nx](docs/integrations/nx.md) · [Moon](docs/integrations/moon.md) · [VS Code](docs/integrations/vscode.md) · [MCP](docs/integrations/mcp.md) | The integrations at the edge                                           |
| [Agent skills](docs/skills/overview.md)                                                                                                      | The architecture-aware agent protocol                                  |
| [Development](docs/development/architecture.md)                                                                                              | For contributors: how it works inside                                  |

Full index: [**docs/**](docs/README.md). The package's own reference, which
stands alone as the npm landing page, is [here](packages/archkeep/README.md).

## Contributing

The most valuable contribution is a **missed violation** — a boundary crossed
in a real workspace with no output; it has a
[dedicated issue form](.github/ISSUE_TEMPLATE/missed_violation.yml). Everything
else: [CONTRIBUTING.md](CONTRIBUTING.md) ·
[Code of Conduct](CODE_OF_CONDUCT.md) · [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE) — © Mai Ngọc Hóa (John Martin) and the Archkeep
contributors. Apache-2.0 for its explicit patent grant.

---

<p align="center">
  <sub>
    Maintained by <a href="https://ecoma.io">Ecoma</a> ·
    <a href="https://ecoma.io">Website</a> ·
    <a href="https://github.com/ecoma-io">Github</a>
  </sub>
</p>
