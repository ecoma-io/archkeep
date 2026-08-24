import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readSnapshots } from "./history.mjs";
import { SCHEMA_VERSION } from "../report/json.mjs";

// G-10, read side: the capture writer (`../commands/history.mjs`'s
// `writeSnapshotFile`) refuses a workspace-inside history directory whose
// intermediate components are symlinks, but the READER it pairs with used to
// `readdirSync` the same directory unguarded — a `.archkeep/history ->
// /tmp/outside` committed symlink hands outside snapshot bytes in as the
// workspace's own evolution, silently. `readSnapshots(dir, root)` now refuses
// the escape class loudly, the read-side half of the write guard.
describe("history read containment (G-10) — real filesystem", () => {
  let root;
  let outside;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "archkeep-history-read-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "archkeep-history-read-outside-")));
    mkdirSync(join(root, ".archkeep"), { recursive: true });
    mkdirSync(join(outside, "history"), { recursive: true });
    // A well-formed snapshot envelope, planted entirely outside the workspace.
    const envelope = {
      schemaVersion: SCHEMA_VERSION,
      command: "graph",
      workspace: {
        root: "/outside",
        provider: "native",
        marker: "archkeep.json",
        provenance: { commit: "abc", remote: "https://example.test/repo.git", dirty: false },
      },
      status: "ok",
      exitCode: 0,
      coverage: { complete: true, projects: 1, analyzedFiles: 2, imports: 1 },
      result: { projects: [], dependencies: [] },
    };
    writeFileSync(join(outside, "history", "0001-planted.json"), JSON.stringify(envelope));
    symlinkSync(join(outside, "history"), join(root, ".archkeep", "history"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses a history directory whose realpath leaves the workspace, loudly", () => {
    expect(() => readSnapshots(join(root, ".archkeep", "history"), root)).toThrow(
      /cannot read the history directory/,
    );
  });

  it("reads a history directory named outside the workspace when no root is given — caller's explicit choice", () => {
    const { files } = readSnapshots(join(outside, "history"));
    expect(files.map((f) => f.name)).toEqual(["0001-planted.json"]);
  });
});
