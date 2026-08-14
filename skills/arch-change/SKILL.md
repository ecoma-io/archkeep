---
name: arch-change
description: Architecture-aware coding workflow — inspect boundaries before changing code, then verify the change respects them
metadata:
  version: "0.4.0"
compatibility: Requires @ecoma-io/lattice CLI
---

## When to use

Before and after modifying code in a Lattice-governed project — when adding or
removing imports, creating new files, or changing cross-project dependencies.

## Why

An import that crosses a forbidden boundary compiles and runs fine but violates
the architecture. `arch-change` ensures the agent checks constraints before
editing and verifies the result after, so violations are caught at the point of
introduction rather than in CI.

## How

1. **Before the change** — run `arch-context` for the target project. Understand
   which dependency directions are allowed and which are forbidden.

2. **Make the change** — modify code respecting the constraints identified above.

3. **After the change** — run a targeted check:

   ```
   lattice check --format json
   ```

   A full-workspace check is the authoritative verdict. A scoped check on the
   changed files is faster but omits cycle and lazy-load rules — it is a
   pre-check, not the gate.

4. **Interpret the exit code:**

   - **Exit 0** — no violations found. The change respects boundaries.
   - **Exit 1** — violations exist. Read each one: it names the file, the import,
     and the violated constraint. Fix the code, not the policy. Re-check.
   - **Exit 3** — the check could not complete. This is NOT "clean." Investigate
     the coverage gap before proceeding.

5. **Resolve violations by fixing code.** If a new import is forbidden, find an
   allowed alternative: move the code, introduce a facade, or restructure the
   dependency. Re-run `lattice check` after each fix.

## Safety constraints

- **Never modify the boundary policy to make a check pass.** The policy
  (`module-boundaries.config.*`) is the authority. If the code cannot comply with
  the existing policy, the right answer is to change the code or escalate — not
  to weaken the rule.
- **A scoped check is not the gate.** `lattice check <paths>` judges only the
  listed files; cycle and lazy-load rules need the whole graph. Use it for speed,
  but run a full check before committing.
- **Report unresolved violations rather than suppress them.** If you cannot fix
  a violation, say so explicitly. A silent violation is worse than a loud one.

## What to do if it fails

- **Exit 3 after change** — coverage is incomplete. Do not assume the workspace
  is clean. Investigate what Lattice could not analyze.
- **Violations in unrelated files** — your change may have exposed pre-existing
  violations. These still need attention, but they are not caused by your edit.
- **`lattice check` hangs or times out** — the workspace graph may be very large.
  Try a scoped check on your changed files first, then run the full check.
