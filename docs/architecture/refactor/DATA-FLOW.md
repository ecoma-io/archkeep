# Data flow

The one-way semantic flow of [CON-2](CONSTITUTION.md#con-2--semantic-flow-is-one-way),
instantiated with the modules that occupy each stage today. Phase 0 audit
verified the flow is singular end to end; the hazards listed per stage are
where a refactor could accidentally create a second path.

```
input adapters → workspace acquisition → observation/analysis →
canonical representation → evidence → policy/rules/governance inputs →
deterministic evaluation → verdict → projections/surfaces
```

## Stages, with occupants

### 1. Input adapters

- `cli.mjs` — argument parsing, one usage-error lane (exit 2, before any
  envelope).
- `src/config.mjs` — the law file, four accepted dialects, validated on load.
- `src/options.mjs` — the one filename-knowing layer (which files belong to
  which language).

### 2. Workspace acquisition

- `src/workspace.mjs` — root discovery via markers.
- git shapes (`src/git-shapes.mjs`) — tracked files, injectable.
- Providers: `src/providers/nx.mjs` (one-call `readProjectGraph`),
  `src/providers/native/` (two-call discover + buildGraph), `src/providers/moon.mjs`
  (one-call + marker). Three seam shapes — see
  [BOUNDARIES.md](BOUNDARIES.md#provider-seam).

### 3. Observation / analysis

- `src/analysis/*` analyzers (Go, Rust, Python, TS/JS, Vue, JVM, .NET, markdown)
  produce import records under the frozen contract in
  `src/analysis/contract.md`. **Analysis never judges** (intent C).
- The shared preamble `resolveCommandContext` (`src/commands/context.mjs:510-917`)
  composes root → provider graph → tracked files → analysis → owned/unclaimed
  gaps for every graph-reading verb. Two documented bypasses: `adr` (own
  marker walk — reads no project model) and `rules` (synthetic native context —
  reads the catalog, no workspace). `evolution` walks its own root to enumerate
  revisions (`cli.mjs:2222`) but analyzes every revision through the ordinary
  pipeline (`evolution.mjs:234-236,262`) — a root walk, not a preamble bypass.

### 4. Canonical representation

- Graph builders: `buildProjects`/`buildDependencies` (`src/commands/graph.mjs:72-220`).
- `src/canonical.mjs` — deterministic serialization (a utility, not a
  semantic-model seed).
- `computePolicyFingerprint` — the policy axis of snapshot identity.

### 5. Evidence

- Evidence snapshots: `src/commands/delta-snapshot.mjs` (bytes-identity, ADR
  [0008](../../adr/0008-snapshot-identity-per-family.md)).
- Custom-rule evidence bundles: `src/custom-rules/evidence.mjs`.
- `src/report/evidence.mjs` — re-export carrier for envelope decisions.
- Replay substrate: a stored baseline + current law re-derives any base-side
  verdict deterministically (coverage-gated baselines; determinism pinned).

### 6. Policy / rules / governance inputs

- The policy ladder `resolvePolicy` (`src/commands/policy.mjs:100-123`).
- Rules: `src/rules/index.mjs` (`evaluateRun`), edge constraints, tags,
  topology, reachability.
- The intent law: `src/architecture-intent/{model,judge}.mjs`.
- Governance records: waivers, ADR registry, origin records, decision
  lifecycle, profiles (selection of committed files, never mutation).

### 7. Deterministic evaluation

- The four judgment construction sites (see
  [AUTHORITY-MAP.md](AUTHORITY-MAP.md#the-one-enforcement-authority)) fold into
  `evaluateRun` → `evaluate`.
- Waiver/suppression folds (`check` withdraws accepted unclaimed failures;
  `waivers` evaluates with the suppression table removed — command-level
  shaping, documented).
- One injected clock (`governance/clock.mjs`) threads `now` through
  delta/change judgments; the Contract-K source guard forbids any other
  wall-clock read in shipped `src/` (the exempt-site roster beyond the clock
  itself is unverified — INV-16's gap, OQ-6).

### 8. Verdict

- `verdictFor` (`src/verdict.mjs:121-238`) → `buildDecision`
  (`governance/verdict.mjs`) + the single `EXIT` table — this is `check`'s
  fold of the lane's output; the three sibling enforcement carriers
  (`delta --compare`, `change`, `fitness`) fold their own verdicts through
  the same vocabulary and table, not through `verdictFor`
  ([CON-1](CONSTITUTION.md#con-1--one-enforcement-authority));
  `rules verify` folds its artifact-integrity status over the same vocabulary
  and table outside this lane
  ([PD-8](DECISIONS.md#program-decisions)).

### 9. Projections / surfaces

- JSON envelope (`src/report/json.mjs`, `schemaVersion: 2`), SARIF, text
  renderers — render, decide nothing (the import direction that would let
  `report/` decide is unscanned — G-5, Phase 3).
- LSP diagnostics (publication only), MCP tools (compose `./commands`),
  e2e consumers of the packed artifact.

## Parallel record flows (not verdicts)

State that flows beside the main lane, each single-owned:

- **history capture → graph snapshots → diff/delta/change/evolution reads**
  (identity: `snapshotIdentity`).
- **delta capture → evidence snapshots → re-judged baselines** (identity: the
  bytes).
- **delta/change/evolution `--event-out` → append-only event store**
  (identity: `eventDedupeKey`; three producers, one store).

These are records, not verdicts: none of them changes what a run concludes;
they change what a later run can _prove_. A refactor that lets a record flow
influence evaluation order or content beyond the documented baseline contract
has created a loop — a [P-D](CONSTITUTION.md#process-articles) stop.

## Hazards (where a second path could grow)

1. Re-judging semantics: `delta`/`change` deliberately re-judge the BASE side
   under the current law while taking BASE structural facts from the stored
   snapshot (`change.mjs:690-699`, `delta.mjs:98-101`). This is the documented
   contract; a "simpler" local comparison would be a second universe.
2. The provider seam has three shapes (one-call, two-call, one-call+marker) —
   a new consumer that picks one shape per provider bakes in provider
   knowledge (Phase 1/7 concern).
3. The LSP's own Nx discovery (see
   [AUTHORITY-MAP.md](AUTHORITY-MAP.md#known-divergences-and-pressures)) is a
   live example of a second acquisition path; it is the caution for every
   future surface.
