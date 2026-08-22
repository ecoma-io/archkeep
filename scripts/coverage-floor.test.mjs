// Drift pin for coverage.config.json (#235): the two vitest configs must be
// proven to CONSUME it, not merely sit beside it.
//
// Each config reads the floor's keys individually (`floor.lines`, …) rather
// than spreading, which is the right shape and the exact hazard: rename a key
// in the JSON and `floor.lines` reads `undefined`, vitest treats an undefined
// threshold as unset, and the coverage gate silently stops being a gate —
// red only if coverage happens to fall below 80 on its own, byte-for-byte
// green otherwise. Nothing verified the wiring before this file; the configs'
// own headers say why they read the keys they do, and this is what holds them
// to it, both directions: a JSON key no config consumes is a threshold
// someone deleted from the gate while believing they had moved it.
//
// Derivation, not restatement: the JSON is read, each config is both scanned
// for the keys its SOURCE names and imported for the thresholds VITEST would
// actually evaluate, and the two views must agree with the JSON. The `$comment`
// key is excluded by name — it is the file's own documentation, deliberately
// not a threshold, and that exclusion is stated here because it is the one
// place a dead key could hide.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const FLOOR_URL = new URL("../coverage.config.json", import.meta.url);
/** @type {Record<string, number|string>} */
const floor = JSON.parse(readFileSync(FLOOR_URL, "utf8"));

const CONFIGS = [
  "../packages/lattice/vitest.config.mjs",
  "../packages/lattice-vscode/vitest.config.mjs",
];

const floorKeys = Object.keys(floor)
  .filter((key) => key !== "$comment")
  .sort();
assert.ok(floorKeys.length > 0, "coverage.config.json declares no thresholds at all");

for (const configPath of CONFIGS) {
  test(`#235 — ${configPath} consumes exactly the keys coverage.config.json declares`, async () => {
    const url = new URL(configPath, import.meta.url);
    const source = readFileSync(url, "utf8");

    // What the source asks the floor for, deduplicated.
    const consumed = [...new Set([...source.matchAll(/\bfloor\.(\w+)/g)].map((m) => m[1]))].sort();

    assert.ok(
      consumed.length > 0,
      `${configPath} no longer reads coverage.config.json through a \`floor.<key>\` lookup — ` +
        `the thresholds have been cut loose from the shared floor`,
    );
    assert.deepEqual(
      consumed,
      floorKeys,
      `coverage.config.json and ${configPath} disagree over which keys exist. A key renamed or ` +
        `removed on either side yields undefined thresholds, and vitest silently treats an ` +
        `undefined threshold as unset — the floor stops existing without anything going red.`,
    );

    // And what vitest itself would evaluate: import the config for real, so a
    // lookup that resolves to undefined cannot pass the source scan above by
    // also renaming its reference.
    const config =
      /** @type {{default: {test: {coverage: {thresholds: Record<string, unknown>}}}}} */ (
        await import(pathToFileURL(url.pathname).href)
      );
    const evaluated = config.default?.test?.coverage?.thresholds;
    assert.ok(evaluated, `${configPath} exposes no test.coverage.thresholds to judge`);
    for (const key of floorKeys) {
      assert.equal(
        typeof evaluated[key],
        "number",
        `${configPath} evaluates thresholds.${key} as ${String(evaluated[key])} — vitest ignores ` +
          `an undefined threshold, so this floor key has silently stopped constraining coverage`,
      );
    }
  });
}
