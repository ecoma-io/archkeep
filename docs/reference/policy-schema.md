# Policy schema

The constraint table every `boundaryConfig` file holds, regardless of dialect.
What each field contains; not what to put in it (that is
[boundaries.md](../concepts/boundaries.md)) or how to load it
(that is [policies.md](../concepts/policies.md)).

## Top-level keys

Four keys, same names in every dialect. A fifth, `$schema`, is accepted in the
`.json` dialect (file or inline) for editor validation, and must be a non-empty
string.

| key                     | type   | required | meaning                                                           |
| ----------------------- | ------ | -------- | ----------------------------------------------------------------- |
| `depConstraints`        | array  | yes      | The constraint table.                                             |
| `moduleBoundaryOptions` | object | yes      | The eight `@nx/enforce-module-boundaries` options.                |
| `boundarySuppressions`  | array  | no       | Accepted violations. Absent means nothing suppressed.             |
| `fitness`               | array  | no       | Named quality gates judged every run. Absent means none declared. |

Any other key is rejected by name in every dialect that reads this table — the
`.mjs`/`.js` module's extra exports included, so a misspelled key cannot load
exit-0 and disappear ([policies.md](../concepts/policies.md), "The ES module
dialect").

## `depConstraints`

An array of rows. Each row keys on exactly one of two identifying fields, then
takes up to four optional list fields. Any other key in a row is rejected at
load, naming the key.

### Identifying fields (exactly one per row)

| field           | type     | meaning                                                                         |
| --------------- | -------- | ------------------------------------------------------------------------------- |
| `sourceTag`     | string   | The row applies to any project carrying this tag.                               |
| `allSourceTags` | string[] | The row applies only to a project carrying **all** of these tags. At least two. |

### Constraint fields (optional, zero to four per row)

| field                      | type     | meaning                                                                 |
| -------------------------- | -------- | ----------------------------------------------------------------------- |
| `onlyDependOnLibsWithTags` | string[] | The target must carry at least one of these.                            |
| `notDependOnLibsWithTags`  | string[] | The target must carry **none** of these -- transitive, not just direct. |
| `allowedExternalImports`   | string[] | Allowlist for third-party specifiers.                                   |
| `bannedExternalImports`    | string[] | Denylist for third-party specifiers.                                    |

`bannedExternalImports` judges every specifier that leaves the workspace, and
Node's built-in modules are among them: a row banning `*` reports `node:fs` the
same way it reports an installed package. `banTransitiveDependencies` is the
option that exempts built-ins, and it is a different question -- a built-in has
no manifest entry to be missing from, so counting it as an undeclared transitive
dependency would report every workspace. A row meant to keep frameworks out of a
layer without touching the standard library names the packages, or their scope,
rather than `*`.

### Documentation fields (optional)

| field         | type   | meaning                                                                                               |
| ------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| `description` | string | What this constraint row enforces and why. Shown in `context`, `explain`, `impact` and `diff` output. |
| `remediation` | string | How to fix a violation of this row. Shown alongside the description.                                  |

These fields are optional and do not affect the verdict. They exist so that a
developer reading `lattice context`, `lattice explain`, or the constraint-context
sections of `impact` and `diff` can understand both what the rule means and how
to bring their import back into compliance without consulting the config file
directly.

### Governance block (optional)

A row may carry the shared governance block — `origin`, `rationale`,
`decisionRef`, `fitnessBindings` — the same four keys an intent row may carry,
validated by the one shared schema ([provenance.md](../concepts/provenance.md)
owns the block). A `decisionRef` names the recorded architecture decision the
row leans on: `lattice adr <id>` reads it, and a reference that resolves to
nothing is `unknown`, never a pass. A row without the block is a legacy row and
stays valid byte-identical.

`onlyDependOnLibsWithTags: []` is a rule, not an empty setting -- it means the
project may not depend on any library carrying tags at all. If you meant "no
restriction on this axis," omit the field.

## `moduleBoundaryOptions`

All eight are required. None is defaulted -- a missing option is rejected
rather than filled in, because a default here would be a second copy of a value
the file already states.

| option                               | type     | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `allow`                              | string[] | Specifiers exempt from every check. The escape hatch of last resort. Nx's `matchImportWithWildcard` dialect.                                                                                                                                                                                                                                                                                                                                                 |
| `buildTargets`                       | string[] | Which target names make a project "buildable." Read only by `enforceBuildableLibDependency`. Exact target names — an entry carrying glob syntax is refused at load (a pattern can never match an exact name), and when the option is on, an entry that matches no target declared by any project is refused by every evaluating command (`check`, `explain`, `graph`, the language server — not just the checker), never silently read as selecting nothing. |
| `enforceBuildableLibDependency`      | boolean  | Whether a buildable library importing a non-buildable one is an error.                                                                                                                                                                                                                                                                                                                                                                                       |
| `allowCircularSelfDependency`        | boolean  | Whether a file may reach its own project through the project's public entry point.                                                                                                                                                                                                                                                                                                                                                                           |
| `checkDynamicDependenciesExceptions` | string[] | Specifiers whose `import()` is exempt. Nx's `matchImportWithWildcard` dialect.                                                                                                                                                                                                                                                                                                                                                                               |
| `ignoredCircularDependencies`        | string[] | Project pairs excused from the cycle check. Each entry is a `[projectA, projectB]` pair -- exact names only, no globs.                                                                                                                                                                                                                                                                                                                                       |
| `banTransitiveDependencies`          | boolean  | Whether importing a package declared in neither the project's own manifest nor the workspace root's is an error.                                                                                                                                                                                                                                                                                                                                             |
| `checkNestedExternalImports`         | boolean  | Whether `bannedExternalImports` is judged against what dependencies drag in, as well as direct imports.                                                                                                                                                                                                                                                                                                                                                      |

### Pattern dialects

The three pattern-matching dialects are not interchangeable. Using the wrong one
matches more than intended, and the tests pass anyway.

| where                                                               | dialect                        | what it actually does                                                                                                                                              |
| ------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `allow`, `checkDynamicDependenciesExceptions`                       | Nx's `matchImportWithWildcard` | Understands exactly three shapes -- trailing `/**`, trailing `/*`, and `prefix/**/suffix`. **Anything else falls through to an unanchored `new RegExp(pattern)`.** |
| `bannedExternalImports`, `allowedExternalImports`, glob-shaped tags | Nx's `mapGlobToRegExp`         | Every run of `*` becomes `.*`, and the result is anchored. Every other regex metacharacter survives.                                                               |
| `ignoredCircularDependencies`                                       | Nx's `findMatchingProjects`    | Neither names nor globs: a case-insensitive word-boundary regex over project names.                                                                                |

These are ported literally so that this tool and ESLint keep agreeing about
which imports escape.

## `boundarySuppressions`

An array of `{ path, reason, messageId?, expiresAt?, origin? }` rows.

| field       | type   | required | meaning                                                                                                                                                                                                   |
| ----------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`      | string | yes      | Glob over the workspace-relative path of the importing file, matched with `path.posix.matchesGlob` and capped at 512 brace-driven alternatives -- see [configuration.md](configuration.md#projectsinfer). |
| `reason`    | string | yes      | Non-empty. An unexplained suppression is indistinguishable from a boundary that stopped being enforced.                                                                                                   |
| `messageId` | string | no       | Narrows which check the entry covers. Validated against the engine's violation ids -- a typo suppresses nothing.                                                                                          |
| `expiresAt` | string | no       | Makes the row a **waiver** instead of a suppression. A parseable ISO-8601 instant. An expired waiver re-asserts the violation it covered. See [waivers.md](../concepts/waivers.md).                       |
| `origin`    | string | no       | Non-empty. Where the row came from -- a ticket id, a decision record. Never shown in a verdict, only in the waiver's surface and the acceptance report.                                                   |

A row with **no** `expiresAt` is a suppression and removes the violation from
the run's findings -- the existing behavior. A row **with** `expiresAt` is a
waiver: the violation stays in the findings (exit code stays 1), marked
accepted until that instant, and re-asserts in full with the evidence
`"expired waiver"` once the instant passes. A waiver is judged at epoch-ms
precision against the shared governance clock, so `now === expiresAt` is
already expired.

A suppression removes a **verdict**, never a failure. The file is still fully
analyzed, and anything the analyzer could not read in it is still reported.

## `fitness`

An array of named quality-gate rows. Each row judges one condition over the
projects its `match` selects, on every run.

| field       | type     | required | meaning                                                                                                                                                   |
| ----------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`      | string   | yes      | Letters, digits, `-` and `_` only -- no `:` (so a name can never collide with a selector label). Unique across the list.                                  |
| `match`     | string[] | yes      | Non-empty list of project selectors (`name:x`, `tag:x`, `directory:x`, `*`, `!`). Zero selected projects is `not_applicable`, loudly.                     |
| `condition` | object   | yes      | One condition type plus its fields. See the table below.                                                                                                  |
| `reason`    | string   | yes      | Non-empty. A fitness function is a policy decision, and one with no reason written down is indistinguishable from a policy that quietly stopped applying. |

An empty list is rejected -- a list present but empty reads as policy while
deciding nothing. Unknown keys in a row, a duplicate name, or an ill-formed
`condition` are rejected at load, naming the key.

### Conditions

| `type`                                        | fields                       | verdict contract                                                                                                                                                                                  |
| --------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cycle-free`                                  | —                            | `pass` when the matched subgraph has no dependency cycle.                                                                                                                                         |
| `layer-dependency`                            | `from`, `to`, `direction`    | `direction` is `forbidden` (no edge from `from` to `to`) or `required` (at least one). A tag no matched project carries is `unknown`, never `pass` or `fail`.                                     |
| `tag-conformance`                             | `from`, `to`, `toDependents` | `toDependents` is `only` (edges from `from` may target only `to`) or `never` (may not target `to`).                                                                                               |
| `coverage-minimum`                            | `statement`                  | At least `statement` percent of the matched projects' analyzable owned files were analyzed. Zero owned files is `unknown`; a path-scoped run is `not_applicable` — it needs a full, unscoped run. |
| `boundary-suppression-count-within-threshold` | `max`                        | The number of accepted `boundarySuppressions` is at most `max`.                                                                                                                                   |
| `drift-free`                                  | —                            | `pass` when the declared architecture intent judges clean; no intent file or a no-verdict intent is `unknown`.                                                                                    |

`from`/`to` are non-empty tag values; `direction` is one of
`forbidden`/`required`; `toDependents` is one of `only`/`never`; `statement` is
a percentage between 0 and 100; `max` is a non-negative integer.

The verdict semantics and the two faces (`lattice fitness` and `check`'s fold)
live in [fitness-functions.md](../concepts/fitness-functions.md).

## Three dialects

All three are validated by the same function. A constraint row is checked
identically whichever dialect wrote it.

| dialect               | selector                   | read as                                             | `boundarySuppressions`       | `moduleBoundaryOptions` defaults                              |
| --------------------- | -------------------------- | --------------------------------------------------- | ---------------------------- | ------------------------------------------------------------- |
| `.mjs` / `.js` module | extension                  | ES module, `import()`ed                             | supported                    | none -- all eight required                                    |
| `.json`               | extension                  | plain JSON, `JSON.parse`d (never JSONC)             | supported                    | none -- all eight required                                    |
| ESLint flat config    | basename `eslint.config.*` | flat config's `@nx/enforce-module-boundaries` entry | not supported (always empty) | filled from the workspace's own installed `@nx/eslint-plugin` |

The ESLint dialect is explicit opt-in only -- lattice never probes for one.
Legacy `.eslintrc*` names are refused by name. Basename is checked before
extension. For the conceptual overview of what policies are and how they relate
to the Nx ecosystem, see [policies.md](../concepts/policies.md).

### Inline policy (`lattice.json` only)

A native workspace may hold the policy object directly on `lattice.json`'s
`boundaryConfig` field instead of pointing at a filename. Same four keys as
the `.json` dialect, validated by the identical function — `$schema` included,
accepted and checked the same way a `.json` policy file accepts it. Every face
reads it: the CLI, the Nx hook, and the language server, which re-reads
`lattice.json` on every invalidation and so sees an edited inline law exactly
as it sees an edited policy file.
