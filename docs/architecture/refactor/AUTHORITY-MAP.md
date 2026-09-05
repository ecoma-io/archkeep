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

## The one enforcement authority

The authority is the **evaluation lane** — one law, one vocabulary, one
Decision constructor — not one function call:

```
violationOf (rules/index.mjs:428-442)      ┐
judgeEdge (rules/edge-constraints.mjs:79)  ├─→ evaluateRun → evaluate ──→ verdictFor (check's fold)
compareGoWork (go-work.mjs:313-394)        │    (rules/index.mjs)         (src/verdict.mjs:121-238)
judgeTsconfigPaths (tsconfig-paths.mjs)    ┘
```

- **Singular**: the `EXIT` table (`src/verdict.mjs:21-26` — the only place
  the numbers live as a table), the status vocabulary
  (`ok/findings/no-verdict`), the one Decision constructor `buildDecision`
  (`src/governance/verdict.mjs:204-310`), and the law being evaluated.
- **Plural — five verdict carriers, five fold sites**: exactly five verbs can
  exit 1, each earning that role by reporting a verdict on every reachable
  path or refusing to look silently (the doctrine's carrier roster,
  `docs/reference/exit-codes.md`): `check` folds through `verdictFor`
  (callers `cli.mjs:802` and `src/commands/check.mjs:1066`);
  `delta --compare` folds at `cli.mjs:1060-1061` over a status computed at
  `src/commands/delta.mjs:751-781` from `evaluateRun`'s re-judgment of both
  sides; `change` at `cli.mjs:1377-1378` (`change.mjs:751-780`);
  `fitness` at `cli.mjs:1539-1542` (`fitness.mjs:211-216`);
  `rules verify` through an if-chain at `cli.mjs:2017-2019`
  (`rules.mjs:444-448`). The carriers agree because they evaluate the same
  law through the same engines (intent J), **not** because they share one
  fold function — `verdictFor` is `check`'s fold, and only `check`'s.
