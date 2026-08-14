---
name: arch-review
description: Review a change or PR for architecture impact — context, diff, check, impact, explain, and summarize
metadata:
  version: "0.4.0"
compatibility: Requires @ecoma-io/lattice CLI
---

## When to use

When reviewing a change, pull request, or diff for architecture impact —
especially changes that touch cross-project imports, add dependencies, or modify
policy-adjacent files.

For a trivial edit (whitespace, comments, string constants in an isolated
module), `arch-check` alone may suffice. This skill is for changes where the
architecture consequences matter.

## Why

A code review that does not assess architecture impact misses the most
consequential changes. An import that crosses a forbidden boundary is a real
violation even if the code compiles and tests pass. `arch-review` walks through
the architecture dimensions of a change so the reviewer can assess what the diff
does not show.

## How

1. **Context.** For each project touched by the change, run:

   ```
   lattice context <project>
   ```

   Understand what constraints apply — which dependency directions are allowed
   and which are forbidden. If the project has no constraints, that is an
   unknown, not a green light.

2. **Diff.** If a baseline graph snapshot exists (from a prior `lattice graph
--format json` run), compare the current graph against it:

   ```
   lattice diff <baseline-snapshot.json>
   ```

   This shows added and removed edges, project changes, and — when a boundary
   config is available — rule-impact analysis for each changed edge. A diff with
   `--format json` provides the same data structured for programmatic use.

3. **Check.** Run the boundary check to see the current violation state:

   ```
   lattice check --format json
   ```

   New violations relative to the baseline indicate where the change broke
   compliance. Removed violations indicate where it improved compliance.

4. **Impact.** For each changed project, see who depends on it:

   ```
   lattice impact <project>
   ```

   An empty `dependents` list is a claim ("nothing depends on this"), not a
   shrug. A non-empty list shows the blast radius: which other projects would be
   affected by a change to this one.

5. **Explain.** For any violation that needs understanding:

   ```
   lattice explain <file:line:column>
   ```

   This shows the judgment reasoning: the import, the tags on both sides, and
   the specific constraint that was matched or violated.

6. **Summarize architecture impact.** Report:

   - New violations introduced by the change
   - Existing violations removed by the change
   - Changes to the dependency graph (new or removed edges)
   - Constraint changes (if the boundary config was modified)
   - Downstream impact: projects that depend on the changed projects
   - Coverage gaps: any file or project the check could not analyze

## Scope judgment

- **Trivial changes** (formatting, comments, constants in an isolated module):
  `arch-check` alone may be sufficient. The full review workflow adds little.
- **Cross-project changes** (new imports, dependency additions, refactors that
  move code between projects): use the full review workflow. The architecture
  consequences are the most important part of the review.
- **Policy changes** (modifications to `module-boundaries.config.*`): the full
  review workflow is essential. A policy change affects every project in the
  workspace; `lattice diff` with `--config` shows the rule-impact analysis.

## What to do if it fails

- **`lattice diff` exit 3** — the baseline or the head is incomplete. The diff
  is unreliable; do not treat it as "no changes." Re-generate the baseline with
  `lattice graph --format json` and try again.
- **`lattice impact` returns empty dependents** — that is a claim, not a shrug.
  Nothing in the workspace depends on this project. Verify this is expected.
- **`lattice check` exit 3** — coverage is incomplete. The review cannot reach a
  verdict on the unchecked files. State this in the review summary.
- **Multiple violations, unclear which are new** — compare the check output
  against the baseline. If no baseline exists, the check output shows the
  current state but cannot distinguish new from pre-existing violations.
