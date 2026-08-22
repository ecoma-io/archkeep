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
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readFileSync } from "node:fs";

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

// The naive entry guard this replaced —
// `process.argv[1] === fileURLToPath(import.meta.url)` — is false whenever
// the invoking path contains a symlink anywhere in it: Node resolves
// symlinks before recording a module's URL, but records `argv[1]` exactly
// as the caller spelled it. Measured directly: run through a symlinked
// checkout with the required env unset, the OLD code exits 0 with no output
// at all — `main()` never ran, so the release lane's reformat push silently
// no-opped while the step still read green. The fix must reach `main()`
// regardless of the symlink, and `main()` itself must then fail LOUDLY on
// the missing env rather than the guard silently skipping it.
test("invoked through a symlinked path, main() still runs and fails loudly on missing env", () => {
  const realScript = fileURLToPath(new URL("./push-reformatted-files.mjs", import.meta.url));
  const tmp = mkdtempSync(join(tmpdir(), "r0b-symlink-"));
  const link = join(tmp, "scripts-link");
  symlinkSync(dirname(realScript), link);
  const scriptViaSymlink = join(link, "push-reformatted-files.mjs");

  const env = { ...process.env };
  delete env.GITHUB_REPOSITORY;
  delete env.GH_TOKEN;

  const result = spawnSync(process.execPath, [scriptViaSymlink], { encoding: "utf8", env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GITHUB_REPOSITORY is required/u);
});

test("the reformat list is every file the lane repairs", () => {
  assert.deepEqual(REFORMAT_FILES, [
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    ".codex-plugin/plugin.json",
    "packages/lattice/package.json",
    "packages/lattice-vscode/package.json",
    "packages/lattice-rule-sdk-ts/package.json",
    "packages/lattice-rule-sdk-rust/Cargo.lock",
  ]);
});

test("the list carries every JSON extra-file release-please re-serializes", () => {
  // Derived from the release configuration rather than restated, because a
  // second copy of that roster agrees with the first only until someone adds
  // an SDK. A manifest release-please rewrites and Prettier never sees is a
  // release pull request that fails its own required format check — which is
  // exactly how `packages/lattice-rule-sdk-ts/package.json` sat unlisted from
  // the release that introduced it.
  const config = JSON.parse(
    readFileSync(new URL("../release-please-config.json", import.meta.url), "utf8"),
  );
  const jsonExtraFiles = config.packages["."]["extra-files"]
    .filter((f) => f.type === "json")
    .map((f) => f.path);
  for (const path of jsonExtraFiles) {
    assert.ok(
      REFORMAT_FILES.includes(path),
      `${path} is a JSON extra-file release-please rewrites, but the repair list omits it`,
    );
  }
});
