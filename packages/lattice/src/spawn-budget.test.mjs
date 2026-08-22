import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SPAWN_BUDGET_MS, SPAWN_TEST_BUDGET_MS } from "../spawn-budget.mjs";

const srcRoot = fileURLToPath(new URL(".", import.meta.url));

/** Every `*.test.mjs` under `src/`, wherever it nests. */
function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.name.endsWith(".test.mjs") ? [path] : [];
  });
}

describe("the spawn budgets", () => {
  it("keeps the per-test ceiling strictly above the single-spawn budget", () => {
    // The derivation is the whole point (#249): an outer bound at or below
    // the inner one kills a test before the budget its own helper states,
    // and the tighter number is again the one nobody chose.
    expect(SPAWN_TEST_BUDGET_MS).toBeGreaterThan(SPAWN_BUDGET_MS);
  });

  it("derives every spawn-using test file's bounds from the one module", () => {
    // Same move as `../../../scripts/check-packages.mjs` parsing ci.yml: the
    // roster of files that spawn is read off the tree rather than copied, so a
    // file that starts spawning without importing the budgets fails here
    // instead of flaking under full-suite load. `../spawn-budget.mjs` states
    // the rule this walk enforces.
    const unwired = testFiles(srcRoot).filter((path) => {
      const text = readFileSync(path, "utf8");
      if (!text.includes("spawnSync(")) return false;
      return !(text.includes("SPAWN_BUDGET_MS") && text.includes("SPAWN_TEST_BUDGET_MS"));
    });
    expect(unwired).toEqual([]);
  });
});
