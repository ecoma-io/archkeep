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

Three shapes exist where one is claimed:

- `nx.mjs` — one call (`readProjectGraph`), pure acquisition.
- `native/` — two calls (discover, then buildGraph).
- `moon.mjs` — one call + marker, with normalization policy embedded (see
  [AUTHORITY-MAP.md](AUTHORITY-MAP.md#known-divergences-and-pressures)).

Plus the LSP's private Nx branch (`workspace-index.mjs:398-533`) — a fourth,
surface-local acquisition path. Phase 1 normalizes the seam definition; Phase
7 collapses the LSP's copy into it.

## Package-level boundaries (repository self-law)

`module-boundaries.config.mjs` at the workspace root is the law this
repository runs on itself; `packages/archkeep-mcp` composes `./commands`, the
VS Code client holds no analysis, the rule SDKs hold no engine. The refactor
does not move package boundaries without a proven gain
([CON-9](CONSTITUTION.md#con-9--surface--package): surface ≠ package).
