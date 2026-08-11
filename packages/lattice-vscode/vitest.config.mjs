// Node environment; `.mjs` config because this repository has no TS toolchain.
// Nothing here needs a DOM: every test in this package drives a pure function
// over described inputs, and the one file that talks to VS Code is excluded
// below.
import { readFileSync } from "node:fs";

import { defineConfig } from "vitest/config";

// Read, not imported: JSON has no import, and a relative import from inside a
// project up to a root-level file is a boundary violation this repository's own
// checker reports. The four keys are named individually rather than spread, so
// a comment or a new key in that file cannot arrive here as a threshold vitest
// does not know.
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
    include: ["src/**/*.test.mjs"],
    coverage: {
      provider: "v8",
      enabled: true,
      // `extension.mjs` is deliberately absent, on the same ground `cli.mjs` and
      // `lsp.mjs` are absent from the server package's config: it can only run
      // inside a VS Code extension host, which in-process V8 coverage never
      // sees. That is the exclusion's reason, not a convenience — and it is why
      // that file holds wiring only, with every decision in `src/`.
      include: ["src/**/*.mjs"],
      exclude: ["src/**/*.test.mjs"],
      thresholds,
    },
  },
});
