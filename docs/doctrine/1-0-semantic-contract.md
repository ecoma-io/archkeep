# 1.0 semantic contract

This page is the 1.0 freeze manifest. It does not restate the schemas, command
contracts or authority rules those pages already own; it names the surfaces that
become compatibility commitments at 1.0 and points each one at its binding home.
If a future change needs to alter one of these surfaces, the change is a
contract change even when no function signature moved.

This page prepares a 1.0 candidate. It does not release 1.0, tag it, or decide
that every readiness condition is met.

## What is frozen

| surface                           | binding home                                                                                                                                                                                                                      | what changes only as a contract change                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authority boundary                | [architecture-authority.md](architecture-authority.md), [exit-codes.md](../reference/exit-codes.md)                                                                                                                               | `check` remains the sole workspace-architecture enforcement authority and the only command holding all four exit codes in its verdict fold; `fitness`, `delta`, `change` and `rules verify` remain bounded verdict carriers — each exits 1 on its own question's findings and 3 where it could not look, none holding exit 2 in its own fold; every other command is descriptive.   |
| Process exit codes                | [exit-codes.md](../reference/exit-codes.md), `packages/archkeep/src/verdict.mjs`                                                                                                                                                  | The meanings of 0, 1, 2 and 3, and the exit semantics of each command; a remapped or renamed exit code is a contract change ([exit-codes.md](../reference/exit-codes.md) owns the mapping, `json-output.md` the status-to-exit agreement).                                                                                                                                          |
| JSON envelope                     | [json-output.md](../reference/json-output.md), `packages/archkeep/src/report/json.mjs`, `packages/archkeep/src/report/envelope-shape.json`                                                                                        | `schemaVersion: 2` (a bump is a breaking change); the envelope shape and its enforced latches are the binders in `json-output.md` and `envelope-shape.json`, and any change to them is a contract change even when the version moves first.                                                                                                                                         |
| SARIF output                      | `packages/archkeep/src/report/sarif.mjs`, `packages/archkeep/src/report/sarif.integration.test.mjs`                                                                                                                               | SARIF 2.1.0; `ruleId` as the engine message id; result `level: "error"`; analysis failures as notifications rather than findings; the fitness-failure rule id; and the current absence of driver `version` / `semanticVersion`. Filling that absence is a future output-contract decision, not incidental cleanup.                                                                  |
| CLI command roster                | `packages/archkeep/cli.mjs` (`COMMAND_NAMES`), `scripts/check-cli-docs-roster.mjs`, [cli.md](../reference/cli.md), [architecture.md](../concepts/architecture.md)                                                                 | The 24-command roster, held canonically by `cli.mjs`'s `COMMAND_NAMES` and enforced against the two doc tables by the roster gate; adding, renaming or removing a command is a contract change, and no other copy of the list is authoritative.                                                                                                                                     |
| Package entry points              | `packages/archkeep/package.json`, `packages/archkeep/index.mjs`, `packages/archkeep/nx.mjs`, `packages/archkeep/commands.mjs`, `packages/archkeep/gate-attestation.mjs`, `packages/archkeep/presets/*.json`                       | The root engine entry, `./nx`, `./commands`, `./gate-attestation` and `./presets/*.json`; the root `createDependencies` loud-failure guard; and the rule that `./commands` is the canonical in-process integration surface, not a duplicate CLI implementation.                                                                                                                     |
| Provider exposure                 | `packages/archkeep/index.mjs`, `packages/archkeep/src/commands/context.mjs`, `packages/archkeep/src/providers/`                                                                                                                   | `nxProvider` and `readProjectGraph` are public root exports; the native and Moon providers are internal provider spellings behind command-context resolution. Treating the three providers as a uniform public API is not part of the 1.0 contract.                                                                                                                                 |
| Configuration                     | [configuration.md](../reference/configuration.md), [policy-schema.md](../reference/policy-schema.md), `packages/archkeep/src/options.mjs`, `packages/archkeep/src/config.mjs`, `packages/archkeep/src/providers/native/model.mjs` | The `boundaryConfig` / `tsConfig` pair; the six top-level `archkeep.json` keys; profile selection; refusal of unknown option/config keys; refusal of Moon/native marker coexistence; refusal of native inline `boundaryConfig.coverage`; stale `coverage.exempt` as a loud error; and missing Moon tsconfig with path-resolved files as no-verdict rather than defaulting silently. |
| Analyzer contract                 | `packages/archkeep/src/analysis/contract.md`, `packages/archkeep/src/analysis/registry.mjs`                                                                                                                                       | Every analyzer returns the same record shape; analyzer limits are named as coverage gaps or blind spots instead of clean output; and the language registry is the source for CLI/LSP coverage.                                                                                                                                                                                      |
| MCP server                        | `packages/archkeep-mcp/src/server.mjs`, `packages/archkeep-mcp/src/engine.mjs`, `packages/archkeep-mcp/src/commands-subpath.test.mjs`                                                                                             | The nine tool names; read-only capability posture; no boundary-policy override; completed results as the same JSON envelope the CLI renders; and `archkeep_propose` returning `requiresApproval: true`, `authoritative: false`, `written: false`.                                                                                                                                   |
| LSP server and VS Code client     | `packages/archkeep/src/lsp/server.mjs`, `packages/archkeep/src/lsp/diagnose.mjs`, `packages/archkeep-vscode/src/languages.mjs`                                                                                                    | Full-document synchronization; watched graph/config files; the rule that `analyzed: false` must publish at least one diagnostic and never an empty clean list; and the routed extension set for languages ESLint cannot read.                                                                                                                                                       |
| Custom rules and official catalog | [custom-rules.md](../reference/custom-rules.md), `packages/archkeep/src/custom-rules/`, `packages/archkeep-rules/catalog.json`, `packages/archkeep/src/conformance/rule-sdks.integration.test.mjs`                                | The wasm ABI and verdict vocabulary; `fail`, `unknown` and `not_applicable` exit semantics; catalog digest verification; and the one-contract/four-SDK conformance gate.                                                                                                                                                                                                            |
| Release evidence                  | [release.md](../development/release.md), `release-please-config.json`, `.github/workflows/release.yml`, `scripts/sync-goldens.mjs`, `scripts/push-reformatted-files.mjs`, `scripts/sync-cargo-lock.mjs`                           | The repository-wide release unit; the single version chain; release-please extra-files as the authoritative version-bearing roster; golden-output version synchronization; and the requirement that any forced 1.0 cut be driven by a `Release-As: 1.0.0` footer on the commit message that reaches `main`.                                                                         |

