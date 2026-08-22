---
name: arch-migrate
description: Bring an existing repository under Lattice governance — derive a candidate model from what is observed, review it, and write the Intent by hand as a diff a human can refuse
compatibility: Requires @ecoma-io/lattice CLI
---

## When to use

When a repository has an architecture but has not declared one, and the task is
to bring it under governance: no `architecture-intent.json` at the workspace
root, or one that was written long enough ago that nobody trusts it. Also when
onboarding a large legacy tree where hand-writing the model up front would be
guesswork.

Not for a workspace that already has a model the team stands behind. There the
change is an ordinary one (`arch-change`), the verdict is `arch-check`, and a
model that has merely gone stale is `arch-review`'s step on a stale model —
this skill is for the case where the model does not exist yet, or must be
rebuilt from scratch.

## Why

An agent asked to "set up Lattice here" will, by default, write an
`architecture-intent.json` from whatever it inferred while reading the code.
That file is law: `check` gates on it, and CI turns red on it. A model produced
by inference and adopted without review is a law nobody authored — and because
it was derived from the code as it currently stands, it silently blesses every
violation the repository already contains. The resulting green run is the
worst possible outcome: an enforced architecture that enforces the mess.

The `--propose` surfaces exist so the derivation and the adoption are separate
acts. Lattice derives; a human adopts. The agent's job is to make the second
act easy to perform and easy to refuse — never to perform it silently.

## How

1. **Confirm the workspace has a root marker.** Every step below needs one. A
   tree with none refuses:

   ```
   lattice discover
   ```

   Exit 3 naming `nx.json`, `lattice.json` or `.moon` means there is no
   workspace to govern yet. Adding the marker is a repository decision — say
   which one the repository should carry and why, and let the human make it.
   Do not create it silently as a side effect of "setting up".

2. **Observe, and clear coverage before anything else.**

   ```
   lattice discover --format json
   ```

   `discover` is descriptive and exits 0 on a complete read. An incomplete
   one exits 3 while still printing a full-looking report — read the coverage
   line, not the project list. Every file the analyzer could not read is a
   hole the derived model would silently be missing, so this is the first
   thing to fix and the only step that may not be skipped: give the file a
   project that owns it, or name it in `lattice.json`'s `coverage.exempt`
   with a reason. Report which you chose.

3. **Derive candidates.**

   ```
   lattice discover --propose --format json --output proposal.json
   ```

   Every candidate carries `proposed: true` and `notAuthoritative: true`, and
   the text report prefixes each line `[proposed — not authoritative]`. Under
   `--propose` an incomplete coverage read is a **refusal**, not a warning —
   the command declines to produce candidates at all rather than derive them
   from a tree it did not finish reading. If step 2 was done, this exits 0.

   Nothing is written to the workspace by this command, under any flag.

4. **Review the candidates against what the repository is FOR.** This is the
   step that carries the whole skill, and no command performs it.

   A proposal describes what the code does — including what it does wrong. The
   dependency someone added under deadline is observed exactly as faithfully as
   the one the architecture intended, and the output does not distinguish them.
   So for each candidate, decide which it is:

   - it states the intended architecture → keep it;
   - it states a violation the repository is being migrated away from → invert
     it (declare the rule the violation breaks), do not adopt it;
   - it cannot be told apart without knowledge the agent does not have → say
     so, and ask.

   Every candidate carries a `confidence` of `high`, `medium` or `low` and the
   `evidence` it was derived from. Sort by those, and put the low-confidence
   candidates in front of the human first — they are the ones least likely to
   survive contact with someone who knows the repository.

5. **Write the Intent as a reviewable diff — never as a silent adoption.**

   The agent may author `architecture-intent.json` and the boundary config, and
   should: producing the file is useful work. What it must not do is produce it
   as a side effect the human discovers later. Present it as an explicit diff,
   state that it is derived from the proposal and which candidates were
   inverted or dropped, and let the human refuse it. If the human does not
   review it, it is not adopted — say that plainly rather than proceeding.

   The two files are law and are reviewed like code:
   `architecture-intent.json` states what the architecture IS
   ([docs/reference/architecture-intent.md](../../docs/reference/architecture-intent.md)),
   and the boundary config states which imports are permitted
   ([docs/concepts/policies.md](../../docs/concepts/policies.md)).

   **A shipped policy pack is a starting point for the second file.** Six ship
   with the package under `presets/` — clean architecture, hexagonal, layered,
   modular monolith, vertical slice, DDD bounded contexts — each a profile
   registry that states the tag vocabulary it expects. An Nx workspace either
   copies one in and names the copy in the `profiles` plugin option (the copy
   is yours to extend, and a Lattice upgrade then cannot change what CI
   enforces) or points `profiles` at the file inside `node_modules` and accepts
   that an upgrade can move the law. A `lattice.json` or Moon workspace has no
   `profiles` option, so it copies the profile's `block` into its own `.json`
   boundary law instead — flattening a `base` chain by hand first, base before
   child, because nothing resolves it once the `block` has left the registry. Adopting a pack is the same act as adopting a derived
   candidate and gets the same treatment: it is a proposal until a human takes
   it, the step-4 candidates are what say whether this tree actually matches
   the style, and a pack whose tag vocabulary the repository does not carry
   enforces nothing while looking enforced
   ([docs/usage/presets.md](../../docs/usage/presets.md)).

   **A rule the migration writes is a rule somebody has to defend later.**
   Where the decision behind a row is not evident from the row, record it as
   `docs/adr/NNN-slug.md` with `status: proposed` and `bindings` naming the
   rule id, and give the row that record's `decisionRef` — the same discipline
   `arch-change` requires of every enforceable rule. Write the record in the
   same change as the citation: an **intent** row citing an id the registry
   does not know makes `check` a no-verdict run (exit 3), which is worse than a
   row that cites nothing. No command writes an ADR — `lattice adr` only reads
   ([docs/concepts/adr.md](../../docs/concepts/adr.md)).

   Write the boundary config before running `drift`: `drift` resolves the
   boundary law and exits 3 when the file `boundaryConfig` names is absent,
   which reads like a failed comparison rather than a missing file.

