# Getting started

From an Nx workspace with no boundary enforcement outside TypeScript to a
violation on your screen. About ten minutes, most of it spent deciding what your
tags mean.

## Before you start

|            |                                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node       | ≥ 22                                                                                                                                                                                                                                             |
| Nx         | ≥ 21, and it must be the workspace's own — it is a peer dependency, so the graph read here is the one your `nx` command builds                                                                                                                   |
| TypeScript | ≥ 5 and < 7. Required even in a workspace with no TypeScript in it: `ts.resolveModuleName` is what resolves JS/TS specifiers, and the upper bound is there because TypeScript 7's entry point exports none of the compiler API this delegates to |
| Vue        | optional, ≥ 3 — needed only if you have `.vue` files, and loaded lazily so a workspace without it pays nothing                                                                                                                                   |

You do **not** need Go, Cargo or uv installed. Nothing here shells out to a
toolchain; manifests are parsed as data. That is what lets the graph compute on a
lint-only CI runner.

## 1. Install

```shell
pnpm add -D @ecoma-io/lattice
```

## 2. Register the plugin

In `nx.json`:

```json
{
  "plugins": ["@ecoma-io/lattice/nx"]
}
```

That is enough if your workspace uses the Nx conventions. If it renamed either
file the plugin reads, say so:

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

Those two values are the defaults. There are no other options, and an unknown
key **throws** rather than falling back — a `tsconfigBase` typed for `tsConfig`
that quietly used the default would give you a full green run against a rule
nobody wrote.

Confirm the plugin loaded and is contributing edges:

```shell
pnpm exec nx graph --file=graph.json
```

A Go project that imports a sibling's module path should now show that sibling
in its dependencies. If it does not, [troubleshooting.md](troubleshooting.md)
starts with that case.

## 3. Tag your projects

The boundary rules are decided entirely by tags, and the tags are yours. A common
starting pair is one axis for layering and one for ownership:

```jsonc
// apps/checkout-api/project.json
{
  "name": "checkout-api",
  "tags": ["layer:app", "scope:checkout"],
}
```

```jsonc
// libs/billing-core/project.json
{
  "name": "billing-core",
  "tags": ["layer:domain", "scope:billing"],
}
```

Two things about tags that are easy to get wrong and expensive to discover late
are in [designing-boundaries.md](designing-boundaries.md) — read it before you
commit to a vocabulary. The most important one in advance: **a project whose tags
match no constraint row at all is a violation**, not a project nobody restricted.

## 4. Write the boundary table

One file at the workspace root — the one `boundaryConfig` names. It exports three
things:

```js
// module-boundaries.config.mjs

export const depConstraints = [
  { sourceTag: "layer:app", onlyDependOnLibsWithTags: ["layer:domain", "layer:util"] },
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain", "layer:util"] },
  { sourceTag: "layer:util", onlyDependOnLibsWithTags: ["layer:util"] },
  { sourceTag: "scope:checkout", onlyDependOnLibsWithTags: ["scope:checkout", "scope:shared"] },
  { sourceTag: "scope:billing", onlyDependOnLibsWithTags: ["scope:billing", "scope:shared"] },
  { sourceTag: "scope:shared", onlyDependOnLibsWithTags: ["scope:shared"] },
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

`depConstraints` is `@nx/enforce-module-boundaries`' own option, in its own
shape. That is deliberate: in a workspace that already runs the ESLint rule, the
same file can feed both, and there is one table rather than two that drift.

`moduleBoundaryOptions` is the rule's eight non-table options. **Write all eight
even where you want the default.** Nothing in this package defaults an option, on
purpose — a default here would be a second copy of a value your workspace already
states, and the two disagree the day one changes. What each option does is in
[designing-boundaries.md](designing-boundaries.md).

`boundarySuppressions` is where an accepted violation goes, and `reason` is
mandatory on every entry. Keep the empty array rather than deleting it: an empty
list is the rule satisfied; an absent list is the rule having nowhere to live
when the first exemption is proposed.

### If you already run `@nx/enforce-module-boundaries`

Point it at the same file so the two enforcers answer from one table:

```js
// eslint.config.mjs
import { depConstraints, moduleBoundaryOptions } from "./module-boundaries.config.mjs";

export default [
  {
    rules: {
      "@nx/enforce-module-boundaries": ["error", { ...moduleBoundaryOptions, depConstraints }],
    },
  },
];
```

Keep running it. It stays authoritative for JavaScript, TypeScript and Vue; this
tool is for the languages it cannot parse. The conditions under which you could
eventually drop it are enumerated in
[`src/conformance/`](../../packages/lattice/src/conformance/README.md),
and one of the three is not met yet.

## 5. Run the check

```shell
pnpm exec lattice check
```

A clean tree prints what it inspected, not just that it found nothing:

```text
✔ no boundary violations (264 imports in 78 files across 12 projects)
```

Those counts are the point. "No violations" is a claim about coverage as much as
about correctness, and a run that analyzed four files would otherwise look
identical to one that analyzed four hundred.

A violation looks like this:

```text
apps/checkout-api/internal/handler/pay.go:14:2  onlyTagsConstraintViolation
  A project tagged with "scope:checkout" can only depend on libs tagged with scope:checkout, scope:shared
  import      "github.com/acme/billing-core/ledger" (static)  checkout-api → billing-core
  constraint  sourceTag scope:checkout, onlyDependOnLibsWithTags [scope:checkout, scope:shared]
```

Four things, each with a reader in mind: the `file:line:column` your terminal
turns into a link, the `messageId` (the same id ESLint reports, so a search finds
upstream's documentation), what is wrong, and — on the last line — **which row of
your config said so**, because that is the line a fix has to agree with.

The full list of message ids and what resolves each one is
[violations.md](violations.md).

## 6. Put it in CI

```shell
pnpm exec lattice check
```

Exit 0 is clean, 1 is findings — boundary violations, go.work drift, or dead
tsconfig aliases — 2 is a usage error, and **3 is "no verdict" — the run could
not look**. Do not collapse 3 into 0. That distinction is the
reason this tool can be trusted, and [ci.md](ci.md) covers it along with SARIF
upload to GitHub code scanning.

## 7. Get it in your editor

The package ships a language server, so a violation becomes a diagnostic at the
edit rather than a CI failure an hour later. Setup per client — including the
one-command install for Claude Code — is [editors.md](editors.md).

## Where to go next

- The tags you just invented will be wrong in a way that is cheap to fix now and
  expensive later → [designing-boundaries.md](designing-boundaries.md)
- It reported something you disagree with → [violations.md](violations.md)
- It reported nothing and you expected something → [troubleshooting.md](troubleshooting.md)
- You want to know exactly what it reads in each language, and what it cannot →
  [languages.md](languages.md)
