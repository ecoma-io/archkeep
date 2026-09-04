---
name: arch-context
description: Establish the architectural facts and governance constraints relevant to a change before modifying code in a Archkeep-governed project
compatibility: Requires @ecoma-io/archkeep CLI
---

## When to use

Before modifying code in any project that Archkeep governs — especially when the
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
   `archkeep graph --format json` and match by root directory.

2. **Know which law is in effect.** First identify the project model by the
   marker at the workspace root — exactly one is present, and it decides where
   the law is declared:

   - **`nx.json`** (Nx) — the plugin options for `@ecoma-io/archkeep/nx` carry
     `boundaryConfig`, and possibly a `profiles` option.
   - **`archkeep.json`** (native) — the file's own `boundaryConfig` field names
     the policy, or holds it inline as an object. No `profiles` surface, by
     design.
   - **`.moon/`** (Moon) — no options table exists: `boundaryConfig` is
     `module-boundaries.config.mjs` by convention, `--config` overrides it for
     one run, and there is no `profiles` surface
     ([docs/integrations/moon.md](https://github.com/ecoma-io/archkeep/blob/main/docs/integrations/moon.md)).

   A workspace enforces either by **file** or by **named profile**. In an Nx
   workspace, check whether the plugin options carry a `profiles` option
   (`profiles` is an Nx plugin option only — the other two providers have
   none, by design):

   - **No `profiles` option** — the default. `boundaryConfig` / `--config`
     names a policy _file_ (`module-boundaries.config.*`), exactly as before.
   - **A `profiles` option** — it names a JSON registry of named laws. Then
     `boundaryConfig` — and a one-run `--config` override — select a profile
     _by name_ from that registry, never a file path. Profiles stack on a
     `base` (constraint and suppression rows append through the chain; the
     eight boundary options overwrite key by key). The profile in effect is
     the one `boundaryConfig` selects; that is the law the context below
     describes. Do not substitute another profile "that seems likely" — an
     ambiguous selection is a governance question, not a guess. Profiles are
     documented in [docs/concepts/profiles.md](https://github.com/ecoma-io/archkeep/blob/main/docs/concepts/profiles.md)
     and [docs/reference/profiles.md](https://github.com/ecoma-io/archkeep/blob/main/docs/reference/profiles.md).

   Every command below that reads a boundary law resolves the active profile
   by name, exactly as `check` does — `context`, `graph`, `diff`, `impact`,
   `explain`, `fitness`, `history`, `waivers`, `debt`, `health`, and `report`
   all share `check`'s own config-resolution step, so `--config`/`boundaryConfig` is a
   profile NAME everywhere, never a file path, the moment the workspace names
   a `profiles` registry. A descriptive command exiting 3 in a profile
   workspace is therefore a real coverage gap — an unknown profile name, an
   unknown `base`, a `base` cycle, or an unreadable registry, the same four
   conditions `check` can hit — not an artifact of that command failing to
   look at `profiles` at all. A profile's `block` may carry a `fitness` key
   like any other policy key, so `fitness` on a profile-selected workspace
   folds the declared functions the same way a file-selected one does —
   [docs/usage/profiles.md](https://github.com/ecoma-io/archkeep/blob/main/docs/usage/profiles.md), "Every command
   resolves it, not only `check`".

3. **Determine what exists and what governs it.** Run:

   ```
   archkeep context <project> --format json
   ```

   This resolves the active profile the same way `check` does, and shows:

   - The project's tags (`layer:`, `scope:`, `license:`)
   - Every constraint that applies — what the project MAY import, and what is
     forbidden
   - Any current dependencies, with any that already violate constraints
     marked. Per-edge verdicts here cover only `depConstraints` (3 of 15
     violation types) — a dependency with no violations in this list may still
     violate a cycle, lazy-load, or npm-ban rule. The full-workspace `check` is
     the complete verdict; `context --plan` is scoped for reporting where it
     runs.

4. **Check the declared Intent.** When the workspace carries a tracked
   `architecture-intent.json`, the architecture is a comparison, not a row of
   tables. See whether the intent file exists and what it declares before you
   treat the current structure as the intended one:

   ```
   archkeep drift --format json
   ```

   Drift prints the intent fingerprint and every intent row the observed graph
   violates. Exit 3 means the comparison could not be completed — an
   _unverifiable_ intent must never be read as _no drift_. A workspace with no
   intent file has not failed this step; it has declared no Intent, and
   establishing one is `arch-migrate`'s protocol rather than something to
   improvise here.

5. **For a planned change, request the planning context.** When about to change
   code (not just read it):

   ```
   archkeep context <project> --plan
   ```

   or, scoped to the files the change touches:

   ```
   archkeep context <project> --plan path/to/file.go path/to/other.rs
   ```

   `--plan` adds the deterministic facts an agent needs to plan safely: the
   current architecture snapshot, the applicable policy with the author's
   Intent (each constraint row's `description`/`remediation`), the impact of a
   change to the project (who depends on it), the current violations (the
   full-workspace rule-engine verdict, scoped for reporting), drift (go.work
   and tsconfig-path aliases), coverage with the exact files that could not be
   analyzed, and the commands that verify the change afterwards. Trailing paths
   scope the change; with no paths, the whole workspace is in scope.

   `--plan` is facts, not a plan. Archkeep never decides an implementation
   strategy — the agent reasons over these facts and produces the plan. In a
   profile-selected workspace `--plan` resolves the active profile the same
   way `check` does, and its bundled `verify` commands (`impact`, `graph`, …)
   resolve it too when you run them separately.

6. **Read the constraints.** Each constraint names a source tag pattern, a target
   tag pattern, and whether the import is `allowed` or `forbidden`. A project
   with `layer:domain` may be allowed to import `layer:domain` and `layer:shared`
   but forbidden from importing `layer:adapter`. When a constraint row — or an
   intent row — carries a `decisionRef`, that is the "why" of the rule: the
   record of the decision that made it enforceable. A fitness gate may carry
   one too — `decisionRef` is a governance block key a fitness row accepts,
   alongside `name`/`match`/`condition`/`reason`. Resolve it with the reverse
   lookup before treating the rule as standing on its own:

   ```
   archkeep adr rule:no-direct-dep          # which ADR binds this rule?
   archkeep adr 0001-bind-collaboration    # that record's status and its bindings
   ```

   `archkeep adr <id>` confirms the record's binding and status, but the decision
   itself — the rationale, the context — lives in the record file: open
   `docs/adr/NNN-slug.md` and read the prose.
   A `decisionRef` that resolves is architecture evidence: the rule is enforced
   because a recorded decision made it so. An ADR id the registry does not know
   exits 3 — the record is missing, and the rule's grounding reads as `unknown`,
   never a pass; flag it rather than reading it as bound. Note the reverse
   lookup inverts that: `archkeep adr rule:orphan` names a rule no ADR binds and
   exits 0 with a sentence, which is a fact to verify against the rule row's
   exact spelling, never a clean verdict. A record whose status is `superseded`
   still binds its rows until a replacement is authored — flag it to the team
   rather than treating the rule as unbound or unbinding it yourself. See
   [docs/concepts/adr.md](https://github.com/ecoma-io/archkeep/blob/main/docs/concepts/adr.md).

7. **Assess downstream and historical context when relevant.** If the project is
   imported by others, `archkeep impact <project> --format json` lists its
   transitively dependent projects — the blast radius of the change. If the
   repository keeps graph snapshots, `archkeep history <dir>` describes how the
   architecture evolved, so you can distinguish a permission that has always
   been there from one that appeared a snapshot ago. An empty or missing
   snapshots directory is a no-verdict run (exit 3), never a clean "no
   evolution" — point it at a populated capture directory, or skip the step and
   say no history was inspected. Snapshots do not appear on their own:
   `archkeep history <dir> --capture` appends one for the current workspace
   before describing the record, and it records the fingerprint of the law in
   effect. That writes a file into the directory, so it is the repository's
   decision (a CI step, a maintenance job), not something to do as a side
   effect of reading context. It is the same directory `debt` reads, and the
   one `health` and `report` read their trends from when given one.

8. **Understand the surrounding governance surfaces when the facts need
   context.** These are descriptive, never gates — they do not report boundary
   findings:
   `archkeep waivers` lists the term-bound suppressions a violation under review
   may be covered by; `archkeep health` reports per-metric verdicts (unmeasured
   is `unknown`/`not_applicable`, never zero); `archkeep debt <dir>` ages waivers,
   gaps and drift across snapshots; `archkeep fitness` (when the policy declares
   a `fitness` export) judges the workspace's named quality gates and exits 1
   when one `fail`s;
   `archkeep adr` lists the recorded architecture decisions and what each binds;
   and `archkeep reconcile --propose` / `archkeep discover --propose` shape a stale
   model or a blank one — all proposals; the only write is
   `discover --propose --write-intent <file>`, to a file the operator names. Consult them for
   context, and let their zero-verdict exits stay out of the change's clean/not
   verdict: `check` is the only command that exits 1 on boundary findings —
   `fitness` also exits 1 when a declared function `fail`s.
   `archkeep report` composes these same surfaces into one governance document,
   every number taken from the command that owns it, under one law resolved
   once for the whole page. It is the whole-workspace picture rather than a
   fact scoped to this change, so prefer the individual commands above while
   the question is narrow. It never exits 1 either: exit 0 means the document
   was established, not that the architecture is clean, and exit 3 names every
   surface it could not establish in a closing `could not inspect` block.

9. **Proceed within constraints.** Only then modify code, staying within the
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
- `waivers`, `health`, `debt`, `fitness`, `adr`, `reconcile`, `discover` — when
  the facts under the change involve a term-bound suppression, a quality claim,
  an aging ledger, a named quality gate, a decision reference, a stale model, or
  an undeclared one.
- `report` — when the question is the whole governance picture at once rather
  than one of those surfaces; it composes them into a single document and
  reaches for the same numbers.
- `check` — to see the current violation state (though `context --plan` already
  reports it scoped for reporting).

## What to do if it fails

- **Exit 3** — the run could not complete. This is NOT "clean"; it means Archkeep
  could not reach a verdict. Check whether a workspace root, boundary config, or
  project graph is missing or malformed. In a profile-selected workspace, every
  command that reads a boundary law can exit 3 for the same reason `check`
  can: an unknown profile name, an unknown `base`, a `base` cycle, or an
  unreadable registry — none of those falls back to another law, on any
  command. Do not "fix" it by changing `boundaryConfig` or passing a file
  path; the value is a profile name, and the fix is the registry or the name,
  not the command. Do not proceed as if the architecture is safe.
- **`drift` exit 3** — the intent comparison could not be verified (intent file
  unreadable, a boundary matched no observed project). Surface this in your
  change notes; the declared architecture is not confirmed.
- **`adr` exit 3** — an ADR-pattern id the registry does not know, or a registry
  that could not be read. A decision that cannot be looked up reads as `unknown`,
  never as valid evidence; do not cite a `decisionRef` as authoritative unless
  `archkeep adr` resolves it.
- **Project not found** — verify the project name matches what `archkeep graph`
  reports. Names come from the project manifest, not the directory name.
- **No constraints shown** — the boundary config may be absent or may not apply
  any rule to this project's tags. This is NOT a green light; it is an unknown.
  The project has no declared boundaries, which means nothing is enforced.