6. **Converge, one divergence at a time.**

   ```
   lattice reconcile --propose --format json
   ```

   `reconcile` scores every observed project and edge against the declared
   model and ranks the model edits that would make the two agree. It exits 0
   whether or not it found divergence — it is descriptive, never a gate.

   Each round: pick one divergence, decide whether the CODE or the MODEL is
   wrong, change that side, re-run. **The ranking is not the decision.** A
   candidate list run mid-migration will readily propose relaxing the very
   intent row that names the violation being migrated away from — its own
   wording is "relax the row **or** change the boundary", because it cannot
   tell which is right. Adopting the relaxation makes the run green by
   deleting the rule, which is the one outcome the migration exists to
   prevent. When a candidate would weaken a rule, do not apply it: name it and
   escalate.

7. **Enforce, and hand over the gate.**

   ```
   lattice drift --format json
   lattice check --format json
   ```

   `drift` describes the disagreement and exits 0 even when it finds one;
   `check` is the gate and exits 1 on findings, folding the intent comparison
   in by presence. Only `check` belongs in CI as the blocking step
   ([docs/usage/ci.md](../../docs/usage/ci.md)).

8. **Report the migration.** State: which marker the workspace carries, what
   coverage gaps were cleared and how, which candidates were adopted, which
   were inverted or dropped and why, the model files written, and the final
   `check` exit code with the law it ran under. A migration whose report does
   not say which candidates were rejected cannot be reviewed — it reads as if
   the tool decided.

The whole path, with the detail each step needs, is
[docs/usage/migration.md](../../docs/usage/migration.md).

## The authority boundary

The line this skill exists to hold, and the one an agent is most likely to
cross while being helpful:

- **A proposal is never a decision.** `discover --propose` and
  `reconcile --propose` derive candidates and mark every one of them
  `proposed` / `notAuthoritative`. Neither command writes
  `architecture-intent.json`, and there is no flag that applies a candidate.
  The absence of that flag is deliberate, not a missing feature to work around
  with a file write.
- **The agent may draft the law; it may not enact it.** Writing the Intent file
  is allowed and useful. Writing it without presenting it as a diff the human
  can refuse is not — that converts a derivation into an adoption, which is a
  decision the agent does not hold
  ([docs/doctrine/architecture-authority.md](../../docs/doctrine/architecture-authority.md)).
- **Never derive the model from a tree that was not fully read.** An incomplete
  coverage read is exit 3 at every step above. Clear it; do not route around it.
- **Never weaken a rule to reach green.** During a migration the model and the
  code disagree by design — that is the migration. Editing the model to end the
  disagreement is only correct when the model is what is wrong, and that
  judgment belongs to the team.

## What to do if it fails

- **Exit 3 from `discover`** — either no workspace root, or incomplete
  coverage. Both are fixable and neither is clean. Do not proceed to
  `--propose`: the refusal there is the same gap, and it is telling you the
  candidates would be fabricated.
- **Exit 3 from `discover --propose` after a clean `discover`** — the plain run
  reported an incomplete read that was easy to miss because it still printed a
  report. Re-read the coverage line.
- **Exit 3 from `drift`** — the boundary law could not be loaded, the intent
  file is unreadable, or a row matched no observed project. A missing config
  file is the common one during a migration, and it is not drift; check whether
  the file `boundaryConfig` names exists before reading the result as a
  comparison at all.
- **Exit 3 from `reconcile`** — the model cannot be scored. That is not "no
  divergence"; say so rather than reporting the migration converged.
- **`check` exit 1 with many findings on the first enforced run** — expected.
  A migration's first green is earned by fixing code or by consciously
  narrowing the model, not by loosening the law until the count reaches zero.
  Report the count and the list; do not silently edit the Intent to shrink it.
- **A proposal that contradicts the team's stated architecture** — trust the
  team, not the derivation. The proposal describes the code as it is, and the
  point of the migration is that the code as it is is not yet what was
  intended.
- **Exit 2** — usage error: a positional argument a command does not take, or
  an unknown flag. Fix the invocation.
