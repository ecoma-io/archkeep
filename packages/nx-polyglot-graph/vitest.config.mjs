// Node environment; `.mjs` config because this project has no TS toolchain.
// Default pool is fine: no test chdirs or mutates process.env (the integration
// test passes absolute fixture paths through the resolver contract instead of
// relying on the working directory).
import { defineConfig } from "vitest/config";

// The coverage floor is stated here rather than read from a workspace-level
// file, and that is Rule 14 rung 3 passing its rubric for exactly as long as
// this is the only package with tests: there is no second consumer to drift
// from. When a second package earns a test target, these four numbers hoist to
// a root `coverage.config.json` that both configs read — a value copied across
// two files was never a valid hardcode, it was an unsynced config.
//
// 80 is a floor, not a target: it exists so a change that deletes coverage
// fails instead of passing quietly. This suite sits well above it.
const thresholds = {
  lines: 80,
  functions: 80,
  branches: 80,
  statements: 80,
};

export default defineConfig({
  test: {
    environment: "node",
    // Pins fast-check's seed on CI; the file beside this one says why.
    setupFiles: ["./vitest.property-seed.mjs"],
    include: ["src/**/*.test.mjs"],
    coverage: {
      provider: "v8",
      enabled: true,
      // `index.mjs` is named because Nx loads it and nothing else; it is
      // exercised in-process by the graph integration test. `cli.mjs` and
      // `lsp.mjs` are deliberately absent: both call `process.exit` and are
      // driven end-to-end as spawned subprocesses, which in-process V8
      // coverage cannot see.
      include: ["src/**/*.mjs", "index.mjs"],
      exclude: ["src/**/*.test.mjs"],
      thresholds,
    },
  },
});
