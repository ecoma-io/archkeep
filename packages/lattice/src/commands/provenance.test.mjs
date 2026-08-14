/**
 * Tests for optional repository provenance resolution.
 *
 * Provenance is `null` when git is unavailable — the envelope carries no origin
 * claim it cannot verify. When git IS available (the normal CLI path), the
 * commit, remote, and dirty state are captured.
 *
 * These tests run against the real git repository this package lives in, because
 * `resolveProvenance` is a thin wrapper over `git` commands and the meaningful
 * test is whether it correctly reads what git reports. A mocked git would prove
 * the mock, not the code.
 */
import { describe, it, expect } from "vitest";
import { resolveProvenance } from "./provenance.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("resolveProvenance", () => {
  it("returns an object with commit, remote, and dirty when git is available", () => {
    // This test runs inside the real repo, so git is available.
    const provenance = resolveProvenance(process.cwd());
    expect(provenance).not.toBeNull();
    expect(typeof provenance.commit).toBe("string");
    expect(provenance.commit.length).toBe(40); // SHA-1 hex
    // remote may be null (no remotes) or a URL string.
    if (provenance.remote !== null) {
      expect(typeof provenance.remote).toBe("string");
      expect(provenance.remote.length).toBeGreaterThan(0);
    }
    expect(typeof provenance.dirty).toBe("boolean");
  });

  it("returns null when the directory is not a git repository", () => {
    // Create a temp directory with no .git — resolveProvenance must return null.
    const tmp = mkdtempSync(join(tmpdir(), "lattice-provenance-test-"));
    try {
      const provenance = resolveProvenance(tmp);
      expect(provenance).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports dirty=true when working tree has changes", () => {
    // This test is probabilistic (the working tree may or may not be dirty), so
    // verify the field exists and matches what git status actually reports.
    const provenance = resolveProvenance(process.cwd());
    expect(provenance).not.toBeNull();
    const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf-8" }).trim();
    const expectedDirty = status.length > 0;
    expect(provenance.dirty).toBe(expectedDirty);
  });

  it("reports commit matching git rev-parse HEAD", () => {
    const provenance = resolveProvenance(process.cwd());
    expect(provenance).not.toBeNull();
    const expected = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    expect(provenance.commit).toBe(expected);
  });

  it("reports remote matching the first remote URL", () => {
    const provenance = resolveProvenance(process.cwd());
    expect(provenance).not.toBeNull();
    let expectedRemote = null;
    try {
      const remotes = execFileSync("git", ["remote"], { encoding: "utf-8" }).trim();
      if (remotes) {
        const firstRemote = remotes.split("\n")[0].trim();
        expectedRemote = execFileSync("git", ["remote", "get-url", firstRemote], {
          encoding: "utf-8",
        }).trim();
      }
    } catch {
      // no remotes
    }
    expect(provenance.remote).toBe(expectedRemote);
  });
});
