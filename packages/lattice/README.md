# Lattice

**Architecture governance for polyglot repositories** — a deterministic
authority that keeps the architecture your team declared aligned with the code
your team keeps changing. Dependency graphs and module boundaries for Go, Rust,
Python, TypeScript, JavaScript and Vue, with Nx and Moon as first-class
integrations. Coding agents read the same verdicts, machine-readably, through
the `arch-*` skills. The system boundary — what Lattice is and what it is not —
is owned by [architecture-authority.md](https://github.com/ecoma-io/lattice/blob/main/docs/doctrine/architecture-authority.md).

## Why it exists

ESLint reads JavaScript, TypeScript and Vue. In a polyglot repository, the
languages it cannot parse carry their `layer:` and `scope:` tags with **no
enforcer behind them**: a Go import that crosses a boundary passes lint, because
ESLint answers "File ignored because no matching configuration was supplied"
for `.go`. The dependency graph is silent the same way — `nx affected` only
knows a dependency exists when it is an edge in the project graph, and Nx infers
no edge for a Go import, a Cargo path dependency, or a `pyproject.toml` path
dependency. An under-selecting `affected` and an absent boundary rule look
exactly like a clean workspace, which is why the silence goes unnoticed (the
measurement: [why.md](https://github.com/ecoma-io/lattice/blob/main/docs/why.md)).

Lattice closes both gaps with one analysis, served three ways — a CLI
(`lattice check`), a language server (`lattice-lsp`), and an Nx plugin
(`@ecoma-io/lattice/nx`) — with the same verdict in each.

## It works in under a minute

```shell
npm install -D @ecoma-io/lattice
```

`lattice.json` at the repository root declares the projects and their tags —
the `coverage.exempt` row names the boundary law itself, which no project owns:

```json
{
  "projects": {
    "declared": [
      { "name": "billing-core", "root": "libs/billing/core", "tags": ["scope:billing"] },
      { "name": "shared-ui", "root": "libs/shared/ui", "tags": ["scope:shared"] }
    ]
  },
  "coverage": {
    "exempt": [
      {
        "path": "module-boundaries.config.mjs",
        "reason": "The boundary law, not owned by a project"
      }
    ]
  }
}
```

`module-boundaries.config.mjs` at the same root holds the constraint table —
the same shape `@nx/enforce-module-boundaries` takes, so one table feeds both
enforcers:

```js
export const depConstraints = [
  {
    sourceTag: "scope:billing",
    onlyDependOnLibsWithTags: ["scope:billing", "scope:shared"],
    description: "Billing services must not reach outside their scope",
    remediation: "Move the shared logic into a scope:shared library",
  },
];

export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
```

The import resolver reads the workspace's `tsconfig.base.json` for path
mappings, so `@shared/button` maps to the UI source:

```json
{
  "compilerOptions": {
    "paths": { "@shared/button": ["libs/shared/ui/src/button.ts"] }
  }
}
```

A `billing-core` file importing `@shared/button` is legal (the constraint
row allows it) — and had a `billing-core` file imported into a project tagged
outside `scope:billing` or `scope:shared`, the same constraint would be an
`onlyTagsConstraintViolation`, exit 1. Now check the tree:

```shell
lattice check
```

```text
policy  module-boundaries.config.mjs — fingerprint 3f9c…

✔ no boundary violations (1 import in 2 files across 2 projects; 1 file exempted from coverage by lattice.json's coverage.exempt)
```

A clean run states what it inspected — the import, file and project counts are
the load-bearing half, so "no violations" is a claim about coverage as much as
about correctness. The exempt suffix names the boundary law itself, which is
not owned by any project.

The import resolver uses the workspace's own `typescript` (a peer dependency,
resolved from your tree, never bundled). A TypeScript-free Go/Rust/Python
workspace pays nothing: resolution keys off the manifests that exist.

## Who it is for

**Human teams** run `lattice check` in CI and gate on its exit code. The verdict
is deterministic and evidence-based: same tree, same config, same answer — no
machine-specific toolchain result, no model in the loop, and every verdict names
what it inspected beside what it found
([exit-codes.md](https://github.com/ecoma-io/lattice/blob/main/docs/reference/exit-codes.md)).

**Coding agents** read the same authority through the four `arch-*` skills —
`arch-context` before an edit, `arch-change` during, `arch-check` after, and
`arch-review` on a change or PR. The agent is a consumer of the verdict, never
its authority: the commands it runs are read-only, and the constraint table is
a file it cannot edit ([overview.md](https://github.com/ecoma-io/lattice/blob/main/docs/skills/overview.md)).

## What it does

- **Deterministic graph** — a project graph from any provider: Nx, Moon, or the
  native discovery that needs neither
  ([graph.md](https://github.com/ecoma-io/lattice/blob/main/docs/concepts/graph.md)).
- **Boundary check** — every import judged against the constraint table, with
  `file:line:column` evidence for each violation
  ([violations.md](https://github.com/ecoma-io/lattice/blob/main/docs/reference/violations.md)).
- **Drift and intent** — a tracked `architecture-intent.json` declares what the
  architecture must be; `drift` and `check` compare the observed graph against
  it, and an unverifiable intent is a no-verdict, never a pass
  ([drift.md](https://github.com/ecoma-io/lattice/blob/main/docs/concepts/drift.md)).
- **Evolution** — `graph` snapshots the architecture, `diff` compares two
  snapshots, `history` describes the evolution across a directory of them
  ([diff.md](https://github.com/ecoma-io/lattice/blob/main/docs/usage/diff.md)).
- **Waivers, profiles, fitness, ADR** — term-bound waivers, named law profiles
  selected at check time, declared quality gates judged per run, and recorded
  architecture decisions a constraint row can lean on
  ([waivers.md](https://github.com/ecoma-io/lattice/blob/main/docs/concepts/waivers.md) ·
  [profiles.md](https://github.com/ecoma-io/lattice/blob/main/docs/concepts/profiles.md) ·
  [fitness-functions.md](https://github.com/ecoma-io/lattice/blob/main/docs/concepts/fitness-functions.md) ·
  [adr.md](https://github.com/ecoma-io/lattice/blob/main/docs/concepts/adr.md)).
- **Machine-readable JSON** — `--format json` wraps any verdict in a versioned
  envelope (`schemaVersion`, `status`, `exitCode`, `coverage`); every field
  name is a public contract
  ([json-output.md](https://github.com/ecoma-io/lattice/blob/main/docs/reference/json-output.md)).
- **Language server** — `lattice-lsp` publishes one diagnostic per violation in
  any LSP client; an empty diagnostic list means "no violation", nothing else
  ([vscode.md](https://github.com/ecoma-io/lattice/blob/main/docs/integrations/vscode.md)).

## Support

- **Languages** — Go, Rust, Python, TypeScript and JavaScript, and Vue. Analysis
  from source, never a build: nothing shells out to `go`, `cargo`, `uv` or `tsc`
  ([languages.md](https://github.com/ecoma-io/lattice/blob/main/docs/reference/languages.md)).
- **Workspaces** — any repository: Nx registers the plugin in `nx.json` and
  reuses Nx's project graph; Moon workspaces are recognised automatically; any
  other tree uses `lattice.json` and the native provider
  ([nx.md](https://github.com/ecoma-io/lattice/blob/main/docs/integrations/nx.md) ·
  [moon.md](https://github.com/ecoma-io/lattice/blob/main/docs/integrations/moon.md)).
- **Agents** — Claude Code, Codex and opencode run the `arch-*` skills, which
  are host-independent ([supported-hosts.md](https://github.com/ecoma-io/lattice/blob/main/docs/skills/supported-hosts.md)).

## Install and quick start

`npm install -D @ecoma-io/lattice` (or pnpm / yarn / bun), create
`lattice.json` and `module-boundaries.config.mjs` as above, then `lattice check`.

In CI, both findings (1) and "no verdict" (3) must fail the build — the
distinction is the point. `lattice check || true` is wrong: it turns "could
not look" into "looked and found nothing". Distinguish explicitly:

```shell
lattice check
case $? in
  0) echo "clean" ;;
  1) echo "boundary violations"; exit 1 ;;
  3) echo "the checker could not reach a verdict"; exit 1 ;;
  *) echo "usage error"; exit 1 ;;
esac
```

Exit codes: 0 clean — and every selected file was analyzed; 1 findings;
2 usage error; 3 no verdict
([exit-codes.md](https://github.com/ecoma-io/lattice/blob/main/docs/reference/exit-codes.md) ·
[ci.md](https://github.com/ecoma-io/lattice/blob/main/docs/usage/ci.md)).

Ten minutes end to end, most of it spent deciding what your tags mean:
[**Getting started →**](https://github.com/ecoma-io/lattice/blob/main/docs/getting-started/installation.md). `graph`, `diff`,
`history`, `drift`, `impact`, `explain`, `context` and the rest of the
sixteen-command surface are in the [CLI reference](https://github.com/ecoma-io/lattice/blob/main/docs/reference/cli.md).

## Documentation map

| Topic           | Read                                                                                                                                                                                                                                                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Getting started | [Installation](https://github.com/ecoma-io/lattice/blob/main/docs/getting-started/installation.md) → [first project](https://github.com/ecoma-io/lattice/blob/main/docs/getting-started/first-project.md) → [first policy](https://github.com/ecoma-io/lattice/blob/main/docs/getting-started/first-policy.md)                                                                |
| Concepts        | [The engine](https://github.com/ecoma-io/lattice/blob/main/docs/concepts/architecture.md) · [boundaries](https://github.com/ecoma-io/lattice/blob/main/docs/concepts/boundaries.md) · [drift](https://github.com/ecoma-io/lattice/blob/main/docs/concepts/drift.md) · [intent](https://github.com/ecoma-io/lattice/blob/main/docs/reference/architecture-intent.md)           |
| Reference       | [CLI and flags](https://github.com/ecoma-io/lattice/blob/main/docs/reference/cli.md) · [configuration](https://github.com/ecoma-io/lattice/blob/main/docs/reference/configuration.md) · [exit codes](https://github.com/ecoma-io/lattice/blob/main/docs/reference/exit-codes.md) · [JSON output](https://github.com/ecoma-io/lattice/blob/main/docs/reference/json-output.md) |
| Using it        | [Checking](https://github.com/ecoma-io/lattice/blob/main/docs/usage/checking.md) · [CI](https://github.com/ecoma-io/lattice/blob/main/docs/usage/ci.md) · [troubleshooting](https://github.com/ecoma-io/lattice/blob/main/docs/usage/troubleshooting.md)                                                                                                                      |
| Agents          | [The `arch-*` protocol](https://github.com/ecoma-io/lattice/blob/main/docs/skills/overview.md)                                                                                                                                                                                                                                                                                |
| Building on it  | [Architecture](https://github.com/ecoma-io/lattice/blob/main/docs/development/architecture.md) · [contributing](https://github.com/ecoma-io/lattice/blob/main/CONTRIBUTING.md)                                                                                                                                                                                                |

## Status and deliberate limits

CI proves both halves run on this repository's own source — the same `check`
command runs against this tree's tag vocabulary, which shares nothing with the
workspace the tool was written against.

Three refusals, by design (full list:
[architecture-authority.md](https://github.com/ecoma-io/lattice/blob/main/docs/doctrine/architecture-authority.md)):

- **It never infers targets.** Projects and targets stay hand-written in each
  `project.json`; this tool adds the missing dependency edges only, so what a
  target does has one source of truth. (The one derivation the Moon provider
  performs — inferring the workspace layout's `libsDir`/`appsDir` prefixes from
  project root paths — is about where source lives, never what a target runs.)
- **It never shells out.** Resolvers read only tracked manifest and source
  files, so the graph computes on a lint-only CI runner with no Go, Cargo or uv
  installed.
- **There is no language off-switch.** Every report of a disabled language
  would be byte-for-byte identical to that language having no violations, and
  each analyzer already costs nothing in a workspace without that language.

## License

[Apache License 2.0](https://github.com/ecoma-io/lattice/blob/main/LICENSE) — © Mai Ngọc Hóa (John Martin) and the
Lattice contributors. This README ships inside the tarball; the
repository-level landing page with the full capability index is
[`README.md`](https://github.com/ecoma-io/lattice).
