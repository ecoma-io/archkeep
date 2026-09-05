<p align="center">
  <img src=".github/assets/banner.png" alt="Archkeep — an architecture authority for human and agentic software development: a deterministic authority that keeps the architecture your team declared aligned with the code your team keeps changing" width="100%" />
</p>

<h1 align="center">Archkeep</h1>

<p align="center">
  <strong>An architecture authority for human and agentic software development.</strong><br />
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
  <a href="#in-30-seconds"><strong>In&nbsp;30&nbsp;seconds&nbsp;→</strong></a> ·
  <a href="docs/doctrine/why.md">Why&nbsp;it&nbsp;exists</a> ·
  <a href="docs/doctrine/architecture-authority.md">The&nbsp;authority&nbsp;model</a> ·
  <a href="docs/doctrine/roadmap.md">Roadmap</a> ·
  <a href="docs/README.md">Docs</a> ·
  <a href="https://ecoma.io">About&nbsp;Ecoma</a>
</p>

---

## In 30 seconds

- **What it is.** An **architecture authority** — the system a repository consults to learn whether
  the code that exists agrees with the architecture the team declared. Not a linter, not a
  dependency-graph viewer, not an AI reviewer: a deterministic authority that keeps the intended
  architecture and the observed one from quietly parting ways.
- **The problem.** Declared architecture lives in heads, docs and Slack threads; the repository's
  real architecture lives in its imports. Nothing compares the two — until a change crosses a line
  nobody encoded anywhere, and the build stays green. Coding agents multiply the rate at which this
  happens.
- **The mechanism.** You declare intent as reviewed files. Archkeep reads every import site
  statically, computes evidence (graphs, coverage counts, provenance), and one command — `check` —
  issues the authoritative verdict. Same tree, same config, same verdict.
- **Why agents care.** Humans, CI and coding agents consume the **same** authority: agents read the
  governing constraints before editing, verify with `check`, and cannot weaken the law or accept
  their own proposals — there is no override anywhere.
- **Where it runs.** An Nx plugin, a Moonrepo provider, or bare `archkeep.json` discovery — the
  verdict does not change with the provider. Eight languages, analyzed statically; your lint-only
  CI needs no Go, Cargo, uv, JDK or .NET installed.

```bash
npm install -D @ecoma-io/archkeep && npx archkeep check
```

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

## The mental model

Archkeep turns architecture from something people remember into something the
repository can compute. One chain, six links:

```text
ARCHITECTURE INTENT      declared once, reviewed like code
        ↓
OBSERVED REALITY         every real import site, read statically
        ↓
DETERMINISTIC EVIDENCE   graphs, coverage counts, provenance — reproducible
        ↓
RECONCILIATION           the gap between intent and reality, element by element
        ↓
ENFORCEMENT              one authority issues the verdict
        ↓
HUMAN + CODING AGENT     CI gates on it, editors show it, agents act on it
```

The words are kept precise, because loose synonyms are where governance
decays ([the full model](docs/doctrine/architecture-authority.md)):

- **Intent** — the declared, normative architecture: boundary policy and
  `architecture-intent.json`, reviewed like code.
- **Reality** — the architecture the repository actually has, read from its
  sources and manifests.
- **Evidence** — a reproducible fact about that reality: a graph snapshot, a
  coverage count, a provenance record.
- **Verdict** — the deterministic, authoritative result of judging reality
  against intent.
- **Prediction, proposal, judgment** — a statement about the future, a possible
  change, a heuristic output. Never a verdict; all three are marked as such
  wherever Archkeep produces them.
- **Decision** — a governance record: a waiver accepted, an ADR cited, an
  intent row changed. Made by humans, in reviewed diffs.
- **Waiver** — an explicit, expiring exception to intent. Accepting a breach is
  a tracked decision, not a shrug.

For the chain to govern anything, it has to be:

- **explicit** — boundaries stated as declarations, not folklore
- **machine-readable** — consumable by CI, editors and agents without parsing prose
- **deterministic** — same tree, same config, same verdict; reviewable and reproducible
- **observable** — every result states what it inspected, because "no violations" means nothing if four files were analyzed instead of four hundred
- **enforceable** — exit codes a pipeline gates on, where _could not look_ never passes as _clean_
- **explainable** — verdicts cite the rule, the constraint row, the recorded decision behind them
- **evolvable** — drift, debt and history tracked, so exceptions stay decisions instead of decaying into accidents

## What Archkeep is

Archkeep is a deterministic architecture governance system for humans and
coding agents. You declare the architecture you intend; Archkeep reads what
your repository actually imports — statically, with none of those
languages' toolchains needed — and answers one question with a machine-computed
verdict:

> Does the code that exists agree with the architecture that was declared?

And the same question in the form agentic development makes urgent:

> When a coding agent changes a repository, how does the system **deterministically verify** that
> the change still conforms to the architecture the team declared?

