// Node environment; `.mjs` config because this project has no TS toolchain.
// Nothing here needs a DOM: the unit tests drive the engine adapters over
// fixture trees, and the protocol tests drive a real MCP client over an
// in-memory transport pair.
import { readFileSync } from "node:fs";

import { defineConfig } from "vitest/config";

// Read, not imported: JSON has no import, and a relative import from inside a
// project up to a root-level file is a boundary violation this repository's
// own checker reports. The four keys are named individually rather than
// spread, so a comment or a new key in that file cannot arrive here as a
// threshold vitest does not know — the same arrangement the two sibling
// packages' configs keep.
const floor = JSON.parse(
  readFileSync(new URL("../../coverage.config.json", import.meta.url), "utf8"),
);
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
      // `mcp.mjs` is deliberately absent, on the same ground `cli.mjs` and
      // `lsp.mjs` are absent from the engine package's config: it is process
      // wiring over the real stdio, driven end-to-end as a spawned subprocess
      // by `src/mcp.integration.test.mjs`, which in-process V8 coverage never
      // sees. That is the exclusion's reason, not a convenience — and it is
      // why that file holds wiring only, with every decision in `src/`.
      include: ["src/**/*.mjs", "index.mjs"],
      exclude: ["src/**/*.test.mjs"],
      thresholds,
    },
  },
});
