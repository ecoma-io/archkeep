# Boundary policy schema

`boundaryConfig` — an Nx workspace's `nx.json -> plugins[].options`, or a
native workspace's [configuration.md](configuration.md) field — names the file
that holds your constraint table. This page is the reference for what that file
may contain, in every form it may take.

Three dialects. All three are read by `src/config.mjs`, and all three are
validated by the exact same function — a constraint row is checked identically
whichever dialect wrote it, so nothing here can drift into a second opinion
about a malformed row.

## Choosing a dialect

Basename is checked first, before extension. A filename matching
`eslint.config.*` always selects the ESLint flat-config dialect below,
regardless of extension, and a legacy `.eslintrc*` name is always refused by
name. Only once neither of those two basenames matches does the filename's
extension decide:

| selector                   | read as                         | default                                                                |
| -------------------------- | ------------------------------- | ---------------------------------------------------------------------- |
| basename `eslint.config.*` | an ESLint flat config           | no — explicit opt-in only, lattice never probes for one                |
| basename `.eslintrc*`      | refused by name (legacy ESLint) | n/a — there is no legacy shape to read a boundary law out of           |
| extension `.mjs`, `.js`    | an ES module, `import()`ed      | yes — `module-boundaries.config.mjs` unless a workspace says otherwise |
| extension `.json`          | plain JSON, `JSON.parse`d       | no — opt in by naming a `.json` file                                   |

Any other extension is refused by name, in a message that does not say "cannot
load" — a `boundaryConfig` pointed at a `.yaml` or `.toml` file is a naming
mistake, not a missing or unreadable file, and the two read as different
problems on purpose.

There is no codemod between any of these, and none is planned: a workspace
picks the dialect that fits how it already writes configuration and keeps it.

## The `.mjs` / `.js` dialect

The default: a plain ES module exporting up to three names:

