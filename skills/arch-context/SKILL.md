---
name: arch-context
description: Establish the architectural facts and governance constraints relevant to a change before modifying code in a Lattice-governed project
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
   `lattice graph --format json` and match by root directory (in a
   profile-selected workspace — see step 2 — `graph` itself exits 3, and
   project names come from the workspace manifests instead).

2. **Know which law is in effect.** A workspace enforces either by **file** or
   by **named profile**. Check whether `nx.json`'s plugin options for
   `@ecoma-io/lattice/nx` carry a `profiles` option (`profiles` is an Nx plugin
   option only — a native `lattice.json` workspace has none, by design):

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
     documented in [docs/concepts/profiles.md](../../docs/concepts/profiles.md)
     and [docs/reference/profiles.md](../../docs/reference/profiles.md).

   Only `lattice check` resolves a profile by name. The descriptive commands
   below do not read the `profiles` option, so in a profile-selected
   workspace a command that takes `--config` still means a file path there,
   and a command that prints the boundary law may fail loudly (exit 3) rather
   than silently fall back. Treat that as a fact about which law is in effect,
   not as "no law". When a descriptive command exits 3 in a profile workspace —
   `context`, `impact`, `diff`, `explain`, `fitness`, `history`, `waivers`,
   `debt`, `health`, and `graph` (which takes no `--config` but still loads
   `boundaryConfig` for the policy fingerprint) — the message "names an
   unsupported boundaryConfig extension '(none)'" is pointing at profile
   selection, not at a real file —
   do not "fix" it by changing `boundaryConfig` or passing a file path. Read
   the profile's effective block from the registry file and resolve its `base`
   chain by hand — that is the only source of what the project MAY import; the
   gate's `check --config <active-profile> --format json` reports only the
   violations that fired, not the full admissible-direction table.

3. **Determine what exists and what governs it.** Run:

   ```
   lattice context <project> --format json
   ```

   In a profile-selected workspace this exits 3 — `context` does not resolve a
   profile, and the effective block is readable only from the registry file;
   fall through to step 6 with the registry's rows as the constraint table.
   Where it works, this shows:
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
   lattice drift --format json
   ```

   Drift prints the intent fingerprint and every intent row the observed graph
   violates. Exit 3 means the comparison could not be completed — an
   _unverifiable_ intent must never be read as _no drift_.

5. **For a planned change, request the planning context.** When about to change
   code (not just read it) in a file-based workspace:

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
   strategy — the agent reasons over these facts and produces the plan. In a
   profile-selected workspace `context --plan` exits 3 with the same
   profile-selection artifact (step 2); its `verify` commands (`impact`,
   `graph`, ...) are not runnable there either — plan from the registry file's
   effective block and verify with `lattice check --config <active-profile>`.

6. **Read the constraints.** Each constraint names a source tag pattern, a target
   tag pattern, and whether the import is `allowed` or `forbidden`. A project
   with `layer:domain` may be allowed to import `layer:domain` and `layer:shared`
   but forbidden from importing `layer:adapter`. When a constraint row — or an
   intent row — carries a `decisionRef`, that is the "why" of the rule: the
   record of the decision that made it enforceable. (A fitness gate cannot carry
   one: a fitness row accepts exactly `name`/`match`/`condition`/`reason`.)
   Resolve it with the reverse lookup before treating the rule as standing on
   its own:

   ```
   lattice adr rule:no-direct-dep          # which ADR binds this rule?
   lattice adr 0001-bind-collaboration    # that record's status and its bindings
   ```

   `lattice adr <id>` confirms the record's binding and status, but the decision
   itself — the rationale, the context — lives in the record file: open
   `docs/adr/NNN-slug.md` and read the prose.
   A `decisionRef` that resolves is architecture evidence: the rule is enforced
   because a recorded decision made it so. An ADR id the registry does not know
   exits 3 — the record is missing, and the rule's grounding reads as `unknown`,
   never a pass; flag it rather than reading it as bound. Note the reverse
   lookup inverts that: `lattice adr rule:orphan` names a rule no ADR binds and
   exits 0 with a sentence, which is a fact to verify against the rule row's
   exact spelling, never a clean verdict. A record whose status is `superseded`
   still binds its rows until a replacement is authored — flag it to the team
   rather than treating the rule as unbound or unbinding it yourself. See
   [docs/concepts/adr.md](../../docs/concepts/adr.md).

7. **Assess downstream and historical context when relevant.** If the project is
   imported by others, `lattice impact <project> --format json` lists its
   transitively dependent projects — the blast radius of the change. If the
   repository keeps graph snapshots, `lattice history <dir>` describes how the
   architecture evolved, so you can distinguish a permission that has always
   been there from one that appeared a snapshot ago. An empty or missing
   snapshots directory is a no-verdict run (exit 3), never a clean "no
   evolution" — point it at a populated capture directory, or skip the step and
   say no history was inspected.

8. **Understand the surrounding governance surfaces when the facts need
   context.** These are descriptive, never gates — they never exit 1:
   `lattice waivers` lists the term-bound suppressions a violation under review
   may be covered by; `lattice health` reports per-metric verdicts (unmeasured
   is `unknown`/`not_applicable`, never zero); `lattice debt <dir>` ages waivers,
   gaps and drift across snapshots; `lattice fitness` (when the policy declares
   a `fitness` export) judges the workspace's named quality gates;
   `lattice adr` lists the recorded architecture decisions and what each binds;
   and `lattice reconcile --propose` / `lattice discover --propose` shape a stale
   model or a blank one — all proposals, never written. Consult them for
   context, and let their zero-verdict exits stay out of the change's clean/not
   verdict: `check` is the only command that exits 1.

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
- `check` — to see the current violation state (though `context --plan` already
  reports it scoped for reporting).

## What to do if it fails

- **Exit 3** — the run could not complete. This is NOT "clean"; it means Lattice
  could not reach a verdict. Check whether a workspace root, boundary config, or
  project graph is missing or malformed. In a profile-selected workspace,
  distinguish the two readings of exit 3: a descriptive command (`context`,
  `graph`, `diff`, `impact`, `explain`, `history`, `fitness`, `waivers`,
  `debt`, `health`) **never resolves a profile** — when one of those exits 3, a
  message about a boundary config with no extension is the profile-selection
  artifact, not a missing file; do not "fix" it by changing `boundaryConfig` or
  passing a file path, get the law from `lattice check --config <name>` and the
  registry file instead. Only `check` can exit 3 because a profile could not be
  resolved — an unknown profile name, an unknown `base`, a `base` cycle, or an
  unreadable registry; none of those falls back to another law. Do not proceed
  as if the architecture is safe.
- **`drift` exit 3** — the intent comparison could not be verified (intent file
  unreadable, a boundary matched no observed project). Surface this in your
  change notes; the declared architecture is not confirmed.
- **`adr` exit 3** — an ADR-pattern id the registry does not know, or a registry
  that could not be read. A decision that cannot be looked up reads as `unknown`,
  never as valid evidence; do not cite a `decisionRef` as authoritative unless
  `lattice adr` resolves it.
- **Project not found** — verify the project name matches what `lattice graph`
  reports. Names come from the project manifest, not the directory name.
- **No constraints shown** — the boundary config may be absent or may not apply
  any rule to this project's tags. This is NOT a green light; it is an unknown.
  The project has no declared boundaries, which means nothing is enforced.
