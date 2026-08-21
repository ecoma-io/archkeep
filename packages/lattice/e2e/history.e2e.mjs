// E2E scenarios for the `history` command.
//
// `history <dir>` reads a consumer-managed directory of graph snapshots and
// describes how the architecture evolved across them. `--capture` appends a
// snapshot of the current workspace first, deduplicating when the architecture
// identity already matches the last snapshot. It is descriptive — it never
// exits 1. An empty or unreadable history directory is a no-verdict run
// (exit 3), never a record of nothing.
//
// The history directory lives OUTSIDE the consumer's git tree (a sibling
// tempdir), because snapshots are never meant to be committed — the commit
// the snapshot records is the workspace's, and a snapshot that is itself
// tracked would be captured under one commit and committed under the next.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { packArtifact } from "./helpers/artifact.mjs";
import { createNativeConsumer, commitFiles } from "./helpers/consumer.mjs";
import { lattice } from "./helpers/run.mjs";
import { CORE_REACHES_APP } from "./fixtures/violations.mjs";

let artifact;
let nativeConsumer;

beforeAll(() => {
  artifact = packArtifact();
  nativeConsumer = createNativeConsumer(artifact);
});

afterAll(() => {
  nativeConsumer?.cleanup();
  artifact?.cleanup();
});

/** A fresh, empty history directory the workspace's git tree never sees. */
function freshHistoryDir() {
  return mkdtempSync(join(tmpdir(), "lattice-e2e-history-"));
}

/** The snapshot files in a history directory, ignoring stray `.tmp` files. */
function listSnapshots(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".json.tmp"))
    .sort();
}

/** Reads a snapshot file and parses it as a graph envelope. */
function readSnapshot(dir, name) {
  return JSON.parse(readFileSync(join(dir, name), "utf8"));
}

