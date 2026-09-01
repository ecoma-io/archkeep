<p align="center">
  <img src=".github/assets/banner.png" alt="Archkeep — architecture governance for human and agentic software development: a deterministic authority that keeps the architecture your team declared aligned with the code your team keeps changing" width="100%" />
</p>

<h1 align="center">Archkeep</h1>

<p align="center">
  <strong>The contract between the architecture you intended and the code you actually have.</strong><br />
  Declare your architecture once — layers, scopes, allowed dependencies — and Archkeep judges
  every import in Go, Rust, Python, TypeScript and JavaScript, Vue, Java, Kotlin and C# against it: deterministic
  verdicts with evidence attached, in any repository, with or without Nx or Moon.<br />
  <em>An empty result is a claim, not a shrug.</em>
</p>

<p align="center">
  <a href="https://github.com/ecoma-io/archkeep/actions/workflows/ci.yml"><img src="https://github.com/ecoma-io/archkeep/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/ecoma-io/archkeep/actions/workflows/analysis.yml"><img src="https://github.com/ecoma-io/archkeep/actions/workflows/analysis.yml/badge.svg" alt="Analysis" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache 2.0" /></a>
  <a href="https://www.npmjs.com/package/@ecoma-io/archkeep"><img src="https://img.shields.io/npm/dm/@ecoma-io/archkeep.svg" alt="npm downloads per month" /></a>
</p>

<p align="center">
  <a href="#quick-start"><strong>Quick&nbsp;start&nbsp;→</strong></a> ·
  <a href="docs/doctrine/why.md">Why&nbsp;it&nbsp;exists</a> ·
  <a href="docs/doctrine/north-star.md">North&nbsp;star</a> ·
  <a href="docs/doctrine/roadmap.md">Roadmap</a> ·
  <a href="docs/README.md">Docs</a> ·
  <a href="https://ecoma.io">About&nbsp;Ecoma</a>
</p>

---

## Architecture doesn't break. It erodes.

Every repository starts with an architecture somebody can hold in their head.
The layers are obvious. The boundaries are obvious. The three engineers who
wrote the first services could recite them.

Then the team grows. Services become dozens of modules across four languages.
New people join, and the boundary rules — which module may know which, why
infrastructure must not leak into domain — exist as a feeling, a Slack thread,
a memory of a meeting. Nobody decided to lose them. They were never written
down anywhere the repository could see.

And then one day a change merges that crosses a line nobody remembers drawing.
The build passes. The tests pass. The feature works. Nothing in the pipeline
was ever asked.

**Recognize any of these?**

- **The rules live in a few people's heads.** The people who knew why this
  module cannot import that one have moved on. New engineers rediscover the
  boundaries by crossing them, one review comment at a time.
- **The diagram says one thing. The repository does another.** Architecture
  documentation describes the system as designed; the import graph is the
  system as merged. Nothing compares them, so nothing notices when they part
  ways.
- **Temporary exceptions become load-bearing.** An emergency dependency merges
  under deadline, to be cleaned up after launch. Six months later it is
  load-bearing, and no one can say whether it was ever a decision.
- **CI says something is wrong, rarely why it matters.** A rule fails — but
  which intended decision did it break? Is this exception intentional? How long
  has this violation been there? Without those answers, violations read as
  noise, and noise gets ignored.
- **Drift never announces itself.** No single dramatic event — each change is
  locally reasonable, and none of them alone is worth a meeting. By the time
  the coupling hurts, unwinding it is a quarter of work nobody budgeted.
- **Then coding agents multiply all of it.** Agents are not careless — they are
  fast and local. They optimize the task in front of them, and constraints that
  live in docs, reviews and heads are invisible to them. An agent can produce
  thousands of lines between two human reviews, each file sensible, some of it
  quietly crossing lines nobody ever encoded anywhere it could read.

None of this is a developer failure or an AI failure. It is structural:
**architectural intent was never an explicit, machine-checkable contract.**
People cannot hold a whole architecture in mind. Documents do not enforce.
Code review does not scale. Language linters see one language at a time.
Dependency tools draw the graph but carry no law about what the graph may do.
And the hand-written scripts teams bolt on to compensate rot quietly beside
the pipelines they police.

## The missing layer

What closes the gap is not another tool watching code. It is making intent
itself executable — an explicit contract between two things that today only
coincidentally agree:

```text
WHAT WE INTEND          declared once, reviewed like code
        ↕               ← this comparison is the missing layer
WHAT ACTUALLY EXISTS    read from every real import site
```

