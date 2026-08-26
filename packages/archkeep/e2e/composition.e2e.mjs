// E2E scenarios proving official rules compose with shipped presets.
//
// The mission: prove that boundary constraints from a shipped preset,
// official generic rules declared as customRules, and fitness functions
// ALL judge in a single `check` run — without inventing a second law system.
//
// Composition happens at the workspace level: the workspace selects a
// profile from a shipped preset (vertical-slice) via nx.json's `profiles`
// option, AND declares its own customRules rows and fitness rows in its
// boundary config. The three layers merge through the existing policy
// resolution path and reach the verdict through the same enforcement run.
//
// This suite drives the real CLI against a packed tarball, over an Nx
// workspace that consumes the vertical-slice preset from node_modules,
// with tag-cardinality declared as a workspace-owned custom rule.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { packArtifact } from "./helpers/artifact.mjs";
import { createNxLanguageConsumer, commitFiles } from "./helpers/consumer.mjs";
import { archkeep } from "./helpers/run.mjs";
import { compositionFiles } from "./fixtures/composition-consumer.mjs";

// Resolve from this test file's location to repository root
const TEST_FILE = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = resolve(TEST_FILE, "../..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");
const RULES_PACKAGE = resolve(REPO_ROOT, "packages/archkeep-rules");

let artifact;
let consumer;

beforeAll(() => {
  artifact = packArtifact();
  consumer = createNxLanguageConsumer(artifact, compositionFiles);

  // Copy the tag-cardinality.wasm file into the consumer workspace
  const wasmSource = resolve(RULES_PACKAGE, "rules/tag-cardinality.wasm");
  const wasmDest = resolve(consumer.root, "tools/rules/tag-cardinality.wasm");
  mkdirSync(resolve(consumer.root, "tools/rules"), { recursive: true });
  const wasmData = readFileSync(wasmSource);
  writeFileSync(wasmDest, wasmData);
});

afterAll(() => {
  consumer?.cleanup();
  artifact?.cleanup();
});

/** Mutates the tree to create or remove violations. */
function setViolationState({ boundary = false, doubleFeature = false }) {
  /** @type {Record<string, string>} */
  const updates = {};

  // Boundary violation: kernel reaching into a slice (forbidden by preset)
  const kernelCode = boundary
    ? 'package kernel\n\nimport "example.test/catalog"\n\nvar _ = catalog.Name\n'
    : 'package kernel\n\nconst Name = "kernel"\n';

  // Orders imports kernel in clean state, no import in violating state (avoids cycle)
  const ordersCode = !boundary
    ? 'package orders\n\nimport "example.test/kernel"\n\nvar _ = kernel.Name\n'
    : 'package orders\n\nconst Name = "orders"\n';

  updates["libs/kernel/kernel.go"] = kernelCode;
  updates["libs/orders/orders.go"] = ordersCode;

  // Custom rule violation: orders slice carries two feature: tags
  const ordersTags = doubleFeature
    ? ["layer:slice", "feature:orders", "feature:catalog"]
    : ["layer:slice", "feature:orders"];
  updates["libs/orders/project.json"] = JSON.stringify({
    name: "orders",
    tags: ordersTags,
  });

  commitFiles(
    consumer.root,
    updates,
    `boundary=${boundary ? "violating" : "clean"}, doubleFeature=${doubleFeature}`,
  );
}

