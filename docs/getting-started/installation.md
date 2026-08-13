# Installation

Install the package and confirm it runs. About two minutes.

## Requirements

|            |                                                                                                                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node       | >= 22                                                                                                                                                                                              |
| TypeScript | >= 5 and < 7. Required even in a workspace with no TypeScript: `ts.resolveModuleName` resolves JS/TS specifiers, and TypeScript 7's entry point exports none of the compiler API this delegates to |
| Vue        | optional, >= 3 — needed only if you have `.vue` files, and loaded lazily so a workspace without it pays nothing                                                                                    |

You do **not** need Go, Cargo, or uv installed. Nothing here shells out to a
toolchain; manifests are parsed as data. That is what lets the graph compute on a
lint-only CI runner.

## Install the package

```shell
pnpm add -D @ecoma-io/lattice
```

npm and yarn work too. The package has no install script and no postinstall
compilation step.

## Confirm it works

```shell
pnpm exec lattice --help
```

You should see the command listing. If you do not,
[troubleshooting.md](../usage/troubleshooting.md) starts with that case.

From here the path splits by workspace type:

- **Nx workspace** — register the plugin in `nx.json`, then continue at
  [first-policy.md](first-policy.md) for the boundary table
- **No Nx** — continue at [first-project.md](first-project.md) to set up a
  `lattice.json` workspace root
