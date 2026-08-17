---
name: arch-check
description: Run the authoritative governance gate after a change — boundary rules and declared Intent, as a fail-closed deterministic verdict
compatibility: Requires @ecoma-io/lattice CLI
---

## When to use

After changes, before committing. Also on demand to validate a workspace's
architecture integrity — for example, at the start of a session to understand
the current state, or when a `drift` comparison or a `check` in CI reports
red.

## Why

`lattice check` is the authoritative governance gate for a Lattice-governed
workspace. It judges every import against the constraint table **and** folds the
declared architecture intent in by presence: everything the workspace states
about its own structure is compared with what the files actually do, in one
deterministic run. No other command gives this answer. Running it is the only
way to know whether the architecture is sound — and any change that claims to
leave it sound must show the check green.

## How

1. **Run the gate — against the law in effect.**

   Full workspace (authoritative — also the form CI runs):

   ```
   lattice check
   ```

   Scoped to specific files (fast pre-check):

   ```
   lattice check path/to/file.go path/to/other.rs
   ```

   Know whether this workspace enforces by **file** or by **named profile**
   before you read the verdict. A `profiles` registry in the plugin options
   makes `boundaryConfig` (and a one-run `--config` override) a profile NAME
   selected from that registry, not a file path; without one, both are file
   paths. The default `check` enforces the profile `boundaryConfig` selects —
   read the `boundaryConfig` value in `nx.json`'s plugin options, because that
   string IS the active profile name, and the bare run resolves it. If you pass
   `--config`, it must equal that value to be a verification of the active law.
   Review a different law without touching the registered one the same way the
   CLI overrides a filename:

   ```
   lattice check --config migration
   ```

   A run that resolves a different profile than in effect is a review of that
   profile, not a verification of the change — never substitute one law for
   another to get a green run, and when you report a run like this, name the
   profile and say it is not the law in effect. See
   [docs/concepts/profiles.md](../../docs/concepts/profiles.md).

2. **Choose the output format.**

   - `--format text` — human-readable terminal output (default)
   - `--format json` — structured JSON envelope for programmatic use
   - `--format sarif` — SARIF 2.1.0 for GitHub code scanning upload

3. **Interpret the exit code — never silently.**

   - **Exit 0** — no violations found, every selected file analyzed, and — when
     an intent file exists and is tracked — the declared architecture agrees
     with the observed graph. The number of files, projects, and imports
     inspected is stated beside the verdict.
   - **Exit 1** — findings: boundary violations, intent findings (a forbidden
     relationship appeared, an allowed one went missing), or waiver-entangled
     ones (a violation an active waiver accepts is still exit `1`, only moved
     to an "accepted violations" section). This is the only command that exits 1.
   - **Exit 3** — no verdict. The run could not complete, or a selected file
     could not be analyzed, or the intent could not be established, or — in a
     profile-selected workspace — the selected profile could not be resolved:
     an unknown profile name, an unknown `base`, a `base` cycle, or an
     unreadable registry. None of those falls back to another law: a resolved
     profile is the law the verdict names, so a resolution failure withholds
     the verdict. This is NOT "clean"; it is the fail-closed direction.
   - **Exit 2** — usage error (wrong flag, missing argument). Fix the invocation.

4. **Read the findings.** Each one tells you:

   - The file and line where the violating import was written
   - The project that contains the file
   - The target project being imported
   - The specific constraint rule that was broken (`messageId`)

5. **Explain individual findings.** For any violation that is unclear:

   ```
   lattice explain <file:line:column>
   ```

   This shows the import specifier, the source and target tags, the matched
   constraints, and whether the judgment is a violation or allowed. An
   `UNRESOLVABLE` verdict names a target that is not statically knowable —
   that is a declared blind spot, not the absence of a judgment.

6. **Distinguish what `check` folds in.** `check` is the gate. It enforces
   whatever law is in effect — a file, or the profile `boundaryConfig`/`--config`
   selects — and folds in the intent comparison by presence (the same findings
   `drift` describes: exit 1 on intent findings, exit 3 on a malformed intent or
   one whose boundary matched no observed project); it folds waivers in the same
   way (a violation an active waiver accepts is still exit `1`, listed under
   "accepted violations"); and it folds fitness in by presence too — a policy
   **file** declaring a `fitness` export gets those per-function verdicts counted
   into `check`'s exit code (`1` for any `fail`, `3` for any `unknown`). A
   profile cannot carry fitness: a profile's block is exactly
   `depConstraints`/`moduleBoundaryOptions`/`boundarySuppressions`, so a
   profile-selected run folds no fitness functions. `check` is also the one
   command that resolves a `profiles` registry; the descriptive commands beside
   it do not. An _unverifiable_ intent is never a _satisfied_ one, and an
   unresolved profile is never a satisfied law.

7. **For CI: generate SARIF.**

   ```
   lattice check --format sarif --output boundaries.sarif
   ```

