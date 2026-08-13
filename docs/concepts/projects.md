# Projects

A project is the unit of architecture the engine reasons about. It has a name, a
root directory, a type, and a set of tags. The tags are how the constraint table
reaches it — see [boundaries.md](boundaries.md).

## What a project is

A project is a directory in the workspace that carries a manifest declaring it as
a unit. The engine recognises two types:

- **`app`** — an application. Applications are the top of the dependency graph;
  they are composed, not consumed. A library importing an app is a violation.
- **`lib`** — a library. Libraries may depend on other libraries, subject to the
  constraint table.

The type is decided by the project's own declaration, not by directory
convention. An `-e2e` suffix on the project name marks it as an end-to-end test
project, which is treated as structurally off-limits to imports.

## Discovery

How projects are found depends on the provider — the abstraction that supplies
the project graph to the rest of the engine. A workspace using a registered
integration receives the graph through that integration's provider. A standalone
workspace uses the native provider, which discovers projects from the tracked
tree and their manifests.

Neither the CLI nor the language server needs to know which provider it holds.
The provider seam is what makes the engine independent of the host. See the
[integration overview](integrations.md) for the seams each integration may
implement.

## Naming

A project's name comes from its declaration — the `name` field in its manifest
or project configuration. The engine never assumes any workspace's project
names, areas, or tag values. Installed from a registry, the tool sits inside the
consumer's tree while the architecture it judges is above it, and every name it
reads is an argument rather than a constant.

## The one-manifest-per-project assumption

The engine models graph identity as one language manifest per project root:

- Go: one `go.mod` at `<projectRoot>/go.mod`
- Rust: one `Cargo.toml` at `<projectRoot>/Cargo.toml`
- Python: one `pyproject.toml` at `<projectRoot>/pyproject.toml`

A nested second manifest inside one project yields no edge — the engine does not
invent a project for it. Split it into its own project instead.

Analysis is deliberately broader. It attributes a **file** rather than a
manifest, so a crate or module nested inside a project still belongs to the
project whose directory contains it. A Tauri app keeping its Rust crate in
`src-tauri/` is the case that reaches this: the graph draws no Rust edge for it
while analysis reads its sources. The two disagreeing there is the documented
modelling limit surfacing, not a bug in either.

## Tags

Tags are strings that a project's declaration attaches to it. They are the
vocabulary the constraint table operates on — every row keys on a `sourceTag`
or `allSourceTags`, and the target check looks at the target's tags.

A project without tags is not "unrestricted". If no row in the constraint table
matches a project's tags, any dependency it has is reported as a violation. This
is the rule most often mistaken for a bug, and it is the one doing the most
work: without it, a new project added without tags would silently escape every
boundary while the tool reported green.

Add a tag in the change that lands its first project, never before. A constraint
whose `sourceTag` no project carries proves nothing while reading as protection.

## Languages and edges

Each language contributes edges from its own manifest form. For languages whose
host already infers edges, the provider supplies those edges and the engine does
not infer a second answer. The native analyzers supply manifest edges for Go,
Rust, and Python.

| language                | edges from                         |
| ----------------------- | ---------------------------------- |
| Go                      | `go.mod`                           |
| Rust                    | `Cargo.toml`                       |
| Python                  | `pyproject.toml` (uv, Poetry, PDM) |
| TypeScript / JavaScript | the selected provider              |
| Vue                     | the selected provider              |

Everything is read statically. No `go`, no `cargo`, no `uv`, no `python`, no
`tsc` process. Manifests are parsed as data, sources are read as text. A graph
that needs toolchains installed fails on the machine that does not have them.

There is no option to switch a language off. A report from a workspace that
disabled Go would be byte-for-byte identical to a report from a workspace whose
Go is clean. A workspace pays nothing for a language it does not have: every
resolver keys off a manifest that is not there, and the Vue parser is not loaded
until a `.vue` file is seen.
