# Boundaries

The constraint table is the whole configuration surface of this tool. Everything
else is mechanism. This page is about the model — what a boundary is, what
"allowed" means, and what "violation" means. The configuration dialects are in
[policies.md](policies.md); the exact row schema is in
[policy-schema.md](../reference/policy-schema.md).

## The three axes

Projects carry **tags**, and tags group into axes. The axes that hold are the
ones whose direction is obvious from the tag names alone.

- **Layer** — where a project sits in the dependency gradient. `layer:app` may
  depend on `layer:domain`, which may depend on `layer:util`. The direction is
  readable without a legend.
- **Scope** — which bounded context a project belongs to. `scope:checkout` may
  depend on `scope:shared`, but not on `scope:billing`. Scope controls which
  domains may reach each other.
- **License** — what licence constraints propagate through the graph.
  `license:gpl` in a `notDependOnLibsWithTags` row is transitive, which is
  exactly the semantics licence contamination has.

Two axes carry most of the value. Each additional axis multiplies the rows a new
project has to satisfy, and rows compose with AND — so the fifth axis is usually
the one that gets a blanket row added to make the build pass, at which point it
enforces nothing.

## The constraint model

A row in the table says: a project carrying _this_ tag may depend on projects
carrying _those_ tags, and/or may not import _these_ external packages.

Every row keys on exactly one of:

| key             | meaning                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `sourceTag`     | a single tag — the row applies to any project carrying it               |
| `allSourceTags` | an array of at least two tags — the row applies only if all are present |

and then takes any of four optional list fields:

| field                      | meaning                                          |
| -------------------------- | ------------------------------------------------ |
| `onlyDependOnLibsWithTags` | the target must carry at least one of these      |
| `notDependOnLibsWithTags`  | the target must carry none of these (transitive) |
| `allowedExternalImports`   | an allowlist for third-party specifiers          |
| `bannedExternalImports`    | a denylist for third-party specifiers            |

Anything else in a row is rejected at load — with two exceptions.
`description` and `remediation` are optional documentation fields that do not
affect the verdict. They appear in `context`, `explain`, `impact` and `diff`
output so a developer can understand and resolve a violation without opening
the config file directly. A row with any other unknown field would be a rule
that matches nothing — and a constraint matching nothing does not error, it
approves.

## Five semantics that surprise people

Each of these is upstream's behaviour, reproduced deliberately. Getting any of
them backwards changes which imports pass.

### 1. A project matching no row is a violation

Not "unrestricted". If a project's tags match no row at all, any dependency it
has is reported as `projectWithoutTagsCannotHaveDependencies`. The table is an
allowlist over projects, not just over edges. A new project added without tags
fails on its first dependency.

### 2. Several matching rows are AND, not OR

A project tagged `layer:app` and `scope:checkout` is held to _both_ rows.
Adding a row can only ever make the workspace stricter. There is no row you can
add to grant an exemption.

### 3. `notDependOnLibsWithTags` is transitive

`onlyDependOnLibsWithTags` looks at the direct target.
`notDependOnLibsWithTags` looks at **everything the target can reach**.
Importing a clean library that itself imports a forbidden one is a violation.

### 4. `onlyDependOnLibsWithTags: []` is a rule, not an empty setting

An empty list means "this project may not depend on any library carrying tags
at all" — reported as `emptyOnlyTagsConstraintViolation`. It is the way to say
"leaf". If you meant "no restriction on this axis", omit the field.

### 5. Patterns are not globs

There are three different pattern dialects, matching three different upstream
functions. A pattern that looks right often matches more than you think. The
dialects are documented in [policies.md](policies.md).

## What "violation" means

A violation is a verdict: the rules layer judged an import site against the
constraint table and found it disallowed. The fifteen violation types use the
same identifiers as the ESLint boundary rule. The shared vocabulary makes a
verdict searchable and lets the two engines be compared directly.

The fifteen fall into three groups by what decides them:

- **Decided on how the import is written** (5) — the specifier's own text, not
  the project graph. A relative path reaching inside another project, a banned
  external package.
- **Decided on the shape of the graph** (6) — structural facts about which
  project reached which. Cycles, apps imported by libs, transitive dependencies.
- **Decided by the constraint table** (4) — the tag axes. A project without a
  matching row, a tag combination the table forbids.

The order matters: most import sites produce at most one violation, and which
one you see depends on where the site falls in the sequence. Fix the reported
problem and a different id may appear at the same line — you have moved down
the list, not made things worse.

Each id's meaning, what produces it, and what closes it is documented in
[violations.md](../reference/violations.md).

## What "allowed" means

An import is allowed when the rules layer can reach a definite "yes" through the
constraint table. That requires:

1. The importing project's tags match at least one row.
2. Every matching row is satisfied (AND composition).
3. The import's specifier form is legal (not a relative cross-project path, not
   a banned external, etc.).
4. The target project is structurally reachable (no cycles that are not
   explicitly ignored, no app imported by a lib).

The `allow` list in the options is the escape hatch: a matching specifier is
exempt from all fifteen checks. Because its entries are unanchored regular
expressions, it is the last resort rather than the first.

## Accepting a violation

A real violation that the workspace is going to live with goes in
`boundarySuppressions`, not in an `eslint-disable` comment or a widened row:

- `reason` is mandatory. An unexplained suppression is indistinguishable from a
  boundary that quietly stopped being enforced.
- `messageId` is optional but validated against the fifteen — a typo would
  suppress nothing while reading as though it did.
- A suppression removes a **verdict**, never a failure. The file is still fully
  analyzed. You cannot use this to silence a blind spot.
