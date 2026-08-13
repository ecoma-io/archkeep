# Moon integration

Lattice's Moon integration supplies the project graph from a Moonrepo workspace,
using `moon project-graph --json` to read what Moon already knows. It follows the
same one-call `readProjectGraph` pattern as the Nx integration: Moon resolves
projects and their dependencies, and Lattice builds its enforcement model from
that graph.

## What the integration provides

| surface              | what it gives you                                                         |
| -------------------- | ------------------------------------------------------------------------- |
| Project graph        | Every project, its tags, and its dependencies — from `moon project-graph` |
| Boundary enforcement | The same constraint table, judged against the Moon graph                  |

Edges come from the graph; verdicts come from sources. That split is the
architecture's central seam —
[architecture.md](../development/architecture.md) owns the full flow.

## Workspace detection

Lattice detects a Moon workspace by the presence of a `.moon/` directory at the
workspace root. A `lattice.json` or `nx.json` alongside it is an ambiguity the
checker refuses — exactly one marker may be present.

## Configuration

A Moon workspace states its options in `lattice.json` at the root (the same file
the native provider reads), not in `.moon/workspace.yml`. This is because Moon's
own configuration does not carry a plugin-options table the way `nx.json`'s
`plugins[].options` does, and a second config file would need its own filename
option to find itself.

```json
{
  "boundaryConfig": "module-boundaries.config.mjs",
  "tsConfig": "tsconfig.base.json"
}
```

Those two values are the defaults. There are no other options. An unknown key
**throws** rather than falling back — a `tsconfigBase` typed for `tsConfig`
that quietly used the default would give you a full green run against a rule
nobody wrote.

## How the provider reads the graph

The CLI and the language server need the full project graph. They get it through
`readProjectGraph`, which spawns the Moon CLI:

```shell
moon project-graph --json
```

The package resolves the `moon` binary from the workspace's own installation
(`node_modules/.bin/moon`), so `@moonrepo/cli` must be a dev dependency of the
workspace. The provider prepends `node_modules/.bin` to PATH to find the binary,
matching the resolution `pnpm exec moon` performs.

The command emits a JSON object with an integer-indexed graph:

```json
{
  "graph": {
    "nodes": [0, 1],
    "edges": [[0, 1, "production"]]
  },
  "data": {
    "0": { "id": "core", "root": "libs/core", "tags": ["layer-core"] },
    "1": { "id": "app", "root": "libs/app", "tags": ["layer-app"] }
  }
}
```

Lattice normalises this into the same project-model shape the Nx and native
providers produce: project records with `id`, `root`, `tags`, and
`dependencies`.

## Tag format

Moon tags cannot contain colons — its validation rejects them. Use dash
separators instead:

```yaml
# moon.yml — correct
tags:
  - layer-core
  - scope-shared

# moon.yml — Moon rejects this
tags:
  - layer:core
  - scope:shared
```

The boundary config uses the same dash format the Moon provider emits verbatim
from `moon.yml` tags. A constraint table written for `layer:core` will not match
a project carrying `layer-core`, and vice versa — the strings must agree
exactly.

## Dependency scopes

Moon's project-graph edges carry a scope that Lattice maps to dependency types:

| Moon scope    | Lattice type |
| ------------- | ------------ |
| `production`  | `static`     |
| `development` | `dynamic`    |
| `build`       | `static`     |
| `peer`        | `static`     |
| `root`        | _(skipped)_  |

`root` dependencies are internal to Moon's runtime and carry no
source-code-level meaning, so Lattice does not surface them.

## What Moon already does

Moon infers TypeScript and JavaScript edges from import statements (when
configured to do so). Lattice does not re-infer them. The boundary checker still
analyzes `.ts`, `.js` and `.vue` files — it uses `ts.resolveModuleName` to
resolve specifiers and reports violations against the same constraint table —
but the graph edges those projects depend on come from Moon, not from this
integration.

## What this integration does not do

- **It does not register as a Moon plugin.** Moon does not carry a hook
  equivalent to Nx's `createDependencies`. Lattice reads the graph after Moon
  has computed it, rather than contributing edges into the computation.
- **It does not infer polyglot edges for `moon affected`.** Moon's own
  affected-command walks the graph Moon builds; Lattice reads that graph for
  enforcement, not for contribution. A workspace that needs polyglot edges in
  `moon affected` should declare them through Moon's own `dependsOn` in
  `moon.yml`.
- **It does not carry `workspaceLayout`.** Moon does not emit the
  `appsDir`/`libsDir` convention Nx uses. A Moon workspace's project roots are
  declared explicitly in `.moon/workspace.yml`, so the path-based layout
  inference the Nx provider carries does not apply.

---

- Install the tool and write the first boundary table:
  [installation.md](../getting-started/installation.md)
- What each analyzer reads, and the shapes it cannot:
  [languages.md](../reference/languages.md)
- The CLI's exit codes and SARIF output: [ci.md](../usage/ci.md)
- The architecture the integration fits into:
  [architecture.md](../development/architecture.md)
