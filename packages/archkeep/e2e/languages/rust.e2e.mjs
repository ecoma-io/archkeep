// E2E scenarios for the Rust language fixture.
//
// Proves that Archkeep discovers Rust `use` paths, resolves crate
// identifiers (package names normalised to underscores), reads Cargo
// manifest `path` dependencies, builds the correct graph, and enforces
// architecture boundaries. No Cargo build required.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { packArtifact } from "../helpers/artifact.mjs";
import { createNativeLanguageConsumer, commitFiles } from "../helpers/consumer.mjs";
import { archkeep } from "../helpers/run.mjs";
import { RUST_VIOLATION } from "../fixtures/languages/violations.mjs";

let artifact;
let consumer;

beforeAll(() => {
  artifact = packArtifact();
  consumer = createNativeLanguageConsumer(artifact, "rust");
});

afterAll(() => {
  consumer?.cleanup();
  artifact?.cleanup();
});

describe("Rust language E2E", () => {
  it("Rust module dependencies are discovered in the graph", () => {
    const result = archkeep(consumer.root, ["graph", "--format", "json"]);
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

  it("Rust valid architecture passes check", () => {
    const result = archkeep(consumer.root, ["check"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/[1-9]\d* import/);
    expect(result.stdout).toMatch(/[1-9]\d* file/);
    expect(result.stdout).toMatch(/[1-9]\d* project/);
  });

  it("Rust architecture violation is enforced", () => {
    const violator = createNativeLanguageConsumer(artifact, "rust");
    try {
      commitFiles(violator.root, RUST_VIOLATION, "domain reaches up into application");
      const result = archkeep(violator.root, ["check"]);
      expect(result.exitCode).toBe(1);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("onlyTagsConstraintViolation");
      expect(output).toMatch(/libs\/domain\/src\/violate\.rs:\d+:\d+/);
    } finally {
      violator.cleanup();
    }
  });

  it("Rust check produces a valid JSON envelope on a clean tree", () => {
    const result = archkeep(consumer.root, ["check", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.command).toBe("check");
    expect(result.json.schemaVersion).toBe(2);
    expect(result.json.status).toBe("ok");
    expect(result.json.coverage.complete).toBe(true);
    expect(result.json.coverage.imports).toBeGreaterThan(0);
  });

  it("Rust graph JSON includes expected projects and edges", () => {
    const result = archkeep(consumer.root, ["graph", "--format", "json"]);
    expect(result.json.result.projects.length).toBe(3);
    // Two edges: application→domain, api→application.
    expect(result.json.result.dependencies.length).toBeGreaterThanOrEqual(2);
  });

  it("Rust output is deterministic across two runs", () => {
    const first = archkeep(consumer.root, ["graph", "--format", "json"]);
    const second = archkeep(consumer.root, ["graph", "--format", "json"]);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(first.stdout).toBe(second.stdout);
  });
});
