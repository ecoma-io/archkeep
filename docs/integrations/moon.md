# Moon integration

Archkeep's Moon integration supplies the project graph from a Moonrepo workspace,
using `moon project-graph --json` to read what Moon already knows. It follows the
same one-call `readProjectGraph` pattern as the Nx integration: Moon resolves
projects and their dependencies, and Archkeep builds its enforcement model from
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

Archkeep detects a Moon workspace by a `.moon/` directory at the workspace root.
Moonrepo v2.0+'s alternative location, `.config/moon/`, is recognized the same
way: either one alone makes the tree a Moon workspace, and diagnostics name
whichever one is present. Both together are a **hard error** — Moon treats the
two as mutually exclusive config roots, so a tree carrying both is refused
loudly (exit 3), naming both directories, rather than silently judged against
one of them. A `archkeep.json` or `nx.json` alongside either is refused for the
same reason: this tool judges a workspace against exactly one project model.
Exactly one marker may be present.

## Configuration

A Moon workspace cannot create a `archkeep.json` — the `.moon`/`archkeep.json`
pair is refused. The provider therefore reads the two options by convention
rather than from a declaration: `boundaryConfig` names
`module-boundaries.config.mjs`, and `tsConfig` is the first of
`tsconfig.base.json`, then `tsconfig.json` that the workspace root actually
carries. Moon's own configuration does not carry a plugin-options table the way
`nx.json`'s `plugins[].options` does, and a second config file would need its
own filename option to find itself.

The `tsConfig` chain is **ordered, not "whichever is there"**. A workspace
carrying both files is read against `tsconfig.base.json`, because a root
`tsconfig.json` beside it is normally the editor's own config extending the
base one. Every run names the file it chose, so a `paths` table found in the
second candidate is visible in the report rather than inferred from a clean
exit — and the language server watches **both** candidates, so a
`tsconfig.base.json` added later takes the resolution over in the editor
without a restart.

**What the chain does not solve.** Two cases, and neither is refused, because
in both the tool finds a config and has no way to know it is the wrong one:

- **A shared config that is neither candidate.** A workspace whose `paths`
  table lives in `config/tsconfig.shared.json` — or in any name outside those
  two — has nowhere to say so, because Moon has no plugin-options table and no
  `archkeep.json` to carry a `tsConfig` field.
- **Both candidates present, with the table in the second one.** The chain
  picks by existence, not by content: a `tsconfig.base.json` holding only
  `compilerOptions.target`, beside a `tsconfig.json` holding the real `paths`
  table, is chosen and read, and every alias resolves to nothing. This is the
  same wall of false crossings the chain was added to end, reached from the
  other side.

The fix for both is the same: point one of the two candidate names at the file
that has the table (a `tsconfig.base.json` at the root whose only content is
`{"extends": "./config/tsconfig.shared.json"}` is enough), or rename it. Every
run names the file it chose in its `policy`/`tsConfig` reporting, so the check
is to read that name back and confirm it is the one holding your aliases.

**A Moon workspace carrying `.ts`, `.tsx`, `.mts`, `.cts` or `.vue` files and
neither candidate is refused, loudly.** The refusal is resolved with the
workspace itself, before any command asks its own question, so it is **every**
command that refuses — not only `check`. `graph`, `context`, `impact`, `drift`
and `history` exit 3 on such a tree too, and deliberately: they all read the
same analysis, so an unresolved `paths` table makes `graph` draw edges that are
not there and `impact` select fewer projects than a change really touches. An
under-selecting `impact` is the silent direction, and it is worse than a
refusal that names its cause. The language server publishes the reason on
every open document, instead of judging the tree. With no config to read, TypeScript falls back to compiler defaults,
every path alias resolves to nothing, and each internal import is reported as a
boundary crossing: a wall of findings on a workspace that may have no violation
in it at all.

Two kinds of workspace are deliberately **not** refused, because in both a
missing tsconfig means "there is no paths table" rather than "the paths table
was not found":

- Go, Rust and Python resolve through their own manifests and never read a
  tsconfig at all.
