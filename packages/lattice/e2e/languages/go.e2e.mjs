// E2E scenarios for the Go language fixture.
//
// Proves that Lattice discovers Go imports, builds the correct graph,
// enforces architecture boundaries, and produces valid structured output —
// all through the real installed CLI against the packed artifact.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { packArtifact } from "../helpers/artifact.mjs";
import { createNativeLanguageConsumer, commitFiles } from "../helpers/consumer.mjs";
import { lattice } from "../helpers/run.mjs";
import { GO_VIOLATION } from "../fixtures/languages/violations.mjs";

let artifact;
let consumer;

beforeAll(() => {
  artifact = packArtifact();
  consumer = createNativeLanguageConsumer(artifact, "go");
});

afterAll(() => {
  consumer?.cleanup();
  artifact?.cleanup();
});

describe("Go language E2E", () => {
  it("Go dependency imports are discovered in the graph", () => {
    const result = lattice(consumer.root, ["graph", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();

    const names = result.json.result.projects.map((p) => p.name).sort();
    expect(names).toEqual(["api", "application", "domain"]);

    const edges = result.json.result.dependencies;
    const appToDomain = edges.find((e) => e.source === "application" && e.target === "domain");
    expect(appToDomain).toBeDefined();
    expect(appToDomain.type).toBe("static");

    const apiToApp = edges.find((e) => e.source === "api" && e.target === "application");
    expect(apiToApp).toBeDefined();
    expect(apiToApp.type).toBe("static");
  });

  it("Go valid architecture passes check", () => {
    const result = lattice(consumer.root, ["check"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/[1-9]\d* import/);
    expect(result.stdout).toMatch(/[1-9]\d* file/);
    expect(result.stdout).toMatch(/[1-9]\d* project/);
  });

  it("Go architecture violation is enforced", () => {
    const violator = createNativeLanguageConsumer(artifact, "go");
    try {
      commitFiles(violator.root, GO_VIOLATION, "domain reaches up into application");
      const result = lattice(violator.root, ["check"]);
      expect(result.exitCode).toBe(1);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("onlyTagsConstraintViolation");
      expect(output).toMatch(/libs\/domain\/violate\.go:\d+:\d+/);
    } finally {
      violator.cleanup();
    }
  });

  it("Go check produces a valid JSON envelope on a clean tree", () => {
    const result = lattice(consumer.root, ["check", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.command).toBe("check");
    expect(result.json.schemaVersion).toBe(2);
    expect(result.json.status).toBe("ok");
    expect(result.json.exitCode).toBe(0);
    expect(result.json.coverage.complete).toBe(true);
    expect(result.json.coverage.imports).toBeGreaterThan(0);
  });

  it("Go graph JSON includes expected projects and edges", () => {
    const result = lattice(consumer.root, ["graph", "--format", "json"]);
    expect(result.json.result.projects.length).toBe(3);
    // Two valid edges: application→domain, api→application.
    expect(result.json.result.dependencies.length).toBe(2);
  });

  it("Go output is deterministic across two runs", () => {
    const first = lattice(consumer.root, ["graph", "--format", "json"]);
    const second = lattice(consumer.root, ["graph", "--format", "json"]);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(first.stdout).toBe(second.stdout);
  });
});
