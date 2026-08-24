# The fifteen violations

Every violation this tool reports carries a `messageId` — the same id
`@nx/enforce-module-boundaries` uses for that import. That is deliberate: the id
is searchable against upstream's documentation, and it is what lets the two
engines' verdicts be compared rather than merely both being red.

This page is the reader's side of those fifteen ids: what each one means, what
produced it, and what closes it.

**An id spelled `custom/<rule>/<finding>` is not one of the fifteen and is not
on this page.** It comes from a rule the workspace declared and this engine did
not write, so its meaning is the rule author's rather than upstream's — which
is why it is namespaced, and why no fixed catalogue can describe it. What
explains one is the rule's own message, the `reason` its policy row is required
to carry, and the evidence bundle it was judged over
([custom-rules.md](custom-rules.md)). It is a finding like any other:
exit 1, on all three report faces, accepted only through the same declared
suppressions and waivers.

## How to read a report

```text
apps/checkout-api/internal/handler/pay.go:14:2  onlyTagsConstraintViolation
  A project tagged with "scope:checkout" can only depend on libs tagged with scope:checkout, scope:shared
  import      "github.com/acme/billing-core/ledger" (static)  checkout-api → billing-core
  constraint  sourceTag scope:checkout, onlyDependOnLibsWithTags [scope:checkout, scope:shared]
```

| line               | what it is for                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `file:line:column` | Unindented and unprefixed, so a terminal makes it a link and `grep ':'` down the left margin lists exactly the sites |
| `messageId`        | The id, for searching and for comparing                                                                              |
| the message        | What is wrong, rendered exactly as ESLint would render it                                                            |
| `import`           | Which specifier, of which kind, and the project pair it crosses                                                      |
| `constraint`       | **Which row of your config said so** — the line a fix has to agree with                                              |
| `description`      | (optional) What the constraint row enforces and why                                                                  |
| `remediation`      | (optional) How to fix a violation of this row                                                                        |

When a constraint row carries `description` or `remediation` fields, those
appear indented below the constraint line in `explain`, `impact` and `context`
output. They are optional and do not affect the verdict — they exist so a
developer can understand and resolve a violation without opening the config
file.

When the `constraint` line reads _"not driven by a depConstraints row — this
check fires before the table is read"_, that is not a missing field. Nine of the
fifteen checks are decided before the table is consulted.

## The order matters

Most import sites produce **at most one** violation, and which one you see
depends on where the site falls in this sequence. If you fix the reported problem
and a different id appears at the same line, you have moved down the list rather
than made things worse.

A suppression behaves the same way, because it must: a `boundarySuppressions`
row removes one verdict, and whatever check sits below the removed one then
reports at the same line exactly as fixing the specifier would. A row that
turned every later check off instead would be an off switch wearing a
suppression's name -- [policy-schema.md](policy-schema.md#boundarysuppressions)
owns that contract and the refusal for a row that has stopped covering
anything.

1. `allow` — a matching specifier is exempt from **all fifteen** and nothing below runs
2. A file belonging to no project is skipped entirely — never silently: on the
   Nx and Moon paths a skipped TypeScript, JavaScript or Vue file is counted in
   the run's `unowned-files` coverage gap ([json-output.md](json-output.md)),
   which names how many and in which languages and changes no exit code, while a
   skipped Go, Rust or Python file is a whole-file failure that withholds the
   verdict (exit 3) — and on the native provider every language does
3. Path spelling → **1, 2**
4. Unresolvable target → **2, 10**
5. Reaching your own project through its public alias → **3**
6. An external/npm target → **4, 10** _(the only place two can be reported for one site)_
7. Project-to-project structure → **6, 7, 8, 9, 11**
8. The constraint table → **5, 12, 13, 14, 15**

The bold numbers are the section numbers of the catalogue below.

Two exceptions to "at most one": an external import can be reported as both
transitive **and** banned, and the nested-banned check reports once per offending
package.

---

## Decided on how the import is written

These five are judged on the specifier's own text. The projects can be entirely
correct and the spelling still be the violation — which is why a graph edge
alone could never serve them.

### 1. `noRelativeOrAbsoluteImportsAcrossLibraries`

> Projects cannot be imported by a relative or absolute path, and must begin with a npm scope

A file reached another project by walking the filesystem — `../../billing/src/ledger`
— instead of by the project's public name.

**Why it is a rule and not a style preference:** a relative path reaches _inside_
another project, past whatever it chose to export. The boundary the tags describe
is at the project's entry point, and a path that steps around it makes every
other rule advisory.

**Fix:** import the project by its published name or path alias.

### 2. `noRelativeOrAbsoluteExternals`

> External resources cannot be imported using a relative or absolute path

A path specifier that resolves to nothing inside the workspace. Usually a path
into `node_modules`, a stale path after a move, or a file that is not tracked.

