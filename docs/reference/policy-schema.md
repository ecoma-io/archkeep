# Policy schema

The constraint table every `boundaryConfig` file holds, regardless of dialect.
What each field contains; not what to put in it (that is
[boundaries.md](../concepts/boundaries.md)) or how to load it
(that is [policies.md](../concepts/policies.md)).

## Top-level keys

Six keys, same names in every dialect. A seventh, `$schema`, is accepted in
the `.json` dialect (file or inline) for editor validation, and must be a
non-empty string.

| key                     | type   | required | meaning                                                                                       |
| ----------------------- | ------ | -------- | --------------------------------------------------------------------------------------------- |
| `depConstraints`        | array  | yes      | The constraint table.                                                                         |
| `moduleBoundaryOptions` | object | yes      | The eight `@nx/enforce-module-boundaries` options.                                            |
| `boundarySuppressions`  | array  | no       | Accepted violations. Absent means nothing suppressed.                                         |
| `fitness`               | array  | no       | Named quality gates judged every run. Absent means none declared.                             |
| `customRules`           | array  | no       | Declared WebAssembly rules of the workspace's own. Absent means none declared.                |
| `coverage`              | object | no       | Accepted unowned files (`coverage.unowned`), Nx/Moon only. Absent means no acceptance record. |

Any other key is rejected by name in every dialect that reads this table — the
`.mjs`/`.js` module's extra exports included, so a misspelled key cannot load
exit-0 and disappear ([policies.md](../concepts/policies.md), "The ES module
dialect").

## `depConstraints`

An array of rows. Each row keys on exactly one of two identifying fields, then
takes up to four optional list fields. Any other key in a row is rejected at
load, naming the key.

### Identifying fields (exactly one per row)

| field           | type     | meaning                                                                         |
| --------------- | -------- | ------------------------------------------------------------------------------- |
| `sourceTag`     | string   | The row applies to any project carrying this tag.                               |
| `allSourceTags` | string[] | The row applies only to a project carrying **all** of these tags. At least two. |

### Constraint fields (optional, zero to four per row)

| field                      | type     | meaning                                                                 |
| -------------------------- | -------- | ----------------------------------------------------------------------- |
| `onlyDependOnLibsWithTags` | string[] | The target must carry at least one of these.                            |
| `notDependOnLibsWithTags`  | string[] | The target must carry **none** of these -- transitive, not just direct. |
| `allowedExternalImports`   | string[] | Allowlist for third-party specifiers.                                   |
| `bannedExternalImports`    | string[] | Denylist for third-party specifiers.                                    |

`bannedExternalImports` judges every specifier that leaves the workspace, and
Node's built-in modules are among them: a row banning `*` reports `node:fs` the
same way it reports an installed package. `banTransitiveDependencies` is the
option that exempts built-ins, and it is a different question -- a built-in has
no manifest entry to be missing from, so counting it as an undeclared transitive
dependency would report every workspace. A row meant to keep frameworks out of a
layer without touching the standard library names the packages, or their scope,
rather than `*`.

### Documentation fields (optional)

| field         | type   | meaning                                                                                               |
| ------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| `description` | string | What this constraint row enforces and why. Shown in `context`, `explain`, `impact` and `diff` output. |
| `remediation` | string | How to fix a violation of this row. Shown alongside the description.                                  |

These fields are optional and do not affect the verdict. They exist so that a
developer reading `archkeep context`, `archkeep explain`, or the constraint-context
sections of `impact` and `diff` can understand both what the rule means and how
to bring their import back into compliance without consulting the config file
directly.

### Governance block (optional)

A row may carry the shared governance block — `origin`, `rationale`,
`decisionRef`, `fitnessBindings` — the same four keys an intent row may carry,
validated by the one shared schema ([provenance.md](../concepts/provenance.md)
owns the block). A `decisionRef` names the recorded architecture decision the
row leans on: `archkeep adr <id>` reads it, and a reference that resolves to
nothing is `unknown`, never a pass. A row without the block is a legacy row and
stays valid byte-identical.

`onlyDependOnLibsWithTags: []` is a rule, not an empty setting -- it means the
project may not depend on any library carrying tags at all. If you meant "no
restriction on this axis," omit the field.

### A row that covers nothing

A constraint row can be dead in two ways, and `archkeep check` refuses both with
exit 3, naming the row -- a constraint matching nothing does not error, it
approves:

- **Its source selector matches no project.** A `sourceTag`, or an
  `allSourceTags` combination no project carries all of, selects nothing, so
  the row never applies to any import and everything on its axis passes while
  the config reads as enforced. Usually a rename outlived the config.
- **A `notDependOnLibsWithTags` entry names a tag no project carries.** A ban
  whose every value names nothing forbids nothing, while reading as a ban.

An `onlyDependOnLibsWithTags` entry naming no carried tag is deliberately NOT
refused: a permitted list naming nothing makes the row maximally strict --
every dependency violates -- which is loud on its first run and needs no gate.
The refusal fires only where the answer is knowable: a whole-workspace run over
a tree the run fully analyzed (a path-scoped run or one with unanalyzed files
cannot tell a dead row from an unvisited one), and only on law the workspace
wrote -- [policy packs](../usage/presets.md) are adopted wholesale from
`node_modules` and are exempt.

## `moduleBoundaryOptions`

All eight are required. None is defaulted -- a missing option is rejected
rather than filled in, because a default here would be a second copy of a value
the file already states.

| option                               | type     | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `allow`                              | string[] | Specifiers exempt from every check. The escape hatch of last resort. Nx's `matchImportWithWildcard` dialect.                                                                                                                                                                                                                                                                                                                                                 |
| `buildTargets`                       | string[] | Which target names make a project "buildable." Read only by `enforceBuildableLibDependency`. Exact target names — an entry carrying glob syntax is refused at load (a pattern can never match an exact name), and when the option is on, an entry that matches no target declared by any project is refused by every evaluating command (`check`, `explain`, `graph`, the language server — not just the checker), never silently read as selecting nothing. |
| `enforceBuildableLibDependency`      | boolean  | Whether a buildable library importing a non-buildable one is an error.                                                                                                                                                                                                                                                                                                                                                                                       |
| `allowCircularSelfDependency`        | boolean  | Whether a file may reach its own project through the project's public entry point.                                                                                                                                                                                                                                                                                                                                                                           |
| `checkDynamicDependenciesExceptions` | string[] | Specifiers whose `import()` is exempt. Nx's `matchImportWithWildcard` dialect.                                                                                                                                                                                                                                                                                                                                                                               |
| `ignoredCircularDependencies`        | string[] | Project pairs excused from the cycle check. Each entry is a `[projectA, projectB]` pair -- exact names only, no globs.                                                                                                                                                                                                                                                                                                                                       |
| `banTransitiveDependencies`          | boolean  | Whether importing a package declared in neither the project's own manifest nor the workspace root's is an error.                                                                                                                                                                                                                                                                                                                                             |
| `checkNestedExternalImports`         | boolean  | Whether `bannedExternalImports` is judged against what dependencies drag in, as well as direct imports.                                                                                                                                                                                                                                                                                                                                                      |

### Pattern dialects

The three pattern-matching dialects are not interchangeable. Using the wrong one
matches more than intended, and the tests pass anyway.

| where                                                               | dialect                        | what it actually does                                                                                                                                                                                                                             |
| ------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allow`, `checkDynamicDependenciesExceptions`                       | Nx's `matchImportWithWildcard` | Understands exactly three shapes -- trailing `/**`, trailing `/*`, and `prefix/**/suffix`. **Anything else falls through to an unanchored `new RegExp(pattern)`** -- which this engine refuses at config load if its shape backtracks; see below. |
| `bannedExternalImports`, `allowedExternalImports`, glob-shaped tags | Nx's `mapGlobToRegExp`         | Every run of `*` becomes `.*`, and the result is anchored. Every other regex metacharacter survives.                                                                                                                                              |
| `ignoredCircularDependencies`                                       | Nx's `findMatchingProjects`    | Neither names nor globs: a case-insensitive word-boundary regex over project names.                                                                                                                                                               |

These are ported literally so that this tool and ESLint keep agreeing about
which imports escape.

### Refused pattern shapes

The port is the matcher, not the door in front of it. Where a pattern falls
through to `new RegExp`, this engine refuses two shapes at config load that
ESLint compiles and runs -- so on those two, and only those two, the tools do
not agree.

The divergence is deliberate, and the asymmetry is the reason. ESLint runs the
pattern against specifiers from the repository the developer is editing, in that
developer's editor. This engine runs it in CI against every specifier in the
tree, and the subject that costs the most is the one that does _not_ match --
which a pull request chooses. A pattern that takes minutes to fail reports no
violation while it runs, and a check that never returns is byte-for-byte a clean
workspace: the silent direction. Refusing at load is the loud one.

| shape                                                                    | example        | why                                                                                                                                                                            |
| ------------------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A repeated group that can match the same text more than one way          | `(a+)+$`       | Exponential. Measured on Node v24.16.0: 12ms against a 20-character specifier, 775ms at 26, **12.4 seconds at 30** -- four times the work for every two characters after that. |
| More than two repetitions re-split against a requirement that _can_ fail | `^a.*a.*a.*z$` | Polynomial. 190ms against a 1000-character specifier, 1.5s against 2000.                                                                                                       |
| Groups nested more than 32 deep                                          | --             | Past that depth the shape is not read further, and a pattern it cannot tell apart from one that never returns is refused rather than guessed at.                               |

The discriminator in the second row is the **failing requirement**, not the
count. `^.*-.*-.*-.*$` ends in a wildcard nothing can fail after, costs 0.0ms at
every length, and is accepted at any number of repetitions. So is a uniform
delimited pattern up to eight segments (`^\w+(\.\w+)*$`), and so is every
pattern whose repeated group is pinned -- each iteration the same length
(`(ab)+`, `(a|b)+`), or opening on a character that appears nowhere else inside
it (`(\.\w+)*`). The ordinary globs are unaffected: `@acme/*/*/*` is not a
regex at all.

A refused pattern is a config error naming the row, and the message names the
sub-pattern that earned the refusal and what to write instead. It exits 3, not
1 -- the law could not be established, so there is no verdict to report.

Patterns that survive load are still quadratic in the length of a specifier that
does not match, and nothing upstream bounds that length, so the **subject** is
bounded too: a specifier past 1024 characters is not matched, and not matching
is reported (exit 3) rather than passed.

## `boundarySuppressions`

An array of `{ path, reason, messageId?, expiresAt?, origin? }` rows.

| field       | type   | required | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`      | string | yes      | Glob over the workspace-relative path of the importing file, matched with `path.posix.matchesGlob` and capped at 512 brace-driven alternatives -- see [configuration.md](configuration.md#projectsinfer).                                                                                                                                                                                                                               |
| `reason`    | string | yes      | Non-empty. An unexplained suppression is indistinguishable from a boundary that stopped being enforced. And fixing the violation a row accepts makes the ROW dead: the next whole-workspace run refuses with exit 3 until the row is removed. That is the rule working -- an acceptance nobody can point to a violation for any more must not read as clean -- but it is a cost to go in knowing, not one to discover from a red build. |
| `messageId` | string | no       | Narrows which check the entry covers. Validated against the engine's violation ids -- a typo suppresses nothing.                                                                                                                                                                                                                                                                                                                        |
| `expiresAt` | string | no       | Makes the row a **waiver** instead of a suppression. A parseable ISO-8601 instant. An expired waiver re-asserts the violation it covered. See [waivers.md](../concepts/waivers.md).                                                                                                                                                                                                                                                     |
| `origin`    | string | no       | Non-empty. Where the row came from -- a ticket id, a decision record. Never shown in a verdict, only in the waiver's surface and the acceptance report.                                                                                                                                                                                                                                                                                 |

A row with **no** `expiresAt` is a suppression and removes the verdicts it
covers from the run's findings -- which is not the same as removing the
checks, as the next paragraph states. A row **with** `expiresAt` is a
waiver: the violation stays in the findings (exit code stays 1), marked
accepted until that instant, and re-asserts in full with the evidence
`"expired waiver"` once the instant passes. A waiver is judged at epoch-ms
precision against the shared governance clock, so `now === expiresAt` is
already expired.

A suppression removes a **verdict**, never a failure. The file is still fully
analyzed, and anything the analyzer could not read in it is still reported.
And because a site reports the first check in [the documented
order](violations.md#the-order-matters) that fires, removing one verdict means
the checks below it apply at the same line exactly as fixing the specifier
would: suppressing `noRelativeOrAbsoluteImportsAcrossLibraries` on an edge the
constraint table forbids surfaces the tag verdict behind it. A suppression
behaves like a fix, never like an off switch for the file.

A suppression whose verdicts are all gone -- or that never matched one -- is
refused by `archkeep check` with exit 3, naming the row, in the same shape as a
stale `coverage.exempt` row: a boundary that stopped being enforced must not
read as clean. An **expired** waiver covering nothing is refused with it -- its
term has lapsed, and only an edit brings a lapsed term back. A waiver still in
force that currently covers nothing is deliberately not refused: a fixed
violation leaves its waiver idle until expiry, which is the feature working,
and that resting state is reported by `archkeep waivers` instead. Both refusals
fire only on a whole-workspace run over a fully analyzed tree, for the reason
the [constraint-table refusal](#a-row-that-covers-nothing) states: elsewhere a
row covering nothing in what this run saw may cover plenty in what it did not.

## `fitness`

An array of named quality-gate rows. Each row judges one condition over the
projects its `match` selects, on every run.

| field       | type     | required | meaning                                                                                                                                                   |
| ----------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`      | string   | yes      | Letters, digits, `-` and `_` only -- no `:` (so a name can never collide with a selector label). Unique across the list.                                  |
| `match`     | string[] | yes      | Non-empty list of project selectors (`name:x`, `tag:x`, `directory:x`, `*`, `!`). Zero selected projects is `not_applicable`, loudly.                     |
| `condition` | object   | yes      | One condition type plus its fields. See the table below.                                                                                                  |
| `reason`    | string   | yes      | Non-empty. A fitness function is a policy decision, and one with no reason written down is indistinguishable from a policy that quietly stopped applying. |

An empty list is rejected -- a list present but empty reads as policy while
deciding nothing. Unknown keys in a row, a duplicate name, or an ill-formed
`condition` are rejected at load, naming the key.

### Conditions

| `type`                                        | fields                       | verdict contract                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cycle-free`                                  | —                            | `pass` when the matched subgraph has no dependency cycle.                                                                                                                                                                                                                                                                                                                                   |
| `layer-dependency`                            | `from`, `to`, `direction`    | `direction` is `forbidden` (no edge from `from` to `to`) or `required` (at least one). A tag no matched project carries is `unknown`, never `pass` or `fail`.                                                                                                                                                                                                                               |
| `tag-conformance`                             | `from`, `to`, `toDependents` | `match` selects the sources; a judged edge's target is any project it lands on, matched or not (a non-project target such as an npm package is `bannedExternalImports`' business, not this one's). `toDependents` is `only` (edges from `from` may target only `to`) or `never` (may not target `to`). A `to` tag no project in the workspace carries is `unknown`, never `pass` or `fail`. |
| `coverage-minimum`                            | `statement`                  | At least `statement` percent of the matched projects' analyzable owned files were analyzed. Zero owned files is `unknown`; a path-scoped run is `not_applicable` — it needs a full, unscoped run.                                                                                                                                                                                           |
| `boundary-suppression-count-within-threshold` | `max`                        | The number of accepted `boundarySuppressions` is at most `max`.                                                                                                                                                                                                                                                                                                                             |
| `drift-free`                                  | —                            | `pass` when the declared architecture intent judges clean; no intent file or a no-verdict intent is `unknown`.                                                                                                                                                                                                                                                                              |
| `tag-axis-isolation`                          | `axis`, `exempt` (optional)  | `fail` when a direct edge leaving a matched project reaches a project that carries a value on `axis` and shares none of the source's. A matched project carrying no value on `axis` is `unknown`.                                                                                                                                                                                           |

`from`/`to` are non-empty tag values; `direction` is one of
`forbidden`/`required`; `toDependents` is one of `only`/`never`; `statement` is
a percentage between 0 and 100; `max` is a non-negative integer; `axis` is a
non-empty tag axis that must NOT itself contain `:` (an `axis` of
`"module:orders"` would read the partition off the second colon, so it is
refused by name rather than allowed to match nothing); `exempt` is a list of
project selectors in the same grammar `match` uses, and absent or empty means
nothing is exempt.

`tag-axis-isolation` is the one condition whose target set is computed
_relative to the source_. [fitness-functions.md](../concepts/fitness-functions.md)
owns what that means and why a constraint row cannot express it; this page owns
only the field shapes above.

The verdict semantics and the two faces (`archkeep fitness` and `check`'s fold)
live in [fitness-functions.md](../concepts/fitness-functions.md).

## `customRules`

An array of declared custom rules — one WebAssembly rule per row, judged once
per run. [custom-rules.md](custom-rules.md) owns the contract the artifact
must implement; [../concepts/custom-rules.md](../concepts/custom-rules.md)
owns the model.

| field      | type   | required | meaning                                                                                                                                                                                                                                                                                    |
| ---------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`     | string | yes      | Dash-separated lowercase (`a-z`, `0-9`, `-`), unique across the list; must equal the artifact's own describe `name`. Findings render namespaced under it.                                                                                                                                  |
| `artifact` | string | yes      | Workspace-relative path to the `.wasm` module — never absolute, never escaping the workspace. It need not be tracked; the hash below is the review mechanism.                                                                                                                              |
| `sha256`   | string | yes      | 64 lowercase hex characters: the artifact's content digest. A mismatch at load refuses the run — what CI judged is byte-identified by the row review approved.                                                                                                                             |
| `params`   | object | no       | This instance's parameters, handed to the rule inside the evidence bundle. Must be data JSON can carry losslessly — a function, `NaN`, a `Map`, an `undefined` or a cycle is refused at load naming the path, because a rule judged under parameters nobody wrote is the silent direction. |
| `reason`   | string | yes      | Non-empty. A custom rule is a policy decision, and one with no reason written down is indistinguishable from a policy that quietly stopped applying.                                                                                                                                       |

A row also accepts the same governance block a `depConstraints` row carries
(`origin`, `rationale`, `decisionRef`, `fitnessBindings` —
[provenance.md](../concepts/provenance.md) owns those keys). An empty list is
rejected — law present but judging nothing reads as protection. Unknown keys
in a row, a duplicate name, or a malformed field are rejected at load, naming
the key and the row.

## `coverage`

An object with exactly one field: `unowned`, an array of `{ path, reason }`
rows. Each row records the acceptance of tracked analyzable files **owned by
no project** on an Nx or Moon workspace — the files `check` otherwise reports
as the permanent `unowned-files` warning (TypeScript, JavaScript, Vue) or
refuses with exit 3 (an unclaimed Go, Rust or Python file). See
[troubleshooting.md](../usage/troubleshooting.md#it-reported-nothing-and-i-expected-a-violation)
for the state each row answers.

| field    | type   | required | meaning                                                                                                                                            |
| -------- | ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`   | string | yes      | Glob over a workspace-relative path, matched with `path.posix.matchesGlob` and capped at 512 brace-driven alternatives like every other glob here. |
| `reason` | string | yes      | Non-empty. An accepted coverage hole with no reason written down reads as coverage that is still enforced.                                         |

Rows are matched **only against files already decided to be unowned** — never
against owned files — so even a `**` row cannot silence a verdict about a file
a project owns. This is the same guarantee the native provider's
[`coverage.exempt`](configuration.md#coverageexempt) states, and it is what
separates accepting a **coverage hole** (a file judged by nothing) from a
`boundarySuppressions` row's accepting a **verdict** the engine reached.

A covered file is a recorded acceptance, never an invisible one. `check`
still states every accepted file, in every format, as an
`accepted-unowned-files` coverage gap
([json-output.md](json-output.md#coverage)), and `archkeep waivers` names
each row with its reason and how many unowned files it currently covers. What
stops for a covered file is only the permanent half: the unanswerable
warning, and the unclaimed exit 3.

A row matching no unowned file across both sets is refused by `archkeep
check` with exit 3, naming the row — the same stale-row sentence a native
`coverage.exempt` row gets, under the same whole-workspace, fully-analyzed
gate as [the constraint-table refusal](#a-row-that-covers-nothing). A fixed
tree deletes its dead acceptances the way it deletes dead suppressions: by an
explicit edit, never silently.

Two provider rules, and one compatibility note:

- **A native workspace is refused the key, loudly.** `archkeep.json`'s own
  [`coverage.exempt`](configuration.md#coverageexempt) is that provider's one
  channel for the identical decision, so a policy carrying `coverage` on a
  native tree exits 3 naming it — in the inline spelling and the file
  spelling alike. One channel per decision per tree.
- **The ESLint dialect cannot carry it.** A flat config's rule entry has
  nowhere to declare the key — the same structural gap `boundarySuppressions`
  and `customRules` have under that dialect (the table below).
- **Older archkeep refuses the key.** A policy carrying `coverage` exits 3 on
  archkeep ≤ 0.13.x, whose loaders reject the unknown key by name. That is
  the loud direction, and deliberate pre-1.0: an older enforcer must refuse a
  law it cannot fully read rather than enforce the half it understood.

## Three dialects

All three are validated by the same function. A constraint row is checked
identically whichever dialect wrote it.

| dialect               | selector                   | read as                                             | `boundarySuppressions`       | `customRules`                | `moduleBoundaryOptions` defaults                              |
| --------------------- | -------------------------- | --------------------------------------------------- | ---------------------------- | ---------------------------- | ------------------------------------------------------------- |
| `.mjs` / `.js` module | extension                  | ES module, `import()`ed                             | supported                    | supported                    | none -- all eight required                                    |
| `.json`               | extension                  | plain JSON, `JSON.parse`d (never JSONC)             | supported                    | supported                    | none -- all eight required                                    |
| ESLint flat config    | basename `eslint.config.*` | flat config's `@nx/enforce-module-boundaries` entry | not supported (always empty) | not supported (always empty) | filled from the workspace's own installed `@nx/eslint-plugin` |

`coverage` follows the `customRules` column exactly: supported in the
`.mjs`/`.js` and `.json` dialects, never present under the ESLint dialect —
absent there, as the workspace's own statement, not empty.

The ESLint dialect is explicit opt-in only -- archkeep never probes for one.
Legacy `.eslintrc*` names are refused by name. Basename is checked before
extension. For the conceptual overview of what policies are and how they relate
to the Nx ecosystem, see [policies.md](../concepts/policies.md).

### Inline policy (`archkeep.json` only)

A native workspace may hold the policy object directly on `archkeep.json`'s
`boundaryConfig` field instead of pointing at a filename. Same keys as the
`.json` dialect, validated by the identical function — `$schema` included,
accepted and checked the same way a `.json` policy file accepts it — with the
one exception [`coverage`](#coverage) states: the inline form refuses that
key by name, because `archkeep.json`'s own `coverage.exempt` is the native
provider's channel for the same decision. Every face
reads it: the CLI, the Nx hook, and the language server, which re-reads
`archkeep.json` on every invalidation and so sees an edited inline law exactly
as it sees an edited policy file.
