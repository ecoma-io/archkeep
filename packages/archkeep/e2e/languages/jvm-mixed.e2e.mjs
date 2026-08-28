// E2E scenarios for the mixed Java/Kotlin JVM fixture.
//
// One package index spans BOTH extensions (`src/analysis/jvm/packages.mjs`):
// a `.java` import may reach a package only a `.kt` declares, and the other
// way round. These scenarios prove that through the real installed CLI —
// each canonical edge below resolves through the OTHER extension's entry —
// and that the index's loud contracts hold at the process surface: a split
// package is a named blind spot with no guessed edge in its place, and an
// unreadable source refuses check, graph, and diff (exit 3), never an empty
// result.
import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { packArtifact } from "../helpers/artifact.mjs";
import { createNativeLanguageConsumer, commitFiles } from "../helpers/consumer.mjs";
import { archkeep } from "../helpers/run.mjs";
import {
  jvmMixedLanguageFiles,
  SPLIT_PACKAGE_MUTATION,
  MIXED_VIOLATION,
} from "../fixtures/languages/jvm-mixed.mjs";

let artifact;
let consumer;

beforeAll(() => {
  artifact = packArtifact();
  consumer = createNativeLanguageConsumer(artifact, jvmMixedLanguageFiles);
});

afterAll(() => {
  consumer?.cleanup();
  artifact?.cleanup();
});

describe("JVM mixed Java/Kotlin E2E", () => {
  it("resolves cross-extension packages into static edges in both directions", () => {
    const result = archkeep(consumer.root, ["graph", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    expect(result.json).not.toBeNull();
    expect(result.json.schemaVersion).toBe(2);
    expect(result.json.coverage.complete).toBe(true);
    expect(result.json.result.projects.map((p) => p.name).sort()).toEqual([
      "api",
      "application",
      "domain",
    ]);
    // application→domain resolves through the `.kt`-declared
    // `com.example.kdomain`; api→application through the `.java`-declared
    // `com.example.application`. Both records exist, or the shared index
    // lost one of its two extensions.
    expect(result.json.result.dependencies.map((e) => [e.source, e.target, e.type]).sort()).toEqual(
      [
        ["api", "application", "static"],
        ["application", "domain", "static"],
      ],
    );
  });

  it("passes check on a clean mixed tree", () => {
    const result = archkeep(consumer.root, ["check"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/[1-9]\d* import/);
    expect(result.stdout).toMatch(/[1-9]\d* file/);
  });

  it("reports a split package as a named blind spot and draws no guessed edge", () => {
    const split = createNativeLanguageConsumer(artifact, jvmMixedLanguageFiles);
    try {
      commitFiles(split.root, SPLIT_PACKAGE_MUTATION, "two projects claim one package");
      // The documented contract: a positioned failure is a blind spot, not a
      // refusal — the run reached a verdict about everything else, and the
      // unresolvable import is named at its own site.
      const checked = archkeep(split.root, ["check", "--format", "json"]);
      expect(checked.exitCode).toBe(0);
      expect(checked.json.coverage.blindSpots).toHaveLength(1);
      expect(checked.json.coverage.blindSpots[0].file).toBe(
        "libs/application/src/main/java/com/example/application/App.java",
      );
      // `import` sits on line 3 of the fixture's App.java.
      expect(checked.json.coverage.blindSpots[0].line).toBe(3);
      // Claimants in declared-project order (archkeep.json: domain first).
      expect(checked.json.coverage.blindSpots[0].reason).toContain(
        "'com.example.kdomain' is declared by more than one project (domain, application)",
      );
      expect(checked.json.coverage.blindSpots[0].reason).toContain(
        "Java would pick by classpath order",
      );

      // And the graph drew nothing GUESSED for it: the import-track edge is
      // lost, while the application→domain edge the split tree still shows is
      // the pom's declared dependency — a fact of the workspace, not a
      // resolution guess between the two claimants.
      const graph = archkeep(split.root, ["graph", "--format", "json"]);
      expect(graph.exitCode).toBe(0);
      expect(graph.json.result.dependencies.map((e) => `${e.source}->${e.target}`)).toEqual([
        "api->application",
        "application->domain",
      ]);
    } finally {
      split.cleanup();
    }
  });

  it("fails a cross-extension boundary violation", () => {
    const violator = createNativeLanguageConsumer(artifact, jvmMixedLanguageFiles);
    try {
      commitFiles(
        violator.root,
        MIXED_VIOLATION,
        "domain reaches sideways through a Kotlin import",
      );
      const result = archkeep(violator.root, ["check"]);
      expect(result.exitCode).toBe(1);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("onlyTagsConstraintViolation");
      expect(output).toMatch(/Reach\.kt:\d+:\d+/);
    } finally {
      violator.cleanup();
    }
  });

  it("refuses check, graph, and diff when a tracked JVM source is unreadable", () => {
    const broken = createNativeLanguageConsumer(artifact, jvmMixedLanguageFiles);
    try {
      const baseline = join(broken.root, "baseline.json");
      const clean = archkeep(broken.root, ["graph", "--format", "json", "--output", baseline]);
      expect(clean.exitCode).toBe(0);

      // A dangling symlink is tracked by git but unreadable on disk: the
      // package index records a whole-file failure, and every result built
      // on the index would be a claim over a tree nobody could read.
      const helper = join(
        broken.root,
        "libs",
        "domain",
        "src",
        "main",
        "kotlin",
        "com",
        "example",
        "kdomain",
        "Helper.kt",
      );
      rmSync(helper);
      symlinkSync("definitely-missing.kt", helper);

      const checked = archkeep(broken.root, ["check", "--format", "json"]);
      expect(checked.exitCode).toBe(3);
      expect(checked.json.coverage.complete).toBe(false);
      expect(checked.json.coverage.notAnalyzed.map((row) => row.file)).toEqual([
        "libs/domain/src/main/kotlin/com/example/kdomain/Helper.kt",
      ]);

      const graph = archkeep(broken.root, ["graph", "--format", "json"]);
      expect(graph.exitCode, "graph refuses an unreadable JVM source").toBe(3);

      const refused = archkeep(broken.root, ["diff", baseline, "--format", "json"]);
      expect(refused.exitCode, "diff refuses an unreadable head source").toBe(3);
      expect(refused.stderr).toContain("could not be analyzed");
    } finally {
      broken.cleanup();
    }
  });
});
