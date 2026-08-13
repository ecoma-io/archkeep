# Boundaries

The constraint table is the whole configuration surface of the engine. Everything
else is mechanism. This page is about what to put in it, and about the five
semantics that are the opposite of what the option names suggest.

The table's shape is the same one the ESLint boundary rule uses, so that rule's
own documentation applies verbatim and is not restated here. What is here is the
part a reader gets wrong from the names alone, and the part that only matters
once the same table is judging imports across several languages.

## The model

Projects carry **tags**. The table carries **rows**. A row says: a project
carrying _this_ tag may depend on projects carrying _those_ tags, and/or may
not import _these_ external packages.

```js
export const depConstraints = [
  { sourceTag: "layer:app", onlyDependOnLibsWithTags: ["layer:domain", "layer:util"] },
];
```

Every row keys on exactly one of:

| key             | meaning                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------ |
| `sourceTag`     | a single tag — the row applies to any project carrying it                                  |
| `allSourceTags` | an array of **at least two** tags — the row applies only to a project carrying all of them |

and then takes any of four optional list fields:

| field                      | meaning                                                              |
| -------------------------- | -------------------------------------------------------------------- |
| `onlyDependOnLibsWithTags` | the target must carry at least one of these                          |
| `notDependOnLibsWithTags`  | the target must carry none of these — **and see "transitive" below** |
| `allowedExternalImports`   | an allowlist for third-party specifiers                              |
| `bannedExternalImports`    | a denylist for third-party specifiers                                |

Anything else in a row is rejected at load, naming the key. A row with an
unknown field would otherwise be a rule that matches nothing — and a constraint
matching nothing does not error, it approves.

## The five semantics that surprise people

Each of these is the upstream rule's behaviour, reproduced deliberately. Getting
any of them backwards changes which imports pass.

### 1. A project matching no row at all is a violation

Not "unrestricted". If a project's tags match no `sourceTag` and no
`allSourceTags` in the entire table, any dependency it has is reported.

Read that as the rule it is: **the table is an allowlist over projects, not just
over edges.** A new project added without tags does not slip through — it fails
on its first dependency. This is the single most useful property of the design
and the one most often mistaken for a bug.

### 2. Several matching rows are AND, not OR

A project tagged `layer:app` and `scope:checkout` is held to _both_ rows. It is
not enough to satisfy one. Rows compose, which is what makes independent axes —
layering, ownership, licensing — work as separate concerns in one table.

The practical consequence: adding a row can only ever make the workspace
stricter. There is no row you can add to grant an exemption.

### 3. `notDependOnLibsWithTags` is transitive

`onlyDependOnLibsWithTags` looks at the direct target. `notDependOnLibsWithTags`
looks at **everything the target can reach**. Importing a clean library that
itself imports a forbidden one is a violation, and the message names the
offending projects.

That asymmetry is the right way round: a "must only depend on" rule describes
an intended shape, while a "must never depend on" rule usually encodes something
that stays true through any number of hops — a GPL library, a deprecated stack,
a service you are migrating off.

### 4. `onlyDependOnLibsWithTags: []` is a rule, not an empty setting

An empty list does not mean "no restriction". It means **this project may not
depend on any library carrying tags at all**. It is the way to say "leaf".

If you meant "no restriction on this axis", omit the field.

### 5. Patterns are not globs — there are three different dialects

| where                                                               | dialect             | what it actually does                                                                                                                                          |
| ------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allow`, `checkDynamicDependenciesExceptions`                       | wildcard match      | Understands exactly three shapes — trailing `/**`, trailing `/*`, and `prefix/**/suffix`. **Anything else falls through to an unanchored regular expression.** |
| `bannedExternalImports`, `allowedExternalImports`, glob-shaped tags | glob-to-regex       | Every run of `*` becomes `.*`, and the result is anchored. Every _other_ regex metacharacter survives.                                                         |
| `ignoredCircularDependencies`                                       | word-boundary regex | Neither names nor globs: a case-insensitive word-boundary regex over project names.                                                                            |

Two consequences worth memorising:

- **`allow: ["@scope/pkg"]` is a regular expression, unanchored.** It also
  exempts `@scope/pkg-internal`, and `x@scopeYpkg`. If you mean exactly one
  package, that is not how to say it.
- **`bannedExternalImports: ["@tauri-apps/api"]` also bans `@tauri-appsXapi`**,
  because `.` still means "any character". Harmless in practice; startling when
  you first see it fire.

These are ported literally rather than approximated, precisely so that this tool
and the ESLint rule keep agreeing about which imports escape. Swapping in a glob
library would keep every simple test green and silently change the answer.

## Choosing axes that hold

Advice rather than mechanism, from watching tables age.

**Two axes beat five.** Layer and scope carry most of the value. Each additional
axis multiplies the rows a new project has to satisfy, and rows are AND — so the
fifth axis is usually the one that gets a blanket row added to make the build
pass, at which point it enforces nothing.

**Add a tag in the change that lands its first project, never before.** A
constraint whose `sourceTag` no project carries proves nothing while reading as
protection. It is indistinguishable, in every report, from a rule that works.

**Name the axis so the direction is obvious.** `layer:app` → `layer:domain` →
`layer:util` reads as a gradient; `type:frontend` and `type:core` do not, and
every reviewer has to re-derive which may import which.

**Prefer `onlyDependOnLibsWithTags` for shape and `notDependOnLibsWithTags` for
prohibitions.** They behave differently under transitivity, and using the
transitive one to express an intended shape produces failures several hops from
the code that caused them.

**Make one axis about licensing if you ship anything.** `license:gpl` in a
`notDependOnLibsWithTags` is transitive, which is exactly the semantics licence
contamination has. This is one of the few places where the surprising rule is the
one you want.

## Accepting a violation

When a violation is real and you are going to live with it anyway, it goes in
`boundarySuppressions` rather than being argued away:

```js
export const boundarySuppressions = [
  {
    path: "apps/checkout-api/internal/legacy/ledger.go",
    messageId: "onlyTagsConstraintViolation",
    reason: "Pre-split ledger call; removed by the billing extraction, tracked in #482.",
  },
];
```

- `reason` is **mandatory** and rejected if absent. An unexplained suppression is
  indistinguishable from a boundary that quietly stopped being enforced.
- `messageId` is optional but validated against the fifteen — a typo there would
  otherwise suppress nothing while reading as though it did.
- A suppression removes a **verdict**, never a failure. The file is still fully
  analyzed, and anything the analyzer could not read in it is still reported.

## Where this is enforced from

The same table is read by every surface: the CLI, the language server, and the
ESLint rule if the workspace wires it. One file, one answer. Nothing in this
engine holds a copy of a constraint, and the file lives in the workspace rather
than in the tool — which is what makes it reviewable like the code it governs.

---

- Each violation `messageId` and what fixes it → [../reference/violations.md](../reference/violations.md)
- How the table is loaded, in every dialect → [../reference/policy-schema.md](../reference/policy-schema.md)
- Architecture governance and who decides what changes → [../doctrine/architecture-governance.md](../doctrine/architecture-governance.md)
