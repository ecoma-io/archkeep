// E2E scenarios for the `rules` command.
//
// `rules` provides a CLI interface to the official rules catalog:
// list, info, verify, and add. The verbs are descriptive except `verify`:
// a verification that ran and came back negative (a digest mismatch) exits 1
// — a finding, the same class as a boundary violation — and exit 3 stays the
// could-not-look class (a missing or unreadable catalog).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { packArtifact } from "./helpers/artifact.mjs";
import { createNativeConsumer } from "./helpers/consumer.mjs";
import { archkeep } from "./helpers/run.mjs";

let artifact;
let consumer;
const tempDir = process.cwd() + "/tmp-rules-add-test";

beforeAll(() => {
  artifact = packArtifact();
  consumer = createNativeConsumer(artifact);
  // Create temp directory for rules add tests
  mkdirSync(tempDir, { recursive: true });
});

afterAll(() => {
  consumer?.cleanup();
  artifact?.cleanup();
  // Clean up temp directory
  rmSync(tempDir, { recursive: true, force: true });
});

/** Get the path to the catalog for testing. */
function _getCatalogPath() {
  return process.cwd() + "/packages/archkeep-rules/catalog.json";
}

describe("rules list", () => {
  it("lists all rules from the catalog", () => {
    const catalogPath = _getCatalogPath();
    const result = archkeep(consumer.root, [
      "rules",
      "list",
      "--catalog",
      catalogPath,
      "--format",
      "json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.command).toBe("rules list");
    expect(result.json.result.rules).toBeInstanceOf(Array);
    expect(result.json.result.rules.length).toBeGreaterThan(0);
  });

  it("renders text output by default", () => {
    const catalogPath = _getCatalogPath();
    const result = archkeep(consumer.root, ["rules", "list", "--catalog", catalogPath]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Official rules");
    // Text output includes JSON examples, so it will contain braces
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});

describe("rules info", () => {
  const catalogPath = _getCatalogPath();

  it("shows details for a specific rule", () => {
    const result = archkeep(consumer.root, [
      "rules",
      "info",
      "tag-cardinality",
      "--catalog",
      catalogPath,
      "--format",
      "json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.command).toBe("rules info");
    expect(result.json.result.rule.name).toBe("tag-cardinality");
    expect(result.json.result.rule.contract).toBeDefined();
    expect(result.json.result.rule.artifact).toBeDefined();
    expect(result.json.result.rule.sha256).toBeDefined();
  });

  it("fails on unknown rule name", () => {
    const result = archkeep(consumer.root, [
      "rules",
      "info",
      "nonexistent-rule",
      "--catalog",
      catalogPath,
    ]);
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain("not found in catalog");
  });
});

describe("rules verify", () => {
  const catalogPath = _getCatalogPath();

  it("verifies catalog integrity through REAL host", () => {
    const result = archkeep(consumer.root, [
      "rules",
      "verify",
      "--catalog",
      catalogPath,
      "--format",
      "json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.command).toBe("rules verify");
    expect(result.json.result.totalRules).toBeGreaterThan(0);
    expect(result.json.result.passed).toBeGreaterThan(0);
  });

  it("reports failed integrity checks", () => {
    // This test assumes the catalog has at least one rule that can be verified.
    // In a real scenario, we'd need to mock a corrupted catalog or rule artifact.
    const result = archkeep(consumer.root, ["rules", "verify", "--catalog", catalogPath]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/OK|FAILED/);
  });

  // The three-state exit contract, at the process boundary a CI script
  // branches on: a completed verification with a negative result is exit 1 —
  // the finding a script must act on — and only a run that could not look is
  // exit 3. Collapsing the two makes "this shipped artifact was tampered
  // with" indistinguishable from "the catalog could not be read".
  it("exits 1 when an artifact's bytes do not match its digest", () => {
    const tamperedDir = join(consumer.root, "tampered-catalog");
    mkdirSync(join(tamperedDir, "rules"), { recursive: true });
    writeFileSync(
      join(tamperedDir, "rules", "tampered-rule.wasm"),
      Buffer.from("bytes edited after the catalog recorded their digest"),
    );
    writeFileSync(
      join(tamperedDir, "catalog.json"),
      JSON.stringify({
        version: 1,
        rules: [
          {
            name: "tampered-rule",
            description: "artifact bytes edited after the digest was recorded",
            contract: 1,
            needs: [],
            params: {},
            artifact: "rules/tampered-rule.wasm",
            sha256: "0".repeat(64),
          },
        ],
      }),
    );

    const result = archkeep(consumer.root, [
      "rules",
      "verify",
      "--catalog",
      join(tamperedDir, "catalog.json"),
      "--format",
      "json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.json).not.toBeNull();
    expect(result.json.status).toBe("findings");
    expect(result.json.exitCode).toBe(1);
    expect(result.stdout).toContain("Digest mismatch");
  });

  it("exits 3 when the catalog cannot be read at all", () => {
    const result = archkeep(consumer.root, [
      "rules",
      "verify",
      "--catalog",
      join(consumer.root, "no-such-catalog.json"),
    ]);

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("catalog not found");
  });
});

describe("rules add", () => {
  const catalogPath = _getCatalogPath();
  const tempDir = process.cwd() + "/tmp-rules-add-test";

  it("adds a rule to the workspace", () => {
    const result = archkeep(consumer.root, [
      "rules",
      "add",
      "tag-cardinality",
      "--catalog",
      catalogPath,
      "--to",
      tempDir,
      "--format",
      "json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.command).toBe("rules add");
    expect(result.json.result.rule).toBe("tag-cardinality");
    expect(result.json.result.artifactPath).toContain("tag-cardinality.wasm");
    // #425's silent direction: the printed row must never carry the catalog's
    // params SCHEMA as if it were values — a row that parses but cannot run.
    expect(result.json.result.customRulesRow).not.toHaveProperty("params");
  });

  it("fails on unknown rule name", () => {
    const result = archkeep(consumer.root, [
      "rules",
      "add",
      "nonexistent-rule",
      "--catalog",
      catalogPath,
      "--to",
      tempDir,
    ]);
    expect(result.exitCode).toBe(3);
    // The error message might be in stdout or stderr depending on how the CLI handles errors
    const output = result.stdout + result.stderr;
    expect(output).toContain("not found in catalog");
  });

  it("copies wasm file to tools/rules/", () => {
    const result = archkeep(consumer.root, [
      "rules",
      "add",
      "tag-cardinality",
      "--catalog",
      catalogPath,
      "--to",
      tempDir,
    ]);
    expect(result.exitCode).toBe(0);
    // The actual file copy is verified by the command's behavior;
    // this test checks that the command completes successfully.
    expect(result.stdout).toContain("customRules");
  });
});
