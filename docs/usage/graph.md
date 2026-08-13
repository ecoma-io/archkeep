# `lattice graph`

Print the project graph as a deterministic, serialisable snapshot.

```shell
lattice graph
lattice graph --format json
lattice graph --format json --output snapshot.json
```

`graph` reads the same project model every other command reads — Nx or native,
resolved from the workspace root — and returns it as two sorted arrays: one of
projects and one of edges. It is descriptive: it never exits 1, because a
snapshot of what is is never a finding.

## What the snapshot contains

- **Projects**: name, root directory, type (`"app"` or `"lib"`), and tags — one
  entry per project, sorted by name using plain string comparison (never
  `localeCompare`, so two runs over an unchanged tree produce byte-identical
  output). Targets, when declared, are listed by name; a native project with no
  target table omits the field rather than emitting an empty array.
- **Edges**: source project, target project, and dependency type (`"static"` or
  `"dynamic"`) — one entry per edge, sorted by source, then target, then type.
  Edge identity is the full `(source, target, type)` triple: a `static` edge
  becoming `dynamic` is two different edges, not one that changed.
- **Workspace layout**: the `appsDir`/`libsDir` the engine used when judging
  imports, with a `workspaceLayoutSource` that is `"declared"` (the workspace's
  own `nx.json` or `lattice.json` named it) or `"default"` (neither did, so the
  engine fell back to `apps`/`libs`). Two copies of a default is how a report
  ends up describing a layout the engine did not use, so the default is imported
  from where the rule engine defines it, never written a second time.

Internal fields the rule engine uses (`mfeRemote`, `entryPoints`,
`declaredPackages`) are stripped from the snapshot. They are facts about how
this tool reads upstream, not facts about the consumer's architecture.

## Exit codes

| code | meaning                                                                      |
| ---- | ---------------------------------------------------------------------------- |
| 0    | The snapshot was built, and coverage is complete.                            |
| 2    | Usage error: unknown flag, wrong argument count.                             |
| 3    | The graph has incomplete coverage — at least one file could not be analyzed. |

`graph` never exits 1. That exit code belongs to `check` alone.

## The unregistered-plugin refusal

On an Nx workspace whose `nx.json` does not register this plugin but whose
tracked files include polyglot manifests (Go, Rust, Python) under project
roots, `graph` refuses loudly rather than returning a snapshot whose edges
silently under-represent the real architecture. The refusal is narrowed to
that condition: a pure-TypeScript Nx workspace whose graph is complete without
this plugin is never refused. There is no escape flag — an option that makes a
check not run is a drift signal.

## Snapshot for diff

The JSON snapshot (`--format json`) is the file `lattice diff` accepts as its
baseline. Capture one at a known-good point and diff later to see what changed:

```shell
lattice graph --format json --output baseline.json
# ... later, after changes ...
lattice diff baseline.json
```
