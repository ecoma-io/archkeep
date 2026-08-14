// E2E scenarios for the Moon provider.
//
// A Moonrepo workspace uses `.moon/workspace.yml` and per-project `moon.yml`
// files. Lattice discovers the workspace via `.moon/` and reads the project
// graph from `moon project-graph --json` — the same one-call contract as the
// Nx provider, but without Nx installed. These scenarios prove that Lattice's
// analysis, graph construction, and boundary enforcement work through the Moon
// provider against a real installed CLI.
import { execSync } from "node:child_process";
import { join } from "node:path";

import { describe as vitestDescribe, it, expect, beforeAll, afterAll } from "vitest";
import { packArtifact } from "./helpers/artifact.mjs";
import { createMoonConsumer, commitFiles } from "./helpers/consumer.mjs";
import { lattice } from "./helpers/run.mjs";
import { MOON_LIB_REACHES_APP } from "./fixtures/violations.mjs";

// Skip the entire suite when the `moon` CLI is not available — the fixture
// is a Moon workspace and the Moon provider calls `moon project-graph --json`.
// The consumer installs `@moonrepo/cli` as a devDependency, so Moon is
// available inside the consumer's `node_modules/.bin`. The skip check here
// merely verifies that Moon can run on this platform at all (the consumer's
// install would fail otherwise, but the error would be confusing).
let moonAvailable = false;
try {
  execSync("npx moon --version", { stdio: "pipe" });
  moonAvailable = true;
} catch {
  // `moon` cannot run on this platform — suite will be skipped.
}
const describe = moonAvailable ? vitestDescribe : vitestDescribe.skip;

let artifact;
let moonConsumer;

beforeAll(() => {
  artifact = packArtifact();
  moonConsumer = createMoonConsumer(artifact);
});

afterAll(() => {
  moonConsumer?.cleanup();
  artifact?.cleanup();
});

describe("Moon (smoke)", () => {
  it("exits 0 on a clean Moon tree and states what it inspected", () => {
    const result = lattice(moonConsumer.root, ["check"]);
    expect(result.exitCode).toBe(0);
    // "no violations" is a claim about coverage too — a 0 that inspected
    // nothing is the same silence as no check at all.
    expect(result.stdout).toMatch(/[1-9]\d* import/);
    expect(result.stdout).toMatch(/[1-9]\d* file/);
    expect(result.stdout).toMatch(/[1-9]\d* project/);
  });

  it("exits 0 on a clean Moon tree for graph and states project and edge counts", () => {
    const result = lattice(moonConsumer.root, ["graph"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/[1-9]\d* project/);
    expect(result.stdout).toMatch(/[1-9]\d* edge/);
  });
});

describe("Moon (full)", () => {
  it("exits 1 on a violating Moon tree, naming the rule and position", () => {
    // Each violating test needs its own consumer to avoid mutating the shared
    // clean consumer. Create a fresh one.
    const violator = createMoonConsumer(artifact);
    try {
      commitFiles(violator.root, MOON_LIB_REACHES_APP, "core reaches up into cli");
      const result = lattice(violator.root, ["check"]);
      expect(result.exitCode).toBe(1);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("onlyTagsConstraintViolation");
      expect(output).toMatch(/libs\/core\/src\/index\.ts:\d+:\d+/);
    } finally {
      violator.cleanup();
    }
  });

  it("produces a valid JSON envelope for check on a clean Moon tree", () => {
    const result = lattice(moonConsumer.root, ["check", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.command).toBe("check");
    expect(result.json.schemaVersion).toBe(2);
    expect(result.json.status).toBe("ok");
    expect(result.json.exitCode).toBe(0);
    expect(result.json.coverage.complete).toBe(true);
    expect(result.json.coverage.notAnalyzed).toEqual([]);
    expect(result.json.coverage.imports).toBeGreaterThan(0);
    expect(result.json.coverage.analyzedFiles).toBeGreaterThan(0);
  });

  it("produces a valid JSON envelope for graph on a clean Moon tree", () => {
    const result = lattice(moonConsumer.root, ["graph", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.command).toBe("graph");
    expect(result.json.schemaVersion).toBe(2);
    expect(result.json.status).toBe("ok");
    expect(result.json.coverage.complete).toBe(true);
    expect(Array.isArray(result.json.result.projects)).toBe(true);
    expect(Array.isArray(result.json.result.dependencies)).toBe(true);
  });

  it("includes expected project names in the graph JSON output", () => {
    const result = lattice(moonConsumer.root, ["graph", "--format", "json"]);
    const names = result.json.result.projects.map((p) => p.name);
    expect(names).toContain("web");
    expect(names).toContain("cli");
    expect(names).toContain("api");
    expect(names).toContain("core");
  });

  it("diff exits 0 and reports no changes against a self-baseline", () => {
    const baselineFile = join(moonConsumer.root, "baseline-moon.json");
    lattice(moonConsumer.root, ["graph", "--format", "json", "--output", baselineFile]);
    const result = lattice(moonConsumer.root, ["diff", baselineFile]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no changes");
  });

  it("impact reports direct and transitive dependents for a leaf project", () => {
    const result = lattice(moonConsumer.root, ["impact", "core", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.command).toBe("impact");
    expect(result.json.result.dependents).toContain("api");
    expect(result.json.result.dependents).toContain("web");
  });

  it("explain explains a violating import site", () => {
    const violator = createMoonConsumer(artifact);
    try {
      commitFiles(violator.root, MOON_LIB_REACHES_APP, "core reaches up into cli");
      // libs/core/src/index.ts line 1: `import { cli } from "@acme/cli"`
      // Position 1:21 is where the specifier "@acme/cli" starts.
      const result = lattice(violator.root, [
        "explain",
        "libs/core/src/index.ts:1:21",
        "--format",
        "json",
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.json).not.toBeNull();
      expect(result.json.result.import.specifier).toBe("@acme/cli");
      expect(result.json.result.import.sourceProject).toBe("core");
      expect(result.json.result.import.targetProject).toBe("cli");
      expect(result.json.result.violation).not.toBeNull();
      expect(result.json.result.violation.messageId).toBe("onlyTagsConstraintViolation");
    } finally {
      violator.cleanup();
    }
  });

  it("uses the Moon provider — provider is moon, not native or nx", () => {
    // The fixture has `.moon/` but no `lattice.json` and no `nx.json`, so
    // the Moon provider is the one that runs. Assert the JSON envelope's
    // `workspace.provider` field.
    const result = lattice(moonConsumer.root, ["graph", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json.workspace.provider).toBe("moon");
  });
});
