// Tests for codex-post-tool-use.mjs.
//
// `parseTouchedFiles` is the pure half of the Codex hook — it reads the file
// names out of an apply_patch command text — so it is the half worth pinning.
// The rest of the adapter spawns the shared editor-hook scripts with that
// list; a test that stubbed those spawns would only pin the stub, and the
// real thing is exercised by a Codex session. Each case below goes red in the
// SILENT direction: an unparsed file name means the gates never run on that
// file, which is exactly the quiet gap the hook exists to close.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseTouchedFiles } from "./codex-post-tool-use.mjs";

test("parses Update, Add, and Delete File markers", () => {
  const command = `*** Begin Patch ***
*** Update File: docs/usage/ci.md ***
@@ -1,1 +1,2 @@
- old
+ new
*** Add File: packages/lattice/src/editor-gates.js ***
@@ -0,0 +1,1 @@
+ new file
*** Delete File: docs/usage/policy-file.md ***
@@ -1,1 +0,0 @@
- gone
*** End Patch ***
`;
  assert.deepEqual(parseTouchedFiles(command), [
    "docs/usage/ci.md",
    "packages/lattice/src/editor-gates.js",
    "docs/usage/policy-file.md",
  ]);
});

test("returns an empty list for a command with no File markers — nothing to gate", () => {
  assert.deepEqual(parseTouchedFiles("*** Begin Patch ***\n*** End Patch ***\n"), []);
});

test("trims surrounding whitespace off a marker path", () => {
  const command = "*** Update File:   docs/usage/ci.md   ***\n";
  assert.deepEqual(parseTouchedFiles(command), ["docs/usage/ci.md"]);
});

test("keeps every marker, not just the first", () => {
  const command = `*** Update File: a.md ***
*** Update File: b.md ***
*** Update File: c.md ***
`;
  assert.deepEqual(parseTouchedFiles(command), ["a.md", "b.md", "c.md"]);
});

test("ignores marker-like lines that are not at the start of the line", () => {
  const command = "some context *** Update File: not-a-file.md ***\n";
  assert.deepEqual(parseTouchedFiles(command), []);
});
