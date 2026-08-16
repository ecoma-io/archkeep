# Checking boundaries

Run the boundary law against the workspace.

```shell
pnpm exec lattice check
```

A clean tree prints what it inspected, not just that it found nothing:

```text
✔ no boundary violations (264 imports in 78 files across 12 projects)
```

Those counts are the point. "No violations" is a claim about coverage as much
as correctness, and a run that analyzed four files would otherwise look
identical to one that analyzed four hundred.

## What `check` judges

One run combines four verdicts:

1. **Import boundaries** — every import site in every tracked, supported source
   file is matched against the boundary law.
2. **`go.work` drift** — when a tracked `go.work` exists at the root, its `use`
   list is compared against every project's `go.mod`.
3. **Dead tsconfig aliases** — when the workspace tsconfig declares a `paths`
   table, each alias is checked for at least one target directory that exists.
4. **Architecture drift** — when the workspace declares an intended architecture
   (`architecture-intent.config.mjs` at the root, or whatever `intentConfig`
   names), the observed graph is judged against it: a required project that
   vanished, a forbidden one that appeared, or an edge that crosses the declared
   dependency/tag law is a finding. See [drift.md](drift.md).

The three workspace facts (2, 3, 4) are judged against the whole tree, so paths
named on the command line do not scope them. The drift check is folded by the
intent file's presence — no flag, so a workspace without an intent file pays
nothing and hears nothing.

## A violation

```text
apps/checkout-api/internal/handler/pay.go:14:2  onlyTagsConstraintViolation
  A project tagged with "scope:checkout" can only depend on libs tagged with scope:checkout, scope:shared
  import      "github.com/acme/billing-core/ledger" (static)  checkout-api → billing-core
  constraint  sourceTag scope:checkout, onlyDependOnLibsWithTags [scope:checkout, scope:shared]
```

Four things, each with a reader in mind: the `file:line:column` your terminal
turns into a link, the `messageId`, what is wrong, and **which row of the config
said so** — because that is the line a fix has to agree with.

The full catalogue of message ids and what resolves each one is in
[violations.md](../reference/violations.md). To inspect one site's full judgment — including
the tags and every matching constraint row — use
[`lattice explain`](explain.md). To see which constraints apply to a project
before editing it, use [`lattice context`](context.md).

## Scoped runs

Name paths after `check` to narrow source analysis:

```shell
lattice check apps/payments libs/ledger/src/lib.rs
```

A path outside the workspace is a usage error, not a silent empty selection.

A scoped run is a fast local pre-check and **not the gate**: cycle and lazy-load
rules judge the file graph as a whole, so a scoped run can miss what a
whole-workspace run would find. CI should always run `lattice check` with no
paths.

## Formats

### Text

```shell
lattice check
lattice check --output report.txt
```

The default. `file:line:column` positions are terminal-linkable.

### SARIF

```shell
lattice check --format sarif --output lattice.sarif
```

SARIF 2.1.0 for GitHub code scanning. [ci.md](ci.md) shows the upload step.

### JSON

```shell
lattice check --format json
lattice check --format json --output report.json
```

A deterministic, versioned envelope for scripts. The schema and stability
promise are in [json-output.md](../reference/json-output.md).

## Exit codes

| code | meaning                                                                         |
| ---- | ------------------------------------------------------------------------------- |
| `0`  | No findings, and every selected file was analyzed                               |
| `1`  | Boundary violation, `go.work` drift, dead tsconfig alias, or architecture drift |
| `2`  | Usage error — invalid arguments, unknown flag, or path outside the workspace    |
| `3`  | No verdict — the run could not look, or coverage is incomplete                  |

Do not collapse 3 into 0. A checker that could not look must never be mistaken
for one that looked and found nothing. [ci.md](ci.md) owns the full automation
contract.

## Override the policy for one run

```shell
lattice check --config proposed-boundaries.mjs
```

The file is resolved from the workspace root. It changes the boundary law, not
the workspace root or provider. This is useful when reviewing a proposed policy
without replacing the workspace's current one.
