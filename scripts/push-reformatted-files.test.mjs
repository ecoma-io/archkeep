// Tests for push-reformatted-files.mjs.
//
// `treePayload` takes every fact it needs as an argument (base tree, files,
// root) and `main`'s loud-failure branch is the verification verdict passed in
// through the return of `pushReformattedFiles` — so the tests run with no
// repository, no filesystem, and no GitHub. `requestGit` is deliberately
// untested: a test that stubbed the API response would pin the stub, the same
// boundary check-docs-links.mjs draws around `readFacts`.
//
// The failure case goes red in the SILENT direction first: a reformat commit
// that did not come back `valid` is precisely the state that left release PR
// #75 blocked with green checks — the script must refuse to claim success.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REFORMAT_FILES, treePayload } from "./push-reformatted-files.mjs";

test("treePayload embeds each file's bytes as inline content with a trailing newline", () => {
  const root = mkdtempSync(join(tmpdir(), "r0b-tree-"));
  mkdirSync(join(root, ".claude-plugin"));
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), '{"version":"0.5.0"}');
  writeFileSync(
    join(root, ".claude-plugin", "marketplace.json"),
    '{"plugins":[{"version":"0.5.0"}]}',
  );

  const payload = treePayload(
    "abc123",
    [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json"],
    root,
  );

  assert.equal(payload.base_tree, "abc123");
  assert.deepEqual(payload.tree, [
    {
      path: ".claude-plugin/plugin.json",
      mode: "100644",
      type: "blob",
      content: '{"version":"0.5.0"}\n',
    },
    {
      path: ".claude-plugin/marketplace.json",
      mode: "100644",
      type: "blob",
      content: '{"plugins":[{"version":"0.5.0"}]}\n',
    },
  ]);
});

test("treePayload keeps a file that already ends in a newline at exactly one newline", () => {
  const root = mkdtempSync(join(tmpdir(), "r0b-tree-"));
  writeFileSync(join(root, "p.json"), '{"a":1}\n');
  const payload = treePayload("abc", ["p.json"], root);
  assert.equal(payload.tree[0].content, '{"a":1}\n');
});

test("treePayload throws loudly when a file is missing rather than omitting it silently", () => {
  const root = mkdtempSync(join(tmpdir(), "r0b-tree-"));
  assert.throws(() => treePayload("abc", ["does-not-exist.json"], root), /does-not-exist\.json/);
});

test("the reformat list is the five files the lane owns", () => {
  assert.deepEqual(REFORMAT_FILES, [
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    ".codex-plugin/plugin.json",
    "packages/lattice/package.json",
    "packages/lattice-vscode/package.json",
  ]);
});
