<!-- harmonise:skip-start -->
<p align="center">
  <a href="https://github.com/ecoma-io/archkeep/actions/workflows/ci.yml"><img src="https://github.com/ecoma-io/archkeep/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/ecoma-io/archkeep/actions/workflows/analysis.yml"><img src="https://github.com/ecoma-io/archkeep/actions/workflows/analysis.yml/badge.svg" alt="Analysis" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache 2.0" /></a>
  <a href="https://www.npmjs.com/package/@ecoma-io/archkeep"><img src="https://img.shields.io/npm/dm/@ecoma-io/archkeep.svg" alt="npm downloads per month" /></a>
</p>
<!-- harmonise:skip-end -->

<p align="center">
  <img src=".github/assets/logo.png" alt="Archkeep" width="64px" />
</p>

<h1 align="center">Archkeep</h1>

<!-- harmonise:skip-start -->
<p align="center">
<a href="README.md">English</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh.md">中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.es.md">Español</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.ar.md">العربية</a> | <a href="README.pt.md">Português</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.ru.md">Русский</a> | <a href="README.fr.md">Français</a>
</p>
<!-- harmonise:skip-end -->

<p align="center">
  <strong>An architecture authority for human and agentic software development.</strong><br />
  Declare the architecture you intend. Archkeep compares it with the architecture your repository actually has and produces deterministic, evidence-backed verdicts.
</p>

<p align="center">
  <a href="docs/README.md">Docs</a> ·
  <a href="https://github.com/ecoma-io/archkeep/issues/new?template=bug_report.yml">Report Bug</a> ·
  <a href="https://github.com/ecoma-io/archkeep/issues/new?template=feature_request.yml">Feature Request</a>
</p>

<p align="center">
  <img src=".github/assets/banner.png" alt="Archkeep" width="100%" />
</p>

## Why Archkeep

Architecture rarely fails all at once. It erodes.

A team agrees on layers, ownership and dependency boundaries. Then the repository changes: a convenient import crosses a boundary, a temporary exception becomes permanent, documentation drifts from reality, and coding agents make the same problem scale faster.

The build can still pass. Tests can still pass. A linter can still report clean.

The missing question is:

> **Does the code still conform to the architecture we chose?**

Archkeep turns that question into a machine-checkable contract.

## The core idea

```text
ARCHITECTURE INTENT
        ↓
OBSERVED REALITY
        ↓
DETERMINISTIC EVIDENCE
        ↓
AUTHORITATIVE VERDICT
```

You declare the boundaries and dependency rules that matter. Archkeep statically observes the repository, builds the relevant graph and evidence, compares reality with intent, and returns a deterministic verdict.

The same authority can be used by humans, CI and coding agents.

## Why it is different

| Tool               | Answers                                                 |
| ------------------ | ------------------------------------------------------- |
| Compiler           | Does it build?                                          |
| Tests              | Does it behave?                                         |
| Linter             | Does the code follow language/style rules?              |
| Dependency tooling | How is the code connected?                              |
| AI code review     | Does a model think this change looks reasonable?        |
| **Archkeep**       | **Does the code conform to the architecture we chose?** |

Archkeep does not replace these tools. It owns the architectural boundary between them.

## How it fits agentic development

```text
Human declares architecture
            ↓
      Coding agent
   reads architecture context
            ↓
       changes code
            ↓
       Archkeep check
            ↓
     deterministic verdict
            ↓
             CI
```

Agents may inspect, explain and propose. They do not redefine the architecture when their changes disagree with it.

## Core capabilities

- **Architecture enforcement** — dependency and boundary rules across polyglot repositories.
- **Deterministic evidence** — 24 commands with versioned, byte-stable JSON; reproducible verdicts with coverage and provenance.
- **Governance** — waivers, ADRs, fitness functions and explicit decisions.
- **Architecture evolution** — drift, change impact, history, health and debt.
- **Agent integration** — CLI, MCP, VS Code and architecture-aware agent skills.

## Polyglot by design

Archkeep evaluates architecture across Go, Rust, Python, TypeScript/JavaScript, Vue, Java/Kotlin and C# repositories, while integrating with workspace systems such as Nx and Moon or discovering projects natively.

The goal is one architectural policy across language boundaries, not one enforcement mechanism per language.

## Quick start

```bash
pnpm add -D @ecoma-io/archkeep
```

Register Archkeep with Nx, use the native `archkeep.json` workspace discovery, or configure the integration appropriate for your repository.

Then run:

```bash
pnpm exec archkeep check
```

For an existing repository, start with discovery:

```bash
pnpm exec archkeep discover
```

**Node.js ≥ 22 is required. No language toolchain is required for static analysis.**

→ [Getting started](docs/getting-started/installation.md)

## A small example

Declare a rule such as:

```js
export const depConstraints = [
  {
    sourceTag: "layer:domain",
    onlyDependOnLibsWithTags: ["layer:domain"],
    description: "The domain outlives frameworks, queues and databases.",
  },
];
```

If a domain project imports infrastructure:

```text
libs/pricing/src/discount.go:14:2  onlyTagsConstraintViolation
  A project tagged with "layer:domain" can only depend on libs tagged with layer:domain
  import      "github.com/acme/mq-client/publish" (static)  pricing → mq-client
  constraint  sourceTag layer:domain → onlyDependOnLibsWithTags [layer:domain]
  rule        The domain outlives frameworks, queues and databases.
```

The important part is not only that the check fails. The verdict carries the evidence and points back to the architectural rule that caused it.

## Used in the Ecoma ecosystem

Archkeep is dogfooded by:

- [Loom](https://github.com/ecoma-io/loom)
- [Action-Agents](https://github.com/ecoma-io/action-agents)
- [Release-Craft](https://github.com/ecoma-io/release-craft)

## Documentation

- [Getting started](docs/getting-started/installation.md)
- [Architecture model](docs/doctrine/architecture-authority.md)
- [Governance lifecycle](docs/concepts/governance-lifecycle.md)
- [CLI reference](docs/reference/cli.md)
- [Integrations](docs/concepts/integrations.md)
- [Agent skills](docs/skills/overview.md)
- [Full documentation](docs/README.md)

## Contributing

The most valuable contribution is a [missed violation](.github/ISSUE_TEMPLATE/missed_violation.yml): a real architectural boundary that Archkeep failed to detect.

See [CONTRIBUTING.md](CONTRIBUTING.md), [Code of Conduct](CODE_OF_CONDUCT.md) and [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE)
