---
name: arch-check
description: Run the authoritative governance gate after a change — boundary rules and declared Intent, as a fail-closed deterministic verdict
compatibility: Requires @ecoma-io/archkeep CLI
---

## When to use

After changes, before committing. Also on demand to validate a workspace's
architecture integrity — for example, at the start of a session to understand
the current state, or when a `drift` comparison or a `check` in CI reports
red.

## Why

`archkeep check` is the authoritative governance gate for a Archkeep-governed
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
   archkeep check
   ```

   Scoped to specific files (fast pre-check):

   ```
   archkeep check path/to/file.go path/to/other.rs
   ```

   Know whether this workspace enforces by **file** or by **named profile**
   before you read the verdict. Where `boundaryConfig` is declared follows
   from the project model (`arch-context`, "Know which law is in effect"):
   `nx.json`'s plugin options in an Nx workspace, `archkeep.json`'s own
   `boundaryConfig` field in a native one (a filename, or the policy inline),
   and the conventional default `module-boundaries.config.mjs` in a Moon
   workspace, where only `--config` selects another file for one run. A
   `profiles` registry — an Nx plugin option only — makes `boundaryConfig`
   (and a one-run `--config` override) a profile NAME selected from that
   registry, not a file path; without one, both are file paths. The default
   `check` enforces the profile `boundaryConfig` selects — read the
   `boundaryConfig` value in `nx.json`'s plugin options, because that string
   IS the active profile name, and the bare run resolves it. If you pass
   `--config`, it must equal that value to be a verification of the active law.
   Review a different law without touching the registered one the same way the
   CLI overrides a filename:

   ```
   archkeep check --config migration
   ```

   A run that resolves a different profile than in effect is a review of that
   profile, not a verification of the change — never substitute one law for
   another to get a green run, and when you report a run like this, name the
   profile and say it is not the law in effect. See
   [docs/concepts/profiles.md](https://github.com/ecoma-io/archkeep/blob/main/docs/concepts/profiles.md).

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
     relationship appeared, an allowed one went missing), waiver-entangled
     ones (a violation an active waiver accepts is still exit `1`, only moved
     to an "accepted violations" section), a declared fitness function that
     `fail`s, or a declared custom rule that `fail`s. This is the only command
     that exits 1 on boundary findings — with one companion: `fitness` also
     exits 1 when a declared function `fail`s.
   - **Exit 3** — no verdict. The run could not complete, or a selected file
     could not be analyzed, or the intent could not be established, or a
     declared fitness function or custom rule answered `unknown`, or a declared
     custom rule's artifact would not load at all (missing, `sha256` mismatch,
     not wasm, asking for an import), or a tracked intent row cites a
     `decisionRef` the ADR registry does not know (the one citation that
     withholds a verdict rather than only reporting it — see "Fail-closed
     semantics"), or — in a profile-selected workspace — the selected profile
     could not be resolved: an unknown profile name, an unknown `base`, a
     `base` cycle, or an unreadable registry. None of those
     falls back to another law: a resolved profile is the law the verdict
     names, so a resolution failure withholds the verdict. This is NOT "clean";
     it is the fail-closed direction.
   - **Exit 2** — usage error (wrong flag, missing argument). Fix the invocation.

4. **Read the findings.** Each one tells you:

   - The file and line where the violating import was written
   - The project that contains the file
   - The target project being imported
   - The specific constraint rule that was broken (`messageId`)

   Those four describe an **import-site** finding, and not every finding is
   one. An `implicitDependencies` edge is declared in a manifest rather than
   written as an import, so a **declared-edge** finding names the file that
   declared it — `<project-root>/project.json` under Nx, `archkeep.json`
   natively — with no line and no column, alongside the edge `source → target`
   and the constraint row it broke. There is no import to delete: the declared
   dependency itself has to go, or the two projects' tags be reconciled. Step
   5 does not apply to it either: `explain` answers about an import site, and
   this finding has none. Hunting for a line number that does not exist, or
   reading the finding as malformed, is the mistake to avoid.

5. **Explain individual findings.** For any violation that is unclear:

   ```
   archkeep explain <file:line:column>
   ```

   This shows the import specifier, the source and target tags, the matched
   constraints, and whether the judgment is a violation or allowed. An
   `UNRESOLVABLE` verdict names a target that is not statically knowable —
   that is a declared blind spot, not the absence of a judgment.

   With `--format json`, read three fields off `result` rather than guessing
   at the fix:

   - `verdict` says WHETHER for this one site: `"violation"`, `"clean"`, or
     `"unknown"` for an unresolvable site. It is site-level and descriptive —
     a `"violation"` verdict still exits 0, because explaining is never the
     gate; `check` is.
   - each violation entry's `constraint` plus `allowed` say WHICH LAW governs
     it: `allowed` is the governing row's own `onlyDependOnLibsWithTags`
     list, verbatim from the law, and `allowed: null` means the row states no
     allowed list (a `notDependOnLibsWithTags` row, or a check no row
     drives) — read the `constraint` row itself there; the tool never
     computes a complement of a ban list.
   - `remediation` is the workspace author's declared guidance, verbatim.
     `remediation: null` means none was declared — consult the constraint
     row and its `decisionRef`/ADR, not improvise a fix. It is never an
     instruction to edit the policy.

6. **Distinguish what `check` folds in.** `check` is the gate. It enforces
   whatever law is in effect — a file, or the profile `boundaryConfig`/`--config`
   selects — and folds in the intent comparison by presence (the same findings
   `drift` describes: exit 1 on intent findings, exit 3 on a malformed intent or
   one whose boundary matched no observed project); it folds waivers in the same
   way (a violation an active waiver accepts is still exit `1`, listed under
   "accepted violations"); and it folds fitness in by presence too — a policy
   **file** declaring a `fitness` export gets those per-function verdicts counted
   into `check`'s exit code (`1` for any `fail`, `3` for any `unknown`). A
   profile carries fitness like any other policy key: a profile's block is
   `depConstraints`/`moduleBoundaryOptions`/`boundarySuppressions`/`fitness`,
   so a profile-selected run folds a declared `fitness` block the same way a
   file-selected one does.

   **`customRules` folds in the identical way, and you must read it the same.**
   A policy declaring a `customRules` list gets every declared rule judged on
   every unscoped `check` — by presence, with no flag to pass and none to
   forget. Each rule is a WebAssembly artifact the workspace committed and
   pinned by `sha256`; its findings arrive namespaced as
   `custom/<rule>/<finding>`, and its verdict rides the same two lanes
   (`1` for any `fail`, `3` for any `unknown`). Four consequences for you:

   - **Do not look up a `custom/…` id in the violation catalogue.** It is not
     one of the fifteen and has no upstream meaning. What explains it is the
     finding's own message plus the `reason` its policy row is required to
     carry — read the row.
   - **A rule that could not judge is never a rule that found nothing.** An
     `unknown` — the rule's own, or the engine's for a rule that trapped, ran
     out of budget, or asked for evidence this engine cannot supply — is exit
     3, and the message names the cause. Report it as a gate that did not run,
     never as a clean result.
   - **A path-scoped `check` answers `not_applicable` for every declared
     rule**, because a rule's evidence is the whole tree. If custom rules
     matter to the question you were asked, the unscoped run is the only one
     that answers it.
   - **When a rule answers `unknown`, ask what it was handed.**
     `archkeep check --evidence-out <dir>` writes one `<rule>.json` per declared
     rule into that directory — the exact evidence document the rule was judged
     over, written even for a rule that trapped or exhausted its budget, which
     is when it is needed. Create the directory first — the flag writes into
     an existing one and fails the run rather than creating a missing one. It
     moves no verdict and no exit code, so the debugged run is the same run,
     and it never writes nothing silently: a path-scoped run and a policy
     declaring no `customRules` each say so on stderr rather than leaving an
     empty directory. Feed the bundle to the replay harness the rule's SDK
     ships
     ([docs/usage/custom-rules.md](https://github.com/ecoma-io/archkeep/blob/main/docs/usage/custom-rules.md),
     [docs/reference/custom-rules.md](https://github.com/ecoma-io/archkeep/blob/main/docs/reference/custom-rules.md)).

   An _unverifiable_ intent is never a _satisfied_ one, an unresolved profile
   is never a satisfied law, and a custom rule that could not be loaded or run
   is never a custom rule that passed.

7. **For CI: generate SARIF.**

   ```
   archkeep check --format sarif --output boundaries.sarif
   ```

## Fail-closed semantics

- **Exit 3 is never "clean."** A gate that could not look must never be mistaken
  for one that looked and found nothing. If Archkeep could not analyze a file,
  the verdict for that file is unknown — not absent. Treat exit 3 as a red that
  you investigate, distinct from exit 1's red that you fix: both fail a build,
  they differ in what you go and look at.
- **An empty violations list is a claim.** When exit 0, Archkeep states what it
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
  which "empty" a green run is, run `archkeep waivers`: it names every
  `boundarySuppressions` row — a waiver with its term, a permanent suppression
  with what it is hiding — the one surface that distinguishes the two. In a
  profile workspace, a run that
  reports unexpectedly green can also mean the law being enforced changed —
  check the plugin options and the `--config`/`boundaryConfig` selector
  against what was in effect when the change was made (the option-change
  check `arch-review` step 2 runs), not only the code under review.
- **UNKNOWN / INCOMPLETE never silently becomes PASS.** A coverage gap, an
  unreadable file, a no-verdict intent, an unresolved profile — each withholds
  the verdict instead of folding into the green. An unresolved decision is the
  same rule in the agent's hands: `check` resolves each row's `decisionRef`
  against the ADR registry and names an unresolved one inline and under
  `result.unresolvedDecisionRefs`, so an ADR id that `archkeep adr` cannot look
  up stays `unknown` evidence, never a pass — say so rather than citing it.
  **Which row carries the citation decides whether it also moves the verdict.**
  On a `depConstraints` row it is report-only: the resolution changes no byte
  of the verdict, because a missing record is a fact about the rule's
  documentation rather than about whether the boundary held. On an **intent**
  row, while the intent is applied, it is exit 3 — a workspace that declared an
  intended architecture whose governing decision does not exist cannot claim
  `ok` on that axis, and the gate CI runs must not be the one face that stays
  quiet where `drift` and `provenance` already flag the identical row. So an
  unresolvable intent citation is a no-verdict run (exit 3) even beside a
  perfectly clean boundary table, and reporting that run as green is the silent
  direction.
- **Empty output from a scoped check does NOT mean the workspace is safe.**
  Cycle rules and lazy-load rules judge the whole file graph. A scoped check is
  a fast filter; a full check is the gate. A fitness function that needs the
  whole tree (`coverage-minimum` today) reports `not_applicable` in a scoped
  run rather than a real verdict — that is expected, not a coverage gap to
  chase, and it does not by itself fail the run. Only an unscoped `check`
  actually judges it.

## Beyond import edges: the workspace-level checks

`check` is the deterministic gate, and it is not limited to import edges. On
this implementation it also performs the workspace checks the boundary law
names when the workspace carries them: the three workspace-level checks it
runs when the corresponding workspace state exists — a tracked `go.work` whose
`use` list disagrees with the projects' `go.mod` files, a tsconfig `paths`
table with an alias pointing at a directory that does not exist, and every
`implicit`-typed edge (`implicitDependencies`) judged against `depConstraints`,
which is where a boundary crossing with no import site behind it is caught.
Each is a finding (exit 1); each unreadable source fails the run (exit 3)
rather than being read as clean. A workspace carrying none of that state hears
nothing about it: each section is printed only when the state exists, so its
absence means "no such fact here", never "checked and clean". What a future
version folds into the same gate is decided by the same rule: an additional deterministic check makes the verdict complete,
never merely louder.

Sixteen descriptive commands sit **beside** the gate. `graph`, `diff`,
`drift`, `discover`, `reconcile`, `impact`, `explain`, `context`, `history`,
`waivers`, `health`, `report`, `debt`, `provenance`, and `adr` each describe or
propose against the same observed facts, and none of them exits 1 on its own
(describing architecture is not a finding; `debt` ages the ledger rather than
re-judging it, `health` reports per-metric verdicts where an unmeasured
metric is `unknown`/`not_applicable`, never zero, and `adr` describes the
recorded decisions — exit 3 only on an ADR-pattern id the registry does not
know or an unreadable registry, never clean, but never a finding; a reverse
lookup naming a rule id no ADR binds is a sentence with exit 0). Two of them
still reach an exit code: `fitness` is the one descriptive command that exits
1 on its own when a declared function `fail`s (`fail` → 1, `unknown` → 3), and
a waived violation stays exit `1` in `check`, moved to the "accepted
violations" section until its term lapses. Those two inform a verdict; the
rest only inform the reader. A build fails on `check` and on `fitness`, and on
nothing else.

## What to do if it fails

- **Exit 3** — investigate the coverage gap. Common causes: no workspace root
  detected, malformed boundary config, missing language manifests, an intent
  that cannot be established, or — in a profile-selected workspace — a profile
  that could not be resolved (unknown name, unknown `base`, a `base` cycle, an
  unreadable registry). Do not re-run until the gap is understood.
- **Unexpected violations** — use `archkeep explain` to understand why each import
  was flagged before deciding how to respond.
- **No violations but expected some** — verify the boundary config applies to the
  relevant project tags, and that the intent file is tracked. A project with no
  matching constraints is unconstrained, not compliant.
