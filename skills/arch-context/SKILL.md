---
name: arch-context
description: Establish the architectural facts and governance constraints relevant to a change before modifying code in a Lattice-governed project
metadata:
  version: "0.4.0"
compatibility: Requires @ecoma-io/lattice CLI
---

## When to use

Before modifying code in any project that Lattice governs — especially when the
change touches imports, adds dependencies, or crosses project boundaries. Also
when starting an unfamiliar workspace, to learn what the architecture is and
what is enforced.

## Why

An agent that does not understand which imports a project is allowed to make
will create boundary violations by default. Architecture is not an opinion — it
is a deterministic comparison between observed code and declared intent — and an
agent that reads the facts first can plan the change inside the constraints
instead of breaking them and needing a fix. If declared state looks wrong, the
answer is to surface it, never to ignore it.

## How

1. **Identify the affected projects.** Find the project name for each file or
   directory the change touches. If unsure, list projects with
   `lattice graph --format json` and match by root directory.

2. **Determine what exists and what governs it.** Run:

   ```
   lattice context <project> --format json
   ```

   This shows:
   - The project's tags (`layer:`, `scope:`, `license:`)
   - Every constraint that applies — what the project MAY import, and what is
     forbidden
   - Any current dependencies, with any that already violate constraints
     marked. Per-edge verdicts here cover only `depConstraints` (3 of 15
     violation types) — a dependency with no violations in this list may still
     violate a cycle, lazy-load, or npm-ban rule. `context --plan` or `check`
     is the complete verdict.

3. **Check the declared Intent.** When the workspace carries a tracked
   `architecture-intent.json`, the architecture is a comparison, not a row of
   tables. See whether the intent file exists and what it declares before you
   treat the current structure as the intended one:

   ```
   lattice drift --format json
   ```

   Drift prints the intent fingerprint and every intent row the observed graph
   violates. Exit 3 means the comparison could not be completed — an
   _unverifiable_ intent must never be read as _no drift_.

4. **For a planned change, request the planning context.** When about to change
   code (not just read it):

   ```
   lattice context <project> --plan
   ```

   or, scoped to the files the change touches:

   ```
   lattice context <project> --plan path/to/file.go path/to/other.rs
   ```

   `--plan` adds the deterministic facts an agent needs to plan safely: the
   current architecture snapshot, the applicable policy with the author's
   Intent (each constraint row's `description`/`remediation`), the impact of a
   change to the project (who depends on it), the current violations (the
   full-workspace rule-engine verdict, scoped for reporting), drift (go.work
   and tsconfig-path aliases), coverage with the exact files that could not be
   analyzed, and the commands that verify the change afterwards. Trailing paths
   scope the change; with no paths, the whole workspace is in scope.

   `--plan` is facts, not a plan. Lattice never decides an implementation
   strategy — the agent reasons over these facts and produces the plan.

5. **Read the constraints.** Each constraint names a source tag pattern, a target
   tag pattern, and whether the import is `allowed` or `forbidden`. A project
   with `layer:domain` may be allowed to import `layer:domain` and `layer:shared`
   but forbidden from importing `layer:adapter`.

6. **Assess downstream and historical context when relevant.** If the project is
   imported by others, `lattice impact <project> --format json` lists its
   transitively dependent projects — the blast radius of the change. If the
   repository keeps graph snapshots, `lattice history <dir>` describes how the
   architecture evolved, so you can distinguish a permission that has always
   been there from one that appeared a snapshot ago. An empty or missing
   snapshots directory is a no-verdict run (exit 3), never a clean "no
   evolution" — point it at a populated capture directory, or skip the step and
   say no history was inspected.

7. **Understand the surrounding governance surfaces when the facts need
   context.** These are descriptive, never gates — they never exit 1:
   `lattice waivers` lists the term-bound suppressions a violation under review
   may be covered by; `lattice health` reports per-metric verdicts (unmeasured
   is `unknown`/`not_applicable`, never zero); `lattice debt <dir>` ages waivers,
   gaps and drift across snapshots; `lattice fitness` (when the policy declares
   a `fitness` export) judges the workspace's named quality gates; and
   `lattice reconcile --propose` / `lattice discover --propose` shape a stale
   model or a blank one — all proposals, never written. Consult them for
   context, and let their zero-verdict exits stay out of the change's clean/not
   verdict: `check` is the only command that exits 1.

8. **Proceed within constraints.** Only then modify code, staying within the
   import directions the context described.

## Choosing the minimum sufficient set

Run only what the change needs. The default is `context` (+ `--plan` for a
code change). Add:

- `impact` — when the change alters a project others depend on (its API, its
  output, or its very existence).
- `drift` — when you need the declared Intent, or are validating whether the
  architecture is in the state the declarations claim.
- `history` — when the change follows or revisits recent architectural
  evolution, or when a permission looks out of place.
- `waivers`, `health`, `debt`, `fitness`, `reconcile`, `discover` — when the
  facts under the change involve a term-bound suppression, a quality claim, an
  aging ledger, a named quality gate, a stale model, or an undeclared one.
- `check` — to see the current violation state (though `context --plan` already
  reports it scoped for reporting).

## What to do if it fails

- **Exit 3** — the run could not complete. This is NOT "clean"; it means Lattice
  could not reach a verdict. Check whether a workspace root, boundary config, or
  project graph is missing or malformed. Do not proceed as if the architecture is
  safe.
- **`drift` exit 3** — the intent comparison could not be verified (intent file
  unreadable, a boundary matched no observed project). Surface this in your
  change notes; the declared architecture is not confirmed.
- **Project not found** — verify the project name matches what `lattice graph`
  reports. Names come from the project manifest, not the directory name.
- **No constraints shown** — the boundary config may be absent or may not apply
  any rule to this project's tags. This is NOT a green light; it is an unknown.
  The project has no declared boundaries, which means nothing is enforced.
