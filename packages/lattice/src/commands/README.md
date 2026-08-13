# `src/commands/` — one module per CLI command

One module per CLI command, holding the computation and nothing about argv,
exit codes or where output goes. `../../cli.mjs` owns those three. A module
here may read the graph, the workspace and the policy; it may not print, and
it may not decide the process's exit code — it returns a status and `cli.mjs`
maps it.

`context.mjs` is the exception in kind, not in rule: it is the preamble the
commands share rather than a command. It composes `../workspace.mjs`,
`../providers/` and `../options.mjs`; it does not reimplement any of them.

## Commands

- **`check`** (`../../cli.mjs`'s `runCheck`) — judges every import site against
  the boundary rules and returns violations, go.work drift, and dead tsconfig
  path aliases. The only command that exits 1.

- **`graph`** (`./graph.mjs`'s `graphCommand`) — the project graph as a
  deterministic, serialisable snapshot: projects (with `targets` and `tags`) and
  dependencies, each as a flat sorted array. Strips internal fields
  (`mfeRemote`, `entryPoints`, `declaredPackages`). Includes
  `workspaceLayout`/`workspaceLayoutSource`. Refuses an Nx workspace with
  polyglot manifests but no plugin registration. Descriptive: never exits 1.

- **`diff`** (`./diff.mjs`'s `diffCommand`) — two graph snapshots compared edge
  by edge. Takes a baseline file (not a git ref).
  Refuses an incomplete baseline or head.
  Refuses an Nx workspace with polyglot manifests but no plugin registration.
  Descriptive: never exits 1.

- **`impact`** (`./impact.mjs`'s `impactCommand`) — reverse reachability from
  the project graph: given a project name, lists every project that transitively
  depends on it. Separates direct from transitive dependents. Refuses incomplete
  coverage (whole-file analysis failures). Refuses an Nx workspace with polyglot
  manifests but no plugin registration. Descriptive: never exits 1.

- **`explain`** (`./explain.mjs`'s `explainCommand`) — the judgment for one import
  site, explained. Takes a `file:line:column` site, finds the matching import
  record, and explains: which constraint row matched, which tags applied,
  whether it is a violation and why. Reports an `UNRESOLVABLE` verdict for a
  site-level failure (dynamic import with non-literal argument). Refuses an Nx
  workspace with polyglot manifests but no plugin registration. Descriptive:
  never exits 1.
