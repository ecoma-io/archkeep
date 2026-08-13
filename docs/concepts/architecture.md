# Architecture

How Lattice reads a repository, judges boundaries, and reports the verdict. This
page owns the flow. What each layer is _allowed to know_ is owned by the
package's own CLAUDE.md; the record passed between them is frozen in the
analysis contract. Those two bind; this page explains how they fit together.

## The two halves

The engine closes one gap with two independent mechanisms:

```
                   ┌─ graph/       → the dependency edges
reading a repository┤
                   └─ analysis/    → rules/ → report/       → the verdict
                          ↑              ↑
                     workspace.mjs   config.mjs
```

The **edges** half discovers which project depends on which, from manifests.
The **enforcement** half judges which imports cross boundaries, from source
files. They read different things on purpose: a manifest says a dependency _may_
be used; it never says a boundary _was crossed_.

## One check, in order

The CLI's `check()` is the whole pipeline in one function. Every step is a
decision.

### 1. Find the workspace root

The engine walks up for a root marker — a file that declares this directory to
be the root of a workspace. The marker found decides which project-model
provider the rest of this run uses.

### 2. Read the options

Two filenames the workspace may have renamed: the boundary config and the
TypeScript config. An unknown option key throws at every door that reads options,
because a typo'd key that quietly used the default would give a full green run
against a rule nobody wrote.

### 3. Load the boundary config

The constraint table is read and validated. Validation is shape-only — whether
`layer:adapter` may reach `layer:domain` is the workspace's decision. Every
problem is accumulated, not just the first. A malformed row fails here rather
than becoming a rule that silently matches nothing.

### 4. Read the graph, and the file list

The graph comes from the project-model provider selected in step 1. The file
list comes from the version-control system's tracked-files query. Both reach
outside the process through injectable parameters, which is what lets a test
drive the real pipeline over a fixture tree.

### 5. Build the workspace view

The workspace view is the object every analyzer is handed: root, projects,
files-of, read-file. Before anything is judged, graph nodes are annotated with
facts the project model cannot carry — the same facts upstream reads per lint
run.

### 6. Select

Paths named on the command line narrow the run. A path outside the tree is a
usage error, not a silent empty selection. Cycle and lazy-load rules judge the
file graph as a whole, so a scoped run is a fast pre-check and not the gate.

### 7. Analyze

Each file is dispatched through two tables: extension → language, then language
→ analyzer. Each analyzer returns import records and failures. It never judges,
and it never throws on a malformed file — a failure is a record, because an
analyzer that threw would take down the run, and one that returned empty would
call it clean.

### 8. Judge the workspace's own declarations

Two checks that read no import: a Go workspace file's `use` list is compared
against every project's `go.mod`, and the TypeScript config's `paths` table is
judged for dead aliases. Both run on the CLI only, because their findings
describe the workspace rather than any open file.

### 9. Evaluate

The rules layer is pure: records and config in, violations out. No filesystem,
no version control, no network. That purity is what makes one verdict serve
three surfaces, and what lets all fifteen rules be driven from fixtures with no
workspace at all.

### 10. Suppress

Suppressions are applied after every import has been judged. A suppression
removes a verdict, never a failure. A file listed in suppressions is still fully
analyzed, and anything the analyzer could not read in it is still reported.

### 11. Report

The report renders and decides nothing. Two formats, two audiences: the terminal
report produces `file:line:column` links, and the SARIF report produces what
GitHub code scanning accepts. A formatter that filtered would be a rule wearing
a formatter's name.

### 12. Exit

Exit 0 is clean, 1 is findings, 3 is "could not look". The count of unchecked
files is computed inside `check()` rather than by the caller, so the exit code
and the report must agree. That line is the whole design.

## Why the cuts are where they are

Four seams, each justified by a specific failure it prevents.

**Analysis never judges.** An analyzer that filtered its own output would have
taken a decision away from the layer that owns it — and a rule change would then
need an analyzer change in every language.

**Rules never read files.** Purity is what makes one verdict serve three
surfaces. It is also what makes differential testing possible: two engines can
be handed the same records and the same options.

**The report decides nothing.** Two renderers of one verdict cannot disagree
about what is a violation.

**Options are the only layer that knows what a workspace named its files.**
Everything downstream takes a resolved name as an argument.

## What must never land

- A second copy of the constraint table.
- A second resolver for TypeScript import paths.
- A dependency on any sibling package outside the short allow-list.
- Any workspace's project names, areas or tag values — this repository's
  included.
- A shell-out to a language toolchain.

---

- The constraint table and how to design one → [boundaries.md](boundaries.md)
- What the project graph contains → [graph.md](graph.md)
- How the editor fits → [integrations.md](integrations.md)
- Adding a language → [../development/adding-a-language.md](../development/adding-a-language.md)
