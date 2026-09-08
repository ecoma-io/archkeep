// E2E Vitest configuration.
//
// Separate from the package's own `vitest.config.mjs` for two reasons:
//   - E2E runs the installed CLI as a subprocess, not in-process code, so V8
//     coverage cannot see it — the same reason `cli.mjs` and `lsp.mjs` are
//     excluded from the package config's coverage `include`.
//   - E2E needs a much longer timeout (artifact packing, pnpm install, real
//     CLI execution) and serial execution (one pack per run, one install per
//     consumer), which would slow or break the package's own unit/integration
//     suite if applied globally.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.e2e.mjs"],
    // E2E tests pack an artifact, install it, and run the real CLI — each
    // scenario can take 30+ seconds. 120 s gives headroom for CI runners
    // that share resources. `hookTimeout` must match: every suite creates
    // its consumers in `beforeAll`, and Vitest's 10 s default hook timeout
    // kills the whole suite before a single test runs when the host is busy.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // File-level parallelism is safe here because concurrent files share
    // nothing a race could reach: every consumer a file touches lives in its
    // own mkdtemp directory (`helpers/consumer.mjs` — temp dir, `git init`,
    // its own install per consumer; `helpers/artifact.mjs` packs into one the
    // same way). A file's own tests still run in order, so a scenario that
    // mutates its consumer stays serial where the sequencing matters.
    // Cross-runner parallelism is `--shard`, which splits the FILES across
    // runners — see the `verify-e2e` job in `../../../.github/workflows/ci.yml`.
    // Vitest 4 moved pool options to the top level; `fileParallelism` here
    // replaces the old `poolOptions.forks.maxForks: 1`.
    pool: "forks",
    fileParallelism: true,
  },
});
