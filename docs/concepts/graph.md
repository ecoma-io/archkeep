# The project graph

The project graph is the engine's model of which projects exist and how they
depend on each other. It is a deterministic, serialisable snapshot: two runs
over an unchanged workspace produce byte-identical output, given the same
archkeep version (a newer release may change the schema or field ordering).

## What a project is

A project is a directory in the workspace that carries a manifest declaring it as
a unit of architecture. It has a name, a root directory, a type (`"app"` or
`"lib"`), and a set of tags. The tags are how the constraint table reaches it —
see [boundaries.md](boundaries.md).

How projects are discovered depends on the provider. The details are in
[projects.md](projects.md).

## What an edge is

An edge connects two projects with a direction and a type. Its identity is the
full triple:

```
(source, target, type)
```

A `static` edge becoming `dynamic` is two different edges, not one that changed.
The type comes from the import's form in the source file:

- **`static`** — a compile-time dependency (`import`, `use`, a Go import).
- **`dynamic`** — a run-time-only dependency (`import()`, `require` of a
  lazy-loaded library).

Go, Rust and Python edges come from language manifests, not from source files.
A manifest says a dependency _may_ be used; it never says a boundary _was_
crossed. The source file is where the boundary question lives — analysis
records carry the import's form where one exists, which is where the
`static`/`dynamic` split above is read — and the two disagreeing is itself
information: a declared-but-unused dependency and an undeclared-but-imported
one are both findings.

## Deterministic snapshots

The graph sorts its output so two runs agree:

- **Projects**: one entry per project, sorted by name using plain string
  comparison (never `localeCompare`).
- **Edges**: one entry per edge, sorted by source, then target, then type.

Internal fields the rule engine uses (`mfeRemote`, `entryPoints`,
`declaredPackages`) are stripped from the snapshot. They are facts about how the
engine reads upstream, not facts about the consumer's architecture.

## Workspace layout

The `appsDir`/`libsDir` the engine used when judging imports is included in the
snapshot, with a `workspaceLayoutSource` that is `"declared"` (the canonical
graph carries a `workspaceLayout` key — the workspace's own configuration named
it, or the Moon provider derived it per
[ADR 0010](../adr/0010-moon-workspace-layout-inference.md)) or `"default"`
(neither happened, so the engine fell back to `apps`/`libs`). The default is
imported from where the rule engine defines it, never written a second time.

A complete declaration is honored. A partial one — naming only `appsDir` or only
`libsDir` — is refused loudly, with exit 3 and a message naming the missing key.
Running with half the layout silently defaulted would check the wrong half of
the tree, and a clean result from that half would look identical to "no
violation".

## The coverage invariant

The graph is descriptive: it reports what is. If a file could not be analyzed,
that fact appears in the snapshot rather than being omitted. An edge list that
silently under-represents the real architecture is the defect this tool's whole
design exists to prevent.

On an Nx workspace where the integration is not registered but polyglot manifests exist
under project roots, the engine refuses to return a snapshot rather than
producing one whose edges silently under-represent the real architecture. There
is no escape flag — an option that makes a check not run is a drift signal.
