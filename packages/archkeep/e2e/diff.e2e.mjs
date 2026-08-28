// E2E scenarios for the `diff` command.
//
// `diff` takes a graph baseline FILE (not a git ref) and compares the
// current graph against it. It is descriptive — it never exits 1. It
// refuses incomplete baselines or incomplete head graphs (exit 3).
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { packArtifact } from "./helpers/artifact.mjs";
import {
  createNativeConsumer,
  createNativeLanguageConsumer,
  commitFiles,
  fixtureFiles,
  applyFiles,
} from "./helpers/consumer.mjs";
import { archkeep } from "./helpers/run.mjs";
import { CORE_REACHES_APP } from "./fixtures/violations.mjs";
import { canonicalNativeFiles, mutations } from "./fixtures/canonical/native.mjs";
import { assertDelta } from "./helpers/canonical.mjs";

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

describe("diff", () => {
  it("exits 0 and reports no changes against a self-baseline", () => {
    // Capture a baseline from the clean tree.
    const baselineFile = join(nativeConsumer.root, "baseline-self-text.json");
    archkeep(nativeConsumer.root, ["graph", "--format", "json", "--output", baselineFile]);
    const result = archkeep(nativeConsumer.root, ["diff", baselineFile]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no changes");
  });

  it("produces a valid JSON envelope for a self-baseline diff", () => {
    const baselineFile = join(nativeConsumer.root, "baseline-self-json.json");
    archkeep(nativeConsumer.root, ["graph", "--format", "json", "--output", baselineFile]);
    const result = archkeep(nativeConsumer.root, ["diff", baselineFile, "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.command).toBe("diff");
    expect(result.json.status).toBe("ok");
    expect(result.json.result.addedProjects).toEqual([]);
    expect(result.json.result.removedProjects).toEqual([]);
    expect(result.json.result.addedEdges).toEqual([]);
    expect(result.json.result.removedEdges).toEqual([]);
  });

  it("reports an added edge when a violation is introduced", () => {
    // Use a fresh consumer so the baseline is clean.
    const consumer = createNativeConsumer(artifact);
    try {
      const baselineFile = join(consumer.root, "baseline-pre-violation.json");
      archkeep(consumer.root, ["graph", "--format", "json", "--output", baselineFile]);

      // Introduce the violation.
      commitFiles(consumer.root, CORE_REACHES_APP, "core reaches up into app");

      const result = archkeep(consumer.root, ["diff", baselineFile, "--format", "json"]);
      expect(result.exitCode).toBe(0);
      expect(result.json.result.addedEdges.length).toBeGreaterThan(0);
      const added = result.json.result.addedEdges;
      const coreToApp = added.find((e) => e.source === "core" && e.target === "app");
      expect(coreToApp).toBeDefined();
    } finally {
      consumer.cleanup();
    }
  });

  it("reports a removed edge when an import is removed", () => {
    const consumer = createNativeConsumer(artifact);
    try {
      const baselineFile = join(consumer.root, "baseline-pre-remove.json");
      archkeep(consumer.root, ["graph", "--format", "json", "--output", baselineFile]);

      // Remove the app→core import by replacing app.go with an empty file.
      commitFiles(consumer.root, { "libs/app/app.go": "package app\n" }, "remove import from app");

      const result = archkeep(consumer.root, ["diff", baselineFile, "--format", "json"]);
      expect(result.exitCode).toBe(0);
      expect(result.json.result.removedEdges.length).toBeGreaterThan(0);
      const removed = result.json.result.removedEdges;
      const appToCore = removed.find((e) => e.source === "app" && e.target === "core");
      expect(appToCore).toBeDefined();
    } finally {
      consumer.cleanup();
    }
  });

  it("exits 3 when the baseline file cannot be parsed", () => {
    const badBaseline = join(nativeConsumer.root, "bad-baseline.json");
    writeFileSync(badBaseline, "not json at all", "utf8");
    const result = archkeep(nativeConsumer.root, ["diff", badBaseline]);
    expect(result.exitCode).toBe(3);
  });

  it("exits 3 when the baseline has incomplete coverage", () => {
    // Build a baseline with `coverage.complete: false`.
    const incompleteBaseline = join(nativeConsumer.root, "incomplete-baseline.json");
    const fakeEnvelope = {
      schemaVersion: 1,
      command: "graph",
      status: "no-verdict",
      exitCode: 3,
      coverage: { complete: false, notAnalyzed: [{ file: "missing.go", reason: "parse error" }] },
      result: { projects: [], dependencies: [] },
    };
    writeFileSync(incompleteBaseline, JSON.stringify(fakeEnvelope), "utf8");
    const result = archkeep(nativeConsumer.root, ["diff", incompleteBaseline]);
    expect(result.exitCode).toBe(3);
  });
});

describe("diff --config", () => {
  it("self-baseline diff with config shows 'no boundary-rule impact' in text", () => {
    // Bug 1 regression: when the workspace has a boundaryConfig, a self-baseline
    // diff must show "no boundary-rule impact" alongside "no changes" — the two
    // are distinct claims and neither subsumes the other.
    const baselineFile = join(nativeConsumer.root, "baseline-config-text.json");
    archkeep(nativeConsumer.root, ["graph", "--format", "json", "--output", baselineFile]);
    const result = archkeep(nativeConsumer.root, ["diff", baselineFile]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no boundary-rule impact");
    expect(result.stdout).toContain("no changes");
  });

  it("self-baseline diff with config in JSON has ruleImpact", () => {
    const baselineFile = join(nativeConsumer.root, "baseline-config-json.json");
    archkeep(nativeConsumer.root, ["graph", "--format", "json", "--output", baselineFile]);
    const result = archkeep(nativeConsumer.root, ["diff", baselineFile, "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.result.ruleImpact).toBeDefined();
    expect(result.json.result.ruleImpact.introduced).toEqual([]);
    expect(result.json.result.ruleImpact.resolved).toEqual([]);
  });

  it("diff after violation with config shows 'boundary violation introduced'", () => {
    const consumer = createNativeConsumer(artifact);
    try {
      const baselineFile = join(consumer.root, "baseline-pre-violation-config.json");
      archkeep(consumer.root, ["graph", "--format", "json", "--output", baselineFile]);

      // Introduce the violation — core imports app, violating layer:core → layer:core.
      commitFiles(consumer.root, CORE_REACHES_APP, "core reaches up into app");

      const result = archkeep(consumer.root, ["diff", baselineFile]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("boundary violation introduced");
    } finally {
      consumer.cleanup();
    }
  });

  it("diff after violation with config in JSON has ruleImpact.introduced entries", () => {
    const consumer = createNativeConsumer(artifact);
    try {
      const baselineFile = join(consumer.root, "baseline-pre-violation-config-json.json");
      archkeep(consumer.root, ["graph", "--format", "json", "--output", baselineFile]);

      commitFiles(consumer.root, CORE_REACHES_APP, "core reaches up into app");

      const result = archkeep(consumer.root, ["diff", baselineFile, "--format", "json"]);
      expect(result.exitCode).toBe(0);
      expect(result.json).not.toBeNull();
      expect(result.json.result.ruleImpact).toBeDefined();
      expect(result.json.result.ruleImpact.introduced.length).toBeGreaterThan(0);
      const entry = result.json.result.ruleImpact.introduced.find(
        (v) => v.messageId === "onlyTagsConstraintViolation",
      );
      expect(entry).toBeDefined();
    } finally {
      consumer.cleanup();
    }
  });

  it("diff with config after removing a violating edge shows 'boundary violation resolved'", () => {
    const consumer = createNativeConsumer(artifact);
    try {
      // Start with the violation in place.
      commitFiles(consumer.root, CORE_REACHES_APP, "core reaches up into app");
      const baselineFile = join(consumer.root, "baseline-violating.json");
      archkeep(consumer.root, ["graph", "--format", "json", "--output", baselineFile]);

      // Remove the violation: restore core's go.mod and rewrite violate.go
      // so it no longer imports app. The workspace's own boundaryConfig is
      // used automatically.
      const CLEAN_CORE_GO_MOD = "module example.test/core\n\ngo 1.22\n";
      const NOOP_VIOLATE_GO = "package core\n";
      commitFiles(
        consumer.root,
        { "libs/core/go.mod": CLEAN_CORE_GO_MOD, "libs/core/violate.go": NOOP_VIOLATE_GO },
        "remove core → app violation",
      );

      const result = archkeep(consumer.root, ["diff", baselineFile]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("boundary violation resolved");
    } finally {
      consumer.cleanup();
    }
  });
});

describe("diff incompleteness, metadata, and determinism", () => {
  it("refuses exit 3 when a head source file cannot be read", () => {
    const consumer = createNativeLanguageConsumer(artifact, canonicalNativeFiles);
    try {
      const baselineFile = join(consumer.root, "baseline-head-incomplete.json");
      archkeep(consumer.root, ["graph", "--format", "json", "--output", baselineFile]);

      // A dangling symlink is tracked by git but unreadable on disk: the
      // head graph cannot be complete, and every "removed" entry would be
      // ambiguous between "gone" and "never seen".
      const coreGo = join(consumer.root, "libs/core/core.go");
      const original = readFileSync(coreGo, "utf8");
      rmSync(coreGo);
      symlinkSync("definitely-missing.go", coreGo);

      const refused = archkeep(consumer.root, ["diff", baselineFile, "--format", "json"]);
      expect(refused.exitCode, "diff refuses an unreadable head source").toBe(3);
      expect(refused.stderr).toContain("head graph has incomplete coverage");

      // The refusal was about coverage, not architecture: restoring the file
      // restores the empty self-diff.
      rmSync(coreGo);
      writeFileSync(coreGo, original);
      const restored = archkeep(consumer.root, ["diff", baselineFile, "--format", "json"]);
      expect(restored.exitCode).toBe(0);
      assertDelta(restored.json.result, {});
    } finally {
      consumer.cleanup();
    }
  });

  it("reports a tags edit as changedProjects, with no edge movement", () => {
    const consumer = createNativeLanguageConsumer(artifact, canonicalNativeFiles);
    try {
      const clean = fixtureFiles(artifact, canonicalNativeFiles);
      // tooling carries no law row, so the edit cannot be confounded with a
      // boundary refusal.
      const withTooling = mutations["add-project-tooling"](clean);
      applyFiles(consumer.root, clean, withTooling, "add the tooling project");

      const baselineFile = join(consumer.root, "baseline-tags.json");
      archkeep(consumer.root, ["graph", "--format", "json", "--output", baselineFile]);

      const renamed = {
        ...withTooling,
        "archkeep.json": withTooling["archkeep.json"].replace("layer/tooling", "layer/bench"),
      };
      applyFiles(consumer.root, withTooling, renamed, "rename tooling's layer tag");

      const result = archkeep(consumer.root, ["diff", baselineFile, "--format", "json"]);
      expect(result.exitCode).toBe(0);
      assertDelta(result.json.result, { changedProjects: ["tooling"] });
      const fields = result.json.result.changedProjects[0].changes.map((change) => change.field);
      expect(fields, "the tags edit is named as such").toContain("tags");
    } finally {
      consumer.cleanup();
    }
  });

  it("produces byte-identical output across two runs over one mutation", () => {
    const consumer = createNativeLanguageConsumer(artifact, canonicalNativeFiles);
    try {
      const clean = fixtureFiles(artifact, canonicalNativeFiles);
      const baselineFile = join(consumer.root, "baseline-determinism.json");
      archkeep(consumer.root, ["graph", "--format", "json", "--output", baselineFile]);

      const mutated = mutations["add-edge-api-core"](clean);
      applyFiles(consumer.root, clean, mutated, "mutation: add-edge-api-core");

      const first = archkeep(consumer.root, ["diff", baselineFile]);
      const second = archkeep(consumer.root, ["diff", baselineFile]);
      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toBe(first.stdout);
    } finally {
      consumer.cleanup();
    }
  });
});
