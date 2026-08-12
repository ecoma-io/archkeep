# The boundary policy file

`boundaryConfig` — an Nx workspace's `nx.json → plugins[].options`, or a
native workspace's `lattice.json` field
([lattice-json.md](lattice-json.md)) — names the file that holds your
constraint table. This page is the reference for what that file may contain,
in either form it may take.

Two dialects. Both are read by `packages/lattice/src/config.mjs`, and both are
validated by the exact same function — a constraint row is checked identically
whichever dialect wrote it, so nothing here can drift into a second opinion
about a malformed row.

## Choosing a dialect

The extension of the filename `boundaryConfig` names decides it:

| extension     | read as                    | default                                                                |
| ------------- | -------------------------- | ---------------------------------------------------------------------- |
| `.mjs`, `.js` | an ES module, `import()`ed | yes — `module-boundaries.config.mjs` unless a workspace says otherwise |
| `.json`       | plain JSON, `JSON.parse`d  | no — opt in by naming a `.json` file                                   |

Any other extension is refused by name, in a message that does not say
"cannot load" — a `boundaryConfig` pointed at a `.yaml` or `.toml` file is a
naming mistake, not a missing or unreadable file, and the two read as
different problems on purpose.

There is no codemod between the two, and none is planned: a workspace picks
the dialect that fits how it already writes configuration and keeps it.

## The `.mjs` / `.js` dialect

The default, unchanged since before this page existed. A module exporting up
to three names:

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
helper the constraint table is built from. This loader reads exactly the
three names above and ignores the rest; an ES module's exports are a
namespace a file is free to share, so an extra export is not treated as a
mistake.

In a TypeScript workspace, this is the same file `eslint.config.mjs` feeds to
`@nx/enforce-module-boundaries` — see
[designing-boundaries.md](designing-boundaries.md) for what to put in it. This
page stops at shape; that page is where the values are argued.

## The `.json` dialect

A plain JSON object, read with `JSON.parse` — never JSONC, never `import()`.
No comments, no trailing commas: a `.json` boundary file carries no more
syntax than the format it declares itself to be.

```json
{
  "$schema": "https://example.invalid/lattice-boundary-config.schema.json",
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

### The three keys

Both dialects hold the same three things, under the same names — only the
syntax around them changes:

- **`depConstraints`** — the constraint table: which `sourceTag`/`allSourceTags`
  may depend on which. See
  [designing-boundaries.md](designing-boundaries.md) for how to pick tags that
  hold and rows that mean something.
- **`moduleBoundaryOptions`** — the eight `@nx/enforce-module-boundaries`
  options, all eight required, none defaulted here: `allow`, `buildTargets`,
  `enforceBuildableLibDependency`, `allowCircularSelfDependency`,
  `checkDynamicDependenciesExceptions`, `ignoredCircularDependencies`,
  `banTransitiveDependencies`, `checkNestedExternalImports`. A missing option
  is rejected rather than defaulted — a default here would be a second copy of
  a value this file already states, and the two would disagree the day one of
  them changed.
- **`boundarySuppressions`** — optional; absent means "nothing is suppressed."
  Each entry is `{ path, reason, messageId? }`: a glob over the
  workspace-relative path of the importing file, a **mandatory** non-empty
  reason, and an optional violation id to narrow which check the entry covers.
  A suppression with no reason is rejected outright — see
  [violations.md](violations.md) for the id vocabulary `messageId` draws from.

## An inline policy, for `lattice.json`

A native workspace's `boundaryConfig` field may hold the policy object
directly instead of a filename — no separate file at all. It takes the same
three keys as the `.json` dialect above (with no `$schema` carve-out; there is
no file for an editor to validate against) and is validated by the identical
function. [lattice-json.md](lattice-json.md)'s "`boundaryConfig` / `tsConfig`"
section is the reference for that shape. The CLI reads this form fine, but the
language server does not yet: it only ever loads a policy _file_ to watch and
re-read, so it refuses to start over a workspace whose `boundaryConfig` is
inline rather than a filename — move the policy into its own `.mjs` or `.json`
file to use it from an editor.

## Next

- What to put in the constraint table → [designing-boundaries.md](designing-boundaries.md)
- `lattice.json`'s own fields, including the inline form above → [lattice-json.md](lattice-json.md)
- Each violation `messageId` may name → [violations.md](violations.md)
