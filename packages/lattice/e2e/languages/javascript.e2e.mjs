// E2E scenarios for the JavaScript language fixture.
//
// Proves that Lattice discovers JavaScript imports (ESM `import` and CJS
// `require()`), resolves through pnpm's symlinked node_modules (no
// tsconfig.json), builds the correct graph, and enforces architecture
// boundaries. This catches regressions where TypeScript parsing works but
// JavaScript parsing breaks.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { packArtifact } from "../helpers/artifact.mjs";
import { createNativeLanguageConsumer, commitFiles } from "../helpers/consumer.mjs";
import { lattice } from "../helpers/run.mjs";
import { JAVASCRIPT_VIOLATION } from "../fixtures/languages/violations.mjs";

let artifact;
let consumer;

beforeAll(() => {
  artifact = packArtifact();
  consumer = createNativeLanguageConsumer(artifact, "javascript");
});

afterAll(() => {
  consumer?.cleanup();
  artifact?.cleanup();
});

describe("JavaScript language E2E (smoke)", () => {
  it("JavaScript ESM dependencies are discovered in the graph", () => {
    const result = lattice(consumer.root, ["graph", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();

    const names = result.json.result.projects.map((p) => p.name).sort();
    expect(names).toEqual(["api", "application", "domain"]);

    const edges = result.json.result.dependencies;
    // application→domain and api→application must both appear.
    const appToDomain = edges.find((e) => e.source === "application" && e.target === "domain");
    expect(appToDomain).toBeDefined();
    const apiToApp = edges.find((e) => e.source === "api" && e.target === "application");
    expect(apiToApp).toBeDefined();
  });

  it("JavaScript valid architecture passes check", () => {
    const result = lattice(consumer.root, ["check"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/[1-9]\d* import/);
    expect(result.stdout).toMatch(/[1-9]\d* file/);
    expect(result.stdout).toMatch(/[1-9]\d* project/);
  });
});

describe("JavaScript language E2E (full)", () => {
  it("JavaScript architecture violation is enforced", () => {
    const violator = createNativeLanguageConsumer(artifact, "javascript");
    try {
      commitFiles(violator.root, JAVASCRIPT_VIOLATION, "domain reaches up into application");
      const result = lattice(violator.root, ["check"]);
      expect(result.exitCode).toBe(1);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("onlyTagsConstraintViolation");
      expect(output).toMatch(/libs\/domain\/violate\.mjs:\d+:\d+/);
    } finally {
      violator.cleanup();
    }
  });

  it("JavaScript check produces a valid JSON envelope on a clean tree", () => {
    const result = lattice(consumer.root, ["check", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.command).toBe("check");
    expect(result.json.schemaVersion).toBe(2);
    expect(result.json.status).toBe("ok");
    expect(result.json.coverage.complete).toBe(true);
    expect(result.json.coverage.imports).toBeGreaterThan(0);
  });

  it("JavaScript graph JSON includes expected projects and edges", () => {
    const result = lattice(consumer.root, ["graph", "--format", "json"]);
    expect(result.json.result.projects.length).toBe(3);
    // Three project→project edges: application→domain, api→application,
    // and api→domain (the CJS `require` also creates a graph edge).
    expect(result.json.result.dependencies.length).toBe(3);
  });

  it("JavaScript output is deterministic across two runs", () => {
    const first = lattice(consumer.root, ["graph", "--format", "json"]);
    const second = lattice(consumer.root, ["graph", "--format", "json"]);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(first.stdout).toBe(second.stdout);
  });
});
