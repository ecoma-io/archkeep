# Policy schema

The constraint table every `boundaryConfig` file holds, regardless of dialect.
What each field contains; not what to put in it (that is
[boundaries.md](../concepts/boundaries.md)) or how to load it
(that is [policies.md](../concepts/policies.md)).

## Top-level keys

Three keys, same names in every dialect. A fourth, `$schema`, is tolerated in
the `.json` dialect but does nothing.

| key                     | type   | required | meaning                                               |
| ----------------------- | ------ | -------- | ----------------------------------------------------- |
| `depConstraints`        | array  | yes      | The constraint table.                                 |
| `moduleBoundaryOptions` | object | yes      | The eight `@nx/enforce-module-boundaries` options.    |
| `boundarySuppressions`  | array  | no       | Accepted violations. Absent means nothing suppressed. |

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

`onlyDependOnLibsWithTags: []` is a rule, not an empty setting -- it means the
project may not depend on any library carrying tags at all. If you meant "no
restriction on this axis," omit the field.

## `moduleBoundaryOptions`

All eight are required. None is defaulted -- a missing option is rejected
rather than filled in, because a default here would be a second copy of a value
the file already states.

| option                               | type     | meaning                                                                                                                  |
| ------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `allow`                              | string[] | Specifiers exempt from every check. The escape hatch of last resort. Nx's `matchImportWithWildcard` dialect.             |
| `buildTargets`                       | string[] | Which target names make a project "buildable." Read only by `enforceBuildableLibDependency`. Target names, not patterns. |
| `enforceBuildableLibDependency`      | boolean  | Whether a buildable library importing a non-buildable one is an error.                                                   |
| `allowCircularSelfDependency`        | boolean  | Whether a file may reach its own project through the project's public entry point.                                       |
| `checkDynamicDependenciesExceptions` | string[] | Specifiers whose `import()` is exempt. Nx's `matchImportWithWildcard` dialect.                                           |
| `ignoredCircularDependencies`        | string[] | Project pairs excused from the cycle check. Each entry is a `[projectA, projectB]` pair -- exact names only, no globs.   |
| `banTransitiveDependencies`          | boolean  | Whether importing a package declared in neither the project's own manifest nor the workspace root's is an error.         |
| `checkNestedExternalImports`         | boolean  | Whether `bannedExternalImports` is judged against what dependencies drag in, as well as direct imports.                  |

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

An array of `{ path, reason, messageId? }` rows.

| field       | type   | required | meaning                                                                                                         |
| ----------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------- |
| `path`      | string | yes      | Glob over the workspace-relative path of the importing file.                                                    |
| `reason`    | string | yes      | Non-empty. An unexplained suppression is indistinguishable from a boundary that stopped being enforced.         |
| `messageId` | string | no       | Narrows which check the entry covers. Validated against the fifteen violation ids -- a typo suppresses nothing. |

A suppression removes a **verdict**, never a failure. The file is still fully
analyzed, and anything the analyzer could not read in it is still reported.

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
`boundaryConfig` field instead of pointing at a filename. Same three keys as
the `.json` dialect, validated by the identical function. The language server
does not yet read this form.
