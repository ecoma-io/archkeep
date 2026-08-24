# Troubleshooting

Organised by what you are looking at, not by what is broken.

---

## It reported nothing, and I expected a violation

This is the failure this project cares most about, so start by checking whether
the file was actually looked at. The clean line tells you:

```text
✔ no boundary violations (264 imports in 78 files across 12 projects)
```

If the file counts look too low, the problem is coverage rather than the rules.
Work down this list:

**The file is not tracked by git.** The set of files a run covers comes from
`git ls-files`. An untracked file, or one matched by `.gitignore`, is not in the
run at all. `git status --porcelain` and `git check-ignore -v <file>` settle it.

**The file belongs to no project.** Files are attributed to the project whose
directory contains them. A file above every project root is outside the boundary
system entirely and is skipped without a verdict — the run says so rather than
staying quiet about it, in a line naming how many such files there are and in
which languages:

```text
⚠ 49 tracked analyzable files (typescript) owned by no project — skipped, so no boundary verdict here covers them
```

That is a coverage note, not a finding: the exit code does not change, and
`--format json` carries the complete list in `coverage.coverageGaps`. On the
native provider (a `archkeep.json` workspace) the same state is a refusal
instead — exit 3, no verdict.

**The project is invisible to the workspace tool.** On an Nx workspace, a
directory with sources but no `project.json` or `package.json` does not appear
in `nx show projects` at all — not as a warning, as an absence. On a Moon
workspace, a directory with no `moon.yml` is invisible to `moon projects`.
Check with:

```shell
# Nx
pnpm exec nx show projects
# Moon
pnpm exec moon projects
```

**The language is not one of the five.** See
[languages.md](../reference/languages.md). A file with an unrecognised extension is a no-op —
the dispatcher is pointed at every tracked file and `README.md` is not an error.

**An `allow` entry is matching more than you think.** This is the most common
cause of a genuine silent pass. `allow` patterns are matched with Nx's own
matcher, whose fallback branch is an **unanchored `new RegExp(pattern)`** — so
`allow: ["@scope/pkg"]` also exempts `@scope/pkg-internal` and `x@scopeYpkg`. An
allowed specifier is exempt from all fifteen rules, checked before anything else
runs. Empty `allow` and re-run to test.

**A suppression is matching.** Check `boundarySuppressions` in your boundary
config for a `path` glob broader than intended. Every entry carries a mandatory
`reason` precisely so this is auditable. A row with an `expiresAt` is a
**waiver**, not a suppression — it keeps the violation in the findings (exit
stays 1) until it expires, so waiving will not make a red build go green; only
a permanent suppression (no `expiresAt`) removes a violation.

**You scoped the run.** `archkeep check <path>` restricts the file set,
and the cycle and lazy-load rules judge the file graph as a whole. Re-run without
paths.

**The rule genuinely fires later in the sequence.** Most sites produce at most
one violation, and the order is the semantics — see [violations.md](../reference/violations.md)
§ _The order matters_. An `allow` match, a missing source project, or an external
target returning early each stop the checks below them.

### If none of those explain it

That is a **missed violation**, and it is the most valuable bug report this
project can get. It earns a permanent regression fixture rather than just a fix.
The issue tracker has a
dedicated form for it (`.github/ISSUE_TEMPLATE/missed_violation.yml`),
separate from the ordinary bug form, because a false negative is a different
class of defect.

---

## It reported something I think is wrong

**`projectWithoutTagsCannotHaveDependencies` on a project you thought was fine.**
This is not "the project has no tags" — it is "no row in the table matches this
project's tags". That is the rule working: without it, a new project added
without tags would escape every boundary while the tool reported green. Tag the
project, or add the row.

**A violation ESLint does not report on the same file.** There is a short,
deliberate list of places this engine is stricter, and all of them resolve toward
reporting because the alternative is silence. The ones that change a verdict:

- Facts upstream reads off disk are optional graph fields here, and **absent
  means the exemption does not apply** — `mfeRemote` (for `noImportsOfApps`),
  `entryPoints` (secondary entry points), `declaredPackages` (for
  `noTransitiveDependencies`). The CLI and the language server populate all
  three from the same files upstream reads, so through them these grounds
  exempt exactly what ESLint exempts; the strict answer remains for a graph
  built by anything else. One named gap that can change a verdict: secondary
  entry points declared only by an Angular `ng-package.json` are not read —
  that fallback of upstream's `getEntryPoint` is deliberately not reproduced —
  so a self-import through one is reported here where ESLint exempts it.
- **`require()` and `require.resolve()` of a lazy-loaded library are reported**,
  where ESLint exempts both. The analysis record cannot tell the three call forms
  apart.
- **An external record with no external node in the graph is still checked**, so
  `bannedExternalImports` reaches Go, Rust and Python — where upstream would bail.