describe("history capture determinism (E-F05)", () => {
  it("capturing twice into the SAME dir differs only in the duplicate marker", () => {
    const dir = freshHistoryDir();
    try {
      const first = lattice(nativeConsumer.root, ["history", dir, "--capture", "--format", "json"]);
      expect(first.exitCode).toBe(0);
      expect(first.json).not.toBeNull();
      const second = lattice(nativeConsumer.root, [
        "history",
        dir,
        "--capture",
        "--format",
        "json",
      ]);
      expect(second.exitCode).toBe(0);
      expect(second.json).not.toBeNull();

      // The envelope's shape must NOT be a function of history-dir state: the
      // two envelopes differ in exactly the `result.captured.duplicate`
      // boolean (false for the fresh write, true for the dedup), never in
      // which keys exist.
      const one = JSON.parse(JSON.stringify(first.json));
      const two = JSON.parse(JSON.stringify(second.json));
      expect(one.result.captured.duplicate).toBe(false);
      expect(two.result.captured.duplicate).toBe(true);
      delete one.result.captured.duplicate;
      delete two.result.captured.duplicate;
      expect(JSON.stringify(one)).toBe(JSON.stringify(two));
      expect(listSnapshots(dir)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("capturing once into two EMPTY dirs is byte-identical", () => {
    const dirA = freshHistoryDir();
    const dirB = freshHistoryDir();
    try {
      const a = lattice(nativeConsumer.root, ["history", dirA, "--capture", "--format", "json"]);
      const b = lattice(nativeConsumer.root, ["history", dirB, "--capture", "--format", "json"]);
      expect(a.exitCode).toBe(0);
      expect(b.exitCode).toBe(0);
      // The snapshot files written INTO the two dirs are plain graph
      // envelopes — they never reference the history dir — so they must be
      // byte-identical across the two fresh captures: the bytes are a
      // function of the tree, not of which capture number or which dir.
      const aName = listSnapshots(dirA)[0];
      const bName = listSnapshots(dirB)[0];
      expect(readFileSync(join(dirA, aName), "utf8")).toBe(readFileSync(join(dirB, bName), "utf8"));
      // The captured filename is the identity-derived `<seq>-<sha8>.json` —
      // identical for an identical tree.
      expect(aName).toBe(bName);
      // The stdout envelopes differ only in `result.dir` (the two temp dirs
      // are at different absolute paths); every other byte must match.
      const ja = JSON.parse(a.stdout);
      const jb = JSON.parse(b.stdout);
      delete ja.result.dir;
      delete jb.result.dir;
      expect(JSON.stringify(ja)).toBe(JSON.stringify(jb));
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});

describe("history (empty and capture)", () => {
  it("exits 3 when the directory holds no snapshots — never a record of nothing", () => {
    // The silent-direction case for `history`: an empty directory must be a
    // loud no-verdict (exit 3), never an empty record that reads as "no
    // history" — the same empty-result invariant the rest of the suite holds.
    const dir = freshHistoryDir();
    try {
      const result = lattice(nativeConsumer.root, ["history", dir]);
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("contains no snapshots");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("captures a snapshot into an empty directory", () => {
    const dir = freshHistoryDir();
    try {
      const result = lattice(nativeConsumer.root, ["history", dir, "--capture"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("capture");
      expect(result.stdout).toContain("written");
      expect(listSnapshots(dir)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("captures a snapshot, then deduplicates when nothing changed", () => {
    const dir = freshHistoryDir();
    try {
      const first = lattice(nativeConsumer.root, ["history", dir, "--capture"]);
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain("capture");
      expect(first.stdout).toContain("written");
      const snapshots = listSnapshots(dir);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatch(/^0001-[0-9a-f]{8}\.json$/);

      // The captured file is a valid, complete graph envelope.
      const envelope = readSnapshot(dir, snapshots[0]);
      expect(envelope.command).toBe("graph");
      expect(envelope.status).toBe("ok");
      expect(envelope.coverage.complete).toBe(true);
      expect(envelope.result.projects).toBeDefined();
      expect(envelope.result.dependencies).toBeDefined();
      expect(envelope.workspace.provenance.commit).toBeTruthy();

      // An unchanged workspace deduplicates: no new file, no manufactured
      // transition.
      const second = lattice(nativeConsumer.root, ["history", dir, "--capture"]);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("already the last snapshot");
      expect(listSnapshots(dir)).toEqual(snapshots);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("describes a captured history as JSON with the versioned envelope", () => {
    const dir = freshHistoryDir();
    try {
      lattice(nativeConsumer.root, ["history", dir, "--capture"]);
      const result = lattice(nativeConsumer.root, ["history", dir, "--format", "json"]);
      expect(result.exitCode).toBe(0);
      expect(result.json).not.toBeNull();
      expect(result.json.command).toBe("history");
      expect(result.json.status).toBe("ok");
      expect(result.json.result.dir).toBe(dir);
      expect(result.json.result.snapshots).toHaveLength(1);
      expect(result.json.result.transitions).toEqual([]);
      expect(result.json.result.captured).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("history (evolution)", () => {
  it("records an architectural change as a transition between snapshots", () => {
    const consumer = createNativeConsumer(artifact);
    const dir = freshHistoryDir();
    try {
      lattice(consumer.root, ["history", dir, "--capture"]);

      // Introduce a real architectural change: core starts reaching into app.
      commitFiles(consumer.root, CORE_REACHES_APP, "core reaches up into app");

      const result = lattice(consumer.root, ["history", dir, "--capture"]);
      expect(result.exitCode).toBe(0);
      expect(listSnapshots(dir)).toHaveLength(2);
      expect(result.stdout).toContain("(architecture)");
      expect(result.stdout).toContain("1 transition recorded an architectural change");

      // The full record, as JSON, carries the classified transition.
      const describe = lattice(consumer.root, ["history", dir, "--format", "json"]);
      expect(describe.exitCode).toBe(0);
      expect(describe.json).not.toBeNull();
      expect(describe.json.result.snapshots).toHaveLength(2);
      expect(describe.json.result.transitions).toHaveLength(1);
      expect(describe.json.result.transitions[0].architectureChanged).toBe(true);
      expect(describe.json.result.transitions[0].changes.addedEdges.length).toBeGreaterThan(0);
      const coreToApp = describe.json.result.transitions[0].changes.addedEdges.find(
        (e) => e.source === "core" && e.target === "app",
      );
      expect(coreToApp).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      consumer.cleanup();
    }
  });
});
