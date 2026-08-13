# Projects

How the engine discovers what exists, and what a project _is_ inside the graph.

## The project model

A project is the unit the boundary rules judge against. It carries:

- **A name** — unique across the workspace, used in every report and every edge.
- **A root directory** — workspace-relative, the directory the engine associates
  with this project.
- **A type** — `app`, `lib`, or `e2e`. Applications and e2e projects have
  blanket import bans; libraries are where the constraint table applies.
- **Tags** — the labels the boundary rules match on. Tags carry architectural
  meaning (`layer:domain`, `scope:billing`, `license:gpl`); the engine never
  interprets them, only matches them.

## How projects are discovered

Two routes, and they compose rather than compete:

**Declared** — the workspace names project roots explicitly. The declaration
carries the name, type, and tags; the engine trusts it.

**Inferred** — the engine finds a project per tracked manifest file (`go.mod`,
`Cargo.toml`, `pyproject.toml`, `package.json`, `project.json`) under a
directory that no declaration already claims. The manifest provides the name; the
engine assigns a default type.

A workspace can use either alone, both together, or neither. A workspace
declaring zero projects and inferring none is almost certainly not what you want,
and the CLI's coverage checks will make that loud rather than reading it as a
clean tree.

## Project identity and the graph

One manifest per project root is the modelling assumption. A nested second
manifest — a `go.mod` inside a project that already has one — draws no edge. The
project's identity comes from the manifest at its root.

For analysis, the rule is simpler: a file belongs to whichever project's
directory contains it. A crate nested inside a project still belongs to the
project whose directory contains it — the graph draws no Rust edge for it, while
analysis reads its sources. The two disagreeing there is a documented modelling
limit, not a bug in either.

## Tags

Tags are the boundary rules' vocabulary. They are _not_ validated against a
schema — a project either carries a tag or it does not, and whether `layer:adapter`
is a tag the constraint table actually constrains is that table's question, not
the project model's.

Tags from different sources are merged as a union, never a precedence: a
declaration, an inference rule, and a config file may all contribute tags to the
same project, and the result is the union of all of them.

## Project rules

A workspace may declare rules that apply tags and types to projects whose roots
match a glob pattern. A rule applies to every matching project; a project may
match several rules, and the tags from all of them accumulate.

A rule that sets neither tags nor type is rejected as pointless — it matches
projects and changes nothing about them.

---

- How the graph is built from projects → [graph.md](graph.md)
- How the boundary rules use tags → [boundaries.md](boundaries.md)
- Configuration reference → [../reference/configuration.md](../reference/configuration.md)
