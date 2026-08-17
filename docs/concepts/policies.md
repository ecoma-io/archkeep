# Policy dialects

One constraint table, three ways to write it. All three are read by the same
loader and validated by the same function — a constraint row is checked
identically whichever dialect wrote it, so nothing here can drift into a second
opinion about a malformed row.

What to put in the constraint table is documented in
[boundaries.md](boundaries.md) and
[policy-schema.md](../reference/policy-schema.md). This page is about
the file formats only.

## Choosing a dialect

Basename is checked first, before extension. A filename matching `eslint.config.*`
always selects the ESLint flat-config dialect, and a legacy `.eslintrc*` name is
always refused. Only once neither basename matches does the extension decide:

| selector                   | read as                    | default                              |
| -------------------------- | -------------------------- | ------------------------------------ |
| basename `eslint.config.*` | an ESLint flat config      | no — explicit opt-in only            |
| basename `.eslintrc*`      | refused (legacy ESLint)    | n/a                                  |
| extension `.mjs`, `.js`    | an ES module, `import()`ed | yes — `module-boundaries.config.mjs` |
| extension `.json`          | plain JSON, `JSON.parse`d  | no — opt in by naming a `.json` file |

Any other extension is refused by name, in a message that does not say "cannot
load" — a `boundaryConfig` pointed at a `.yaml` or `.toml` file is a naming
mistake, not a missing file.

There is no codemod between dialects, and none is planned: a workspace picks the
one that fits how it already writes configuration and keeps it.

## The four keys

Every dialect holds the same things, under the same names — only the syntax
around them changes:

- **`depConstraints`** — the constraint table. Which `sourceTag`/`allSourceTags`
  may depend on which. A row may also carry the shared governance block
  (`origin`, `rationale`, `decisionRef`, `fitnessBindings`) — [provenance.md](provenance.md)
  owns those keys.
- **`moduleBoundaryOptions`** — the eight options (`allow`, `buildTargets`,
  `enforceBuildableLibDependency`, `allowCircularSelfDependency`,
  `checkDynamicDependenciesExceptions`, `ignoredCircularDependencies`,
  `banTransitiveDependencies`, `checkNestedExternalImports`). All eight are
  required, none defaulted — a default would be a second copy of a value the
  workspace already states.
- **`boundarySuppressions`** — optional; absent means nothing is suppressed.
  Each entry is `{ path, reason, messageId?, expiresAt?, origin? }`. A row with
  an `expiresAt` is a **waiver** — an acceptance with a deadline — whose
  lifecycle [waivers.md](waivers.md) owns; without one it is a permanent
  suppression.
- **`fitness`** — optional; absent means no named quality gates are declared.
  Each row is `{ name, match, condition, reason }` — a fitness gate cannot
  carry a `decisionRef`. See [fitness-functions.md](fitness-functions.md).

## The ES module dialect (`.mjs` / `.js`)

The default. A plain ES module exporting up to four names:

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
export const fitness = [];
```

Being a real ES module, it may export other names too — a shared constant, a
helper the table is built from. The loader reads exactly the four names above
and ignores the rest.

## The JSON dialect (`.json`)

A plain JSON object, read with `JSON.parse` — never JSONC, never `import()`.
No comments, no trailing commas.

Exactly four top-level keys are recognized — `depConstraints`,
`moduleBoundaryOptions`, `boundarySuppressions`, `fitness` — plus `$schema`,
which is tolerated but does nothing. Any other top-level key is **rejected by
name.**

That is deliberately asymmetric with the ES module dialect's tolerance for extra
exports. A JSON object has no namespace to share, so an unrecognized key is
almost always a typo (`"depConstraint"` for `"depConstraints"`) rather than a
deliberate export, and the module dialect's leniency would let that typo pass in
silence.

## The ESLint flat-config dialect

A workspace that already runs `@nx/enforce-module-boundaries` under ESLint's
flat config can point `boundaryConfig` at that file directly instead of
maintaining a second copy of the same table. Selection is by basename and is
explicit opt-in only.

The loader reads the flat config's default export as an array, finds the entry
that configures `@nx/enforce-module-boundaries`, and takes `depConstraints` off
its options. Any option the entry does not state is filled in from the
installed ESLint boundary plugin — its rule's own declared defaults, not a table
kept here.

`boundarySuppressions` has no equivalent under this dialect. An ESLint flat
config has no comparable table, and this tool does not invent one.

### What this dialect refuses instead of guessing

- A rule that is absent or set to `"off"`/`0` is refused, not read as an empty
  table.
- A `files`-scoped entry is refused, unless every glob is a bare
  source-extension pattern with no directory component.
- The installed ESLint boundary plugin must actually resolve from the config's
  own location. If it does not, the refusal names the cause rather than falling
  back to a hand-kept table of defaults.
- An import that throws is reported with its cause, not swallowed.

### What it cannot see

This dialect reads the static shape of the exported array. It does not run
ESLint, so options computed at run time, per-file-glob law, `eslint-disable`
comments, and generator-applied overrides are outside what it can answer. Each
is a named refusal or a stated limit, not a silent gap.

The language server does not read this dialect yet. Point `boundaryConfig` at an
`.mjs`, `.js`, or `.json` file to use it from an editor.

## The stability contract

All three dialects produce the same `depConstraints` shape the ESLint boundary
rule reads. That is the contract: whichever dialect a workspace writes, the
verdict is the same, because the table is the same. Nothing here restates a
constraint, and nothing here defaults an option — the constraint table has one
home, in the consumer's workspace, and every face reads it from there.
