# Installation

What you need before you install, and how to install it.

## Prerequisites

|            |                                                                                                                                                                                                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node       | >= 22                                                                                                                                                                                                                                                                 |
| TypeScript | >= 5 and < 7. Required even in a workspace with no TypeScript in it: `ts.resolveModuleName` is what resolves TypeScript and JavaScript specifiers, and the upper bound is there because TypeScript 7's entry point exports none of the compiler API this delegates to |
| Vue        | optional, >= 3 -- needed only if you have `.vue` files, and loaded lazily so a workspace without it pays nothing                                                                                                                                                      |

You do **not** need Go, Cargo or uv installed. Nothing here shells out to a
toolchain; manifests are parsed as data. That is what lets the graph compute on a
lint-only CI runner.

Nx is a peer dependency, but an optional one -- the engine and the CLI run
without it. A workspace with no `nx` installed uses the native provider
([first-project.md](first-project.md)); a workspace that has Nx uses the
integration ([../integrations/nx.md](../integrations/nx.md)). A Moonrepo
workspace uses the Moon integration
([../integrations/moon.md](../integrations/moon.md)) instead.

## Install

```shell
pnpm add -D @ecoma-io/archkeep
```

That is the only install step. What you do next depends on how your workspace is
structured:

- No workspace tool -- the native provider walks the tree itself: [first-project.md](first-project.md)
- Nx workspace -- register the integration in `nx.json`: [../integrations/nx.md](../integrations/nx.md)
- Moonrepo workspace -- add the `.moon/` directory and follow the integration guide (no `archkeep.json` — the pair is a hard error): [../integrations/moon.md](../integrations/moon.md)

## What the package provides

Three entry points, one engine behind them — plus a fourth seam for
integrations:

| entry                         | how it runs                  | what it does                                                                      |
| ----------------------------- | ---------------------------- | --------------------------------------------------------------------------------- |
| `archkeep check`              | CLI                          | Analyze the tree, report violations, exit 0/1/2/3                                 |
| `archkeep-lsp`                | Language server over stdio   | Diagnostics at the edit, in any LSP client                                        |
| `@ecoma-io/archkeep/nx`       | Nx integration, in `nx.json` | Polyglot edges in the project graph, on every `nx` invocation                     |
| `@ecoma-io/archkeep/commands` | In-process, for integrations | The CLI's command functions, for a caller that owns its own output and exit codes |

The CLI commands are documented individually under [../usage/](../usage/), and
[../reference/cli.md](../reference/cli.md) is the full command reference. This
page covers
getting the package onto your machine; the next two pages cover using it.

A fourth face exists for AI agents: `@ecoma-io/archkeep-mcp` exposes the
engine's commands as structured MCP tools, for agents whose host speaks the
Model Context Protocol — a separate optional install, described in
[../integrations/mcp.md](../integrations/mcp.md).

## Next

- Set up a workspace with no workspace tool: [first-project.md](first-project.md)
- Write and run your first constraint table: [first-policy.md](first-policy.md)
