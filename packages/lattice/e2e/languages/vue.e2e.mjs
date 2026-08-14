// E2E scenarios for the Vue language fixture.
//
// Proves that Lattice discovers Vue SFC imports — `vue/compiler-sfc`
// locates `<script setup>` blocks, blanks everything outside them, and
// hands the code to the TypeScript analyzer. This is the path most likely
// to regress silently (lazy-loaded parser, non-standard source container).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { packArtifact } from "../helpers/artifact.mjs";
import { createNativeLanguageConsumer, commitFiles } from "../helpers/consumer.mjs";
import { lattice } from "../helpers/run.mjs";
import { VUE_VIOLATION } from "../fixtures/languages/violations.mjs";

let artifact;
let consumer;

beforeAll(() => {
  artifact = packArtifact();
  consumer = createNativeLanguageConsumer(artifact, "vue");
});

afterAll(() => {
  consumer?.cleanup();
  artifact?.cleanup();
});

describe("Vue language E2E (smoke)", () => {
  it("Vue SFC script imports are discovered in the graph", () => {
    const result = lattice(consumer.root, ["graph", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();

    const names = result.json.result.projects.map((p) => p.name).sort();
    expect(names).toEqual(["api", "application", "domain"]);

    const edges = result.json.result.dependencies;
    // application→domain (App.vue imports from domain).
    const appToDomain = edges.find((e) => e.source === "application" && e.target === "domain");
    expect(appToDomain).toBeDefined();
  });

  it("Vue valid architecture passes check", () => {
    const result = lattice(consumer.root, ["check"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/[1-9]\d* import/);
    expect(result.stdout).toMatch(/[1-9]\d* file/);
    expect(result.stdout).toMatch(/[1-9]\d* project/);
  });
});

describe("Vue language E2E (full)", () => {
  it("Vue architecture violation is enforced", () => {
    const violator = createNativeLanguageConsumer(artifact, "vue");
    try {
      commitFiles(violator.root, VUE_VIOLATION, "domain reaches up into application");
      const result = lattice(violator.root, ["check"]);
      expect(result.exitCode).toBe(1);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("onlyTagsConstraintViolation");
      // The violation is in the .vue SFC's script block.
      expect(output).toMatch(/libs\/domain\/Violate\.vue:\d+:\d+/);
    } finally {
      violator.cleanup();
    }
  });

  it("Vue check produces a valid JSON envelope on a clean tree", () => {
    const result = lattice(consumer.root, ["check", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.command).toBe("check");
    expect(result.json.schemaVersion).toBe(2);
    expect(result.json.status).toBe("ok");
    expect(result.json.coverage.complete).toBe(true);
    expect(result.json.coverage.imports).toBeGreaterThan(0);
  });

  it("Vue graph JSON includes expected projects and edges", () => {
    const result = lattice(consumer.root, ["graph", "--format", "json"]);
    expect(result.json.result.projects.length).toBe(3);
    // Two edges: application→domain (App.vue imports from domain),
    // api→application (View.vue imports from application).
    expect(result.json.result.dependencies.length).toBe(2);
  });

  it("Vue output is deterministic across two runs", () => {
    const first = lattice(consumer.root, ["graph", "--format", "json"]);
    const second = lattice(consumer.root, ["graph", "--format", "json"]);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(first.stdout).toBe(second.stdout);
  });
});
