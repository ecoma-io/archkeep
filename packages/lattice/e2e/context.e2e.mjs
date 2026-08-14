// E2E scenarios for the `context` command.
//
// `context` is a descriptive command — it never exits 1. Given a project name,
// it reports the project's tags and the constraint rows that apply to it.
// It exits 2 for usage errors (unknown project, wrong argument count).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { packArtifact } from "./helpers/artifact.mjs";
import { createNativeConsumer, createNativeMonorepoConsumer } from "./helpers/consumer.mjs";
import { lattice } from "./helpers/run.mjs";

let artifact;
let nativeConsumer;
let monorepoConsumer;

beforeAll(() => {
  artifact = packArtifact();
  nativeConsumer = createNativeConsumer(artifact);
  monorepoConsumer = createNativeMonorepoConsumer(artifact);
});

afterAll(() => {
  monorepoConsumer?.cleanup();
  nativeConsumer?.cleanup();
  artifact?.cleanup();
});

describe("context (smoke)", () => {
  it("exits 0 and returns project tags and constraints in JSON", () => {
    const result = lattice(nativeConsumer.root, ["context", "core", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.command).toBe("context");
    expect(result.json.result.tags).toContain("layer:core");
    const coreConstraint = result.json.result.constraints.find((c) => c.sourceTag === "layer:core");
    expect(coreConstraint).toBeDefined();
  });
});

describe("context (full)", () => {
  it("reports app constraints with both allowed tags on native consumer", () => {
    // Native boundary law: layer:app may reach layer:app and layer:core.
    const result = lattice(nativeConsumer.root, ["context", "app", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    const appConstraint = result.json.result.constraints.find((c) => c.sourceTag === "layer:app");
    expect(appConstraint).toBeDefined();
    expect(appConstraint.onlyDependOnLibsWithTags).toContain("layer:app");
    expect(appConstraint.onlyDependOnLibsWithTags).toContain("layer:core");
  });

  it("outputs tags and constraint text in text format", () => {
    const result = lattice(nativeConsumer.root, ["context", "core"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("layer:core");
    // The text report includes a constraint-row section — the exact label
    // varies, so check for the tag appearing in a constraint context rather
    // than pinning the whole format.
    expect(result.stdout).toMatch(/constraint/i);
  });

  it("exits 2 for an unknown project name", () => {
    // "no project named..." matches the usage-error regex, so the CLI
    // exits 2 (usage), not 3 (error).
    const result = lattice(nativeConsumer.root, ["context", "nonexistent"]);
    expect(result.exitCode).toBe(2);
  });

  it("reports api constraints on monorepo consumer", () => {
    // Monorepo boundary law: layer:api may reach layer:api and layer:core.
    const result = lattice(monorepoConsumer.root, ["context", "api", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.result.tags).toContain("layer:api");
    const apiConstraint = result.json.result.constraints.find((c) => c.sourceTag === "layer:api");
    expect(apiConstraint).toBeDefined();
  });

  it("reports app can depend on layer:app, layer:api, and layer:core on monorepo", () => {
    // Monorepo boundary law: layer:app may reach layer:app, layer:api,
    // and layer:core.
    const result = lattice(monorepoConsumer.root, ["context", "app", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    const appConstraint = result.json.result.constraints.find((c) => c.sourceTag === "layer:app");
    expect(appConstraint).toBeDefined();
    expect(appConstraint.onlyDependOnLibsWithTags).toContain("layer:app");
    expect(appConstraint.onlyDependOnLibsWithTags).toContain("layer:api");
    expect(appConstraint.onlyDependOnLibsWithTags).toContain("layer:core");
  });
});
