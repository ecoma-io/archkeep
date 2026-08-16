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
  by edge. Takes a baseline file (not a git ref). When a boundary config is
  available (via `--config` or the workspace's declared config), also reports
  which boundary violations the diff introduces and which it resolves — this
  is narrower than `check`: it checks only `depConstraints` (tag-based), not
  npm/circular/lazy-load rules that need import-site details.
  Refuses an incomplete baseline or head.
  Refuses an Nx workspace with polyglot manifests but no plugin registration.
  Descriptive: never exits 1.

- **`impact`** (`./impact.mjs`'s `impactCommand`) — reverse reachability from
  the project graph: given a project name, lists every project that transitively
  depends on it. Separates direct from transitive dependents. When a boundary
  config is available, also shows the constraint context for each dependent:
  which constraint rows govern its edge and whether that edge violates them.
  Refuses incomplete coverage (whole-file analysis failures).
  Refuses an Nx workspace with polyglot manifests but no plugin registration.
  Descriptive: never exits 1.

- **`explain`** (`./explain.mjs`'s `explainCommand`) — the judgment for one import
  site, explained. Takes a `file:line:column` site, finds the matching import
  record, and explains: which constraint row matched, which tags applied,
  whether it is a violation and why. Reports an `UNRESOLVABLE` verdict for a
  site-level failure (dynamic import with non-literal argument). Refuses an Nx
  workspace with polyglot manifests but no plugin registration. Descriptive:
  never exits 1.

- **`context`** (`./context-command.mjs`'s `contextCommand`) — the architecture
  constraints that apply to one project. Takes a project name and returns the
  project's tags plus every matching `depConstraints` row, including optional
  descriptions and remediation guidance. The filename deliberately avoids
  colliding with `./context.mjs`, which is the shared command preamble. Refuses
  an Nx workspace with polyglot manifests but no plugin registration.
  Descriptive: never exits 1.

- **`history`** (`./history.mjs`'s `historyCommand`) — the architecture's
  evolution across a consumer-managed directory of `graph --format json`
  snapshots. Reads every snapshot (the directory is the sole source of truth —
  no index, no database), in filename byte-sort (history) order, and classifies
  each transition by what the snapshots carry: graph diff (architecture),
  `policy.fingerprint` (policy/intent), `workspace.provider` (provider), and
  provenance advance with neither changed (code drift). One-sided or cross-repo
  signals are disclosed as incomparable rather than read as unchanged.
  `--capture` writes `<sequence>-<sha8>.json` (deduplicating when the
  architecture identity already is the last snapshot) and refuses incomplete
  head coverage. Refuses an empty or unreadable directory, and a snapshot that
  parses as an incomplete envelope. Descriptive: never exits 1.

## Shared modules

- **`snapshot-meta.mjs`** — `compareSnapshotMetadata`, shared by `diff` and
  `history`: the provider, provenance (with cross-repo and one-sided
  detection) and policy-fingerprint comparison between a baseline and a head.

- **`edge-constraints.mjs`** — edge-constraint analysis shared by `diff` and

- **`edge-constraints.mjs`** — edge-constraint analysis shared by `diff` and
  `impact`. Judges a single graph edge against the `depConstraints` table,
  producing violations with their constraint rows. Checks only tag-based rules
  (`onlyDependOnLibsWithTags`, `notDependOnLibsWithTags`,
  `projectWithoutTagsCannotHaveDependencies`); npm/circular/lazy-load rules
  need import-site details that graph edges do not carry. A consumer who needs
  the complete verdict should run `check`.