```js
export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
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

Being a real ES module, it may export other names too — a shared constant, a
helper the constraint table is built from. The loader reads exactly the three
names above and ignores the rest; an ES module's exports are a namespace a file
is free to share, so an extra export is not treated as a mistake.

In a TypeScript workspace, this is the same file `eslint.config.mjs` feeds to
`@nx/enforce-module-boundaries` — point `boundaryConfig` at it directly, or
keep the two in step by hand.

## The `.json` dialect

A plain JSON object, read with `JSON.parse` — never JSONC, never `import()`.
No comments, no trailing commas: a `.json` boundary file carries no more syntax
than the format it declares itself to be.

```json
{
  "depConstraints": [{ "sourceTag": "layer:domain", "onlyDependOnLibsWithTags": ["layer:domain"] }],
  "moduleBoundaryOptions": {
    "allow": [],
    "buildTargets": ["build"],
    "enforceBuildableLibDependency": false,
    "allowCircularSelfDependency": false,
    "checkDynamicDependenciesExceptions": [],
    "ignoredCircularDependencies": [],
    "banTransitiveDependencies": false,
    "checkNestedExternalImports": false
  },
  "boundarySuppressions": []
}
```

Exactly three top-level keys are recognized — `depConstraints`,
`moduleBoundaryOptions`, `boundarySuppressions` — plus one that is tolerated
but does nothing: `$schema`, the key an editor writes in unasked for IDE
validation. Any other top-level key is **rejected by name.**

That is deliberately asymmetric with the `.mjs` dialect's tolerance for extra
exports above. A JSON object has no namespace to share the way an ES module
does, so an unrecognized key here is almost always a typo
(`"depConstraint"` for `"depConstraints"`) rather than a deliberate export,
and the `.mjs` dialect's leniency would let that typo pass in silence — the
constraint table would simply not be there, and the run would report a clean
tree over a law that was never read.

## The three keys

Every dialect holds the same three things, under the same names — only the
syntax (or, for the ESLint dialect, the surrounding rule entry) around them
changes:

- **`depConstraints`** — the constraint table: which `sourceTag`/`allSourceTags`
  may depend on which. Each row is an object with at least `sourceTag` and one
  of `onlyDependOnLibsWithTags` or `notDependOnLibsWithTags`. See
  [boundaries.md](../concepts/boundaries.md) for how to pick tags that hold and
  rows that mean something.

- **`moduleBoundaryOptions`** — the eight `@nx/enforce-module-boundaries`
  options, all eight required, none defaulted here:

  | option                               | type     | meaning                                                    |
  | ------------------------------------ | -------- | ---------------------------------------------------------- |
  | `allow`                              | string[] | Specifiers exempt from all checks.                         |
  | `buildTargets`                       | string[] | Target names that make a project "buildable."              |
  | `enforceBuildableLibDependency`      | boolean  | Reject non-buildable deps from buildable libs.             |
  | `allowCircularSelfDependency`        | boolean  | Allow a project to import from its own public entry point. |
  | `checkDynamicDependenciesExceptions` | string[] | Specifiers exempt from the lazy-load check.                |
  | `ignoredCircularDependencies`        | string[] | Exact project names whose cycle is accepted.               |
  | `banTransitiveDependencies`          | boolean  | Reject undeclared transitive npm/crate/PyPI deps.          |
  | `checkNestedExternalImports`         | boolean  | Reject banned packages dragged in by a dependency.         |

  A missing option is rejected rather than defaulted — a default here would be
  a second copy of a value this file already states, and the two would disagree
  the day one of them changed. (The ESLint dialect is the one exception — see
  below, where the default comes from the workspace's own installed plugin
  rather than from this file.)

- **`boundarySuppressions`** — optional; absent means "nothing is suppressed."
  Each entry is `{ path, reason, messageId? }`: a glob over the
  workspace-relative path of the importing file, a **mandatory** non-empty
  reason, and an optional violation id to narrow which check the entry covers.
  A suppression with no reason is rejected outright — see
  [violations.md](violations.md) for the id vocabulary `messageId` draws from.
  The ESLint dialect has no equivalent table at all — see below.

## Reading the law out of an ESLint flat config

A workspace that already runs `@nx/enforce-module-boundaries` under ESLint's
flat config can point `boundaryConfig` at that file directly instead of
maintaining a second, `.mjs` copy of the same table:

```json
"plugins": [
  {
    "plugin": "@ecoma-io/lattice/nx",
    "options": { "boundaryConfig": "eslint.config.mjs" }
  }
]
```

Selection is by **basename**, not extension, and it is explicit opt-in only —
lattice never probes for an ESLint config on its own. A file named
`eslint.config.mjs`, `eslint.config.js`, or any other extension after
`eslint.config.` is read through this dialect, and that basename check runs
BEFORE the `.mjs`/`.js`/`.json` extension dispatch above. A file named
`.eslintrc.*` (ESLint's legacy config format) is refused by name for the
identical reason — checked before the extension dispatch too — loudly, before
lattice ever tries to import it: `@nx/enforce-module-boundaries` itself only
runs under flat config, so there is no legacy shape to read a boundary law out
of.

Lattice reads the flat config's default export as an array, finds the entry
that configures `@nx/enforce-module-boundaries`, and takes `depConstraints`
off its options exactly like the `.mjs` dialect does. Any option the entry does
not state is filled in from the workspace's own installed `@nx/eslint-plugin`
— its rule's own declared defaults, not a table kept here — so a workspace
that never wrote out all eight `moduleBoundaryOptions` still gets the same
answer ESLint itself would compute.

`boundarySuppressions` has no equivalent under this dialect. An ESLint flat
config has no comparable table, and lattice does not invent one — an
`eslint.config.*` `boundaryConfig` always reports an empty suppression list.

### What this reads exactly like ESLint, and what it refuses instead of guessing

- **The rule must be on, with options that state `depConstraints`.** A rule that
  is absent, or set to `"off"`/`0` (bare or as the first element of an array),
  is refused rather than read as an empty, fully-permissive table. So is a rule
  that IS on but whose options carry no `depConstraints` key at all: reading an
  unstated table as an empty one would report a clean tree over an entry that
  never said what it enforces. `"warn"`/`1` is read the same as `"error"`/`2`.

- **The last unscoped entry wins**, exactly as ESLint itself binds a rule
  configured more than once. If two or more unscoped entries configure the rule
  differently, lattice notes which one it used rather than silently picking one.

- **A `files`-scoped entry is refused, by name — unless every glob it lists is
  a bare source-extension pattern with no directory component** (`**/*.ts`,
  `**/*.tsx`, `**/*.js`, `**/*.jsx` — the exact shape `nx g @nx/eslint` itself
  emits). ESLint applies a scoped entry only to the files its glob matches, and
  a checker that is not ESLint cannot replicate that scoping. A glob with a
  directory component (`apps/**/*.ts`) states which part of the tree the law
  covers and stays refused; a bare extension glob states only which languages
  ESLint parses, so lattice applies the table tree-wide instead. Brace expansion
  (`**/*.{ts,tsx}`) is not treated as the same shape and is refused as scoped.

- **`@nx/eslint-plugin` must actually resolve from the config's own location.**
  If it does not, lattice refuses rather than falling back to a hand-kept table
  of its own — a copy that would drift the day the installed plugin's defaults
  changed upstream. Resolving and loading are reported as two distinct causes: a
  plugin that is simply not installed reads differently from one that resolves
  but throws while its own entry point runs.

- **An import that throws is reported with its cause**, not swallowed into a
  bare "could not load" — a flat config that reads another file at import time
  fails the same way it would under `eslint` itself.

### What it cannot see

This dialect reads the _static_ shape of the exported array. It does not run
ESLint, so a handful of things ESLint itself resolves at run time are outside
what it can answer:

- **Options computed at run time** — anything built from a function call,
  environment variable, or conditional inside the config file rather than
  written as a literal — are read as whatever that expression evaluates to when
  the config module is imported, exactly once.
- **Per-file-glob law** — a `files`-scoped entry configuring the rule
  differently for part of the tree is refused outright, not approximated.
- **`eslint-disable` comments** are invisible. A source file suppressing the
  rule inline is a lint-time mechanism; this dialect only ever reads the config
  file, never the sources.
- **`extends`/preset chains are followed only if the config itself resolves
  them before exporting the array** — the same way any other import in the file
  would be.
- **Overrides an Nx generator applies at run time** are not observable from
  the source file.
- **An `ignores` key on the winning entry is disregarded.** The constraint
  table is applied to files an `ignores` list would have excluded. That is the
  over-reporting direction — loud rather than silent — so it is a stated limit,
  not a refusal.

**The language server does not read this dialect yet.** `cli.mjs` and the
Nx-plugin face both do; the editor face refuses an `eslint.config.*` or
`.eslintrc*` `boundaryConfig` by name. Point `boundaryConfig` at an `.mjs`,
`.js`, or `.json` boundary-law file to use it from an editor; see "An inline
policy" below for the one other spelling the language server also does not read.

## An inline policy, for `lattice.json`

A native workspace's `boundaryConfig` field may hold the policy object directly
instead of a filename — no separate file at all. It takes the same three keys
as the `.json` dialect above (with no `$schema` carve-out; there is no file for
an editor to validate against) and is validated by the identical function.
[configuration.md](configuration.md)'s `boundaryConfig` / `tsConfig` section
is the reference for that shape. The CLI reads this form fine, but the language
server does not yet: it only ever loads a policy _file_ to watch and re-read,
so it refuses to start over a workspace whose `boundaryConfig` is inline rather
than a filename — move the policy into its own `.mjs` or `.json` file to use
it from an editor.

## See also

- [configuration.md](configuration.md) — `lattice.json`'s own fields, including the inline form above
- [violations.md](violations.md) — each violation `messageId` may name
- [cli.md](cli.md) — command-line syntax and `--config`
- [exit-codes.md](exit-codes.md) — what each exit code means
