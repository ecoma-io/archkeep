// E2E scenarios for the `impact` command.
//
// `impact` computes reverse reachability from the project graph: given a
// project name, it lists every project that transitively depends on it.
// It is descriptive — it never exits 1. It throws for unknown projects
// or incomplete graph coverage (exit 3).
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

describe("impact (full)", () => {
  it("reports direct and transitive dependents for a leaf project", () => {
    // In the monorepo: app → api → core. So `impact core` should list
    // api (direct) and app (transitive).
    const result = lattice(monorepoConsumer.root, ["impact", "core", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.command).toBe("impact");
    expect(result.json.result.direct).toContain("api");
    expect(result.json.result.transitive).toContain("app");
    expect(result.json.result.dependents).toContain("api");
    expect(result.json.result.dependents).toContain("app");
  });

  it("reports only direct dependents for a mid-chain project", () => {
    // `impact api` → direct: [app], transitive: []
    const result = lattice(monorepoConsumer.root, ["impact", "api", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json.result.direct).toContain("app");
    expect(result.json.result.transitive).toEqual([]);
  });

  it("reports empty dependents for a root project", () => {
    // `impact app` → nothing depends on app.
    const result = lattice(monorepoConsumer.root, ["impact", "app", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json.result.dependents).toEqual([]);
  });

  it("exits 2 for an unknown project name", () => {
    // "no project named..." matches the usage-error regex, so the CLI
    // exits 2 (usage), not 3 (error).
    const result = lattice(monorepoConsumer.root, ["impact", "nonexistent"]);
    expect(result.exitCode).toBe(2);
  });

  it("exits 2 for an unknown project name in JSON format", () => {
    const result = lattice(monorepoConsumer.root, ["impact", "nonexistent", "--format", "json"]);
    expect(result.exitCode).toBe(2);
  });
});

describe("impact --config (full)", () => {
  it("impact core on monorepo shows constraint context", () => {
    // The monorepo declares boundaryConfig in lattice.json, so the
    // workspace's own config is loaded and constraint context appears.
    // api depends on core, and the constraint (layer:api → layer:api,
    // layer:core) allows it, so api shows ✔.
    const result = lattice(monorepoConsumer.root, ["impact", "core"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Constraint context");
    expect(result.stdout).toContain("✔ api");
  });

  it("impact core --format json on monorepo has constraintImpact array", () => {
    const result = lattice(monorepoConsumer.root, ["impact", "core", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.result.constraintImpact).toBeDefined();
    expect(result.json.result.constraintImpact.length).toBeGreaterThanOrEqual(1);
    const apiEntry = result.json.result.constraintImpact.find((e) => e.project === "api");
    expect(apiEntry).toBeDefined();
    expect(apiEntry.violations).toEqual([]);
  });

  it("impact app on monorepo shows explicit empty message when no dependents", () => {
    // Bug 2 regression: app has no dependents, but the boundary config
    // was provided, so the constraint context section must appear with
    // the "no dependents to judge" line — never silently omitted.
    const result = lattice(monorepoConsumer.root, ["impact", "app"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Constraint context");
    expect(result.stdout).toContain("no dependents to judge against constraint table");
  });

  it("impact app --format json on monorepo has empty constraintImpact", () => {
    const result = lattice(monorepoConsumer.root, ["impact", "app", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.result.constraintImpact).toBeDefined();
    expect(result.json.result.constraintImpact).toEqual([]);
  });
});
