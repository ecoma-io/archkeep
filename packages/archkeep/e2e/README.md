# E2E Compatibility Suite

End-to-end tests that verify the **installed CLI** — the public product a consumer buys — against real `pnpm pack` tarballs installed into independent workspaces outside this repository.

## What these tests prove

The unit and integration tests under `src/` prove the engine correct against in-process fixtures. The E2E suite proves something they structurally cannot: that the artifact a consumer installs from npm works from end to end, in a tree this repository never built, with tag vocabularies `src/` has no knowledge of.

Specifically:

- **Ten of the eighteen public commands** (`check`, `graph`, `diff`, `drift`,
  `fitness`, `waivers`, `history`, `impact`, `explain`, `context`) produce
  correct exit codes and structured output
- **Native and Nx consumers** agree on semantics (project names, edge source/target/type, violation rule IDs and file paths)
- **Deterministic output** — two runs over an unchanged tree produce byte-identical JSON
- **Silent-failure guards** — exit 3 when no verdict is reachable (no workspace marker, incomplete graph, malformed baseline), never exit 0

What E2E does **not** cover (and why):

| Gap                 | Reason                                             |
| ------------------- | -------------------------------------------------- |
| LSP initialization  | Already covered by `scripts/verify-package.mjs`    |
| Nx Go-edge drawing  | Already covered by `scripts/verify-package.mjs`    |
| SARIF output        | Covered by `src/report/sarif.integration.test.mjs` |
| In-process coverage | E2E runs subprocesses; V8 coverage cannot see them |

## Running

```bash
# The whole suite (all commands, parity, determinism)
pnpm e2e

# One half of it — the two shards CI runs on separate runners
pnpm e2e --shard=1/2
pnpm e2e --shard=2/2
```

`pnpm e2e` is the one entry point, and anything after it is passed through to Vitest, which runs with the dedicated config at `packages/archkeep/e2e/vitest.config.mjs`. Tests execute **serially** (`fileParallelism: false`) because `pnpm install` mutates `node_modules` and parallel consumers would race on shared state — the parallelism CI buys is across runners, never inside one.

## Architecture

### Harness

```
helpers/
  artifact.mjs    Packs once per run, returns the tarball path
  consumer.mjs    Creates, installs, and tears down consumer workspaces
  run.mjs         Spawns the installed CLI, captures exit code and output
```

Every consumer workspace is:

1. Created in an OS temp directory (outside this repository)
2. Populated with fixture files
3. `pnpm install`-ed with the packed tarball
4. `git init`-ed and committed (Archkeep uses `git ls-files` — an uncommitted tree is empty)
5. Torn down in a `finally` block

### Fixtures

```
fixtures/
  boundary-law.mjs       Two-layer (core/app) and three-layer (core/api/app) constraint tables
  nx-consumer.mjs        Nx workspace: nx.json, project.json, Go sources
  native-consumer.mjs    Native workspace: archkeep.json, Go sources, no nx
  native-monorepo.mjs    3-project native monorepo (app → api → core)
  vertical-slice-consumer.mjs  Feature-sliced tree whose law is a fitness function
  waiver-law.mjs         One law in three readings: permanent, active waiver, lapsed waiver
  violations.mjs         Files that produce specific violation types
```

`vertical-slice-consumer.mjs` is the one fixture whose point is what the
constraint rows CANNOT see: every slice carries the same `layer:slice` tag, so
`depConstraints` permits the cross-slice edge and only the declared
`tag-axis-isolation` function reports it. `check` on that tree prints "no
boundary violations" and still exits 1, which is the fold `fitness.e2e.mjs`
exists to pin.

### Test files

| File                  | Commands covered                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `check.e2e.mjs`       | `check` (clean, violating, no-marker, JSON envelope)                                                            |
| `graph.e2e.mjs`       | `graph` (clean, JSON envelope, project names, edges, `--output`)                                                |
| `diff.e2e.mjs`        | `diff` (self-baseline, added/removed edge, invalid/incomplete baseline)                                         |
| `drift.e2e.mjs`       | `drift` (matching tree, forbidden edge, missing project, malformed intent)                                      |
| `history.e2e.mjs`     | `history` (empty/capture, evolution)                                                                            |
| `context.e2e.mjs`     | `context` (tags, constraints, text and JSON, unknown project)                                                   |
| `intent.e2e.mjs`      | `architecture-intent` through the installed CLI                                                                 |
| `moon.e2e.mjs`        | Moon provider (`check`, `graph`, `diff`, `impact`, `explain`, `context`)                                        |
| `impact.e2e.mjs`      | `impact` (leaf, mid-chain, root project, unknown project)                                                       |
| `explain.e2e.mjs`     | `explain` (clean site, violating site, malformed/missing site)                                                  |
| `fitness.e2e.mjs`     | `fitness` and `check`'s fold of it: clean → coupled → fixed, plus the unjudgeable case (exit 3)                 |
| `waivers.e2e.mjs`     | The suppression table over a real violation: permanent, active, expired, and the row left stale by a fix        |
| `parity.e2e.mjs`      | Native/Nx semantic parity (projects, edges, violations, envelope)                                               |
| `determinism.e2e.mjs` | Repeated-execution byte-identical output                                                                        |
| `sweep.e2e.mjs`       | Every machine-readable command, run twice, byte-identical                                                       |
| `languages/*.e2e.mjs` | Go, Rust, Python, TypeScript, JavaScript and Vue, one file each, plus `cross-language.e2e.mjs` for their parity |

### Sharding

The suite is split across runners by **test file**, and the assignment is
Vitest's rather than this directory's: measured against Vitest 4.1.10, it hashes
each resolved file's workspace-relative path with SHA-1, sorts by that hash, and
hands each shard a contiguous slice. Two consequences worth knowing before
trying to tune it:

- The split is deterministic run to run, and every file lands in exactly one
  shard — the shards together are the whole suite, never more and never less.
- The sort key is a path, not a cost, so the shards are **not** balanced by
  duration, and no ordering option can rebalance them: `shard()` re-sorts by
  hash whatever order it is handed. What does move a file between shards is
  renaming it (the hash is of its path) or adding or removing an e2e file (the
  slice boundaries move with the file count).

A shard that ran nothing must never read as a shard that passed. Both ways that
can happen exit 1 rather than 0, and the
[`verify-e2e` job](../../../.github/workflows/ci.yml) names each with the
message Vitest prints.

## CI integration

- **Every PR and merge**: two `verify-e2e` matrix legs run `pnpm e2e --shard=1/2`
  and `pnpm e2e --shard=2/2`, in parallel with `verify-core`
- **Release lane**: `pnpm e2e` runs the whole suite in one job before
  `npm publish`, against the exact tag checkout

The existing `verify-package.mjs` step remains unchanged — it proves LSP initialization and Nx Go-edge drawing, responsibilities the E2E suite does not duplicate.

## Relationship to verify-package.mjs

Both prove the packed artifact works outside this workspace. They are **deliberately independent**:

- `verify-package.mjs` is a standalone gate script with inline assertions, running as a side-effect script
- The E2E suite is Vitest-based with structured fixtures, lifecycle hooks, and per-test isolation

Two independent harnesses that prove the same thing from different angles is **stronger** than one shared harness — a defect that hides from one pattern may surface in the other.
