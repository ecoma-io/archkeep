---
name: arch-change
description: Make an architecture-aware change — inspect context and declared Intent first, change code inside the constraints, and produce verifiable evidence
metadata:
  version: "0.4.0"
compatibility: Requires @ecoma-io/lattice CLI
---

## When to use

Before and after modifying code in a Lattice-governed project — when adding or
removing imports, creating new files, changing cross-project dependencies, or
touching anything that declares or moves architecture (policy files,
`architecture-intent.json`, project manifests).

## Why

An import that crosses a forbidden boundary compiles and runs fine but violates
the architecture. `arch-change` ensures the agent reads the constraints before
editing and verifies the result after, so violations are caught at the point of
introduction rather than in CI. Verifiable evidence matters too: the same
machine-readable output used to make the change is what a reviewer re-runs to
confirm it.

## How

1. **Establish context.** Run `arch-context` for the target project, and where
   the change is non-trivial, request the planning context:

   ```
   lattice context <project> --plan path/to/file.go
   ```

   Understand which dependency directions are allowed and which are forbidden,
   who depends on the project, current violations in scope, any drift, the
   declared Intent when one exists, and the commands that will verify the change.

2. **Understand the Intent and policy.** Read the constraint rows the context
   named, and check whether the workspace declares `architecture-intent.json`
   (`lattice drift --format json` shows it and whether the observed graph
   agrees). The Intent states what the architecture _is_, not merely what the
   rule table allows. Do not change code that an existing Intent row
   forbids without first resolving that conflict with the team.

3. **Make the smallest coherent change.** Change the code, staying inside the
   import directions the context described. A source-code change is **not**
   automatically an architecture change; an _architecture_ change is one that
   moves the graph or its laws: project boundaries, dependency direction,
   project creation or removal, ownership boundaries, policy changes, Intent
   changes, or a provider migration. If the change is not of that kind, you are
   done once the check is green — do not invoke the heavier machinery.

4. **Inspect the architectural diff when the change is architectural.** If a
   baseline graph snapshot exists (from a prior
   `lattice graph --format json --output baseline.json` run), compare:

   ```
   lattice diff baseline.json --format json
   ```

   This shows the projects and edges added or removed, and — when a boundary
   config is available — which of the added edges introduce boundary violations
   and which removed edges resolve them.

5. **Check constraints.** Run the authoritative gate:

   ```
   lattice check --format json
   ```

   A full-workspace check is the verdict. A scoped check on the changed files is
   faster but omits cycle and lazy-load rules — it is a pre-check, not the gate.

6. **Inspect drift when the architecture changed or the Intent is at stake.**
   If the change created or removed projects or edges, or touches anything the
   Intent names, confirm the observed graph still agrees with the declared one:

   ```
   lattice drift --format json
   ```

   `drift` requires a tracked `architecture-intent.json` at the workspace root.
   In a workspace without one, it exits 3 naming the missing file: that is
   "the workspace chose not to declare an Intent", not a finding. `check` (step 5) already folds the intent comparison in by presence, so on an intent-less
   workspace the clean `check` verdict stands and there is nothing more to
   inspect.

7. **Verify impacted projects — only when the change is visible to
   dependents.** For a project whose API, output, or existence changed, confirm
   who depends on it:

   ```
   lattice impact <project> --format json
   ```

   An empty dependents list is a claim ("nothing depends on this"), not a shrug.
   For a change that does not alter what a project exposes (an internal
   implementation detail, a test, a comment), this step is skipped — that is
   the step-3 shortcut: done once the check is green, no heavier machinery.

8. **Re-run relevant checks.** Fix any violation by changing the code, not the
   law, and re-run the full check until it is green.

9. **Report what changed and why.** State the projects and edges the change
   introduced or removed, the evidence commands that verified it, and any
   coverage gap (exit 3) you could not clear.

## Interpreting exit codes

- **Exit 0** — no violations found. The change respects boundaries and the
  declared Intent.
- **Exit 1** — violations exist. Read each one: it names the file, the import,
  and the violated constraint. Fix the code, not the policy. Re-check. Exit 1
  from `check` also covers intent findings — a forbidden path appeared or an
  allowed relationship is missing — which may point at a code change, not a
  policy one.
- **Exit 3** — the run could not complete. This is NOT "clean." Investigate the
  coverage gap before proceeding.
- **Exit 2** — usage error. Fix the invocation.

## Safety constraints

- **Never modify the boundary policy or the Intent to make a check pass.** The
  policy (`module-boundaries.config.*`) and `architecture-intent.json` are the
  authority — reviewed like code, owned by the team. If the code cannot comply,
  change the code or escalate. An Intent change is a governance decision, read
  `arch-check` on the difference, and confirm with a human.
- **A scoped check is not the gate.** `lattice check <paths>` judges only the
  listed files; cycle and lazy-load rules need the whole graph. Use it for speed,
  but run a full check before committing.
- **Report unresolved violations rather than suppress them.** If you cannot fix
  a violation, say so explicitly. A silent violation is worse than a loud one.
- **Proposed is not authoritative.** `reconcile --propose` and
  `discover --propose` derive candidate architecture or repair edits, and mark
  them as proposals that are never written. Nothing in `drift`, `diff`,
  `reconcile`, or `discover` writes to the Intent — proposals are for
  surfacing, and a human decides the architecture.

## What to do if it fails

- **Exit 3 after change** — coverage is incomplete. Do not assume the workspace
  is clean. Investigate what Lattice could not analyze.
- **Violations in unrelated files** — your change may have exposed pre-existing
  violations. These still need attention, but they are not caused by your edit;
  say so in the report.
- **`drift` exit 3 after an Intent-adjacent change** — the intent comparison
  cannot be verified. The change's governance status is unknown, not clean. If
  the run names a missing `architecture-intent.json`, the workspace simply has
  no declared Intent: the `check` verdict from step 5 is the whole story, not a
  gap.
- **`lattice check` hangs or times out** — the workspace graph may be very large.
  Try a scoped check on your changed files first, then run the full check.
