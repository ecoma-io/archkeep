---
name: arch-change
description: Make an architecture-aware change — inspect context and declared Intent first, change code inside the constraints, and produce verifiable evidence
compatibility: Requires @ecoma-io/archkeep CLI
---

## When to use

Before and after modifying code in a Archkeep-governed project — when adding or
removing imports, creating new files, changing cross-project dependencies, or
touching anything that declares or moves architecture (policy files,
`architecture-intent.json`, a profiles registry, `docs/adr/` records, project
manifests).

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
   archkeep context <project> --plan path/to/file.go
   ```

   Understand which dependency directions are allowed and which are forbidden,
   who depends on the project, current violations in scope, any drift, the
   declared Intent when one exists, and the commands that will verify the
   change. In a profile-selected workspace `context --plan` resolves the
   active profile the same way `check` does, including its bundled
   `impact`/`graph` facts.

2. **Understand the Intent and policy — and which law is in effect.** First
   confirm whether the workspace enforces by file or by named profile (see
   `arch-context`, step "Know which law is in effect"): when a `profiles`
   registry is active, the constraint rows you are reading are the selected
   profile's effective block, not a file. Then read the rows the context
   named, and check whether the workspace declares `architecture-intent.json`
   (`archkeep drift --format json` shows it and whether the observed graph
   agrees). The Intent states what the architecture _is_, not merely what the
   rule table allows. Do not change code that an existing Intent row
   forbids without first resolving that conflict with the team. When a
   constraint or intent row in the change's path carries a `decisionRef`, run
   `archkeep adr rule:no-direct-dep` (the reverse lookup: which ADR binds this
   rule?) and `archkeep adr 0001-bind-collaboration` (that record's status and
   rationale) before changing code the rule binds. The `decisionRef` literal
   names a record by its bare `NNN-slug` id — and `adr:NNN-slug` is that same
   record written with the `adr:` prefix the decisionRef docs recommend, the
   alternate spelling the registry normalises before lookup: both resolve to
   the same record. A `rule:`/`fitness:` id is the reverse lookup — which ADR
   binds this rule — and one no ADR binds is a fact about the registry,
   reported in a sentence with exit 0, not a resolved reference. Anything
   else, an ADR id the registry does not know, bare or `adr:`-prefixed, is
   no-verdict exit 3, never a clean "not enforced" sentence: verify the
   literal against the registry with `archkeep adr <id>`, or open
   `docs/adr/NNN-slug.md`.
   `archkeep adr <id>` confirms the binding and the record's status, but the
   decision itself — the rationale, the context, the consequences — lives in
   the record file: open `docs/adr/NNN-slug.md` and read the prose before
   changing code the rule binds.
   An ADR a rule references is committed governance, and changing the code it
   binds is a governance decision: a change that satisfies the rule table but
   contradicts the recorded decision is a review finding waiting to happen.
   An ADR id the registry does not know exits 3 — the grounding is `unknown`,
   never a pass. A fitness row is a policy decision like any other row: beside
   `name`/`match`/`condition`/`reason` it carries the same governance block
   keys (`origin`, `rationale`, `decisionRef`, `fitnessBindings`), so a
   fitness gate's `decisionRef` resolves exactly as a constraint row's does. A
   record whose status is `superseded` still binds its rows until a
   replacement is authored.

3. **Make the smallest coherent change.** Change the code, staying inside the
   import directions the context described. A source-code change is **not**
   automatically an architecture change; an _architecture_ change is one that
   moves the graph or its laws: project boundaries, dependency direction,
   project creation or removal, ownership boundaries, policy changes, the
   profile registry or the selected profile (a `profiles` registry edit, a
   profile's `block`, a `base` chain, or the default profile a `boundaryConfig`
   selects), Intent changes, or a provider migration. If the change is not of
   that kind, you are done once the check is green — do not invoke the heavier
   machinery. When the change adds or rewrites a rule the team will enforce,
   the decision behind it belongs in a recorded ADR — a new
   `docs/adr/NNN-slug.md` with `status: proposed`, `bindings` naming the rule
   id, reviewed like code (no command writes it; `archkeep adr` only reads).
   The rule row then carries that decision's `decisionRef`; a change that
   creates an enforceable rule without a recorded decision is governance
   debt, and `arch-review` will flag a rule whose `decisionRef` is missing or
   unresolvable.

   **A custom rule is that same law, compiled.** When the change adds or edits
   one of the workspace's own `customRules`, the edit is not finished when the
   rule's source is: rebuild the `.wasm` with the SDK for its language (four
   ship on the engine's own version chain — Rust, Go, TypeScript syntax
   through AssemblyScript, and Python), commit the artifact, and update the `sha256` the policy row pins, because
   that digest is what makes "the law CI ran is the law review saw" checkable
   on a file nobody can read in a diff. A stale digest is not a stale comment:
   the artifact fails to load and the whole run refuses (exit 3) rather than
   judging under a law nobody declared. The row's `reason` is mandatory the way
   a suppression's is, and it takes the same governance block a constraint row
   does, so everything above about `decisionRef` applies to it unchanged.
   Nothing is discovered by convention — a rule that is not declared judges
   nothing. Before writing one at all, check whether a declared `fitness` row
   already says it: a fitness function needs no toolchain, no artifact and no
   hash ([docs/usage/custom-rules.md](https://github.com/ecoma-io/archkeep/blob/main/docs/usage/custom-rules.md)).

4. **Inspect the architectural diff when the change is architectural.** If a
   baseline graph snapshot exists (from a prior
   `archkeep graph --format json --output baseline.json` run), compare:

   ```
   archkeep diff baseline.json --format json
   ```

   This shows the projects and edges added or removed, and — when a boundary
   config is available — which of the added edges introduce boundary violations
   and which removed edges resolve them.

   For the violation half of the same question — which violations did THIS
   change introduce or resolve — capture an evidence baseline before the
   change and compare after it:

   ```
   archkeep delta --capture --output delta-base.json   # before the change
   archkeep delta delta-base.json --format json        # after the change
   ```

   Both sides are re-judged under the current law, so a policy edit between
   capture and compare cannot fabricate an introduced/resolved pair. Exit 1
   means the change introduced a violation no active waiver covers; an
   introduced-but-waived entry is reported without gating, and belongs in the
   step-9 report as an accepted cost, not silence. Exit 3 is a refusal or an
   unclassifiable item — never "no change".

5. **Check constraints.** Run the authoritative gate:

   ```
   archkeep check --format json
   ```

   A full-workspace check is the verdict. A scoped check on the changed files is
   faster but omits cycle and lazy-load rules — it is a pre-check, not the gate.
   The check enforces the law in effect, declared where the project model puts
   it (`arch-context`, "Know which law is in effect"): in a profile-selected
   workspace — which is always an Nx one — the profile `boundaryConfig`
   selects (a one-run `archkeep check --config <name>` overrides the
   selection). There, read the `boundaryConfig` value in `nx.json`'s plugin
   options — that string IS the active profile name — and verify the check
   resolves exactly it; a check that resolves a different profile than the one
   in effect is not the verdict the change needs. In a native or Moon
   workspace the law is the policy file (or `archkeep.json`'s inline policy)
   itself. Write the law down at the start of the change — `--config <NAME>`
   in effect — so the evaluation step 9 reports is the one the change was
   actually made against.

6. **Inspect drift when the architecture changed or the Intent is at stake.**
   If the change created or removed projects or edges, or touches anything the
   Intent names, confirm the observed graph still agrees with the declared one:

   ```
   archkeep drift --format json
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
   archkeep impact <project> --format json
   ```

   An empty dependents list is a claim ("nothing depends on this"), not a shrug.
   For a change that does not alter what a project exposes (an internal
   implementation detail, a test, a comment), this step is skipped — that is
   the step-3 shortcut: done once the check is green, no heavier machinery.

8. **Re-run relevant checks.** Fix any violation by changing the code, not the
   law, and re-run the full check until it is green. A declared custom rule
   that answered `unknown` is exit 3 — a gate that did not run, never a clean
   result: get the evidence it was handed with
   `archkeep check --evidence-out <dir>` (an existing directory, one
   `<rule>.json` per declared rule, no verdict and no exit code moved) and fix
   the rule or the tree before reporting anything about that law.

9. **Report what changed and why.** State the projects and edges the change
   introduced or removed, the evidence commands that verified it, and any
   coverage gap (exit 3) you could not clear. State the law the gate ran with —
   the exact `--config <NAME>` (or the `boundaryConfig` value) the check
   resolved — so a report reading "check green" still carries the name of the
   law it was green under. A report that names no law cannot be reproduced, and
   in a profile-selected workspace it hides the one fact that makes a
   profile-swap detectable.

## Interpreting exit codes

- **Exit 0** — no violations found. The change respects boundaries and the
  declared Intent.
- **Exit 1** — violations exist. Read each one: it names the file, the import,
  and the violated constraint. Fix the code, not the policy. Re-check. Exit 1
  from `check` also covers intent findings — a forbidden path appeared or an
  allowed relationship is missing — which may point at a code change, not a
  policy one.
- **Exit 3** — the run could not complete. This is NOT "clean." Investigate the
  coverage gap before proceeding — including a profile that could not be
  resolved: unknown profile name, unknown `base`, a `base` cycle, or an
  unreadable registry. None of these falls back to another law.
- **Exit 2** — usage error. Fix the invocation.

## Safety constraints

- **Never modify the boundary policy, the profile registry, or the Intent to
  make a check pass.** The policy (`module-boundaries.config.*`), a `profiles`
  registry (every profile's `block`, the `base` chain, and the default profile
  `boundaryConfig` selects), and `architecture-intent.json` are the authority —
  reviewed like code, owned by the team. The name that selects the law is part
  of the law: the plugin option that names the `profiles` registry, and the
  `boundaryConfig`/`--config` value that selects a profile, are governance
  state, not a flag you may flip to get a green run. If the code cannot comply,
  change the code or escalate. An Intent or profile change is a governance
  decision, read `arch-check` on the difference, and confirm with a human.
  **Never switch the active profile merely to make a check pass** — that is
  editing the law under a different name, and it is the one move that lets a
  violation vanish while the boundary table looks untouched. Report the exact
  `--config <NAME>` the gate ran with; a red under the team's active profile is
  a violation to fix in code or escalate, not a law to swap.
- **A scoped check is not the gate.** `archkeep check <paths>` judges only the
  listed files; cycle and lazy-load rules need the whole graph, and a fitness
  function that needs the whole tree (`coverage-minimum` today) reports
  `not_applicable` rather than a real verdict. Use it for speed, but run a full
  check before committing.
- **Report unresolved violations rather than suppress them.** If you cannot fix
  a violation, say so explicitly. A silent violation is worse than a loud one.
- **Proposed is not authoritative.** `reconcile --propose` and
  `discover --propose` derive candidate architecture or repair edits, and mark
  them as proposals that are never written. Nothing in `drift`, `diff`,
  `reconcile`, or `discover` writes to the Intent — proposals are for
  surfacing, and a human decides the architecture.

## What to do if it fails

- **Exit 3 after change** — coverage is incomplete. Do not assume the workspace
  is clean. Investigate what Archkeep could not analyze — including a profile
  resolution failure in a profile-selected workspace.
- **Violations in unrelated files** — your change may have exposed pre-existing
  violations. These still need attention, but they are not caused by your edit;
  say so in the report.
- **`drift` exit 3 after an Intent-adjacent change** — the intent comparison
  cannot be verified. The change's governance status is unknown, not clean. If
  the run names a missing `architecture-intent.json`, the workspace simply has
  no declared Intent: the `check` verdict from step 5 is the whole story, not a
  gap.
- **`archkeep check` hangs or times out** — the workspace graph may be very large.
  Try a scoped check on your changed files first, then run the full check.
