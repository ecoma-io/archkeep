# Validation matrix

What each phase must run, and what today's harness can and cannot prove. The
tier taxonomy and gap registers below are the Phase 0 test audit's product;
they define Phase 4's entry gate and every phase's exit evidence.

## Test tiers

- **T1 invariant** — fails when the tool goes quiet: silent-direction
  positives, loudness/refusal, determinism, byte-identity, conservation,
  vacuity guards. The refactor-blocking set: must stay green with **no
  weakened assertion**.
- **T2 contract** — pins an external contract: verbs/flags, exit codes,
  envelope schema + roster, SARIF, LSP protocol, exports/subpaths, config
  schema, rosters/version chains.
- **T3 behavior** — module semantics over injected data.
- **T4 implementation detail** — wording/shape a refactor may change freely
  (renderers' pinned prose included — regenerating pinned text is a review
  decision, not a gate breach).

Representative T1 spine (full per-suite citations live in the test audit, and
the suites themselves are the authority): `conformance/boundary`,
`conformance/layer-direction`, `conformance/verdict-layering`,
`conformance/module-graph`, `conformance/conformance.integration` (the ESLint
differential), `conformance/corpus.integration`, `rules/invariants`,
`analysis/metamorphic`, `check-repeat-byte-identity.integration`,
`deterministic-ordering.integration`, `refusal-contract.integration`,
`entry-point.test`, `index.test`, plus the LSP empty-diagnostic suites.

## Contract → pin map (external contracts a refactor must not move)

| Contract                                         | Pin today                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Exit codes 0/1/2/3; `check` the only 4-code verb | `EXIT` table + `verdict-layering` scan + `exit-matrix.integration` + spawned `cli.integration`                                       |
| JSON envelope `schemaVersion: 2` + field roster  | `envelope-shape.integration` vs `envelope-shape.json` (both directions, human-gated regen) + `json.test` self-contradiction refusals |
| SARIF shape                                      | `sarif.integration.test.mjs`                                                                                                         |
| Intent contracts A–M                             | `src/intent/intent-manifest.json` + `intent.test.mjs`                                                                                |
| CLI verb/flag spellings                          | `COMMAND_NAMES`-derived rosters + `check-cli-docs-roster` + `cli-contract-edge-cases`                                                |
| Package exports/subpaths/bins                    | `module-graph.test` entry derivation + `boundary.test` manifest parity + `verify-package`                                            |
| Config schema + 4-dialect equivalence            | `config*.test` family with red twins                                                                                                 |
| Analysis record contract (frozen)                | `src/analysis/contract.md` + intent C + metamorphic/corpus                                                                           |
| Status ladder `ok/findings/no-verdict`           | `verdict-layering` STATUS_KEYS + refusal-contract                                                                                    |
| LSP surface + empty-diagnostic invariant         | protocol/diagnose/server suites + `verify-package` check 3                                                                           |
| MCP tool surfaces                                | `packages/archkeep-mcp` suite (runs via its own moon target)                                                                         |
| Rule-SDK one contract                            | `rule-sdks.integration.test.mjs` (ADR 0002 gate)                                                                                     |
| Provider parity Nx/Moon/Native                   | intent L + `e2e/parity` + CI twins                                                                                                   |
| Docs claims, rosters, prereqs                    | the `scripts/check-*` gates                                                                                                          |
| PR title convention                              | commitlint step in `ci.yml`                                                                                                          |

## Existing differentials (old-vs-new machinery already real)

1. Engine vs `@nx/enforce-module-boundaries` over the fixture catalogue, with
   an exact divergence ledger and vacuity guards.
2. Engine vs ESLint on pinned real trees (weekly + release lane, tagged bytes).
3. Native vs Moon/Nx on this tree (CI twins; in-package native differential).
4. `check` run-to-run byte identity (4 cold starts, self-tested comparator).
5. All-command envelope sortedness; e2e determinism legs.
6. Config dialect equivalence (4 dialects, red twins).
7. One-contract-four-SDKs (byte-identical fixtures + digest-verified wasm).
8. Cross-command consistency (history/trajectory/classifier, gates, state).
9. Coverage-real-trees weekly (exact counts both directions).

## Output differentials every structural phase must run

For the verbs its diff touches, over pinned fixture trees, old path vs new:

1. `check` verdict + JSON + SARIF, byte-for-byte.
2. `delta --capture` then `--compare` classification stability.
3. `change` reconciliation verdicts.
4. `explain` per-site agreement with `check` findings.
5. `context`/`impact` agreement with `check` declared edges.
6. `waivers` finding set vs `check` (suppression-removal path).
7. `health`/`report` numbers vs their constituent commands.
8. `history --capture` → `diff` roundtrip.
9. `trajectory` classification vs `history`'s classifier.
10. Exit-code matrix per verb — the real exit-matrix shape (ok/refused sides
    plus the suite's named extras; findings sides pinned for the five verdict
    carriers).
11. `rules verify` tamper → exit 1.
12. Envelope byte stability per verb.

## Differential gaps (what the harness cannot prove today)

- **GAP-A — golden-output corpus (load-bearing).** No committed pre/post
  stdout (text+json+sarif) per verb over pinned trees. `envelope-shape.json`
  pins field paths, not values; byte-identity compares the same code to
  itself. **Phase 4 entry gate**: record the corpus before any structural
  move (regen procedure modeled on `ARCHKEEP_UPDATE_ENVELOPE_SHAPE`,
  human-gated). Exit: post-refactor diff empty or re-blessed row by row.
- **GAP-B — byte-identity is single-command** (`check`); the comparator's own
  header anticipates composing it for every read-only verb.
- **GAP-C — differential breadth**: governance/provenance/report _values_
  have no differential, only relationship pins.
- **GAP-D — no cross-version baseline**: nothing diffs engine output at
  version N vs N+1 over the same tree.
- **GAP-E — LSP has no recorded golden responses** for a server refactor.

## Architectural test gaps

Structure claimed but not scanned — each is a one-direction static-import
assertion over the shipped tree, same mechanics as `layer-direction.test.mjs`:

- **G-1** core (`rules`/`analysis`/`report`) → `providers/` — claimed by
  intent A, unenforced.
- **G-2** `commands` → `lsp`.
- **G-3** `nx.mjs`/`index.mjs`/`commands.mjs` re-export-only.
- **G-4** `cli.mjs`/`lsp.mjs` wiring-only.
- **G-5** `report/` imports no rule/config law (renders, decides nothing).
- **G-6** `options.mjs` the only filename-knowing layer.
- **G-7** every `src/**.mjs` reachable from an entry (no orphans).
- **G-8** unit-tier filesystem purity.

Phase 3 closes them in priority order G-1, G-5, G-2, G-7; G-3/G-4/G-6/G-8
remain conventions with recorded reasons unless a phase proves a scan's worth.

## Per-phase validation requirement

Every phase PR carries, in its description: the INV ids touched, the T1/T2
suites re-run by name, the output differentials run (rows above), and — for
phases 4+ — the GAP-A corpus comparison verdict. "Tests pass" is not evidence;
the named matrix is.
