# Boundaries

What separates the layers today, which separations are **mechanically
enforced** versus declared-but-unscanned, and the pressure points the Phase 0
audit measured. The refactor's boundary work is mostly _enforcing what is
already claimed_ before creating anything new.

## Enforced today (a test fails on violation)

| Boundary                                               | Enforcement                                                      |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| No undeclared third-party imports in shipped code      | `src/conformance/boundary.test.mjs:405-421`                      |
| Manifest ↔ imports parity, both directions             | `boundary.test.mjs:468-523`                                      |
| No `src/lsp → src/commands` static import              | `src/conformance/layer-direction.test.mjs` (#649)                |
| Verdict core imports no `report/`                      | `src/conformance/verdict-layering.test.mjs:1-31`                 |
| No second numeric status→exit table in shipped surface | `verdict-layering.test.mjs:131-186`                              |
| Shipped import graph acyclic                           | `src/conformance/module-graph.test.mjs`                          |
| Engine vs `@nx/enforce-module-boundaries` differential | `src/conformance/conformance.integration.test.mjs`               |
| This repository's own boundaries                       | `module-boundaries.config.mjs` via `cli.mjs check` in CI         |
| Package-level containment (repo self-law)              | `module-boundaries.config.mjs` (tags `type-package`, `scope-nx`) |

## Declared but unscanned

Stated in `packages/archkeep/AGENTS.md` or the intent manifest, with **no test
that fails** if violated tomorrow (audit registers G-1..G-8; full definitions
in [VALIDATION-MATRIX.md](VALIDATION-MATRIX.md#architectural-test-gaps)):

- **G-1** core (`rules`, `analysis`, `report`) must not import `providers/` —
  intent A _claims_ this; `boundary.test.mjs` is package-level, not
  layer-level, so a relative `./providers/…` import passes.
- **G-2** `commands → lsp` (reverse of the #649 direction).
- **G-3** `nx.mjs`/`index.mjs`/`commands.mjs` re-export-only — no scan keeps
  logic out of the module every `nx` invocation pays to load.
- **G-4** `cli.mjs`/`lsp.mjs` wiring-only.
- **G-5** `report/` renders and decides nothing — nothing forbids
  `report → rules` imports.
- **G-6** `src/options.mjs` as the only filename-knowing layer.
- **G-7** orphan modules — `module-graph.test.mjs` grows closure _from_
  entries but never asserts every `src/**.mjs` is reachable from one.
- **G-8** unit-tier purity (no filesystem in unit tests) — convention only.

Phase 3's core deliverable is turning the load-bearing subset of these into
scans; the priority order is G-1, G-5, G-2, G-7 (each is a one-direction
static-import assertion over the shipped tree, same mechanics as
`layer-direction.test.mjs`).

## Measured pressure points (edges that exist today)

The graph is acyclic and law-abiding, but these edges are where the declared
layering bends (all verified by audit; none is a violation of any current
rule):

1. **`analysis → rules`** — `src/analysis/markdown.mjs:51` imports
   `rules/match.mjs` (analyzer consulting rule vocabulary).
2. **`options ↔ analysis` mutual** — `analysis/typescript.mjs:85`
   (`DEFAULT_OPTIONS`) vs `options.mjs:94` (`languageOf`).
3. **`rules ↔ config` mutual** — `rules/index.mjs:57` imports `config.mjs`;
   `config.mjs:132-141` imports `rules/match` + `rules/messages`.
4. **core → governance** — `config.mjs:129-131` and `rules/index.mjs:58-59`
   import from `src/governance/`.

Each is acceptable under
[CON-0](CONSTITUTION.md#con-0--do-not-trade-semantic-maturity-for-structural-purity)
until it costs something; Phase 3 records the decision per edge (keep, with a
documented reason, or break) rather than blanket-forbidding them.

## Provider seam

One selection gate, four acquisition paths. The gate is
`requireSingleProjectModel` (`packages/archkeep/src/providers/model-gate.mjs`):
both faces read it before composing any provider — the CLI at
`src/commands/context.mjs:535`, the LSP at `src/lsp/workspace-index.mjs:372` —
and it refuses a root carrying more than one project-model marker. Both faces
then compose in the same order: native (`archkeep.json`) first, Moon
(`.moon/` or `.config/moon/`) second, Nx as the fallback branch. Behind the
gate, three provider shapes where one seam is claimed — Nx one-call, native
two-call, Moon one-call-plus-marker — plus the LSP's private Nx branch, a
fourth, surface-local path.

The seam is measured against a responsibility ladder:

**Acquisition → Normalization → Bounded derivation → Canonical engine input →
Evaluation.**

Bounded derivation is permitted only when all four hold: the source fact is
externally stated, the transformation is deterministic, the transformation is
recorded (ADR or contract), and the provider never evaluates policy, never
creates a verdict, never creates a governance decision. Evaluation belongs to
the evaluation authority alone. The Canonical output column below is the
ladder's fourth rung — what each path hands `evaluate()`. Per-path contract,
measured against source (Phase 1-D, 2026-09-06):

| Provider                                                   | Acquisition shape                                                                                                                                                                                                                                        | Normalization boundary                                                                                                                                                                                                                                                                                                                                       | Bounded derivation (recorded)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Failure / loudness                                                                                                                                                                                                                                                                                                                                                                   | Canonical output                                                                                                                                                                                                                                                                      | Consumer contract                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Nx** — `providers/nx.mjs`                                | One call, no `marker` field on the provider object — the fallback branch. `readProjectGraph(root)` (`nx.mjs:144`) spawns `node <nx-cli> graph --file=<tmp>`, the CLI resolved from the workspace's installed `nx` peer                                   | Shape-check plus one merge: `graph.nodes` required; `workspaceLayout` merged from `nx.json` when declared-and-complete, refused when declared-incomplete, absent when undeclared (`nx.mjs:159`). `externalNodes` and the three caller-annotated facts (`mfeRemote`, `entryPoints`, `declaredPackages`) deliberately stay out                                 | None — every graph fact was emitted by `nx graph` or stated in `nx.json`; the provider adds no derived input                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Absent peer throws the install action (`MODULE_NOT_FOUND` only; other resolver failures propagate as themselves); no `graph.nodes` throws; spawn failures propagate already named by `runProcess`. No path returns an empty graph                                                                                                                                                    | `{nodes, dependencies}` plus `workspaceLayout` when declared-complete — the graph half of `evaluate()`'s input, manifest edges already inside `dependencies` (drawn by the polyglot plugin inside Nx's own computation)                                                               | CLI only (`commands/context.mjs`'s Nx branch; `pluginGap` reports an unregistered plugin). The LSP never uses this provider — last row                                                                                                                                                                                    |
| **Native** — `providers/native/`                           | Two calls, `marker: archkeep.json`. `discover({root, files, readFile})`, then `buildGraph({discovered, importSites})` — the split exists because import-site analysis needs projects known first; one call would hide an analysis pass inside a provider | `discover` validates the `archkeep.json` model (a declared-but-incomplete `workspaceLayout` refused at load), discovers declared-or-inferred projects, judges coverage. `buildGraph` (`native/graph.mjs:188`) writes only measured node facts and reproduces Nx's own root-target-edge rule (`isRoot`)                                                       | `targets` executors synthesized from declared target names (`archkeep:declared`, so `hasBuildExecutor` reads them as real) and `exemptedFiles` expanded from `coverage.exempt` rows — both from stated facts, deterministic, recorded in the module contracts (`native/graph.mjs`, `native/coverage.mjs`) and pinned by their suites; neither evaluates anything                                                                                                                                                                                                                                       | Malformed model, discovery defect, stale `coverage.exempt` row → throw. An unclaimed file and an unparseable manifest are NOT throws: `fileFailure` records riding in `failures`, the same exit-3 path an analyzer's own failures use                                                                                                                                                | `{nodes, dependencies}` plus `workspaceLayout`/`exemptedFiles` declared-or-absent (never defaulted here — the engine's `createContext` is the only place the default is applied); `externalNodes` never set, the engine synthesizes externals from analysis records                   | Both faces call the same two functions: the CLI's native branch and the LSP's `buildNativeWorkspaceIndex`, which catches a `discover` throw into a `nativeModelFailure` gap instead of exiting. Both fold manifest edges (`mergeDeclaredEdges`); import sites are `buildGraph`'s explicit input, so no `mergeImportEdges` |
| **Moon** — `providers/moon.mjs`                            | One call + marker (`.moon/` or `.config/moon/`, both-at-once refused inside `moonMarkerAt`). `readProjectGraph(root)` (`moon.mjs:943`) spawns `moon project-graph --json`, the workspace's `node_modules/.bin` prepended to PATH                         | `transformMoonGraph` (`moon.mjs:606`): the three contract-backed normalizations — root-scoped edge exclusion, Moon↔Archkeep vocabulary inversion, scope collapse — plus root-spelling refusal (`canonicalMoonRoot`) and collect-and-throw anomaly refusal. The per-item verdicts are [MOON-POLICY.md](MOON-POLICY.md)'s items 1–3, cited, not re-adjudicated | The two provider-owned derived inputs, each with enforcement consequences, each ADR-recorded: `layer:`/`stack:` tags — constraint rows match tags — ([ADR 0009](../../adr/0009-moon-derived-tags-provider-policy.md)) and `workspaceLayout` inference — feeds `isAbsoluteImportIntoAnotherProject` — ([ADR 0010](../../adr/0010-moon-workspace-layout-inference.md)); [MOON-POLICY.md](MOON-POLICY.md) items 4–5. Not judgments: the provider states Moon's own facts in the vocabulary the rules read and decides nothing with them (`nodeTypeFromLayer` reads under ADR 0009's reasoning by analogy) | Absent binary throws the install action (ENOENT only — a binary that ran and failed propagates untouched); anomalous output and non-canonical roots each throw naming every instance at once. No path answers with an empty graph                                                                                                                                                    | `{nodes, dependencies}` plus `workspaceLayout` when inference completes (both axes or neither). The `graph` snapshot reports an inferred layout through the `workspaceLayoutSource` `"declared"` slot — [ADR 0010](../../adr/0010-moon-workspace-layout-inference.md)'s recorded cost | Both faces through the one `moonProvider.readProjectGraph`, then the same `mergeImportEdges` (Moon has no plugin hook, so the consumer folds analysis import edges) and `mergeDeclaredEdges`; the LSP catches a throw into a `moonModelFailure` gap. Every adjudicated behavior pinned by `moon.test.mjs`                 |
| **LSP private Nx** — `src/lsp/workspace-index.mjs:398-533` | A fourth shape, none of the three: the index re-implements Nx discovery — private `discoverProjects`/`buildNodes` in the same file — by reading tracked `project.json` files instead of asking Nx, because a server spawned by an editor has no Nx       | Nx-shaped nodes from shared primitives (`nodeTypeOf`/`buildDependencies` imported from `providers/native/`, not a second copy); `workspaceLayout` merged from `nx.json` exactly as the Nx provider merges it, its read failure caught into a `workspaceLayoutFailure` gap rather than thrown; manifest edges folded (`mergeDeclaredEdges` — no plugin host)  | The annotator facts (`mfeRemote`, `entryPoints`, `declaredPackages`) computed in-branch through the same shared `workspace.mjs` functions the CLI calls — the one node-fact derivation that lives surface-side today                                                                                                                                                                                                                                                                                                                                                                                   | Nothing escapes the index build as a throw: an unparseable `project.json` and a duplicate project name become published gaps (`skippedProjects`, `duplicateProjects`); a package-based Nx workspace — projects declared in `package.json`, which `discoverProjects` never reads — yields zero nodes, recorded as `nxModelFailure` naming that `archkeep check` still judges the tree | An Nx-shaped `{nodes, dependencies}` graph — the same canonical shape, built per-surface rather than by a provider                                                                                                                                                                    | LSP only — **temporary divergence, collapses in Phase 7**. The gap family (`indexGaps`) publishes one bounded diagnostic on every open document, and `diagnose.mjs` refuses to call a document analyzed while any gap stands                                                                                              |

The LSP row, as a registered divergence rather than prose:

```text
Current: LSP → private acquisition/normalization path
Target:  LSP → canonical provider seam
Phase:   7
Reason:  avoid duplicate acquisition semantics and surface-specific drift
```

Phase 7's entry — collapse the private Nx discovery into this seam, golden LSP
responses recorded first (GAP-E) — is
[MIGRATION-PLAN.md](MIGRATION-PLAN.md#phase-7--additional-surfaces-lsp-mcp-vs-code)'s;
[AUTHORITY-MAP.md](AUTHORITY-MAP.md#known-divergences-and-pressures)'s
divergence 2 is the Phase 0 record of the same fact.

One coupling this table records as a Phase 7 note, not a design: the three
provider objects carry three different shapes — `{name, readProjectGraph}`
(`nx.mjs:175`), `{name, marker, discover, buildGraph}`
(`native/index.mjs:148`), `{name, marker, readProjectGraph}`
(`moon.mjs:980`) — and the consumer branches on provider anyway
(`context.mjs:542` picks the graph reader; native never goes through one).
Whether that coupling earns a shared shape is Phase 7's question; this table
proposes no interface for symmetry.

## Package-level boundaries (repository self-law)

`module-boundaries.config.mjs` at the workspace root is the law this
repository runs on itself; `packages/archkeep-mcp` composes `./commands`, the
VS Code client holds no analysis, the rule SDKs hold no engine. The refactor
does not move package boundaries without a proven gain
([CON-9](CONSTITUTION.md#con-9--surface--package): surface ≠ package).