For that comparison to govern anything, it has to be:

- **explicit** — boundaries stated as declarations, not folklore
- **machine-readable** — consumable by CI, editors and agents without parsing prose
- **deterministic** — same tree, same config, same verdict; reviewable and reproducible
- **observable** — every result states what it inspected, because "no violations" means nothing if four files were analyzed instead of four hundred
- **enforceable** — exit codes a pipeline gates on, where _could not look_ never passes as _clean_
- **explainable** — verdicts cite the rule, the constraint row, the recorded decision behind them
- **evolvable** — drift, debt and history tracked, so exceptions stay decisions instead of decaying into accidents

That layer is what Archkeep implements.

## What Archkeep is

Archkeep is a deterministic architecture governance system for humans and
coding agents. You declare the architecture you intend; Archkeep reads what
your repository actually imports — statically, with none of those
languages' toolchains needed — and answers one question with a machine-computed
verdict:

> Does the code that exists agree with the architecture that was declared?

It is worth saying what Archkeep is **not**, because its neighbours each own
something else: not a linter (style and language rules stay with your linters),
not a dependency visualizer (it holds law, not just a picture), not an AI judge
(every verdict is computed, never guessed), not an Nx replacement (Nx and Moon
are providers of the project graph — a repository with neither still gets the
full verdict). [Architecture authority](docs/doctrine/architecture-authority.md)
owns that boundary.

## A governance lifecycle, not a lint run

Enforcement is one stage of what Archkeep does. The commands form a loop:

| Stage     | Question it answers                           | Commands                                                                                        |
| --------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Discover  | What architecture do we actually have?        | `discover` · `graph`                                                                            |
| Declare   | What architecture do we intend?               | the policy table · `architecture-intent.json`                                                   |
| Enforce   | Does this tree agree?                         | `check` · `fitness`                                                                             |
| Explain   | Why? Who depends on this? Since when?         | `explain` · `impact` · `context` · `adr` · `decisions` · `provenance`                           |
| Evolve    | Where is it drifting? What did a change cost? | `diff` · `delta` · `change` · `drift` · `history` · `trajectory` · `debt` · `health` · `report` |
| Reconcile | How do we close the gap — or accept it?       | `reconcile --propose` · `waivers`                                                               |

One line runs through all six stages: **proposals are never decisions.**
`discover --propose` and `reconcile --propose` derive candidate architectures
and candidate repairs from observation — marked as proposals, never written to
any file. Declaring and changing intent is a human act, done in files a pull
request reviews. `check` is the gate; most other commands describe, evidence,
and get out of the way. The whole lifecycle:
[governance lifecycle](docs/concepts/governance-lifecycle.md).

## Watch it work

Your declared intent — one file at the workspace root, in the shape
[`@nx/enforce-module-boundaries`](docs/concepts/policies.md) already speaks:

```js
// module-boundaries.config.mjs
export const depConstraints = [
  {
    sourceTag: "layer:domain",
    onlyDependOnLibsWithTags: ["layer:domain"],
    description: "The domain outlives frameworks, queues and databases.",
  },
];
```

A coding agent adds a convenient publisher call to the pricing engine. Code
compiles, tests pass, feature ships. Then:

```text
libs/pricing/src/discount.go:14:2  onlyTagsConstraintViolation
  A project tagged with "layer:domain" can only depend on libs tagged with layer:domain
  import      "github.com/acme/mq-client/publish" (static)  pricing -> mq-client
  constraint  sourceTag layer:domain, onlyDependOnLibsWithTags [layer:domain]
```

Four lines, four audiences: where it happened, the rule that fired (the same
message id ESLint reports), what is wrong, and — the line everything else
exists for — **which row of your declared policy said so**.

What happens next is governance, not just a red build:

- **It was intentional, for now** → record a waiver: a row with a mandatory
  reason and a deadline. The violation stays visible as _accepted_ — accepting
  a breach is a tracked decision, not a fix — and when the term lapses it
  re-asserts itself with `expired waiver` evidence. Permanent acceptance is a
  different row, and both are reviewed diffs, not inline comments.
- **A decision already grounds it** → the constraint row cites an ADR via
  `decisionRef`; a citation that resolves to nothing reports `unknown`, never
  clean.
- **It was drift** → delete the import. `delta` tells you exactly which
  violations a change introduced or resolved before you merge it; `impact`
  shows who depends on the module before you touch it.
- **It is debt you cannot pay yet** → `debt` ages it across snapshots so the
  bill stays on the books.

And when everything agrees, the answer still refuses to shrug:

```text
policy  module-boundaries.config.mjs — fingerprint 3f9c…

✔ no boundary violations (264 imports in 78 files across 12 projects)
```

Those counts are the point: "no violations" is a claim about coverage as much
as correctness.

## Where it sits among your tools

Every tool answers a different question, and they compose:

| Tool                        | Question                                                |
| --------------------------- | ------------------------------------------------------- |
| Compiler                    | Does it build?                                          |
| Tests                       | Does it behave?                                         |
| Linter                      | Does the code follow style and language rules?          |
| Security scanner            | Any known vulnerabilities?                              |
| Dependency analyzer         | How is everything connected?                            |
| **Architecture governance** | **Does the code conform to the architecture we chose?** |

Archkeep lives in the last row and replaces none of the others. If you run
`@nx/enforce-module-boundaries` today, keep it — point both enforcers at the
same constraint file and they answer from one table, with the same violation
ids ([how](docs/getting-started/first-policy.md)). Dependency analyzers draw your
graph; Archkeep is the law the graph is judged against.

## Built for humans and machines to share one authority

Agentic coding increases the rate at which architectural decisions get made;
humans cannot manually review every one. That is the project's founding thesis
([north star](docs/doctrine/north-star.md)) — and the answer is not giving the
agent judgment. It is giving every consumer the same deterministic authority:

```text
            your team
   declares intent · reviews · decides
                 │
                 ▼
        ┌─────────────────┐
        │    ARCHKEEP     │
        │ intent + graph  │
        │  deterministic  │
        │   evaluation    │
        └────────┬────────┘
                 │  verdict + evidence
      ┌──────────┼───────────┐
      ▼          ▼           ▼
     CI         IDE      coding agents
```

- **CI gates on it.** Four exit codes with a published contract — `0` clean,
  `1` findings, `2` usage, `3` could-not-look, and `3` fails the build too,
  because a checker that could not look must never be mistaken for one that
  found nothing. SARIF uploads straight into GitHub code scanning;
  [the recipe](docs/usage/ci.md).
- **Editors show it.** A language server publishes diagnostics in any LSP
  client, with the same invariant: an empty Problems panel means _no
  violation_, nothing else. The VS Code extension routes `.go`, `.rs`, `.py`
  and `.vue` to it and deliberately leaves TS/JS to your ESLint setup —
  [details](docs/integrations/vscode.md).
- **Agents consume it.** An MCP server exposes eight read-only tools — context
  before editing (`archkeep_context` hands an agent the governing constraints
  first), the authoritative check, impact, drift, explain, graph, history, and
  a proposal mode that carries `requiresApproval: true` because proposals are
  never decisions. There is no override anywhere: no tool accepts a weaker
  boundary config, so an agent cannot verify itself against a law of its own
  choosing. Five `arch-*` skills teach agents the protocol — read the
  constraints, change inside them, check, report evidence — and never modify
  policy to reach green. [MCP](docs/integrations/mcp.md) ·
  [skills](docs/skills/overview.md)

## Polyglot, because architecture is above language boundaries

A real system is a Go backend, a Rust service, a TypeScript frontend and a
Python worker — and it still has one architecture: domain boundaries, ownership
boundaries, dependency policies. Those should not need four enforcement
mechanisms that silently disagree.

Archkeep contributes polyglot edges into your project graph — Go, Rust,
Python, JVM and .NET manifests, plus the import sites every language writes —
so in an Nx workspace, `nx affected` finally sees polyglot dependents — and
judges source-level imports in all eight languages against one constraint
table.
Analysis is static
and self-contained: your lint-only CI job needs no Go, Cargo or uv installed.
Every analyzer's known parse limits are documented, and every limit errs toward
naming text the file really contains rather than staying silent —
[per language](docs/reference/languages.md).

## Capabilities

Grouped the way the [concepts](docs/concepts/architecture.md) own them:

- **Boundary enforcement** — the full `@nx/enforce-module-boundaries` model
  (all eight options, fifteen shared violation ids) extended beyond JavaScript;
  declared dependencies judged even without an import site; go.work drift and
  dead tsconfig path aliases checked alongside; custom rules compiled to
  sandboxed wasm — SDKs in Rust, Go, AssemblyScript and Python under one
  conformance contract ([custom rules](docs/concepts/custom-rules.md)).
- **Governance machinery** — waivers with deadlines and mandatory reasons,
  permanent suppressions, fitness functions (cycle-free graphs, coverage
  floors, suppression budgets…), constraints grounded in ADRs, named profiles,
  six shipped preset policy packs ([waivers](docs/concepts/waivers.md) ·
  [fitness functions](docs/concepts/fitness-functions.md)).