**Fix:** import the package by name; or, if the path was meant to reach
something real, find out why it does not resolve —
[troubleshooting.md](../usage/troubleshooting.md) covers the "it should have resolved"
case.

### 3. `noSelfCircularDependencies`

> Projects should use relative imports to import from other files within the same project. Use "./path/to/file" instead of import from "…"

A file reached _its own_ project through the project's public entry point. That
is a cycle through the barrel, and it is invisible in an edge list because the
edge starts and ends at the same node.

What counts as "instead of a relative path" is the language's own answer, not a
guess: `./x` in JavaScript, `crate::`/`self::`/`super::` in Rust, a leading-dot
import in Python. **Go cannot produce this violation**, because Go has no
relative import form at all and its compiler already forbids the cycle.

**Fix:** use the relative form. Or set `allowCircularSelfDependency: true` if
your workspace has decided the barrel round-trip is acceptable.

### 4. `bannedExternalImportsViolation`

> A project tagged with "…" is not allowed to import "…"

A `bannedExternalImports` pattern on a matching row matched the specifier.

**Note the matcher**: every run of `*` becomes `.*` and the result is anchored,
but other regex metacharacters survive — `.` still means any character. See
[boundaries.md](../concepts/boundaries.md) § _Patterns are not globs_.

**Fix:** stop importing it, or move the ban to a narrower `sourceTag`.

### 5. `nestedBannedExternalImportsViolation`

> A project tagged with "…" is not allowed to import "…". Nested import found at …

The same ban, matched against something a **dependency** drags in rather than
something this project imports directly. Only fires under
`checkNestedExternalImports: true`.

This is the one check that reports **once per offending package**, so a single
import site can produce several lines.

**Fix:** the message names the child project that actually imports the banned
package. The fix belongs there, not at the reported site.

---

## Decided on the shape of the graph

These five never consult the constraint table. They are structural facts about
which project reached which.

### 6. `noCircularDependencies`

> Circular dependency between "A" and "B" detected: … / Circular file chain: …

A dependency cycle between projects. The message prints both the project path and
the file chain, so the specific import to cut is visible rather than inferred.

**Fix:** cut one edge — usually by extracting the shared piece into a third
project both may depend on. If a cycle is genuinely accepted, name the exact
project in `ignoredCircularDependencies` (exact names only; glob patterns are
rejected at load rather than approximated).

### 7. `noImportsOfApps`

> Imports of apps are forbidden

A library imported an application. Applications are the top of the graph; they
are composed, not consumed.

**Fix:** extract what the library needed into a library both may depend on.

### 8. `noImportsOfE2e`

> Imports of e2e projects are forbidden

Something imported an end-to-end test project. E2E projects exist to be run, not
imported from.

**Fix:** move the shared helper into a real library.

### 9. `noImportOfNonBuildableLibraries`

> Buildable libraries cannot import or export from non-buildable libraries

A library that produces a build artifact depends on one that does not, so the
artifact would ship a reference to something never built.

Only fires when `enforceBuildableLibDependency: true`, and "buildable" means
"declares one of the target names in `buildTargets`". In a workspace where
nothing is built, turn this option off — the check has nothing true to say there.

**Fix:** give the dependency a build target, or stop depending on it.

### 10. `noTransitiveDependencies`

> Only packages defined in the "package.json" can be imported. Transitive or unresolvable dependencies are not allowed.

An external package was imported without being declared in the importing
project's own manifest or the workspace root's — the same two files upstream
checks. It works today because something else installed it, and
it breaks the day that something else stops depending on it.

Only fires under `banTransitiveDependencies: true`. Node built-ins are exempt.

**Fix:** declare the dependency where it is used.

### 11. `noImportsOfLazyLoadedLibraries`

> Static imports of lazy-loaded libraries are forbidden. / Library "…" is lazy-loaded in these files: …

A project is loaded lazily somewhere and statically here, which defeats the
lazy-loading — the bundle it was meant to defer is pulled into the main one.

**One deliberate strictness:** `require()` and `require.resolve()` of a
lazy-loaded library are reported here, where ESLint exempts them. The analysis
record cannot tell those two apart from an `import` statement, and the tie is
broken toward reporting.

**Fix:** load it dynamically here too, or list the specifier in
`checkDynamicDependenciesExceptions`.

---

## Decided by the constraint table

The last four, and the ones your table actually shapes.

### 12. `projectWithoutTagsCannotHaveDependencies`

> A project without tags matching at least one constraint cannot depend on any libraries

**The source project's tags match no row in the entire table.** Read the message
carefully — it is not "this project has no tags", it is "no row applies to this
project".

This is the rule most often reported as a bug, and it is the one doing the most
work. Without it, a new project added without tags would silently escape every
boundary while the tool reported green.

**Fix:** tag the project so a row matches it, or add the row.

