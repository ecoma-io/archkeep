import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SPAWN_BUDGET_MS, SPAWN_TEST_BUDGET_MS } from "../spawn-budget.mjs";

const srcRoot = fileURLToPath(new URL(".", import.meta.url));
const selfPath = fileURLToPath(import.meta.url);

/** Every `*.test.mjs` under `src/`, wherever it nests. */
function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.name.endsWith(".test.mjs") ? [path] : [];
  });
}

// Matches `SPAWN_TEST_BUDGET_MS` actually being handed to vitest as a
// timeout, in every shape this package's spawning test files use it: a
// module-scope `vi.setConfig({ testTimeout: … })` (or `hookTimeout`, for a
// file whose only spawn sits inside a hook), a `{ timeout: … }` options
// object on `describe`/`it`/`beforeAll`/`beforeEach`, or a bare trailing
// timeout argument on a hook call. None of these three shapes can be
// satisfied by the `import { …, SPAWN_TEST_BUDGET_MS } from "../spawn-budget.mjs"`
// line alone — that line pairs the identifier with `SPAWN_BUDGET_MS` and a
// `}`, never with `timeout:`/`vi.setConfig(`/a trailing `)`.
const APPLIES_SPAWN_TEST_BUDGET = new RegExp(
  [
    String.raw`vi\s*\.\s*setConfig\(\s*\{[^}]*\b(?:testTimeout|hookTimeout)\s*:\s*SPAWN_TEST_BUDGET_MS`,
    String.raw`\btimeout\s*:\s*SPAWN_TEST_BUDGET_MS\b`,
    String.raw`,\s*SPAWN_TEST_BUDGET_MS\s*\)`,
  ].join("|"),
);

/**
 * True when a file calls `spawnSync` but never actually applies the shared
 * per-test ceiling — the gap #249's fix mostly missed. Measured: this file's
 * old check was `text.includes("SPAWN_BUDGET_MS") && text.includes("SPAWN_TEST_BUDGET_MS")`,
 * which a bare `import` line alone satisfies, so `cli.integration.test.mjs`
 * carried 45 `describe` blocks and only 5 of them actually raised the
 * ceiling — 40 ran at vitest's untouched 5000 ms default while this check
 * stayed green. Split out so it can be driven with synthetic text
 * (`../../AGENTS.md`: a function that reads a file and decides something
 * must be split before it is testable, and the split is the improvement).
 *
 * @param {string} text
 * @returns {boolean}
 */
export function spawnsWithoutBudget(text) {
  if (!text.includes("spawnSync(")) return false;
  return !APPLIES_SPAWN_TEST_BUDGET.test(text);
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
    // file that starts spawning without APPLYING the budgets fails here
    // instead of flaking under full-suite load. `../spawn-budget.mjs` states
    // the rule this walk enforces; `spawnsWithoutBudget` above states what
    // "applies" means, and it is not satisfied by an import line. This file
    // is excluded from its own walk: it names the probe string
    // `spawnsWithoutBudget` looks for in its own source and in the fixtures
    // below, which would otherwise make it fail its own check — it spawns no
    // process itself and is not one of the files this gate is judging.
    const unwired = testFiles(srcRoot)
      .filter((path) => path !== selfPath)
      .filter((path) => spawnsWithoutBudget(readFileSync(path, "utf8")));
    expect(unwired).toEqual([]);
  });

  it("catches a file that imports the budget but never applies it (the #249 gap this gate missed)", () => {
    // Reduced to a fixture: exactly the shape `cli.integration.test.mjs` was
    // in before it wired a module-scope `vi.setConfig` — the constant
    // imported and even used for the single-spawn budget, but never handed to
    // vitest as the per-test ceiling. The old substring check
    // (`text.includes("SPAWN_BUDGET_MS") && text.includes("SPAWN_TEST_BUDGET_MS")`)
    // passes this text, because both identifiers appear on the import line;
    // that is the false green this predicate exists to close.
    //
    // Built by concatenation, never as a literal `spawnSync(` substring:
    // written literally, this fixture would make THIS file itself match
    // `spawnsWithoutBudget`'s own `spawnSync(` probe, which is exactly the
    // false-positive this comment is warning the next editor away from.
    const spawnCall = ["spawn", "Sync("].join("");
    const unappliedImportOnly = [
      'import { SPAWN_BUDGET_MS, SPAWN_TEST_BUDGET_MS } from "../spawn-budget.mjs";',
      "",
      'describe("something that spawns", () => {',
      '  it("spawns", () => {',
      `    ${spawnCall}"git", ["status"], { timeout: SPAWN_BUDGET_MS });`,
      "  });",
      "});",
    ].join("\n");

    expect(spawnsWithoutBudget(unappliedImportOnly)).toBe(true);
  });

  it("does not flag a file that spawns but never mentions the test budget at all", () => {
    // Sanity check on the other side of the branch: a file with no
    // `spawnSync` call is out of scope for this gate regardless of what it
    // imports.
    const noSpawn = 'import { SPAWN_TEST_BUDGET_MS } from "../spawn-budget.mjs";\n';
    expect(spawnsWithoutBudget(noSpawn)).toBe(false);
  });
});
