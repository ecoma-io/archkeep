// E2E scenarios for deterministic output.
//
// Archkeep uses plain string comparison for sorting (never `localeCompare`),
// so two runs over an unchanged tree must produce byte-identical JSON.
// These scenarios prove that contract: run the same command twice, compare
// the raw stdout character-by-character.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { packArtifact } from "./helpers/artifact.mjs";
import {
  createNativeConsumer,
  createNativeMonorepoConsumer,
  commitFiles,
} from "./helpers/consumer.mjs";
import { archkeep } from "./helpers/run.mjs";
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

describe("determinism", () => {
  it("graph --format json produces identical output on two runs", () => {
    const first = archkeep(nativeConsumer.root, ["graph", "--format", "json"]);
    const second = archkeep(nativeConsumer.root, ["graph", "--format", "json"]);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(first.stdout).toBe(second.stdout);
  });

  it("check --format json produces identical violation ordering on two runs", () => {
    const violator = createNativeConsumer(artifact);
    try {
      commitFiles(violator.root, CORE_REACHES_APP, "core reaches up into app");
      const first = archkeep(violator.root, ["check", "--format", "json"]);
      const second = archkeep(violator.root, ["check", "--format", "json"]);
      expect(first.exitCode).toBe(1);
      expect(second.exitCode).toBe(1);
      expect(first.stdout).toBe(second.stdout);
    } finally {
      violator.cleanup();
    }
  });

  it("impact --format json produces identical output on two runs", () => {
    const monorepo = createNativeMonorepoConsumer(artifact);
    try {
      const first = archkeep(monorepo.root, ["impact", "core", "--format", "json"]);
      const second = archkeep(monorepo.root, ["impact", "core", "--format", "json"]);
      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      expect(first.stdout).toBe(second.stdout);
    } finally {
      monorepo.cleanup();
    }
  });
});
