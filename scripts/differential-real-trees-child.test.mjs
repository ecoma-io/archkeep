// Unit tests for the one pure helper the real-tree differential's child
// process exports: `silentUpstreamFailures`. Everything else in
// `differential-real-trees-child.mjs` needs a real cloned tree, the tree's own
// nx, and a real ESLint run — this is the part that does not, and the part
// bug #39 lived in.
//
// The case to read first is the SILENT-direction one: a file upstream could
// not read cleanly, and this engine independently had nothing to say about it
// either — the shape `noteCount`'s comment claimed was covered while nothing
// downstream ever read the count it landed in.
import assert from "node:assert/strict";
import { test } from "node:test";

import { silentUpstreamFailures } from "./differential-real-trees-child.mjs";

test("a note on a file neither engine produced a verdict for is silently hidden — this is the defect", () => {
  // Bug #39: before the fix, this file's parse-error note only ever fed
  // `noteCount`, which landed in `counts.upstreamNotes` and was never read
  // again — not printed by `reportTree`, not gated by any breach. The old
  // code had no `silentUpstreamFailures` at all, so this file's regression is
  // the function simply not existing to catch the case.
  const notesByFile = new Map([["libs/broken/src/index.ts", ["eslint: Parsing error: bad"]]]);
  const upstreamFiles = new Set(); // no boundary-rule message for this file
  const toolFiles = new Set(); // this engine reported nothing for it either

  const hidden = silentUpstreamFailures(notesByFile, upstreamFiles, toolFiles);

  assert.deepEqual(hidden, [
    { file: "libs/broken/src/index.ts", notes: ["eslint: Parsing error: bad"] },
  ]);
});

test("a note on a file upstream ALSO reported a boundary verdict for is not hidden", () => {
  // The file already reached the ordinary comparison loop through
  // `upstreamByFile`, so it is not part of the invisible set — any
  // disagreement there is a `differences` entry the ledger already sees.
  const notesByFile = new Map([["libs/mixed/src/index.ts", ["eslint: some other rule"]]]);
  const upstreamFiles = new Set(["libs/mixed/src/index.ts"]);
  const toolFiles = new Set();

  assert.deepEqual(silentUpstreamFailures(notesByFile, upstreamFiles, toolFiles), []);
});

test("a note on a file this engine ALSO reported a violation for is not hidden", () => {
  const notesByFile = new Map([["libs/mixed/src/index.ts", ["eslint: some other rule"]]]);
  const upstreamFiles = new Set();
  const toolFiles = new Set(["libs/mixed/src/index.ts"]);

  assert.deepEqual(silentUpstreamFailures(notesByFile, upstreamFiles, toolFiles), []);
});

test("no notes at all means nothing is hidden", () => {
  assert.deepEqual(silentUpstreamFailures(new Map(), new Set(), new Set()), []);
});

test("multiple silently-masked files are all named, not just the first", () => {
  const notesByFile = new Map([
    ["a.ts", ["eslint: parse error"]],
    ["b.ts", ["eslint: parse error"]],
  ]);
  const hidden = silentUpstreamFailures(notesByFile, new Set(), new Set());
  assert.deepEqual(
    hidden.map((entry) => entry.file),
    ["a.ts", "b.ts"],
  );
});