## Compatibility classification

- **Canonical surfaces** are the entries in the table above. They are part of the
  1.0 contract because consumers can call, parse, route or publish them.
- **Intentional compatibility surfaces** stay unless a later contract change
  removes them: the `archkeep/nx` plugin shorthand, legacy `.eslintrc*` refusal,
  legacy rows without governance blocks, non-expiring suppressions, persisted
  snapshot compatibility, and the existing `complete` aliases in impact and
  scenario payloads.
- **Historical records** stay as records: ADRs, changelogs, migration notes and
  the Lattice upgrade path. They explain past compatibility costs; they are not
  active API.
- **Not public API**: native and Moon provider objects, command capability facade
  modules, governance internals, renderer helpers, and refactor-program control
  terms. They may remain important implementation constraints, but a consumer
  cannot rely on importing them from the package root.

## Future changes after 1.0

A change to an item in the freeze table must say which class it belongs to:

1. **Correctness, security or reliability.** Fixes that make the stated contract
   true, especially silent-failure fixes, are allowed and should include a
   regression that fails in the silent direction.
2. **Ecosystem-driven compatibility.** A consumer need may add a field, command,
   rule, route or adapter when it does not change an existing claim.
3. **Focused improvement.** Performance, diagnostics and ergonomics work is
   acceptable when it demonstrates the current contract remains byte-for-byte
   stable for unchanged inputs.
4. **Deferred research.** Federation runtime, global registries, generic decision
   engines, autonomous migration, AI architecture authority, runtime simulation,
   new language families and large rewrites stay outside the 1.0 contract until
   a maintainer explicitly authorizes that direction.

A field rename, exit-code remapping, changed verdict on an unchanged workspace,
changed SARIF rule id, changed MCP tool name, removed compatibility alias, or
changed package entry point is a breaking change. On the 0.x line those changes
were named behavior changes in minor releases; after 1.0 they require the release
process and maintainer decision appropriate to a breaking contract change.

## Open 1.0 decisions

These are not resolved by this manifest:

- **SARIF driver version metadata.** The current output omits driver
  `version` / `semanticVersion`; the source documents that as a gap. Filling it
  changes output identity and should be its own named decision.
- **Current release-please branch state.** The remote
  `release-please--branches--main--components--archkeep` branch (merge-base
  `5b40477c`, commits bumped to 0.26.1) must not be merged as-is. Measured on
  2026-09-08: the merge is conflict-free and self-consistent — `main` has
  touched no version-bearing file or golden since the merge-base, so the
  branch's 0.26.1 slots and its 24 `src/corpus/goldens/*.json` files land
  wholesale and the byte-identity gate passes on the merged tree. The hazard
  is sequencing, not mechanism: merging it merges an ordinary 0.26.1 release
  computed from the pre-hardening commit history, a release decision this
  manifest leaves to the maintainer. Hand-editing that branch (for example
  recomputing its goldens from a different source state) is what would create
  a version-slot mismatch.
- **Readiness evidence.** The readiness command remains the measured owner of
  whether the quiet-stretch, differential, attestation and registry conditions
  have been satisfied. This page names what freezes; it does not mark those
  conditions complete.