- **Deterministic evidence** — 24 commands with versioned, byte-stable JSON
  (a schema-versioned envelope), plus text and SARIF 2.1.0; a four-state
  verdict vocabulary where `unknown` demands a stated reason; coverage counts
  on every result; git provenance and a policy fingerprint naming the exact
  law that governed the run ([JSON output](docs/reference/json-output.md)).
- **Evolution tracking** — graph snapshots, structural diff, per-change delta
  with rule impact, declared-intent reconciliation (`change`), history,
  trajectory and evolution across snapshots or Git ranges, an aged debt ledger,
  health metrics that report `unknown` rather than zero, and one governance
  report tying it together ([report](docs/usage/report.md)).
- **Agentic development** — the MCP server, the five skills, plan-mode context
  for agents, and the proposal-only line between observing and deciding
  ([agentic development](docs/concepts/agentic-development.md)).
- **Any workspace shape** — an Nx plugin, a Moonrepo provider, or native
  discovery from an `archkeep.json` marker with neither installed
  ([configuration](docs/reference/configuration.md)).

## Quick start

```bash
npm install -D @ecoma-io/archkeep   # or pnpm / yarn / bun
```

Register the plugin in `nx.json`…

```jsonc
{
  "plugins": [
    {
      "plugin": "@ecoma-io/archkeep/nx",
      "options": {
        "boundaryConfig": "module-boundaries.config.mjs",
        "tsConfig": "tsconfig.base.json",
      },
    },
  ],
}
```

…or skip registration entirely: put an `archkeep.json` at the workspace root
and Archkeep discovers your projects itself. Then write one constraint row and
run the gate:

```bash
pnpm exec archkeep check
```

Node ≥ 22 required; no language toolchains needed. Ten minutes end to end,
most of it spent deciding what your tags mean —
[**Getting started →**](docs/getting-started/installation.md).
Bringing an existing repository under governance starts with
`archkeep discover`, not a blank page:
[the migration path](docs/usage/migration.md).

> **Coming from Lattice?** This is the same tool under a new name:
> [what breaks and what does not](docs/getting-started/upgrading-from-lattice.md).

## Documentation

Read it in this order, or jump to what you need:

|                                                                                                                                              |                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [Why it exists](docs/doctrine/why.md)                                                                                                        | The gap, with the measurement that proves it is real |
| [Getting started](docs/getting-started/installation.md)                                                                                      | Install, register, first policy, first violation     |
| [Boundaries](docs/concepts/boundaries.md) · [Policies](docs/concepts/policies.md)                                                            | The constraint model and its four dialects           |
| [Governance lifecycle](docs/concepts/governance-lifecycle.md)                                                                                | Why the commands form a system                       |
| [Drift](docs/concepts/drift.md) · [Waivers](docs/concepts/waivers.md) · [Health](docs/concepts/health.md)                                    | Intent vs reality, accepted exceptions, trends       |
| [Usage](docs/usage/checking.md) · [CI](docs/usage/ci.md)                                                                                     | Running it, gating on it, SARIF, exit codes          |
| [Reference](docs/reference/cli.md)                                                                                                           | Every command, flag, exit code, schema, parse limit  |
| [Nx](docs/integrations/nx.md) · [Moon](docs/integrations/moon.md) · [VS Code](docs/integrations/vscode.md) · [MCP](docs/integrations/mcp.md) | The integrations at the edge                         |
| [Agent skills](docs/skills/overview.md)                                                                                                      | The architecture-aware agent protocol                |
| [Development](docs/development/architecture.md)                                                                                              | For contributors: how it works inside                |

Full index: [**docs/**](docs/README.md).

## Real-world usage

Archkeep is actively dogfooded within the Ecoma ecosystem:

- **[ecoma-io/loom](https://github.com/ecoma-io/loom)** — a TypeScript/Vue monorepo using Moonrepo, where Archkeep enforces module-boundary constraints through `module-boundaries.config.mjs` and runs as part of `lint`, with mutation-based tests verifying violations are caught.
- **[ecoma-io/action-agents](https://github.com/ecoma-io/action-agents)** — a GitHub Actions and automation repository with a native workspace, where Archkeep validates project boundaries via `archkeep.json` and `module-boundaries.config.mjs`, and runs `archkeep check` as a blocking CI gate.

Both consume Archkeep as a pinned dependency.

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