## Fail-closed semantics

- **Exit 3 is never "clean."** A gate that could not look must never be mistaken
  for one that looked and found nothing. If Lattice could not analyze a file,
  the verdict for that file is unknown — not absent. Treat exit 3 as a red that
  you investigate, distinct from exit 1's red that you fix: both fail a build,
  they differ in what you go and look at.
- **An empty violations list is a claim.** When exit 0, Lattice states what it
  inspected: files, projects, imports. "No violations" means those imports were
  checked and all complied — and "no findings" from a scoped run says nothing
  about the files outside its scope. **A permanent suppression is the one
  documented exception to "checked and complied."** A `boundarySuppressions`
  row with no `expiresAt` removes a real violation from the findings entirely,
  by design: exit 0 can mean the workspace is genuinely clean, or that it is
  clean except for what is permanently suppressed, and `check`'s own output
  does not distinguish the two — unlike a waiver (a row WITH `expiresAt`),
  which stays a finding under "accepted violations" until its term lapses
  rather than disappearing (`arch-review`, "Waivers / exceptions"). To tell
  which "empty" a green run is, read the active policy's `boundarySuppressions`
  table directly for rows with no `expiresAt`; `lattice waivers` names only
  the term-bound rows, not this one. In a profile workspace, a run that
  reports unexpectedly green can also mean the law being enforced changed —
  check the plugin options and the `--config`/`boundaryConfig` selector
  against what was in effect when the change was made (the option-change
  check `arch-review` step 2 runs), not only the code under review.
- **UNKNOWN / INCOMPLETE never silently becomes PASS.** A coverage gap, an
  unreadable file, a no-verdict intent, an unresolved profile — each withholds
  the verdict instead of folding into the green. An unresolved decision is the
  same rule in the agent's hands: `check` validates a `decisionRef`'s shape but
  does not resolve it, so an ADR id that `lattice adr` cannot look up stays
  `unknown` evidence, never a pass — say so rather than citing it. That
  `unknown` is the agent's own inference, not a verdict from `check`: no gate
  turns a row's `decisionRef` into a verdict, and the only action that names it
  is asking `lattice adr` the id.
- **Empty output from a scoped check does NOT mean the workspace is safe.**
  Cycle rules and lazy-load rules judge the whole file graph. A scoped check is
  a fast filter; a full check is the gate.

## Beyond import edges: the workspace-level checks

`check` is the deterministic gate, and it is not limited to import edges. On
this implementation it also performs the workspace checks the boundary law
names when the workspace carries them: the two drift-bearing workspace checks it
runs when the corresponding workspace state exists — a tracked `go.work` whose
`use` list disagrees with the projects' `go.mod` files, and a tsconfig `paths`
table with an alias pointing at a directory that does not exist. Each is a
finding (exit 1); each unreadable source fails the run (exit 3) rather than
being read as clean. What a future version folds into the same gate is decided
by the same rule: an additional deterministic check makes the verdict complete,
never merely louder.

Fifteen descriptive commands sit **beside** the gate. `graph`, `diff`,
`drift`, `discover`, `reconcile`, `impact`, `explain`, `context`, `history`,
`waivers`, `fitness`, `health`, `debt`, `provenance`, and `adr` each describe
or propose against the same observed facts, and none of them exits 1 on its
own (describing architecture is not a finding; `debt` ages the ledger rather
than re-judging it, `health` reports per-metric verdicts where an unmeasured
metric is `unknown`/`not_applicable`, never zero, and `adr` describes the
recorded decisions — exit 3 only on an ADR-pattern id the registry does not
know or an unreadable registry, never clean, but never a finding; a reverse
lookup naming a rule id no ADR binds is a sentence with exit 0). But two of
them still reach `check`'s exit code: `fitness` verdicts fold into the gate by
presence (`fail` → 1, `unknown` → 3), and a waived violation stays exit `1` in
`check`, moved to the "accepted violations" section until its term lapses.
Those two inform a verdict; the rest only inform the reader. A build fails on
`check`, and on nothing else.

## What to do if it fails

- **Exit 3** — investigate the coverage gap. Common causes: no workspace root
  detected, malformed boundary config, missing language manifests, an intent
  that cannot be established, or — in a profile-selected workspace — a profile
  that could not be resolved (unknown name, unknown `base`, a `base` cycle, an
  unreadable registry). Remember that in a profile workspace `boundaryConfig`
  holds a name, not a file, so a message about a boundary config with no
  extension is pointing at profile selection, not a missing file. Do not re-run
  until the gap is understood.
- **Unexpected violations** — use `lattice explain` to understand why each import
  was flagged before deciding how to respond.
- **No violations but expected some** — verify the boundary config applies to the
  relevant project tags, and that the intent file is tracked. A project with no
  matching constraints is unconstrained, not compliant.
