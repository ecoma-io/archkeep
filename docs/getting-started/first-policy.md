# First policy

Tag your projects, write the boundary table, run the check, see a violation.
About ten minutes, most of it spent deciding what your tags mean.

This page is technology-neutral: it works the same whether the workspace root
holds `nx.json` or `lattice.json`. The only difference is where the tags live —
`project.json` for Nx, `lattice.json` for a native workspace — and that is
called out where it matters.

## 1. Tag your projects

The boundary rules are decided entirely by tags, and the tags are yours. A
common starting pair is one axis for layering and one for ownership.

In a native workspace (`lattice.json`), tags go on the declared row or arrive
via `projectRules` — [first-project.md](first-project.md) showed both. In an
Nx workspace, tags go in `project.json`:

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
are in [boundaries.md](../concepts/boundaries.md) — read it
before you commit to a vocabulary. The most important one in advance: **a
project whose tags match no constraint row at all is a violation**, not a
project nobody restricted.

## 2. Write the boundary table

One file at the workspace root — the one `boundaryConfig` names. It exports
three things:

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
even where you want the default.** Nothing in this package defaults an option,
on purpose — a default here would be a second copy of a value your workspace
already states, and the two disagree the day one changes. What each option does
is in [boundaries.md](../concepts/boundaries.md).

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

Keep running it. It stays authoritative for JavaScript, TypeScript, and Vue;
this tool is for the languages it cannot parse. The conditions under which you
could eventually drop it are enumerated in
[`src/conformance/`](../../packages/lattice/src/conformance/README.md), and one
of the three is not met yet.

### Other dialects

A `.json` boundary file and an ESLint flat config are also valid, each with its
own trade-offs. The full comparison is
[policy-schema.md](../reference/policy-schema.md).

## 3. Run the check

```shell
pnpm exec lattice check
```

A clean tree prints what it inspected, not just that it found nothing:

```text
✔ no boundary violations (264 imports in 78 files across 12 projects)
```

Those counts are the point. "No violations" is a claim about coverage as much
as about correctness, and a run that analyzed four files would otherwise look
identical to one that analyzed four hundred.

A violation looks like this:

```text
apps/checkout-api/internal/handler/pay.go:14:2  onlyTagsConstraintViolation
  A project tagged with "scope:checkout" can only depend on libs tagged with scope:checkout, scope:shared
  import      "github.com/acme/billing-core/ledger" (static)  checkout-api → billing-core
  constraint  sourceTag scope:checkout, onlyDependOnLibsWithTags [scope:checkout, scope:shared]
```

Four things, each with a reader in mind: the `file:line:column` your terminal
turns into a link, the `messageId` (the same id ESLint reports, so a search
finds upstream's documentation), what is wrong, and — on the last line — **which
row of your config said so**, because that is the line a fix has to agree with.

The full list of message ids and what resolves each one is
[violations.md](../reference/violations.md).

## 4. Put it in CI

```shell
pnpm exec lattice check
```

Exit 0 is clean, 1 is findings — boundary violations, go.work drift, or dead
tsconfig aliases — 2 is a usage error, and **3 is "no verdict" — the run could
not look**. Do not collapse 3 into 0. That distinction is the reason this tool
can be trusted, and [ci.md](../usage/ci.md) covers it along with SARIF upload
to GitHub code scanning.

## 5. Get it in your editor

The package ships a language server, so a violation becomes a diagnostic at the
edit rather than a CI failure an hour later. Setup per client — including the
one-command install for Claude Code — is in [vscode.md](../integrations/vscode.md).

## Where to go next

- The tags you just invented will be wrong in a way that is cheap to fix now and
  expensive later — [boundaries.md](../concepts/boundaries.md)
- It reported something you disagree with — [violations.md](../reference/violations.md)
- It reported nothing and you expected something — [troubleshooting.md](../usage/troubleshooting.md)
- You want to know exactly what it reads in each language, and what it cannot —
  [languages.md](../concepts/languages.md)
- Every `lattice.json` field — [configuration.md](../reference/configuration.md)
- The boundary policy file in every dialect — [policy-schema.md](../reference/policy-schema.md)