describe("official rules compose with shipped presets", () => {
  it("exits 0 on the clean tree — preset constraints, custom rule, and fitness all pass", () => {
    const result = archkeep(consumer.root, ["check"]);
    expect(result.exitCode).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain("no boundary violations");
    expect(output).toContain("tag-cardinality");
    expect(output).toContain("judged this workspace and reported no finding");
    expect(output).toContain("custom rules: 1 passed");
    expect(output).toContain("slice-isolation");
    expect(output).toContain("3 matched projects");
  });

  it("reports a preset boundary violation — kernel → slice is forbidden by vertical-slice", () => {
    setViolationState({ boundary: true, doubleFeature: false });
    const result = archkeep(consumer.root, ["check"]);
    expect(result.exitCode).toBe(1);
    const output = `${result.stdout}${result.stderr}`;
    // The preset's constraint row bans kernel → slice
    expect(output).toContain("kernel → catalog");
    // Custom rule still passes (single feature: tag)
    expect(output).toContain("tag-cardinality");
    expect(output).toContain("judged this workspace and reported no finding");
    // Fitness still passes (slice isolation not violated)
    expect(output).toContain("slice-isolation");
  });

  it("reports a custom rule violation — double feature: tag on orders slice", () => {
    setViolationState({ boundary: false, doubleFeature: true });
    const result = archkeep(consumer.root, ["check"]);
    expect(result.exitCode).toBe(1);
    const output = `${result.stdout}${result.stderr}`;
    // Custom rule finding: tag-cardinality violation
    expect(output).toContain("custom/tag-cardinality");
    expect(output).toContain("orders");
    // No boundary violations (kernel respects preset)
    expect(output).toContain("no boundary violations");
    // Fitness still passes
    expect(output).toContain("slice-isolation");
  });

  it("reports BOTH violations together — preset boundary + custom rule, exit 1 with both findings", () => {
    setViolationState({ boundary: true, doubleFeature: true });
    const result = archkeep(consumer.root, ["check"]);
    expect(result.exitCode).toBe(1);
    const output = `${result.stdout}${result.stderr}`;
    // Preset boundary violation
    expect(output).toContain("kernel → catalog");
    // Custom rule violation
    expect(output).toContain("custom/tag-cardinality");
    expect(output).toContain("orders");
    // Fitness still passes
    expect(output).toContain("slice-isolation");
  });

  it("exits 0 again after fixing both violations", () => {
    setViolationState({ boundary: false, doubleFeature: false });
    const result = archkeep(consumer.root, ["check"]);
    expect(result.exitCode).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain("no boundary violations");
    expect(output).toContain("tag-cardinality");
    expect(output).toContain("judged this workspace and reported no finding");
    expect(output).toContain("custom rules: 1 passed");
    expect(output).toContain("slice-isolation");
  });

  it("carries all three judgment layers in the JSON envelope", () => {
    setViolationState({ boundary: true, doubleFeature: true });
    const result = archkeep(consumer.root, ["check", "--format", "json"]);

    expect(result.exitCode).toBe(1);
    expect(result.json, result.stdout).not.toBeNull();
    expect(result.json.status).toBe("findings");
    expect(result.json.schemaVersion).toBe(2);

    // Boundary findings from preset - at result.violations
    const violations = result.json.result?.violations ?? [];
    expect(violations.length).toBeGreaterThan(0);
    const kernelViolation = violations.find(
      (v) => v.sourceProject === "kernel" && v.targetProject === "catalog",
    );
    expect(kernelViolation).toBeDefined();

    // Custom rule findings - at result.customRules.rules
    const customRules = result.json.result?.customRules?.rules ?? [];
    expect(customRules.length).toBeGreaterThan(0);
    const tagCardinalityRule = customRules.find((r) => r.name === "tag-cardinality");
    expect(tagCardinalityRule).toBeDefined();
    expect(tagCardinalityRule.findings).toHaveLength(1);
    const tagCardinalityFinding = tagCardinalityRule.findings.find((f) => f.project === "orders");
    expect(tagCardinalityFinding).toBeDefined();

    // Fitness judgment
    const fitness = result.json.result?.fitness;
    expect(fitness).toBeDefined();
    expect(fitness.verdict).toBe("pass");
    expect(fitness.functions).toContainEqual(
      expect.objectContaining({ name: "slice-isolation", verdict: "pass" }),
    );
  });

  it("folds the clean fitness verdict into check's exit code", () => {
    setViolationState({ boundary: false, doubleFeature: false });
    const result = archkeep(consumer.root, ["fitness"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("slice-isolation");
  });
});
