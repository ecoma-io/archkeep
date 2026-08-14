---
name: arch-check
description: Validate architecture boundaries after changes — the authoritative verdict on whether a workspace or files comply with its boundary policy
metadata:
  version: "0.4.0"
compatibility: Requires @ecoma-io/lattice CLI
---

## When to use

After changes, before committing. Also on demand to validate a workspace's
architecture integrity — for example, at the start of a session to understand
the current state.

## Why

`lattice check` is the authoritative verdict on boundary compliance. It compares
every import in the workspace against the constraint table and reports violations.
No other command gives this answer. Running it is the only way to know whether
the architecture is sound.

## How

1. **Run the check.**

   Full workspace (authoritative):

   ```
   lattice check
   ```

   Scoped to specific files (fast pre-check):

   ```
   lattice check path/to/file.go path/to/other.rs
   ```

2. **Choose the output format.**

   - `--format text` — human-readable terminal output (default)
   - `--format json` — structured JSON envelope for programmatic use
   - `--format sarif` — SARIF 2.1.0 for GitHub code scanning upload

3. **Interpret the exit code.**

   - **Exit 0** — no violations found. The workspace is compliant. The number of
     files, projects, and imports inspected is stated beside the verdict.
   - **Exit 1** — violations exist. Each violation names the source file, the
     target project, and the constraint that forbids the import. This is the only
     command that exits 1.
   - **Exit 3** — the run could not complete. This is NOT "clean"; it means
     Lattice could not reach a verdict. Check for missing workspace roots,
     malformed configs, or files that could not be read.
   - **Exit 2** — usage error (wrong flag, missing argument). Fix the invocation.

4. **Read the violations.** Each one tells you:

   - The file and line where the violating import was written
   - The project that contains the file
   - The target project being imported
   - The specific constraint rule that was broken (`messageId`)

5. **Explain individual violations.** For any violation that is unclear:

   ```
   lattice explain <file:line:column>
   ```

   This shows the import specifier, the source and target tags, the matched
   constraints, and whether the judgment is a violation or allowed.

6. **For CI: generate SARIF.**

   ```
   lattice check --format sarif --output boundaries.sarif
   ```

## Important distinctions

- **Empty output from a scoped check does NOT mean the workspace is safe.**
  Cycle rules and lazy-load rules judge the whole file graph, not individual
  files. A scoped check is a fast filter; a full check is the gate.
- **Exit 3 is never "clean."** A check that could not look must never be mistaken
  for one that looked and found nothing. If Lattice could not analyze a file,
  the verdict for that file is unknown — not absent.
- **An empty violations list is a claim.** When exit 0, Lattice states what it
  inspected: files, projects, imports. "No violations" means those imports were
  checked and all complied.

## What to do if it fails

- **Exit 3** — investigate the coverage gap. Common causes: no workspace root
  detected, malformed boundary config, missing language manifests.
- **Unexpected violations** — use `lattice explain` to understand why each import
  was flagged before deciding how to respond.
- **No violations but expected some** — verify the boundary config applies to the
  relevant project tags. A project with no matching constraints is unconstrained,
  not compliant.
