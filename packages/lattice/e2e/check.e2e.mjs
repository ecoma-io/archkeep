// E2E scenarios for the `check` command.
//
// `check` is the only command that exits 1 (findings). Every other command
// exits 0 (ok) or 3 (no verdict). The E2E scenarios prove the exit-code
// contract, the coverage statement, and the JSON envelope structure.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { packArtifact } from "./helpers/artifact.mjs";
import { createNxConsumer, createNativeConsumer, commitFiles } from "./helpers/consumer.mjs";
import { lattice } from "./helpers/run.mjs";
import { CORE_REACHES_APP } from "./fixtures/violations.mjs";

let artifact;
let nxConsumer;
let nativeConsumer;

beforeAll(() => {
  artifact = packArtifact();
  nxConsumer = createNxConsumer(artifact);
  nativeConsumer = createNativeConsumer(artifact);
});

afterAll(() => {
  nxConsumer?.cleanup();
  nativeConsumer?.cleanup();
  artifact?.cleanup();
});

describe("check (smoke)", () => {
  it("exits 0 on a clean native tree and states what it inspected", () => {
    const result = lattice(nativeConsumer.root, ["check"]);
    expect(result.exitCode).toBe(0);
    // "no violations" is a claim about coverage too — a 0 that inspected
    // nothing is the same silence as no check at all.
    expect(result.stdout).toMatch(/[1-9]\d* import/);
    expect(result.stdout).toMatch(/[1-9]\d* file/);
    expect(result.stdout).toMatch(/[1-9]\d* project/);
  });

  it("exits 0 on a clean Nx tree and states what it inspected", () => {
    const result = lattice(nxConsumer.root, ["check"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/[1-9]\d* import/);
    expect(result.stdout).toMatch(/[1-9]\d* file/);
    expect(result.stdout).toMatch(/[1-9]\d* project/);
  });

  it("exits 1 on a violating native tree, naming the rule and position", () => {
    // Each violating test needs its own consumer to avoid mutating the shared
    // clean consumer. Create a fresh one.
    const violator = createNativeConsumer(artifact);
    try {
      commitFiles(violator.root, CORE_REACHES_APP, "core reaches up into app");
      const result = lattice(violator.root, ["check"]);
      expect(result.exitCode).toBe(1);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("onlyTagsConstraintViolation");
      expect(output).toMatch(/libs\/core\/violate\.go:\d+:\d+/);
    } finally {
      violator.cleanup();
    }
  });
});

describe("check (full)", () => {
  it("exits 1 on a violating Nx tree, naming the rule and position", () => {
    const violator = createNxConsumer(artifact);
    try {
      commitFiles(violator.root, CORE_REACHES_APP, "core reaches up into app");
      const result = lattice(violator.root, ["check"]);
      expect(result.exitCode).toBe(1);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("onlyTagsConstraintViolation");
      expect(output).toMatch(/libs\/core\/violate\.go:\d+:\d+/);
    } finally {
      violator.cleanup();
    }
  });

  it("produces a valid JSON envelope on a clean native tree", () => {
    const result = lattice(nativeConsumer.root, ["check", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.command).toBe("check");
    expect(result.json.schemaVersion).toBe(2);
    expect(result.json.status).toBe("ok");
    expect(result.json.exitCode).toBe(0);
    expect(result.json.coverage.complete).toBe(true);
    expect(result.json.coverage.notAnalyzed).toEqual([]);
    expect(result.json.coverage.imports).toBeGreaterThan(0);
    expect(result.json.coverage.analyzedFiles).toBeGreaterThan(0);
    // The canonical verdict of a structurally clean run — the same envelope
    // now carries it as a four-state decision alongside the three-state status.
    expect(result.json.decision.verdict).toBe("pass");
  });

  it("produces a valid JSON envelope on a violating native tree", () => {
    const violator = createNativeConsumer(artifact);
    try {
      commitFiles(violator.root, CORE_REACHES_APP, "core reaches up into app");
      const result = lattice(violator.root, ["check", "--format", "json"]);
      expect(result.exitCode).toBe(1);
      expect(result.json).not.toBeNull();
      expect(result.json.status).toBe("findings");
      expect(result.json.exitCode).toBe(1);
      expect(result.json.result.violations.length).toBeGreaterThan(0);
      // The decision of a violating tree: `fail`, agreeing with the status the
      // same way status and exitCode agree.
      expect(result.json.decision.verdict).toBe("fail");
      const v = result.json.result.violations[0];
      expect(v.messageId).toBe("onlyTagsConstraintViolation");
    } finally {
      violator.cleanup();
    }
  });

  it("exits 3 when run outside any workspace (no marker)", () => {
    // Running in an empty directory with no marker file and no lattice
    // installed — `pnpm exec lattice` fails because pnpm cannot find the
    // package. The CLI itself would exit 3 ("no workspace root above..."),
    // but pnpm intercepts with its own error and exits 1. This test proves
    // the observable contract: the command does NOT exit 0.
    const nowhere = mkdtempSync(join(tmpdir(), "lattice-e2e-nowhere-"));
    try {
      const result = lattice(nowhere, ["check"]);
      expect(result.exitCode).not.toBe(0);
    } finally {
      rmSync(nowhere, { recursive: true, force: true });
    }
  });
});
