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
    // that share resources.
    testTimeout: 120_000,
    // Serial execution: the artifact is packed once per run, and pnpm install
    // mutates the consumer's node_modules. Parallel tests sharing a consumer
    // directory would race; separate consumers are possible but slower and
    // the serial overhead is modest (~30 s total for a smoke run).
    // Vitest 4 moved pool options to the top level; `fileParallelism: false`
    // replaces the old `poolOptions.forks.maxForks: 1`.
    pool: "forks",
    fileParallelism: false,
  },
});
