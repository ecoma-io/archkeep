# `lattice.json`

This page is for a workspace with no Nx at all. If `nx.json` is the marker at
your workspace root, skip it — [getting-started.md](getting-started.md)'s
"Register the plugin" step is yours instead, and none of what follows applies:
`findWorkspaceRoot` treats `nx.json` and `lattice.json` as alternatives, never
both, and a root carrying both is a usage error rather than a guess at which
one was meant
([architecture.md](../development/architecture.md), "Find the workspace
root").

A workspace declares itself native by putting a `lattice.json` at its root.
Its presence is the marker; its contents are the project-and-tag model
[`../development/architecture.md`](../development/architecture.md) elsewhere
gets from Nx. Everything on this page is validated shape — a field the loader
rejects outright — never the deeper question of whether a declared root
exists in the tree, or whether two projects collide on one name; those are
judged against the tracked tree itself and reported the same loud way,
covered in
[`packages/lattice/src/providers/native/README.md`](../../packages/lattice/src/providers/native/README.md)'s
"Two failure classes, both loud."

## The shape, field by field

Every field below is optional; an empty `{}` is a valid `lattice.json` that
declares zero projects outright and infers none, which validates but almost
certainly is not what you want — see "Declaring vs. inferring projects"
below. Six top-level keys are recognized; any other key is rejected by name,
naming itself, in the same error.

```jsonc
{
  "projects": {
    "declared": [{ "root": "libs/core", "name": "core", "type": "lib", "tags": ["layer:core"] }],
    "infer": {
      "manifests": ["go.mod", "Cargo.toml", "pyproject.toml"],
      "include": ["**"],
      "exclude": ["libs/vendor/**"],
    },
  },
  "projectRules": [{ "match": "apps/*", "tags": ["layer:app"] }],
  "coverage": {
    "exempt": [{ "path": "tools/**", "reason": "generated, not owned by a project" }],
  },
  "workspaceLayout": { "appsDir": "apps", "libsDir": "libs" },
  "boundaryConfig": "module-boundaries.config.mjs",
  "tsConfig": "tsconfig.base.json",
}
```

### `projects.declared`

An array of project rows, each naming a project outright. One required field,
five optional:

| field                  | required | type                    | notes                                                                                                                                                                                                                               |
| ---------------------- | -------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `root`                 | yes      | string                  | Workspace-relative, posix slashes, no leading/trailing slash, no `.`/`..` segment. `""` names the workspace root itself; `"."` is rejected by name in favor of `""`.                                                                |
| `name`                 | no       | non-empty string        | Falls back to a `package.json`'s `name`, then the root's own basename — the same precedence Nx applies, so a tree that used to run Nx keeps its project names.                                                                      |
| `type`                 | no       | `app` \| `lib` \| `e2e` | Feeds `nodeTypeOf`'s `-e2e`-suffix rule; a project stating none lands on `lib`, the type with no blanket import ban.                                                                                                                |
| `tags`                 | no       | string[]                | Every entry non-empty. Merged as a **union** with any `projectRules` match and any `project.json` the project happens to have — never a precedence.                                                                                 |
| `implicitDependencies` | no       | string[]                | Each entry must resolve against the matcher `packages/lattice/src/rules/match.mjs`'s `findMatchingProjects` uses — an entry that cannot is rejected here, at load time, rather than silently dropped later when the graph is built. |
| `targets`              | no       | string[]                | Names only, never run. Enough to make `hasBuildExecutor` see the project as buildable; see the native provider's own README, "Declared limits," item 3.                                                                             |

A directory named by two different rows — one declared, one inferred — is not
an error at this layer: declared always wins, field by field, and the
inferred contribution to that root is dropped.

### `projects.infer`

Omitting this key entirely means the declared list is exhaustive — **no
inference runs at all.** This is the one place on this page where absence and
presence-with-defaults mean different things; keeping it that way is what
keeps `projects: {}` from silently claiming a vendored `package.json` as a
project nobody asked for.

| field       | default (when the key is present but this field is not)                  | notes                                                                                                                         |
| ----------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `manifests` | `project.json`, `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml` | One tracked manifest of these names, per directory, contributes a project — unless that directory is already a declared root. |
| `include`   | `["**"]`                                                                 | Glob, matched with `path.posix.matchesGlob`.                                                                                  |
| `exclude`   | `[]`                                                                     | Same matcher. `exclude: []` is a real, meaningful setting ("exclude nothing") and is exempt from the rule below.              |

`manifests: []` or `include: []` is rejected outright, by name, rather than
silently accepted as "match nothing": an empty list here reads as "infer
zero projects," which is the silent direction this whole tool exists to
refuse. Omit `projects.infer` entirely to get that effect on purpose.

### `projectRules`

An array of `{ match, tags?, type? }` rows, each a glob over a project's root
(`path.posix.matchesGlob`) plus tags and/or a type to apply to every project
whose root matches. At least one of `tags`/`type` is required per row — a row
setting neither matches projects and changes nothing about them, so it is
rejected as pointless rather than accepted as a no-op.

### `coverage.exempt`

An array of `{ path, reason }` rows — a glob over a workspace-relative path,
and a **mandatory**, non-empty `reason`. This is a waiver: a path this array
names is excluded from the "every tracked, analyzable file belongs to some
project" check `packages/lattice/src/providers/native/README.md`'s "Two
failure classes, both loud" describes. A waiver with no reason recorded is
indistinguishable from coverage that quietly stopped being enforced, which is
why `reason` is required rather than optional.

### `workspaceLayout`

`{ appsDir, libsDir }`, both non-empty strings when the key is present at
all. Never inferred from directory names — a workspace that wants either
judged states both explicitly; one that states neither gets the rule
engine's own default, the same default the Nx path falls back to when Nx's
own `workspaceLayout` is unset.

### `boundaryConfig` / `tsConfig`

The same two options an Nx-registered workspace states in
`nx.json → plugins[].options`, stated directly here instead because a
`lattice.json` workspace has no `plugins[].options` table to nest them under
([architecture.md](../development/architecture.md), "Read the plugin
options"). `--config` on the command line still overrides `boundaryConfig`
for one run either way.

`boundaryConfig` takes a second shape besides a filename: an object, holding
the boundary law inline rather than pointing at a separate file. Its three
keys are exactly `depConstraints`, `moduleBoundaryOptions` and
`boundarySuppressions` — [policy-file.md](policy-file.md) is the reference for
what each one holds — validated by the same check a `.mjs` or `.json` boundary
file goes through, so a malformed row is rejected here, at `lattice.json`
load, the same way it would be rejected in a separate file. `tsConfig` has no
such second shape; it stays a filename.

## Declaring vs. inferring projects

Two ways to get a project onto the list, and they compose rather than
compete: `projects.declared` names roots outright, and `projects.infer` (when
present) adds one project per tracked manifest matching its `manifests`,
`include` and `exclude` — skipping any directory a declared row already
claims. A workspace can use either alone, both together, or neither (an
empty `{}` at `projects`, which validates and means zero projects — almost
certainly not what you want, and the CLI's own coverage checks will make that
loud rather than reading it as a clean tree).

## What this file does not decide

Tag _values_ are never validated against a vocabulary here — a project either
carries a tag or it does not, and whether `layer:adapter` is a tag your
`boundaryConfig` actually constrains is that file's question, not this one's.
Nothing on this page reaches a project's build system, its language
toolchain, or npm registry bookkeeping — see
[`packages/lattice/src/providers/native/README.md`](../../packages/lattice/src/providers/native/README.md)'s
"Declared limits" for the full list and why each one stops here.

## Next

- What proves this model against a real tree it was not tested on → [`packages/lattice/src/providers/native/README.md`](../../packages/lattice/src/providers/native/README.md)
- How the provider seam fits into one `check` → [../development/architecture.md](../development/architecture.md)
- The exit codes this model's own failures map to → [ci.md](ci.md)
