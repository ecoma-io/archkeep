---
name: arch-context
description: Understand architecture boundaries and constraints before changing code in a Lattice-governed project
metadata:
  version: "0.4.0"
compatibility: Requires @ecoma-io/lattice CLI
---

## When to use

Before modifying code in any project that Lattice governs — especially when the
change touches imports, adds dependencies, or crosses project boundaries.

## Why

An agent that does not understand which imports a project is allowed to make will
create boundary violations by default. Running `arch-context` first surfaces the
constraints that matter, so the change respects them from the start rather than
breaking them and needing a fix.

## How

1. **Identify the project.** Find the project name for the file or directory you
   are about to change. If unsure, list projects with `lattice graph --format json`
   and match by root directory.

2. **Inspect the context.** Run:

   ```
   lattice context <project>
   ```

   This shows:
   - The project's tags (`layer:`, `scope:`, `license:`)
   - Every constraint that applies — what the project MAY import, and what is
     forbidden
   - Current dependencies, with any that already violate constraints marked

3. **Read the constraints.** Each constraint names a source tag pattern, a target
   tag pattern, and whether the import is `allowed` or `forbidden`. A project
   with `layer:domain` may be allowed to import `layer:domain` and `layer:shared`
   but forbidden from importing `layer:adapter`.

4. **Use JSON for precision.** For machine-readable output:

   ```
   lattice context <project> --format json
   ```

5. **Proceed within constraints.** Only then modify code, staying within the
   import directions the context described.

## What to do if it fails

- **Exit 3** — the run could not complete. This is NOT "clean"; it means Lattice
  could not reach a verdict. Check whether a workspace root, boundary config, or
  project graph is missing or malformed. Do not proceed as if the architecture is
  safe.
- **Project not found** — verify the project name matches what `lattice graph`
  reports. Names come from the project manifest, not the directory name.
- **No constraints shown** — the boundary config may be absent or may not apply
  any rule to this project's tags. This is NOT a green light; it is an unknown.
  The project has no declared boundaries, which means nothing is enforced.