It is worth saying what Archkeep is **not**, because its neighbours each own
something else: not a linter (style and language rules stay with your linters),
not a dependency visualizer (it holds law, not just a picture), not an AI judge
(every verdict is computed, never guessed), not an Nx replacement (Nx and Moon
are providers of the project graph — a repository with neither still gets the
full verdict). [Architecture authority](docs/doctrine/architecture-authority.md)
owns that boundary.

## One enforcement authority

Every surface Archkeep exposes produces evidence, records, or a verdict — and
exactly one of them decides:

| Surface                                                                                                                                                                                                      | What it answers                                         | Authoritative?                                      | Output                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | --------------------------------------------------- | --------------------------------- |
| `check`                                                                                                                                                                                                      | Does this tree conform to the declared law?             | **Yes — the enforcement authority**                 | verdict + exit code (0 / 1 / 3)   |
| `fitness`                                                                                                                                                                                                    | Do the workspace's own declared predicates hold?        | a verdict on its own question, under the same law   | failing function exits 1          |
| `delta`, `change`                                                                                                                                                                                            | Did this change introduce violations, break its intent? | verdicts on the change, judged against the same law | classified delta · reconciliation |
| `rules verify`                                                                                                                                                                                               | Are the shipped rule artifacts what they claim?         | a verdict on catalog integrity                      | digest-level verification         |
| `graph`, `diff`, `drift`, `history`, `trajectory`, `evolution`, `health`, `debt`, `report`, `impact`, `explain`, `context`, `provenance`, `adr`, `decisions`, `waivers`, `discover`, `reconcile`, `scenario` | evidence, analysis, governance records, projections     | descriptive — they inform, they never gate          | findings without the exit code    |

`check` is the gate, and the only command holding all four exit codes.
`fitness`, `delta`, `change` and `rules verify` are verdict-carriers on their
own questions — a failing fitness function, a non-waived introduced violation,
an unfulfilled change declaration, a rule artifact that fails integrity — and
they answer under the same verdict vocabulary and exit table
([exit codes](docs/reference/exit-codes.md)). Every other command describes,
evidences, and gets out of the way. The asymmetry is the design: **analysis is
everywhere; authority is in one place.**

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
| Build system                | What changed, and what does it affect?                  |
| AI code reviewer            | Does a model think this change looks reasonable?        |
| **Architecture governance** | **Does the code conform to the architecture we chose?** |

Archkeep lives in the last row and replaces none of the others — and the two
newest neighbours deserve the boundary made explicit. A **build system** computes
what changed; it does not hold a law about what may depend on what, and `nx
affected` is silent about Go, Rust and Python edges until a provider supplies
them. An **AI code reviewer** produces a per-change judgment: useful, and
heuristic by nature — it may differ between runs, and it cannot be the thing a
pipeline gates on. Archkeep's verdict is deterministic, reproducible and
evidence-backed; reviewers and agents may explain and propose, and the verdict
stays computed.

If you run `@nx/enforce-module-boundaries` today, keep it — point both
enforcers at the same constraint file and they answer from one table, with the
same violation ids ([how](docs/getting-started/first-policy.md)). Dependency
analyzers draw your graph; Archkeep is the law the graph is judged against.

## Agentic development: the same authority, no shortcuts

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

An agent's change travels the same chain a human's does:

1. **Declare** — the team states intent in files a pull request reviews.
2. **Context** — before editing, the agent reads the constraints that govern
   the target project: `archkeep_context` over MCP, `archkeep context --plan`
   over the CLI, or the `arch-context` skill.
3. **Change** — the agent edits code inside those constraints.
4. **Observe** — the engine reads every import site the change touched,
   statically.
5. **Evidence** — the agent inspects the judgment: `explain` for why one site
   was judged as it was, `impact` for who depends on what it touched, `delta`
   for what its change moved.
6. **Decide** — `check` issues the authoritative verdict. The agent iterates on
   findings; it does not argue with them.
7. **Enforce** — CI runs the same `check` on the same tree. The merge is gated
   by the same authority the agent answered to, not by the agent's
   self-report.

The red line is structural, not aspirational: **an agent may not redefine the
architecture when its code disagrees with it.** There is no override anywhere —
no MCP tool accepts a weaker boundary config; `archkeep_propose` carries
`requiresApproval: true` and drafts candidates, never decisions; changing
intent happens in files a human reviews.

The agent-facing surfaces: an [MCP server](docs/integrations/mcp.md) exposing
nine read-only tools (`archkeep_context`, `archkeep_check`,
`archkeep_impact`, `archkeep_drift`, `archkeep_explain`, `archkeep_graph`,
`archkeep_history`, `archkeep_propose`, `archkeep_scenario`) — every tool calls
the engine's own command layer in process, so an agent sees the same envelope a
pipeline sees. Five [`arch-*` skills](docs/skills/overview.md) teach the
protocol — read the constraints, change inside them, check, report evidence.
A [language server](docs/integrations/vscode.md) publishes the same verdicts
into editors, with the same invariant: an empty Problems panel means _no
violation_, nothing else.

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