If your case is not one of those, it is a divergence worth filing. A _config_ this engine refuses to load where ESLint compiles it is a different axis and a deliberate one — see [policy-schema.md](../reference/policy-schema.md#refused-pattern-shapes).

**A specifier that does not exist in the file.** Each analyzer has pinned parse
limits, and every one of them errs toward a _spurious record naming text the file
really contains_ rather than a missed import. The known shapes are listed per
language in [languages.md](../reference/languages.md) — a Go raw string containing something
that looks like an import declaration, a Rust local `mod` named after a sibling
crate, a Python triple-quoted string with an import-shaped line. If your case is
not on that list, it is a bug.

**A Rust import at a location that surprises you.** A renamed dependency
(`dep = { package = "real" }`) is followed by the manifest resolver but not at
source level, so the edge exists while the source-level location does not.

---

## A go.work drift finding

These appear only in a workspace with a tracked `go.work` at its root, and they
fail the run with exit 1 because both directions mean the same dangerous thing:
a developer's `go build` and CI select different module sets, and nothing else
notices. What each finding asks for — the four ids and their semantics are in
[languages.md](../reference/languages.md) § _go.work is checked against the graph_:

- **`goWorkMissingUse`** — add the named `use` entry (the message spells it),
  or, if the module really should not be built locally, ask why it is a
  project at all.
- **`goWorkStaleUse`** — remove the entry, or track the `go.mod` it points at:
  the file set is `git ls-files`, so an untracked module reads as absent.
- **`goWorkUnmodeledUse`** — the module builds locally but the graph does not
  model it (one module per project root). Split it into its own project, the
  same fix as the nested-`go.mod` case under `nx affected` below.
- **`goWorkOutsideUse`** — a `use` pointing above the workspace is a
  multi-checkout development setup; it may be deliberate on one machine, but
  committed to `go.work` it promises every machine a directory only one has.

A finding you believe is wrong is worth filing — that is the loud direction
working. A `go.work` the parser could not read is not a finding: it is exit 3,
below.

---

## A dead tsconfig path alias finding

**`tsconfigDeadPathAlias`** appears only in a workspace whose tsconfig declares
a `paths` table, and it fails the run with exit 1 because an alias mapped only
to directories that do not exist resolves no import: the build breaks on it, or
it silently resolves to an installed package of the same name and every
boundary decision reads the import as external. The rule and its limits are in
[languages.md](../reference/languages.md) § _The paths table is checked for dead aliases_.

The fix is what the message says: point the alias at the moved source, or
delete it. Two shapes worth knowing before disputing one:

- The judged base is `baseUrl` when your tsconfig sets one, else the directory
  of the config file that declared `paths` — so under an `extends` chain, a
  target is relative to the file that wrote it, not necessarily the file
  `check` was pointed at.
- The check asks only whether each target's static prefix directory exists. A
  finding therefore means _no_ candidate TypeScript could form from those
  targets can exist — while the converse miss (file deleted, directory kept)
  is deliberately not reported, because deciding it would need TypeScript's
  per-mode candidate probing.

A tsconfig that does not load, or a `paths` value that is not an array of
strings, is not a finding: it is exit 3, below — a broken table must never
read as an absent one.

---

## Exit 3 — "no verdict"

The run could not reach an answer, either at all or for part of the tree. That is
a distinct outcome from both 0 and 1, and it should fail your build.

**Total failures** — the run never started:

| symptom                                  | cause                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no workspace found                       | not run from inside a repository with a workspace marker (`nx.json`, `archkeep.json`, `.moon/` or `.config/moon/`)                                                                                                                                                                                                                                                                          |
| config errors, naming the row            | the boundary config is malformed — every problem is listed rather than the first                                                                                                                                                                                                                                                                                                            |
| a config that loaded before now exits 3  | a pattern this engine refuses by shape, or one it now bounds — the message names the row and what to write instead. ESLint compiles these; this engine will not run them against specifiers a pull request chooses. See [policy-schema.md](../reference/policy-schema.md#refused-pattern-shapes)                                                                                            |
| a Moon workspace with TypeScript exits 3 | the tree carries `.ts`, `.tsx`, `.mts`, `.cts` or `.vue` files and neither `tsconfig.base.json` nor `tsconfig.json` at its root, so there is no `paths` table to resolve against. Refused rather than judged against the compiler defaults, which would report every aliased import as a boundary crossing. Every command refuses, not only `check`. See [moon.md](../integrations/moon.md) |
| `nx graph` failed                        | a plugin threw during graph computation; run `nx graph --file=graph.json` directly for the real message                                                                                                                                                                                                                                                                                     |
| `git` failed                             | not a git repository, or `git ls-files` is unavailable                                                                                                                                                                                                                                                                                                                                      |

**Partial failures** — the run completed but some file has no verdict. These
appear under their own heading in the report, and they are the reason exit 3
covers more than a crash: a file the summary counted but no rule judged is a hole
in the claim the clean line makes.

Common causes: a file the analyzer could not parse, a file whose extension is
registered but whose analyzer is missing, a `tsconfig` that will not load, or —
for Vue — `vue` not installed in a workspace that has `.vue` files. A malformed
`go.work` lands here too, naming its line: a use list this tool cannot read
must not be read as an empty one, because empty would mean "no drift". So does
a `paths` value that is not an array of strings, naming its alias: TypeScript's
own config parse accepts that shape without a diagnostic, and read as "no
aliases" it would silence the dead-alias check exactly where the table is most
broken.

The fix is whatever the failure line names. What is _not_ a fix is treating exit
3 as success; see [ci.md](ci.md) § _The exit codes_.

### Blind spots are a different section, and do not fail the run

An import whose specifier is not statically knowable — a computed `import()`
argument, a Rust `use {` whose braces never balance — is
printed under its own heading. The file _was_ judged; one position in it has no
answer, and it is declared rather than dropped.

Two sections, two meanings: **whole-file failures fail the run; site failures do
not.**

---

## `nx affected` still misses a dependency

Edges and analysis answer different questions, and a missing edge is the first
one.

**Go.** Identity is `<projectRoot>/go.mod`, and an edge needs an import of another
project's module path. A second `go.mod` nested inside a project yields no edge —
the modelling assumption is one module per project root. Split it into its own
project.

**Rust.** Only `{ path = … }` and `{ workspace = true }` dependencies draw edges;
registry (crates.io) dependencies never do. A `{ workspace = true }` entry
resolves through the nearest ancestor manifest carrying `[workspace]`, and _that_
entry must itself be a path dependency to point at a project.

A crate nested inside a project — `src-tauri/` is the usual case — gets no graph
edge while its sources are still analyzed. That disagreement is the documented
modelling limit surfacing, not a bug in either half.

**Python.** An edge needs an explicit workspace wiring in the manifest, under
the declaring tool's own semantics — a `[tool.uv.sources]` route, a Poetry
`{ path = "…" }`, a PDM root-anchored local URL; the exact shapes are in
[languages.md](../reference/languages.md) § _Python_. A name that merely coincides with a
sibling package draws nothing, and a declared path that lands on no project's
root fails graph computation outright rather than being dropped.

This is the language where the manifest and the sources most often disagree, and
the gap is real rather than theoretical — `import other_project.thing` with no
manifest declaration imports fine at runtime while the manifest says nothing at
all. The boundary check catches it; `nx affected` will not until the dependency
is declared.

**Verify what the graph actually holds:**

```shell
pnpm exec nx graph --file=graph.json
```

If the integration is not contributing anything at all, confirm it is registered in
`nx.json` and that no option key is misspelled — an unknown key throws at the
first graph computation rather than falling back to a default.

---

## The editor is showing stale or no diagnostics

**Nothing at all in a supported file.** Confirm the client is routing that
extension to the server, and that the server's workspace root is your workspace
root rather than a subdirectory — the root decides which boundary config is read.
Pass it explicitly through `initializationOptions` if in doubt. See
[editors.md](../integrations/vscode.md).

**Stale after editing the boundary config.** The server asks the client to watch
five patterns: the boundary config, the resolved `tsConfig`, `**/project.json`,
`**/nx.json` and `**/archkeep.json`. A client that cannot
register watchers dynamically is told so **on stderr** — check the server's log
output. Reopening the file re-runs the check regardless.

**A diagnostic that says the file could not be analyzed.** That is the server
working as designed. It publishes a diagnostic rather than an empty list on every
path that did not reach a verdict, because an empty list in an editor is
indistinguishable from a clean file.

---

## Python imports resolve to nothing

Import roots are read from the filesystem — `src/<pkg>/__init__.py`,
`<pkg>/__init__.py`, `<mod>.py` — plus four build-backend layout declarations
(`[tool.setuptools] package-dir`, `[tool.setuptools.packages.find] where`,
`[tool.hatch.build.targets.wheel] packages`, `[tool.poetry] packages`).

Anything outside those is reported as a **failure**, naming the manifest that put
the answer out of reach, rather than being silently classified as an external
PyPI package. That earlier behaviour was a genuine defect: classifying a
first-party project as external made every tag constraint evaporate, because the
rules return from their npm branch before the constraint block is reached.

If you hit this, the fix is usually to declare the layout in a table this reads.
If your backend uses a shape that is not on the list, that is a gap worth filing.

---

## Still stuck

Two doors, and they are different on purpose:

- **A violation that was not reported** →
  the missed-violation form (`.github/ISSUE_TEMPLATE/missed_violation.yml`).
  This is the dangerous class and it is tracked separately.
- **Anything else** → the ordinary bug form.

Either way, the most useful thing you can attach is the file, its `project.json`
tags, and the boundary config row you expected to fire.
