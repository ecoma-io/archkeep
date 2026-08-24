// E2E scenarios for native/Nx semantic parity.
//
// Both providers describe the same two-project architecture (core and app,
// Go, layer:core/layer:app). The parity tests assert that the observable
// semantics agree: project names, edge source/target/type, violation rule
// IDs and file paths, and JSON envelope structure.
//
// Does NOT compare provider-specific metadata or absolute workspace root
// paths — those are expected to differ.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { packArtifact } from "./helpers/artifact.mjs";
import { createNxConsumer, createNativeConsumer, commitFiles } from "./helpers/consumer.mjs";
import { archkeep } from "./helpers/run.mjs";
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

describe("parity", () => {
  it("graph JSON agrees on project names", () => {
    const nativeResult = archkeep(nativeConsumer.root, ["graph", "--format", "json"]);
    const nxResult = archkeep(nxConsumer.root, ["graph", "--format", "json"]);

    expect(nativeResult.exitCode).toBe(0);
    expect(nxResult.exitCode).toBe(0);

    const nativeNames = nativeResult.json.result.projects.map((p) => p.name).sort();
    const nxNames = nxResult.json.result.projects.map((p) => p.name).sort();
    expect(nativeNames).toEqual(nxNames);
  });

  it("graph JSON agrees on dependency edges (source, target, type)", () => {
    const nativeResult = archkeep(nativeConsumer.root, ["graph", "--format", "json"]);
    const nxResult = archkeep(nxConsumer.root, ["graph", "--format", "json"]);

    const nativeEdges = nativeResult.json.result.dependencies
      .map((e) => `${e.source}->${e.target}:${e.type}`)
      .sort();
    const nxEdges = nxResult.json.result.dependencies
      .map((e) => `${e.source}->${e.target}:${e.type}`)
      .sort();
    expect(nativeEdges).toEqual(nxEdges);
  });

  it("check agrees on violation rule ID and file when violating", () => {
    const nxViolator = createNxConsumer(artifact);
    const nativeViolator = createNativeConsumer(artifact);
    try {
      commitFiles(nativeViolator.root, CORE_REACHES_APP, "core reaches up into app");
      commitFiles(nxViolator.root, CORE_REACHES_APP, "core reaches up into app");

      const nativeResult = archkeep(nativeViolator.root, ["check", "--format", "json"]);
      const nxResult = archkeep(nxViolator.root, ["check", "--format", "json"]);

      expect(nativeResult.exitCode).toBe(1);
      expect(nxResult.exitCode).toBe(1);

      // Same violation rule IDs.
      const nativeIds = nativeResult.json.result.violations.map((v) => v.messageId).sort();
      const nxIds = nxResult.json.result.violations.map((v) => v.messageId).sort();
      expect(nativeIds).toEqual(nxIds);

      // Same violation file paths (relative paths, not absolute).
      const nativeFiles = nativeResult.json.result.violations.map((v) => v.sourceFile).sort();
      const nxFiles = nxResult.json.result.violations.map((v) => v.sourceFile).sort();
      expect(nativeFiles).toEqual(nxFiles);
    } finally {
      nativeViolator.cleanup();
      nxViolator.cleanup();
    }
  });

  it("check JSON envelope agrees on command, schemaVersion, status, exitCode", () => {
    const nativeResult = archkeep(nativeConsumer.root, ["check", "--format", "json"]);
    const nxResult = archkeep(nxConsumer.root, ["check", "--format", "json"]);

    expect(nativeResult.json.command).toEqual(nxResult.json.command);
    expect(nativeResult.json.schemaVersion).toEqual(nxResult.json.schemaVersion);
    expect(nativeResult.json.status).toEqual(nxResult.json.status);
    expect(nativeResult.json.exitCode).toEqual(nxResult.json.exitCode);
  });
});
