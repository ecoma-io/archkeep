// Node environment; `.mjs` config because this project has no TS toolchain.
// Default pool is fine: no test chdirs or mutates process.env (the integration
// test passes absolute fixture paths through the resolver contract instead of
// relying on the working directory).
import { readFileSync } from "node:fs";

import { defineConfig } from "vitest/config";

// The coverage floor used to be four literals here, with a note saying they
// would hoist to a root `coverage.config.json` the moment a second package
// earned a test target. `packages/lattice-vscode` is that package, and this is
// the hoist. It is read rather than imported: JSON has no import, and a relative
// import from inside a project up to a root-level file is a boundary violation
// this repository's own checker reports. The four keys are named individually
// rather than spread, so a comment or a new key in that file cannot arrive here
// as a threshold vitest does not know.
const floor = JSON.parse(readFileSync(new URL("../../coverage.config.json", import.meta.url)));
const thresholds = {
  lines: floor.lines,
  functions: floor.functions,
  branches: floor.branches,
  statements: floor.statements,
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
