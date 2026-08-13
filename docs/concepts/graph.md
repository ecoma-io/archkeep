# The project graph

The project graph is the foundation everything else stands on. It answers two
questions: _which projects exist_, and _which depends on which_. Every boundary
judgment, every impact query, every diff comparison starts from this graph.

## What the graph contains

The graph has two parts:

- **Projects** — each with a name, a root directory, a type (`app` or `lib`),
  and tags. Tags carry the architectural meaning the boundary rules judge
  against.
- **Edges** — a dependency from one project to another, typed as `static` or
  `dynamic`. Edge identity is the full triple: `(source, target, type)`. A
  `static` edge becoming `dynamic` is two different edges, not one that changed.

## Where the edges come from

Edges come from manifests, not from source files. A manifest — `go.mod`,
`Cargo.toml`, `pyproject.toml` — is a dependency _declaration_; a source file
is a _use_ of that dependency. The two can disagree, and the disagreement is
itself information:

- **Declared but unused** — the manifest lists a dependency the source never
  imports. A waste, not a violation.
- **Undeclared but used** — the source imports something the manifest does not
  list. A real dependency the graph does not know about, and a real false
  negative in the edge list.

Source-level analysis is what catches the second case. The graph catches the
first.

## Determinism

The graph is deterministic. Two computations over the same tree, with the same
version of the engine, produce byte-identical output. Project names and edge
lists are sorted using plain string comparison — never `localeCompare` — so
the order does not depend on the runtime's locale.

That determinism is what makes the `graph` and `diff` commands useful in a
pipeline: a captured snapshot at a known-good point can be compared against the
current workspace, and the diff shows only real changes.

## Workspace layout

The workspace layout — which directories hold apps and which hold libraries —
is read from the workspace's own declaration, not inferred from directory names.
A workspace that states `packages/` as its libraries directory is judged against
`packages/`, never against the default `libs/`.

A declaration naming only one of the two directories (apps or libs) is refused
rather than completed from the default, because a half-applied layout would
quietly check the wrong half of the tree, and a clean result from that half
would look identical to "no violation".

## What the graph does not carry

The graph is edges only — never nodes, never targets. Projects stay declared by
the workspace, and no target is ever inferred. That refusal is the reason this
engine exists separately from tools that solve the edge problem by also inferring
build targets: what a target does keeps one source of truth.

The graph also does not carry per-file import records. That information lives
in the analysis layer, and the two are separate on purpose: a manifest says a
dependency _may_ be used; it never says a boundary _was crossed_.

---

- What the engine does with the graph → [architecture.md](architecture.md)
- How boundaries are judged → [boundaries.md](boundaries.md)
- The commands that read the graph → [../usage/graph.md](../usage/graph.md),
  [../usage/diff.md](../usage/diff.md), [../usage/impact.md](../usage/impact.md)
