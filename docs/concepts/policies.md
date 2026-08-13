# Policies

The boundary config is the workspace's law. This page is about the shape of that
law — what forms it may take, and how each form is read. What to _put_ in the
constraint table is [boundaries.md](boundaries.md); this page stops at shape.

## Three dialects

All three are read by the same loader, and all three are validated by the exact
same function — a constraint row is checked identically whichever dialect wrote
it, so nothing here can drift into a second opinion about a malformed row.

| selector                   | read as                    | default                                             |
| -------------------------- | -------------------------- | --------------------------------------------------- |
| basename `eslint.config.*` | an ESLint flat config      | no — explicit opt-in only                           |
| basename `.eslintrc*`      | refused by name (legacy)   | n/a — no legacy shape to read a boundary law out of |
| extension `.mjs`, `.js`    | an ES module, `import()`ed | yes — the default filename                          |
| extension `.json`          | plain JSON, `JSON.parse`d  | no — opt in by naming a `.json` file                |

Basename is checked first, before extension. A filename matching
`eslint.config.*` always selects the ESLint dialect regardless of extension.
Only once neither that nor the legacy refusal matches does the extension decide.

Any other extension is refused by name. There is no codemod between dialects,
and none is planned.

## The three keys

Every dialect holds the same three things, under the same names:

- **`depConstraints`** — the constraint table: which tags may depend on which.
- **`moduleBoundaryOptions`** — the eight non-table options, all eight required,
  none defaulted. A missing option is rejected rather than filled in — a default
  would be a second copy of a value the workspace already states.
- **`boundarySuppressions`** — accepted violations, each with a mandatory reason.

## The `.mjs` / `.js` dialect

The default. A plain ES module exporting up to three names. Being a real module,
it may export other names too — the loader reads exactly the three above and
ignores the rest.

## The `.json` dialect

A plain JSON object, read with `JSON.parse` — never JSONC, never `import()`.
No comments, no trailing commas. Exactly three top-level keys are recognised
(`depConstraints`, `moduleBoundaryOptions`, `boundarySuppressions`) plus
`$schema`, which is tolerated but does nothing.

An unrecognised key is **rejected by name** — deliberately asymmetric with the
`.mjs` dialect's tolerance for extra exports, because a JSON object has no
namespace and an unrecognised key is almost always a typo that would let the
constraint table silently vanish.

## The ESLint flat-config dialect

A workspace that already runs the boundary rule under ESLint's flat config can
point the engine at that file directly instead of maintaining a second copy.
The engine reads the flat config's default export, finds the entry that
configures the rule, and takes `depConstraints` off its options. Any option the
entry does not state is filled in from the workspace's own installed ESLint
plugin — its rule's own declared defaults, not a table kept here.

`boundarySuppressions` has no equivalent under this dialect. An ESLint flat
config has no comparable table, and the engine does not invent one.

### What this dialect refuses instead of guessing

- The rule must be on, with options that state `depConstraints`. A rule set to
  `"off"` or missing `depConstraints` is refused rather than read as an empty
  table.
- A `files`-scoped entry is refused, by name — unless every glob it lists is a
  bare source-extension pattern with no directory component.
- The ESLint plugin must resolve from the config's own location. If it does not,
  the engine refuses rather than falling back to a hand-kept defaults table.
- `eslint-disable` comments are invisible. Per-file-glob law is refused
  outright.

## An inline policy

A native workspace's config field may hold the policy object directly instead of
a filename — no separate file at all. It takes the same three keys as the `.json`
dialect, validated by the identical function.

---

- What to put in the constraint table → [boundaries.md](boundaries.md)
- The full schema reference → [../reference/policy-schema.md](../reference/policy-schema.md)
- Configuration for a native workspace → [../reference/configuration.md](../reference/configuration.md)