- **What holds the folds honest**: `jsonEnvelope` refuses a status↔exitCode
  disagreement (`src/report/json.mjs:88-96`; every carrier eagerly builds its
  envelope), the exit-matrix suite pins per-verb sides, and
  `src/conformance/verdict-layering.test.mjs` scans for a second numeric
  _table_ — branch/ternary literals at the carrier sites are invisible to
  that scan (INV-2's gap names this honestly).

The four construction sites are judgment sites **inside** the lane — they
construct findings; they do not own verdicts. That is the distinction
[CON-1](CONSTITUTION.md#con-1--one-enforcement-authority) protects: the lane
shares one vocabulary and one law; a refactor must neither unfold the
construction sites nor "route the sibling carriers through `verdictFor`" as a
cleanup — `delta`'s `findings` status folds classification counts
`verdictFor` has no inputs for, and changing that path changes semantics.

## Decision rights by surface

| Surface                            | May decide                                                                                                                          | Must not decide                                                                            | Audit verdict                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `check` evaluation lane            | verdict, exit, envelope decision                                                                                                    | —                                                                                          | singular                                                                         |
| `fitness`                          | verdict via shared `fitnessVerdictFor`, folded into check                                                                           | its own exit table                                                                         | composes the lane                                                                |
| `drift`                            | descriptive findings (never exit 1 itself; intent M)                                                                                | enforcement                                                                                | compliant                                                                        |
| `delta`/`change` (compare)         | verdicts by re-judging both sides through `evaluateRun`                                                                             | local comparison semantics — material delta IS `diff`'s `computeDiff` (`change.mjs:14-18`) | composes                                                                         |
| `explain`/`context`/`impact`       | nothing — judge through the same `evaluate`/`judgeEdge`/`computeImpactConstraints` check uses                                       | an independent evaluation that could disagree with check (intent J)                        | composes                                                                         |
| `scenario`                         | nothing — virtual graph, `virtual/notAuthoritative`, never mutates, never emits events                                              | any write, any exit 1                                                                      | compliant                                                                        |
| `report`/renderers (`src/report/`) | presentation only                                                                                                                   | verdicts, filtering, suppression                                                           | compliant; no scan enforces it (gap [G-5](BOUNDARIES.md#declared-but-unscanned)) |
| LSP server                         | diagnostics publication (exactly two empty-publish sites)                                                                           | verdicts; its own graph discovery (see divergences)                                        | invariant intact; one divergence                                                 |
| MCP tools (archkeep-mcp)           | nothing — nine tools compose `./commands` in-process; `propose` returns `requiresApproval:true, authoritative:false, written:false` | any write                                                                                  | compliant; one seam widening                                                     |
| Providers (nx/moon/native)         | acquisition + normalization                                                                                                         | policy, verdicts                                                                           | one policy pressure (below)                                                      |
| VS Code client                     | nothing — holds no analysis                                                                                                         | everything semantic                                                                        | compliant by construction                                                        |

## Write doors (the complete census)

Every path that writes state, all code-enforced:

| Door                                   | Enforcement                                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `--output <file>` (any verb)           | governance-target refusal (`cli.mjs:480-495`), containment, `wx` tmp + atomic rename                                              |
| `check --evidence-out`                 | via the same writer; three loud nothing-writes                                                                                    |
| `discover --propose --write-intent`    | the **only** intent write door: refuses existing file, requires `--propose`, prints "proposal, not the law" (`cli.mjs:2404-2425`) |
| `delta --capture`                      | refuses positional args + `--event-out` combination; refuses unjudgeable head                                                     |
| `history --capture`                    | `wx` tmp + rename; dedupe; incomplete-head refusal                                                                                |
| `--event-out` (delta/change/evolution) | append-only store with identity-checked writes (`evolution-store.mjs`)                                                            |
| `rules add --to`                       | copies wasm bytes under containment; never writes config                                                                          |

Propose-never-decides is structural: proposal producers (`discover`,
`reconcile`, `scenario`, change declarations) hold no write path except the one
`--write-intent` door, which itself only materializes a reviewed file.

## Known divergences and pressures

Recorded, not judged, by Phase 0. Each is a candidate for a later phase and
must not be "fixed" without its phase's differential:

1. **Moon provider embeds discovery policy** — `transformMoonGraph`
   (`moon.mjs:606-822`) filters "root"-scoped edges, maps Moon's `implicit`
   onto Archkeep's inverse vocabulary (`moon.mjs:243-275`, the #262 fix),
   collapses scopes to `static`, synthesizes `layer:`/`stack:` tags, and
   infers workspace layout. Each is defensible normalization; together they
   are a policy surface inside a provider
   ([CON-10](CONSTITUTION.md#con-10--providers-observe-they-do-not-decide)).
   Phase 1 decides per item: lift to an explicit normalization contract or
   pin as documented provider policy via ADR.
2. **LSP holds a second Nx discovery** — `workspace-index.mjs:398-533`
   re-implements Nx project-graph discovery for the editor; package-based Nx
   workspaces yield zero editor nodes while the CLI sees them. Mitigated by
   `nxModelFailure` loudness; structurally a second implementation of a
   provider seam (Phase 7).
3. **MCP imports past its seam** — `packages/archkeep-mcp/src/engine.mjs:71`
   imports `findWorkspaceRoot`/`listTrackedFiles` from the package root,
   widening the documented `./commands`-only seam (Phase 7 hygiene).
4. **`verdictFor`'s counts input is an untyped 14-field tuple** — a misspelled
   key silently defaults to 0 and flips exit 1 → exit 0. The loudest latent
   defect class in the one authority lane; Phase 1 hardening candidate.

## What a refactor may not add

No second engine, no `GovernService`, no surface-local verdict, no provider
judgment, no new write door outside this census, no exit code computed outside
the `EXIT` table. [CON-1](CONSTITUTION.md#con-1--one-enforcement-authority),
[CON-7](CONSTITUTION.md#con-7--proposal-reconciliation-decision-waiver-change-explain-stay-distinct),
and [P-D](CONSTITUTION.md#process-articles) make each of those a stop
condition, not a review note.
