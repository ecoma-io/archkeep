# Configuration

Every configuration surface in one place: `lattice.json` fields, `nx.json`
plugin options, Moon workspace options, and CLI flags. A consumer never needs
to look elsewhere for a field's definition.

## `lattice.json`

For a workspace with no Nx at all. `nx.json` and `lattice.json` are
alternatives -- a root carrying both is a usage error. A Moon workspace (`.moon/`
directory present) also reads from `lattice.json` when no `nx.json` is present.
Every field below is optional; an empty `{}` validates but declares zero projects.
Six top-level keys are recognized; any other key is rejected by name.

### `projects`

#### `projects.declared`

An array of project rows, each naming a project outright.

| field                  | required | type                          | default | meaning                                                                                                           |
| ---------------------- | -------- | ----------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `root`                 | yes      | string                        | --      | Workspace-relative, posix slashes, no leading/trailing slash, no `.`/`..` segment. `""` names the root itself.    |
| `name`                 | no       | non-empty string              | derived | Falls back to `package.json`'s `name`, then the root's basename -- same precedence Nx applies.                    |
| `type`                 | no       | `"app"` \| `"lib"` \| `"e2e"` | `"lib"` | Feeds `nodeTypeOf`'s `-e2e`-suffix rule.                                                                          |
| `tags`                 | no       | string[]                      | `[]`    | Every entry non-empty. Merged as a **union** with `projectRules` and project manifest tags -- never a precedence. |
| `implicitDependencies` | no       | string[]                      | `[]`    | Each entry must resolve against `findMatchingProjects`; unresolvable entries are rejected at load time.           |
| `targets`              | no       | string[]                      | `[]`    | Names only, never run. Enough to make `hasBuildExecutor` see the project as buildable.                            |

#### `projects.infer`

Omitting this key entirely means the declared list is exhaustive -- no
inference runs at all. Presence-with-defaults differs from absence; this is
intentional.

| field       | default (when the key is present but this field is not)                  | meaning                                                                                                     |
| ----------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `manifests` | `project.json`, `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml` | One tracked manifest per directory contributes a project, unless that directory is already a declared root. |
| `include`   | `["**"]`                                                                 | Glob, matched with `path.posix.matchesGlob`.                                                                |
| `exclude`   | `[]`                                                                     | Same matcher.                                                                                               |

`manifests: []` or `include: []` is rejected outright rather than accepted as
"match nothing" -- an empty list here reads as "infer zero projects," which is
the silent direction. Omit `projects.infer` entirely to get that effect on
purpose.

### `projectRules`

An array of `{ match, tags?, type? }` rows. Each row is a glob over a
project's root (`path.posix.matchesGlob`) plus tags and/or a type to apply to
every project whose root matches. At least one of `tags`/`type` is required per
row -- a row setting neither is rejected as pointless.

### `coverage.exempt`

An array of `{ path, reason }` rows. `path` is a glob over a
workspace-relative path; `reason` is **mandatory** and non-empty. A waiver with
no reason is indistinguishable from coverage that quietly stopped being
enforced.

### `workspaceLayout`

| field     | type   | meaning                                        |
| --------- | ------ | ---------------------------------------------- |
| `appsDir` | string | Non-empty. The directory holding applications. |
| `libsDir` | string | Non-empty. The directory holding libraries.    |

Never inferred from directory names. A declaration naming only one of the two
keys is refused. An Nx-registered workspace states the same fact in `nx.json`'s
own top-level `workspaceLayout` field; the Nx integration reads it from there
directly. A Moon workspace does not use `workspaceLayout` — project roots are
declared explicitly in `.moon/workspace.yml`.

### `boundaryConfig`

| type   | default                          | meaning                                                                                     |
| ------ | -------------------------------- | ------------------------------------------------------------------------------------------- |
| string | `"module-boundaries.config.mjs"` | Filename of the boundary law, workspace-relative.                                           |
| object | --                               | The boundary law inline: `{ depConstraints, moduleBoundaryOptions, boundarySuppressions }`. |

