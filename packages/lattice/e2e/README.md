# E2E Compatibility Suite

End-to-end tests that verify the **installed CLI** — the public product a consumer buys — against real `pnpm pack` tarballs installed into independent workspaces outside this repository.

## What these tests prove

The unit and integration tests under `src/` prove the engine correct against in-process fixtures. The E2E suite proves something they structurally cannot: that the artifact a consumer installs from npm works from end to end, in a tree this repository never built, with tag vocabularies `src/` has no knowledge of.

Specifically:

- **Eight of the sixteen public commands** (`check`, `graph`, `diff`, `drift`,
  `history`, `impact`, `explain`, `context`) produce correct exit codes and
  structured output
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
# Full suite (all commands, parity, determinism)
pnpm e2e

# Smoke subset (~5 fastest scenarios)
pnpm e2e:smoke
```

Both commands run Vitest with the dedicated config at `packages/lattice/e2e/vitest.config.mjs`. Tests execute **serially** (`maxForks: 1`) because `pnpm install` mutates `node_modules` and parallel consumers would race on shared state.

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
4. `git init`-ed and committed (Lattice uses `git ls-files` — an uncommitted tree is empty)
5. Torn down in a `finally` block

### Fixtures

```
fixtures/
  boundary-law.mjs       Two-layer (core/app) and three-layer (core/api/app) constraint tables
  nx-consumer.mjs        Nx workspace: nx.json, project.json, Go sources
  native-consumer.mjs    Native workspace: lattice.json, Go sources, no nx
  native-monorepo.mjs    3-project native monorepo (app → api → core)
  violations.mjs         Files that produce specific violation types
```

### Test files

| File                  | Commands covered                                                        |
| --------------------- | ----------------------------------------------------------------------- |
| `check.e2e.mjs`       | `check` (clean, violating, no-marker, JSON envelope)                    |
| `graph.e2e.mjs`       | `graph` (clean, JSON envelope, project names, edges, `--output`)        |
| `diff.e2e.mjs`        | `diff` (self-baseline, added/removed edge, invalid/incomplete baseline) |
| `drift.e2e.mjs`       | `drift` (smoke, with an intent file)                                    |
| `history.e2e.mjs`     | `history` (empty/capture, evolution)                                    |
| `context.e2e.mjs`     | `context` (smoke, full)                                                 |
| `intent.e2e.mjs`      | `architecture-intent` through the installed CLI                         |
| `moon.e2e.mjs`        | Moon provider (smoke, full)                                             |
| `impact.e2e.mjs`      | `impact` (leaf, mid-chain, root project, unknown project)               |
| `explain.e2e.mjs`     | `explain` (clean site, violating site, malformed/missing site)          |
| `parity.e2e.mjs`      | Native/Nx semantic parity (projects, edges, violations, envelope)       |
| `determinism.e2e.mjs` | Repeated-execution byte-identical output                                |

### Smoke tests

Describe blocks named `(smoke)` contain the five fastest scenarios:

- Native clean check
- Native violating check
- Nx clean check
- Native graph
- Native self-baseline diff

The `e2e:smoke` script filters by name pattern (`-t 'smoke'`), running only these.

## CI integration

- **Every PR and merge**: `pnpm e2e:smoke` runs after `verify-package.mjs` in the `verify` job
- **Every PR and merge**: `pnpm e2e` runs the full suite in the same job
- **Release lane**: `pnpm e2e` runs before `npm publish`, against the exact tag checkout

The existing `verify-package.mjs` step remains unchanged — it proves LSP initialization and Nx Go-edge drawing, responsibilities the E2E suite does not duplicate.

## Relationship to verify-package.mjs

Both prove the packed artifact works outside this workspace. They are **deliberately independent**:

- `verify-package.mjs` is a standalone gate script with inline assertions, running as a side-effect script
- The E2E suite is Vitest-based with structured fixtures, lifecycle hooks, and per-test isolation

Two independent harnesses that prove the same thing from different angles is **stronger** than one shared harness — a defect that hides from one pattern may surface in the other.
