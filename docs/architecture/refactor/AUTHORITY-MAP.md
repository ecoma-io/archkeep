# Authority map

Who may decide what, instantiated at file level. The doctrine statement of the
boundary is [`docs/doctrine/architecture-authority.md`](../../doctrine/architecture-authority.md);
this page is the refactor's consumption view of it — every row below was
verified against code by the Phase 0 audit (issue #725), and every phase must
leave the table true or update it in the same PR.

## Roles beside the tool

The six-role doctrine table (Archkeep / Provider / Native discovery / Agent /
CI-PR / Orchestrator) and the ten supplementary rows (human maintainer
declares intent — "nothing infers it"; agent skills are protocol, never
engine; custom rules one seam; governance artifacts modify effective policy,
never verdicts; the intelligence layer explains, never decides; VS Code/LSP
render; report renders; gate attestation carries no verdict authority) are
stated once in
[`docs/doctrine/architecture-authority.md`](../../doctrine/architecture-authority.md)
("The boundary, stated once") — this page instantiates the Archkeep-internal
half and does not restate the rest.

## Vocabulary: authority, carrier, projection, adapter, surface

Five words this control plane uses precisely. A module is classified by what
it may **do**, never by what it holds:

- **Authority** — a module with the right to make a semantic judgment or
  decision. Archkeep has exactly one: the evaluation lane below. Holding,
  passing, rendering, or storing a Verdict does not make a module an
  authority; deciding does. The count is one and the refactor may not
  increase it ([INV-25](INVARIANTS.md), maturity gate row 1).
- **Carrier** — a command that reports a verdict on every reachable path and
  can exit 1 through a fold over the shared vocabulary. The **enforcement
  carriers** — the ones folding the architecture law's verdict — are four
  today: `check` plus the three siblings (`delta --compare`, `change`,
  `fitness`). `rules verify` also exits 1 through a fold over the shared
  vocabulary, but over the **artifact-integrity** law: it is the
  **artifact-integrity verification surface**, named here so the exit-code
  roster is complete, not counted among the enforcement carriers
  ([PD-8](DECISIONS.md#program-decisions)). Adding a verdict-carrying verb —
  in either family — is a semantic change needing maintainer
  classification — not a cleanup, and not forbidden forever; never created by
  a refactor PR as a side effect.
- **Projection** — a read-only derivation of canonical facts (graph, drift,
  impact, history reads). Projects what the lane decided; never judges.
- **Adapter** — a translation at a boundary (provider normalization, envelope
  rendering, MCP tool shapes). May reshape representation, never meaning.
- **Surface** — a product entry (CLI verb, LSP, MCP, VS Code). Composition
  over the core; thin by
  [CON-9](CONSTITUTION.md#con-9--surface--package).

## The one enforcement authority

The authority is the **evaluation lane** — one law, one vocabulary, one
Decision constructor — not one function call. `check` is the lane's
**primary enforcement surface**, the front door consumers meet; it is not an
exclusive semantic entry point, and the enforcement carriers below are
legitimate peers on the same law, not violations awaiting unification:

```
violationOf (rules/index.mjs:428-442)      ┐
judgeEdge (rules/edge-constraints.mjs:79)  ├─→ evaluateRun → evaluate ──→ verdictFor (check's fold)
compareGoWork (go-work.mjs:313-394)        │    (rules/index.mjs)         (src/verdict.mjs:201-333)
judgeTsconfigPaths (tsconfig-paths.mjs)    ┘
```

- **Singular**: the `EXIT` table (`src/verdict.mjs:22-27` — the only place
  the numbers live as a table), the status vocabulary
  (`ok/findings/no-verdict`), the one Decision constructor `buildDecision`
  (`src/governance/verdict.mjs:212-318`), and the law being evaluated.
- **Plural — four enforcement carriers, four architecture fold sites, plus
  the integrity fold beside them**: exactly five verbs can exit 1 (the
  exit-code roster, `docs/reference/exit-codes.md`), but they are not one
  family. The **enforcement carriers** fold the architecture law's verdict:
  `check` through `verdictFor` (callers `cli.mjs:809` and
  `src/commands/check.mjs:1066`); `delta --compare` folds at
  `cli.mjs:1082` over a status computed by `deltaFold`
  (`src/commands/delta.mjs:486`) from `evaluateRun`'s re-judgment of both
  sides; `change` at `cli.mjs:1399` (`changeFold`, `change.mjs:498`);
  `fitness` at `cli.mjs:1560-1563` (`fitnessFold`, `fitness.mjs:137`). Those
  four evaluate the same law through the same
  engines (intent J), **not** because they share one fold function —
  `verdictFor` is `check`'s fold, and only `check`'s. The fifth verb,
  `rules verify`, folds at `cli.mjs:2040-2042` (`rules.mjs:445-448`) over the
  **artifact-integrity** law — the same status vocabulary, `EXIT` table, and
  envelope latch, a different law, no lane membership
  ([PD-8](DECISIONS.md#program-decisions)).
- **What holds the folds honest**: `jsonEnvelope` refuses a status↔exitCode
  disagreement (`src/report/json.mjs:93`; every carrier eagerly builds its
  envelope), the exit-matrix suite pins per-verb sides, and
  `src/conformance/verdict-layering.test.mjs` scans for a second numeric
  _table_ — the sibling folds' keyed-object lookup spellings are invisible to
  that scan (INV-2's gap names this honestly).

The four construction sites are judgment sites **inside** the lane — they
construct findings; they do not own verdicts. That is the distinction
[CON-1](CONSTITUTION.md#con-1--one-enforcement-authority) protects: the lane
shares one vocabulary and one law; a refactor must neither unfold the
construction sites nor "route the sibling carriers through `verdictFor`" as a
cleanup — `delta`'s `findings` status folds classification counts
`verdictFor` has no inputs for, and changing that path changes semantics.

## Decision rights by surface

| Surface                             | May decide                                                                                                                          | Must not decide                                                                            | Audit verdict                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `check` evaluation lane             | verdict, exit, envelope decision                                                                                                    | —                                                                                          | singular                                                                                                             |
| `rules verify` (artifact integrity) | catalog-integrity findings: digest, contract version, host validity, artifact containment                                           | architecture law, a lane verdict over the workspace, entry into the evaluation lane        | bounded integrity authority ([PD-8](DECISIONS.md#program-decisions)); shares the vocabulary/table/latch, not the law |
| `fitness`                           | verdict via shared `fitnessVerdictFor`, folded into check                                                                           | its own exit table                                                                         | composes the lane                                                                                                    |
| `drift`                             | descriptive findings (never exit 1 itself; intent M)                                                                                | enforcement                                                                                | compliant                                                                                                            |
| `delta`/`change` (compare)          | verdicts by re-judging both sides through `evaluateRun`                                                                             | local comparison semantics — material delta IS `diff`'s `computeDiff` (`change.mjs:14-18`) | composes                                                                                                             |
| `explain`/`context`/`impact`        | nothing — judge through the same `evaluate`/`judgeEdge`/`computeImpactConstraints` check uses                                       | an independent evaluation that could disagree with check (intent J)                        | composes                                                                                                             |
| `scenario`                          | nothing — virtual graph, `virtual/notAuthoritative`, never mutates, never emits events                                              | any write, any exit 1                                                                      | compliant                                                                                                            |
| `report`/renderers (`src/report/`)  | presentation only                                                                                                                   | verdicts, filtering, suppression                                                           | compliant; no scan enforces it (gap [G-5](BOUNDARIES.md#declared-but-unscanned))                                     |
| LSP server                          | diagnostics publication (exactly two empty-publish sites)                                                                           | verdicts; its own graph discovery (see divergences)                                        | invariant intact; one divergence                                                                                     |
| MCP tools (archkeep-mcp)            | nothing — nine tools compose `./commands` in-process; `propose` returns `requiresApproval:true, authoritative:false, written:false` | any write                                                                                  | compliant; one seam widening                                                                                         |
| Providers (nx/moon/native)          | acquisition + normalization + recorded bounded derivation                                                                           | policy, verdicts                                                                           | policy surface adjudicated (MOON-POLICY); seam contract in BOUNDARIES                                                |
| VS Code client                      | nothing — holds no analysis                                                                                                         | everything semantic                                                                        | compliant by construction                                                                                            |

## Write doors (the complete census)

Every path that writes state, all code-enforced:

| Door                                   | Enforcement                                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `--output <file>` (any verb)           | governance-target refusal (`cli.mjs:480-495`), containment, `wx` tmp + atomic rename                                              |
| `check --evidence-out`                 | via the same writer; three loud nothing-writes                                                                                    |
| `discover --propose --write-intent`    | the **only** intent write door: refuses existing file, requires `--propose`, prints "proposal, not the law" (`cli.mjs:2426-2444`) |
| `delta --capture`                      | refuses positional args + `--event-out` combination; refuses unjudgeable head                                                     |
| `history --capture`                    | `wx` tmp + rename; dedupe; incomplete-head refusal                                                                                |
| `--event-out` (delta/change/evolution) | append-only store with identity-checked writes (`evolution-store.mjs`)                                                            |
| `rules add --to`                       | copies wasm bytes under containment; never writes config                                                                          |

Propose-never-decides is structural: proposal producers (`discover`,
`reconcile`, `scenario`, change declarations) hold no write path except the one
`--write-intent` door, which itself only materializes a reviewed file.

## Known divergences and pressures

Recorded, not judged, by Phase 0. Each is a candidate for a later phase and
must not be "fixed" without its phase's differential — divergences 1 and 4
are since closed by Phase 1, annotated in place:

1. ~~**Moon provider embeds discovery policy**~~ — **CLOSED by Phase 1-C**
   (PR #734): every one of the five embedded policies
   (`transformMoonGraph`, `moon.mjs:606-822`) is adjudicated in
   [MOON-POLICY.md](MOON-POLICY.md) — three contract-backed normalizations
   (root-scoped edge exclusion as domain exclusion; the #262
   Moon↔Archkeep vocabulary inversion; the #280 scope collapse to `static`)
   and two recorded provider policies
   ([ADR 0009](../../adr/0009-moon-derived-tags-provider-policy.md) derived
   `layer:`/`stack:` tags; [ADR 0010](../../adr/0010-moon-workspace-layout-inference.md)
   workspace-layout inference), each bounded to stating Moon's own facts and
   deciding nothing. "Policy surface" resolved as recorded policy, not
   silent behavior; the per-provider seam contract
   ([BOUNDARIES.md](BOUNDARIES.md#provider-seam)) carries the verdicts. A
   sixth embedded behavior the five missed — `moon:declared` targets
   synthesis (`moon.mjs:725-737`) — was surfaced by the phase-close
   hostile review; the seam table records it with its per-item verdict
   owed to Phase 2-A, so the closure names five and the seam contract
   carries six.
2. **LSP holds a second Nx discovery** — `workspace-index.mjs:398-533`
   re-implements Nx project-graph discovery for the editor; package-based Nx
   workspaces yield zero editor nodes while the CLI sees them. Mitigated by
   `nxModelFailure` loudness; structurally a second implementation of a
   provider seam (Phase 7). Registered against the seam contract's table as
   a temporary divergence with its Current/Target/Phase/Reason block.
3. **MCP imports past its seam** — `packages/archkeep-mcp/src/engine.mjs:71`
   imports `findWorkspaceRoot`/`listTrackedFiles` from the package root,
   widening the documented `./commands`-only seam (Phase 7 hygiene).
4. ~~**`verdictFor`'s counts input is an untyped 14-field tuple**~~ —
   **CLOSED by Phase 1-A** (PR #730): the counts input is validated by
   roster — required and optional keys, per-key types, unknown-key refusal —
   at every one of the five fold sites, each with red-by-construction twins;
   a misspelled key now refuses loudly instead of defaulting to 0 and
   flipping exit 1 → exit 0.

## What a refactor may not add — and may not remove

No second engine, no `GovernService`, no surface-local verdict, no provider
judgment, no new write door outside this census, and no **new** exit
computation bypassing the `EXIT` table — the carriers' existing literal
folds (four enforcement folds plus the integrity fold) are the pinned
baseline (INV-2's gap), not violations awaiting conformance. The mirror
prohibitions: no mechanical unification of the fold sites
([PD-6](DECISIONS.md#program-decisions) — routing the sibling carriers
through `verdictFor` changes semantics, it does not conform them); no routing
`rules verify` through `buildDecision`/`verdictFor` or into the
architecture lane — its contract is the artifact-integrity contract
([PD-8](DECISIONS.md#program-decisions)); and no change that raises the
architecture semantic enforcement authority count above one — the count is
one before this program and one after it
([INV-25](INVARIANTS.md)).
[CON-1](CONSTITUTION.md#con-1--one-enforcement-authority),
[CON-7](CONSTITUTION.md#con-7--proposal-reconciliation-decision-waiver-change-explain-stay-distinct),
and [P-D](CONSTITUTION.md#process-articles) make each of those a stop
condition, not a review note.
