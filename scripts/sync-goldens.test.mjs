// Pure-function tests for `sync-goldens.mjs` — the version chain-link that
// keeps the golden-output corpus in step with `packages/archkeep/package.json`
// (see that file's header for the full case). Following the repository's rule
// that gate scripts take their facts as arguments, every decision here is
// tested against TEXT, never a filesystem; `main()` in the sync script is the
// only part that touches one, exactly like `sync-cargo-lock.mjs`.
import assert from "node:assert/strict";
import { test } from "node:test";

import { replaceVersion, syncGoldenVersion } from "./sync-goldens.mjs";
import { goldenToolVersion } from "./check-skills.mjs";

test("goldenToolVersion reads the engine version out of a JSON envelope", () => {
  const text = '{\n  "tool": {\n    "name": "@ecoma-io/archkeep",\n    "version": "0.25.0"\n  }\n}';
  assert.equal(goldenToolVersion(text), "0.25.0");
});

test("goldenToolVersion returns null for a file with no tool block", () => {
  assert.equal(goldenToolVersion("hello"), null);
  assert.equal(goldenToolVersion('{"tool": {"name": "@ecoma-io/archkeep"}}'), null);
});

test("replaceVersion leaves text alone when the old version is absent", () => {
  const { text, changed } = replaceVersion('{"version": "2.1.0"}', "1.2.3", "4.5.6");
  assert.equal(changed, false);
  assert.equal(text, '{"version": "2.1.0"}');
});

test("replaceVersion swaps every occurrence of the recorded version", () => {
  const input =
    '"tool": {"version": "0.25.0"}, "baseline": {"tool": {"version": "0.25.0"}, "toolVersion": "0.25.0"}';
  const { text, changed } = replaceVersion(input, "0.25.0", "0.26.0");
  assert.equal(changed, true);
  assert.equal(text.includes("0.26.0"), true);
  assert.equal(text.includes("0.25.0"), false);
});

test("syncGoldenVersion leaves an in-step golden untouched", () => {
  const text = '{\n  "tool": {"name": "@ecoma-io/archkeep", "version": "0.25.0"}\n}';
  const outcome = syncGoldenVersion(text, "0.25.0");
  assert.equal(outcome.refused, false);
  assert.deepEqual(outcome.result, { text, changed: false });
});

test("syncGoldenVersion rewrites a stale golden to the manifest version", () => {
  // A release-please branch bumps the manifest and the goldens lag behind —
  // the recorded slot holds the OLD version and the sync rewrites it. This is
  // the normal repair case, NOT a refusal.
  const text = '{"tool": {"name": "@ecoma-io/archkeep", "version": "0.25.0"}}';
  const { result, refused } = syncGoldenVersion(text, "0.26.0");
  assert.equal(refused, false);
  assert.equal(result.changed, true);
  assert.equal(result.text.includes("0.26.0"), true);
  assert.equal(result.text.includes("0.25.0"), false);
});

test("syncGoldenVersion refuses a JSON envelope with no tool version slot", () => {
  // A `.json` golden is an envelope and MUST carry the slot: a missing slot is
  // a golden that stopped embedding the version, which is the silent direction.
  const text = '{"tool": {"name": "@ecoma-io/archkeep"}}';
  const outcome = syncGoldenVersion(text, "0.26.0");
  assert.equal(outcome.refused, true);
  assert.equal(outcome.result, null);
});

test("syncGoldenVersion returns null (no slot) for non-JSON text", () => {
  const outcome = syncGoldenVersion("help text — no envelope here", "0.26.0");
  assert.equal(outcome.refused, false);
  assert.equal(outcome.result, null);
});

test("syncGoldenVersion rewrites the diff-family secondary slots too", () => {
  // `diff`/`delta`/`change` embed the version a second time (baseline
  // toolVersion). A real scan runs on the whole committed golden, so the
  // rewrite covers the secondary occurrence in one pass.
  const text =
    '{"tool": {"name": "@ecoma-io/archkeep", "version": "0.25.0"}, "result": {"baseline": {"toolVersion": "0.25.0"}}}';
  const { result, refused } = syncGoldenVersion(text, "0.26.0");
  assert.equal(refused, false);
  assert.equal(result.changed, true);
  assert.equal(result.text.match(/0\.26\.0/g).length, 2);
  assert.equal(result.text.includes("0.25.0"), false);
});
