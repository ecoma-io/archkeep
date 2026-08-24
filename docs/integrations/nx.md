# Nx integration

Archkeep's Nx integration is the one surface with no user interface of its own,
and the one everything else depends on being cheap. It runs on every `nx`
invocation, contributes polyglot dependency edges into the project graph, and
makes those edges visible to `nx affected` and to the boundary rules.

What it does **not** do is re-infer what Nx already knows. TypeScript and
JavaScript edges are Nx's own — Archkeep adds Go, Rust and Python, and leaves
the rest alone ([north-star.md](../doctrine/north-star.md): _TypeScript and
JavaScript stay with `@nx/eslint-plugin`_).

## What the integration provides

| surface              | what it gives you                                                                       |
| -------------------- | --------------------------------------------------------------------------------------- |
| Project graph edges  | Go, Rust and Python dependencies between Nx projects, contributed at graph time         |
| `nx affected`        | Polyglot edges make `nx affected` mark dependents of changed Go/Rust/Python code        |
| Boundary enforcement | The same constraint table that `@nx/enforce-module-boundaries` uses, for every language |
| `workspaceLayout`    | The plugin carries `nx.json`'s own `workspaceLayout` into the engine                    |

Edges come from manifests; verdicts come from sources. That split is the
architecture's central seam —
[architecture.md](../development/architecture.md) owns the full flow.

## Plugin registration

In `nx.json`:

```json
{
  "plugins": ["@ecoma-io/archkeep/nx"]
}
```

The `/nx` subpath is not optional. It is the one module Nx is allowed to load,
reached through the package's `exports` map. The bare package name
(`"@ecoma-io/archkeep"`) resolves to the engine entry instead — see
_The misregistration guard_ below.

If your workspace renamed either file the plugin reads, say so:

```json
{
  "plugins": [
    {
      "plugin": "@ecoma-io/archkeep/nx",
      "options": {
        "boundaryConfig": "module-boundaries.config.mjs",
        "tsConfig": "tsconfig.base.json"
      }
    }
  ]
}
```

Those two values are the defaults. An unknown key **throws** rather than
falling back — a `tsconfigBase` typed for `tsConfig` that quietly used the
default would give you a full green run against a rule nobody wrote. A
`profiles` option switches `boundaryConfig` from a filename to a profile name
(`docs/concepts/profiles.md` owns that switch and the loud failures it adds).
A workspace that names one is enforced by profile, and the editor refuses the
workspace loudly rather than reading a name as a file.

Confirm the plugin loaded:

```shell
pnpm exec nx graph --file=graph.json
```

A Go project that imports a sibling's module path should now show that sibling
in its dependencies.

## How the plugin loads

Nx loads `./nx` (`packages/archkeep/nx.mjs`) on every graph computation,
including on machines running a single unrelated target. That is why the file
holds no logic — it re-exports `createDependencies` and `name` from
`src/graph/create-dependencies.mjs`, and nothing else. What it imports is what
every `nx` invocation pays for, so the rule engine, the CLI and the language
server grow under `src/` without being dragged into Nx's own startup path.

```js
// nx.mjs — the entire file
export {
  createDependencies,
  resolvePolyglotDependencies,
} from "./src/graph/create-dependencies.mjs";
export const name = "archkeep";
```

