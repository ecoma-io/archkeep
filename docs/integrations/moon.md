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

Lattice detects a Moon workspace by a `.moon/` directory at the workspace root.
Moonrepo v2.0+'s alternative location, `.config/moon/`, is recognized the same
way: either one alone makes the tree a Moon workspace, and diagnostics name
whichever one is present. Both together are a **hard error** — Moon treats the
two as mutually exclusive config roots, so a tree carrying both is refused
loudly (exit 3), naming both directories, rather than silently judged against
one of them. A `lattice.json` or `nx.json` alongside either is refused for the
same reason: this tool judges a workspace against exactly one project model.
Exactly one marker may be present.

## Configuration

A Moon workspace cannot create a `lattice.json` — the `.moon`/`lattice.json`
pair is refused. The provider therefore reads the two options from defaults by
convention: `boundaryConfig` names `module-boundaries.config.mjs` and
`tsConfig` names `tsconfig.base.json`. Moon's own configuration does not carry
a plugin-options table the way `nx.json`'s `plugins[].options` does, and a
second config file would need its own filename option to find itself.

Those two values are the defaults. There are no other options. An unknown key
in a workspace that does carry a `lattice.json` under another provider
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
matching the resolution `pnpm exec moon` performs. It reads and writes that
variable under whatever case the platform spells it (`Path` on Windows), and no
entry of the PATH it builds is ever empty — an empty entry resolves as the
current directory, which for this spawn is the workspace being judged, so a
`moon` file committed into a repository would otherwise run in place of the real
CLI.

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
`dependencies`. The language server builds its editor index through this same
`readProjectGraph` call — one dispatch for both faces, so an attached editor
judges exactly the graph `lattice check` judges. When the invocation fails —
`moon` missing from `node_modules/.bin`, a nonzero exit, output that will not
parse — neither face answers with an empty graph: the CLI refuses with exit 3,
and the server publishes an index-gap diagnostic naming the failed command on
every open document until the next successful rebuild. A binary that is in
neither place names the install command that fixes it; every other failure keeps
Moon's own stderr, because a Moon that ran and failed is a different problem
from a Moon that is not there.

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

## Declared dependencies, and Moon's `source`

Moon marks each dependency with a `source` as well as a scope, and **Moon's
`implicit` is the opposite of Lattice's**. Moon's own schema defines the field
as "either explicitly defined in configuration, or implicitly derived from
source files":

| Moon `source` | what it means                                             | Lattice type       |
| ------------- | --------------------------------------------------------- | ------------------ |
| `explicit`    | written by hand in `moon.yml`'s `dependsOn`               | `implicit`         |
| `implicit`    | Moon derived it from source files (e.g. a `package.json`) | from `scope` above |

Lattice's `implicit` type means what Nx's `implicitDependencies` means: a
dependency a human declared, with no import behind it. That is the one kind the
boundary checker cannot judge at an import site — there is no import site — so
`lattice check` judges it as a graph edge instead and reports it separately, as
a **declared-edge violation**. A dependency Moon derived from a manifest does
have code behind it, so it is typed from its scope and judged the ordinary way,
at the import.

The practical consequence: a `moon.yml` that names a forbidden `dependsOn` is a
finding even when no source file imports anything.

```yaml
# libs/core/moon.yml — core is a lib, cli is an app, and the table forbids it
tags:
  - type-lib
dependsOn:
  - cli # reported, with no import anywhere in the tree
```

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
- **It infers `workspaceLayout` from project source paths.** Moon does not
  declare an `appsDir`/`libsDir` convention the way `nx.json` does, so the
  provider infers one from the common directory prefix shared by each layer's
  project roots (`application`-layer sources → `appsDir`, `library`-layer
  sources → `libsDir`), falling back to the default
  `{libsDir: "libs", appsDir: "apps"}` when no consistent prefix exists. A
  project at the workspace root contributes to neither prefix: whatever its
  `source` is spelled as, its top path segment names no directory below the
  root — which is the test the provider applies, rather than a list of the
  spellings that land there — and inferring `appsDir: "."` from one would make
  every ordinary relative import in the workspace an absolute-import
  violation.
  `workspaceLayout` is carried on the graph output exactly as the Nx and
  native providers carry theirs.

---

- Install the tool and write the first boundary table:
  [installation.md](../getting-started/installation.md)
- What each analyzer reads, and the shapes it cannot:
  [languages.md](../reference/languages.md)
- The CLI's exit codes and SARIF output: [ci.md](../usage/ci.md)
- The architecture the integration fits into:
  [architecture.md](../development/architecture.md)