- A plain-JavaScript tree — `.js`, `.jsx`, `.mjs`, `.cjs` — needs no tsconfig
  either. JavaScript runs without one, most such workspaces have never had one,
  and their relative and package specifiers resolve correctly against the
  compiler defaults. Refusing them would turn a run that is currently right
  into exit 3.

  The residual case, named rather than claimed away: a JavaScript tree that
  DOES resolve through aliases — declared in a `jsconfig.json`, or in any name
  outside the two candidates — is not refused either, and is judged against the
  compiler defaults, so it gets the wall of false crossings described above.
  The tool cannot tell that tree from one with no aliases at all without
  reading a config it has not been given. Point one of the two candidate names
  at the file holding the aliases.

Those are the only options. There are no others. An unknown key in a workspace
that does carry a `archkeep.json` under another provider **throws** rather than
falling back — a `tsconfigBase` typed for `tsConfig` that quietly used the
default would give you a full green run against a rule nobody wrote.

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

Archkeep normalises this into the same project-model shape the Nx and native
providers produce: project records with `id`, `root`, `tags`, and
`dependencies`. The language server builds its editor index through this same
`readProjectGraph` call — one dispatch for both faces, so an attached editor
judges exactly the graph `archkeep check` judges. When the invocation fails —
`moon` missing from `node_modules/.bin`, a nonzero exit, output that will not
parse — neither face answers with an empty graph: the CLI refuses with exit 3,
and the server publishes an index-gap diagnostic naming the failed command on
every open document until the next successful rebuild. A binary that is in
neither place names the install command that fixes it; every other failure keeps
Moon's own stderr, because a Moon that ran and failed is a different problem
from a Moon that is not there.

Output that parses but is anomalous gets the same refusal rather than a
smaller graph: a `data` entry that is not a project node, one project `id`
declared twice, and an edge or a `dependsOn` naming a project the graph does
not contain all fail the run, naming every instance in one error — each would
otherwise drop a project or an edge silently, and a graph judged over less
than the tree is indistinguishable from one that never had them. One such
shape reaches this from ordinary configuration rather than malformed output:
a `moon.yml` `dependsOn` naming a project that does not exist exits 0 on
Moon's side (measured on 2.5.3), so this refusal is where that typo surfaces.
A root-level project whose `source` is the empty string is **not** anomalous —
Moon itself accepts `""` and `"."` as the same root — and is read as a
project.

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

Moon's project-graph edges carry a scope that Archkeep maps to dependency types:

| Moon scope    | Archkeep type |
| ------------- | ------------- |
| `production`  | `static`      |
| `development` | `static`      |
| `build`       | `static`      |
| `peer`        | `static`      |
| `root`        | _(skipped)_   |

A scope states **when** a dependency is needed — runtime, build time, peer
consumption — never **how** the importing code is written, so no scope can
produce a `dynamic` edge: that type is reserved for an `import()` a source
file actually wrote (#280). Such sites are still found by the checker's own
analysis and folded onto the graph afterward, so a genuinely lazy-loaded
dependency carries a `dynamic` edge regardless of the scope it was declared
with.

`root` dependencies are internal to Moon's runtime and carry no
source-code-level meaning, so Archkeep does not surface them.

## Declared dependencies, and Moon's `source`

Moon marks each dependency with a `source` as well as a scope, and **Moon's
`implicit` is the opposite of Archkeep's**. Moon's own schema defines the field
as "either explicitly defined in configuration, or implicitly derived from
source files":

| Moon `source` | what it means                                             | Archkeep type      |
| ------------- | --------------------------------------------------------- | ------------------ |
| `explicit`    | written by hand in `moon.yml`'s `dependsOn`               | `implicit`         |
| `implicit`    | Moon derived it from source files (e.g. a `package.json`) | from `scope` above |

Archkeep's `implicit` type means what Nx's `implicitDependencies` means: a
dependency a human declared, with no import behind it. That is the one kind the
boundary checker cannot judge at an import site — there is no import site — so
`archkeep check` judges it as a graph edge instead and reports it separately, as
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
configured to do so). Archkeep does not re-infer them. The boundary checker still
analyzes `.ts`, `.js` and `.vue` files — it uses `ts.resolveModuleName` to
resolve specifiers and reports violations against the same constraint table —
but the graph edges those projects depend on come from Moon, not from this
integration.

## What this integration does not do

- **It does not register as a Moon plugin.** Moon does not carry a hook
  equivalent to Nx's `createDependencies`. Archkeep reads the graph after Moon
  has computed it, rather than contributing edges into the computation.
- **It does not infer polyglot edges for `moon affected`.** Moon's own
  affected-command walks the graph Moon builds; Archkeep reads that graph for
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
