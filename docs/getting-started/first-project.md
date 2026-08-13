# First project

Set up a native workspace — no Nx, no `nx.json`. A `lattice.json` at the root
declares the projects and the engine finds them.

This is the path for a workspace that does not use Nx. If you have an `nx.json`
at your root, skip this page: the plugin registration in `nx.json` is your
entry point, and none of what follows applies — `findWorkspaceRoot` treats
`nx.json` and `lattice.json` as alternatives, never both, and a root carrying
both is a usage error rather than a guess at which one was meant.

## Create `lattice.json`

Place it at the workspace root. An empty `{}` is valid, but it declares zero
projects and infers none — almost certainly not what you want. Start by
declaring the projects you care about:

```jsonc
{
  "projects": {
    "declared": [
      { "root": "apps/checkout-api", "name": "checkout-api", "type": "app", "tags": ["layer:app"] },
      {
        "root": "libs/billing-core",
        "name": "billing-core",
        "type": "lib",
        "tags": ["layer:domain"],
      },
      { "root": "libs/shared-util", "name": "shared-util", "type": "lib", "tags": ["layer:util"] },
    ],
  },
  "boundaryConfig": "module-boundaries.config.mjs",
}
```

Every field in a declared row except `root` is optional — `name` falls back to
the directory's own `package.json` `name` field, then the root's basename, and
`type` defaults to `lib`. Tags declared here are merged as a union with any
`projectRules` matches and any `project.json` the directory happens to carry.

## Inference instead of enumeration

Listing every project by hand is one way. The other is to let the engine find
them from their manifests:

```jsonc
{
  "projects": {
    "infer": {
      "manifests": ["go.mod", "Cargo.toml", "pyproject.toml"],
      "include": ["**"],
      "exclude": ["vendor/**"],
    },
  },
  "boundaryConfig": "module-boundaries.config.mjs",
}
```

When `infer` is present, one project is added per directory that holds at least
one of the listed manifests — unless that directory is already a declared root,
in which case the declared row wins field by field and the inferred contribution
is dropped. Omit `infer` entirely to make the declared list exhaustive; an
empty `infer: {}` means "search with defaults," which is different.

`manifests: []` and `include: []` are rejected outright, by name — an empty
list here reads as "infer zero projects," which is the silent direction this
tool exists to refuse.

## Apply tags by pattern

`projectRules` adds tags and/or a type to every project whose root matches a
glob, without repeating them per project:

```jsonc
{
  "projectRules": [
    { "match": "apps/*", "tags": ["layer:app"] },
    { "match": "libs/*", "tags": ["layer:lib"] },
  ],
}
```

Rules merge with declared and inferred tags — never a precedence. At least one
of `tags` or `type` is required per row; a row setting neither is rejected as
pointless.

## Verify the engine found your projects

```shell
pnpm exec lattice check
```

Before you have written a boundary table the check will exit 3 ("no verdict"),
because there is no law to enforce yet. What matters is that the output names
the projects it discovered and the files it would analyze — a sign the engine
can see your tree. A run that found zero projects when you expected several is
the first case [troubleshooting.md](../usage/troubleshooting.md) covers.

The full reference for every field `lattice.json` accepts — including
`workspaceLayout`, `coverage.exempt`, and the inline `boundaryConfig` object —
is [configuration.md](../reference/configuration.md).

## Where to go next

- Write the boundary table and see a violation — [first-policy.md](first-policy.md)
- Every `lattice.json` field and what the loader rejects — [configuration.md](../reference/configuration.md)
- If the engine found nothing or found the wrong projects — [troubleshooting.md](../usage/troubleshooting.md)
