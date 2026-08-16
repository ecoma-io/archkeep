# Your first policy

Write a constraint table and see a violation. This page is about the boundary
law itself -- which tags may depend on which -- regardless of whether the
workspace uses Nx or the native provider.

## The constraint table

One file at the workspace root -- the one `boundaryConfig` names -- holds the
law. It exports three things:

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

### `depConstraints`

`depConstraints` is `@nx/enforce-module-boundaries`' own option, in its own
shape. That is deliberate: in a workspace that already runs the ESLint rule, the
same file can feed both, and there is one table rather than two that drift.

Each row matches a `sourceTag` and lists the tags a project carrying that source
tag may depend on. Two things that are easy to get wrong:

- **A project whose tags match no row at all is a violation**, not a project
  nobody restricted. Every tag in your vocabulary must appear as a `sourceTag`
  somewhere in the table.
- **`allSourceTags`** matches only when every tag listed is present, while
  `sourceTag` matches when any one is. The difference is the difference between
  "layer:app AND scope:checkout" and "layer:app OR scope:checkout".
  [../concepts/boundaries.md](../concepts/boundaries.md) owns
  that distinction and the rest of the tag design guidance.

### `moduleBoundaryOptions`

The rule's eight non-table options. **Write all eight even where you want the
default.** Nothing in this package defaults an option, on purpose -- a default
here would be a second copy of a value your workspace already states, and the two
disagree the day one changes. What each option does is in
[../concepts/boundaries.md](../concepts/boundaries.md).

### `boundarySuppressions`

Where an accepted violation goes, and `reason` is mandatory on every entry. A
row with an `expiresAt` is a waiver — an acceptance with a deadline, which
re-asserts when it lapses; without one it is a permanent suppression. Keep the
empty array rather than deleting it: an empty list is the rule satisfied; an
absent list is the rule having nowhere to live when the first exemption is
proposed.

## Run the check

```shell
pnpm exec lattice check
```

A clean tree prints what it inspected, not just that it found nothing:

```text
no boundary violations (264 imports in 78 files across 12 projects)
```

Those counts are the point. "No violations" is a claim about coverage as much as
about correctness, and a run that analyzed four files would otherwise look
identical to one that analyzed four hundred.

## Read a violation

A violation looks like this:

```text
apps/checkout-api/internal/handler/pay.go:14:2  onlyTagsConstraintViolation
  A project tagged with "scope:checkout" can only depend on libs tagged with scope:checkout, scope:shared
  import      "github.com/acme/billing-core/ledger" (static)  checkout-api -> billing-core
  constraint  sourceTag scope:checkout, onlyDependOnLibsWithTags [scope:checkout, scope:shared]
```

Four things, each with a reader in mind: the `file:line:column` your terminal
turns into a link, the `messageId` (the same id ESLint reports, so a search
finds upstream's documentation), what is wrong, and -- on the last line --
**which row of your config said so**, because that is the line a fix has to
agree with.

The full list of message ids and what resolves each one is
[../reference/violations.md](../reference/violations.md).

## If you already run `@nx/enforce-module-boundaries`

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
`src/conformance/`,
and one of the three is not met yet.

## Other dialects

`.mjs` is the default. Two others exist, selected by filename:

- `.json` -- plain JSON, no comments, no trailing commas. Same three keys.
- `eslint.config.*` -- reads the constraint table out of an ESLint flat config's
  `@nx/enforce-module-boundaries` entry directly, so the file you already have
  is the file Lattice reads.

A native workspace can also write the policy inline in `lattice.json` rather
than as a separate file.

The full reference for all four spellings, including what each one cannot see,
is [../concepts/policies.md](../concepts/policies.md).

## Next

- What to put in the constraint table, and how to pick tags that hold:
  [../concepts/boundaries.md](../concepts/boundaries.md)
- Each violation `messageId` may name: [../reference/violations.md](../reference/violations.md)
- The exit codes and SARIF output in a pipeline: [../usage/ci.md](../usage/ci.md)
- Diagnostics at the edit, per client: [../integrations/vscode.md](../integrations/vscode.md)
