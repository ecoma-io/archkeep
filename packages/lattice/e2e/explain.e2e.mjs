// E2E scenarios for the `explain` command.
//
// `explain` takes a `file:line:column` site, finds the matching import
// record, and explains the judgment: which constraint row matched, which
// tags applied, whether it is a violation and why. It is descriptive —
// it never exits 1. It throws for malformed sites (exit 2) or when no
// import exists at the given position (exit 2).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { packArtifact } from "./helpers/artifact.mjs";
import { createNativeConsumer, commitFiles } from "./helpers/consumer.mjs";
import { lattice } from "./helpers/run.mjs";
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

describe("explain", () => {
  it("explains a clean import site with no violation", () => {
    // libs/app/app.go line 3: `import "example.test/core"`
    // The `"` of the import path is at column 8 (1-based: i=1, m=2, p=3,
    // o=4, r=5, t=6, space=7, "=8).
    const result = lattice(nativeConsumer.root, [
      "explain",
      "libs/app/app.go:3:8",
      "--format",
      "json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.command).toBe("explain");
    expect(result.json.result.import.specifier).toBe("example.test/core");
    expect(result.json.result.import.sourceProject).toBe("app");
    expect(result.json.result.import.targetProject).toBe("core");
    expect(result.json.result.sourceTags).toContain("layer:app");
    expect(result.json.result.targetTags).toContain("layer:core");
    expect(result.json.result.violations).toBeNull();
  });

  it("explains a violating import site", () => {
    const violator = createNativeConsumer(artifact);
    try {
      commitFiles(violator.root, CORE_REACHES_APP, "core reaches up into app");
      // libs/core/violate.go line 3: `import "example.test/app"`
      // The `"` is at column 8.
      const result = lattice(violator.root, [
        "explain",
        "libs/core/violate.go:3:8",
        "--format",
        "json",
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.json.result.violations).not.toBeNull();
      expect(result.json.result.violations[0].messageId).toBe("onlyTagsConstraintViolation");
      expect(result.json.result.sourceTags).toContain("layer:core");
    } finally {
      violator.cleanup();
    }
  });

  it("exits 2 for a malformed site string", () => {
    const result = lattice(nativeConsumer.root, ["explain", "bad-format"]);
    expect(result.exitCode).toBe(2);
  });

  it("exits 3 for a site with no import at that position", () => {
    const result = lattice(nativeConsumer.root, ["explain", "libs/app/app.go:1:1"]);
    // Line 1 is `package app` — no import there. The CLI reports "no import
    // site at..." which does not match the usage-error patterns, so it exits
    // 3 (error), not 2 (usage).
    expect(result.exitCode).toBe(3);
  });

  it("exits 3 for a nonexistent file site", () => {
    const result = lattice(nativeConsumer.root, ["explain", "libs/app/nonexistent.go:1:1"]);
    expect(result.exitCode).toBe(3);
  });
});