`createDependencies` is the hook Nx calls. It validates the options (so a
typo'd key fails at the first graph computation, not at some later CLI run) and
then resolves polyglot edges from language manifests. The options themselves are
not used during edge resolution — manifest names are fixed external contracts,
not configurable values — but validating them here is what makes a misspelling
loud immediately.

## Options

Three options; the first two are Nx conventions a workspace may rename, the
third opts a workspace into named-law selection.

| option           | default                        | what it names                                                               |
| ---------------- | ------------------------------ | --------------------------------------------------------------------------- |
| `boundaryConfig` | `module-boundaries.config.mjs` | The file holding the constraint table — or, with `profiles`, a profile name |
| `tsConfig`       | `tsconfig.base.json`           | The shared TypeScript config for path resolution                            |
| `profiles`       | absent                         | The profile registry file, when the workspace enforces by profile name      |

### Three consumers, three routes

The same options table is read by three faces, each through a different route.
The differences are load-bearing —
`packages/archkeep/AGENTS.md`'s
"The three consumers of the options" owns the full detail.

| consumer                           | how it reads the options                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| The Nx hook (`createDependencies`) | `options` parameter from Nx directly; never reads `nx.json`                           |
| The CLI (`cli.mjs`)                | `readPluginOptions(workspaceRoot)`; `--config` overrides `boundaryConfig` for one run |
| The language server                | `readPluginOptions` at `initialize` and on every invalidation                         |

An unknown key throws at every one of those three doors.

### What is deliberately not an option

There is no `languages` option. Switching a language off is indistinguishable
in every report from that language having no violations — which is the exact
silence this tool exists to refuse. A workspace with no Go pays nothing for Go
support already: each resolver keys off the manifests that exist, finds none,
and does nothing. See
`packages/archkeep/src/options.mjs`
for the full argument.

## readProjectGraph

The CLI and the language server need the full project graph — not just the
polyglot edges the plugin contributes, but every node and edge Nx knows about.
They get it through `readProjectGraph`, which spawns the Nx CLI rather than
importing Nx directly:

```shell
node <nxCli> graph --file=/tmp/archkeep-XXXXX/graph.json
```

`nx graph --file=` is a stable, documented surface. The package resolves the
`nx` CLI from the workspace's own installation — it is a peer dependency, so
what that resolution finds is the copy the consumer installed, never a second
one bundled in here. A tool that shipped its own Nx could report a graph the
workspace's own CLI disagrees with.

The command emits `{ graph: { nodes, dependencies } }` and no
`externalNodes` — external packages are synthesised from analysis records
instead, which is what makes `bannedExternalImports` reachable for crates and
Go modules at all. The command also emits no `workspaceLayout`, so
`readProjectGraph` reads that key from `nx.json` separately and merges it onto
the graph before returning; without this, a workspace with a custom `libsDir`
would be judged against Nx's default layout instead of the one it declared.

## affected integration

`nx affected` decides what to rebuild or retest by walking the project graph's
dependency edges. Nx already infers TypeScript and JavaScript edges from
imports, so a change to a TypeScript or JavaScript library correctly marks its
consumers affected. For Go, Rust and Python, that inference does not exist — the
edges are absent, and `nx affected` silently under-selects.

Archkeep's plugin fills that gap. A Go project importing a sibling's module path,
a Rust crate with a `path` dependency, a Python package wired through
`[tool.uv.sources]` — each becomes a graph edge at computation time, and
`nx affected` works the same way it does for TypeScript and JavaScript.

The boundary check catches violations that `nx affected` never will: an
undeclared Python import that works at runtime, for example, crosses the
boundary while drawing no graph edge. Edges and analysis answer different
questions, and both stay —
[languages.md](../reference/languages.md) owns that distinction per language.

## workspaceLayout

`nx.json` carries a top-level `workspaceLayout` field (`{ appsDir, libsDir }`)
that some workspaces set to non-default values. The plugin reads it from there
directly — not from `plugins[].options`, but from `nx.json`'s own key — and
carries it into the engine. A workspace with a custom `libsDir`/`appsDir` does
not need to repeat the value anywhere for the boundary rules to see it.

A declared-but-incomplete layout (one key present, the other absent) throws
rather than being silently completed from the default. The refusal and its
diagnostic are in [violations.md](../reference/violations.md).

A native workspace (no `nx.json`) states the same fact on `archkeep.json`'s own
`workspaceLayout` field — see [configuration.md](../reference/configuration.md).

## What Nx already does

Nx infers TypeScript and JavaScript edges from import statements. Archkeep does
not re-infer them. A second inference would be a second answer to a question
that already has one, and the project's position is that
`@nx/enforce-module-boundaries` should keep running for those languages
([north-star.md](../doctrine/north-star.md): _TypeScript and JavaScript stay with
`@nx/eslint-plugin`_).

The boundary checker still analyzes `.ts`, `.js` and `.vue` files — it uses
`ts.resolveModuleName` to resolve specifiers and reports violations against the
same constraint table — but the graph edges those projects depend on come from
Nx, not from this integration.

## The misregistration guard

Writing `"plugins": ["@ecoma-io/archkeep"]` — the bare package name, missing
`/nx` — resolves to `index.mjs`, the engine entry. Before the guard existed,
Nx accepted that silently: `nx graph` exited 0, printed no warning, and
computed zero polyglot edges. A silent graph, not a loud failure.

`index.mjs` now exports a `createDependencies` that always throws, naming the
fix:

```text
archkeep: registered as the engine entry, not the Nx plugin face — nx.json named
"@ecoma-io/archkeep" instead of "@ecoma-io/archkeep/nx". Change the `plugin`
value in nx.json to "@ecoma-io/archkeep/nx".
```

The guard is the only logic `index.mjs` carries beyond its re-exports. It does
not export `name` alongside the throwing function, because measured against
nx 23.1.1 adding `name` alone (still no `createDependencies`) changed nothing
— same exit 0, same silence, same empty graph. The throwing function is what
Nx actually surfaces.

## The unregistered-plugin refusal

If the plugin is not registered in `nx.json` at all, Nx computes the graph
without it — zero polyglot edges, zero warnings. The workspace's Go, Rust and
Python projects exist in the graph as nodes (their `project.json` files still
declare them), but no edge connects any of them. `nx affected` under-selects,
and the boundary check — which reads the graph through `readProjectGraph` —
still runs, but judges the workspace against a graph that pretends those
projects have no dependencies.

The check's coverage counts are what catch this: a workspace with a dozen Go
files reporting "0 imports" is the signal that the edges are missing. If the
counts look too low, [troubleshooting.md](../usage/troubleshooting.md) starts
with that case.

---

- Install the plugin and write the first boundary table:
  [installation.md](../getting-started/installation.md)
- What each analyzer reads, and the shapes it cannot:
  [languages.md](../reference/languages.md)
- The CLI's exit codes and SARIF output: [ci.md](../usage/ci.md)
- The architecture the integration fits into:
  [architecture.md](../development/architecture.md)
