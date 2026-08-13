// E2E scenarios for the `diff` command.
//
// `diff` takes a graph baseline FILE (not a git ref) and compares the
// current graph against it. It is descriptive — it never exits 1. It
// refuses incomplete baselines or incomplete head graphs (exit 3).
import { writeFileSync } from "node:fs";
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

describe("diff (smoke)", () => {
  it("exits 0 and reports no changes against a self-baseline", () => {
    // Capture a baseline from the clean tree.
    const baselineFile = join(nativeConsumer.root, "baseline-smoke.json");
    lattice(nativeConsumer.root, ["graph", "--format", "json", "--output", baselineFile]);
    const result = lattice(nativeConsumer.root, ["diff", baselineFile]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no changes");
  });
});

describe("diff (full)", () => {
  it("produces a valid JSON envelope for a self-baseline diff", () => {
    const baselineFile = join(nativeConsumer.root, "baseline-full.json");
    lattice(nativeConsumer.root, ["graph", "--format", "json", "--output", baselineFile]);
    const result = lattice(nativeConsumer.root, ["diff", baselineFile, "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.command).toBe("diff");
    expect(result.json.status).toBe("ok");
    expect(result.json.result.addedProjects).toEqual([]);
    expect(result.json.result.removedProjects).toEqual([]);
    expect(result.json.result.addedEdges).toEqual([]);
    expect(result.json.result.removedEdges).toEqual([]);
  });

  it("reports an added edge when a violation is introduced", () => {
    // Use a fresh consumer so the baseline is clean.
    const consumer = createNativeConsumer(artifact);
    try {
      const baselineFile = join(consumer.root, "baseline-pre-violation.json");
      lattice(consumer.root, ["graph", "--format", "json", "--output", baselineFile]);

      // Introduce the violation.
      commitFiles(consumer.root, CORE_REACHES_APP, "core reaches up into app");

      const result = lattice(consumer.root, ["diff", baselineFile, "--format", "json"]);
      expect(result.exitCode).toBe(0);
      expect(result.json.result.addedEdges.length).toBeGreaterThan(0);
      const added = result.json.result.addedEdges;
      const coreToApp = added.find((e) => e.source === "core" && e.target === "app");
      expect(coreToApp).toBeDefined();
    } finally {
      consumer.cleanup();
    }
  });

  it("reports a removed edge when an import is removed", () => {
    const consumer = createNativeConsumer(artifact);
    try {
      const baselineFile = join(consumer.root, "baseline-pre-remove.json");
      lattice(consumer.root, ["graph", "--format", "json", "--output", baselineFile]);

      // Remove the app→core import by replacing app.go with an empty file.
      commitFiles(consumer.root, { "libs/app/app.go": "package app\n" }, "remove import from app");

      const result = lattice(consumer.root, ["diff", baselineFile, "--format", "json"]);
      expect(result.exitCode).toBe(0);
      expect(result.json.result.removedEdges.length).toBeGreaterThan(0);
      const removed = result.json.result.removedEdges;
      const appToCore = removed.find((e) => e.source === "app" && e.target === "core");
      expect(appToCore).toBeDefined();
    } finally {
      consumer.cleanup();
    }
  });

  it("exits 3 when the baseline file cannot be parsed", () => {
    const badBaseline = join(nativeConsumer.root, "bad-baseline.json");
    writeFileSync(badBaseline, "not json at all", "utf8");
    const result = lattice(nativeConsumer.root, ["diff", badBaseline]);
    expect(result.exitCode).toBe(3);
  });

  it("exits 3 when the baseline has incomplete coverage", () => {
    // Build a baseline with `coverage.complete: false`.
    const incompleteBaseline = join(nativeConsumer.root, "incomplete-baseline.json");
    const fakeEnvelope = {
      schemaVersion: 1,
      command: "graph",
      status: "no-verdict",
      exitCode: 3,
      coverage: { complete: false, notAnalyzed: [{ file: "missing.go", reason: "parse error" }] },
      result: { projects: [], dependencies: [] },
    };
    writeFileSync(incompleteBaseline, JSON.stringify(fakeEnvelope), "utf8");
    const result = lattice(nativeConsumer.root, ["diff", incompleteBaseline]);
    expect(result.exitCode).toBe(3);
  });
});
