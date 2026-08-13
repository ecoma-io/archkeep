# Your first project

Set up a workspace with no Nx at all. Lattice's native provider discovers
projects and builds the graph from the tree itself -- no `nx.json`, no Nx
installation, no build system as a precondition.

If your workspace already has `nx.json` at its root, this is not the page you
need: [../integrations/nx.md](../integrations/nx.md) covers the Nx path.

## 1. Create `lattice.json`

A workspace declares itself native by putting a `lattice.json` at its root. Its
presence is the marker; its contents are the project-and-tag model the Nx path
gets from Nx instead.

Start with the minimum that says something real -- one declared project and one
inferred:

```jsonc
{
  "projects": {
    "declared": [{ "root": "apps/api", "name": "api", "type": "app", "tags": ["layer:app"] }],
    "infer": {
      "manifests": ["go.mod", "Cargo.toml", "pyproject.toml"],
      "include": ["**"],
    },
  },
  "boundaryConfig": "module-boundaries.config.mjs",
  "tsConfig": "tsconfig.base.json",
}
```

`projects.declared` names projects outright. `projects.infer` (when present) adds
one project per tracked manifest it finds -- skipping any directory a declared
row already claims. Omit `projects.infer` entirely to declare every project by
hand; omit `projects.declared` to infer everything. Both together compose rather
than compete.

The full field reference -- `projectRules`, `coverage.exempt`,
`workspaceLayout`, the inline `boundaryConfig` object -- is in
[../reference/configuration.md](../reference/configuration.md).

## 2. Add a project with a manifest

Inference finds projects by their manifests. Create a Go module in a library
directory:

```shell
mkdir -p libs/billing-core
cd libs/billing-core
git init && go mod init github.com/acme/billing-core
```

Or a Rust crate:

```shell
mkdir -p libs/billing-core
cd libs/billing-core
cargo init --lib
```

Or a Python package:

```shell
mkdir -p libs/billing-core
```

```toml
# libs/billing-core/pyproject.toml
[project]
name = "billing-core"
version = "0.1.0"
```

The native provider finds these by matching `projects.infer.manifests` against
tracked files. One manifest per project root is the modeling assumption -- a
nested second manifest inside one project yields no edge.

## 3. Tag the project

Tags drive the boundary rules, and the tags are yours. Two ways to attach them:

**In `lattice.json`**, using `projectRules` -- a glob over a project's root,
plus tags to apply to every match:

```jsonc
{
  "projects": {/* ... */},
  "projectRules": [
    { "match": "apps/*", "tags": ["layer:app"] },
    { "match": "libs/*", "tags": ["layer:domain"] },
  ],
}
```

**In each project's `project.json`**, if it has one:

```jsonc
// libs/billing-core/project.json
{
  "name": "billing-core",
  "tags": ["layer:domain", "scope:billing"],
}
```

Tags from all sources are merged as a union -- never a precedence.

Two things about tags that are easy to get wrong and expensive to discover late
are in [../concepts/boundaries.md](../concepts/boundaries.md) --
read it before you commit to a vocabulary. The most important one in advance: **a
project whose tags match no constraint row at all is a violation**, not a
project nobody restricted.

## 4. Define a boundary config

Create the file `boundaryConfig` names. The default is
`module-boundaries.config.mjs` at the workspace root:

```js
// module-boundaries.config.mjs

export const depConstraints = [
  { sourceTag: "layer:app", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
];

export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};

export const boundarySuppressions = [];
```

That file is the single home of the constraint table. Nothing here restates a
constraint, and nothing here defaults an option. The full reference for every
dialect it may take is in [../concepts/policies.md](../concepts/policies.md);
what to put in the table is in
[../concepts/boundaries.md](../concepts/boundaries.md). The next
page in this sequence walks through writing and running it step by step:
[first-policy.md](first-policy.md).

## 5. Run the check

```shell
pnpm exec lattice check
```

A clean tree prints what it inspected, not just that it found nothing:

```text
no boundary violations (18 imports in 6 files across 2 projects)
```

Those counts are the point. "No violations" is a claim about coverage as much as
about correctness, and a run that analyzed four files would otherwise look
identical to one that analyzed four hundred.

Exit codes: 0 is clean, 1 is findings, 2 is a usage error, and **3 is "no
verdict" -- the run could not look**. Do not collapse 3 into 0. That distinction
is the reason this tool can be trusted -- [../usage/ci.md](../usage/ci.md)
covers it in full.

## Next

- Write and run your first constraint table: [first-policy.md](first-policy.md)
- `lattice.json` field reference: [../reference/configuration.md](../reference/configuration.md)
- Boundary config dialects and shape: [../concepts/policies.md](../concepts/policies.md)
- Nx integration (if you add Nx later): [../integrations/nx.md](../integrations/nx.md)
