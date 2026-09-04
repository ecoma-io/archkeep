# Configuration

Every configuration surface in one place: `archkeep.json` fields, `nx.json`
plugin options, Moon workspace options, and CLI flags. A consumer never needs
to look elsewhere for a field's definition.

## `archkeep.json`

For a workspace with no Nx at all. `nx.json` and `archkeep.json` are
alternatives -- a root carrying both is refused loudly (exit 3). A Moon workspace
(`.moon/` directory present) must NOT create a `archkeep.json` alongside it: a
tree carrying both markers is refused loudly (exit 3), because this tool
judges a workspace against exactly one project model. Every field below is
optional; an empty `{}` validates but declares zero projects.
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

| field                   | default (when the key is present but this field is not)                                                                                   | meaning                                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifests`             | `project.json`, `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`, `pom.xml`, `settings.gradle`, `settings.gradle.kts`, `*.csproj` | One tracked manifest per directory contributes a project, unless that directory is already a declared root.                                                                |
| `include`               | `["**"]`                                                                                                                                  | Glob, matched with `path.posix.matchesGlob`.                                                                                                                               |
| `exclude`               | `["**/docs/**", "**/fixtures/**", "**/__fixtures__/**"]`                                                                                  | Same matcher.                                                                                                                                                              |
| `excludeBeyondDefaults` | `[]`                                                                                                                                      | Extra patterns merged into the effective exclude set (the defaults or an explicit `exclude`), so a workspace extends rather than restates the default guard. Same matcher. |

`manifests: []` or `include: []` is rejected outright rather than accepted as
"match nothing" -- an empty list here reads as "infer zero projects," which is
the silent direction. Omit `projects.infer` entirely to get that effect on
purpose.

##### The default exclusion set, and why it is deliberate

A tracked manifest inside a directory that is data ABOUT the workspace --
documentation, test fixtures -- anchors a phantom project: inference judges it
and its files as real production code, silently. The default `exclude` set is
the deliberate guard. It names three whole path segments -- `docs`, `fixtures`,
`__fixtures__` -- and nothing else:

- **Segments, not substrings**: `my-docs/` and `test-fixtures/` do not match.
- **`examples` is deliberately absent**: example projects are commonly real,
  built, governed code; excluding them by name would trade a phantom for a
  silently missing project.
- **An explicit list replaces the default** (the `tsconfig` convention for the
  same field). A workspace naming its own `exclude` takes over the whole
  decision -- `exclude: []` is the documented opt-out and means it.
- **`excludeBeyondDefaults` extends the effective set** without restating the
  defaults: a workspace with `testdata/` or `golden/` directories names them
  here rather than copying the three default patterns by hand. The merge is
  additive -- `excludeBeyondDefaults` patterns join whatever `exclude` resolves
  to (the defaults when `exclude` is absent, the explicit list when it is
  present) -- so the two fields never conflict.

The exclusion is not a silent hole, by construction:

- `projects.declared` is exempt from it. A workspace with a real project under
  one of these paths declares it, and declaration is the authoritative channel
  inference never touches.
- A dropped anchor's analyzable files do not vanish: they surface as unclaimed
  coverage findings ("not owned by any project") until the workspace either
  declares the project or records a reasoned `coverage.exempt` row -- which is
  the explicit, audited way to say "this directory is fixture data."

##### Generated .NET output under `obj/` and `bin`

A tracked `*.csproj` under an `obj/` or `bin/` directory never anchors a
project when the directory above that segment carries the tracked `.csproj`
whose build produced it -- the layout `dotnet build` itself writes, the
project file beside the `obj/` and `bin/` it fills. The judgment is by role,
not name: a source project that merely lives under a directory NAMED `obj` or
`bin`, with no owning manifest above the segment, is discovered like any
other.

Every `path.posix.matchesGlob` pattern in this file -- `include`/`exclude`
here, and `projectRules[].match`/`coverage.exempt[].path` below -- is capped
at 512 brace-driven alternatives. The matcher's `{a,b,c}` brace-group support
expands combinatorially, so an unbounded pattern is a denial-of-service risk
in a file a pull request can edit, not just an unusual one; a pattern past the
cap is rejected at load, naming it.

### `projectRules`

An array of `{ match, tags?, type? }` rows. Each row is a glob over a
project's root (`path.posix.matchesGlob`) plus tags and/or a type to apply to
every project whose root matches. At least one of `tags`/`type` is required per
row -- a row setting neither is rejected as pointless.

### `coverage.exempt`

An array of `{ path, reason }` rows. `path` is a glob over a
workspace-relative path; `reason` is **mandatory** and non-empty. A waiver with
no reason is indistinguishable from coverage that quietly stopped being
enforced. A row matching no unclaimed analyzable tracked file is refused as
stale when the run starts, and rows are matched over the files no project owns
-- so even a wide glob (`**`, a whole directory) can never name a file a
project owns, and no judgment that needs a claimed target can be silenced.

Exemption answers the boundary question too, not only the coverage one: an
import that resolves into an exempt file is judged unconstrained -- neither a
project-to-project edge nor an external import -- instead of being reported as
`noRelativeOrAbsoluteExternals`. Every such import is counted in the run's
coverage notes directly after the exempted-file count, so "not constrained,
by this declaration" stays distinguishable from "not analyzed".

An Nx or Moon workspace has no `archkeep.json` to carry this list; its
counterpart is the boundary policy's own
[`coverage.unowned`](policy-schema.md#coverage) key, which a native tree is
refused in turn -- one channel per decision per tree, in each direction.

### `workspaceLayout`

| field     | type   | meaning                                        |
| --------- | ------ | ---------------------------------------------- |
| `appsDir` | string | Non-empty. The directory holding applications. |
| `libsDir` | string | Non-empty. The directory holding libraries.    |

Never inferred from directory names. A declaration naming only one of the two
keys is refused. An Nx-registered workspace states the same fact in `nx.json`'s
own top-level `workspaceLayout` field; the Nx integration reads it from there
directly. A Moon workspace carries `workspaceLayout` on its graph output too,
inferred from the common directory prefix shared by each layer's project
roots.

### `boundaryConfig`

| type   | default                          | meaning                                                                                                           |
| ------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| string | `"module-boundaries.config.mjs"` | Filename of the boundary law, workspace-relative.                                                                 |
| object | --                               | The boundary law inline: `{ depConstraints, moduleBoundaryOptions, boundarySuppressions, fitness, customRules }`. |

When the value is a string, `--config` on the CLI overrides it for one run.
When the value is an object, the same keys as the `.json` dialect are
validated by the identical function — `customRules` included, so a native
workspace declares a rule of its own here exactly as a policy file would
([custom-rules.md](custom-rules.md)) — except the policy's
[`coverage`](policy-schema.md#coverage) key, refused inline and in a policy
file alike on a native tree: `coverage.exempt` above is this file's own
channel for that decision. The language server reads the inline form
too: it watches `archkeep.json` itself, so an edit to the policy re-diagnoses
every open file the same way an edit to a policy file does.

### `tsConfig`

| type   | default                | meaning                                   |
| ------ | ---------------------- | ----------------------------------------- |
| string | `"tsconfig.base.json"` | Filename of the shared TypeScript config. |

No second shape -- stays a filename. An Nx-registered workspace states this
under `nx.json -> plugins[].options` instead. A Moon workspace carries no
`archkeep.json` (the `.moon`/`archkeep.json` pair is refused loudly, exit 3), so
the Moon provider reads the two options from defaults by convention.

## `nx.json` plugin options

For a workspace with an Nx root. Stated under `plugins[].options`:

```json
{
  "plugins": [
    {
      "plugin": "@ecoma-io/archkeep/nx",
      "options": {
        "boundaryConfig": "module-boundaries.config.mjs",
        "tsConfig": "tsconfig.base.json"
      }
    }
  ]
}
```

| field            | type   | default                          | meaning                                                                                                                           |
| ---------------- | ------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `boundaryConfig` | string | `"module-boundaries.config.mjs"` | Filename of the boundary law at the workspace root — or, when `profiles` is present, a profile NAME.                              |
| `tsConfig`       | string | `"tsconfig.base.json"`           | Filename of the shared TypeScript config.                                                                                         |
| `profiles`       | string | absent                           | Name of a profile registry file. When present, `boundaryConfig`/`--config` select a profile by name ([profiles.md](profiles.md)). |

`boundaryConfig` and `tsConfig` default to the Nx conventions, so a workspace
that follows them can register the plugin by name alone. An unknown key throws
at every consumer -- the Nx hook, the CLI, and the language server -- rather
than falling back to a default. A `profiles` option is refused by the language
server at startup, loudly, because it only ever reads a policy file.

## CLI flags

All commands share the same flag-parsing rules. Both `--flag value` and
`--flag=value` work. An unknown flag is a usage error rather than a path.
`--help` is the one exception to the shared rules — see below.

Help is shown by `archkeep --help` (running `archkeep` with no arguments prints
the same text, but as a usage error: exit 2, on stderr), and only as the first
argument — `archkeep <command> --help` is a usage error
(exit 2), because `--help` is not parsed per command. A bare `archkeep help`
(no `--`) is likewise a usage error: `help` is not a command name.

### `--format`

| command                                                                                                                                                                                                                                    | values                  | default | meaning                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `check`, `delta`                                                                                                                                                                                                                           | `text`, `sarif`, `json` | `text`  | Terminal report, SARIF 2.1.0 for GitHub code scanning, or the versioned JSON envelope.                |
| `graph`, `diff`, `change`, `drift`, `discover`, `reconcile`, `waivers`, `fitness`, `history`, `trajectory`, `evolution`, `health`, `report`, `debt`, `impact`, `scenario`, `explain`, `context`, `provenance`, `decisions`, `adr`, `rules` | `text`, `json`          | `text`  | Terminal report or the versioned JSON envelope. No SARIF -- descriptive commands produce no findings. |

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

Accepted by `check`, `diff`, `delta`, `waivers`, `fitness`, `history`,
`health`, `report`, `debt`, `impact`, `explain`, and `context`. The judgment
(`check`, `explain`), rule-impact analysis (`diff`, `delta`), the waiver
surface (`waivers` — the rows listed are the ones the law carries), the fitness
gates (`fitness` — a named rule set may live in the same boundary file), the
evolution narrative (`history` — the captured snapshot records the fingerprint
of the law in effect), the per-metric verdicts (`health`), the composed
governance document (`report` — one law resolved once for every section, so no
two can answer from two), the debt ledger (`debt`), constraint context
(`impact`), and matching rows (`context`) all depend on which boundary law is in
effect.
`graph`, `discover`, `drift`, `reconcile`, `provenance`, and `adr` take no
`--config` because they describe structure or compare against the declared
intent, not against any boundary law — `adr` reads only the tracked
`docs/adr/` at the workspace root, so a description of what is recorded needs
no boundary law to frame it. Does not move the workspace root — the tree being
judged is still the consumer's.

## What is deliberately not configurable

There is no `languages` option. Switching a language off is indistinguishable,
in every report, from that language having no violations. Each analyzer costs
nothing in a workspace without that language, because resolution is keyed on a
manifest that is not there.