When the value is a string, `--config` on the CLI overrides it for one run.
When the value is an object, the same three keys as the `.json` dialect are
validated by the identical function. The language server does not yet read the
inline form -- move the policy into its own `.mjs` or `.json` file to use it
from an editor.

### `tsConfig`

| type   | default                | meaning                                   |
| ------ | ---------------------- | ----------------------------------------- |
| string | `"tsconfig.base.json"` | Filename of the shared TypeScript config. |

No second shape -- stays a filename. An Nx-registered workspace states this
under `nx.json -> plugins[].options` instead. A Moon workspace states it in
`lattice.json` alongside the native provider.

## `nx.json` plugin options

For a workspace with an Nx root. Stated under `plugins[].options`:

```json
{
  "plugins": [
    {
      "plugin": "@ecoma-io/lattice/nx",
      "options": {
        "boundaryConfig": "module-boundaries.config.mjs",
        "tsConfig": "tsconfig.base.json"
      }
    }
  ]
}
```

| field            | type   | default                          | meaning                                             |
| ---------------- | ------ | -------------------------------- | --------------------------------------------------- |
| `boundaryConfig` | string | `"module-boundaries.config.mjs"` | Filename of the boundary law at the workspace root. |
| `tsConfig`       | string | `"tsconfig.base.json"`           | Filename of the shared TypeScript config.           |

Both default to the Nx conventions, so a workspace that follows them can
register the plugin by name alone. An unknown key throws at every consumer --
the Nx hook, the CLI, and the language server -- rather than falling back to a
default.

## CLI flags

All commands share the same flag-parsing rules. Both `--flag value` and
`--flag=value` work. An unknown flag is a usage error rather than a path.

### Global flags (every command)

| flag     | argument | default | meaning                        |
| -------- | -------- | ------- | ------------------------------ |
| `--help` | --       | --      | Show the help text and exit 0. |

### `--format`

| command                                                             | values                  | default | meaning                                                                                               |
| ------------------------------------------------------------------- | ----------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `check`                                                             | `text`, `sarif`, `json` | `text`  | Terminal report, SARIF 2.1.0 for GitHub code scanning, or the versioned JSON envelope.                |
| `graph`, `diff`, `drift`, `waivers`, `impact`, `explain`, `context` | `text`, `json`          | `text`  | Terminal report or the versioned JSON envelope. No SARIF -- descriptive commands produce no findings. |

`--format` changes no exit code and no byte of the other two formats. It is an
additional rendering of the same verdict.

### `--output`

| flag       | argument | default | meaning                                       |
| ---------- | -------- | ------- | --------------------------------------------- |
| `--output` | `<file>` | stdout  | Write the report to a file instead of stdout. |

Written atomically (write to `.tmp`, then rename) so a reader never sees a
truncated file.

### `--config`

| flag       | argument | default                        | meaning                                                                         |
| ---------- | -------- | ------------------------------ | ------------------------------------------------------------------------------- |
| `--config` | `<file>` | (from `boundaryConfig` option) | Read the boundary law from this file instead of the workspace's configured one. |

Accepted by `check`, `diff`, `impact`, `explain`, `context`, and `waivers`.
The judgment (`check`, `explain`), rule-impact analysis (`diff`), constraint
context (`impact`), matching rows (`context`), and the waiver surface
(`waivers` — the rows listed are the ones the law in effect carries) all
depend on which boundary law is in effect. `graph` takes no `--config` because
it describes structure, not rules, and `drift` takes none because it compares
the tree against the declared intent, not against any boundary law. Does not
move the workspace root — the tree being judged is still the consumer's.

## What is deliberately not configurable

There is no `languages` option. Switching a language off is indistinguishable,
in every report, from that language having no violations. Each analyzer costs
nothing in a workspace without that language, because resolution is keyed on a
manifest that is not there.