Note that an external/npm target returns before this check, so **no external
import can ever produce this violation**, however untagged its source project is.

### 13. `onlyTagsConstraintViolation`

> A project tagged with "…" can only depend on libs tagged with …

The everyday one. A matching row's `onlyDependOnLibsWithTags` list contains none
of the target's tags.

Remember that rows **compose with AND**: if a project matches four rows it must
satisfy all four, and the reported `constraint` line tells you which one it
failed.

**Fix:** re-tag one of the two projects, restructure the dependency, or widen the
row — in roughly that order of preference.

### 14. `emptyOnlyTagsConstraintViolation`

> A project tagged with "…" cannot depend on any libs with tags

A matching row has `onlyDependOnLibsWithTags: []`. An empty list is a rule of its
own — "this project is a leaf" — not an unset option.

**Fix:** if you meant "no restriction on this axis", remove the field rather than
emptying it.

### 15. `notTagsConstraintViolation`

> A project tagged with "…" can not depend on libs tagged with … / Violation detected in: …

A matching row's `notDependOnLibsWithTags` list matched something the target can
reach.

**This check is transitive**, which is why the message ends with a list of
projects: the direct target may be perfectly clean and something several hops
down the chain may not be. The listed projects are where the forbidden tag
actually is.

**Fix:** the fix is usually at one of the listed projects rather than at the
reported import. That distance is intentional — a licence or deprecation rule
that stopped at the first hop would be trivially bypassable.

---

## `workspaceLayout`, and the one place this deliberately diverges from Nx

`nx.json`'s `workspaceLayout` (`appsDir`, `libsDir`) changes which import can
produce violation 1 above. `noRelativeOrAbsoluteImportsAcrossLibraries` fires
on a specifier that begins with the declared `libsDir` (or `appsDir`) prefix,
not on `"libs/…"` unconditionally — so a workspace naming a non-default pair,
say `{"libsDir": "packages", "appsDir": "applications"}`, now has that pair
fully honored: an absolute `"packages/…"` import can produce this finding, the
same as it would under real Nx and `@nx/enforce-module-boundaries` on the
identical tree. Previously Archkeep never read `nx.json`'s `workspaceLayout` at
all and judged every workspace against Nx's own default (`libs`/`apps`)
regardless of what was declared — a workspace with a custom layout got a rule
that could never fire on its own layout
([#31](https://github.com/ecoma-io/archkeep/issues/31)).

**A complete declaration is honored; a partial one is refused, loudly.**
`workspaceLayout` must name both `appsDir` and `libsDir`, or neither.
Declaring only one of the two exits **3** — no verdict — with a message
naming the key that is missing, rather than running with the other key
silently defaulted. Real Nx (measured against nx 23.1.1) does the opposite: it
accepts a partial `workspaceLayout` and evaluates the missing key as though it
were never configured, silently running half the rule. Archkeep cannot make
that promise — the check reads both keys off one object with no per-key
fallback, so a workspace that redirected `libsDir` and forgot `appsDir` would
get a rule quietly checking the wrong half of the tree, and a clean result from
that half would look identical to "no violation" — the one outcome this tool's
whole design exists to keep truthful. A named refusal is the loud version of
that failure; a half-applied layout is the silent one.

**Both are breaking changes in 1.0 terms.** A workspace with a non-default,
complete `workspaceLayout` can see new findings on a tree it did not touch —
what the declared layout was always supposed to mean, now actually enforced.
A workspace with a partial `workspaceLayout` — previously ignored like any
other declaration, because nothing read the key at all — now gets a new
exit-3 refusal instead of a pass.

---

## Three things that are not violations

**Unresolvable import sites.** A specifier that is not statically knowable — a
computed `import()` argument, a Rust `use` whose braces do not balance, a
literal package import that names no declared project and cannot resolve — is
printed under its own heading as a declared blind spot. The file _was_ judged;
one position in it has no answer. The run does not fail on these: a workspace
with packages is a normal state, and failing on every uninstalled package
would block merges over dependencies nobody crossed.

**Whole-file failures.** A file that could not be analyzed at all — unreadable,
no analyzer, a `tsconfig` that will not load, or a literal import that names a
DECLARED project but cannot be resolved (a missing workspace edge) — is a
different section, and it **does** fail the run with exit 3. That distinction
is the whole design: a checker that could not look must never be mistaken for
one that looked and found nothing.

**Workspace-level findings.** go.work drift (the `goWork*` ids) and a dead
tsconfig paths alias (`tsconfigDeadPathAlias`) are judged against the
workspace's own declarations rather than against any import, so no constraint
row applies to them and no suppression removes them. They fail the run with
exit 1 exactly as a violation does. [languages.md](languages.md) owns each
check's semantics.

All three, including what fixes each finding, are explained in
[troubleshooting.md](../usage/troubleshooting.md).