## A verdict that refuses to shrug

The dangerous failure is not a false alarm — it is the quiet one: reporting
nothing when a violation exists, byte-for-byte identical to a clean workspace.
Archkeep is built so that cannot pass silently:

- **Coverage rides with every verdict.** Every result states what it inspected
  — imports, files, projects — because "no violations" is a claim about
  coverage too.
- **`ok` means analyzed, not merely quiet.** `status: "ok"` is refused unless
  coverage is complete — a file the analyzer never reached a verdict about
  makes `ok` unreachable, enforced in the envelope builder itself, not just
  documented.
- **Could-not-look is its own exit code.** `0` clean, `1` findings, `2` usage
  error, `3` no verdict — and `3` fails the build too, because a checker that
  could not look must never be mistaken for one that found nothing
  ([the contract](docs/reference/exit-codes.md)).
- **Unknown is a first-class answer.** The four-state verdict vocabulary —
  `pass`, `fail`, `unknown`, `not_applicable` — makes "I could not determine"
  sayable, and an `unknown` must state its reason.
- **Known blind spots are declared, not hidden.** Site-level unknowables
  (dynamic imports with non-literal arguments, unresolvable package imports)
  are reported as blind spots; coverage the run knows it did not provide is
  reported as gaps, each with its kind — never folded into a clean result.

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

## Evidence, not promises

The claims above are kept narrow on purpose: **deterministic, reproducible,
evidence-backed** — not "formally verified", and not "proven correct". What
backs them is a test architecture that attacks the failure modes a governance
tool actually has:

- **The differential against the real thing.** The reimplementation of
  `@nx/enforce-module-boundaries` runs side by side with the real ESLint rule
  over **48 fixture workspaces, 125 probes, 100 projects**; every one of
  upstream's fifteen violation ids is triggered by at least one probe, and a
  probe where this tool is weaker than upstream is a defect by definition. Five
  pinned public workspaces nobody here built run through the same differential
  on a schedule ([how it works](docs/development/testing.md)).
- **The installed artifact is what gets tested.** The end-to-end suite runs the
  CLI from `pnpm pack` tarballs installed into throwaway workspaces — the
  plugin drawing an edge Nx cannot infer, the exit contract holding in both
  directions, the language server answering through an installed plugin's
  symlinked path.
- **The provider cannot change the verdict.** The same tree modelled twice —
  real `nx graph` versus native `archkeep.json` — is asserted to yield
  identical nodes, edges and verdicts, so `check` does not depend on which
  provider ran.
- **Determinism is swept, not hoped for.** Every array in every command's JSON
  envelope is sorted; integration and end-to-end suites assert two runs over an
  unchanged tree are byte-identical.
- **Every command's exit contract is driven from both sides.** An exit-code
  matrix runs all 24 commands on their findings side and their clean side, with
  a roster guard that fails the suite when a command ships without a decided
  contract.
- **Irrelevant edits cannot move the facts.** Metamorphic tests assert that
  comments, blank lines, renames and import reordering produce zero record
  changes and zero graph delta.
- **The empty-result invariant is attacked directly.** Dedicated suites drive
  the paths that could return nothing — unreadable files, unloaded analyzers,
  unresolved imports — and require each to report loudly instead.

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

## Status and roadmap

Archkeep ships today on the **0.x line**
([`@ecoma-io/archkeep`](https://www.npmjs.com/package/@ecoma-io/archkeep));
until 1.0, a minor release may carry a behavior change, named in the
changelog.

The [roadmap](docs/doctrine/roadmap.md) is a **maturity model, not a feature
list**: five phases — **Authority** (deterministic enforcement), **Evidence**
(canonical architecture state), **Governance** (decisions, waivers, ADRs — on
the authority, never beside it), **Change Intelligence** (impact, scenarios,
advisory reasoning over evidence) and **Agentic Architecture** (agents as
consumers of the same authority) — each with explicit exit criteria and the
evidence that must back it.

**1.0 is a trustworthiness milestone, not a feature count**: the point where
the authority core is hardened enough — deterministic, reproducible,
coverage-explicit, provider-independent, conformance-proven — to be trusted
with a stability promise. The intelligence capabilities of the later phases
(architectural impact analysis, scenario evaluation, the evidence-grounded
advisor) are documented direction, not shipped capability; the deterministic
`scenario` command ships today as a read-only what-if, marked `virtual` and
`notAuthoritative`. There is no second line and no next generation: every
phase lands on `main`, on the same authority contract.

## Documentation

Read it in this order, or jump to what you need:

|                                                                                                                                              |                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [Why it exists](docs/doctrine/why.md)                                                                                                        | The gap, with the measurement that proves it is real |
| [The authority model](docs/doctrine/architecture-authority.md)                                                                               | Intent, reality, evidence — and the boundary         |
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
