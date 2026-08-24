// E2E scenarios for the `graph` command.
//
// `graph` is a descriptive command — it never exits 1. It produces a
// deterministic snapshot of the project graph: sorted arrays of projects
// and edges, stripped of internal metadata.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { packArtifact } from "./helpers/artifact.mjs";
import { createNxConsumer, createNativeConsumer } from "./helpers/consumer.mjs";
import { archkeep } from "./helpers/run.mjs";

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

describe("graph", () => {
  it("exits 0 on a clean native tree and states project and edge counts", () => {
    const result = archkeep(nativeConsumer.root, ["graph"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/[1-9]\d* project/);
    expect(result.stdout).toMatch(/[1-9]\d* edge/);
  });

  it("produces a valid JSON envelope on a clean native tree", () => {
    const result = archkeep(nativeConsumer.root, ["graph", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.command).toBe("graph");
    expect(result.json.schemaVersion).toBe(2);
    expect(result.json.status).toBe("ok");
    expect(result.json.coverage.complete).toBe(true);
    expect(Array.isArray(result.json.result.projects)).toBe(true);
    expect(Array.isArray(result.json.result.dependencies)).toBe(true);
  });

  it("includes expected project names in the JSON output", () => {
    const result = archkeep(nativeConsumer.root, ["graph", "--format", "json"]);
    const names = result.json.result.projects.map((p) => p.name);
    expect(names).toContain("core");
    expect(names).toContain("app");
  });

  it("includes the expected dependency edge in the JSON output", () => {
    const result = archkeep(nativeConsumer.root, ["graph", "--format", "json"]);
    const edges = result.json.result.dependencies;
    const appToCore = edges.find((e) => e.source === "app" && e.target === "core");
    expect(appToCore).toBeDefined();
    expect(appToCore.type).toBe("static");
  });

  it("exits 0 on a clean Nx tree", () => {
    const result = archkeep(nxConsumer.root, ["graph"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/[1-9]\d* project/);
    expect(result.stdout).toMatch(/[1-9]\d* edge/);
  });

  it("writes JSON to an output file when --output is given", () => {
    const outputFile = join(nativeConsumer.root, "graph-snapshot.json");
    const result = archkeep(nativeConsumer.root, [
      "graph",
      "--format",
      "json",
      "--output",
      outputFile,
    ]);
    expect(result.exitCode).toBe(0);
    const written = readFileSync(outputFile, "utf8");
    const parsed = JSON.parse(written);
    expect(parsed.command).toBe("graph");
  });
});
